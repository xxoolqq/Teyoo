// 拆题主流程：源码 →（按科目）锁公式 → 单次 LLM 调用 → JSON 解析 → 还原 → 校验 → questions[]
// ────────────────────────────────────────────────────────────────────────────
//
// 整条管线只在「切题」这一步用模型，且只用一次（JSON 解析失败才多一次修复调用）。
// 其余全是确定性的本地活：公式锁定与还原、枚举收敛、知识点编码校验、知识点引文
// 逐字校验、答案自编净化。
//
// v2 起按科目分流：
//   · 提示词片段由调用方按 subjectCode 选好（见 prompt.ts）；
//   · 题型候选、知识点词表由调用方按「科目 + 勾选年级」从 SQLite 查出后传进来；
//   · 公式锁定只对 lockFormula=true 的科目跑。
//
// 这样 parse.ts 本身不认识「数学」或「英语」，加学科不用改这里。

import { completeChat, type ChatMessage, type ChatUsage } from '../llm'
import {
  buildSystemPrompt,
  buildUserMessage,
  stageLabel,
  type PromptBlocks,
  type PromptOption
} from './prompt'
import {
  inspectLockIntegrity,
  lockVisibleMath,
  restoreLockedMath,
  summarizeLock,
  type LockedFormula
} from './lock'
import { dumpRawResponse } from './raw-log'

export type KnowledgeRole = 'main' | 'auxiliary'
export type EvidenceSource = 'content' | 'answer_markdown'

export interface ParsedKnowledgePoint {
  code: string
  /** 展示名（按词表回填，不信模型给的名字） */
  name: string
  role: KnowledgeRole
  evidenceSource: EvidenceSource
  evidence: string
  targetEvidence: string[]
  reason: string
  scope?: string
}

export interface ParsedQuestion {
  content: string
  answerMarkdown: string
  /** 题型代码，取值来自本次传入的 subjectTypes */
  subjectTypeCode: string
  knowledgePoints: ParsedKnowledgePoint[]
  /** 难度 '1'~'5' */
  easy: string
  source: string | null
  referencedImages: string[]
}

export interface ParseConnection {
  baseUrl: string
  apiKey: string
  model: string
}

export interface MathParseOptions {
  markdown: string
  title?: string
  generateAnswers: boolean
  connection: ParseConnection
  /** 科目代码，如 0001 */
  subjectCode: string
  /** 科目名，用于角色句 */
  subjectName: string
  /** 学段 primary / junior / senior / other（界面上显式选的，不再由年级反推） */
  stage: string
  /** 本次勾选的「年级-学期」组合（只用于 meta 回溯：词表已按它筛好了） */
  gradeTerms?: readonly string[]
  /** 本次可选题型（已按科目 + 学段筛过） */
  subjectTypes: readonly PromptOption[]
  /** 本次可选知识点（已按科目 + 勾选年级筛过） */
  knowledgePoints: readonly PromptOption[]
  /**
   * 从 prompt_table 查出来的四段提示词（core / subject_type / knowledge_point / answer）。
   * subject_type、knowledge_point 装的是**按开关挑好的那一份**：勾着是带清单的，
   * 没勾是那句「一律留空」的禁止文案 —— 段位始终在，模型不会因为缺段自行发挥。
   * 必需段缺失时调用方就该报 BAD_PROMPT（`_off` 段缺行用内置默认兜底）。
   */
  prompts: PromptBlocks
  /** 是否让模型判断题型（关掉时 subject_type_code 允许为空，由人工在审查卡补） */
  classifySubjectType: boolean
  /** 是否让模型标注知识点（关掉时不拼词表、不校验，knowledge_points 一律空） */
  annotateKnowledge: boolean
  /** 是否锁定公式，来自 subject.lock_formula */
  lockFormula: boolean
  /** 拆题可能要几分钟（输出上限 65536 token），默认给 10 分钟 */
  timeoutMs?: number
  maxTokens?: number
  temperature?: number
  /** 各阶段进度回调（锁公式 → 发请求 → 拿到返回 → 校验），直通 UI 日志 */
  onLog?: (line: string) => void
}

export interface MathParseStats {
  /** 切出的题目数 */
  total: number
  /** 锁定 / 被引用的公式数 */
  lockedFormulas: number
  referencedFormulas: number
  /** 一个题都没引用到的公式（多半是题头、页脚、水印） */
  unreferencedFormulas: number
  /** 同一 ID 被引用多次的次数（跨题复用属于违规） */
  duplicateReferences: number
  /** 实际使用的模型与输出上限 —— 慢的时候先看这两个值 */
  model: string
  maxTokens: number
  /** 发给模型的字符数（system + user），用来判断「是不是 prompt 太大」 */
  promptChars: number
  /** 本地阶段耗时（锁公式 + 拼 prompt），正常在几十毫秒 */
  promptReadyMs: number
  /** 模型往返总耗时（含降级重试与修复轮） */
  requestMs: number
  /** 是否因 HTTP 400 降级过参数 */
  degraded: boolean
  /** 是否触发过 JSON 修复轮（触发一次就是一次额外全量生成） */
  repaired: boolean
  /** 输出 token 总数（含思考） */
  completionTokens: number
  /** 其中花在思考上的部分 —— 思考型模型慢就慢在这里 */
  reasoningTokens: number
  /** 思考开关：disabled = 已按拆卷策略关闭；default = 没干预（端点不认该字段） */
  thinking: 'disabled' | 'default'
  /** 本次 vocab 条数，用来判断「是不是词表给多了」 */
  knowledgePointCount: number
}

export interface MathParseMeta {
  subjectCode: string
  stage: string
  /** 只用于回溯（`01-1` = 一年级上学期），不入库 */
  gradeTerms: string[]
}

export type MathParseResult =
  | {
      ok: true
      questions: ParsedQuestion[]
      warnings: string[]
      stats: MathParseStats
      meta: MathParseMeta
      usage?: ChatUsage
      raw?: string
    }
  | { ok: false; error: string; warnings: string[]; meta: MathParseMeta; raw?: string }

