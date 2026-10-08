// 文档助手：自定义语法的「能力说明 / 规范化 / 校验 / 回填 / 摘要」——模型无关的那一层。
//
// 三条设计约束（都是为了让"换个模型也能用"）：
//   1. 结构化能力**不依赖任何 provider 的 function calling**：全部走文本，随
//      delta.content 流进来，任何能写 Markdown 的模型（含本地小模型）都适用；
//   2. 模型能力参差 → **宽容规范化 + 严格校验**：小毛病（代码块包裹、开场白、全角）
//      修掉，危险的东西（臆造的语法、改坏的图片路径）挡住；
//   3. **不信任模型复述"有副作用的值"**：图片路径这类，按序回填成我们自己的。
//
// 本文件是**纯函数**（不碰 DOM、不碰编辑器）—— 所以能直接用 Node 跑表驱动测试，
// 也能被语法往返测试当作"文档即契约"的唯一数据源（SYNTAX_ENTRIES）。

// 图片参数语法直接复用扩展自己的纯逻辑层 —— 这套"描述#宽#高#对齐#B/S/R"只有一份实现，
// 不在这里抄第二遍（抄了就会漂移）。该文件是纯函数（无 import），所以本模块仍能在
// Node 里直接跑测试。
import {
  parseImageAlt,
  stringifyImageAlt,
  type ImageAlign,
  type ImageParams
} from '../extensions/image-style/lib'

/** 一份语法条目：说明 + 规范示例。示例会被往返测试拿去验，改这里就得能让它过。 */
export interface SyntaxEntry {
  /** 上下文里出现什么才注入（省 token）；'always' 表示通用规则 */
  when: SpecFlag
  zh: string
  en: string
  example: string
  /**
   * 解析成功后应当**从正文里消失**的记号 —— 往返测试用它来证明"语法真的被解析成了
   * 节点"（否则把语法当普通文字原样留着，往返也一样相等，测了等于没测）。
   * 省略表示这条靠结构/DOM 断言来证（如表格：它的规范形本身就是序列化输出）。
   */
  rawMarker?: string
}

export type SpecFlag =
  | 'always'
  | 'image'
  | 'table'
  | 'columns'
  | 'subBlock'
  | 'tianzi'
  | 'pinyin'
  | 'font'
  | 'highlight'

/**
 * 自定义语法清单（唯一数据源）。
 * ⚠️ 每一行 example 都由 `tmp:syntax-roundtrip` 那个真机测试验证过：能被编辑器解析成
 * 对应节点、再序列化回原样。改语法/改示例，跑那个测试就能立刻发现问题。
 */
