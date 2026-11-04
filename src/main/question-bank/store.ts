// 本地题库的读写。
//
// 与 formula-db.ts 的关系：同一个 SQLite 依赖、同一种「懒打开 + WAL」的连接管理，
// 但错误处理相反 —— 公式历史是附赠品，写失败可以吞；这里是用户点「导入此题」要的
// 结果，失败必须原样回传给界面，否则卡片会显示「已导入」而库里什么都没有。
//
// v2 起表名与字段名和线上 MySQL 完全一致（见 schema.ts 顶部说明）。
//
// 为什么不用 MathBank 那种「每次 POST 都新增一行」：它的卡片是「发一次请求 = 一道新题」，
// 幂等只在文档工程那条路径上靠 receipts 做。我们的卡片是同一份草稿在续改，`saved`
// 本来就是卡片级状态，再插一行只会得到两条几乎相同的记录。所以：
//   · 首次导入 → INSERT，把 id 交回卡片；
//   · 再次导入 → 带 id 回来，UPDATE 同一行并重写它的知识点。
//
// 查重只做题干归一化后的精确命中（MathBank 那套 question_fingerprints 有 30 列、
// 含 simhash 与文本分带，为的是跨库迁移和语义级重复，这里没有对应需求）。
// 命中不拦截，只是让调用方弹一次确认 —— 同题换出处二次入库是合理操作。

import Database from 'better-sqlite3'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { KNOWLEDGE_CATALOG } from '../math-parse/catalog'
import {
  DEFAULT_KNOWLEDGE_POINT_PROMPT_OFF,
  DEFAULT_SUBJECT_TYPE_PROMPT_OFF,
  SEED_PROMPT_OFF_SENIOR_MATH,
  SEED_PROMPT_SENIOR_MATH,
  type PromptSeed
} from './prompt-seed'
import {
  DDL_V1,
  DDL_V2,
  DDL_V3,
  SCHEMA_VERSION,
  SEED_CLASS_LEVEL,
  SEED_SUBJECT,
  SEED_SUBJECT_TYPE
} from './schema'
import { currentAdminIdentity } from '../session-store'

type DB = Database.Database

const DB_FILE = 'question-bank.db'

/** 现有数据全是人教 A 版高中数学，迁移时统一落到这个科目上 */
const LEGACY_SUBJECT_CODE = '0001'
const LEGACY_STAGE = 'senior'

/** 年级编码只能是这些（与 class_level 表一致，空串表示「跨年级 / 未填」） */
const STAGES = ['primary', 'junior', 'senior', 'other'] as const
export type Stage = (typeof STAGES)[number]

/**
 * 学段码同时是 class_level 的合法值：表示「跨年级（整个学段通用）」。
 *
 * 导入试卷时选了「高中」，审查卡的「跨年级」写的就是 `senior` —— 这道题适用整个
 * 高中。空串仍保留给「未指定学段」的历史数据，两者共存：
 *   `''`      未指定（旧数据 / 不知道该按哪个学段）
 *   `senior`  跨年级，整个高中
 *   `10`      具体年级（十年级）
 *
 * 学段 → 该学段所有年级码：知识点词表按学段筛选时要把这一组都算进来。
 */
const STAGE_GRADE_CODES: Record<string, string[]> = {
  primary: ['01', '02', '03', '04', '05', '06'],
  junior: ['07', '08', '09'],
  senior: ['10', '11', '12'],
  other: ['201']
}

/** 这个值是不是「学段码」（跨年级写法） */
function isStageValue(value: string): boolean {
  return (STAGES as readonly string[]).includes(value)
}

// ── 对外类型 ────────────────────────────────────────────────────────────────

export interface ExerciseInput {
  /** 科目代码，如 0001 */
  subjectCode: string
  /** 学段 primary / junior / senior / other */
  stage: string
  /** 年级代码，空串表示跨年级题 */
  classLevel?: string
  /** 学期 1 上 / 2 下，空串表示未填 */
  term?: string
  /** 题型代码 */
  subjectTypeCode: string
  /** 难度 '1'~'5' */
  easy: string
  /** 题干 Markdown */
  content: string
  /** 答案 + 解析 */
  answerMarkdown?: string
  source?: string | null
  /** 按顺序写入，下标即 position，0 为主知识点 */
  knowledgePointCodes?: string[]
}

export interface ExerciseSaveOptions {
  /** 传了就是「再次导入」：更新这一行。行已被删掉时自动退回新增。 */
  id?: number
  /** 用户已确认「同题也要导」 */
  force?: boolean
}

export interface ExerciseDuplicate {
  id: number
  createdAt: number
  source: string | null
}

export interface ExerciseSaveResult {
  ok: boolean
  id?: number
  /** 命中同题：调用方确认后可带 force 再调一次 */
  duplicate?: ExerciseDuplicate
  /** 错误码（EMPTY_CONTENT / BAD_SUBJECT / BAD_STAGE / …）或底层异常文案 */
  error?: string
}

export interface ExerciseBatchItem extends ExerciseSaveResult {
  index: number
}

export interface ExerciseBatchResult {
  ok: boolean
  saved: number
  results: ExerciseBatchItem[]
  error?: string
}

export interface ExerciseKnowledgePointBrief {
  code: string
  name: string
  /** position === 0 */
  isMain: boolean
}

export interface ExerciseListQuery {
  /** 关键词：命中题干/解析/来源；`#40` 这种写法按 id 精确命中 */
  keyword?: string
  subjectCode?: string
  stage?: string
  classLevel?: string
  subjectTypeCode?: string
  easy?: string
  /** 按录入时间排序，默认倒序 */
  sort?: 'desc' | 'asc'
  /** 从 1 起算 */
  page?: number
  pageSize?: number
}