const DEFAULT_MAX_TOKENS = 65536
const DEFAULT_TEMPERATURE = 0.2
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_KNOWLEDGE_POINTS = 12

/** 难度固定五档，与本地 SQLite / 线上 MySQL 的 easy 完全一致 */
const EASY_VALUES = new Set(['1', '2', '3', '4', '5'])
const DEFAULT_EASY = '3'
const DEFAULT_SUBJECT_TYPE = 'detailed_answer'

/**
 * 输出上限一律给满，不要按模型名猜。
 *
 * 这里记一笔踩过的坑：曾经按「deepseek 的上限是 8192」做了个映射，结果把
 * deepseek-flash 的预算砍死 —— 它是思考型模型，实测一份 21 题的卷子要
 * 31,395 个 reasoning token，8192 在思考阶段就烧光了，content 直接空字符串，
 * 对外表现为 EMPTY_RESPONSE。
 *
 * 真正该做的不是「猜上限」，而是让服务端自己拒绝（400 → 降级），
 * 并在 content 为空时把 finish_reason 带出来，让人一眼看出是「预算不够」
 * 还是「偶发空返回」。
 */
function requestMaxTokens(override: number | undefined): number {
  return override ?? DEFAULT_MAX_TOKENS
}

/**
 * 剥离内嵌的 base64 图片。
 *
 * 这是「比原项目慢太多」的真正元凶之一：docxToMarkdown 用 mammoth 的
 * dataUri 图片转换器，每张图都以 `![alt](data:image/png;base64,…)` 内嵌，
 * 一份 347KB 的试卷能膨胀到 **249,425 字符**，剥离后只剩 4,456（56 倍）。
 * 这些 base64 全被当作 token 发给了模型——纯文本通道里模型完全「看不见」
 * 图片内容，唯一的贡献是把 prompt 撑爆、预填无限拉长。
 *
 * MathBank 从不这么干：它先上传图片拿到路径映射（image_mapping_json），
 * 正文里只留 `![alt](路径)`。这里做同样的事——全局编号换成短占位路径，
 * 真图留在源文件里，需要时由入库/疑点核对阶段另行处理。
 */
const DATA_URI_IMAGE_RE = /!\[([^\]]*)\]\(data:image\/[a-zA-Z0-9.+-]+;base64,[^)\s]+\)/g

export interface StripImagesReport {
  text: string
  /** 被替换掉的图片数 */
  images: number
  /** 节省的字符数（≈ 原 prompt 里的纯噪声） */
  savedChars: number
}

export function stripEmbeddedImages(markdown: string): StripImagesReport {
  let images = 0
  let savedChars = 0
  const text = markdown.replace(DATA_URI_IMAGE_RE, (whole, alt: string) => {
    images += 1
    savedChars += whole.length
    const label = alt.trim() || 'figure'
    return `![${label}](image-${String(images).padStart(3, '0')}.png)`
  })
  return { text, images, savedChars }
}

/**
 * 拆题要不要关思考。
 *
 * 这条规则照抄 mathbank/ai_providers.py 的判定（原文）：
 *     if (code == "deepseek" or host == "api.deepseek.com") and re.fullmatch(
 *         r"deepseek-(?:flash|v4-(?:pro|flash(?:-vision-exp)?))(?:-\d+)?", model):
 *         result["thinking"] = {"type": "enabled" if enabled else "disabled"}
 * 而 `enabled = task in {"solve","classify"} or task == "draw"` —— **parse 不在
 * 里面，所以拆卷一律 thinking=disabled**。
 *
 * 实测同一份 21 题试卷（api.deepseek.com + deepseek-flash）：
 *   默认（思考开）193.3s，completion 39,361，其中 reasoning 31,395
 *   关思考         24.7s，completion  6,841，reasoning      0
 * 正文长度几乎一样（16,594 vs 17,026 字符）。这就是「比原项目慢太多」的全部原因。
 *
 * 只对 DeepSeek 官方 + 该模型族注入：别的端点（硅基 / 百炼 / 中转）认的是
 * enable_thinking 或 reasoning_effort，塞 `thinking` 只会 400。
 */
function thinkingPolicy(connection: ParseConnection): 'disabled' | undefined {
  let host = ''
  try {
    host = new URL(connection.baseUrl).host.toLowerCase()
  } catch {
    return undefined
  }
  if (host !== 'api.deepseek.com') return undefined
  return /^deepseek-(?:flash|v4-(?:pro|flash(?:-vision-exp)?))(?:-\d+)?$/i.test(
    connection.model.trim()
  )
    ? 'disabled'
    : undefined
}

/** 折叠空白后比较：模型抄引文时常把换行/多个空格压成一个，这不算改写 */
function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function containsVerbatim(haystack: string, needle: string): boolean {
  const h = normalizeForMatch(haystack)
  const n = normalizeForMatch(needle)
  return n.length > 0 && h.includes(n)
}

/**
 * 从模型输出里挖出 JSON。
 *
 * 协议禁止 ``` 包裹，但实测仍会出现，且有时候前后还带一句「以下是结果：」。
 * 所以按「去围栏 → 找第一个 { 或 [ → 截到配对的闭合」的顺序尝试，全都失败才算失败。
 */
export function extractJsonPayload(raw: string): unknown | null {
  const text = raw.trim()
  if (!text) return null

  const candidates: string[] = []
  const unfenced = text
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
  candidates.push(text, unfenced)

  for (const candidate of candidates) {
    const direct = tryParse(candidate)
    if (direct !== null) return direct
    const sliced = sliceBalanced(candidate)
    if (sliced) {
      const parsed = tryParse(sliced)
      if (parsed !== null) return parsed
    }
  }
  return null
}

function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** 从第一个 `{` / `[` 起截到与之配对的闭合（跳过字符串内的括号） */
function sliceBalanced(text: string): string | null {
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\') {
      if (inString) escaped = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 取出 questions 数组；容忍模型直接返回裸数组 */
function pickQuestionArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload
  const questions = (payload as { questions?: unknown })?.questions
  return Array.isArray(questions) ? questions : null
}

