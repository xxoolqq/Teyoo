// JSON 视图：只读展示解析结果（MinerU 的 layout.json 之类）。
//
// 三条硬要求是从数据来的：那份测试 JSON 有 8922 个节点、美化后 11396 行 ——
//   · 缩进：JSON.stringify(value, null, 2)，2 空格，键不重排（页码顺序有意义）；
//   · 只读：这是解析结果，不是给人手改的；
//   · 只画可视区那几十行：全量建 DOM 是 5 万+ 节点，首屏就卡住了。
//
// 数据来源：打开 PDF 时自动带出同目录同名 .json（sidecar），带不出来就给
// 「打开 JSON…」。等服务端解析接上，把结果按同名写回（或直接喂进 setSource），
// 这一层不用改。
import { isChinese } from './ui-language'

const INDENT = 2
// 上下多画几行：滚动时不会露出空白边。
const BUFFER_ROWS = 8

interface JsonLine {
  text: string
  foldable: boolean
  // 折叠区间的最后一行（含）：点一下三角，open..end 之间的行都不画。
  end: number
  collapsed: boolean
}

let lines: JsonLine[] = []
// 当前实际画出来的行号（折叠区间的行被剔除）。
let visible: number[] = []
let prettyText = ''
// 解析后的对象：Markdown 还原（layout2md.ts）吃的是它，不是美化文本 —— 省一次
// parse，也让「同一份 JSON 只转一次」能用引用比较判定。
let parsedData: unknown = null
// 这份 JSON 的路径：Markdown 还原要把图片相对路径按它所在的目录解析
//（MinerU 抽出来的图落在同级的 images/ 里）。手动「打开 JSON…」也算。
let sourcePath: string | null = null
// 这份 JSON 是怎么来的：PDF 旁边带出来的 sidecar，还是「打开 JSON…」手选的。
// 图片基准目录按它决定先认谁的目录。
let sourceOrigin: 'sidecar' | 'dialog' | null = null
// 一份新 JSON 到位（sidecar 或「打开 JSON…」）的通知，给 main.ts 同步 Markdown。
let jsonLoadedHandler: (() => void) | null = null
let maxLineLength = 0
let lineHeight = 19
let charWidth = 7.2

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

// ── 建行表 ──────────────────────────────────────────────────────────────
// 缩进层级直接从行首空格数算（JSON.stringify 的缩进就是 2 空格，不用再解析一遍）。
// 括号配对用一次栈扫描：行尾是 { 或 [ 的是开，行首是 } 或 ] 的是闭 —— 这样
// 同一行的空容器 {} / [] 既不算开也不算闭，不会配错。
function buildLines(source: string): JsonLine[] {
  const raw = source.split('\n')
  const result: JsonLine[] = []
  const stack: number[] = []
  let longest = 0
  raw.forEach((line, index) => {
    const trimmed = line.trim()
    result.push({ text: line, foldable: false, end: -1, collapsed: false })
    if (line.length > longest) longest = line.length
    if (trimmed.endsWith('{') || trimmed.endsWith('[')) {
      stack.push(index)
    } else if (trimmed.startsWith('}') || trimmed.startsWith(']')) {
      const open = stack.pop()
      if (open !== undefined) {
        result[open].foldable = true
        result[open].end = index
      }
    }
  })
  maxLineLength = longest
  return result
}

function computeVisible(source: JsonLine[]): number[] {
  const result: number[] = []
  let skipTo = -1
  for (let index = 0; index < source.length; index++) {
    if (index <= skipTo) continue
    result.push(index)
    const line = source[index]
    if (line.collapsed && line.foldable) skipTo = line.end
  }
  return result
}

