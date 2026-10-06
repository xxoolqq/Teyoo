// PDF 对照视图：左侧 PDF 源文件，右侧本项目的 WYSIWYG 编辑器（MinerU 式）。
//
// 它是窗口里的**一个标签页**（「文件 → PDF转md」开的），不再是一个独立窗口：
// 切进来由 main.ts 调 enterPdfTabChrome + loadPdfTab 把外壳换成左右分栏并渲染，
// 切走调 leavePdfTab 收起面板、放掉文档与 worker —— 所以本模块那份状态虽然还是
// 模块级的，但只在 PDF 标签页活动期间有内容。
//
// PDF 怎么来的：主进程读盘后把整份字节经 IPC 送过来。渲染端自己取不到 ——
// 生产环境是 file:// 页面且开着 webSecurity，fetch('file://…') 会被拦，
// 所以 pdf.js 只能喂字节（data）而不是 URL。
//
// 只做「看源文件」这一件事：不抽文本、不解析（解析要调服务端，按钮也还没
// 接），右侧编辑器拿到的就是空白或已经解析好的 Markdown。
//
// worker：用 Vite 的 ?url 资产形式引入，随构建产物一起落到 dist/renderer。
// 实测 Electron 44 在 file:// 页面 + webSecurity: true 下，file:// 的
// module worker 能正常创建，所以不需要 blob worker 或额外开关。

import type { PDFDocumentLoadingTask, PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist'
import type { MineruProgressPayload } from '../preload/index'
import { isChinese } from './ui-language'
import { getJsonData, loadJsonFromPath, loadJsonSidecar } from './json-view'
import { layoutBlockAnchors } from './layout2md'
import {
  clearPdfBlockAnchors,
  getPageBlockRects,
  notePdfClick,
  notePdfHover,
  onBlockAnchorsChanged,
  registerPdfLinkApi,
  setPdfBlockAnchors
} from './block-link'

const PDF_PANEL_MIN_WIDTH = 260
// 拖拽时给右边编辑器留的下限：再窄对照就没意义了。
const PDF_PANEL_MIN_EDITOR_WIDTH = 360
const PDF_PANEL_WIDTH_KEY = 'pdf-panel-width'

// 缩放：1 = 适应栏宽（默认），每档 1.25 倍。不写进 localStorage —— 每次导入都是
// 新窗口，把上一次的 400% 留给下一份 PDF 只会让人困惑。
const PDF_ZOOM_MIN = 0.25
const PDF_ZOOM_MAX = 4
const PDF_ZOOM_STEP = 1.25
let zoom = 1

function maxPdfPanelWidth(): number {
  return Math.max(PDF_PANEL_MIN_WIDTH, window.innerWidth - PDF_PANEL_MIN_EDITOR_WIDTH)
}

function clampPdfPanelWidth(width: number): number {
  return Math.min(maxPdfPanelWidth(), Math.max(PDF_PANEL_MIN_WIDTH, Math.round(width)))
}

// 传 null = 回到默认（左右各一半）：此时不写死像素值，交给 CSS 的 50% 兜底，
// 窗口缩放时两栏会一直保持这个比例。
function applyPdfPanelWidth(width: number | null): void {
  pinnedWidth = width
  if (width === null) {
    document.documentElement.style.removeProperty('--pdf-panel-width')
    return
  }
  document.documentElement.style.setProperty('--pdf-panel-width', `${width}px`)
}

// null = 用户还没拖过分隔条，宽度由 CSS 的 50% 决定。
let pinnedWidth: number | null = null
let pdfDoc: PDFDocumentProxy | null = null
// 上一次 getDocument 的任务：它是销毁 worker 的唯一把手（PDFDocumentProxy 上
// 没有 destroy）。
let pdfTask: PDFDocumentLoadingTask | null = null
let observer: IntersectionObserver | null = null
const pendingRenders = new Map<Element, () => Promise<void>>()
let renderTasks: RenderTask[] = []
let resizeTimer: ReturnType<typeof setTimeout> | null = null

function pdfEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface PdfViewHooks {
  /**
   * 解析结果里的 full.md 到位：交给编辑器填充。
   * 由 main.ts 注册 —— 编辑器那份 API 在 main.ts 里，本模块不能反向 import（会成环）。
   * onlyWhenEmpty：编辑器里已经有内容就别覆盖（打开 PDF 时带出来的那一次用）。
   * 返回 Promise：调用方要等这一份填完，再装联动锚点（顺序见 loadBlockAnchors）。
   */
  onMarkdownFile?: (path: string, options?: { onlyWhenEmpty?: boolean }) => void | Promise<void>
  /**
   * 用户在对照面板里选了源文件：路径要记回标签页（切走再切回来按它重新读盘）。
   * 由 main.ts 注册 —— 标签页那套状态在 main.ts 里，本模块不能反向 import（会成环）。
   */
  onPdfSourceChange?: (path: string) => void
}

let hooks: PdfViewHooks = {}

/**
 * 绑定面板上的控件与 IPC。与「当前是不是 PDF 标签页」无关 —— 面板 DOM 一直都在
 * （默认隐藏），显隐由 enterPdfTabChrome / leavePdfTab 管，所以绑定一次就够。
 */
export function initPdfView(api: import('../preload/index').ElectronAPI, viewHooks: PdfViewHooks = {}): void {
  hooks = viewHooks
  apiRef = api
  bindPdfResizer(pdfEl('pdf-resizer'))
  bindPdfZoom()
  bindPdfEmpty()
  bindPdfParse()
  api.onMineruProgress((payload) => showParseProgress(payload))
  window.addEventListener('resize', () => {
    // 拖过之后宽度是写死的像素，窗口变小可能把编辑器挤没了：重新夹一次。
    if (pinnedWidth !== null) applyPdfPanelWidth(clampPdfPanelWidth(pinnedWidth))
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = null
      // 不在 PDF 标签页时容器是空的，layoutPages 自己会返回，不必额外判断。
      void layoutPages()
    }, 200)
  })
  const pages = pdfEl('pdf-pages')
  if (pages) bindBlockLink(pages)
}