export const SYNTAX_ENTRIES: SyntaxEntry[] = [
  {
    when: 'always',
    zh: '高亮：==高亮文字==',
    en: 'Highlight: ==text==',
    example: '==高亮文字==',
    rawMarker: '=='
  },
  {
    when: 'always',
    zh: '下划线：<u>下划线文字</u>',
    en: 'Underline: <u>text</u>',
    example: '<u>下划线文字</u>',
    rawMarker: '<u>'
  },
  {
    when: 'always',
    zh: '着重号（字下加点）：@.着重文字.@',
    en: 'Emphasis dot: @.text.@',
    example: '@.着重文字.@',
    rawMarker: '@.'
  },
  {
    when: 'always',
    zh: '填空线：--(4)（4 个字的空线），--(4,blank) 表示填空处留空白',
    en: 'Blank line: --(4), or --(4,blank)',
    example: '请填写：--(4)',
    rawMarker: '--('
  },
  {
    when: 'always',
    zh: '上标：^{x}；下标：_{x}（化学式那种）',
    en: 'Superscript ^{x} / subscript _{x}',
    example: 'H_{2}O 与 x^{2}',
    rawMarker: '_{'
  },
  {
    when: 'always',
    zh: '行内字体/字号：{= family=KaiTi size=12pt : 文字}',
    en: 'Inline font: {= family=KaiTi size=12pt : text}',
    example: '{= family=KaiTi size=12pt : 楷体十二磅}',
    rawMarker: '{= '
  },
  {
    when: 'always',
    zh: '块级字体/对齐：:::font {family=SimSun size=14pt align=justify} 换行 内容 换行 :::',
    en: 'Block font: :::font {family=SimSun size=14pt align=justify} … :::',
    example: ':::font {family=SimSun size=14pt}\n宋体十四磅的一段。\n:::',
    rawMarker: ':::font'
  },
  {
    when: 'always',
    zh:
      '分栏：@@cols 2 换行 各栏内容 换行 @@（N 栏写 @@cols N）。' +
      '⚠️ 每一栏都必须是一个**子块**（@ 开头、单独一行，末尾再一个 @ 收尾），不能直接写段落',
    en:
      'Columns: @@cols 2 … @@ (use @@cols N for N columns). ' +
      'IMPORTANT: each column must be a sub-block (@ on its own line … closing @), not a bare paragraph',
    example: '@@cols 2\n@\n第一栏\n@\n\n@\n第二栏\n@\n@@',
    rawMarker: '@@cols'
  },
  {
    when: 'always',
    zh: '子块（可加边框/居中）：@box#center 换行 内容 换行 @',
    en: 'Sub-block: @box#center … @',
    example: '@box#center\n居中的子块内容\n@',
    rawMarker: '@box#'
  },
  {
    when: 'always',
    zh: '田字格：++你好++（每字一格），++(3)++ 是三格空格，++(tian1qi4)++ 带拼音',
    en: 'Tianzi grid: ++你好++, ++(3)++, ++(tian1qi4)++',
    example: '++你好++',
    rawMarker: '++'
  },
  {
    when: 'always',
    zh: '拼音（汉字上方）：汉字(han4zi4)；同级拼音：汉字[han4zi4]',
    en: 'Pinyin: 汉字(han4zi4) above, 汉字[han4zi4] inline',
    example: '汉字(han4zi4)',
    rawMarker: '(han4zi4)'
  },
  {
    when: 'always',
    zh: '带圈序号：字^{1}（右上角带圈数字）',
    en: 'Circled number: 字^{1}',
    example: '字^{1}',
    rawMarker: '^{1}'
  },
  {
    when: 'image',
    zh:
      '图片参数写在 alt 里，用 # 分隔：![描述#宽#高#对齐#B#S#R](url)。' +
      '对齐取值 left/center/right/float-left/float-right；' +
      'B=加边框、S=加阴影、R=圆角（如 R8px）。例：![示意图#60%#auto#float-right](images/a.png)。' +
      '⚠️ 不要用 `{.float-right}` / `{#id}` 这类属性块写法（本编辑器不认）',
    en:
      'Image options live in the alt, separated by #: ![alt#width#height#align#B#S#R](url). ' +
      'align ∈ left/center/right/float-left/float-right; B=border, S=shadow, R=radius. ' +
      'e.g. ![shot#60%#auto#float-right](images/a.png). ' +
      '⚠️ Never use attribute blocks like `{.float-right}` or `{#id}` — this editor does not support them',
    example: '![示意图#60%#auto#float-right](images/a.png)',
    rawMarker: '#float-right'
  },
  {
    when: 'table',
    zh: '表格用标准 GFM 管道表即可（本编辑器按最短对齐符 `--` 与列宽补空格输出）',
    en: 'Tables: plain GFM pipe tables (this editor emits `--` separators and pads cells)',
    example: '| 列一 | 列二 |\n| -- | -- |\n| 甲  | 乙  |'
  }
]

/**
 * "清空 / 删除这段"的约定输出。
 *
 * 为什么要一个标记：模型没法可靠地"回空"（有的端点拒绝空 content，更多的模型会
 * 顺手写一句"已删除"——那句话会被当成新内容写进正文）。所以约定：要求删除时只输出
 * 这个字面量，我们归一成空串，按"清空这段"落地（见 normalizeAnswer）。
 */
export const EMPTY_SENTINEL = '<<EMPTY>>'