// ── 着色 ────────────────────────────────────────────────────────────────
// 只给可视区那几十行做，所以直接拼字符串就够了，不必上 tokenizer 框架。
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlight(line: string): string {
  let out = ''
  let last = 0
  TOKEN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN.exec(line)) !== null) {
    if (match.index > last) out += escapeHtml(line.slice(last, match.index))
    const [, str, colon, num, keyword, punct] = match
    if (str !== undefined) {
      // 带冒号的是键，冒号本身算标点。
      out += colon
        ? `<span class="json-key">${escapeHtml(str)}</span><span class="json-punct">${escapeHtml(colon)}</span>`
        : `<span class="json-string">${escapeHtml(str)}</span>`
    } else if (num !== undefined) {
      out += `<span class="json-number">${escapeHtml(num)}</span>`
    } else if (keyword !== undefined) {
      out += `<span class="json-bool">${escapeHtml(keyword)}</span>`
    } else if (punct !== undefined) {
      out += `<span class="json-punct">${escapeHtml(punct)}</span>`
    }
    last = match.index + match[0].length
  }
  if (last < line.length) out += escapeHtml(line.slice(last))
  return out
}

// ── 渲染 ────────────────────────────────────────────────────────────────
function rowHtml(index: number, rowTop: number, line: JsonLine, hiddenCount: number): string {
  const fold = line.foldable
    ? `<button class="json-fold${line.collapsed ? ' is-collapsed' : ''}" type="button" data-index="${index}" aria-expanded="${String(!line.collapsed)}">${line.collapsed ? '▸' : '▾'}</button>`
    : '<span class="json-fold-space"></span>'
  const hint = hiddenCount > 0 ? `<span class="json-collapsed-hint">⋯ ${hiddenCount} 行</span>` : ''
  return (
    `<div class="json-row" style="top:${rowTop}px">` +
    `<span class="json-ln">${index + 1}</span>` +
    fold +
    `<span class="json-code">${highlight(line.text)}</span>` +
    hint +
    '</div>'
  )
}

function renderWindow(): void {
  const viewport = el('json-viewport')
  const host = el('json-lines')
  if (!viewport || !host) return
  const first = Math.max(0, Math.floor(viewport.scrollTop / lineHeight) - BUFFER_ROWS)
  const count = Math.ceil(viewport.clientHeight / lineHeight) + BUFFER_ROWS * 2
  const last = Math.min(visible.length, first + count)
  let html = ''
  for (let row = first; row < last; row++) {
    const index = visible[row]
    const line = lines[index]
    const hidden = line.collapsed && line.foldable ? line.end - index : 0
    html += rowHtml(index, row * lineHeight, line, hidden)
  }
  host.innerHTML = html
}

function measure(): void {
  const viewport = el('json-viewport')
  if (!viewport) return
  // 行高以 CSS 为准（--json-line-height），字符宽度量一次等宽字体的 '0'。
  const value = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--json-line-height'))
  if (Number.isFinite(value) && value > 0) lineHeight = value
  const probe = document.createElement('span')
  probe.className = 'json-probe'
  probe.textContent = '0'.repeat(100)
  viewport.append(probe)
  const width = probe.getBoundingClientRect().width / 100
  probe.remove()
  if (width > 0) charWidth = width
}

function render(): void {
  const viewport = el('json-viewport')
  const host = el('json-lines')
  if (!viewport || !host) return
  // 撑出滚动范围：纵向 = 可见行数，横向 = 最长行的宽度（等宽字体可算）。
  host.style.height = `${visible.length * lineHeight}px`
  host.style.width = `${Math.ceil(maxLineLength * charWidth + 120)}px`
  const maxScroll = Math.max(0, visible.length * lineHeight - viewport.clientHeight)
  if (viewport.scrollTop > maxScroll) viewport.scrollTop = maxScroll
  renderWindow()
}

// ── 三种状态：树 / 空 / 解析失败 ────────────────────────────────────────
function showPane(tree: boolean): void {
  const viewport = el('json-viewport')
  const empty = el('json-empty')
  if (viewport) viewport.hidden = !tree
  if (empty) empty.hidden = tree
}

function setEmptyText(message: string): void {
  const text = el('json-empty-text')
  if (text) text.textContent = message
  showPane(false)
}