// ── 标签页的进出 ────────────────────────────────────────────────────────
// 面板显隐与左右分栏全靠 body.pdf-view 那组 CSS（编辑器让出左半边、doc-bar 露出
// 来、文件面板收起）。所以进出的第一件事就是开关这个 class —— 同步执行，切换
// 标签页的第一帧就得对，不能等 PDF 字节读到才变。

/** 进入 PDF 标签页：换上对照布局的外壳（面板/分隔条露出来 + 恢复拖过的栏宽）。 */
export function enterPdfTabChrome(): void {
  document.body.classList.add('pdf-view')
  const panel = pdfEl('pdf-panel')
  if (panel) panel.hidden = false
  const resizer = pdfEl('pdf-resizer')
  if (resizer) resizer.hidden = false
  const saved = Number.parseInt(localStorage.getItem(PDF_PANEL_WIDTH_KEY) ?? '', 10)
  applyPdfPanelWidth(saved ? clampPdfPanelWidth(saved) : null)
}

/** 离开 PDF 标签页：收起外壳，并把这一份 PDF 彻底放下（见 releasePdf）。 */
export function leavePdfTab(): void {
  document.body.classList.remove('pdf-view')
  const panel = pdfEl('pdf-panel')
  if (panel) panel.hidden = true
  const resizer = pdfEl('pdf-resizer')
  if (resizer) resizer.hidden = true
  openedPdfPath = null
  // 缩放不跨标签页保留：下一次对照是另一份文档，沿用上次的倍率只会让人困惑。
  zoom = 1
  updateZoomUi()
  showParseButton(false)
  releasePdf()
  // 锚点是全局的：不清掉的话，正文里的高亮与点击还会指向已经不存在的页。
  clearPdfBlockAnchors()
  setPdfSource(null)
  setPdfMeta('')
}

/**
 * 渲染标签页里那份 PDF。null = 还没选源文件，把空态摆出来。
 * 必须排在标签页内容恢复之后（调用于 activateTab 末尾）：填内容会清掉锚点。
 */
export async function loadPdfTab(pdfPath: string | null): Promise<void> {
  if (!pdfPath) {
    showPdfEmpty(emptyMessage())
    showParseButton(false)
    return
  }
  // 同一份还在手上（切走又立刻切回）：直接重排，不必再读一次盘。
  if (openedPdfPath === pdfPath && pdfDoc) {
    await layoutPages()
    await loadBlockAnchors()
    return
  }
  openedPdfPath = pdfPath
  clearPdfBlockAnchors()
  showPdfPane()
  const picked = apiRef ? await apiRef.readPdfFile(pdfPath) : null
  if (!picked) {
    showPdfReadError(pdfPath)
    return
  }
  await loadPdf(picked.path, picked.data)
  await loadBlockAnchors()
  // 有源文件才谈得上在线解析（不管旁边有没有结果：重新解析也是合理的）。
  showParseButton(true)
}