interface NormalizeContext {
  formulas: readonly LockedFormula[]
  generateAnswers: boolean
  /** 本次实际注入的词表：校验只认这份，换年级范围时不必改代码 */
  catalog: ReadonlyMap<string, string>
  /** 本次可选题型 */
  subjectTypes: ReadonlySet<string>
  /**
   * 这门科目是否配了题型字典。
   *
   * 字典为空时（新学科还没灌 subject_type）逐题报「题型不在候选」会刷出几十条
   * 一模一样的告警，把真正的问题埋掉 —— 那种情况只需要在开头说一句。
   */
  hasTypeCatalog: boolean
  /** 是否启用题型分类：关掉时空题型合法，不回退、不告警 */
  classifySubjectType: boolean
  /** 是否启用知识点标注：关掉时跳过整段校验 */
  annotateKnowledge: boolean
  warnings: string[]
  /**
   * **题干**里每个公式 ID 的引用次数。
   *
   * 只统计 content：答案解析里再次引用题干留下的同一个 ID 是正常且推荐的
   * （否则模型只能重写公式，必然漂移），把它算进重复引用会让「答案里引用了一次」
   * 的卷子整批判失败。
   */
  referenced: Map<string, number>
  /** 答案解析里的引用次数：只用于日志，不参与完整性判定 */
  referencedInAnswer: Map<string, number>
  /** 模型照抄标签但改写了标签内公式的 ID（本地已逐字换回） */
  overwritten: string[]
  /**
   * 模型没给出处时的兜底（试卷标题）。
   *
   * 导入中心的「试卷标题」输入框写的是「可选，用作题目来源」，而模型认不出出处
   * 是很常见的（尤其空白卷），此时 source 必须是 null 之外的合理值。
   */
  fallbackSource: string
}

function restoreText(
  context: NormalizeContext,
  text: string,
  field: 'content' | 'answer'
): string {
  const result = restoreLockedMath(text, context.formulas)
  const bucket = field === 'content' ? context.referenced : context.referencedInAnswer
  for (const id of result.referenced) {
    bucket.set(id, (bucket.get(id) ?? 0) + 1)
  }
  for (const id of result.unknown) {
    context.warnings.push(`模型引用了不存在的公式 ID ${id}（已原样保留，需人工核对）`)
  }
  context.overwritten.push(...result.overwritten)
  return result.text
}

/** 答案来源标记：prompt 要求模型写在 answer_markdown 开头，只用于判定来源 */
const ANSWER_MARK = {
  extracted: '[EXTRACTED_ORIGINAL]',
  generated: '[AI_GENERATED]'
} as const

/**
 * 剥掉答案开头的来源标记。
 *
 * 标记是给解析器看的判定信号，不是答案正文 —— 写进正文就会在题目答案里留一行
 * `[AI_GENERATED]`。模型自己也按 prompt 写了一遍，旧代码又拼了一遍，于是页面上
 * 出现两条。
 */
function stripAnswerMarks(raw: string): {
  text: string
  extracted: boolean
  generated: boolean
} {
  let rest = raw.trim()
  let extracted = false
  let generated = false
  for (;;) {
    if (rest.startsWith(ANSWER_MARK.extracted)) {
      extracted = true
      rest = rest.slice(ANSWER_MARK.extracted.length).trim()
      continue
    }
    if (rest.startsWith(ANSWER_MARK.generated)) {
      generated = true
      rest = rest.slice(ANSWER_MARK.generated.length).trim()
      continue
    }
    break
  }
  return { text: rest, extracted, generated }
}

/**
 * 答案净化：自编答案在「不生成」模式下必须抹掉，这是勾选框的硬保证。
 *
 * 来源标记只参与判断，一律不写回 answerMarkdown。
 */
