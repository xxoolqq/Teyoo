// docx转md 视图：左侧是 Word 文档的版式预览，右侧是编辑器放转换出来的 Markdown。
//
// 与 image-view.ts 同一骨架：它是窗口里的**一个标签页**（「文件 → docx转md」开的），
// 切进来由 main.ts 调 enterDocxTabChrome + loadDocxTab 把外壳换成左右分栏，切走
// 调 leaveDocxTab 收起面板 —— 所以这里那份状态虽然还是模块级的，但只在 docx
// 标签页活动期间有内容。
//
// 预览怎么来的：浏览器里没有 docx 渲染器，所以借本机 Word —— 主进程调
// resources/bin/doc2pdf.exe（COM 晚绑定）另存成 PDF，这里再用 pdf.js 画成
// canvas（见 pdf-canvas.ts）。PDF 与 Markdown 是两条独立的链路：
//   · 转 PDF 失败（没装 Word / 文件被占用）→ 左栏留在文件信息卡 + 报错
//   · 转 Markdown 失败 → 右栏不动，状态行报错
// 所以一次转换里两边不会互相连坐。
//
// 触发时机：**选中文档就开跑**（选择 / 拖入都算），左 PDF、右 Markdown 一起出，
// 不用再点第二次按钮。顶部的按钮留着，作用变成「重新转换」（改过 Word 原稿、
// 或者上一次预览失败后想重试）。
//
// 为什么是「先开标签页再选文件」：以前菜单直接弹系统对话框、转完才建标签页，
// 用户在对话框里取消就什么也看不到，也没有地方重新选 / 重新转。

import type { ElectronAPI } from '../preload/index'
import { isChinese } from './ui-language'
import { clearPdfView, renderPdfInto } from './pdf-canvas'

export interface DocxViewHooks {
  /** 转换出来的 Markdown：交给编辑器落地（由 main.ts 注册）。 */
  onMarkdownText?: (markdown: string) => void | Promise<void>
  /** 用户在面板里选了文档：路径要记回标签页（切走再切回来按它重新显示）。 */
  onDocxSourceChange?: (path: string) => void
}

let hooks: DocxViewHooks = {}
let apiRef: ElectronAPI | null = null
/** 当前标签页挂着的 Word 文档；不在 docx 标签页就是 null。 */
let openedDocxPath: string | null = null
/** 当前预览着的 PDF（主进程生成的临时文件）；Markdown 侧不依赖它。 */
let previewPdfPath: string | null = null
let converting = false
/** 「导出 PDF」正在写盘：防连点，同时避免状态行被并发的两次结果互相覆盖 */
let exporting = false

/**
 * 两条链路的进度。PDF 预览与 Markdown 解析**并行**跑，各自收尾；状态行与加载
 * 动画都由这两个状态合成（syncStatus），谁先完成都不影响另一条。
 */
type StepState = 'idle' | 'running' | 'ok' | 'failed'
let previewStep: StepState = 'idle'
let markdownStep: StepState = 'idle'
/** 各自的失败原因，合成状态行时用 */
let previewErrorText = ''
let markdownErrorText = ''
/** Markdown 链路上的警告条数（mammoth 的提示，只在汇总里提一句） */
let markdownWarnings = 0

// 左栏宽度：与 PDF 对照同一套做法 —— 拖分隔条改 --docx-panel-width，记住上次的值；
// 没拖过就不写像素，交给 CSS 的 fallback（50%），窗口缩放时两栏保持同比例。
const DOCX_PANEL_MIN_WIDTH = 280
// 拖宽时给右边编辑器留的下限。比 PDF 对照那条（360）宽一些：那边右栏是逐行
// 对照用的，这边右栏是正文编辑器，再窄一行放不下十几个字，公式也读不出来。
const DOCX_PANEL_MIN_EDITOR_WIDTH = 480
const DOCX_PANEL_WIDTH_KEY = 'docx-panel-width'
/** 拖过之后的宽度（像素）；null = 没拖过 */
let pinnedWidth: number | null = null

function docxEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** doc2pdf 的退出原因翻成人话（前端只拿到字符串，分类在这一处收口） */
function convertErrorText(error?: string): string {
  const zh = isChinese()
  if (!error) return zh ? '预览生成失败' : 'Preview failed'
  if (error === 'CONVERTER_MISSING') {
    return zh
      ? '转换器缺失：resources/bin/doc2pdf.exe 没随应用打包'
      : 'Converter missing: resources/bin/doc2pdf.exe is not packaged'
  }
  if (error === 'TIMEOUT') return zh ? 'Word 转换超时（可能有弹窗卡住了 Word）' : 'Word conversion timed out'
  return error
}

export function initDocxView(api: ElectronAPI, viewHooks: DocxViewHooks = {}): void {
  hooks = viewHooks
  apiRef = api
  bindEmpty()
  bindConvert()
  bindDrop()
  bindResizer()
  bindPreviewActions()
}

// ── 预览 PDF 的「拿得走」────────────────────────────────────────────────
// 预览文件躺在应用的缓存目录里（见 main/docx-convert），不写用户目录。要拿到它
// 只有两条显式通路：导出到 docx 同目录、在文件管理器里定位。

function showPreviewActions(show: boolean): void {
  for (const id of ['docx-export-btn', 'docx-reveal-btn']) {
    const btn = docxEl<HTMLButtonElement>(id)
    if (btn) btn.hidden = !show
  }
}

function bindPreviewActions(): void {
  const zh = isChinese()
  const exportBtn = docxEl<HTMLButtonElement>('docx-export-btn')
  if (exportBtn) {
    exportBtn.textContent = zh ? '导出 PDF' : 'Export PDF'
    exportBtn.title = zh
      ? '把这份 PDF 复制到 Word 文档所在目录（同名文件会先问你）'
      : 'Copy this PDF next to the Word document (asks before overwriting)'
    exportBtn.addEventListener('click', () => { void exportPreviewPdf() })
  }
  const revealBtn = docxEl<HTMLButtonElement>('docx-reveal-btn')
  if (revealBtn) {
    revealBtn.title = zh
      ? '在文件夹中显示预览 PDF（缓存在应用数据目录）'
      : 'Show the preview PDF in its folder (cached in app data)'
    revealBtn.addEventListener('click', () => { void revealPreviewPdf() })
  }
  showPreviewActions(false)
}

async function revealPreviewPdf(): Promise<void> {
  const api = apiRef
  const pdfPath = previewPdfPath
  if (!api || !pdfPath) return
  await api.docxRevealPreview(pdfPath)
}

async function exportPreviewPdf(): Promise<void> {
  const api = apiRef
  const source = openedDocxPath
  const pdfPath = previewPdfPath
  if (!api || !source || !pdfPath || exporting) return
  const zh = isChinese()
  exporting = true
  const btn = docxEl<HTMLButtonElement>('docx-export-btn')
  if (btn) btn.disabled = true
  try {
    const result = await api.docxExportPdf(source, pdfPath)
    if (result.ok && result.path) {
      setStatus(zh ? `PDF 已存到文档同目录：${result.path}` : `PDF saved next to the document: ${result.path}`)
    } else if (!result.canceled) {
      setStatus(result.error || (zh ? '导出 PDF 失败' : 'Could not export the PDF'))
    }
  } catch (error) {
    setStatus(errorText(error))
  } finally {
    exporting = false
    if (btn) btn.disabled = false
  }
}

// ── 左栏宽度（拖分隔条）─────────────────────────────────────────────────
// 编辑器那边的 margin-left、顶栏的 margin-left 都读同一个变量，改一处全动。

function maxPanelWidth(): number {
  return Math.max(DOCX_PANEL_MIN_WIDTH, window.innerWidth - DOCX_PANEL_MIN_EDITOR_WIDTH)
}