/** 放掉这一份 PDF：取消在画的页、断掉观察、清空容器、收掉 worker。 */
function releasePdf(): void {
  cancelRenders()
  observer?.disconnect()
  observer = null
  const container = pdfEl('pdf-pages')
  if (container) container.innerHTML = ''
  // 与换文件时同一套：cleanup 放文档自己占的资源，destroy 才连 worker 一起收。
  if (pdfDoc) {
    const previous = pdfDoc
    pdfDoc = null
    void previous.cleanup().catch(() => { /* 离开标签页，旧文档丢了也无所谓 */ })
  }
  if (pdfTask) {
    const previous = pdfTask
    pdfTask = null
    void previous.destroy().catch(() => { /* worker 已经没了就算了 */ })
  }
}

function setPdfSource(path: string | null): void {
  const name = pdfEl('pdf-source-name')
  if (!name) return
  name.textContent = path ? fileNameOf(path) : ''
  if (path) name.title = path
  else name.removeAttribute('title')
}

function setPdfMeta(text: string): void {
  const meta = pdfEl('pdf-meta')
  if (meta) meta.textContent = text
}

function showPdfReadError(path: string): void {
  showPdfPane()
  const container = pdfEl('pdf-pages')
  if (!container) return
  container.innerHTML = ''
  const message = document.createElement('div')
  message.className = 'pdf-error'
  message.textContent = isChinese() ? `读不到这份 PDF：${path}` : `Could not read this PDF: ${path}`
  container.append(message)
  showParseButton(false)
}

let openedPdfPath: string | null = null
// 空态里的「打开 PDF…」要用它：窗口是从菜单直接进来的，那时还没有任何源文件。
let apiRef: import('../preload/index').ElectronAPI | null = null

/** PDF 旁边（或它所在的结果包里）已经解析留下的两份文件。 */
interface SidecarFiles {
  /** 结果里的 full.md —— 右侧 Markdown 面板读它 */
  markdownPath?: string
  /** 结果里的 layout.json —— 右侧 JSON 面板读它 */
  jsonPath?: string
}

/** 一份 PDF 到位（窗口建立时带进来的，或用户点「打开 PDF…」选的）。 */
function applyPdf(path: string, data: Uint8Array, parsed?: SidecarFiles): void {
  // 换了一份源文件：旧文档那套块锚点作废。
  if (openedPdfPath !== path) clearPdfBlockAnchors()
  openedPdfPath = path
  // 必须先露出版面再 loadPdf：容器隐藏时量到的可用宽度是 0，layoutPages 会直接返回。
  showPdfPane()
  void loadPdf(path, data)
  // 解析结果带出来：Markdown 读 full.md、JSON 读 layout.json；都没有就保持空态，
  // 用户可以在 JSON 模式里手动选一个。
  void applyResultAfterOpen(path, parsed)
  // 有源文件才谈得上在线解析（不管旁边有没有结果：重新解析也是合理的）。
  showParseButton(true)
  // 让标签页记住这份源文件：切走再切回来按它重新读盘渲染。
  hooks.onPdfSourceChange?.(path)
}

/**
 * 结果可能由主进程随 PDF 一起给过来（窗口带 PDF 打开 / 「打开 PDF…」选完都算）。
 * 没给就按包的形状自己在这两处各试一次 —— PDF 旁的 <pdf 名>.mineru/，以及 PDF
 * 自己所在的目录（MinerU 会把原件改名塞回包里，那时两份文件就在它旁边）。
 */
async function applyResultAfterOpen(path: string, parsed?: SidecarFiles): Promise<void> {
  const found = parsed?.markdownPath || parsed?.jsonPath ? parsed : await probeExtractedFiles(path)
  await applyParsedResult(path, found?.markdownPath, found?.jsonPath, true)
}