function sanitizeAnswer(
  answer: string,
  generateAnswers: boolean,
  index: number,
  warnings: string[]
): string {
  const parsed = stripAnswerMarks(answer)
  const text = parsed.text
  if (!text) return ''
  if (!generateAnswers) {
    if (parsed.extracted) return text
    warnings.push(`第 ${index + 1} 题答案未标 [EXTRACTED_ORIGINAL]，按「不生成」规则已清空`)
    return ''
  }
  if (!parsed.extracted) {
    warnings.push(
      `第 ${index + 1} 题答案${parsed.generated ? '为 AI 生成' : '缺少原卷提取标记'}，已按 AI 生成处理`
    )
  }
  return text
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 删掉模型用来分隔题干/答案的 Markdown 水平线（`---`、`***`、`___` 整行）。
 *
 * 那是拆题的辅助记号，不是题目内容 —— 留着会渲染成一条灰线，入库后还会跟到
 * 题库里。整行匹配且只含同一类分隔字符（可夹空白），不会误伤 `- item` 列表、
 * 表格分隔行（含 `|`）或正文里的短横线。
 */
const HR_LINE_RE = /^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm

function stripDividerLines(text: string): string {
  return text.replace(HR_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

function readTargetEvidence(value: unknown): string[] {
  if (typeof value === 'string') {
    const one = value.trim()
    return one ? [one] : []
  }
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (text && !out.includes(text)) out.push(text)
  }
  return out.slice(0, MAX_KNOWLEDGE_POINTS)
}

function normalizeKnowledgePoints(
  raw: unknown,
  context: NormalizeContext,
  content: string,
  answerMarkdown: string,
  index: number
): ParsedKnowledgePoint[] {
  if (!Array.isArray(raw)) return []
  const merged = new Map<string, ParsedKnowledgePoint>()

  for (const item of raw) {
    const code = readString((item as { code?: unknown })?.code)
    // 词表外的编码直接丢：受控词表的意义就是「不许自创」
    const name = context.catalog.get(code)
    if (!name) {
      context.warnings.push(`第 ${index + 1} 题知识点编码「${code || '(空)'}」不在本次词表内，已丢弃`)
      continue
    }
    const roleText = readString((item as { role?: unknown })?.role)
    const role: KnowledgeRole = roleText === 'auxiliary' ? 'auxiliary' : 'main'

    // main 的引文只能来自题干；auxiliary 只能来自解析 —— 模型常把这两者写反，
    // 这里按角色强制归属，只把不一致记成 warning（引文位置本身能自证）
    const derived: EvidenceSource = role === 'auxiliary' ? 'answer_markdown' : 'content'
    const evidenceSource: EvidenceSource = derived
    const declared = readString((item as { evidence_source?: unknown })?.evidence_source)
    if (declared && declared !== derived) {
      context.warnings.push(
        `第 ${index + 1} 题知识点 ${code} 的 evidence_source 写成「${declared}」，与角色 ${role} 不符，已按角色纠正`
      )
    }

    const evidence = readString((item as { evidence?: unknown })?.evidence)
    const targetEvidence = readTargetEvidence((item as { target_evidence?: unknown })?.target_evidence)
    const reason = readString((item as { reason?: unknown })?.reason)

    const haystack = evidenceSource === 'content' ? content : answerMarkdown
    if (!evidence || !containsVerbatim(haystack, evidence)) {
      context.warnings.push(
        `第 ${index + 1} 题知识点 ${code} 的 evidence 未在${evidenceSource === 'content' ? '题干' : '解析'}中逐字出现，已丢弃`
      )
      continue
    }
    if (targetEvidence.length === 0 || !targetEvidence.every((t) => containsVerbatim(content, t))) {
      context.warnings.push(`第 ${index + 1} 题知识点 ${code} 的 target_evidence 未逐字命中题干，已丢弃`)
      continue
    }
    if (!reason) {
      context.warnings.push(`第 ${index + 1} 题知识点 ${code} 缺少 reason，已丢弃`)
      continue
    }

    const scope = readString((item as { scope?: unknown })?.scope)
    const existing = merged.get(code)
    const next: ParsedKnowledgePoint = {
      code,
      name,
      role,
      evidenceSource,
      evidence,
      targetEvidence,
      reason,
      ...(scope ? { scope } : {})
    }
    if (existing) {
      // 同一编码覆盖多个小问：合并引文，主角色优先
      const mergedTarget = Array.from(new Set([...existing.targetEvidence, ...targetEvidence]))
      merged.set(code, {
        ...existing,
        role: existing.role === 'main' || role === 'main' ? 'main' : 'auxiliary',
        targetEvidence: mergedTarget.slice(0, MAX_KNOWLEDGE_POINTS),
        reason: existing.reason.length >= reason.length ? existing.reason : reason
      })
    } else {
      merged.set(code, next)
    }
  }

  return Array.from(merged.values()).slice(0, MAX_KNOWLEDGE_POINTS)
}

/** 从题干里抠出图片路径（模型常漏填 referenced_images，这里补齐） */
function collectImages(content: string): string[] {
  const out: string[] = []
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

function normalizeQuestion(
  raw: unknown,
  context: NormalizeContext,
  index: number
): ParsedQuestion | null {
  const item = raw as Record<string, unknown>
  const content = stripDividerLines(restoreText(context, readString(item?.content), 'content'))
  if (!content) {
    context.warnings.push(`第 ${index + 1} 项 content 为空，已丢弃`)
    return null
  }
  const answerMarkdown = sanitizeAnswer(
    stripDividerLines(restoreText(context, readString(item?.answer_markdown), 'answer')),
    context.generateAnswers,
    index,
    context.warnings
  )

  // 题型：开关关掉时"空"是合法状态（入库题型为空，审查卡补选），不能回退成
  // detailed_answer —— 那等于替用户猜了一个他没要的答案。
  const typeText = readString(item?.subject_type_code)
  let subjectTypeCode = typeText
  if (context.classifySubjectType) {
    if (!context.subjectTypes.has(typeText)) {
      subjectTypeCode = DEFAULT_SUBJECT_TYPE
      if (context.hasTypeCatalog) {
        context.warnings.push(
          `第 ${index + 1} 题题型「${typeText || '(空)'}」不在本次候选中，已回退 ${DEFAULT_SUBJECT_TYPE}`
        )
      }
    }
  } else if (typeText && !context.subjectTypes.has(typeText)) {
    // 没启用题型分类，模型却给了个清单外的值：不认，置空并留一条可回溯的告警
    subjectTypeCode = ''
    context.warnings.push(
      `第 ${index + 1} 题给了题型「${typeText}」，但本次未启用题型分类，已置空`
    )
  }

  const easyText = readString(item?.easy)
  let easy = easyText
  if (!EASY_VALUES.has(easyText)) {
    easy = DEFAULT_EASY
    if (easyText) {
      context.warnings.push(`第 ${index + 1} 题难度「${easyText}」非法，已回退 ${DEFAULT_EASY}`)
    }
  }

  const declaredImages = Array.isArray(item?.referenced_images)
    ? (item.referenced_images as unknown[])
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => v.length > 0)
    : []
  const referencedImages = Array.from(new Set([...declaredImages, ...collectImages(content)]))

  // 模型给不出 source 就用试卷标题补：左栏那个输入框标注的就是「用作题目来源」
  const sourceText = readString(item?.source) || context.fallbackSource

  return {
    content,
    answerMarkdown,
    subjectTypeCode,
    knowledgePoints: context.annotateKnowledge
      ? normalizeKnowledgePoints(item?.knowledge_points, context, content, answerMarkdown, index)
      : [],
    easy,
    source: sourceText || null,
    referencedImages
  }
}

/** 修复轮：JSON 解析失败时的第二次（也是最后一次）调用 */
const REPAIR_SYSTEM_PROMPT = [
  '你是 JSON 修复器。用户会给一段「本该是 JSON 但格式坏了」的文本，',
  '请只输出修复后的严格合法 JSON 对象，不要解释、不要 Markdown 代码块围栏。',
  '规则：删除注释与尾随逗号；补全缺失的引号与括号；字符串内的换行改写成 \\n；',
  'LaTeX 反斜杠按 JSON 规范转义为 \\\\；不要改动任何题目内容、不要新增或删除题目。',
  '顶层结构必须是 {"questions": [...]}。'
].join('')

export async function parsePaperText(options: MathParseOptions): Promise<MathParseResult> {
  const warnings: string[] = []
  const meta: MathParseMeta = {
    subjectCode: options.subjectCode,
    stage: options.stage,
    gradeTerms: [...(options.gradeTerms ?? [])]
  }
  const markdown = options.markdown.replace(/\r\n?/g, '\n').trim()
  if (!markdown) return { ok: false, error: 'EMPTY_SOURCE', warnings, meta }

  const startedAt = Date.now()
  const onLog = options.onLog
  const stripped = stripEmbeddedImages(markdown)
  if (stripped.images > 0) {
    onLog?.(
      `[IMG] 剥离 ${stripped.images} 张内嵌图片（节省 ${stripped.savedChars} 字符，` +
        `正文 ${markdown.length} → ${stripped.text.length} 字符），已替换为 image-NNN.png 占位`
    )
  }

  // 公式锁定只对数学/物理/化学：别的学科正文里的 `$` 多半是普通符号，误锁会破坏原文
  const lock = options.lockFormula
    ? lockVisibleMath(stripped.text)
    : { text: stripped.text, formulas: [] as LockedFormula[] }
  onLog?.(
    options.lockFormula ? `[LOCK] ${summarizeLock(lock)}` : '[LOCK] 本学科不锁公式，原样送入'
  )

  const subjectTypes = options.subjectTypes ?? []
  const knowledgePoints = options.knowledgePoints ?? []

  // 字典空着不是「模型的错」，是数据没灌：说清楚一次，别让用户对着几十条
  // 「题型不在候选」的告警去猜。
  if (options.classifySubjectType && subjectTypes.length === 0) {
    warnings.push(
      `科目「${options.subjectName}」没有配题型字典（subject_type 无数据）：题型一律回退 ` +
        `${DEFAULT_SUBJECT_TYPE}，入库前请先补齐题型字典`
    )
  }
  if (knowledgePoints.length === 0) {
    warnings.push(
      options.annotateKnowledge
        ? '已启用知识点标注，但本次没取到词表（科目/年级范围内没有考点）：题目不会带考点，入库后需人工补'
        : '本次未启用知识点标注：knowledge_points 一律为空，入库后可在审查卡补'
    )
  }

  const systemPrompt = buildSystemPrompt({
    blocks: options.prompts,
    classifySubjectType: options.classifySubjectType,
    annotateKnowledge: options.annotateKnowledge,
    subjectName: options.subjectName,
    stage: options.stage,
    subjectTypes,
    knowledgePoints,
    onWarn: (message) => warnings.push(message)
  })
  const userMessage = buildUserMessage(lock.text, options.title)
  const promptReadyMs = Date.now() - startedAt
  onLog?.(
    `[PROMPT] system ${systemPrompt.length} + user ${userMessage.length} 字符，` +
      `题型${options.classifySubjectType ? ` ${subjectTypes.length} 个` : '关'}、` +
      `知识点${options.annotateKnowledge ? ` ${knowledgePoints.length} 条` : '关'}，本地 ${promptReadyMs}ms`
  )

  const thinking = thinkingPolicy(options.connection)
  const callOptions = {
    baseUrl: options.connection.baseUrl,
    apiKey: options.connection.apiKey,
    model: options.connection.model,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: requestMaxTokens(options.maxTokens),
    responseFormat: 'json_object' as const,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(thinking ? { thinking } : {})
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ]

  const requestStartedAt = Date.now()
  onLog?.(
    `[WAIT] 已发出请求：model=${callOptions.model}, thinking=${thinking ?? 'default'}, ` +
      `max_tokens=${callOptions.maxTokens}, response_format=json_object —— 等待生成（这一步占总耗时 95% 以上）`
  )
  let first = await completeChat({ ...callOptions, messages })
  let requestMs = Date.now() - requestStartedAt
  let degraded = false
  if (first.ok) {
    onLog?.(`[RESP] 首次返回 ${first.text.length} 字符，耗时 ${(requestMs / 1000).toFixed(1)}s`)
  }

  // 兼容性兜底：max_tokens / response_format 不是所有「OpenAI 兼容」端点都认。
  // 400 说明请求形状不被接受 —— 用保守上限重试一次（**不能干脆不发**：不发就是
  // 服务端默认的 4096，长卷必截断，反而多绕一轮修复）。
  if (!first.ok && first.error.startsWith('HTTP_400')) {
    degraded = true
    const fallbackTokens = Math.min(callOptions.maxTokens, 8192)
    warnings.push(
      `模型拒绝了请求参数（max_tokens=${callOptions.maxTokens} / response_format` +
        `${thinking ? ' / thinking' : ''}），已降级为 max_tokens=${fallbackTokens} 重试`
    )
    onLog?.(`[DEGRADE] HTTP 400 → 去掉可选参数、max_tokens=${fallbackTokens} 重试中…`)
    const retryStartedAt = Date.now()
    // 降级时连 thinking 一起去掉：400 也可能是这个扩展字段引起的
    first = await completeChat({
      baseUrl: callOptions.baseUrl,
      apiKey: callOptions.apiKey,
      model: callOptions.model,
      temperature: callOptions.temperature,
      maxTokens: fallbackTokens,
      timeoutMs: callOptions.timeoutMs,
      messages
    })
    requestMs = Date.now() - retryStartedAt
  }

  // 空内容分两种，处置完全相反：
  //   finish=length  → 输出预算被思考过程吃光（思考型模型 + 长卷），重试无用，
  //                    必须换非思考模型或缩短试卷；
  //   其余（stop）   → 偶发空返回，重试一次通常就好了。
  if (!first.ok && first.error.startsWith('EMPTY_RESPONSE')) {
    if (first.error.includes('finish=length')) {
      warnings.push(
        '模型把输出预算全花在思考上（finish=length），没有留下正文：' +
          '请换非思考模型（如 deepseek-chat）或把试卷拆小后重试'
      )
      return { ok: false, error: first.error, warnings, meta }
    }
    warnings.push('模型返回了空内容（偶发），已原样重试一次')
    onLog?.(`[RETRY] 空内容（${first.error}），原参数重试中…`)
    const retryStartedAt = Date.now()
    first = await completeChat({ ...callOptions, messages })
    requestMs += Date.now() - retryStartedAt
  }

  if (!first.ok) return { ok: false, error: first.error, warnings, meta }

  let raw = first.text
  // 先把原始返回落盘再解析：BAD_JSON / 公式闸门 / 字段校验都是在拿到 raw 之后
  // 才可能失败，落在这里才能保证「失败的时候也有东西可看」。
  const rawMeta = {
    model: callOptions.model,
    subjectCode: options.subjectCode,
    title: options.title,
    repaired: false,
    chars: raw.length
  }
  let rawPath = await dumpRawResponse(raw, rawMeta)
  if (rawPath) onLog?.(`[RAW] 模型原始返回已存 ${rawPath}`)
  /** 失败时把落盘路径写进告警：否则用户只有一句「校验未通过」，无从查起 */
  const noteRawPath = (): void => {
    if (rawPath) {
      warnings.push(`模型原始返回已保存：${rawPath}（可打开核对漏抄/重复的具体位置）`)
    }
  }
  let payload = extractJsonPayload(raw)
  let repaired = false

  if (payload === null) {
    repaired = true
    warnings.push(
      `首次输出不是合法 JSON（${raw.length} 字符，可能被 max_tokens=${callOptions.maxTokens} 截断），已发起一次修复调用`
    )
    onLog?.(`[REPAIR] 输出不是合法 JSON（${raw.length} 字符），修复轮调用中…`)
    const repairStartedAt = Date.now()
    const repair = await completeChat({
      ...callOptions,
      messages: [
        { role: 'system', content: REPAIR_SYSTEM_PROMPT },
        { role: 'user', content: raw }
      ]
    })
    requestMs += Date.now() - repairStartedAt
    if (!repair.ok) {
      noteRawPath()
      return { ok: false, error: `BAD_JSON: ${repair.error}`, warnings, meta, raw }
    }
    raw = repair.text
    rawPath =
      (await dumpRawResponse(raw, { ...rawMeta, repaired: true, chars: raw.length })) ?? rawPath
    if (rawPath) onLog?.(`[RAW] 修复轮返回已存 ${rawPath}`)
    payload = extractJsonPayload(raw)
  }
  if (payload === null) {
    noteRawPath()
    return { ok: false, error: 'BAD_JSON', warnings, meta, raw }
  }

  const rawQuestions = pickQuestionArray(payload)
  if (!rawQuestions) {
    noteRawPath()
    return { ok: false, error: 'BAD_SHAPE', warnings, meta, raw }
  }

  const context: NormalizeContext = {
    formulas: lock.formulas,
    generateAnswers: options.generateAnswers,
    catalog: new Map(knowledgePoints.map((p) => [p.code, p.name])),
    subjectTypes: new Set(subjectTypes.map((t) => t.code)),
    hasTypeCatalog: subjectTypes.length > 0,
    classifySubjectType: options.classifySubjectType,
    annotateKnowledge: options.annotateKnowledge,
    warnings: [],
    referenced: new Map<string, number>(),
    referencedInAnswer: new Map<string, number>(),
    overwritten: [],
    fallbackSource: options.title?.trim() ?? ''
  }

  const questions: ParsedQuestion[] = []
  rawQuestions.forEach((item, index) => {
    const question = normalizeQuestion(item, context, index)
    if (question) questions.push(question)
  })
  onLog?.(
    `[VERIFY] 本地校验 ${rawQuestions.length} 项 → ${questions.length} 题，` +
      `丢弃 ${rawQuestions.length - questions.length} 项，告警 ${context.warnings.length} 条，本地 ${Date.now() - startedAt - requestMs}ms`
  )

  warnings.push(...context.warnings)
  if (context.overwritten.length > 0) {
    warnings.push(
      `有 ${context.overwritten.length} 处公式被模型改写后原样照抄（已逐字换回锁定原文）：` +
        context.overwritten.slice(0, 8).join('、') +
        (context.overwritten.length > 8 ? ' 等' : '')
    )
  }

  const referencedIds = context.referenced
  // 「没被引用」有两种合规写法：用 [[ID]] 引用，或按协议把标签内的公式逐字保留下来。
  // 只认 ID 会把后一种全判成漏抄 —— 实测 deepseek-chat 就偏好逐字保留，96 处公式
  // 一个 ID 都不用，却每一处都在题干里。所以判定交给 inspectLockIntegrity：
  // 0 次 ID 引用 + 正文里有该公式原文 = 合规（带定界符的 raw 与纯 latex 都算）。
  //
  // 只拼题干、**不拼答案**：答案里的公式不能证明题干写对了。答案里那处公式属于
  // 「生成内容」，与「原文是否被完整搬过来」是两件事，混进来会把漏抄洗成通过。
  const bodyText = normalizeForMatch(questions.map((q) => q.content).join('\n'))
  const integrity = inspectLockIntegrity(lock.formulas, referencedIds, bodyText)
  const duplicateReferences = [...referencedIds].reduce(
    (sum, [, count]) => sum + Math.max(0, count - 1),
    0
  )

  // ── 公式完整性闸门（对齐 MathBank 的 restore_visible_math）───────────────
  //   duplicated —— 同一 ID 用了两次以上：公式被复制到别的题，串题；
  //   missing    —— 一次没用、正文里也找不到这处公式：静默丢公式。
  // 模型一旦动用 ID 引用（说明它读懂了协议），这两类就整批作废：宁可让人重跑，
  // 也不能把缺一截公式的题悄悄入库。模型完全不用 ID 是协议允许的「逐字保留」
  // 路线，那种情况只告警，不必为卷首/页脚的公式连坐整卷。
  const usesIds = referencedIds.size > 0
  const missingIds = usesIds ? integrity.missing : []
  if (integrity.duplicated.length > 0 || missingIds.length > 0) {
    const brief = (ids: readonly string[]): string =>
      ids.slice(0, 6).join('、') + (ids.length > 6 ? ' 等' : '')
    const reasons: string[] = []
    if (integrity.duplicated.length > 0) {
      reasons.push(`重复引用 ${integrity.duplicated.length} 处（${brief(integrity.duplicated)}）`)
    }
    if (missingIds.length > 0) reasons.push(`漏抄 ${missingIds.length} 处（${brief(missingIds)}）`)
    // 题干里缺的公式如果答案里引用过，说明模型把题干内容挪进了答案 —— 这条线索
    // 能立刻区分「模型偷懒漏抄」和「切题把题干切没了」，否则只能看到一个总数。
    const movedToAnswer = missingIds.filter((id) => context.referencedInAnswer.has(id))
    if (movedToAnswer.length > 0) {
      reasons.push(`其中 ${movedToAnswer.length} 处只出现在答案里（${brief(movedToAnswer)}）`)
    }
    const detail = reasons.join('；')
    warnings.push(
      `公式完整性校验失败：${detail}。为避免公式静默丢失或串题，本次结果已整批作废，` +
        '请直接重试（试卷很长时拆小后再试）'
    )
    onLog?.(`[LOCK] 完整性闸门拦截：${detail}`)
    noteRawPath()
    return { ok: false, error: 'MATH_LOCK_INTEGRITY', warnings, meta, raw }
  }

  if (integrity.missing.length > 0) {
    warnings.push(
      `有 ${integrity.missing.length} 处锁定公式未被任何题目引用（可能是题头/页脚，也可能是漏抄），ID：${integrity.missing
        .slice(0, 8)
        .join('、')}${integrity.missing.length > 8 ? ' 等' : ''}`
    )
  }
  if (duplicateReferences > 0) {
    warnings.push(`有 ${duplicateReferences} 次公式 ID 被重复引用（同一公式应只出现在一道题里）`)
  }
  if (questions.length === 0) warnings.push('模型返回了 0 道题，请检查来源是否为试卷正文')

  return {
    ok: true,
    questions,
    warnings,
    meta,
    stats: {
      total: questions.length,
      lockedFormulas: lock.formulas.length,
      // 被引用 = 用了 ID 引用 + 逐字保留原文，两类都算
      referencedFormulas: lock.formulas.length - integrity.missing.length,
      unreferencedFormulas: integrity.missing.length,
      duplicateReferences,
      model: callOptions.model,
      maxTokens: callOptions.maxTokens,
      promptChars: systemPrompt.length + userMessage.length,
      promptReadyMs,
      requestMs,
      degraded,
      repaired,
      completionTokens: first.usage?.completionTokens ?? 0,
      reasoningTokens: first.usage?.reasoningTokens ?? 0,
      thinking: thinking ?? 'default',
      knowledgePointCount: knowledgePoints.length
    },
    usage: first.usage,
    raw
  }
}

// ─── 单题「AI 生成解析」（审查卡按钮）────────────────────────────────────────
//
// 与整卷拆题共用底层设施（连接、公式锁定、HTTP_400 降级、空返回重试），但输出
// 是**纯文本 Markdown**而不是 JSON：
//   · 不传 response_format=json_object —— 端点对 response_format 的支持参差，
//     纯文本通道没必要冒这个险；
//   · 不复用 buildSystemPrompt —— 它会在末尾追加整卷 JSON【输出格式】段，单题
//     通道拼进去只会诱导模型输出 JSON。这里自行拼 core + answer（generate）
//     两段，并做 {{SUBJECT_NAME}} / {{STAGE_LABEL}} 占位符替换。
// 题型分类、知识点标注两段与本题无关，不查也不注入。

export interface GenerateAnswerOptions {
  /** 题干（审查卡上当前编辑的内容，覆盖式生成以它为准） */
  content: string
  connection: ParseConnection
  /** 只需两段：core_prompt 与 answer_prompt_generate（调用方从库里挑好） */
  prompts: { core: string; answer: string }
  subjectName: string
  /** 学段 primary / junior / senior / other */
  stage: string
  /** 是否锁定公式，来自 subject.lock_formula */
  lockFormula: boolean
  onLog?: (line: string) => void
}

export interface GenerateAnswerResult {
  ok: boolean
  answerMarkdown?: string
  error?: string
  warnings: string[]
}

/** 模型偶尔把答案包进 ```markdown … ``` 围栏：剥掉再入库，正文里的围栏不动 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(trimmed)
  return (fenced ? fenced[1] : trimmed).trim()
}

/**
 * 单题返回也可能按整卷协议包成 JSON（提示词库的 answer 段沿用整卷文案，模型经常
 * 顺手输出 {"answer_markdown": "..."}）：取出字段，别把 JSON 原文当解析入库。
 *
 * JSON.parse 成功时 `\n` / `\"` / `\\` 已被正规还原；整体解析失败（截断、混了
 * 说明文字）但明显带 answer_markdown 字段时，退回正则抠字符串字面量再手工反转义。
 * LaTeX 无恙：合法 JSON 里 `\frac` 必须写成 `\\frac`，反转义后正好回到 `\frac`；
 * 而裸 `\neq` 这类序列只出现在非法 JSON 里，走手工反转义也按字面处理不误伤。
 */
function unwrapAnswerPayload(raw: string): { text: string; unwrapped: boolean } {
  const payload = extractJsonPayload(raw)
  const pick = (item: unknown): string => {
    const value = (item as { answer_markdown?: unknown } | undefined)?.answer_markdown
    return typeof value === 'string' && value.trim() ? value.trim() : ''
  }
  if (payload !== null) {
    if (Array.isArray(payload)) {
      const text = pick(payload[0])
      if (text) return { text, unwrapped: true }
    } else if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>
      const text = pick(obj) || (Array.isArray(obj.questions) ? pick(obj.questions[0]) : '')
      if (text) return { text, unwrapped: true }
    }
  }
  const m = /"answer_markdown"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  if (m) {
    try {
      return { text: JSON.parse(`"${m[1]}"`) as string, unwrapped: true }
    } catch {
      // 字面量里夹了裸换行（非法 JSON）：按转义规则手工还原
      const text = m[1].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (whole: string, esc: string) => {
        switch (esc[0]) {
          case 'n': return '\n'
          case 't': return '\t'
          case 'r': return '\r'
          case '"': return '"'
          case '/': return '/'
          case '\\': return '\\'
          case 'u': {
            const code = Number.parseInt(esc.slice(1), 16)
            return Number.isNaN(code) ? whole : String.fromCharCode(code)
          }
          default: return whole
        }
      })
      return { text, unwrapped: true }
    }
  }
  return { text: raw, unwrapped: false }
}

