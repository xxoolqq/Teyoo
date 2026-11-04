// 导入中心「开始解析」的渲染端接缝。
//
// 与 stores/session.ts 同一套写法：electronAPI 用**结构类型**取一小块，而不是
// import 整个 ElectronAPI —— 这份代码同时要在没有 electronAPI 的 Web 宿主里跑，
// 那边 hasMathParseBridge() 返回 false，页面据此禁用按钮而不是抛异常。
//
// 这里只做三件事：
//   1. 把「拖进来的文件 / 粘贴的文本」统一成 Markdown（docx 走主进程转换）
//   2. 发起拆题并拿回结果
//   3. 把主进程的错误码翻成人话

import type { MathParseCatalog, MathParseQuestion, MathParseResult } from '../../preload/index'

/** 下拉项：统一用 code/name（字典表的口径），不再造 value/label 两套名字 */
export interface CatalogOption {
  code: string
  name: string
}

export type SourceKind = '' | 'tex' | 'md' | 'pdf' | 'docx'

/**
 * 审查卡里的可编辑题目：拆题结果 + 导入状态。
 * 元素以 reactive 形式交给题卡组件就地编辑，「导入」只改 saved 标记。
 */
export type EditableQuestion = MathParseQuestion & {
  saved?: boolean
  /** 已入库那条记录的 id：再次导入时带回去，主进程据此 UPDATE 而不是新增 */
  savedId?: number
  /**
   * 上一次导入失败的原因（人话）。
   *
   * 留一个字段而不是只弹 toast：toast 2.6 秒就淡出，而「点了导入、库里却没有」
   * 这种问题恰恰是在几秒之后才被发现 —— 原因得能一直挂在卡片上。
   */
  importError?: string
  /**
   * 科目与学段由解析前那次选择决定，整卷一致 —— 卡片上不给改（一道题换科目
   * 说明选错了试卷，该重新解析而不是这一道题单独改）。
   */
  subjectCode: string
  stage: string
  /** 年级与学期逐题可改：同一份卷子跨年级、跨学期是常事 */
  classLevel: string
  term: string
}

export interface ParseSubjectSelection {
  subjectCode: string
  /** 界面先选学段，年级列表按它收窄 */
  stage: string
  /** 「年级-学期」组合键（`01-1` = 一年级上），空数组表示不限 */
  gradeTerms: string[]
}

interface MathParseBridge {
  mathParseStart?: (payload: {
    markdown: string
    title?: string
    generateAnswers: boolean
    /** 是否让模型判断题型：关掉时不注入题型清单，subject_type_code 留空待人工补 */
    classifySubjectType?: boolean
    /** 是否让模型标注知识点：关掉时不注入词表（默认关，词表约 310 条） */
    annotateKnowledge?: boolean
    subjectCode: string
    stage: string
    gradeTerms: string[]
  }) => Promise<MathParseResult>
  /** 审查卡「AI 生成解析」：单题调一次模型，返回纯文本 Markdown */
  mathParseAnswer?: (payload: {
    content: string
    subjectCode: string
    stage: string
  }) => Promise<{
    ok: boolean
    answerMarkdown?: string
    error?: string
    warnings?: string[]
  }>
  mathParseCatalog?: () => Promise<MathParseCatalog>
  mathParseDocx?: (bytes: Uint8Array) => Promise<{
    ok: boolean
    markdown?: string
    warnings?: string[]
    error?: string
  }>
  mathParsePdf?: (payload: { filePath: string; pageRange?: string }) => Promise<{
    ok: boolean
    markdown?: string
    markdownPath?: string
    jsonPath?: string
    imageCount?: number
    extractDir?: string
    warnings?: string[]
    error?: string
  }>
  /** File → 磁盘路径。Electron 32+ 把 File.path 去掉了，只能走 webUtils 这条桥 */
  getPathForFile?: (file: File) => string
  /** 解析各阶段的实时日志，返回退订函数 */
  onMathParseLog?: (callback: (line: string) => void) => () => void
}

function bridge(): MathParseBridge {
  return (window as unknown as { electronAPI?: MathParseBridge }).electronAPI ?? {}
}

/** 拆题能力是否可用（没有 electronAPI 的 Web 宿主里为 false） */
export function hasMathParseBridge(): boolean {
  return typeof bridge().mathParseStart === 'function'
}