/** 逐个试读：读得到才算有（readTextFile 读不到返回 null，不抛）。 */
async function probeExtractedFiles(pdfPath: string): Promise<SidecarFiles> {
  const api = apiRef
  if (!api) return {}
  const read = async (filePath: string): Promise<string | undefined> =>
    (await api.readTextFile(filePath))?.path || undefined
  const siblingDir = pdfPath.replace(/\.pdf$/i, '.mineru')
  const ownDir = pdfPath.replace(/[\\/][^\\/]*$/, '')
  for (const dir of [...new Set([siblingDir, ownDir])]) {
    // 先探 full.md：它在绝大多数情况下都有一份，读不到就别再去读那几百 KB 的 json。
    const markdownPath = await read(`${dir}/full.md`)
    if (!markdownPath) continue
    return { markdownPath, jsonPath: await read(`${dir}/layout.json`) }
  }
  // 只有 full.md 才算数：父目录里散落着一个无关 layout.json 是常有的事，
  // 单凭它认亲会把别人家的中间结果端到界面上。
  return {}
}

/**
 * 把解析结果接到右侧两块面板上：
 *   JSON ← 解压目录里的 layout.json（没有就退回 PDF 旁边的同名 .json）
 *   Markdown ← 解压目录里的 full.md（交给 main.ts 填进编辑器）
 */
async function applyParsedResult(
  pdfPath: string,
  markdownPath?: string,
  jsonPath?: string,
  onlyWhenEmpty = false,
): Promise<void> {
  const loaded = jsonPath ? await loadJsonFromPath(jsonPath) : false
  if (!loaded) await loadJsonSidecar(pdfPath)
  // JSON 先到位：full.md 里的图片路径按它的目录解析（见 main.ts 的 resolveLayoutImage）。
  if (markdownPath) await hooks.onMarkdownFile?.(markdownPath, { onlyWhenEmpty })
  await loadBlockAnchors()
}

/**
 * 位置只在中间结果里（bbox + page_size），正文里的字一个坐标都不带，所以两边
 * 只能靠这份 JSON 牵线。
 *
 * 必须排在 Markdown 填进编辑器之后：填内容是「换文档」，那一换会把刚排好的
 * 锚点清掉（见 main.ts 的 setContent → clearPdfBlockAnchors）。
 */
async function loadBlockAnchors(): Promise<void> {
  // 用已解析好的那份（JSON 面板读进来时就 parse 过了），不必再解一遍文本；
  // 解析失败的文档这里拿到 null，联动自然跳过。
  const data = getJsonData()
  if (!data) return
  const { blocks, pageSizes } = await layoutBlockAnchors(data)
  if (!blocks.length) return
  setPdfBlockAnchors(blocks, pageSizes)
}

// ── 在线解析（MinerU 精准解析 API）─────────────────────────────────────
// 请求在主进程发起（渲染端的 CSP 是 default-src 'self'，外部域名根本发不出去），
// 这里只做两件事：发一次 invoke，把主进程推回来的进度写到头部。
// 解析完成后主进程把结果包原样解压到 PDF 旁的 <pdf 名>.mineru/ 目录，收尾就是
// 把那两份文件读进右侧面板：Markdown ← full.md，JSON ← layout.json。
let parsing = false

function parseButtonText(busy: boolean): string {
  const zh = isChinese()
  if (busy) return zh ? '解析中' : 'Parsing'
  return zh ? '在线解析' : 'Parse online'
}

function bindPdfParse(): void {
  const btn = pdfEl<HTMLButtonElement>('pdf-parse-btn')
  if (!btn) return
  const zh = isChinese()
  btn.textContent = parseButtonText(false)
  btn.title = zh
    ? '上传到 MinerU 解析，结果解压到 PDF 旁边的「<pdf 名>.mineru」目录'
    : 'Upload to MinerU; the result is extracted into the "<pdf name>.mineru" folder next to the PDF'
  btn.addEventListener('click', () => {
    void parseOnline()
  })
}

function showParseButton(show: boolean): void {
  const btn = pdfEl<HTMLButtonElement>('pdf-parse-btn')
  if (!btn) return
  btn.hidden = !show
  if (!show) btn.disabled = false
}

function setParseBusy(busy: boolean): void {
  parsing = busy
  const btn = pdfEl<HTMLButtonElement>('pdf-parse-btn')
  if (!btn) return
  btn.disabled = busy
  btn.textContent = parseButtonText(busy)
}