function clampPanelWidth(width: number): number {
  return Math.min(maxPanelWidth(), Math.max(DOCX_PANEL_MIN_WIDTH, Math.round(width)))
}

function applyPanelWidth(width: number | null): void {
  pinnedWidth = width
  if (width === null) {
    // 回到默认：去掉像素值，交给 CSS 的 50% 兜底，窗口缩放时两栏一直是这个比例
    document.documentElement.style.removeProperty('--docx-panel-width')
    return
  }
  document.documentElement.style.setProperty('--docx-panel-width', `${width}px`)
}

function bindResizer(): void {
  const resizer = docxEl('docx-resizer')
  if (!resizer) return
  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    // 拿不到指针捕获也要能拖：move/up 挂在 window 上，捕获成功时事件会重定向到
    // 分隔条再冒泡到 window，没捕获时指针划过其它元素同样冒泡到 window。
    try {
      resizer.setPointerCapture(event.pointerId)
    } catch {
      /* 合成事件 / 个别环境拿不到捕获，上面的 window 监听兜住 */
    }
    resizer.classList.add('dragging')
    document.body.classList.add('docx-resizing')
    // 从当前实际宽度开始拖（没拖过时是 CSS 那一半），否则一按下就会跳位
    const panel = docxEl('docx-panel')
    let width = panel ? Math.round(panel.getBoundingClientRect().width) : Math.round(window.innerWidth / 2)
    const move = (moveEvent: PointerEvent) => {
      width = clampPanelWidth(moveEvent.clientX)
      applyPanelWidth(width)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      resizer.classList.remove('dragging')
      document.body.classList.remove('docx-resizing')
      localStorage.setItem(DOCX_PANEL_WIDTH_KEY, String(width))
      // PDF 不用手动重画：pdf-canvas 的 ResizeObserver 盯着容器宽度，自己会重排
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  })
  // 双击分隔条回到默认对半：拖窄了想恢复时不用去猜该拖到哪
  resizer.addEventListener('dblclick', () => {
    applyPanelWidth(null)
    localStorage.removeItem(DOCX_PANEL_WIDTH_KEY)
  })
  // 拖过之后宽度是写死的像素，窗口变小可能把编辑器挤没了：重新夹一次
  window.addEventListener('resize', () => {
    if (pinnedWidth !== null) applyPanelWidth(clampPanelWidth(pinnedWidth))
  })
}

// ── 标签页的进出 ────────────────────────────────────────────────────────
// 与图片转md 同一手法：body class 管住 chrome（文件面板收起、编辑器让出左半边），
// 面板自己再显隐一次。同步执行 —— 切标签页的第一帧就得对。

export function enterDocxTabChrome(): void {
  document.body.classList.add('docx-view')
  const panel = docxEl('docx-panel')
  if (panel) panel.hidden = false
  const resizer = docxEl('docx-resizer')
  if (resizer) resizer.hidden = false
  // 恢复上次拖过的宽度；没拖过就清掉像素值，走 CSS 的 50%
  const saved = Number.parseInt(localStorage.getItem(DOCX_PANEL_WIDTH_KEY) ?? '', 10)
  applyPanelWidth(saved ? clampPanelWidth(saved) : null)
}

export function leaveDocxTab(): void {
  document.body.classList.remove('docx-view')
  const panel = docxEl('docx-panel')
  if (panel) panel.hidden = true
  const resizer = docxEl('docx-resizer')
  if (resizer) resizer.hidden = true
  openedDocxPath = null
  // previewPdfPath 故意留着：临时 PDF 还在盘上，切回这个标签页时能直接重画左栏，
  // 不至于为了看一眼版式又跑一遍几秒的 Word。两步的进度状态要清掉，否则切回来
  // 时状态行仍写着上一次的「正在……」。
  previewStep = 'idle'
  markdownStep = 'idle'
  previewErrorText = ''
  markdownErrorText = ''
  markdownWarnings = 0
  setConvertBusy(false)
  showConvertButton(false)
  showPreviewActions(false)
  setLoading(false, '')
  setStatus('')
  setSourceName('')
  // 放掉 PDF 文档与 worker：这个标签页再切回来会按 docxPath 重新画一遍
  clearPdfView()
  showPdfPane(false)
  showEmpty(emptyMessage())
}

