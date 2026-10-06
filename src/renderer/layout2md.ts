// MinerU 解析结果（layout.json）→ Markdown。
//
// 规则逐条对齐 WorkBuddy 里那份 Python 版（PDF-Markdown双向定位Demo/layout2md.py）：
//   title(level=N)     -> N 个 '#'（夹在 1..6）
//   text               -> 段落
//   interline_equation -> $$ ... $$ 独立公式块
//   image              -> ![](图片 data URL)
//   table              -> GFM 表格（有 html）；没有 html 时退回表格截图图片
//   其余（page_number / header / footer 等）-> 跳过
// 块之间空一行；块内跨行拼接：CJK 为主时无缝，否则补一个空格。
//
// 除了 Markdown 文本，还一并产出块锚点（BlockAnchor）：PDF 侧画矩形框、Markdown
// 侧打标记都靠它，两边对的是同一个 id —— 不是事后匹配出来的，是同一次遍历构造的。
//
// 数据形状是必須注意的一点：image / table 这两种块本身不带内容目录，内容在
// 子块里一层套一层 —— image 块的 blocks[0]（image_body）→ lines[0].spans[0]
// 才是 {type:'image', image_path}，table 块同理是 blocks[0]（table_body）的
// span 挂着 html / image_path。只读顶层字段会把所有图片表格读成空，退化成占位。
// 所以下面统一 depth-first 扫 span。

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g

interface LayoutSpan {
  type?: string
  content?: string
  image_path?: string
  html?: string
}

interface LayoutLine {
  spans?: LayoutSpan[]
  bbox?: number[]
}

interface LayoutBlock {
  type?: string
  level?: number
  bbox?: number[]
  lines?: LayoutLine[]
  /** MinerU 新结构：image / table 块的内容在子块里（image_body / table_body）。 */
  blocks?: LayoutBlock[]
  image_path?: string
  html?: string
}

interface LayoutPage {
  page_idx?: number
  page_size?: number[]
  para_blocks?: LayoutBlock[]
  preproc_blocks?: LayoutBlock[]
}

interface LayoutDocument {
  pdf_info?: LayoutPage[]
}

/** 一个块在两侧的共同身份。kind 是它在编辑器里会变成的节点大类。 */
export interface BlockAnchor {
  id: string
  pageIdx: number
  kind: 'heading' | 'paragraph' | 'math'
  type: string
  /** 块级 bbox（PDF 坐标，左上原点）；缺失时画不出来，只能单向定位。 */
  bbox: number[] | null
  /** 块文本去掉空白后的前 20 字：编辑过后重新对位用的指纹。 */
  fingerprint: string
  /** 块文本长度，指纹之外的第二个弱判据。 */
  length: number
}

export interface LayoutMarkdown {
  markdown: string
  blocks: BlockAnchor[]
  /** 每页的 page_size（PDF 坐标），PDF 侧换算矩形要用。 */
  pageSizes: Array<number[] | null>
}

export interface LayoutConvertOptions {
  /**
   * 图片相对路径 → 可直接写进 Markdown 的 src。调用方（Electron 渲染端）借此
   * 把 MinerU 抽出来的图片读成 data URL 内嵌；读不到返回 null，正文里就退成
   * 原路径（破图也保留，比静默丢内容好判断）。不传则一律输出相对路径。
   */
  imageResolver?: (imagePath: string) => Promise<string | null> | string | null
}

function cjkRatio(text: string): number {
  if (!text) return 0
  const matches = text.match(CJK)
  return matches ? matches.length / text.length : 0
}

function joinLines(lineTexts: string[]): string {
  let out = ''
  for (let index = 0; index < lineTexts.length; index++) {
    out += lineTexts[index]
    if (index < lineTexts.length - 1) {
      const next = lineTexts[index + 1]
      const separator = cjkRatio(lineTexts[index]) > 0.3 || cjkRatio(next) > 0.3 ? '' : ' '
      out += separator
    }
  }
  return out
}

/**
 * 指纹：去掉空白与 `$` 后的前 20 字。
 * 空白不可信（Markdown 解析会重新折行）；`$` 也要去掉 —— 行内公式进编辑器后
 * 变成 math_inline 节点，节点文本是公式本身，不带那两个 `$`。
 */
export function blockFingerprint(text: string): string {
  return text.replace(/\s+/g, '').replace(/\$/g, '').slice(0, 20)
}

function spanText(span: LayoutSpan): string {
  const content = span.content ?? ''
  // 行内公式按 MinerU 官方 md 输出包成 $...$
  return span.type === 'inline_equation' ? `$${content}$` : content
}

function renderLine(line: LayoutLine): string {
  return (line.spans ?? []).map(spanText).join('')
}

function blockLines(block: LayoutBlock): string[] {
  return (block.lines ?? []).map(renderLine)
}

/** 深度优先遍历一个块（含子块）的所有 span：image/table 的内容都挂在里面。 */
function eachSpan(block: LayoutBlock, visit: (span: LayoutSpan) => void): void {
  for (const line of block.lines ?? []) {
    for (const span of line.spans ?? []) visit(span)
  }
  for (const sub of block.blocks ?? []) eachSpan(sub, visit)
}