function progressText(payload: MineruProgressPayload): string {
  const zh = isChinese()
  const hasPages = payload.extracted !== undefined && payload.total !== undefined && payload.total > 0
  const pages = hasPages
    ? zh
      ? ` ${payload.extracted}/${payload.total} 页`
      : ` ${payload.extracted}/${payload.total} pages`
    : ''
  switch (payload.stage) {
    case 'applying':
      return zh ? '准备上传' : 'Preparing upload'
    case 'uploading':
      return zh ? '上传中' : 'Uploading'
    case 'waiting':
      return zh ? '排队中' : 'Queued'
    case 'running':
      return zh ? `解析中${pages}` : `Parsing${pages}`
    case 'converting':
      return zh ? '转换格式' : 'Converting'
    case 'downloading':
      return zh ? '下载结果' : 'Downloading'
    default:
      return ''
  }
}

function showParseProgress(payload: MineruProgressPayload): void {
  if (!parsing) return
  const meta = pdfEl('pdf-meta')
  if (meta) meta.textContent = progressText(payload)
}

function showParseError(error?: string): void {
  const zh = isChinese()
  const meta = pdfEl('pdf-meta')
  let text: string
  if (error === 'NO_TOKEN') {
    text = zh ? '还没填 MinerU Token（偏好设置 → 通用）' : 'Set the MinerU Token in Preferences'
  } else if (error === 'CANCELED') {
    text = zh ? '已取消' : 'Canceled'
  } else if (error === 'TIMEOUT') {
    // 本地等超时 ≠ 服务端失败：任务还在跑，只是这一轮没等到。
    text = zh ? '等待超时，服务端可能仍在解析，稍后重试' : 'Timed out; the server may still be parsing'
  } else {
    text = error || (zh ? '解析失败' : 'Parsing failed')
  }
  if (meta) meta.textContent = text
}

async function parseOnline(): Promise<void> {
  const api = apiRef
  const path = openedPdfPath
  if (!api || !path || parsing) return
  setParseBusy(true)
  try {
    const result = await api.parsePdfOnline(path)
    if (!result.ok) {
      showParseError(result.error)
      return
    }
    const zh = isChinese()
    const meta = pdfEl('pdf-meta')
    const suffix = result.imageCount ? `${result.imageCount} 张图` : ''
    if (meta) meta.textContent = zh ? `解析完成 ${suffix}`.trim() : `Done ${suffix}`.trim()
    // 主进程已经把结果包解压到 PDF 旁的目录里，Markdown / JSON 各读各的文件。
    await applyParsedResult(path, result.markdownPath, result.jsonPath)
  } catch (error) {
    showParseError(errorText(error))
  } finally {
    setParseBusy(false)
  }
}

// ── 空态：还没有源文件 ──────────────────────────────────────────────────
// 菜单「PDF转md」直接开界面（不再先弹文件对话框），所以窗口一进来就是空的，
// 由这里的按钮把人送去选文件（与 JSON 视图的空态同一套路）。
/** 空态那句话：还没选源文件。选中后 pdf-view 把它换成页面栏。 */
function emptyMessage(): string {
  return isChinese()
    ? '还没有 PDF：选一份源文件，旁边的解析结果（同名 .json）会自动带出来。'
    : 'No PDF yet: pick a source file; the parse result beside it (same name, .json) comes along automatically.'
}

function bindPdfEmpty(): void {
  const zh = isChinese()
  const openBtn = pdfEl<HTMLButtonElement>('pdf-open-btn')
  if (openBtn) {
    openBtn.textContent = zh ? '打开 PDF…' : 'Open PDF…'
    openBtn.addEventListener('click', () => { void openPdfViaDialog() })
  }
  showPdfEmpty(emptyMessage())
}

function showPdfEmpty(message: string): void {
  const text = pdfEl('pdf-empty-text')
  if (text) text.textContent = message
  const empty = pdfEl('pdf-empty')
  if (empty) empty.hidden = false
  const pages = pdfEl('pdf-pages')
  if (pages) pages.hidden = true
}

function showPdfPane(): void {
  const empty = pdfEl('pdf-empty')
  if (empty) empty.hidden = true
  const pages = pdfEl('pdf-pages')
  if (pages) pages.hidden = false
}

async function openPdfViaDialog(): Promise<void> {
  const api = apiRef
  if (!api) return
  const picked = await api.pickPdfFile()
  if (!picked) return
  // 带上旁边已经解析留下的 full.md / layout.json（没有就是 undefined，界面维持空态）。
  applyPdf(picked.path, picked.data, { markdownPath: picked.markdownPath, jsonPath: picked.jsonPath })
}

/**
 * 当前对照窗口里那份 PDF 的路径；不在 PDF 视图里就是 null。
 * Markdown 还原要用它定位图片目录（JSON 路径拿不到时的后备）。
 */