export interface ResolvedSource {
  ok: boolean
  markdown?: string
  /** docx 转换过程的告警（图片公式没认出来、WMF 渲染失败等） */
  warnings?: string[]
  error?: string
}

/**
 * 把用户给的东西变成 Markdown。
 *
 * 来源是文件（拖进来的才是「这份试卷」）；text 留给直接给源码的调用方兜底。
 * docx 走主进程的 docxToMarkdown（OMML / EQ 域 / MathType / MTEF 全覆盖），
 * 渲染端不解析 OOXML —— 那套逻辑只该有一份。
 */
export async function resolveSourceMarkdown(input: {
  kind: SourceKind
  file: File | null
  /** 直接给源码（导入中心的粘贴框已去掉，目前只有兜底用途） */
  text?: string
  /** 页码范围（仅 PDF 用）："1-6, 8"，留空 = 全部页面 */
  pageRange?: string
}): Promise<ResolvedSource> {
  const api = bridge()

  if (input.file) {
    if (input.kind === 'docx') {
      if (typeof api.mathParseDocx !== 'function') {
        return { ok: false, error: 'NO_BRIDGE' }
      }
      try {
        const bytes = new Uint8Array(await input.file.arrayBuffer())
        const result = await api.mathParseDocx(bytes)
        if (!result.ok) return { ok: false, error: result.error ?? 'DOCX_CONVERT_FAILED' }
        return { ok: true, markdown: result.markdown ?? '', warnings: result.warnings ?? [] }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (input.kind === 'pdf') {
      // PDF → Markdown 交给 MinerU（云服务）：本机没有 pdf-inspector 那套「文字层 + 质量闸门」
      // 能力，走云端识别最省事。拿回来的 Markdown 之后与 docx 走完全相同的拆题管线。
      //
      // 传的是**磁盘路径**而不是字节：MinerU 的结果要落在源 PDF 旁边的 <pdf 名>.mineru/，
      // 与「PDF 转 md」完全同一套落盘约定。中转临时目录会让结果跟着临时目录被回收。
      if (typeof api.mathParsePdf !== 'function') {
        return { ok: false, error: 'NO_BRIDGE' }
      }
      const filePath =
        typeof api.getPathForFile === 'function' ? api.getPathForFile(input.file) : ''
      if (!filePath) return { ok: false, error: 'NO_FILE_PATH' }
      try {
        // pageRange 原样透传：解析与校验（格式、越界）都在主进程做，渲染端不重复实现一遍，
        // 免得出现「界面放过了但主进程拒了」这种最难解释的状态。
        const result = await api.mathParsePdf({
          filePath,
          pageRange: input.pageRange?.trim() || undefined
        })
        if (!result.ok) return { ok: false, error: result.error ?? 'PDF_PARSE_FAILED' }
        const markdown = result.markdown ?? ''
        if (!markdown.trim()) return { ok: false, error: 'EMPTY_SOURCE' }
        return { ok: true, markdown, warnings: result.warnings ?? [] }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    try {
      const text = await input.file.text()
      return text.trim() ? { ok: true, markdown: text } : { ok: false, error: 'EMPTY_SOURCE' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const text = (input.text ?? '').trim()
  if (!text) return { ok: false, error: 'EMPTY_SOURCE' }
  return { ok: true, markdown: text }
}

/**
 * 分割线认两种：整行只有 `-` 或整行只有 `*`（3 个及以上，允许首尾空白），
 * 例如 `---`、`----`、`***`、`******`。
 *
 * `___` 刻意不接受 —— 填空横线整行下划线很常见，按分割线切会把一道填空拆成
 * 两半。`***` 曾因「常被当作强调或占位符」被排除，实测题库导出（尤其 Word
 * 转出来的卷子）用它做题目分隔的不少，按要求一并识别；渲染端对整行 `***`
 * 本来就不画线（extension-preview 与拆题清洗都按分隔记号剔除），不会在卡里
 * 留下一条水平线。表格的分隔行 `| --- | --- |` 整行混着竖线，天然不匹配。
 */
const RULE_LINE = /^\s*-{3,}\s*$/
const STAR_LINE = /^\s*\*{3,}\s*$/

/**
 * 手动解析：按 `---` 分割线把源码切成若干段（一份草稿题卡一段）。
 *
 * 只要求「整行只有短横线」，不额外要求它前后有空行：试卷里题目之间常常是
 * `题干最后一行` 紧接着 `---`。代价是
 * ```
 * 2024 学年期中
 * ---
 * ```
 * 这种 setext 二级标题也会被切一刀、多出一张「标题」草稿 —— 拆题场景下这条
 * 更划算，人工删一张卡比漏切一整份卷子省事。
 * 空段直接丢掉：连续两条分割线、开头结尾各一条都很常见。
 */
export function splitMarkdownByRule(markdown: string): string[] {
  const chunks: string[] = []
  let buffer: string[] = []
  const flush = (): void => {
    const text = buffer.join('\n').trim()
    if (text) chunks.push(text)
    buffer = []
  }
  for (const line of markdown.split(/\r?\n/)) {
    if (RULE_LINE.test(line) || STAR_LINE.test(line)) {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return chunks
}

// ── 选择题选项行排版规整 ─────────────────────────────────────────────────────
//
// 题库导出的选择题常把四个选项挤在一行：`A. x B. y C. z D. w`，分隔靠若干
// 半角/全角空格，多少全凭源文件心情。这里把「选项行」里 B~H 每个选项标记
// 前的空白统一成恰好 4 个全角空格（U+3000），预览（pre-wrap）与入库内容
// 都得到整齐的等距排版。
//
// 判定与边界：
//   · 选项行 = 一行里出现 **≥3 个**「行首或空白后紧跟的 A~H 选项标记」
//     （`A.`、`A、`、`A．`、`A)`）。少于 3 个不认 —— 题干正文里「集合 A. 与
//     B.」这类顺手引用只有两个标记，不能误伤；真实选择题至少 A/B/C 三项；
//   · 只处理**空白之后**的 B~H 标记，行首的选项标记不动（那是「一选项一行」
//     的排版，不需要加宽）；紧跟在公式/文字后无空格的标记不碰 —— 无法与
//     正文里的字母可靠区分；
//   · 替换的是标记前的**整段空白**（半角、全角、制表符混排一律归一），所以
//     幂等：跑多少遍结果都一样。
const OPTION_MARK = /(?:^|\s)([A-H][.、．)])/g
const CHOICE_BC_MARK = /\s+([B-H][.、．)])/g
const OPTION_GAP = '　'.repeat(4)

export function spreadChoiceOptions(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      // 选项行 = 一行里 ≥3 个「行首或空白后的 A~H 标记」。少于 3 个不认：
      // 题干正文里「集合 A. 与 B.」这类引用只有两个标记，不能误伤；
      // 真实选择题至少 A/B/C 三项。
      const marks = line.match(OPTION_MARK)?.length ?? 0
      if (marks < 3) return line
      return line.replace(CHOICE_BC_MARK, `${OPTION_GAP}$1`)
    })
    .join('\n')
}

/** 订阅主进程推来的阶段日志（[LOCK]/[WAIT]/[RESP]…），Web 宿主里是空操作 */
export function subscribeParseLogs(callback: (line: string) => void): () => void {
  const api = bridge()
  if (typeof api.onMathParseLog !== 'function') return () => {}
  return api.onMathParseLog(callback)
}

/**
 * 下拉的兜底选项。
 *
 * 唯一来源是主进程的 SQLite 字典表（subject / class_level / subject_type），
 * 跨进程没法直接 import，只能按工程惯例在渲染端留一份小副本（preload 也是这么
 * 处理 TS6307 的）。这里只兜「数学」这一门 —— 别的学科拿不到字典时宁可提示
 * 「科目列表没拉到」，也不能拿数学题型去拼物理卷子的下拉，那会跑出必然被主进程
 * 拒掉的 SUBJECT_TYPE_MISMATCH。
 *
 * 存在的理由：拿不到目录时下拉不能变成一片空白。<select> 的 v-model 值匹配不到
 * 任何 option 时显示的就是空白，看上去像「模型没返回」而不是「选项没拉到」。
 */
export const FALLBACK_SUBJECTS: CatalogOption[] = [{ code: '0001', name: '数学' }]

export const FALLBACK_SUBJECT_TYPES: CatalogOption[] = [
  { code: 'single_choice', name: '单选题' },
  { code: 'multi_choice', name: '多选题' },
  { code: 'fill_in_blank', name: '填空题' },
  { code: 'detailed_answer', name: '解答题' }
]

/** 难度五档固定，与 store 的 EASY_LEVELS / EASY_LABELS 保持一致 */
export const FALLBACK_EASY_LEVELS = [
  { value: '1', label: '很易' },
  { value: '2', label: '易' },
  { value: '3', label: '中' },
  { value: '4', label: '难' },
  { value: '5', label: '拔高' }
]

/** 拉下拉数据源（科目 / 年级 / 题型 / 难度）。失败抛错，由调用方兜底。 */
export async function fetchMathParseCatalog(): Promise<MathParseCatalog> {
  const api = bridge()
  if (typeof api.mathParseCatalog !== 'function') throw new Error('NO_BRIDGE')
  return api.mathParseCatalog()
}

/** 极简 toast：右下角浮出，2.6s 自动消失（MathBank 的 showToast 对齐物） */
export function showToast(message: string, kind: 'info' | 'success' | 'warning' = 'info'): void {
  if (typeof document === 'undefined') return
  const colors: Record<string, string> = {
    info: 'bg-slate-800 text-white',
    success: 'bg-emerald-600 text-white',
    warning: 'bg-amber-500 text-white'
  }
  const el = document.createElement('div')
  el.className = `fixed bottom-6 right-6 z-[9999] px-4 py-2.5 rounded-xl shadow-lg text-xs font-semibold ${colors[kind]}`
  el.style.cssText += 'transition:opacity .25s,transform .25s;opacity:0;transform:translateY(8px)'
  el.textContent = message
  document.body.appendChild(el)
  requestAnimationFrame(() => {
    el.style.opacity = '1'
    el.style.transform = 'translateY(0)'
  })
  window.setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateY(8px)'
    window.setTimeout(() => el.remove(), 300)
  }, 2600)
}

/** 发起拆题。连接信息由主进程现读偏好设置，这里不碰密钥。 */
export async function runMathParse(
  payload: {
    markdown: string
    title?: string
    generateAnswers: boolean
    /** 省 token 用：关掉后模型不判题型，返回的 subject_type_code 为空串 */
    classifySubjectType?: boolean
    /** 省 token 用：关掉后不注入知识点词表，knowledge_points 为空数组 */
    annotateKnowledge?: boolean
  } & ParseSubjectSelection
): Promise<MathParseResult> {
  const api = bridge()
  if (typeof api.mathParseStart !== 'function') {
    return { ok: false, error: 'NO_BRIDGE' }
  }
  try {
    return await api.mathParseStart(payload)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 单题「AI 生成解析」。连接信息由主进程现读偏好设置，这里不碰密钥。 */
export async function runMathParseAnswer(payload: {
  content: string
  subjectCode: string
  stage: string
}): Promise<{ ok: boolean; answerMarkdown?: string; error?: string; warnings?: string[] }> {
  const api = bridge()
  if (typeof api.mathParseAnswer !== 'function') {
    return { ok: false, error: 'NO_BRIDGE' }
  }
  try {
    return await api.mathParseAnswer(payload)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const ERROR_TEXT: Record<string, string> = {
  NO_API_KEY: '未配置大模型密钥：请到 设置 → 文档助手 填写 API Key',
  BAD_BASE_URL: '大模型的 Base URL 不合法：请到 设置 → 文档助手 检查',
  NO_MODEL: '未配置模型名：请到 设置 → 文档助手 填写（如 deepseek-chat）',
  NO_MESSAGES: '请求内容为空',
  BAD_JSON:
    '模型输出不是合法 JSON（已自动修复一次仍失败）：多半是输出上限不够被截断，换长输出模型或把试卷拆成两半再试',
  BAD_SHAPE: '模型输出缺少 questions 数组',
  MATH_LOCK_INTEGRITY:
    '公式完整性校验未通过：模型漏抄或重复引用了公式（每个公式定位编号必须恰好出现一次）。为避免公式静默丢失或串题，本次结果已整批作废，请重试；试卷很长时拆小后再试',
  EMPTY_SOURCE: '没有可解析的内容：请先上传试卷文件（.md / .pdf / .docx）',
  BAD_SUBJECT: '没有可用的科目配置：请先选择科目（或到设置里检查题库字典是否可用）',
  BAD_PROMPT:
    '该科目 + 学段的提示词还没配齐：请在 prompt_table 里补齐 core_prompt / subject_type_prompt / knowledge_point_prompt / answer_prompt_generate（或 _extract）；两个 _off 段可选，缺了会自动用内置默认',
  EMPTY_RESPONSE:
    '模型返回了空内容：思考型模型（如 deepseek-flash）的输出预算可能被思考过程耗尽，换非思考模型（如 deepseek-chat）或缩短试卷',
  NO_BRIDGE: '当前环境不支持解析（需要桌面版）',
  // PDF 走 MinerU 云服务，错误文案都以「PDF」开头，避免和模型侧的报错混在一起
  NO_TOKEN: '未配置 MinerU Token：请到 设置 → 文档助手 填写，或设置环境变量 MINERU_TOKEN',
  NOT_PDF: '选中的文件不是 .pdf',
  NO_FILE_PATH: '拿不到文件的磁盘路径：请用桌面版从本地选择或拖入 PDF',
  FILE_NOT_FOUND: '文件已被移动或删除，请重新选择',
  MINERU_FAILED: 'MinerU 没有返回 Markdown：请重试，或到设置里检查 Token 是否过期',
  PDF_PARSE_FAILED: 'PDF 识别失败（MinerU）',
  DOCX_CONVERT_FAILED: 'Word 文档转换失败：文件可能已损坏或不是 .docx',
  BAD_BYTES: '读到的文件是空的',
  TIMEOUT: '解析超时：试卷可能过长，可拆分后重试'
}

/**
 * 从服务端错误体里捞出那句人话。
 *
 * OpenAI 兼容接口的失败体长这样：
 *   {"error":{"message":"Insufficient Balance","type":"insufficient_balance_error",...}}
 * 整段甩给用户既长又难读（还带 request_id），但完全不展示又没法排查 ——
 * 所以只取 message，取不到才退回截断后的原文。
 */
function serverMessage(detail: string): string {
  const match = /"message"\s*:\s*"([^"]+)"/.exec(detail)
  if (match) return match[1]
  return detail.length > 120 ? `${detail.slice(0, 120)}…` : detail
}

/** 错误码 → 用户能看懂的一句话 */
export function describeParseError(code: string | undefined): string {
  const text = (code ?? '').trim()
  if (!text) return '解析失败（未返回原因）'
  if (text.startsWith('HTTP_')) {
    // 402 余额不足、401/403 密钥问题、429 限流、5xx 对方炸了 —— 必须分开说，
    // 这几种的处置完全不同（充值 / 改 Key / 等一会儿 / 等恢复）。
    const rest = text.slice(5)
    const status = rest.slice(0, 3)
    const detail = rest.includes(': ') ? serverMessage(rest.slice(rest.indexOf(': ') + 2)) : ''
    const suffix = detail ? `（${detail}）` : ''
    if (status === '402') {
      return `模型账户余额不足（402）${suffix}：请到模型服务商平台充值，或改用另一个有余额的 Key`
    }
    if (status === '401' || status === '403') return `模型拒绝授权（${status}），请检查 API Key 与 Base URL`
    if (status === '429') return '模型限流（429），请稍后重试或换模型'
    if (status === '400') return `模型拒绝了请求参数（400）${suffix}：多为输出上限或模型名不被支持`
    if (status.startsWith('5')) return `模型服务异常（${status}），请稍后重试`
    return `请求失败（${status}）${suffix}`
  }
  const exact = ERROR_TEXT[text]
  if (exact) return exact

  // 带诊断后缀的错误（`EMPTY_RESPONSE: finish=length, reasoning_tokens=8192`）：
  // 用前缀查表，把原始证据留在括号里 —— 处置建议在前面，证据在后面
  const colon = text.indexOf(': ')
  if (colon > 0) {
    const head = text.slice(0, colon)
    const detail = text.slice(colon + 2)
    if (head === 'BAD_JSON' && detail.startsWith('EMPTY_RESPONSE')) {
      return '模型两次都返回了空内容：换非思考模型（如 deepseek-chat）或把试卷拆小后重试'
    }
    const mapped = ERROR_TEXT[head]
    if (mapped) return `${mapped}（${detail}）`
  }
  return `解析失败：${text}`
}