function setSource(raw: string, path: string | null, origin: 'sidecar' | 'dialog'): void {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    prettyText = ''
    parsedData = null
    lines = []
    visible = []
    const detail = error instanceof Error ? error.message : String(error)
    setEmptyText(
      `${isChinese() ? '不是合法的 JSON：' : 'Not valid JSON: '}${detail}` +
        (path ? `\n${path}` : '')
    )
    return
  }
  prettyText = JSON.stringify(value, null, INDENT)
  parsedData = value
  sourcePath = path
  sourceOrigin = origin
  lines = buildLines(prettyText)
  visible = computeVisible(lines)
  showPane(true)
  measure()
  render()
  jsonLoadedHandler?.()
}

// ── 对外 ────────────────────────────────────────────────────────────────
export function initJsonView(): void {
  const zh = isChinese()
  const viewport = el('json-viewport')
  const host = el('json-lines')
  const openBtn = el<HTMLButtonElement>('json-open-btn')
  setEmptyText(
    zh
      ? '还没有 JSON：在线解析的结果会自动带出来（PDF 旁边的「<pdf 名>.mineru」目录），也可以手动选一个。'
      : 'No JSON yet: the online parse result is picked up automatically (the "<pdf name>.mineru" folder next to the PDF), or pick one manually.'
  )
  if (openBtn) {
    openBtn.textContent = zh ? '打开 JSON…' : 'Open JSON…'
    openBtn.addEventListener('click', () => {
      void loadJsonViaDialog()
    })
  }
  if (viewport) {
    // 直接重画，不套 requestAnimationFrame：窗口不可见（或被节流）时帧回调不会
    // 触发，滚动就会停在旧的那几行上。可视区就 50 行上下，重画一次不到 1ms，
    // 滚动事件里同步做完全够。
    viewport.addEventListener('scroll', () => {
      renderWindow()
    }, { passive: true })
  }
  // 折叠：事件委托 —— 行是每次重画的新节点，不能逐个挂监听。
  host?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest('.json-fold')
    const index = Number.parseInt(button?.getAttribute('data-index') ?? '', 10)
    if (!Number.isFinite(index) || !lines[index]) return
    lines[index].collapsed = !lines[index].collapsed
    visible = computeVisible(lines)
    render()
  })
  window.addEventListener('resize', () => {
    measure()
    render()
  })
}

/** 切到 JSON 模式时才量得到真实高度（面板此前是 display:none）。 */
export function refreshJsonLayout(): void {
  if (!lines.length) return
  measure()
  render()
}

/** 复制按钮在 JSON 模式下复制的就是这份美化后的文本。 */
export function getJsonText(): string {
  return prettyText
}

/** 解析后的对象（给 Markdown 还原用）；还没有 JSON 时是 null。 */
export function getJsonData(): unknown {
  return parsedData
}

/** 当前 JSON 的所在路径（sidecar 或手动打开的）；图片相对路径按它的目录解析。 */
export function getJsonPath(): string | null {
  return sourcePath
}

/** 这份 JSON 的来源：PDF 旁边带出来的 sidecar，还是「打开 JSON…」手选的。 */
export function getJsonOrigin(): 'sidecar' | 'dialog' | null {
  return sourceOrigin
}

/** 注册「一份新 JSON 到位」的回调（sidecar 自动带出或手动打开都算）。 */
export function onJsonLoaded(handler: () => void): void {
  jsonLoadedHandler = handler
}

/** 读一份 JSON 文件（在线解析解压目录里的 layout.json）：读不到返回 false，视图保持空态。 */
export async function loadJsonFromPath(jsonPath: string): Promise<boolean> {
  const result = await window.electronAPI.readTextFile(jsonPath)
  if (!result) return false
  setSource(result.content, result.path, 'sidecar')
  return true
}

/**
 * PDF 旁边的同名 .json（本地 MinerU 留下的 sidecar）：读不到返回 false。
 * 在线解析的结果不再写这里了 —— 它在 PDF 旁边的 <pdf 名>.mineru/ 目录里。
 */
export async function loadJsonSidecar(pdfPath: string): Promise<boolean> {
  return loadJsonFromPath(pdfPath.replace(/\.pdf$/i, '.json'))
}

/** 空态里的「打开 JSON…」。 */
export async function loadJsonViaDialog(): Promise<void> {
  const result = await window.electronAPI.pickJsonFile()
  if (!result) return
  setSource(result.content, result.path, 'dialog')
}