export function getOpenedPdfPath(): string | null {
  return openedPdfPath
}

// 拖动分隔条改 PDF 栏宽度。与右侧文件面板方向相反：这一栏贴着窗口左边缘，
// 所以指针到左边缘的距离就是宽度。
function bindPdfResizer(resizer: HTMLElement | null): void {
  if (!resizer) return
  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    // 拿不到指针捕获也要能拖：move/up 挂在 window 上，捕获成功时事件会被重定向
    // 到分隔条再冒泡到 window，没捕获时指针划过其它元素同样冒泡到 window。
    try {
      resizer.setPointerCapture(event.pointerId)
    } catch {
      /* 合成事件/个别环境拿不到捕获，上面的 window 监听兜住 */
    }
    resizer.classList.add('dragging')
    document.body.classList.add('pdf-resizing')
    // 从当前实际宽度开始拖（没拖过时是 CSS 那一半），而不是某个写死的默认值，
    // 否则一按下分隔条就会跳位。
    const panel = pdfEl('pdf-panel')
    let width = panel ? Math.round(panel.getBoundingClientRect().width) : Math.round(window.innerWidth / 2)
    const move = (moveEvent: PointerEvent) => {
      width = clampPdfPanelWidth(moveEvent.clientX)
      applyPdfPanelWidth(width)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      resizer.classList.remove('dragging')
      document.body.classList.remove('pdf-resizing')
      localStorage.setItem(PDF_PANEL_WIDTH_KEY, String(width))
      void layoutPages()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  })
}

// 缩放按钮（面板头部、页码左侧的 ⊖ ⊕）。改的是渲染比例，所以要重排重画，
// 不能像图片那样直接改 CSS 尺寸 —— 那样只会把位图拉糊。
function bindPdfZoom(): void {
  const zh = isChinese()
  const out = pdfEl<HTMLButtonElement>('pdf-zoom-out')
  const zoomIn = pdfEl<HTMLButtonElement>('pdf-zoom-in')
  if (out) {
    out.title = zh ? '缩小' : 'Zoom out'
    out.setAttribute('aria-label', out.title)
    out.addEventListener('click', () => { void setZoom(zoom / PDF_ZOOM_STEP) })
  }
  if (zoomIn) {
    zoomIn.title = zh ? '放大' : 'Zoom in'
    zoomIn.setAttribute('aria-label', zoomIn.title)
    zoomIn.addEventListener('click', () => { void setZoom(zoom * PDF_ZOOM_STEP) })
  }
  updateZoomUi()
}

function updateZoomUi(): void {
  const label = pdfEl('pdf-zoom-level')
  if (label) label.textContent = `${Math.round(zoom * 100)}%`
  const out = pdfEl<HTMLButtonElement>('pdf-zoom-out')
  const zoomIn = pdfEl<HTMLButtonElement>('pdf-zoom-in')
  if (out) out.disabled = zoom <= PDF_ZOOM_MIN + 1e-3
  if (zoomIn) zoomIn.disabled = zoom >= PDF_ZOOM_MAX - 1e-3
}

async function setZoom(next: number): Promise<void> {
  const clamped = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, next))
  if (Math.abs(clamped - zoom) < 1e-3) return
  // 记住当前页和它在视口里的位置，重排后还原 —— 否则一放大就跳回顶部。
  const anchor = scrollAnchor()
  zoom = clamped
  updateZoomUi()
  await layoutPages()
  restoreScrollAnchor(anchor)
}

// 视口顶部那一页 + 页内偏移：缩放前后按页高比例换算，视觉上原地放大。
function scrollAnchor(): { index: number; offset: number; height: number } | null {
  const container = pdfEl('pdf-pages')
  if (!container) return null
  const holders = Array.from(container.querySelectorAll<HTMLElement>('.pdf-page'))
  const index = holders.findIndex((holder) => holder.offsetTop + holder.offsetHeight > container.scrollTop + 1)
  if (index < 0) return null
  return { index, offset: container.scrollTop - holders[index].offsetTop, height: holders[index].offsetHeight }
}

function restoreScrollAnchor(anchor: { index: number; offset: number; height: number } | null): void {
  const container = pdfEl('pdf-pages')
  if (!container || !anchor) return
  const holder = container.querySelectorAll<HTMLElement>('.pdf-page')[anchor.index]
  if (!holder) return
  const factor = anchor.height > 0 ? holder.offsetHeight / anchor.height : 1
  container.scrollTop = holder.offsetTop + anchor.offset * factor
}