/** 块里第一张图片的相对路径（没有就是 null）。 */
function firstImagePath(block: LayoutBlock): string | null {
  let found: string | null = null
  eachSpan(block, (span) => {
    if (found === null && span.image_path) found = span.image_path
  })
  return found
}

/** 块里第一段表格 html（没有就是 null）。 */
function firstTableHtml(block: LayoutBlock): string | null {
  let found: string | null = null
  eachSpan(block, (span) => {
    if (found === null && span.html) found = span.html
  })
  return found
}

// ── 表格：MinerU 的 <table> html → GFM 表格 ─────────────────────────────────
// 为什么转：编辑器（Milkdown + gfm preset）对 table 节点有原生渲染，挂 picture
// 的那套 NodeView 也齐全；而 html 节点是 inline 的，一行 <table> 塞进去能不能看、
// 看了能不能编辑都不由我们控制。GFM 表格渲染确定、可编辑，代价是合并单元格在
// Markdown 里没有对应语法 —— colspan 按占位数留空、rowspan 只能忽略（MinerU
// 抽出来的表格大多不带合并；真带了的会降级，但不会错位崩坏）。

interface TableCell {
  text: string
  colspan: number
}

interface TableRow {
  cells: TableCell[]
  isHeader: boolean
}

// 单元格文本用：换行、命名实体。顺序有讲究 —— &amp; 必须最后，先解会让
// &amp;lt; 这类二次转义提前露出一个 < 出来。
const NAMED_ENTITIES: Array<[RegExp, string]> = [
  [/<br\s*\/?>/gi, ' '],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&apos;|&#0*39;/gi, "'"],
  [/&nbsp;/gi, ' '],
  [/&amp;/gi, '&'],
]

/** 单元格的 HTML → 纯文本：`<br>` 转空格、实体解码、标签剥掉、`|` 转义。 */
function cellText(raw: string): string {
  let text = raw
  for (const [pattern, replacement] of NAMED_ENTITIES) text = text.replace(pattern, replacement)
  return text
    // 数字实体（&#8592; / &#x2190;）：命名实体解完之后才是它自己的回合。
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/<[^>]*>/g, '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim()
}

function attributeValue(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']?([^"'\\s>]*)`, 'i'))
  return match ? match[1] : ''
}

function parseTableRow(rowHtml: string): TableRow {
  const cells: TableCell[] = []
  let isHeader = false
  const cellPattern = /<(td|th)\b([\s\S]*?)>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  while ((match = cellPattern.exec(rowHtml)) !== null) {
    if (match[1].toLowerCase() === 'th') isHeader = true
    const span = Number.parseInt(attributeValue(match[2], 'colspan'), 10)
    cells.push({ text: cellText(match[3]), colspan: Number.isFinite(span) && span > 1 ? span : 1 })
  }
  return { cells, isHeader }
}

/**
 * <table> html → GFM 表格文本。一行都没有（或解析不出单元格）返回 null，
 * 调用方据此退到表格截图 / 占位。
 */
export function tableHtmlToMarkdown(html: string): string | null {
  const rowHtmls = html.match(/<tr\b[\s\S]*?<\/tr>/gi)
  if (!rowHtmls?.length) return null
  const rows = rowHtmls.map(parseTableRow).filter((row) => row.cells.length > 0)
  if (!rows.length) return null

  // 列数以最宽的一行为准（colspan 按占位数计入），短行补空单元格对齐。
  const columnCount = rows.reduce((widest, row) => {
    const width = row.cells.reduce((sum, cell) => sum + cell.colspan, 0)
    return Math.max(widest, width)
  }, 0)
  if (columnCount <= 0) return null

  // 有 th 行就用第一行 th 当表头；一个 th 都没有就用第一行 —— GFM 表格必须有
  // 表头，不拿第一行顶上就是整张表渲染不出来。
  const headerIndex = Math.max(rows.findIndex((row) => row.isHeader), 0)
  const expand = (row: TableRow): string[] => {
    const out: string[] = []
    for (const cell of row.cells) {
      out.push(cell.text)
      for (let extra = 1; extra < cell.colspan; extra += 1) out.push('')
    }
    while (out.length < columnCount) out.push('')
    return out.slice(0, columnCount)
  }

  const header = expand(rows[headerIndex])
  const body = rows.filter((_row, index) => index !== headerIndex).map(expand)
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`
  return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...body.map(line)].join('\n')
}

// 没有内容的图片/表格块：留一行可见占位，编辑器里才有得悬停、有得高亮
//（纯 HTML 注释解析后是不可见节点，鼠标根本落不上去）。
function bboxNote(label: string, bbox: unknown): string {
  const value = Array.isArray(bbox) ? `[${(bbox as unknown[]).join(', ')}]` : JSON.stringify(bbox ?? null)
  return `［${label} ${value}］`
}