export interface ExerciseListItem {
  id: number
  exerciseCode: string | null
  subjectCode: string
  stage: string
  classLevel: string
  term: string
  subjectTypeCode: string
  easy: string
  content: string
  answerMarkdown: string
  source: string | null
  /** 毫秒时间戳 */
  createdAt: number
  knowledgePoints: ExerciseKnowledgePointBrief[]
}

export interface ExerciseListResult {
  ok: boolean
  total: number
  page: number
  pageSize: number
  items: ExerciseListItem[]
  error?: string
}

/** 下拉用的三项字典 */
export interface DictionaryOption {
  code: string
  name: string
  /** 级联用：科目码 / 学段 / 空 */
  parent?: string
  /**
   * 该字典项适用的学段。目前只有题型带（subject_type.class_level），
   * 为空表示这行没限定学段（历史数据），前端按「该学段没有专用行时才回退」处理。
   */
  stage?: string
}

export interface Dictionaries {
  subjects: DictionaryOption[]
  classLevels: DictionaryOption[]
  subjectTypes: DictionaryOption[]
}

export interface KnowledgePointOption {
  code: string
  name: string
  classLevel: string
  term: string
}

// ── 连接 ────────────────────────────────────────────────────────────────────

let handle: DB | null = null

/**
 * 打开题库。
 *
 * 失败不缓存：导入是用户主动触发、频率极低的操作，一次磁盘错误不该让整个会话都
 * 以为「题库坏了」。这与 formula-db 里那个 openFailed 标志的取舍正好相反 ——
 * 那边是每 700ms 一次的识别，反复重试会拖慢识别。
 */
function open(): DB {
  if (handle) return handle
  const db = new Database(join(app.getPath('userData'), DB_FILE))
  db.pragma('journal_mode = WAL')
  // ON DELETE CASCADE 只有在开了外键约束时才生效（SQLite 默认关）
  db.pragma('foreign_keys = ON')
  migrate(db)
  seedDictionaries(db)
  handle = db
  return db
}

function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version > SCHEMA_VERSION) {
    throw new Error(`题库数据库版本 ${version} 高于程序支持的 ${SCHEMA_VERSION}，请升级程序`)
  }
  if (version < 1) db.exec(DDL_V1)
  if (version < 2) migrateV2(db)
  if (version < 3) migrateV3(db)
  if (version < 4) migrateV4(db)
  if (version < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`)
}

/**
 * prompt_table 的幂等插入。
 *
 * 表没有唯一键（那是使用者先建好的表，不在本程序职责内改建），所以幂等只能靠
 * `WHERE NOT EXISTS`——`INSERT OR IGNORE` 在没有唯一约束时等于不设防，每次启动
 * 都会多插一行。已有非空 prompt 的行一律不动：用户在表里改过的提示词不能被升级覆盖。
 */
function insertPromptSeeds(
  db: DB,
  course: string,
  stage: string,
  seeds: readonly PromptSeed[]
): void {
  const insert = db.prepare(
    `INSERT INTO prompt_table (prompt, create_time, stage, course, prompt_type)
     SELECT ?, datetime('now', 'localtime'), ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM prompt_table
       WHERE course = ? AND stage = ? AND prompt_type = ?
         AND prompt IS NOT NULL AND TRIM(prompt) <> ''
     )`
  )
  for (const seed of seeds) {
    insert.run(seed.prompt, stage, course, seed.promptType, course, stage, seed.promptType)
  }
}

/** v2 → v3：建提示词表并灌入高中数学的五段种子。 */
function migrateV3(db: DB): void {
  const course = '0001'
  const stage = 'senior'
  db.transaction(() => {
    db.exec(DDL_V3)
    insertPromptSeeds(db, course, stage, SEED_PROMPT_SENIOR_MATH)
  })()
}

/**
 * v3 → v4：补上「题型分类 / 知识点标注 没选中」那两行提示词。
 *
 * 为什么单独一版：v3 的种子只在建库时灌一次，已经导过题的老库不会重跑，于是
 * 表里永远缺这两行。缺行时 resolveParsePrompts 会用内置默认顶上（不报错），
 * 但那样用户就改不了这两段 —— 补行是为了让它们可编辑，与「提示词以库为准」这条
 * 规矩对齐。只补高中数学这一组，其它科目靠内置默认。
 */
function migrateV4(db: DB): void {
  const course = '0001'
  const stage = 'senior'
  db.transaction(() => {
    insertPromptSeeds(db, course, stage, SEED_PROMPT_OFF_SENIOR_MATH)
  })()
}

/**
 * v1 → v2：建新表、灌字典、把 questions 搬进 exercise。
 *
 * 整段一个事务：中途失败要能整体回滚，否则会留下「新表建好了但数据没搬完」的
 * 半截库 —— 那时 user_version 还是 1，下次启动会重跑，但 DDL 是 IF NOT EXISTS，
 * 数据会搬两遍。
 */
function migrateV2(db: DB): void {
  const legacyExists = Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='questions'").get()
  )
  db.transaction(() => {
    db.exec(DDL_V2)
    db.exec(SEED_SUBJECT)
    db.exec(SEED_CLASS_LEVEL)
    db.exec(SEED_SUBJECT_TYPE)
    const codeMap = seedKnowledgePoints(db)
    if (legacyExists) migrateLegacy(db, codeMap)
  })()
}

/**
 * 把硬编码的 230 条知识点灌进 knowledge_point 表。
 *
 * 新编码按 0001_0001 起顺序生成，**不含年级**：知识点会挪年级，编号里带年级
 * 一挪就得改号，历史数据全断。
 *
 * 返回「旧编码 → 新编码」的映射，供下面的关联表迁移使用。
 * 名字撞唯一约束时这一条不会插入，也就不进映射 —— 迁移时自然跳过。
 */
function seedKnowledgePoints(db: DB): Map<string, string> {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO knowledge_point
       (code, subject_code, class_level, term, name, sort_no, enabled)
     VALUES (?, ?, '', '', ?, ?, 1)`
  )
  const map = new Map<string, string>()
  let seq = 0
  for (const row of KNOWLEDGE_CATALOG) {
    const oldCode = String(row[0] ?? '').trim()
    const name = String(row[1] ?? '').trim()
    if (!oldCode || !name || map.has(oldCode)) continue
    seq += 1
    const code = `${LEGACY_SUBJECT_CODE}_${String(seq).padStart(4, '0')}`
    const info = insert.run(code, LEGACY_SUBJECT_CODE, name, seq)
    if (info.changes > 0) map.set(oldCode, code)
  }
  return map
}

