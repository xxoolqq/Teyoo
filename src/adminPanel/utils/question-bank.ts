// 本地 SQLite 题库的渲染端接缝：导入中心写入（导入此题 / 导入选中）、本地题库页读取、
// 录入弹窗的知识点词表。
//
// 与 utils/math-parse.ts 同一套写法 —— 用结构类型取 electronAPI 的一小块，
// 没有桥的宿主（Web 版）里返回明确的错误码，由界面提示而不是抛异常。
//
// 这里只做三件事：把拆题结果转成入库载荷、发请求、把错误码翻成人话。
// 校验与查重的判定都在主进程（question-bank/store.ts），渲染端不重复实现一遍 ——
// 两处都判就会出现「界面放过了但库里拒了」这种最难解释的状态。

import type {
  Dictionaries,
  ExerciseBatchResult,
  ExerciseInput,
  ExerciseListQuery,
  ExerciseListResult,
  ExerciseSaveOptions,
  ExerciseSaveResult,
  ExerciseListItem,
  KnowledgePointOption,
  MathParseQuestion,
  SaveQuestionImageResult
} from '../../preload/index'

import { isStageCode } from './class-level'

/** 知识点词表条目的类型给录入弹窗用，这里透传一次，界面不必再伸到 preload 里取 */
export type { Dictionaries, ExerciseInput, ExerciseListItem, KnowledgePointOption }

/** 落库需要、但拆题结果里没有（或逐题可改）的字段 */
export interface ExerciseScope {
  subjectCode: string
  stage: string
  classLevel: string
  term: string
}

interface QuestionBankBridge {
  questionBankImport?: (
    exercise: ExerciseInput,
    options?: ExerciseSaveOptions
  ) => Promise<ExerciseSaveResult>
  questionBankImportBatch?: (exercises: ExerciseInput[]) => Promise<ExerciseBatchResult>
  questionBankList?: (query: ExerciseListQuery) => Promise<ExerciseListResult>
  questionBankDictionaries?: () => Promise<Dictionaries>
  questionBankKnowledgePoints?: (
    subjectCode: string,
    gradeTerms?: string[]
  ) => Promise<KnowledgePointOption[]>
  questionBankKeyPoints?: (
    courseCode: string,
    classLevel: string
  ) => Promise<KnowledgePointOption[]>
  questionImageSave?: (input: {
    name?: string
    data?: Uint8Array
    sourcePath?: string
  }) => Promise<SaveQuestionImageResult>
  /** File → 磁盘路径。Electron 32+ 去掉了 File.path，只能走 webUtils 这条桥 */
  getPathForFile?: (file: File) => string
}

function bridge(): QuestionBankBridge {
  return (window as unknown as { electronAPI?: QuestionBankBridge }).electronAPI ?? {}
}

/**
 * 拆题结果 → 入库载荷。
 *
 * 三条硬要求，都是踩过的坑：
 *
 * 1. 数组要 `?? []` 兜底：卡片上万一没有这两个字段，`.map` 会抛 TypeError，
 *    而调用方（importOne）是「点一下就调用」的路径，抛出去等于点了没反应。
 * 2. 数组必须**重新摊平成普通数组**，不能把引用直接传下去。`q` 是 Vue 的
 *    reactive 对象，`q.referencedImages` / `kp.targetEvidence` 拿到的是 Proxy，
 *    而 Electron IPC 走结构化克隆 —— Proxy 不可克隆，点「导入此题」会直接报
 *    `An object could not be cloned.`。字符串字段没这问题（Proxy 的 get 陷阱
 *    返回原始值），数组就会带出代理本身。
 * 3. 知识点只传编码数组：v2 的库里「主/辅」由 position 表达（0 = 主），
 *    模型给的 evidence / reason 是拆题过程的证据，不进库。
 */