/** 通用规则：每次都要讲（比语法本身更容易被模型踩） */
const RULES_ZH = [
  '只输出内容本身（不要解释、不要用代码块包裹）。',
  `如果指令要求删除 / 清空这段内容，只输出 ${EMPTY_SENTINEL}，别写"已删除"之类的说明（那句话会被当成新内容写进正文）。`,
  '公式：行内用 $…$、独立成行用 $$…$$；**不要用 \\begin{aligned} / \\begin{cases} 之类的环境、也不要用 & 对齐符**' +
    '（本编辑器的公式解析不支持，会渲染失败）。多行方程组请写成多个独立的 $$…$$。',
  '不要臆造语法：上面没写的标记别用（比如不要写 :::columns、<div>、HTML 标签、{.class} 属性块）。',
  '不要改动你不需要改的值：图片 URL 原样抄回来即可，别改写它；不是这次要改的图片参数也不用管。'
]
const RULES_EN = [
  'Output content only — no explanations, no code fences.',
  `If the instruction asks to delete/clear the content, output exactly ${EMPTY_SENTINEL} — never a sentence like "deleted" (that sentence would become the new content).`,
  'Math: $…$ inline, $$…$$ on its own line. Never use \\begin{aligned}/\\begin{cases} or the & alignment character ' +
    '(this editor cannot parse those). Write multi-line systems as several separate $$…$$ blocks.',
  'Do not invent syntax: never use markers not listed above (no :::columns, no <div>, no HTML).',
  'Never touch values you were not asked to change — copy image URLs back verbatim.'
]

export interface ContextScan {
  flags: Set<SpecFlag>
  /** 上下文里出现过的图片 URL（回填/校验用，顺序即出现顺序） */
  imageUrls: string[]
  /** 对应图片的 alt 原文（含 #参数）—— 合并参数时当"打底"用 */
  imageAlts: string[]
}

const IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