/** 难度四档 → '1'~'5'。旧值不在表里时按「中」处理 */
const LEGACY_EASY: Record<string, string> = {
  easy_error: '3',
  normal: '2',
  challenge: '4',
  qiangji: '5'
}

/**
 * questions → exercise，question_knowledge_points → exercise_knowledge_point。
 *
 * 旧表的 category_* 三列（教材位置）整体丢弃：v2 明确不再记录教材位置。
 * class_level / term 留空串 —— 旧题对不上年级码，硬填就是造假。
 *
 * 逐行插入而不是 INSERT ... SELECT：需要拿到新旧 id 的对应关系，才能把关联表
 * 一起搬过去。题目量级在几千，逐行可接受。
 */
function migrateLegacy(db: DB, codeMap: Map<string, string>): void {
  const rows = db
    .prepare(
      `SELECT id, content, answer_markdown, question_type, difficulty, source,
              content_hash, created_at, updated_at
       FROM questions ORDER BY id`
    )
    .all() as {
    id: number
    content: string
    answer_markdown: string
    question_type: string
    difficulty: string
    source: string | null
    content_hash: string
    created_at: number
    updated_at: number
  }[]

  const insertExercise = db.prepare(
    `INSERT INTO exercise
       (exercise_code, course, user_code, school_code, class_level, term, stage,
        subject_type_code, easy, subject_self, answer_self, source, content_hash,
        create_time, update_time)
     VALUES (NULL, ?, '', '', '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  const idMap = new Map<number, number>()
  for (const row of rows) {
    const info = insertExercise.run(
      LEGACY_SUBJECT_CODE,
      LEGACY_STAGE,
      row.question_type || 'detailed_answer',
      LEGACY_EASY[row.difficulty] ?? '3',
      row.content,
      row.answer_markdown,
      row.source,
      row.content_hash,
      row.created_at,
      row.updated_at
    )
    idMap.set(row.id, Number(info.lastInsertRowid))
  }

  const kpRows = db
    .prepare(
      `SELECT question_id, point_code
       FROM question_knowledge_points
       ORDER BY question_id, position, id`
    )
    .all() as { question_id: number; point_code: string }[]

  const insertKp = db.prepare(
    `INSERT OR IGNORE INTO exercise_knowledge_point
       (exercise_id, knowledge_point_code, position)
     VALUES (?, ?, ?)`
  )
  // position 按题重新连续编号：旧表里被丢弃的点会让 position 出现空洞
  const counters = new Map<number, number>()
  for (const kp of kpRows) {
    const newId = idMap.get(kp.question_id)
    const newCode = codeMap.get(String(kp.point_code ?? '').trim())
    if (!newId || !newCode) continue
    const position = counters.get(newId) ?? 0
    const info = insertKp.run(newId, newCode, position)
    if (info.changes > 0) counters.set(newId, position + 1)
  }

  // 搬完了才删旧表。数量对不上就保留，宁可留着两张表也不要把数据丢了
  const before = (db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n
  const after = (db.prepare('SELECT COUNT(*) AS n FROM exercise').get() as { n: number }).n
  if (rows.length === before && after >= before) {
    db.exec('DROP TABLE IF EXISTS question_knowledge_points;')
    db.exec('DROP TABLE IF EXISTS questions;')
  }
}

/** 每次打开都补齐字典：用户手动删过行也能恢复，INSERT OR IGNORE 天然幂等 */
function seedDictionaries(db: DB): void {
  db.exec(SEED_SUBJECT)
  db.exec(SEED_CLASS_LEVEL)
  db.exec(SEED_SUBJECT_TYPE)
}

// ── 校验 ────────────────────────────────────────────────────────────────────

/**
 * 难度固定五档，不随学科变。用常量而不是查表：值太少，建一张表只是多一次 join。
 */
export const EASY_LEVELS = ['1', '2', '3', '4', '5'] as const

const EASY_LABELS: Record<string, string> = {
  '1': '很易',
  '2': '易',
  '3': '中',
  '4': '难',
  '5': '拔高'
}

export const EASY_OPTIONS = EASY_LEVELS.map((value) => ({
  value,
  label: EASY_LABELS[value] ?? value
}))

/**
 * 题干归一化后取哈希，用于「同题」判断。
 *
 * 去空白：LaTeX 换行与缩进的差异不该让同一道题看起来不同。
 * 去题号：模型有时把「3.」留在 content 里，有时不留。
 * 图片语法与答案都不参与 —— 同一道题干配不同解析是正常操作，不算重复。
 */
function contentHash(content: string): string {
  const normalized = content
    .replace(/^\s*(?:第\s*\d+\s*题|\d+\s*[.、．])\s*/u, '')
    .replace(/\s+/g, '')
  return createHash('sha256').update(normalized).digest('hex')
}

type Prepared = { value: Required<ExerciseInput>; hash: string } | { error: string }

function prepare(db: DB, raw: ExerciseInput): Prepared {
  // IPC 那头是未知来源，先挡掉 null / 非对象：不然后面每个 typeof 都要写 ?.
  if (!raw || typeof raw !== 'object') return { error: 'BAD_PAYLOAD' }

  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (!content) return { error: 'EMPTY_CONTENT' }

  const subjectCode = typeof raw.subjectCode === 'string' ? raw.subjectCode.trim() : ''
  if (!subjectCode) return { error: 'NO_SUBJECT' }
  if (!db.prepare('SELECT 1 FROM subject WHERE code = ?').get(subjectCode)) {
    return { error: 'BAD_SUBJECT' }
  }

  // 年级先解析：它是学段码时语义上自带学段（跨年级 = 整个学段），以它为准，
  // 免得出现「年级=senior、学段=junior」这种自相矛盾的组合
  const classLevel =
    typeof raw.classLevel === 'string' ? raw.classLevel.trim() : ''
  const declaredStage = typeof raw.stage === 'string' ? raw.stage.trim() : ''
  const stage = isStageValue(classLevel) ? classLevel : declaredStage
  if (!STAGES.includes(stage as Stage)) return { error: 'BAD_STAGE' }

  // 空题型是合法状态：导入中心的「允许题型分类」关掉后模型不判断题型，由人工在
  // 审查卡补选。非空时才校验它存在、且属于本科目。
  const subjectTypeCode =
    typeof raw.subjectTypeCode === 'string' ? raw.subjectTypeCode.trim() : ''
  if (subjectTypeCode) {
    const type = db
      .prepare('SELECT subject_code FROM subject_type WHERE code = ?')
      .get(subjectTypeCode) as { subject_code: string } | undefined
    if (!type) return { error: 'BAD_SUBJECT_TYPE' }
    if (type.subject_code !== subjectCode) return { error: 'SUBJECT_TYPE_MISMATCH' }
  }

  const easy = typeof raw.easy === 'string' ? raw.easy.trim() : ''
  if (!EASY_LEVELS.includes(easy as (typeof EASY_LEVELS)[number])) {
    return { error: 'BAD_EASY' }
  }

  // 年级三种合法写法：字典里的年级码（01…12 / 201）、学段码（跨年级，如 senior）、
  // 空串（未指定学段的历史数据 / 老调用）
  if (
    classLevel &&
    !isStageValue(classLevel) &&
    !db.prepare('SELECT 1 FROM class_level WHERE code = ?').get(classLevel)
  ) {
    return { error: 'BAD_CLASS_LEVEL' }
  }
  const declaredTerm = typeof raw.term === 'string' ? raw.term.trim() : ''
  if (declaredTerm && declaredTerm !== '1' && declaredTerm !== '2') return { error: 'BAD_TERM' }
  // 跨年级（年级是学段码）不区分学期：整学段通用的题挂上/下册只会在筛选里矛盾，
  // 一律落空串。界面已禁用学期下拉，这里再兜一次 —— IPC 那头不受界面约束。
  const term = isStageValue(classLevel) ? '' : declaredTerm

  // 知识点：去重、保序、必须真实存在。两张表都是合法来源 —— 录入弹窗按学段
  // 从 key_points 选，早期词表（knowledge_point）与拆题链路仍在用它。
  const codes: string[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(raw.knowledgePointCodes) ? raw.knowledgePointCodes : []) {
    const code = typeof item === 'string' ? item.trim() : ''
    if (!code || seen.has(code)) continue
    if (
      !db.prepare('SELECT 1 FROM knowledge_point WHERE code = ?').get(code) &&
      !db.prepare('SELECT 1 FROM key_points WHERE keypoint_code = ?').get(code)
    ) {
      return { error: `BAD_KNOWLEDGE_POINT:${code}` }
    }
    seen.add(code)
    codes.push(code)
  }

  return {
    hash: contentHash(content),
    value: {
      subjectCode,
      stage,
      classLevel,
      term,
      subjectTypeCode,
      easy,
      content,
      answerMarkdown: typeof raw.answerMarkdown === 'string' ? raw.answerMarkdown.trim() : '',
      source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : null,
      knowledgePointCodes: codes
    }
  }
}

// ── 写入 ────────────────────────────────────────────────────────────────────

// user_code / school_code 来自本地登录态（主进程 admin-session），没登录就是空串；
// is_public 一律写 'no' —— 本地题库的题不默认公开，要公开得走同步那条链路另行设置。
const INSERT_EXERCISE = `
INSERT INTO exercise
  (exercise_code, course, user_code, school_code, class_level, term, stage,
   subject_type_code, easy, subject_self, answer_self, source, content_hash,
   is_public, create_time, update_time)
VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'no', ?, ?)
`

const UPDATE_EXERCISE = `
UPDATE exercise SET
  course = ?, class_level = ?, term = ?, stage = ?, subject_type_code = ?,
  easy = ?, subject_self = ?, answer_self = ?, source = ?, content_hash = ?,
  user_code = ?, school_code = ?, is_public = 'no', update_time = ?
WHERE id = ?
`

const INSERT_EXERCISE_KP = `
INSERT INTO exercise_knowledge_point (exercise_id, knowledge_point_code, position)
VALUES (?, ?, ?)
`

/** 知识点整体重写：再次导入时模型可能删掉或新增考点，逐条 diff 不如删了重插 */
function writeKnowledgePoints(db: DB, exerciseId: number, codes: string[]): void {
  db.prepare('DELETE FROM exercise_knowledge_point WHERE exercise_id = ?').run(exerciseId)
  const insert = db.prepare(INSERT_EXERCISE_KP)
  codes.forEach((code, position) => insert.run(exerciseId, code, position))
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/**
 * 导入一道题。
 *
 * 单行 + 它的知识点在同一个事务里写，避免出现「题目进了库、考点没进」的半截数据。
 */
export function importExercise(
  raw: ExerciseInput,
  options: ExerciseSaveOptions = {}
): ExerciseSaveResult {
  try {
    const db = open()
    const prepared = prepare(db, raw)
    if ('error' in prepared) return { ok: false, error: prepared.error }
    const { value, hash } = prepared
    const now = Date.now()
    // 本地登录态里带了 user_code / school_code 就随题一并落库；没登录（或登录返回
    // 里没这两个字段）就是空串 —— 这里只读主进程的 admin-session，不额外问渲染端
    const identity = currentAdminIdentity()

    if (options.id !== undefined) {
      const existing = db
        .prepare('SELECT id, user_code, school_code FROM exercise WHERE id = ?')
        .get(options.id) as
        | { id: number; user_code: string; school_code: string }
        | undefined
      if (existing) {
        db.transaction(() => {
          db.prepare(UPDATE_EXERCISE).run(
            value.subjectCode,
            value.classLevel,
            value.term,
            value.stage,
            value.subjectTypeCode,
            value.easy,
            value.content,
            value.answerMarkdown,
            value.source,
            hash,
            // 当前没登录 / 换了台机器时，不要把这一行原有的归属冲成空串
            identity.userCode || existing.user_code,
            identity.schoolCode || existing.school_code,
            now,
            options.id as number
          )
          writeKnowledgePoints(db, options.id as number, value.knowledgePointCodes)
        })()
        return { ok: true, id: options.id }
      }
      // 这一行已经不在了（用户换机器、手动清过库）：按新增处理，不静默丢题
    }

    if (!options.force) {
      const duplicate = db
        .prepare(
          `SELECT id, create_time, source FROM exercise
           WHERE content_hash = ? AND course = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(hash, value.subjectCode) as
        | { id: number; create_time: number; source: string | null }
        | undefined
      if (duplicate) {
        return {
          ok: false,
          error: 'DUPLICATE',
          duplicate: {
            id: duplicate.id,
            createdAt: duplicate.create_time,
            source: duplicate.source
          }
        }
      }
    }

    const id = db.transaction(() => {
      const info = db
        .prepare(INSERT_EXERCISE)
        .run(
          value.subjectCode,
          identity.userCode,
          identity.schoolCode,
          value.classLevel,
          value.term,
          value.stage,
          value.subjectTypeCode,
          value.easy,
          value.content,
          value.answerMarkdown,
          value.source,
          hash,
          now,
          now
        )
      const exerciseId = Number(info.lastInsertRowid)
      writeKnowledgePoints(db, exerciseId, value.knowledgePointCodes)
      return exerciseId
    })()

    return { ok: true, id }
  } catch (error) {
    return { ok: false, error: describeError(error, 'DB_ERROR') }
  }
}