/** 显示标签页里那份文档。null = 还没选，把空态摆出来。 */
export async function loadDocxTab(docxPath: string | null): Promise<void> {
  if (!docxPath) {
    showEmpty(emptyMessage())
    showConvertButton(false)
    return
  }
  showDocx(docxPath)
  // 切回来时按上一次生成的 PDF 重画左栏（文件还在临时目录里）；从没转换过就只
  // 显示文件信息卡，用户点「重新转换」开跑。
  if (!previewPdfPath) return
  previewStep = 'running'
  setLoading(true, isChinese() ? '正在绘制 PDF 预览…' : 'Painting the PDF preview…')
  const failure = await showPdf(previewPdfPath)
  previewStep = failure ? 'failed' : 'ok'
  if (failure) previewErrorText = failure
  setLoading(false, '')
  if (failure) setStatus(failure)
}

function showDocx(path: string): void {
  openedDocxPath = path
  setSourceName(fileNameOf(path))
  const name = docxEl('docx-file-name')
  if (name) name.textContent = fileNameOf(path)
  showFileCard(true)
  setFileHint('waiting')
  const empty = docxEl('docx-empty')
  if (empty) empty.hidden = true
  showConvertButton(true)
  setStatus('')
  hooks.onDocxSourceChange?.(path)
}

// ── 选文档 ─────────────────────────────────────────────────────────────

async function pickDocx(): Promise<void> {
  const api = apiRef
  if (!api || converting) return
  const picked = await api.pickDocxFile()
  if (!picked) return
  resetPreview()
  showDocx(picked)
  // 「选择 Word 文档」本身就是发令枪：选完立刻左手 PDF 预览、右手 Markdown，
  // 不再要求用户再点一次按钮（以前那一步是纯粹的额外操作）。
  await runConvert()
}

/** 换文档 / 重新转换：把上一份的预览（PDF 字节 + canvas）彻底丢掉。 */
function resetPreview(): void {
  previewPdfPath = null
  clearPdfView()
  showPdfPane(false)
  showPreviewActions(false)
  // 预览清掉后左栏不能空着：先把文件卡摆回来（转换成功后 showPdf 会隐藏它）
  showFileCard(true)
  setFileHint('converting')
}

function bindEmpty(): void {
  const zh = isChinese()
  const openBtn = docxEl<HTMLButtonElement>('docx-open-btn')
  if (openBtn) {
    openBtn.textContent = zh ? '选择 Word 文档…' : 'Choose Word Document…'
    openBtn.addEventListener('click', () => { void pickDocx() })
  }
  showEmpty(emptyMessage())
}

// ── 预览（docx → PDF）──────────────────────────────────────────────────

function showFileCard(show: boolean): void {
  const card = docxEl('docx-file')
  if (card) card.hidden = !show
}

/** 文件卡下面那行小字：转换中 / 失败可重试，随状态换，免得说错话。 */
function setFileHint(kind: 'waiting' | 'converting' | 'failed'): void {
  const el = docxEl('docx-file-hint')
  if (!el) return
  const zh = isChinese()
  if (kind === 'converting') {
    el.textContent = zh ? '正在用 Word 生成 PDF 预览…' : 'Rendering a PDF preview with Word…'
    return
  }
  if (kind === 'failed') {
    el.textContent = zh ? '预览没生成出来，可点上方「重新转换」重试' : 'Preview failed — use “Convert again” to retry'
    return
  }
  el.textContent = zh ? '准备转换…' : 'Ready to convert…'
}

function showPdfPane(show: boolean): void {
  const pane = docxEl('docx-pdf')
  if (!pane) return
  pane.hidden = !show
  if (!show) pane.replaceChildren()
}