// 图片 alt 一律写「图片」：解析结果里没有描述文字，空 alt 在源码里看着像漏了东西，
// 也给不出信息；写死这两个字至少让图片节点在纯文本视图里可辨认。
const IMAGE_ALT = '图片'

/** 图片路径 → `![图片](src)`：resolver 给得出 URL 就用，给不出就保留原相对路径。 */
async function imageMarkdown(imagePath: string, options: LayoutConvertOptions): Promise<string> {
  let src = imagePath
  if (options.imageResolver) {
    try {
      src = (await options.imageResolver(imagePath)) ?? imagePath
    } catch {
      // 读图失败不影响正文结构：退回相对路径，界面上是破图但内容还在。
      src = imagePath
    }
  }
  return `![${IMAGE_ALT}](${src})`
}

async function renderBlock(
  block: LayoutBlock,
  options: LayoutConvertOptions,
): Promise<{ md: string; kind: BlockAnchor['kind']; text: string }> {
  switch (block.type) {
    case 'title': {
      const level = Math.min(Math.max(block.level ?? 2, 1), 6)
      const text = joinLines(blockLines(block)).trim()
      return { md: `${'#'.repeat(level)} ${text}`, kind: 'heading', text }
    }
    case 'interline_equation': {
      const body = blockLines(block).map((text) => text.trim()).join('\n').trim()
      return { md: body ? `$$\n${body}\n$$` : '', kind: 'math', text: body }
    }
    case 'image': {
      const path = block.image_path ?? firstImagePath(block)
      // 有图片路径：正文里是 image 节点，本身没有文本（对齐时靠"含图片子节点"认）。
      // 没有路径：退化成一行可见占位，指纹就是这行占位文字。
      const md = path ? await imageMarkdown(path, options) : bboxNote('图片', block.bbox)
      return { md, kind: 'paragraph', text: path ? '' : md }
    }
    case 'table': {
      // 优先 span 里的 html（子块结构），顶层 html 也认（老一些的解析结果）。
      const html = block.html ?? firstTableHtml(block)
      const table = html ? tableHtmlToMarkdown(html) : null
      if (table) return { md: table, kind: 'paragraph', text: '' }
      // 没有 html 或解析不出单元格：MinerU 给每个表格都出了一张截图，用它兜住。
      const path = block.image_path ?? firstImagePath(block)
      if (path) return { md: await imageMarkdown(path, options), kind: 'paragraph', text: '' }
      const md = bboxNote('表格', block.bbox)
      return { md, kind: 'paragraph', text: md }
    }
    case 'text': {
      const text = joinLines(blockLines(block)).trim()
      return { md: text, kind: 'paragraph', text }
    }
    default:
      return { md: '', kind: 'paragraph', text: '' } // page_number / header / footer 之类不进正文
  }
}

/**
 * 解析结果 → Markdown 文本 + 块锚点。不是 MinerU 结构（没有 pdf_info，或一块都
 * 没认出来）时 markdown 为空串、blocks 为空：调用方据此保持编辑器原样。
 *
 * 异步只是因为图片可能要读盘（resolver）；不传 resolver 时逻辑与同步版本等价。
 */
export async function layoutToMarkdown(data: unknown, options: LayoutConvertOptions = {}): Promise<LayoutMarkdown> {
  const document_ = data as LayoutDocument | null
  const pages = Array.isArray(document_?.pdf_info) ? (document_ as LayoutDocument).pdf_info ?? [] : []
  const parts: string[] = []
  const blocks: BlockAnchor[] = []
  const pageSizes: Array<number[] | null> = []
  for (const [pageIdx, page] of pages.entries()) {
    pageSizes.push(page.page_size ?? null)
    // para_blocks 是排版后的正文块；没有就退回预处理块（老一些的解析结果）。
    const list = page.para_blocks ?? page.preproc_blocks ?? []
    for (const [blockIdx, block] of list.entries()) {
      const { md, kind, text } = await renderBlock(block, options)
      if (!md.trim()) continue
      parts.push(md)
      blocks.push({
        id: `p${pageIdx}_${blockIdx}`,
        pageIdx,
        kind,
        type: block.type ?? '',
        bbox: Array.isArray(block.bbox) ? block.bbox : null,
        fingerprint: blockFingerprint(text),
        length: text.length
      })
    }
  }
  return { markdown: parts.length ? `${parts.join('\n\n')}\n` : '', blocks, pageSizes }
}

/**
 * 只要位置信息（文本丢掉）：PDF 矩形 ↔ 正文块的联动靠它认块 —— bbox 与
 * page_size 只有这份中间结果里有，full.md 里一个字都没有。
 *
 * 必须与上面的遍历走同一套规则：哪块算「进了正文」由同一处判断（跳过 md 为空
 * 的块），锚点顺序才跟 MinerU 自己写的 full.md 里的块顺序一致；另起一套的话
 * 两边块数不同，对齐会从头错位到尾。
 */
export async function layoutBlockAnchors(data: unknown): Promise<Pick<LayoutMarkdown, 'blocks' | 'pageSizes'>> {
  const { blocks, pageSizes } = await layoutToMarkdown(data)
  return { blocks, pageSizes }
}