async function loadPdf(path: string, bytes: Uint8Array): Promise<void> {
  const container = pdfEl('pdf-pages')
  if (!container) return
  setPdfSource(path)
  // 换文件时把上一份彻底放下：cleanup 释放 PDFDocument 自己占的资源（页面、字体、
  // 位图），任务层 destroy 才连 worker 一起收掉 —— 只做前者，worker 会一直活着。
  // 注意 PDFDocumentProxy 没有 destroy()（有 destroy 的是 loading task）：
  // pdfjs-dist 6 的 PDFDocumentProxy 只有 cleanup()，写 destroy 是调用不存在的方法。
  if (pdfDoc) {
    const previous = pdfDoc
    pdfDoc = null
    void previous.cleanup().catch(() => { /* 换文件时旧文档丢了也无所谓 */ })
  }
  if (pdfTask) {
    const previous = pdfTask
    pdfTask = null
    void previous.destroy().catch(() => { /* worker 已经没了就算了 */ })
  }
  try {
    const pdfjs = await import('pdfjs-dist')
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    // pdf.js 会接管并 detach 传进去的缓冲区，给它一份自己的副本。
    const task = pdfjs.getDocument({ data: bytes.slice() })
    pdfTask = task
    pdfDoc = await task.promise
  } catch (error) {
    container.innerHTML = ''
    const message = document.createElement('div')
    message.className = 'pdf-error'
    message.textContent = errorText(error)
    container.append(message)
    return
  }
  const meta = pdfEl('pdf-meta')
  if (meta) meta.textContent = `${pdfDoc.numPages} 页`
  await layoutPages()
}

// ── 与正文块的双向定位 ──────────────────────────────────────────────────
// 矩形层是 SVG：<g class="pdf-bbox" data-block-id="…"><rect/></g>，一个块一个 g。
// 平时透明、只有矩形本体收事件（不挡 canvas 上的滚动与拖拽）。
const SVG_NS = 'http://www.w3.org/2000/svg'
let hoveredBlockId: string | null = null

function pageRotation(page: { rotate?: number }): number {
  return ((page.rotate ?? 0) % 360 + 360) % 360
}

function buildBlockOverlay(pageIdx: number, cssWidth: number, cssHeight: number): SVGSVGElement | null {
  const rects = getPageBlockRects(pageIdx, cssWidth)
  if (!rects.length) return null
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'pdf-overlay')
  svg.setAttribute('viewBox', `0 0 ${cssWidth} ${cssHeight}`)
  for (const item of rects) {
    const group = document.createElementNS(SVG_NS, 'g')
    group.setAttribute('class', 'pdf-bbox')
    group.dataset.blockId = item.id
    const box = document.createElementNS(SVG_NS, 'rect')
    box.setAttribute('x', String(item.x))
    box.setAttribute('y', String(item.y))
    box.setAttribute('width', String(item.width))
    box.setAttribute('height', String(item.height))
    group.append(box)
    svg.append(group)
  }
  return svg
}

/**
 * 锚点变了就重画一遍矩形层：只换掉每页那张 SVG，不动 canvas。页面位图还在，
 * 整栏重排（layoutPages）既没必要也会把滚动位置和缩放状态一起掀掉。
 */
function refreshBlockOverlays(): void {
  const container = pdfEl('pdf-pages')
  if (!container) return
  container.querySelectorAll<HTMLElement>('.pdf-page').forEach((holder, index) => {
    holder.querySelector('.pdf-overlay')?.remove()
    const canvas = holder.querySelector('canvas')
    if (!canvas) return
    const cssWidth = Number.parseFloat(holder.style.width)
    if (!Number.isFinite(cssWidth) || cssWidth <= 0) return
    // 画布宽高已含 dpr，比例与页面一致 —— 用它反算显示高度最稳。
    const cssHeight = canvas.width > 0 ? (cssWidth * canvas.height) / canvas.width : holder.clientHeight
    const overlay = buildBlockOverlay(index, cssWidth, cssHeight)
    if (overlay) holder.append(overlay)
  })
  // 矩形节点整体换过了：旧的高亮状态已经不指向任何东西。
  hoveredBlockId = null
}