/** 把 PDF 画进左栏。成功返回 null，失败返回给人看的原因（状态行由调用方合成）。 */
async function showPdf(pdfPath: string): Promise<string | null> {
  const api = apiRef
  const pane = docxEl('docx-pdf')
  if (!api || !pane) return null
  const picked = await api.readPdfFile(pdfPath)
  if (!picked) {
    showPreviewActions(false)
    return isChinese() ? '预览读不出来（缓存可能已被清理，重新转换即可）' : 'Preview could not be read'
  }
  showPdfPane(true)
  showFileCard(false)
  try {
    await renderPdfInto(pane, picked.data)
    // 有 PDF 才谈得上「导出到同目录 / 定位它」
    showPreviewActions(true)
    return null
  } catch (error) {
    showPdfPane(false)
    showFileCard(true)
    showPreviewActions(false)
    return errorText(error)
  }
}

/** 左栏的加载态：转圈 + 一句进度（只在 PDF 还没画出来时用）。 */
function setLoading(show: boolean, text: string): void {
  const box = docxEl('docx-loading')
  if (!box) return
  box.hidden = !show
  const label = docxEl('docx-loading-text')
  if (label) label.textContent = show ? text : ''
}

// ── 转换（预览 + Markdown 并行）────────────────────────────────────────

/** 进行中的那一句：两条都在跑就一起说，别让用户以为卡住了。 */
function progressText(): string {
  const zh = isChinese()
  const pdfBusy = previewStep === 'running'
  const mdBusy = markdownStep === 'running'
  if (pdfBusy && mdBusy) {
    return zh
      ? '正在用 Word 生成 PDF 预览，同时解析 Markdown…'
      : 'Rendering the PDF preview and parsing Markdown…'
  }
  if (pdfBusy) return zh ? '正在用 Word 生成 PDF 预览…' : 'Rendering the PDF preview with Word…'
  if (mdBusy) return zh ? '正在解析 Markdown…' : 'Parsing Markdown…'
  return ''
}

/** 收尾汇总：两条链路各有各的下场，分开说清楚，别用一个「失败」盖掉另一半。 */
function doneText(): string {
  const zh = isChinese()
  if (previewStep === 'failed' && markdownStep === 'failed') {
    return zh
      ? `预览失败：${previewErrorText}
Markdown 也失败了：${markdownErrorText}`
      : `Preview failed: ${previewErrorText}
Markdown failed: ${markdownErrorText}`
  }
  if (previewStep === 'failed') {
    return zh
      ? `Markdown 已填到右边编辑器；预览失败：${previewErrorText}`
      : `Markdown is in the editor; preview failed: ${previewErrorText}`
  }
  if (markdownStep === 'failed') {
    return zh
      ? `左侧 PDF 预览已就绪；Markdown 失败：${markdownErrorText}`
      : `PDF preview is ready; Markdown failed: ${markdownErrorText}`
  }
  if (previewStep !== 'ok' && markdownStep !== 'ok') return ''
  const warnText = markdownWarnings > 0 ? (zh ? `（${markdownWarnings} 处提示）` : ` (${markdownWarnings} warnings)`) : ''
  return zh
    ? `完成：左侧是 PDF 预览，Markdown 已填到右边编辑器${warnText}`
    : `Done — PDF preview on the left, Markdown in the editor on the right${warnText}`
}

/**
 * 状态行 + 加载层都由这两个 StepState 合成，所以两条链路谁先收尾都行：
 *   · 只要 PDF 还没画出来，就盖着转圈（左栏那时是空的）
 *   · PDF 一出来就撤掉转圈，剩下 Markdown 拖尾只占状态行一行字
 */
function syncStatus(): void {
  const busy = previewStep === 'running' || markdownStep === 'running'
  setLoading(previewStep === 'running', progressText())
  setStatus(busy ? progressText() : doneText())
}