/**
 * 批量导入（「导入选中」）。
 *
 * 逐题独立事务，不用一个大事务：一题写失败不该把已经合法的题一起回滚 ——
 * 用户在界面上勾了十道题，第九道撞了约束，前十道跟着没了才是最坏的结果。
 * 每道题的结果单独回传，界面可以精确标出哪几道没进去。
 */
export function importExercises(inputs: ExerciseInput[]): ExerciseBatchResult {
  const list = Array.isArray(inputs) ? inputs : []
  const results: ExerciseBatchItem[] = []
  let saved = 0
  for (let index = 0; index < list.length; index += 1) {
    const result = importExercise(list[index])
    if (result.ok) saved += 1
    results.push({ index, ...result })
  }
  return { ok: true, saved, results }
}

// ── 读取 ────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/** 检索命中这些列 */
const KEYWORD_COLUMNS = ['subject_self', 'answer_self', 'source']

/** LIKE 通配符转义：用户输入的 % 与 _ 应该当普通字符匹配 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

type ExerciseRow = {
  id: number
  exercise_code: string | null
  course: string
  stage: string
  class_level: string
  term: string
  subject_type_code: string
  easy: string
  subject_self: string
  answer_self: string
  source: string | null
  create_time: number
}

/**
 * 分页读取本地题库。
 *
 * 失败一律回 `{ ok: false }` 而不是抛：这条通道的调用方是页面 onMounted，
 * 抛出去只会变成一个没人 catch 的 unhandled rejection，界面上仍是「加载中」。
 */