/** 扫一遍上下文，决定"这次要注入哪几段语法" */
export function scanContext(markdown: string): ContextScan {
  const flags = new Set<SpecFlag>(['always'])
  const imageUrls: string[] = []
  const imageAlts: string[] = []
  for (const match of markdown.matchAll(IMAGE_RE)) {
    imageUrls.push(match[2])
    imageAlts.push(match[1])
    flags.add('image')
  }
  if (/^\s*\|.*\|\s*$/m.test(markdown)) flags.add('table')
  if (/@@cols\s/.test(markdown)) flags.add('columns')
  if (/@box#/.test(markdown)) flags.add('subBlock')
  if (/\+\+/.test(markdown)) flags.add('tianzi')
  if (/[\u4e00-\u9fa5][\(\[]([a-z]+\d)[\)\]]/.test(markdown)) flags.add('pinyin')
  if (/:::font|{=\s*family=/.test(markdown)) flags.add('font')
  if (/==[^=]+==/.test(markdown)) flags.add('highlight')
  return { flags, imageUrls, imageAlts }
}

/** 生成要拼进 system prompt 的能力说明（按需裁剪，减少 token 与干扰） */
export function capabilitySpec(scan: ContextScan, zh: boolean): string {
  const lines = SYNTAX_ENTRIES.filter((entry) => scan.flags.has(entry.when)).map((entry) =>
    zh ? `- ${entry.zh}` : `- ${entry.en}`
  )
  const rules = (zh ? RULES_ZH : RULES_EN).map((rule) => `- ${rule}`)
  const title = zh
    ? '本编辑器在标准 Markdown 之外还支持以下写法（需要时直接用）：'
    : 'Beyond standard Markdown, this editor supports the following (use them directly when needed):'
  return [title, ...lines, '', zh ? '通用规则：' : 'General rules:', ...rules].join('\n')
}

// ─── 规范化：宽容（把模型的"小毛病"修掉）─────────────────────────────────

// 语言标记随便写（markdown / md / latex / 空…都剥）：实测模型很爱用 ```latex 包公式。
const FENCE_RE = /^\s*(?:```|~~~)[^\n]*\n([\s\S]*?)\n\s*(?:```|~~~)\s*$/
/** 开场白：一整行、以冒号结尾、且不含语法字符 */
const PREAMBLE_RE = /^[^\n:：#*\-|<>[\]{}]{0,40}[:：]\s*$/

/**
 * 把模型输出整理成"可以直接送进解析器"的正文。
 * 只做**保守**的清理：剥掉整体包裹的代码块、去掉一整行开场白。
 */
export function normalizeAnswer(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim()
  const fenced = text.match(FENCE_RE)
  if (fenced) text = fenced[1].trim()
  const lines = text.split('\n')
  if (lines.length > 1 && PREAMBLE_RE.test(lines[0].trim())) {
    text = lines.slice(1).join('\n').trim()
  }
  // "清空这段"的约定标记（见 EMPTY_SENTINEL）→ 归一成空串
  if (/^<{0,2}\s*empty\s*>{0,2}$/i.test(text)) return ''
  return text
}

// ─── 校验 + 回填：严格 ──────────────────────────────────────────────────

export interface AnswerAnalysis {
  /** 回填之后的正文（图片路径已按序还原成我们自己的） */
  markdown: string
  /** 已自动处理的问题（卡片上告知用户"我改了什么"） */
  repairs: string[]
  /** 没能自动处理的问题（卡片上警示，用户仍可自行决定是否应用） */
  warnings: string[]
}

/** 已知的 ::: 指令名（写错的一律告警，不静默通过） */
const KNOWN_DIRECTIVES = new Set(['font'])

/** 图片 + 紧随其后的 Pandoc 风格属性块：![alt](url){.float-right width=60%} */
const IMAGE_BLOCK_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)(\{[^}]{0,120}\})?/g

const ALIGN_ALIASES: Record<string, ImageAlign> = {
  left: 'left',
  center: 'center',
  right: 'right',
  'float-left': 'float-left',
  'float-right': 'float-right',
  floatleft: 'float-left',
  floatright: 'float-right',
  'align-left': 'left',
  'align-center': 'center',
  'align-right': 'right'
}

/** 只保留"真的设了"的参数：别让默认值（false/undefined）把上下文里的参数冲掉 */
function compactParams(params: ImageParams): Partial<ImageParams> {
  const out: Partial<ImageParams> = {}
  if (params.width) out.width = params.width
  if (params.height) out.height = params.height
  if (params.align) out.align = params.align
  if (params.border) out.border = true
  if (params.shadow) out.shadow = true
  if (params.radius) out.radius = true
  return out
}

/**
 * 把 Pandoc / 通用 Markdown 的属性块翻译成本编辑器的图片参数。
 * 实测模型很爱写 `![图](a.png){.float-right}`（本编辑器不认，会被转义成字面文本）。
 * 认得出来的对齐/尺寸直接转；认不出来的记账，由调用方告警。
 */
function translateAttrBlock(block: string): { params: Partial<ImageParams>; unknown: string[] } {
  const params: Partial<ImageParams> = {}
  const unknown: string[] = []
  const body = block.replace(/^\{/, '').replace(/\}$/, '').trim()
  for (const raw of body.split(/\s+/).filter(Boolean)) {
    if (raw.startsWith('.')) {
      const name = raw.slice(1).toLowerCase()
      const align = ALIGN_ALIASES[name]
      if (align) params.align = align
      else if (name === 'border') params.border = true
      else if (name === 'shadow') params.shadow = true
      else if (name === 'radius') params.radius = true
      else unknown.push(raw)
      continue
    }
    const eq = raw.indexOf('=')
    if (eq < 0) {
      unknown.push(raw)
      continue
    }
    const key = raw.slice(0, eq).trim().toLowerCase()
    const value = raw
      .slice(eq + 1)
      .trim()
      .replace(/^["']/, '')
      .replace(/["']$/, '')
    if (key === 'align' || key === 'text-align' || key === 'float') {
      const align = ALIGN_ALIASES[value.toLowerCase()]
      if (align) params.align = align
      else unknown.push(raw)
    } else if (key === 'width' || key === 'w') {
      if (RE_SIZE_TOKEN.test(value)) params.width = value
      else unknown.push(raw)
    } else if (key === 'height' || key === 'h') {
      if (RE_SIZE_TOKEN.test(value)) params.height = value
      else unknown.push(raw)
    } else if (key === 'border' || key === 'shadow' || key === 'radius') {
      if (value !== 'false') params[key] = true
    } else {
      unknown.push(raw)
    }
  }
  return { params, unknown }
}

const RE_SIZE_TOKEN = /^(auto|\d+(?:\.\d+)?(px|%))$/

/**
 * 图片这一块的回填/翻译，三件事一起做（都为了让"任何模型"的输出都能安全落地）：
 *   1. 参数合并：**上下文那张图的参数打底**（模型没提的部分不许悄悄丢）→ 模型写在
 *      alt 里的参数覆盖 → Pandoc 属性块翻译出来的再覆盖；
 *   2. URL 一律用上下文里的（模型复述路径纯属风险，实测也确实会写坏）；
 *   3. 属性块本身从正文里去掉（留着会被转义成字面文本，比丢参数更糟）。
 */
function repairImages(
  markdown: string,
  scan: ContextScan,
  zh: boolean,
  repairs: string[],
  warnings: string[]
): { text: string } {
  const fixedUrls: string[] = []
  let translatedBlocks = 0
  const unknownAttrs = new Set<string>()
  let index = -1
  let count = 0

  const text = markdown.replace(IMAGE_BLOCK_RE, (whole, altRaw: string, url: string, attrBlock?: string) => {
    index += 1
    count += 1
    const sourceUrl = scan.imageUrls[index]
    const sourceAlt = scan.imageAlts[index]
    const answer = parseImageAlt(altRaw)
    const params: Partial<ImageParams> = {}
    if (sourceAlt) Object.assign(params, compactParams(parseImageAlt(sourceAlt).params))
    Object.assign(params, compactParams(answer.params))
    if (attrBlock) {
      const translated = translateAttrBlock(attrBlock)
      translated.unknown.forEach((token) => unknownAttrs.add(token))
      if (Object.keys(translated.params).length > 0) {
        Object.assign(params, translated.params)
        translatedBlocks += 1
      }
    }
    const finalUrl = sourceUrl || url
    if (sourceUrl && url !== sourceUrl) fixedUrls.push(url)
    return `![${stringifyImageAlt(answer.alt, params)}](${finalUrl})`
  })

  if (fixedUrls.length > 0) {
    repairs.push(zh ? `已还原 ${fixedUrls.length} 处图片路径` : `Restored ${fixedUrls.length} image path(s)`)
  }
  if (translatedBlocks > 0) {
    repairs.push(
      zh
        ? `已把 ${translatedBlocks} 处 {.float-right} 之类的写法转成本编辑器的图片参数`
        : `Converted ${translatedBlocks} attribute block(s) into this editor's image options`
    )
  }
  if (unknownAttrs.size > 0) {
    warnings.push(
      zh
        ? `不认识的图片属性：${[...unknownAttrs].join(' ')}（已忽略）`
        : `Unknown image attribute(s) ignored: ${[...unknownAttrs].join(' ')}`
    )
  }
  if (scan.imageUrls.length > 0 && count < scan.imageUrls.length) {
    warnings.push(
      zh
        ? '答案里没有保留原文的图片（若你正是让它把图转成文字/公式，属正常；否则请核对）'
        : 'The answer dropped a source image (normal if you asked to convert it to text/a formula)'
    )
  }
  return { text }
}

function countOccurrences(text: string, re: RegExp): number {
  let count = 0
  for (const _ of text.matchAll(re)) count++
  return count
}

/**
 * 校验模型答案，并顺手把"不该由模型决定的取值"回填回来。
 *
 * 图片路径是重点：改写过程中模型很可能把 URL 抄错/抄丢，而它**没有理由**改这个值。
 * 规则：答案里的图片与上下文里的图片**数量一致**时按序还原路径（记为 repair）；
 * 数量不一致就不敢猜，只告警。
 */
export function analyzeAnswer(markdown: string, scan: ContextScan, zh: boolean): AnswerAnalysis {
  const repairs: string[] = []
  const warnings: string[] = []
  const images = repairImages(markdown, scan, zh, repairs, warnings)
  let text = images.text

  // 未知的块指令：模型很容易自造（:::columns / :::note …）
  for (const match of text.matchAll(/^:::([a-zA-Z][\w-]*)/gm)) {
    if (!KNOWN_DIRECTIVES.has(match[1])) {
      warnings.push(zh ? `不认识的块指令 :::${match[1]}` : `Unknown block directive :::${match[1]}`)
    }
  }
  // 配对检查：::: 必须成偶数；@@cols … @@ 也必须成对
  const colonCount = countOccurrences(text, /^:::/gm)
  if (colonCount % 2 !== 0) {
    warnings.push(zh ? '::: 指令没有配对（少了收尾的 :::）' : 'Unpaired ::: directive')
  }
  const colsOpen = countOccurrences(text, /^@@cols\s/gm)
  const colsClose = countOccurrences(text, /^@@\s*$/gm)
  if (colsOpen !== colsClose) {
    warnings.push(zh ? '@@cols 分栏没有配对（少了收尾的 @@）' : 'Unpaired @@cols block')
  }

  return { markdown: text, repairs, warnings }
}

// ─── 摘要：把"解析后的结果"说成人话（不靠模型自述）──────────────────────

interface NodeLike {
  type?: { name?: string }
  attrs?: Record<string, unknown>
  marks?: NodeLike[] | readonly NodeLike[]
  content?: { forEach: (cb: (child: NodeLike) => void) => void }
}

const NODE_LABELS: Record<string, [string, string]> = {
  cols: ['分栏', 'Columns'],
  sub_block: ['子块', 'Sub-block'],
  font_block: ['字体块', 'Font block'],
  tianzi_grid: ['田字格', 'Tianzi grid'],
  pinyin_ruby: ['拼音', 'Pinyin'],
  pinyin_inline: ['同级拼音', 'Inline pinyin'],
  circled_sup: ['带圈序号', 'Circled number'],
  blank_line: ['填空线', 'Blank line'],
  image: ['图片', 'Image'],
  table: ['表格', 'Table']
}

const MARK_LABELS: Record<string, [string, string]> = {
  emphDot: ['着重号', 'Emphasis dot'],
  underline: ['下划线', 'Underline'],
  highlight: ['高亮', 'Highlight'],
  subscript: ['下标', 'Subscript'],
  superscript: ['上标', 'Superscript'],
  font_span: ['字体', 'Font']
}

const ALIGN_LABELS: Record<string, [string, string]> = {
  left: ['左对齐', 'left'],
  center: ['居中', 'center'],
  right: ['右对齐', 'right'],
  'float-left': ['浮动左', 'float left'],
  'float-right': ['浮动右', 'float right']
}

/**
 * 从**解析后的节点**生成结构摘要（如「分栏(2 栏)」「图片·浮动右」）。
 * 鸭子类型：不依赖 ProseMirror 的具体类，测试可以喂普通对象。
 */
export function describeStructure(nodes: readonly unknown[], zh: boolean): string[] {
  const counts = new Map<string, number>()
  const details = new Set<string>()
  const marks = new Set<string>()

  const pick = (entry: [string, string] | undefined, fallback: string): string =>
    entry ? (zh ? entry[0] : entry[1]) : fallback

  const walk = (input: unknown): void => {
    const node = input as NodeLike
    const name = node.type?.name ?? ''
    if (NODE_LABELS[name]) {
      if (name === 'image') {
        const align = String(node.attrs?.align ?? '')
        const label = pick(ALIGN_LABELS[align], align)
        details.add(align ? `${pick(NODE_LABELS.image, name)}·${label}` : pick(NODE_LABELS.image, name))
      } else {
        counts.set(name, (counts.get(name) ?? 0) + 1)
        if (name === 'cols') {
          const spec = String(node.attrs?.spec ?? '')
          if (spec) details.add(zh ? `分栏(${spec.includes(':') ? spec.replace(':', '/') : spec + ' 栏'})` : `Columns(${spec})`)
        }
      }
    }
    for (const mark of node.marks ?? []) {
      const markName = mark.type?.name ?? ''
      if (MARK_LABELS[markName]) marks.add(pick(MARK_LABELS[markName], markName))
    }
    node.content?.forEach(walk)
  }
  for (const node of nodes) walk(node)

  const parts: string[] = []
  // cols 的细节已经带栏数，别再来一条干巴巴的"分栏 1"
  for (const [name, count] of counts) {
    if (name === 'cols' && [...details].some((item) => item.startsWith(zh ? '分栏' : 'Columns'))) continue
    const label = pick(NODE_LABELS[name], name)
    parts.push(count > 1 ? `${label}×${count}` : label)
  }
  parts.push(...details)
  if (marks.size > 0) parts.push([...marks].join('/'))
  return parts
}

/** 每种语法各来一份的样例文档（往返测试用：喂进编辑器再读回来应当逐字不变） */
export function syntaxSampleMarkdown(): string {
  const seen = new Set<string>()
  const blocks: string[] = []
  for (const entry of SYNTAX_ENTRIES) {
    if (seen.has(entry.example)) continue
    seen.add(entry.example)
    blocks.push(entry.example)
  }
  return blocks.join('\n\n') + '\n'
}