function convertButtonText(busy: boolean): string {
  const zh = isChinese()
  if (busy) return zh ? '转换中' : 'Converting'
  // 选完文档就自动跑过一遍了，这个按钮的作用是「再来一遍」（改过原稿 / 上次失败）
  return zh ? '重新转换' : 'Convert again'
}

function bindConvert(): void {
  const btn = docxEl<HTMLButtonElement>('docx-convert-btn')
  if (!btn) return
  const zh = isChinese()
  btn.textContent = convertButtonText(false)
  btn.title = zh
    ? '重新跑一遍：用本机 Word 生成 PDF 预览放左边，再把正文解析成 Markdown 填到右边编辑器'
    : 'Run again: render a PDF preview with the local Word, then parse Markdown into the editor'
  // 「重新转换」= 真·重来一遍：先丢掉上一次的 PDF，两条链路都重跑（改了 Word
  // 原稿也能看到新版式，而不是只重算右边）。
  btn.addEventListener('click', () => {
    resetPreview()
    void runConvert()
  })
}

function showConvertButton(show: boolean): void {
  const btn = docxEl<HTMLButtonElement>('docx-convert-btn')
  if (!btn) return
  btn.hidden = !show
  if (!show) btn.disabled = false
}

function setConvertBusy(busy: boolean): void {
  converting = busy
  const btn = docxEl<HTMLButtonElement>('docx-convert-btn')
  if (!btn) return
  btn.disabled = busy
  btn.textContent = convertButtonText(busy)
}

/** ① 版式预览：本机 Word → PDF → pdf.js。失败只在自己这条线上记账。 */
async function convertPreview(api: ElectronAPI, path: string): Promise<void> {
  try {
    const convertStarted = performance.now()
    const pdf = await api.docxToPdf(path)
    const convertMs = Math.round(performance.now() - convertStarted)
    if (!pdf.ok || !pdf.pdfPath) {
      // 计时留在控制台：这条链路的耗时全在 Word 那儿，出问题时要能一眼看出卡在哪段
      console.info(`[docx-view] pdf 转换失败 ${convertMs}ms`, pdf.error)
      previewStep = 'failed'
      previewErrorText = convertErrorText(pdf.error)
      showFileCard(true)
      setFileHint('failed')
      showPdfPane(false)
      return
    }
    previewPdfPath = pdf.pdfPath
    // 先画完再收尾：转圈留到 canvas 真的出来，中间不闪一下空白
    const paintStarted = performance.now()
    const failure = await showPdf(pdf.pdfPath)
    console.info(
      `[docx-view] pdf ${convertMs}ms (${pdf.fromCache ? '缓存' : 'Word'}) + 绘制 ${Math.round(performance.now() - paintStarted)}ms`
    )
    if (failure) {
      previewStep = 'failed'
      previewErrorText = failure
      showFileCard(true)
      setFileHint('failed')
      return
    }
    setFileHint('waiting')
    previewStep = 'ok'
  } catch (error) {
    previewStep = 'failed'
    previewErrorText = errorText(error)
  } finally {
    syncStatus()
  }
}

/** ② Markdown：mammoth 那条老链路，与 PDF 完全独立，预览失败也照常解析。 */
async function convertMarkdown(api: ElectronAPI, path: string): Promise<void> {
  try {
    const parseStarted = performance.now()
    const result = await api.convertDocx(path)
    const parseMs = Math.round(performance.now() - parseStarted)
    if (!result.ok) {
      console.info(`[docx-view] markdown 失败 ${parseMs}ms`, result.error)
      markdownStep = 'failed'
      markdownErrorText = result.error || (isChinese() ? '转换失败' : 'Conversion failed')
      return
    }
    const markdown = result.markdown ?? ''
    if (!markdown.trim()) {
      markdownStep = 'failed'
      markdownErrorText = isChinese() ? '这份文档没有可转换的内容' : 'Nothing to convert in this document'
      return
    }
    const paintStarted = performance.now()
    await hooks.onMarkdownText?.(markdown)
    console.info(
      `[docx-view] markdown ${parseMs}ms + 落地 ${Math.round(performance.now() - paintStarted)}ms，${markdown.length} 字符`
    )
    markdownWarnings = result.warnings?.length ?? 0
    markdownStep = 'ok'
  } catch (error) {
    markdownStep = 'failed'
    markdownErrorText = errorText(error)
  } finally {
    syncStatus()
  }
}