function bindBlockLink(container: HTMLElement): void {
  const boxesOf = (id: string): Element[] =>
    Array.from(container.querySelectorAll(`.pdf-bbox[data-block-id="${CSS.escape(id)}"]`))
  const setHover = (id: string | null): void => {
    if (id === hoveredBlockId) return
    hoveredBlockId = id
    container.querySelectorAll('.pdf-bbox.is-hover').forEach((el) => el.classList.remove('is-hover'))
    if (id) boxesOf(id).forEach((el) => el.classList.add('is-hover'))
  }
  registerPdfLinkApi({
    highlight: setHover,
    reveal: (id) => {
      boxesOf(id)[0]?.scrollIntoView({ block: 'center' })
    }
  })
  // 解析结果（锚点）比页面渲染晚到是常态，到位后补画矩形。
  onBlockAnchorsChanged(() => refreshBlockOverlays())
  const idAt = (event: Event): string | null => {
    const target = event.target instanceof Element ? event.target.closest('.pdf-bbox') : null
    return target instanceof SVGElement ? target.dataset.blockId ?? null : null
  }
  container.addEventListener('mouseover', (event) => {
    const id = idAt(event)
    setHover(id)
    notePdfHover(id)
  })
  container.addEventListener('mouseleave', () => {
    setHover(null)
    notePdfHover(null)
  })
  // 悬停只高亮；点一下才把正文滚到眼前。
  container.addEventListener('click', (event) => {
    const id = idAt(event)
    if (id) notePdfClick(id)
  })
}

function cancelRenders(): void {
  for (const task of renderTasks) task.cancel()
  renderTasks = []
  pendingRenders.clear()
}

// 每页先按宽度占好高度，滚到附近才真的画：一篇几十上百页的论文一次性全渲染
// 会把整个窗口卡住，而对照阅读时屏幕上通常只有一两页。
async function layoutPages(): Promise<void> {
  const container = pdfEl('pdf-pages')
  if (!container || !pdfDoc) return
  // 整栏重排：上一批矩形节点没了，高亮状态跟着清。
  hoveredBlockId = null
  cancelRenders()
  observer?.disconnect()
  container.innerHTML = ''
  const style = getComputedStyle(container)
  const width = container.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
  if (width <= 0) return
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  // 一页的显示宽度：1 倍时正好铺满可用宽度，放大后由容器横向滚动。
  // 向下取整：向上取整会多出不到 1px，正好撑出一条没用的横向滚动条。
  const cssWidth = Math.max(1, Math.floor(width * zoom))
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const render = pendingRenders.get(entry.target)
      if (!render) continue
      pendingRenders.delete(entry.target)
      void render()
    }
  }, { root: container, rootMargin: '600px 0px' })
  for (let index = 1; index <= pdfDoc.numPages; index++) {
    const page = await pdfDoc.getPage(index)
    const base = page.getViewport({ scale: 1 })
    // 位图尺寸 = 显示尺寸 × dpr。pdf.js 只按 viewport 给的像素数画（它不会自己
    // 乘 dpr，也不会改画布尺寸），画布再由 CSS 压回 cssWidth —— 少了这个 dpr，
    // 内容只占画布的 1/dpr，看着就是整页缩在左上角、字特别小。
    const viewport: PageViewport = page.getViewport({ scale: (cssWidth * ratio) / base.width })
    const holder = document.createElement('div')
    holder.className = 'pdf-page'
    holder.style.width = `${cssWidth}px`
    // 占位用 aspect-ratio 而不是写死高度：拖分隔条时页面跟着栏宽实时缩放
    // （位图先糊一下），松手后 layoutPages 再按新宽度重画成清晰的。
    holder.style.aspectRatio = `${base.width} / ${base.height}`
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    holder.append(canvas)
    // 定位用的矩形层：一个块一个框，跟着 layout.json 的 bbox 走。旋转页的坐标
    // 换算不是等比缩放那套，整页不画，免得框飞到别处去。
    if (pageRotation(page) === 0) {
      const overlay = buildBlockOverlay(index - 1, cssWidth, (cssWidth * base.height) / base.width)
      if (overlay) holder.append(overlay)
    }
    container.append(holder)
    pendingRenders.set(holder, async () => {
      const task = page.render({ canvas, viewport })
      renderTasks.push(task)
      try {
        await task.promise
      } catch {
        // 取消（重排/关窗）或单页渲染失败：占位留着，不该因此炸掉整栏
      }
    })
    observer.observe(holder)
  }
}