export async function generateAnswerText(
  options: GenerateAnswerOptions
): Promise<GenerateAnswerResult> {
  const warnings: string[] = []
  const onLog = options.onLog
  const content = options.content.replace(/\r\n?/g, '\n').trim()
  if (!content) return { ok: false, error: 'EMPTY_CONTENT', warnings }

  const stripped = stripEmbeddedImages(content)
  if (stripped.images > 0) {
    onLog?.(`[IMG] 剥离 ${stripped.images} 张内嵌图片（节省 ${stripped.savedChars} 字符）`)
  }
  const lock = options.lockFormula
    ? lockVisibleMath(stripped.text)
    : { text: stripped.text, formulas: [] as LockedFormula[] }
  onLog?.(options.lockFormula ? `[LOCK] ${summarizeLock(lock)}` : '[LOCK] 本学科不锁公式')

  const vars: Record<string, string> = {
    SUBJECT_NAME: options.subjectName,
    STAGE_LABEL: stageLabel(options.stage)
  }
  const fill = (text: string): string =>
    text.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (raw: string, name: string) => vars[name] ?? raw)

  const systemPrompt = [fill(options.prompts.core), fill(options.prompts.answer)]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n')
  if (!systemPrompt) return { ok: false, error: 'BAD_PROMPT', warnings }
  const userMessage = buildUserMessage(lock.text)
  onLog?.(`[PROMPT] system ${systemPrompt.length} + user ${userMessage.length} 字符（单题）`)

  const thinking = thinkingPolicy(options.connection)
  const callOptions = {
    baseUrl: options.connection.baseUrl,
    apiKey: options.connection.apiKey,
    model: options.connection.model,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: requestMaxTokens(undefined),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...(thinking ? { thinking } : {})
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ]

  onLog?.(
    `[WAIT] 已发出请求：model=${callOptions.model}, thinking=${thinking ?? 'default'}, ` +
      `max_tokens=${callOptions.maxTokens} —— 等待生成`
  )
  let first = await completeChat({ ...callOptions, messages })

  // 降级与重试策略与 parsePaperText 一致：HTTP 400 → 去掉扩展参数、保守上限重试；
  // 空返回（finish=length 除外）→ 原参数重试一次。
  if (!first.ok && first.error.startsWith('HTTP_400')) {
    const fallbackTokens = Math.min(callOptions.maxTokens, 8192)
    warnings.push(
      `模型拒绝了请求参数，已降级为 max_tokens=${fallbackTokens} 重试`
    )
    onLog?.(`[DEGRADE] HTTP 400 → max_tokens=${fallbackTokens} 重试中…`)
    first = await completeChat({
      baseUrl: callOptions.baseUrl,
      apiKey: callOptions.apiKey,
      model: callOptions.model,
      temperature: callOptions.temperature,
      maxTokens: fallbackTokens,
      timeoutMs: callOptions.timeoutMs,
      messages
    })
  }
  if (!first.ok && first.error.startsWith('EMPTY_RESPONSE')) {
    if (first.error.includes('finish=length')) {
      warnings.push('模型把输出预算全花在思考上（finish=length）：请换非思考模型后重试')
      return { ok: false, error: first.error, warnings }
    }
    warnings.push('模型返回了空内容（偶发），已原样重试一次')
    onLog?.(`[RETRY] 空内容（${first.error}），原参数重试中…`)
    first = await completeChat({ ...callOptions, messages })
  }
  if (!first.ok) return { ok: false, error: first.error, warnings }

  // 公式还原：模型可能用 [[ID]] 引用题干里的公式，也可能改写后照抄 —— 都换回原文
  const restored = restoreLockedMath(first.text, lock.formulas)
  for (const id of restored.unknown) {
    warnings.push(`解析引用了不存在的公式 ID ${id}（已原样保留，需人工核对）`)
  }
  if (restored.overwritten.length > 0) {
    warnings.push(
      `有 ${restored.overwritten.length} 处公式被模型改写后原样照抄（已逐字换回锁定原文）`
    )
  }

  // ① 模型若按整卷协议输出了 JSON，取出 answer_markdown 字段（顺带还原 \n / \" / \\）
  const unwrapped = unwrapAnswerPayload(restored.text)
  if (unwrapped.unwrapped) {
    warnings.push('模型按整卷协议输出了 JSON，已取出 answer_markdown 字段')
  }
  // ② 剥 ``` 围栏，收敛 3 个以上连续换行、去掉整行水平分割线（与整卷管线同一待遇）
  const answerMarkdown = stripDividerLines(stripCodeFence(unwrapped.text))
  if (!answerMarkdown) {
    return { ok: false, error: 'EMPTY_ANSWER', warnings }
  }
  onLog?.(`[DONE] 生成 ${answerMarkdown.length} 字符，告警 ${warnings.length} 条`)
  return { ok: true, answerMarkdown, warnings }
}