async function runConvert(): Promise<void> {
  const api = apiRef
  const path = openedDocxPath
  if (!api || !path || converting) return
  setConvertBusy(true)
  previewStep = 'running'
  markdownStep = 'running'
  previewErrorText = ''
  markdownErrorText = ''
  markdownWarnings = 0
  syncStatus()

  try {
    // 两条链路并行：Word 另存 PDF 与 mammoth 解析谁也不等谁，总时长取两者的较大
    // 值而不是相加 —— Word 冷启动那几秒里，右边的 Markdown 已经在填了。
    await Promise.all([convertPreview(api, path), convertMarkdown(api, path)])
  } finally {
    // 兜底：任何意外都不能把按钮留在「转换中」
    if (previewStep === 'running') {
      previewStep = 'failed'
      previewErrorText = isChinese() ? '未知错误' : 'Unknown error'
    }
    if (markdownStep === 'running') {
      markdownStep = 'failed'
      markdownErrorText = isChinese() ? '未知错误' : 'Unknown error'
    }
    setConvertBusy(false)
    syncStatus()
  }
}

// ── 拖入文档 ──────────────────────────────────────────────────────────
// 与图片栏同一个便利：把 .docx 拖进左栏就直接选中它，选中即转换（与点「选择
// Word 文档…」同一个下场，两边的行为不能不一样）。

function bindDrop(): void {
  const panel = docxEl('docx-panel')
  if (!panel) return
  let depth = 0
  panel.addEventListener('dragenter', (event) => {
    event.preventDefault()
    depth += 1
    panel.classList.add('docx-drop-over')
  })
  panel.addEventListener('dragover', (event) => event.preventDefault())
  panel.addEventListener('dragleave', () => {
    depth -= 1
    if (depth <= 0) {
      depth = 0
      panel.classList.remove('docx-drop-over')
    }
  })
  panel.addEventListener('drop', (event) => {
    event.preventDefault()
    // 别让全局的 drop（拖文件打开文档）把这份 docx 当成要打开的文档
    event.stopPropagation()
    depth = 0
    panel.classList.remove('docx-drop-over')
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    if (!/\.docx$/i.test(file.name)) {
      setStatus(isChinese() ? '只支持 .docx 文档' : 'Only .docx documents are supported')
      return
    }
    const path = apiRef?.getPathForFile(file)
    if (!path) {
      setStatus(isChinese() ? '这份文档收不下来' : 'Could not take this document')
      return
    }
    resetPreview()
    showDocx(path)
    void runConvert()
  })
}

// ── 空态 / 状态行 ──────────────────────────────────────────────────────

function emptyMessage(): string {
  return isChinese()
    ? '还没有文档：选择或拖入一份 Word 文档，选完会自动转换 —— 左侧显示 PDF 版式预览，右侧填上 Markdown。'
    : 'No document yet: choose or drop a Word document and it converts right away — the PDF preview lands on the left, the Markdown on the right.'
}

function showEmpty(message: string): void {
  const text = docxEl('docx-empty-text')
  if (text) text.textContent = message
  const empty = docxEl('docx-empty')
  if (empty) empty.hidden = false
  showFileCard(false)
}

function setSourceName(name: string): void {
  const el = docxEl('docx-source-name')
  if (el) el.textContent = name
}

function setStatus(text: string): void {
  const el = docxEl('docx-status')
  if (!el) return
  el.textContent = text
  el.hidden = !text
}

/** 当前 docx 标签页挂着的文档路径（切走再切回来要按它重新显示）。 */
export function getOpenedDocxPath(): string | null {
  return openedDocxPath
}