export function listExercises(query: ExerciseListQuery = {}): ExerciseListResult {
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(query.pageSize) || DEFAULT_PAGE_SIZE))
  )
  const page = Math.max(1, Math.floor(Number(query.page) || 1))
  const sort = query.sort === 'asc' ? 'ASC' : 'DESC'

  try {
    const db = open()
    const conditions: string[] = []
    const params: (string | number)[] = []

    const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : ''
    if (keyword) {
      const seq = /^#\s*(\d+)$/.exec(keyword)
      if (seq) {
        conditions.push('id = ?')
        params.push(Number(seq[1]))
      } else {
        const like = `%${escapeLike(keyword)}%`
        // ESCAPE '\' 让上面转义过的 \% \_ 回到字面量语义
        conditions.push(`(${KEYWORD_COLUMNS.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
        for (let i = 0; i < KEYWORD_COLUMNS.length; i += 1) params.push(like)
      }
    }

    // 等值筛选，值只当绑定参数用，不拼进 SQL
    const equals: [keyof ExerciseListQuery, string][] = [
      ['subjectCode', 'course'],
      ['stage', 'stage'],
      ['classLevel', 'class_level'],
      ['subjectTypeCode', 'subject_type_code'],
      ['easy', 'easy']
    ]
    for (const [key, column] of equals) {
      const value = query[key]
      if (typeof value === 'string' && value.trim()) {
        conditions.push(`${column} = ?`)
        params.push(value.trim())
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM exercise ${where}`).get(...params) as { n: number }
    ).n

    // 页码超过总页数时退回最后一页：删过题之后停在空白页是最难解释的状态
    const lastPage = Math.max(1, Math.ceil(total / pageSize))
    const currentPage = Math.min(page, lastPage)
    const rows = db
      .prepare(
        `SELECT id, exercise_code, course, stage, class_level, term, subject_type_code,
                easy, subject_self, answer_self, source, create_time
         FROM exercise ${where}
         ORDER BY create_time ${sort}, id ${sort}
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (currentPage - 1) * pageSize) as ExerciseRow[]

    const points = new Map<number, ExerciseKnowledgePointBrief[]>()
    if (rows.length) {
      const placeholders = rows.map(() => '?').join(',')
      const kpRows = db
        .prepare(
          // 名称两处兜底：先查早期词表，再查 key_points（keypoint_code 是全局唯一的，
          // 不存在跨学段同码），都查不到才回显编码本身。
          `SELECT ekp.exercise_id, ekp.knowledge_point_code, ekp.position,
                  COALESCE(
                    kp.name,
                    (SELECT k.keypoint_name FROM key_points k
                      WHERE k.keypoint_code = ekp.knowledge_point_code)
                  ) AS name
           FROM exercise_knowledge_point ekp
           LEFT JOIN knowledge_point kp ON kp.code = ekp.knowledge_point_code
           WHERE ekp.exercise_id IN (${placeholders})
           ORDER BY ekp.exercise_id, ekp.position`
        )
        .all(...rows.map((row) => row.id)) as {
        exercise_id: number
        knowledge_point_code: string
        position: number
        name: string | null
      }[]
      for (const kp of kpRows) {
        const list = points.get(kp.exercise_id) ?? []
        list.push({
          code: kp.knowledge_point_code,
          name: kp.name ?? kp.knowledge_point_code,
          isMain: kp.position === 0
        })
        points.set(kp.exercise_id, list)
      }
    }

    return {
      ok: true,
      total,
      page: currentPage,
      pageSize,
      items: rows.map((row) => ({
        id: row.id,
        exerciseCode: row.exercise_code,
        subjectCode: row.course,
        stage: row.stage,
        classLevel: row.class_level,
        term: row.term,
        subjectTypeCode: row.subject_type_code,
        easy: row.easy,
        content: row.subject_self,
        answerMarkdown: row.answer_self,
        source: row.source,
        createdAt: row.create_time,
        knowledgePoints: points.get(row.id) ?? []
      }))
    }
  } catch (error) {
    return {
      ok: false,
      total: 0,
      page,
      pageSize,
      items: [],
      error: describeError(error, 'DB_ERROR')
    }
  }
}

// ── 字典读取 ────────────────────────────────────────────────────────────────

/**
 * 三个下拉的候选值。
 *
 * 从字典表读全量而不是「库里出现过的值」：清空题库后筛选框里还应该留着选项，
 * 否则用户会以为程序坏了。级联关系由 parent 字段表达：
 *   · classLevels.parent = 学段
 *   · subjectTypes.parent = 科目码
 */
export function listDictionaries(): Dictionaries {
  try {
    const db = open()
    const subjects = db
      .prepare('SELECT code, name FROM subject ORDER BY sort_no, id')
      .all() as { code: string; name: string }[]
    const levels = db
      .prepare('SELECT code, name, stage FROM class_level ORDER BY sort_no, id')
      .all() as { code: string; name: string; stage: string }[]
    const types = db
      .prepare(
        'SELECT code, name, subject_code, class_level FROM subject_type ORDER BY sort_no, id'
      )
      .all() as {
      code: string
      name: string
      subject_code: string
      class_level: string | null
    }[]
    return {
      subjects: subjects.map((row) => ({ code: row.code, name: row.name })),
      classLevels: levels.map((row) => ({
        code: row.code,
        name: row.name,
        parent: row.stage
      })),
      subjectTypes: types.map((row) => ({
        code: row.code,
        name: row.name,
        parent: row.subject_code,
        // class_level 里存的其实是学段值（senior/…），列名是历史遗留
        stage: row.class_level ?? undefined
      }))
    }
  } catch {
    return { subjects: [], classLevels: [], subjectTypes: [] }
  }
}

/**
 * 年级+学期组合键 `01-1`（一年级上学期）→ 两段值。
 *
 * 词表条目本身按 (class_level, term) 建，所以筛选必须精确到学期：
 * 只按年级筛会把上册的认识钟表与下册的除法混在一起，词表条数翻倍、命中率下降。
 * 也接受纯年级码（`01`），term 视为空，兼容只有一个下拉的旧调用。
 */
export function parseGradeTerm(value: string): { classLevel: string; term: string } {
  const text = String(value ?? '').trim()
  const dash = text.indexOf('-')
  if (dash < 0) return { classLevel: text, term: '' }
  return { classLevel: text.slice(0, dash), term: text.slice(dash + 1) }
}

/**
 * 年级组合 → 精确到年级码的组合。
 *
 * pair.classLevel 是学段码（跨年级，如 `senior`）时展开成该学段的所有年级：
 * 选「整个高中」应该能选到十/十一/十二年级的全部考点，而不是只剩科目通用条目。
 */
function expandStageTerms(pair: { classLevel: string; term: string }): {
  classLevel: string
  term: string
}[] {
  const codes = STAGE_GRADE_CODES[pair.classLevel]
  return codes ? codes.map((code) => ({ classLevel: code, term: pair.term })) : [pair]
}

/**
 * 按「科目 + 年级学期组合」取知识点清单。
 *
 * 这是拆题时塞进 prompt 的候选词表 —— 勾几个「年级×学期」就有多长，
 * 也就是用户说的「年级最终决定 prompt 有多长」。
 * `gradeTerms` 传空数组表示不限（录跨学段综合卷时用），此时返回该科目全量。
 */
export function listKnowledgePoints(
  subjectCode: string,
  gradeTerms: string[] = []
): KnowledgePointOption[] {
  try {
    const db = open()
    const pairs = (Array.isArray(gradeTerms) ? gradeTerms : [])
      .map(parseGradeTerm)
      .filter((pair) => pair.classLevel)
      // 学段码（跨年级）展开成该学段所有年级码
      .flatMap(expandStageTerms)
    const base = `SELECT code, name, class_level, term FROM knowledge_point
                  WHERE subject_code = ? AND enabled = 1`
    // 两处放宽，都是为了让「数据还没细分」时不至于查空：
    //   1. term = '' 表示该年级的通用条目（没标上册/下册），勾哪一册都该能选到
    //   2. class_level = '' 是全科目通用考点（如「数学思想方法」），任何筛选下都可见
    // 精确匹配优先、宽条件兜底，数据补齐后自然收敛。后端 DictionaryMapper 同条件。
    const where = pairs.length
      ? ` AND (${pairs.map(() => '(class_level = ? AND (term = ? OR term = \'\'))').join(' OR ')}
               OR (class_level = '' AND term = ''))`
      : ''
    const params: string[] = [subjectCode]
    for (const pair of pairs) params.push(pair.classLevel, pair.term)
    const rows = db
      .prepare(`${base}${where} ORDER BY sort_no, id`)
      .all(...params) as {
      code: string
      name: string
      class_level: string
      term: string
    }[]
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      classLevel: row.class_level,
      term: row.term
    }))
  } catch {
    return []
  }
}

/**
 * 按「科目 + 学段」从 key_points 取考点清单（录入弹窗的知识点候选）。
 *
 * 与 listKnowledgePoints 不是同一张表，别混用：
 *   - knowledge_point：随包灌进去的早期数学词表（310 条，不分科目/学段/学期），
 *     拆题 prompt 用它，因为 prompt 需要的是短词表；
 *   - key_points：按课标整理的全量考点树（9 个科目 × 3 个学段，一万六千多条），
 *     有 class_level（学段）与 course_code（科目）两列可筛，录入弹窗按学段选它。
 *
 * `classLevel` 只认学段码（primary / junior / senior / other）；「其它」在库里
 * 通常没有条目，查空就是正确答案 —— 不拿别学段的考点凑数。
 */
export function listKeyPoints(courseCode: string, classLevel: string): KnowledgePointOption[] {
  const course = String(courseCode ?? '').trim()
  const stage = String(classLevel ?? '').trim()
  if (!course || !isStageValue(stage)) return []
  try {
    const db = open()
    const rows = db
      .prepare(
        // 按层级再按同层顺序：key_points 是树，只按 sort_order 排会让父节点和
        // 深层的兄弟项交错在一起，看着像乱序
        `SELECT keypoint_code, keypoint_name, class_level FROM key_points
          WHERE course_code = ? AND class_level = ?
          ORDER BY node_level, sort_order, id`
      )
      .all(course, stage) as {
      keypoint_code: string
      keypoint_name: string
      class_level: string
    }[]
    return rows.map((row) => ({
      code: row.keypoint_code,
      name: row.keypoint_name,
      classLevel: row.class_level,
      // key_points 没有学期维度：学段内的考点不再分上下册
      term: ''
    }))
  } catch {
    return []
  }
}

/** 科目是否要锁公式（数学/物理/化学为 true）。查不到按不锁处理。 */
export function shouldLockFormula(subjectCode: string): boolean {
  try {
    const db = open()
    const row = db.prepare('SELECT lock_formula FROM subject WHERE code = ?').get(subjectCode) as
      | { lock_formula: number }
      | undefined
    return Boolean(row?.lock_formula)
  } catch {
    return false
  }
}

/**
 * 拆题需要的一整套学科配置。
 *
 * 这是 parse.ts 与 SQLite 之间唯一的接缝：提示词要的科目名/学段、题型候选、
 * 知识点词表、要不要锁公式，一次查齐。parse.ts 因此完全不认识任何具体学科，
 * 加一门学科只需要往字典表里插数据。
 */
export interface ParseSubjectConfig {
  subjectCode: string
  subjectName: string
  /** 学段由勾选年级推出来：一年级→primary，七年级→junior…；没勾年级时回退 other */
  stage: Stage
  subjectTypes: { code: string; name: string }[]
  knowledgePoints: { code: string; name: string }[]
  lockFormula: boolean
}

/**
 * 解析「科目 + 学段 + 年级学期组合」→ 拆题配置。科目不存在时回 null（调用方报 BAD_SUBJECT）。
 *
 * 学段的来源有两个，优先级明确：
 *   1. 界面上显式选的学段（用户先选小学、再在小学里挑年级，这是主路径）
 *   2. 没传时按已勾年级推，取**最靠前那个年级**的学段
 * 提示词里的「资深XX教研专家」只能写一个，取较低学段更保守 —— 模型会把题
 * 往低学段的理解水平上放，不会因为自称高中而给小升初的卷子写高中解法。
 */
export function resolveParseSubject(
  subjectCode: string,
  gradeTerms: string[] = [],
  stage?: string
): ParseSubjectConfig | null {
  const code = String(subjectCode ?? '').trim()
  if (!code) return null
  try {
    const db = open()
    const subject = db
      .prepare('SELECT code, name, lock_formula FROM subject WHERE code = ?')
      .get(code) as { code: string; name: string; lock_formula: number } | undefined
    if (!subject) return null

    const terms = (Array.isArray(gradeTerms) ? gradeTerms : [])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
    const levels = [...new Set(terms.map((key) => parseGradeTerm(key).classLevel).filter(Boolean))]

    // 显式学段优先；它不合法或没传时，退回按年级推
    let resolvedStage: Stage = 'other'
    const explicit = String(stage ?? '').trim()
    if (explicit && (STAGES as readonly string[]).includes(explicit)) {
      resolvedStage = explicit as Stage
    } else if (levels.length) {
      const row = db
        .prepare(
          `SELECT stage FROM class_level WHERE code IN (${levels.map(() => '?').join(',')})
           ORDER BY sort_no, id LIMIT 1`
        )
        .get(...levels) as { stage: string } | undefined
      if (row && (STAGES as readonly string[]).includes(row.stage)) {
        resolvedStage = row.stage as Stage
      }
    }

    // 题型按学段区分（语文/英语各学段题型确实不同），所以 class_level 必须精确匹配。
    // 数学表里有 8 行 class_level 为 NULL 的历史脏数据，不排除会得到重复题型，
    // 模型看到两份清单只会随机挑一个。
    const types = db
      .prepare(
        `SELECT code, name FROM subject_type
         WHERE subject_code = ? AND class_level = ?
         ORDER BY sort_no, id`
      )
      .all(code, resolvedStage) as { code: string; name: string }[]

    return {
      subjectCode: subject.code,
      subjectName: subject.name,
      stage: resolvedStage,
      subjectTypes: types,
      knowledgePoints: listKnowledgePoints(code, terms).map((row) => ({
        code: row.code,
        name: row.name
      })),
      lockFormula: Boolean(subject.lock_formula)
    }
  } catch {
    return null
  }
}

// ── 提示词 ──────────────────────────────────────────────────────────────────

/**
 * prompt_table.prompt_type 的取值。
 *
 * 每个「可勾选能力」在库里都有**两份**文案：勾上时用不带后缀的那行，没勾时用
 * `_off` 那行（两句都是给模型的指令：「从清单里挑一个」/「一律留空」）。答案同理
 * 两份，只是它的轴是「原卷有没有答案、能不能现场推导」。
 *
 * `_off` 两行是**可选**的：老库没有，缺了就用 prompt-seed 里的内置默认文案 ——
 * 升到这一版不该要求每套配置都补一遍行才不报错。
 */
export type ParsePromptType =
  | 'core_prompt'
  | 'subject_type_prompt'
  | 'subject_type_prompt_off'
  | 'knowledge_point_prompt'
  | 'knowledge_point_prompt_off'
  | 'answer_prompt_generate'
  | 'answer_prompt_extract'

export interface ParsePromptBlocks {
  core: string
  subjectType: string
  knowledgePoint: string
  answer: string
}

export type ParsePromptResult = { ok: true; blocks: ParsePromptBlocks } | { ok: false; missing: string[] }

/**
 * 按「科目 + 学段 + 三个勾选」取拆题要拼的四段提示词。
 *
 * 每个勾选项对应库里两行，这里按当前状态挑一行：
 *   勾上 → `subject_type_prompt` / `knowledge_point_prompt`（带清单，必需）
 *   没勾 → `subject_type_prompt_off` / `knowledge_point_prompt_off`（只说不许输出）
 * 答案段同理二选一（generate / extract）。
 *
 * **必需段缺一行就整体失败**（调用方报 BAD_PROMPT），不做回退：半套提示词拼出来
 * 的 system 比没有更危险——模型会按缺省常识自由发挥，出的题看着正常却和字段/词表
 * 对不上，等入库才发现，排查成本远高于直接拒绝。
 * 例外是两条 `_off` 段：老库没有这两行，缺了就用内置默认文案（见 prompt-seed），
 * 否则升一版就得先把每套配置补齐才能用。
 *
 * 查询规则与表结构配套：表里没有唯一键，取 `ORDER BY id DESC LIMIT 1`（最新一条
 * 生效）；`prompt IS NOT NULL AND TRIM(prompt) <> ''` 既挡空行也挡空串。
 */
export function resolveParsePrompts(input: {
  course: string
  stage: string
  generateAnswers: boolean
  /** 勾了「AI 判断题型」→ 取带清单的那一段，否则取「一律留空」的那一段 */
  classifySubjectType: boolean
  /** 勾了「AI 标注知识点」→ 取带词表的那一段，否则取「一律空数组」的那一段 */
  annotateKnowledge: boolean
}): ParsePromptResult {
  const course = String(input.course ?? '').trim()
  const stage = String(input.stage ?? '').trim()
  if (!course || !stage) return { ok: false, missing: ['科目或学段为空'] }

  const answerType: ParsePromptType = input.generateAnswers
    ? 'answer_prompt_generate'
    : 'answer_prompt_extract'
  const wanted: Array<{
    key: keyof ParsePromptBlocks
    type: ParsePromptType
    /** 缺行时用这段内置文案顶上（只有 `_off` 段有） */
    fallback?: string
  }> = [{ key: 'core', type: 'core_prompt' }]
  wanted.push(
    input.classifySubjectType
      ? { key: 'subjectType', type: 'subject_type_prompt' }
      : {
          key: 'subjectType',
          type: 'subject_type_prompt_off',
          fallback: DEFAULT_SUBJECT_TYPE_PROMPT_OFF
        }
  )
  wanted.push(
    input.annotateKnowledge
      ? { key: 'knowledgePoint', type: 'knowledge_point_prompt' }
      : {
          key: 'knowledgePoint',
          type: 'knowledge_point_prompt_off',
          fallback: DEFAULT_KNOWLEDGE_POINT_PROMPT_OFF
        }
  )
  wanted.push({ key: 'answer', type: answerType })

  try {
    const db = open()
    const stmt = db.prepare(
      `SELECT prompt FROM prompt_table
       WHERE course = ? AND stage = ? AND prompt_type = ?
         AND prompt IS NOT NULL AND TRIM(prompt) <> ''
       ORDER BY id DESC LIMIT 1`
    )
    const blocks: ParsePromptBlocks = { core: '', subjectType: '', knowledgePoint: '', answer: '' }
    const missing: string[] = []
    for (const item of wanted) {
      const row = stmt.get(course, stage, item.type) as { prompt: string } | undefined
      if (!row) {
        // `_off` 段：库里没配就用内置那两句，老库不必补行也能跑
        if (item.fallback) {
          blocks[item.key] = item.fallback
          continue
        }
        missing.push(`${item.type}（course=${course}, stage=${stage}）`)
        continue
      }
      blocks[item.key] = row.prompt
    }
    if (missing.length > 0) return { ok: false, missing }
    return { ok: true, blocks }
  } catch (error) {
    return {
      ok: false,
      missing: [`读取 prompt_table 失败：${(error as Error).message}`]
    }
  }
}