export function toExerciseInput(
  q: MathParseQuestion,
  scope: ExerciseScope
): ExerciseInput {
  const points = q.knowledgePoints ?? []
  // 主知识点排前面：position 0 就是「主要考查」，其余按模型顺序当辅助
  const ordered = [
    ...points.filter((kp) => kp.role === 'main'),
    ...points.filter((kp) => kp.role !== 'main')
  ]
  return {
    subjectCode: scope.subjectCode,
    stage: scope.stage,
    classLevel: scope.classLevel,
    // 跨年级（classLevel 是学段码，如 senior）时学期没有意义：那是「整个高中通用」
    // 的题，再挂个上/下册只会在筛选和词表里制造矛盾，入库存空串。
    term: isStageCode(scope.classLevel) ? '' : scope.term,
    subjectTypeCode: q.subjectTypeCode,
    easy: q.easy,
    content: q.content,
    answerMarkdown: q.answerMarkdown,
    source: q.source,
    knowledgePointCodes: Array.from(new Set(ordered.map((kp) => kp.code)))
  }
}

export async function saveQuestion(
  exercise: ExerciseInput,
  options?: ExerciseSaveOptions
): Promise<ExerciseSaveResult> {
  const api = bridge()
  if (typeof api.questionBankImport !== 'function') return { ok: false, error: 'NO_BRIDGE' }
  try {
    return await api.questionBankImport(exercise, options)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function saveQuestions(exercises: ExerciseInput[]): Promise<ExerciseBatchResult> {
  const api = bridge()
  if (typeof api.questionBankImportBatch !== 'function') {
    return { ok: false, saved: 0, results: [], error: 'NO_BRIDGE' }
  }
  try {
    return await api.questionBankImportBatch(exercises)
  } catch (error) {
    return {
      ok: false,
      saved: 0,
      results: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/** 下拉字典（科目 / 年级 / 题型）。失败回空表，由页面决定是否用兜底值 */
export async function fetchDictionaries(): Promise<Dictionaries> {
  const api = bridge()
  const empty: Dictionaries = { subjects: [], classLevels: [], subjectTypes: [], easyLevels: [] }
  if (typeof api.questionBankDictionaries !== 'function') return empty
  try {
    const dict = await api.questionBankDictionaries()
    return {
      subjects: dict?.subjects ?? [],
      classLevels: dict?.classLevels ?? [],
      subjectTypes: dict?.subjectTypes ?? [],
      easyLevels: dict?.easyLevels ?? []
    }
  } catch {
    return empty
  }
}

/**
 * 知识点词表（按科目 + 「年级-学期」组合取）。
 *
 * gradeTerms 是 `01-1` 这种组合键，不是年级码：词表条目按 (class_level, term) 建，
 * 只传年级会把上下册的考点混在一起。
 *
 * 不缓存：年级一换结果就整批变，按「科目|年级」做 key 的缓存只会让人在改勾选后
 * 看到上一次的词表，排查起来比多一次 IPC 贵得多。
 */
export async function fetchKnowledgePoints(
  subjectCode: string,
  gradeTerms: string[] = []
): Promise<KnowledgePointOption[]> {
  const api = bridge()
  if (typeof api.questionBankKnowledgePoints !== 'function' || !subjectCode) return []
  try {
    const list = await api.questionBankKnowledgePoints(subjectCode, gradeTerms)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 知识点候选项（按科目 + 学段取 key_points 里的全量考点树）。
 *
 * 与 fetchKnowledgePoints 是两张表：那个给拆题拼 prompt 用（短词表），这个给录入
 * 弹窗按学段选考点用。学段码只认 primary / junior / senior / other，空值直接返回
 * 空列表 —— 没选学段就不知道该展开哪个学段，宁可让人先选。
 */
export async function fetchKeyPoints(
  courseCode: string,
  classLevel: string
): Promise<KnowledgePointOption[]> {
  const api = bridge()
  if (typeof api.questionBankKeyPoints !== 'function' || !courseCode || !classLevel) return []
  try {
    const list = await api.questionBankKeyPoints(courseCode, classLevel)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 把一张配图交给主进程落盘，拿回可直接写进 markdown 的 file:// URL。
 *
 * 无桥时回 `{ ok:false, error:'NO_BRIDGE' }`：调用方按失败处理，别把 base64 塞进
 * 题干 —— 那会让这一版「临时能用」变成永久的数据格式。
 */
export async function saveQuestionImage(input: {
  name?: string
  data?: Uint8Array
  sourcePath?: string
}): Promise<SaveQuestionImageResult> {
  const api = bridge()
  if (typeof api.questionImageSave !== 'function') return { ok: false, error: 'NO_BRIDGE' }
  try {
    return await api.questionImageSave(input)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * File → 磁盘绝对路径（拿不到回空串：粘贴的剪贴板截图、浏览器拖进来的图都没有
 * 真实落点）。只用于「这张图是不是已经在工作目录的 images 里」这一个判断。
 */
export function diskPathOfFile(file: File): string {
  const api = bridge()
  if (typeof api.getPathForFile !== 'function') return ''
  try {
    return api.getPathForFile(file) || ''
  } catch {
    return ''
  }
}

/** 读取失败时的空壳：页面据此渲染「加载失败」而不是把列表清空当成「库里没题」 */
export const EMPTY_LIST_RESULT: ExerciseListResult = {
  ok: false,
  total: 0,
  page: 1,
  pageSize: 0,
  items: []
}

/**
 * 分页读取本地题库。
 *
 * 无桥（Web 宿主）时回 `ok:false, error:'NO_BRIDGE'`，不抛 —— 调用方在 onMounted
 * 里 await 它，抛出来就是一个没人接的 rejection，界面会一直停在「加载中」。
 */
export async function listQuestions(query: ExerciseListQuery = {}): Promise<ExerciseListResult> {
  const api = bridge()
  if (typeof api.questionBankList !== 'function') {
    return { ...EMPTY_LIST_RESULT, error: 'NO_BRIDGE' }
  }
  try {
    return await api.questionBankList(query)
  } catch (error) {
    return {
      ...EMPTY_LIST_RESULT,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export type { ExerciseListQuery, ExerciseListResult }

const ERROR_TEXT: Record<string, string> = {
  NO_BRIDGE: '当前环境不支持本地题库（需要桌面版）',
  DB_ERROR: '本地题库数据库打不开：请重启应用后重试',
  BAD_PAYLOAD: '入库请求格式不对，请刷新后重试',
  EMPTY_CONTENT: '题干为空，不能入库',
  NO_SUBJECT: '请先选择科目',
  BAD_SUBJECT: '科目不在字典表里：请刷新后重试',
  BAD_STAGE: '学段不合法：请重新选择年级',
  NO_SUBJECT_TYPE: '请先选择题型',
  BAD_SUBJECT_TYPE: '题型不在字典表里：请重新选择',
  SUBJECT_TYPE_MISMATCH: '题型与科目不匹配：请重新选择题型',
  BAD_EASY: '难度不合法：请重新选择',
  BAD_CLASS_LEVEL: '年级不在字典表里：请重新选择',
  BAD_TERM: '学期只能是上/下：请重新选择',
  DUPLICATE: '题库里已有同一道题'
}

/** 错误码 → 用户能看懂的一句话。认不出的（底层异常文案）原样透出，便于排查。 */
export function describeQuestionBankError(error?: string): string {
  if (!error) return '入库失败'
  // 带参数的错误码：BAD_KNOWLEDGE_POINT:0001_0012 —— 把编码带出来才查得下去
  const colon = error.indexOf(':')
  if (colon > 0) {
    const head = error.slice(0, colon)
    if (head === 'BAD_KNOWLEDGE_POINT') {
      return `知识点编码「${error.slice(colon + 1)}」不在字典表里，请重新选择`
    }
  }
  return ERROR_TEXT[error] ?? error
}
