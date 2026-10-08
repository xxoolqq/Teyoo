import { createEditor, flashHeadingOnArrival, focusEditor, getEditorView, getMarkdown, onEditorJumpPhase, setMarkdown, showMathModal, setMathModalLanguage, releaseMermaidRenderer, getEditorState, restoreEditorState, applyMarkdownStyle, applyFont } from './editor/editor'
import { setupToolbar, toggleToolbarVisible, runToolbarCommand } from './toolbar'
import { setCurrentImageFilePath } from '../extensions/image-style'
import { detectMarkdownStyle } from './editor/markdown-style'
import { SearchPanel } from './editor/search-panel'
import { DEFAULT_WORK_DIR, showPreferencesModal, getExportFormulaEnginePreference } from './preferences-modal'
import { initPrefsStore, getPrefs, onPrefsChanged, setPrefsPath } from './preferences-store'
import { applyTheme, loadSavedTheme } from './themes/theme-manager'
import { setUiLanguage, isChinese, type UiLanguage } from './ui-language'
import { applyEditorFont, loadSavedEditorFont, showFontSettingsModal } from './editor/font-settings'
import { enterPdfTabChrome, getOpenedPdfPath, initPdfView, leavePdfTab, loadPdfTab } from './pdf-view'
import { enterImageTabChrome, initImageView, leaveImageTab, loadImageTab } from './image-view'
import { enterToolTabChrome, initToolView, leaveToolTab, loadToolTab, toolTabLabel, type ToolId } from './tool-view'
import { initAssistant, refreshAssistantContext, setAssistantOpen } from './assistant'
import { initDocBar, type DocFormat } from './doc-bar'
import { getJsonOrigin, getJsonPath, getJsonText, initJsonView, refreshJsonLayout } from './json-view'
import { initPrintPreview, showPrintPreview } from './print-preview'
import { clearPdfBlockAnchors, scheduleBlockLinkRebuild, setBlockLinkView } from './block-link'
import { canvasDocTabLabel, canvasDocWindowTitle, hideCanvasDocView, releaseCanvasDocTab, showCanvasDocView } from './canvas-editor'
// 工具栏里那几个「新建标签页 / 打开文件」的动作用钩子注册进来（避免
// toolbar → main.ts 的循环依赖），见 canvas-editor/host.ts。
import { setCanvasDocHooks, type CanvasDocInit } from './canvas-editor/host'
import './themes/base.css'
import './themes/premium.css'

let sourceModeActive = false
const editorEl = () => document.getElementById('editor') as HTMLElement
const sourceEl = () => document.getElementById('source-editor') as HTMLTextAreaElement
const filePanelEl = () => document.getElementById('file-panel') as HTMLElement
const fileListEl = () => document.getElementById('file-list') as HTMLElement
const outlineListEl = () => document.getElementById('outline-list') as HTMLElement
const fileTabEl = () => document.getElementById('file-panel-files') as HTMLButtonElement
const outlineTabEl = () => document.getElementById('file-panel-outline') as HTMLButtonElement
const fileToggleBtnEl = () => document.getElementById('file-toggle-btn') as HTMLButtonElement
const sourceToggleBtnEl = () => document.getElementById('source-toggle-btn') as HTMLButtonElement
const wordCountEl = () => document.getElementById('word-count') as HTMLElement
const saveStatusEl = () => document.getElementById('save-status') as HTMLElement
const updateBannerEl = () => document.getElementById('update-banner') as HTMLElement
const updateBannerTextEl = () => document.getElementById('update-banner-text') as HTMLElement
const updateBannerActionEl = () => document.getElementById('update-banner-action') as HTMLButtonElement
const submitPanelEl = () => document.getElementById('submit-panel') as HTMLElement
const submitPreviewEl = () => document.getElementById('submit-preview') as HTMLElement
const submitInputEl = () => document.getElementById('submit-input') as HTMLTextAreaElement
const submitInputSecondaryEl = () => document.getElementById('submit-input-secondary') as HTMLTextAreaElement
const submitBtnEl = () => document.getElementById('submit-btn') as HTMLButtonElement
const submitFeedbackEl = () => document.getElementById('submit-feedback') as HTMLElement

// --- Same-directory file panel ---
let currentFilePath: string | null = null
let fileManagerName: import('../preload/index').FileManagerName = 'file-manager'
let dirty = false
// Programmatic Markdown replacement dispatches a synchronous ProseMirror
// transaction. Suppress only that transaction, never a time window of input.
let applyingProgrammaticChange = false
// The editor emits updates while it is being built: the initial document plus
// the trailing paragraph it inserts. Those are not user edits, so a document
// must not start out dirty, or closing an untouched new window would ask to
// save it.
let editorReady = false
// Fresh installs start focused on the document. Once changed, the user's
// explicit panel preference is preserved.
let manualHidden = localStorage.getItem('file-panel-hidden') !== '0'
let panelMode: 'files' | 'outline' = 'files'
let outlineUpdateQueued = false
// Outline doubles as a reading-progress view (#64): the entry for the section
// currently at the top of the viewport is highlighted and kept visible.
// outlineItems only caches source-mode line numbers; visual mode re-queries
// the live DOM at use time because Milkdown recreates heading nodes whenever
// the content is re-set, which silently detaches cached element references.
let outlineItems: OutlineItem[] = []
let outlineActiveIndex = -1
let outlineSyncQueued = false
// While an outline click drives a smooth scroll, scrollspy updates are paused
// so the in-flight scroll events cannot overwrite the clicked entry; the lock
// is released on `scrollend` or by a fallback timer when no scroll happens.
let outlineJumping = false
let outlineJumpTimer: ReturnType<typeof setTimeout> | null = null
let outlineJumpStartTop = 0

// 缓存上次序列化/反序列化结果，避免模式切换时重复执行昂贵的
// getMarkdown() / setMarkdown() 操作。
// - cachedMarkdown: 上次 WYSIWYG → Source 时 getMarkdown() 的结果（未折叠 base64）
// - sourceEnterText: 上次进入 Source 模式时 textarea 的值（已折叠 base64）
// WYSIWYG → Source 时若 dirty === false 且有缓存，跳过序列化。
// Source → WYSIWYG 时若 textarea 内容未改，跳过解析。
let cachedMarkdown: string | null = null
let sourceEnterText: string | null = null

// Resizable file panel: default 220px, drag range 180-420px, persisted
// locally (design.md: light, no permanent handle, hover feedback only).
// Applied at module load so the first paint already uses the saved width.
// The strip's start IS the panel's edge line at every width, so the floor is
// only about the panel's own contents as before.
const FILE_PANEL_MIN_WIDTH = 180
const FILE_PANEL_MAX_WIDTH = 420
const FILE_PANEL_DEFAULT_WIDTH = 220

function clampFilePanelWidth(width: number): number {
  return Math.min(FILE_PANEL_MAX_WIDTH, Math.max(FILE_PANEL_MIN_WIDTH, Math.round(width)))
}

function applyFilePanelWidth(width: number): void {
  document.documentElement.style.setProperty('--file-panel-width', `${width}px`)
}

applyFilePanelWidth(clampFilePanelWidth(Number.parseInt(localStorage.getItem('file-panel-width') ?? '', 10) || FILE_PANEL_DEFAULT_WIDTH))
// PDF 对照的外壳（body.pdf-view）不再首帧就加：它是标签页级别的状态，由
// activateTab 在切进/切出 PDF 标签页时开关（见 enterPdfTabChrome / leavePdfTab）。

function setMarkdownProgrammatically(content: string, flushHistory = false): void {
  applyingProgrammaticChange = true
  try {
    setMarkdown(content, flushHistory)
  } finally {
    applyingProgrammaticChange = false
  }
}

// --- Unsaved-state tracking + auto-save ---
let autosaveTimer: ReturnType<typeof setInterval> | null = null
let documentRevision = 0
let saveQueue: Promise<void> = Promise.resolve()

function reportDirty(): void {
  window.electronAPI.reportDirty(dirty)
}

// --- Save status hint (#49) ---
let saveStatusTimer: ReturnType<typeof setTimeout> | null = null
// True while an external-modification conflict waits for the user's choice;
// autosave stays paused so it cannot silently overwrite the external edit.
let externalConflictPending = false

function showSaveStatus(state: 'dirty' | 'saved'): void {
  const el = saveStatusEl()
  if (!el) return
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer)
    saveStatusTimer = null
  }
  // The dirty hint is gone: the active tab shows a dot for it, and a label in
  // the row was one signal too many. The element stays for the messages that
  // need words, such as an external edit waiting on the user's choice.
  if (state === 'dirty') {
    el.classList.remove('pending')
    el.textContent = ''
  } else {
    el.classList.remove('pending')
    saveStatusTimer = setTimeout(() => {
      el.textContent = ''
    }, 600)
  }
}

function clearSaveStatus(): void {
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer)
    saveStatusTimer = null
  }
  const el = saveStatusEl()
  if (el) {
    el.classList.remove('pending', 'saved')
    el.textContent = ''
  }
}

// An external edit landing while the user still has unsaved changes must never
// clobber the editor, and plain autosave would silently overwrite the external
// edit. Pause autosave and let the user choose explicitly.
function raiseExternalConflict(): void {
  if (externalConflictPending) return
  externalConflictPending = true
  clearAutosaveTimer()
  const el = saveStatusEl()
  if (el) {
    if (saveStatusTimer) {
      clearTimeout(saveStatusTimer)
      saveStatusTimer = null
    }
    el.textContent = isChinese() ? '文件已被外部修改' : 'File changed externally'
    el.classList.remove('saved')
    el.classList.add('pending')
  }
  window.electronAPI.reportExternalConflict?.()
}

// --- Tabs (design.md) ---
// Tabs are created by the user (the + button or ⌘T) and never appear on their own.
// The module-level document state above always describes the ACTIVE tab, so every
// existing path (save, autosave, external conflict, outline, source mode) keeps
// working unchanged. Background tabs keep a snapshot of their own state, which
// makes switching a capture/restore pair instead of a second document machine.
interface DocumentTab {
  id: string
  /** document: 编辑器标签页；submit: 提交表单标签页；canvas: 类docx文档标签页（canvas-editor，非 Markdown 编辑器视图） */
  kind: 'document' | 'submit' | 'canvas'
  filePath: string | null
  /**
   * 这个标签页是不是 PDF 对照标签页（左 PDF / 右文档）。它仍是一个普通文档
   * 标签页 —— full.md 填进来后照样能改、能保存、能标脏 —— 只是额外挂着一份
   * 源文件，窗口里最多一个（再点「PDF转md」就聚焦已有的那个）。
   */
  pdfTab: boolean
  /** 对照的源文件路径；还没选（用户没点「打开 PDF…」）就是 null，面板显示空态。 */
  pdfPath: string | null
  /**
   * 这个标签页是不是「图片转md」标签页（左图片预览 / 右文档）。与 PDF 对照同一
   * 个套路：仍是普通文档标签页（转换结果填进来后照样能改能存），只是挂着一张
   * 源图片，窗口里最多一个（再点「图片转md」就聚焦已有的那个）。
   */
  imageTab: boolean
  /** 源图片路径；还没选就是 null，面板显示空态。 */
  imagePath: string | null
  /**
   * 工具箱标签页（菜单「帮助 → 工具箱」）：整页工具界面，不是文档编辑器。这里写
   * 的是当前打开的工具（见 tool-view.ts），非 null 即表示这个标签页是工具页 ——
   * 与 pdfTab / imageTab 那套布尔标志位同一个用法，只是工具箱以后会有多个工具，
   * 所以存工具 id 而不是再开一个 boolean。窗口里最多一个工具标签页。
   */
  tool: ToolId | null
  /** 工具当前挂着的源文件（PDF拆分选中的那份 PDF）；没选就是 null。 */
  toolPath: string | null
  dirty: boolean
  revision: number
  sourceMode: boolean
  sourceText: string
  content: string
  editorState: import('@milkdown/kit/prose/state').EditorState | null
  diskContent: string | null
  scrollTop: number
}

const tabs: DocumentTab[] = []
let activeTabId: string | null = null
let nextTabId = 1
let switchingTab = false

const tabBarEl = () => document.getElementById('tab-bar') as HTMLElement

function activeTab(): DocumentTab | null {
  return tabs.find((tab) => tab.id === activeTabId) ?? null
}

// The label for a document that has no path yet, in the current UI language.
let untitledName = 'Untitled'

function untitledLabel(): string {
  return untitledName
}

// The tab carries the document's name, not its file name. `.md` on every tab is
// noise in a strip that hugs its label, and it lands right where the ellipsis
// cuts — `解读.…` reads as four dots. Mirrors the panel's markdown filter.
const DOCUMENT_SUFFIX = /\.(md|markdown|mdown|mkd)$/i

const PDF_SUFFIX = /\.pdf$/i

function tabLabel(tab: DocumentTab): string {
  if (tab.kind === 'submit') return isChinese() ? '提交' : 'Submit'
  if (tab.kind === 'canvas') return canvasDocTabLabel()
  if (tab.filePath) {
    const name = tab.filePath.split(/[\\/]/).pop() || tab.filePath
    return name.replace(DOCUMENT_SUFFIX, '')
  }
  // PDF 对照标签页还没另存过：挂了源文件就写它的名字，一个都没选时写「PDF」。
  if (tab.pdfTab) {
    if (!tab.pdfPath) return 'PDF'
    return (tab.pdfPath.split(/[\\/]/).pop() || tab.pdfPath).replace(PDF_SUFFIX, '')
  }
  // 图片转md 标签页同源：挂了图片就写图片名，没选时写「图片」。
  if (tab.imageTab) {
    if (!tab.imagePath) return isChinese() ? '图片' : 'Image'
    return tab.imagePath.split(/[\\/]/).pop() || tab.imagePath
  }
  // 工具箱标签页：标题就是工具名（目前只有「PDF拆分」），不带文件名。
  if (tab.tool) return toolTabLabel(tab.tool)
  return untitledLabel()
}

// Read the live state back into the active tab's record. Called before every
// switch, close and bar render, so the records and the screen cannot disagree.
function captureActiveTab(): void {
  const tab = activeTab()
  if (!tab) return
  // 提交页 / 类docx文档页不是 Markdown 编辑器：模块级编辑器状态仍描述上一个
  // 文档标签页，不能写进它们的记录（否则会被误判为可保存的文档）。
  if (tab.kind === 'submit' || tab.kind === 'canvas') return
  // The path is the tab's identity and only changes where a document is really
  // opened or saved; deriving it here would let a stray render rename a tab.
  tab.dirty = dirty
  tab.revision = documentRevision
  tab.sourceMode = sourceModeActive
  tab.content = getContent()
  if (sourceModeActive) {
    tab.sourceText = sourceEl().value
    tab.scrollTop = sourceEl().scrollTop
  } else {
    tab.editorState = getEditorState()
    tab.scrollTop = editorEl().scrollTop
  }
}

// The bar only carries the unsaved mark that the tab already owns; the title bar
// keeps the primary save hint.
function markActiveTabDirty(): void {
  const tab = activeTab()
  if (!tab || tab.kind === 'submit' || tab.kind === 'canvas') return
  tab.dirty = dirty
  const entry = tabBarEl().querySelector(`.tab-entry[data-tab-id="${tab.id}"]`)
  entry?.classList.toggle('dirty', dirty)
}

// --- The floating label ---
// ONE fixed layer for every name the shell has to shorten: a tab (where it also
// carries ⌘W) and a file-panel row. Neither the strip nor the panel can host it
// — both clip their own overflow — so the renderer positions it.
// A tab waits longer: hovering a tab is usually a prelude to clicking it, and a
// label that jumps out immediately is noise. A row is different — the name is
// what was asked for, so it answers sooner.
const TAB_TIP_DELAY = 1000
const ROW_TIP_DELAY = 450

let tipTimer: ReturnType<typeof setTimeout> | undefined

function showTip(anchor: HTMLElement, text: string, side: 'below' | 'right'): void {
  const tip = document.getElementById('hover-tip') as HTMLElement | null
  if (!tip) return
  tip.textContent = text
  tip.hidden = false
  const rect = anchor.getBoundingClientRect()
  const width = tip.offsetWidth
  if (side === 'right') {
    // Beside the panel and level with the row: the label describes the list, so
    // it must not cover it.
    const height = tip.offsetHeight
    tip.style.left = `${Math.round(Math.min(rect.right + 8, window.innerWidth - width - 8))}px`
    tip.style.top = `${Math.round(Math.min(Math.max(8, rect.top + rect.height / 2 - height / 2), window.innerHeight - height - 8))}px`
    return
  }
  tip.style.left = `${Math.round(Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8))}px`
  tip.style.top = `${Math.round(rect.bottom + 7)}px`
}

function scheduleTip(anchor: HTMLElement, text: string, side: 'below' | 'right', delay: number): void {
  clearTimeout(tipTimer)
  tipTimer = setTimeout(() => showTip(anchor, text, side), delay)
}

function hideTip(): void {
  clearTimeout(tipTimer)
  const tip = document.getElementById('hover-tip') as HTMLElement | null
  if (tip) tip.hidden = true
}

// A tab whose name fits says nothing but the shortcut; only a truncated name is
// worth spelling out. The full path never appears on hover: it was the system
// tooltip, and it reads as an accident.
function tabTipText(entry: HTMLElement): string {
  const shortcut = '⌘W'
  const name = entry.querySelector('.tab-entry-name') as HTMLElement | null
  const full = entry.dataset.fullName ?? ''
  if (!name || !full) return shortcut
  return name.scrollWidth > name.clientWidth + 1 ? `${full} · ${shortcut}` : shortcut
}

function hideTabTip(): void {
  hideTip()
}
function closeGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '9')
  svg.setAttribute('height', '9')
  svg.setAttribute('viewBox', '0 0 9 9')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('stroke-linecap', 'round')
  for (const [x1, y1, x2, y2] of [['1.6', '1.6', '7.4', '7.4'], ['7.4', '1.6', '1.6', '7.4']]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2)
    svg.append(line)
  }
  return svg
}

// Same plus as the title bar button, at the tab strip's scale.

// The plus at the strip's scale, same shape as the icons in the title bar.
function plusGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('stroke-linecap', 'round')
  for (const [x1, y1, x2, y2] of [['8', '3.1', '8', '12.9'], ['3.1', '8', '12.9', '8']]) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2)
    svg.append(line)
  }
  return svg
}

// 提交按钮的上传图标（向上箭头 + 底部横线），跟随按钮文字色（currentColor）。
function uploadGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '13')
  svg.setAttribute('height', '13')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const d of ['M8 11.4V4.4', 'M4.9 7.5 8 4.4l3.1 3.1', 'M3.8 12.6h8.4']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

// 「已提交」按钮的对勾图标，跟随按钮文字色（currentColor）。
function checkGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '13')
  svg.setAttribute('height', '13')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M3.8 8.4l2.8 2.8 5.6-5.6')
  svg.append(path)
  return svg
}

function renderTabBar(): void {
  captureActiveTab()
  const bar = tabBarEl()
  // The strip is always there: with the layout collapsed into the title bar's
  // row it costs no extra height, and one shape for the chrome beats a title bar
  // that changes personality when a second document appears.
  bar.hidden = false
  // The strip lives inside the title bar's row now, so it consumes no height of
  // its own: the editor starts right under the same 40px row either way.
  document.documentElement.style.setProperty('--tab-bar-height', '0px')
  document.documentElement.style.setProperty('--editor-top-gap', '0px')
  bar.innerHTML = ''
  // Hide the hover hint unconditionally, including the path where the whole
  // strip disappears (one tab left): a pending timer would otherwise pop "⌘W"
  // for a tab that no longer exists, and a visible hint would never leave —
  // the strip it belongs to is gone, so no mouseleave can fire (#90).
  hideTabTip()
  for (const tab of tabs) {
    const entry = document.createElement('div')
    entry.className = 'tab-entry'
    entry.dataset.tabId = tab.id
    entry.setAttribute('role', 'tab')
    entry.dataset.fullName = tabLabel(tab)
    if (tab.id === activeTabId) {
      entry.classList.add('active')
      entry.setAttribute('aria-selected', 'true')
    }
    if (tab.dirty) entry.classList.add('dirty')
    const name = document.createElement('span')
    name.className = 'tab-entry-name'
    name.textContent = tabLabel(tab)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tab-entry-close'
    close.setAttribute('aria-label', isChinese() ? '关闭标签页' : 'Close tab')
    close.append(closeGlyph())
    entry.append(name, close)
    bar.append(entry)
  }
  // The plus sits right after the strip, not inside it: inside, a full row of
  // tabs scrolled it out of sight exactly when it was needed. It is one of the
  // row's icon controls, so the shared rule styles it and it keeps its gutter
  // from the last tab.
  const titlebar = bar.parentElement as HTMLElement | null
  titlebar?.querySelector('.tab-new-btn')?.remove()
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'tab-new-btn'
  add.setAttribute('aria-label', isChinese() ? '新建标签页' : 'New tab')
  add.append(plusGlyph())
  add.addEventListener('click', () => void openNewTab())
  add.addEventListener('mouseenter', () => scheduleTip(add, isChinese() ? '新建标签页 · ⌘T' : 'New tab · ⌘T', 'below', TAB_TIP_DELAY))
  add.addEventListener('mouseleave', hideTip)
  bar.after(add)
  // 「提交」放在「显示/隐藏文件列表」按钮左侧（右侧按钮组内）：
  // 新建/聚焦提交表单标签页（非编辑器视图）。文字按钮，样式见 base.css。
  titlebar?.querySelector('.tab-submit-btn')?.remove()
  const submit = document.createElement('button')
  submit.type = 'button'
  submit.className = 'tab-submit-btn'
  // 文字 + 上传图标（样式见 base.css：蓝色实心、圆角、白字）
  submit.textContent = isChinese() ? '提交' : 'Submit'
  submit.append(uploadGlyph())
  submit.setAttribute('aria-label', isChinese() ? '新建提交标签页' : 'New submit tab')
  submit.addEventListener('click', () => void openSubmitTab())
  submit.addEventListener('mouseenter', () => scheduleTip(submit, isChinese() ? '提交' : 'Submit', 'below', TAB_TIP_DELAY))
  submit.addEventListener('mouseleave', hideTip)
  fileToggleBtnEl().before(submit)
  // 「已提交」紧挨「提交」右侧：同款文字按钮，点击后打开一个空白标签页。
  titlebar?.querySelector('.tab-submitted-btn')?.remove()
  const submitted = document.createElement('button')
  submitted.type = 'button'
  submitted.className = 'tab-submitted-btn'
  submitted.textContent = isChinese() ? '已提交' : 'Submitted'
  submitted.append(checkGlyph())
  submitted.setAttribute('aria-label', isChinese() ? '打开已提交的空白标签页' : 'Open submitted blank tab')
  submitted.addEventListener('click', () => void openNewTab())
  submitted.addEventListener('mouseenter', () => scheduleTip(submitted, isChinese() ? '已提交' : 'Submitted', 'below', TAB_TIP_DELAY))
  submitted.addEventListener('mouseleave', hideTip)
  submit.after(submitted)
  const active = bar.querySelector('.tab-entry.active')
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  // Let the main process know which files this window holds in tabs, so opening
  // an already open document can focus that tab instead of duplicating it.
  window.electronAPI.setTabFiles(tabs.map((tab) => tab.filePath).filter((path): path is string => !!path))
  reportActiveTabKind()
}

// 主进程要知道前台是哪种标签页：类 docx 文档（canvas-editor）标签页自成一体的
// 那套，菜单栏的打印/打印预览对它不生效（见 main 的 isCanvasTabActive）。切标签
// 页/换视图都会走到 renderTabBar，借它上报；同值不重复发。
let reportedTabKind: DocumentTab['kind'] | null = null

function reportActiveTabKind(): void {
  const kind = activeTab()?.kind ?? 'document'
  if (kind === reportedTabKind) return
  reportedTabKind = kind
  window.electronAPI.setActiveTabKind(kind)
}

/**
 * 主进程要知道前台这份标签页挂着哪个源文件（PDF 对照 / 图片转md）：「另存为」的
 * 默认文件名按它取（见 main 的 suggestFileName）。两个上报绑在一起，免得只清一个、
 * 留下上一份文件的名字。
 */
function reportActiveSource(tab: DocumentTab | null): void {
  window.electronAPI.setActivePdfPath(tab?.pdfTab ? tab.pdfPath : null)
  window.electronAPI.setActiveImagePath(tab?.imageTab ? tab.imagePath : null)
}

function showBlankDocument(): void {
  releaseMermaidRenderer()
  exitSourceMode()
  applyingProgrammaticChange = true
  try {
    setMarkdown('', true)
  } finally {
    applyingProgrammaticChange = false
  }
  cachedMarkdown = null
  sourceEnterText = null
  foldBase64Cache = null
  updateWordCount('')
  resetDirty()
  updateFileTitle()
  updatePanelVisibility()
  void refreshSiblings()
  scheduleOutlineUpdate()
  editorEl().scrollTop = 0
  sourceEl().scrollTop = 0
}

// Switching away must not lose work. A tab with a path is flushed through the
// usual queue (same rule the file panel already followed); an untitled tab keeps
// its content in its own record and is only decided on when it would really be
// dropped (closing the tab, or closing the window).
async function saveTabForLeaving(tab: DocumentTab | null): Promise<boolean> {
  if (!tab || !tab.dirty || !tab.filePath) return true
  return await saveCurrent()
}

// The window always holds at least one document, so the strip never shows a
// lone plus next to a welcome screen that belongs to no tab: a launch with no
// file seeds the first tab here, and a file that arrives later adopts it.
function ensureTab(): DocumentTab {
  const existing = activeTab()
  if (existing && existing.kind === 'document' && !existing.pdfTab && !existing.imageTab) return existing
  // 提交页 / 类docx文档页 / PDF 对照页 / 图片转md 页是活动标签页时，到来的文档
  // 不能落在它身上：种一个新的文档标签页接管活动位（它们退回后台，供切回）。
  if (existing) {
    const tab: DocumentTab = {
      id: `tab-${nextTabId++}`,
      kind: 'document',
      filePath: null,
      pdfTab: false,
      pdfPath: null,
      imageTab: false,
      imagePath: null,
      tool: null,
      toolPath: null,
      dirty: false,
      revision: documentRevision,
      sourceMode: false,
      sourceText: '',
      content: '',
      editorState: null,
      diskContent: null,
      scrollTop: 0
    }
    tabs.push(tab)
    activeTabId = tab.id
    hideSubmitView()
    hideCanvasDocView()
    // 对照面板跟着标签页走：新文档标签页没有它。
    leavePdfTabChrome()
    leaveImageTab()
    updatePanelVisibility()
    return tab
  }
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    kind: 'document',
    filePath: null,
    pdfTab: false,
    pdfPath: null,
    imageTab: false,
    imagePath: null,
    tool: null,
    toolPath: null,
    dirty: false,
    revision: documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    editorState: null,
    diskContent: null,
    scrollTop: 0
  }
  tabs.push(tab)
  activeTabId = tab.id
  return tab
}

/**
 * 离开 PDF 对照标签页：面板收起、文档与 worker 放掉。格式一并回到 Markdown ——
 * JSON 是 PDF 对照下那份中间结果的只读视图，留在普通标签页上没有意义。
 */
function leavePdfTabChrome(): void {
  leavePdfTab()
  setDocFormat('markdown')
}

async function openNewTab(): Promise<void> {
  const previous = activeTab()
  captureActiveTab()
  if (!await saveTabForLeaving(previous)) return
  // 从提交页 / 类docx文档页 / PDF 对照页 / 图片转md 页新建文档标签页时，先把
  // 这些视图收起来（编辑面归位）
  hideSubmitView()
  hideCanvasDocView()
  leavePdfTabChrome()
  leaveImageTab()
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    kind: 'document',
    filePath: null,
    pdfTab: false,
    pdfPath: null,
    imageTab: false,
    imagePath: null,
    tool: null,
    toolPath: null,
    dirty: false,
    revision: ++documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    editorState: null,
    diskContent: null,
    scrollTop: 0
  }
  tabs.push(tab)
  activeTabId = tab.id
  currentFilePath = null
  // Tell the main process the window is now on an untitled document, otherwise
  // its notion of the active file still points at the previous tab's file.
  await window.electronAPI.activateFile(null)
  reportActiveSource(null)
  showBlankDocument()
  updatePanelVisibility()
  renderTabBar()
  // The new tab exists to be typed in, so the caret goes there without a click.
  focusEditor()
}

// ─── 提交标签页（非编辑器视图） ─────────────────────────────────────────
// 「提交」按钮（+ 号右侧）打开的表单页：一个输入框 + 一个提交按钮，
// 左侧是主编辑器只读预览（输入的 markdown 实时渲染）。它复用标签页
// 的条/切换/关闭机制，但不承载文档内容。

/** 提交页接管编辑区：主编辑器 #editor 的 DOM 移入左侧预览栏只读渲染
 *  输入内容（ProseMirror 状态不随 DOM 移动丢失，文档 tab 的状态已由
 *  调用前的 captureActiveTab 存好）；工具栏由 body class 收起。 */
function showSubmitView(): void {
  document.body.classList.add('submit-view')
  // 从源码模式标签页直接切来时兜底退出（幂等）：预览的 setMarkdown
  // 必须写向编辑器而不是源码 textarea。
  exitSourceMode()
  submitPreviewEl().appendChild(editorEl())
  updateSubmitPreview()
  submitPanelEl().hidden = false
}

/** 离开提交页：收回表单视图，把 #editor 移回 body 原位（#source-editor
 *  之前）。幂等——文档标签页之间的切换调用它没有副作用；目标标签页的
 *  文档内容由 activateTab 的 restore/setMarkdown 随后接管。 */
function hideSubmitView(): void {
  document.body.classList.remove('submit-view')
  submitPanelEl().hidden = true
  if (editorEl().parentElement === submitPreviewEl()) {
    sourceEl().before(editorEl())
  }
  exitSourceMode()
}

/** 两个输入框的内容 → 左侧预览，中间用水平分界线（markdown 的 `---`）分隔。
 *  前后空行确保 `---` 被解析为 thematic break 而不是 setext 标题下划线。
 *  flushHistory=true：预览刷新不进 undo 栈。 */
function updateSubmitPreview(): void {
  const primary = submitInputEl().value
  const secondary = submitInputSecondaryEl().value
  const parts = [primary.trim(), secondary.trim()].filter((text) => text.length > 0)
  if (parts.length === 2) {
    setMarkdown(`${primary}\n\n---\n\n${secondary}`, true)
  } else if (parts.length === 1) {
    setMarkdown(parts[0], true)
  } else {
    setMarkdown('', true)
  }
}

// 同一时刻只保留一个提交页（与「同一文件不重复开标签页」同一思路）：
// 已存在就聚焦它，否则新建一个。
async function openSubmitTab(): Promise<void> {
  const existing = tabs.find((tab) => tab.kind === 'submit')
  if (existing) {
    await activateTab(existing.id)
    return
  }
  const previous = activeTab()
  captureActiveTab()
  if (!await saveTabForLeaving(previous)) return
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    kind: 'submit',
    filePath: null,
    pdfTab: false,
    pdfPath: null,
    imageTab: false,
    imagePath: null,
    tool: null,
    toolPath: null,
    dirty: false,
    revision: documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    editorState: null,
    diskContent: null,
    scrollTop: 0
  }
  tabs.push(tab)
  activeTabId = tab.id
  currentFilePath = null
  // 与未命名文档标签页同一规则：窗口停止指向上一个文档（watcher、标题、最近列表）
  await window.electronAPI.activateFile(null)
  reportActiveSource(null)
  // PDF 对照面板不属于提交页：连同格式一起收回普通编辑面。
  leavePdfTabChrome()
  leaveImageTab()
  showSubmitView()
  document.title = isChinese() ? '提交' : 'Submit'
  renderTabBar()
  // 表单页存在的意义就是输入，焦点直接落到输入框
  submitInputEl().focus()
}

// ─── PDF 对照标签页 ────────────────────────────────────────────────────
// 菜单「文件 → PDF转md」：在窗口里开一个挂着对照面板的文档标签页（左 PDF /
// 右编辑器）。它就是一个普通文档标签 —— 解析结果 full.md 填进来后照样能改、能
// 保存、能标脏 —— 只是额外记住一份源文件路径。窗口里最多一个（已存在就聚焦）。
async function openPdfTab(): Promise<void> {
  const existing = tabs.find((tab) => tab.pdfTab)
  if (existing) {
    await activateTab(existing.id)
    return
  }
  const previous = activeTab()
  captureActiveTab()
  if (!await saveTabForLeaving(previous)) return
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    kind: 'document',
    filePath: null,
    pdfTab: true,
    pdfPath: null,
    imageTab: false,
    imagePath: null,
    tool: null,
    toolPath: null,
    dirty: false,
    revision: ++documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    editorState: null,
    diskContent: null,
    scrollTop: 0
  }
  tabs.push(tab)
  activeTabId = tab.id
  currentFilePath = null
  hideSubmitView()
  hideCanvasDocView()
  leaveImageTab()
  await window.electronAPI.activateFile(null)
  reportActiveSource(null)
  showBlankDocument()
  enterPdfTabChrome()
  updatePanelVisibility()
  renderTabBar()
  // 还没选源文件：面板摆出空态，由里面的「打开 PDF…」把人送去选文件。
  void loadPdfTab(null)
  focusEditor()
}

// ─── 图片转md 标签页 ────────────────────────────────────────────────────
// 菜单「文件 → 图片转md」：开一个左图片预览 / 右编辑器的文档标签页，与上面的
// PDF 对照同一个套路（转换结果填进右边后照样能改、能保存）。窗口里最多一个
//（已存在就聚焦），图片由标签页里的「选择图片…」按钮选。
async function openImageTab(): Promise<void> {
  const existing = tabs.find((tab) => tab.imageTab)
  if (existing) {
    await activateTab(existing.id)
    return
  }
  const previous = activeTab()
  captureActiveTab()
  if (!await saveTabForLeaving(previous)) return
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    kind: 'document',
    filePath: null,
    pdfTab: false,
    pdfPath: null,
    imageTab: true,
    imagePath: null,
    tool: null,
    toolPath: null,
    dirty: false,
    revision: ++documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    editorState: null,
    diskContent: null,
    scrollTop: 0
  }
  tabs.push(tab)
  activeTabId = tab.id
  currentFilePath = null
  hideSubmitView()
  hideCanvasDocView()
  leavePdfTabChrome()
  await window.electronAPI.activateFile(null)
  reportActiveSource(null)
  showBlankDocument()
  enterImageTabChrome()
  // 与 activateTab 同一个理由：这个视图没有 JSON 面，格式一律归位到 Markdown。
  setDocFormat('markdown')
  updatePanelVisibility()
  renderTabBar()
  // 还没选图片：面板摆出空态，由里面的「选择图片…」把人送去选文件。
  void loadImageTab(null)
  focusEditor()
}

// ─── 工具箱标签页 ───────────────────────────────────────────────────────
// 菜单「帮助 → 工具箱」：开一个整页工具界面的标签页（目前只有 PDF拆分）。
// 与上面两种对照页不同，它不是文档编辑器 —— 编辑面整块藏起来（body.tool-view），
// 也不进保存 / 脏标记体系（没有 Markdown 可存）。窗口里最多一个，已存在就聚焦。
function openToolTab(tool: ToolId): void {
  const existing = tabs.find((tab) => tab.tool)
  if (existing) {
    // 已经是同一个工具就直接切过去；换成别的工具时把工具换掉（目前只有一个工具，
    // 这条分支先留着，免得以后加工具时忘了换）。
    existing.tool = tool
    void activateTab(existing.id)
    return
  }
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    kind: 'document',
    filePath: null,
    pdfTab: false,
    pdfPath: null,
    imageTab: false,
    imagePath: null,
    tool,
    toolPath: null,
    dirty: false,
    revision: ++documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    editorState: null,
    diskContent: null,
    scrollTop: 0
  }
  tabs.push(tab)
  activeTabId = tab.id
  currentFilePath = null
  // 编辑面归位：提交表单 / 类docx / PDF 对照 / 图片转md 都不属于这个标签页。
  hideSubmitView()
  hideCanvasDocView()
  leavePdfTabChrome()
  leaveImageTab()
  // 与未命名文档标签页同一规则：窗口停止指向上一个文档（watcher、标题、最近列表）
  void window.electronAPI.activateFile(null)
  reportActiveSource(null)
  showBlankDocument()
  enterToolTabChrome()
  updatePanelVisibility()
  renderTabBar()
  // 还没选文件：工具页摆出空态，由里面的「选择 PDF…」把人送去选文件。
  void loadToolTab(null)
}

// ─── 类 docx 文档标签页 ────────────────────────────────────────────────
// 菜单「文件 → 新建类docx文档」：开一个 canvas-editor 标签页（画布排版、
// 分页的类 Word 文档）。它与提交页同一层级 —— 不是 Markdown 编辑器视图，
// 不接管 #editor，也不进保存/脏标记体系；每次点击都新建一份（菜单说的
// 就是「新建」），实例随标签页关闭而销毁（见 closeTab）。
/**
 * 开一个类 docx 文档标签页。init 可选：给工具栏的导入用 —— 建好画布实例后
 * 立刻执行（把 docx / markdown 的内容塞进这个新标签页），不动当前文档。
 */
async function openCanvasDocTab(init?: CanvasDocInit): Promise<void> {
  const previous = activeTab()
  captureActiveTab()
  if (!await saveTabForLeaving(previous)) return
  const tab: DocumentTab = {
    id: `tab-${nextTabId++}`,
    kind: 'canvas',
    filePath: null,
    pdfTab: false,
    pdfPath: null,
    imageTab: false,
    imagePath: null,
    tool: null,
    toolPath: null,
    dirty: false,
    revision: documentRevision,
    sourceMode: false,
    sourceText: '',
    content: '',
    editorState: null,
    diskContent: null,
    scrollTop: 0
  }
  tabs.push(tab)
  activeTabId = tab.id
  currentFilePath = null
  // 编辑面归位：提交表单与 PDF 对照面板都不属于这个标签页。
  hideSubmitView()
  leavePdfTabChrome()
  leaveImageTab()
  // 与未命名文档标签页同一规则：窗口停止指向上一个文档（watcher、标题、最近列表）
  await window.electronAPI.activateFile(null)
  reportActiveSource(null)
  showCanvasDocView(tab.id, init)
  document.title = canvasDocWindowTitle()
  renderTabBar()
}

// 提交动作：当前没有远端提交目标，先做本地反馈（记录 + 界面提示），
// 后续接接口时替换这一处即可。
function bindSubmitPanel(): void {
  const feedback = submitFeedbackEl()
  const submitValue = (): void => {
    const value = [submitInputEl().value.trim(), submitInputSecondaryEl().value.trim()]
      .filter((text) => text.length > 0)
      .join('\n\n')
    if (!value) {
      feedback.textContent = isChinese() ? '请输入内容' : 'Nothing to submit'
      return
    }
    console.log('[submit]', value)
    feedback.textContent = isChinese() ? `已提交：${value}` : `Submitted: ${value}`
    submitInputEl().value = ''
    submitInputSecondaryEl().value = ''
    updateSubmitPreview()
  }
  // 多行输入：普通 Enter 换行，Ctrl/Cmd+Enter 提交
  const submitOnCtrlEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      submitValue()
    }
  }
  submitBtnEl().addEventListener('click', submitValue)
  submitInputEl().addEventListener('keydown', submitOnCtrlEnter)
  submitInputSecondaryEl().addEventListener('keydown', submitOnCtrlEnter)
  // 两个输入框的内容都实时刷新预览（300ms 防抖：连续敲键不做逐键重建）
  let previewTimer: ReturnType<typeof setTimeout> | null = null
  const schedulePreview = (): void => {
    if (previewTimer) clearTimeout(previewTimer)
    previewTimer = setTimeout(updateSubmitPreview, 300)
  }
  submitInputEl().addEventListener('input', schedulePreview)
  submitInputSecondaryEl().addEventListener('input', schedulePreview)
}

async function activateTab(id: string): Promise<void> {
  if (switchingTab || id === activeTabId) return
  const target = tabs.find((tab) => tab.id === id)
  if (!target) return
  const previous = activeTab()
  captureActiveTab()
  if (!await saveTabForLeaving(previous)) return
  switchingTab = true
  try {
    // 对照面板跟着标签页走：只有那个标签页才展开左 PDF / 右文档，切到别的
    // 标签页（含提交页）一律收起。切进来时只先换外壳 —— 渲染要等本分支末尾
    // 内容恢复完再做（填内容会清掉块锚点，先渲染就白装一遍）。
    if (target.pdfTab) enterPdfTabChrome()
    else leavePdfTabChrome()
    // 图片转md 面板同理：只有那个标签页才展开左图片 / 右文档。
    if (target.imageTab) {
      enterImageTabChrome()
      // 图片转md 没有 JSON 视图：从 PDF 对照切过来时格式可能还停在 JSON，
      // 那会让右边变成只读的 layout.json。
      setDocFormat('markdown')
    } else leaveImageTab()
    // 工具箱同理：只有工具标签页才把整页工具界面铺出来。
    if (target.tool) enterToolTabChrome()
    else leaveToolTab()
    // 主进程要知道前台这份标签页挂着哪个源文件：「另存为」的默认名按它取。
    reportActiveSource(target)
    // 提交表单标签页：不接管编辑器，只切换视图（编辑面由 CSS +
    // showSubmitView 整体隐藏），也无 dirty/大纲/字数可谈。
    if (target.kind === 'submit') {
      await window.electronAPI.activateFile(null)
      activeTabId = target.id
      currentFilePath = null
      hideCanvasDocView()
      showSubmitView()
      document.title = isChinese() ? '提交' : 'Submit'
      renderTabBar()
      submitInputEl().focus()
      return
    }
    // 工具箱标签页：同样不接管编辑器（编辑面由 CSS 的 body.tool-view 收起），
    // 只有工具页自己的那点状态要说：源文件按标签页记下的路径重新画。
    if (target.tool) {
      await window.electronAPI.activateFile(null)
      activeTabId = target.id
      currentFilePath = null
      hideSubmitView()
      hideCanvasDocView()
      document.title = toolTabLabel(target.tool)
      updatePanelVisibility()
      renderTabBar()
      void loadToolTab(target.toolPath)
      return
    }
    // 类 docx 文档标签页（canvas-editor）：与提交页同层级 —— 不接管编辑器，
    // 只切换视图，也无 dirty/大纲/字数可谈。
    if (target.kind === 'canvas') {
      await window.electronAPI.activateFile(null)
      activeTabId = target.id
      currentFilePath = null
      hideSubmitView()
      showCanvasDocView(target.id)
      document.title = canvasDocWindowTitle()
      renderTabBar()
      return
    }
    // 回到文档标签页：先收回提交页 / 类docx文档页，并恢复编辑面默认
    //（wysiwyg）可见性。目标若是源码模式，下方分支会重新 enterSourceMode。
    hideSubmitView()
    hideCanvasDocView()
    // Point the window at the incoming document first: this re-points the file
    // watcher, the title and the recent list, and reports whether the file
    // changed while this tab sat in the background. An untitled tab passes null
    // so the window stops pointing at the tab we are leaving.
    const disk = await window.electronAPI.activateFile(target.filePath)
    // This document may have been written in a different style than the one we
    // are leaving; restore its own serialiser style with its content.
    applyMarkdownStyle(detectMarkdownStyle(target.content))
    activeTabId = target.id
    currentFilePath = target.filePath
    documentRevision = target.revision
    dirty = false
    externalConflictPending = false
    const changedOnDisk = !!disk && target.diskContent !== null && disk.content !== target.diskContent
    if (changedOnDisk && !target.dirty) {
      target.diskContent = disk!.content
      setContent(disk!.content, true)
      clearDirty()
      clearSaveStatus()
    } else if (target.sourceMode) {
      enterSourceMode(target.sourceText, 0)
    } else if (target.editorState) {
      exitSourceMode()
      // Swapping in the tab's own editor state is not a user edit. Without this
      // guard the listener fires, the tab flips to 「已编辑」, and an autosave
      // rewrites the file the user never touched.
      applyingProgrammaticChange = true
      try {
        restoreEditorState(target.editorState)
      } finally {
        applyingProgrammaticChange = false
      }
    }
    // The tab's own unsaved state decides, never the swap itself.
    dirty = target.dirty
    reportDirty()
    if (dirty) {
      showSaveStatus('dirty')
      if (!changedOnDisk) scheduleAutosave()
    } else {
      clearSaveStatus()
    }
    updateWordCount()
    updateFileTitle()
    updatePanelVisibility()
    void refreshSiblings()
    scheduleOutlineUpdate()
    const restoreScroll = (): void => {
      if (target.sourceMode) sourceEl().scrollTop = target.scrollTop
      else editorEl().scrollTop = target.scrollTop
    }
    restoreScroll()
    requestAnimationFrame(restoreScroll)
    // 内容到位之后才渲染 PDF：锚点要装在这份正文上（setContent 会清锚点）。
    if (target.pdfTab) void loadPdfTab(target.pdfPath)
    // 图片转md 面板：切回来按标签页记下的那张图片重新显示（主进程读盘给 data URL）。
    if (target.imageTab) void loadImageTab(target.imagePath)
    renderTabBar()
    // 助手侧边栏的"上下文"跟着标签页走（新标签页＝另一份文档）
    refreshAssistantContext()
    if (changedOnDisk && target.dirty) raiseExternalConflict()
  } finally {
    switchingTab = false
  }
}

async function closeTab(id: string): Promise<void> {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const tab = tabs[index]
  if (tab.id === activeTabId) {
    captureActiveTab()
    if (!await saveTabForLeaving(tab)) return
  } else if (tab.dirty) {
    // A background tab is not the active document, so it is written straight to
    // its own path; an untitled one cannot be written without a dialog.
    if (tab.filePath) {
      const saved = await window.electronAPI.saveFile(tab.content, tab.filePath, false, false)
      if (!saved) return
      tab.dirty = false
    }
  }
  // 未命名标签页没有路径可写：弹「保存 / 丢弃 / 取消」。后台标签页先切到
  // 前台再问，保存动作才有可写的文档（取消时不会留在切换后的标签页——
  // 切换本身是零副作用的视图操作，内容与脏标记都已随 capture 落盘到记录）。
  if (tab.dirty && !tab.filePath) {
    if (tab.id !== activeTabId) await activateTab(tab.id)
    captureActiveTab()
    const choice = await askUnsavedChanges()
    if (choice === 'cancel') return
    if (choice === 'save' && !await saveCurrent()) return
  }
  tabs.splice(index, 1)
  // 类 docx 文档标签页：画布实例跟着标签页走，关掉即销毁（画布不复用）。
  releaseCanvasDocTab(tab.id)
  if (tabs.length === 0) {
    // The last tab closed: the window falls back to a single blank document and
    // the bar disappears with it.
    activeTabId = null
    await openNewTab()
    return
  }
  if (tab.id === activeTabId) {
    activeTabId = null
    await activateTab(tabs[Math.min(index, tabs.length - 1)].id)
  }
  // 关掉的正是挂着源文件的那个标签页时，主进程记的那份「当前源文件」要跟着走。
  reportActiveSource(activeTab() ?? null)
  renderTabBar()
}

// An untitled tab has nowhere to go on disk, so closing it asks first.
// 自绘模态框（原生 confirm 只有「确定/取消」两键，且沿用系统外观，无法与
// 设计稿一致）：版式对齐设计稿——标题 + 两行说明，底部左「保存 / 丢弃」、
// 右「取消」，主按钮实心蓝。返回用户的选择。
type UnsavedChoice = 'save' | 'discard' | 'cancel'

function askUnsavedChanges(): Promise<UnsavedChoice> {
  return new Promise((resolve) => {
    const zh = isChinese()

    const overlay = document.createElement('div')
    overlay.className = 'math-modal-overlay'

    const modal = document.createElement('div')
    modal.className = 'math-modal unsaved-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')

    const title = document.createElement('h3')
    title.textContent = zh ? '保存' : 'Save'

    const message = document.createElement('p')
    message.className = 'unsaved-modal-message'
    message.textContent = zh
      ? '是否保存更改？\n如果不保存，您的更改将会丢失。'
      : 'Save your changes?\nIf you don\'t save, they will be lost.'

    const footer = document.createElement('div')
    footer.className = 'unsaved-modal-footer'
    const left = document.createElement('div')
    left.className = 'unsaved-modal-actions'
    const right = document.createElement('div')
    right.className = 'unsaved-modal-actions'

    const finish = (choice: UnsavedChoice): void => {
      document.removeEventListener('keydown', onKeydown, true)
      overlay.remove()
      resolve(choice)
    }

    const makeBtn = (label: string, kind: 'primary' | 'secondary', choice: UnsavedChoice): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `unsaved-modal-btn ${kind}`
      btn.textContent = label
      btn.addEventListener('click', () => finish(choice))
      return btn
    }

    const saveBtn = makeBtn(zh ? '保存' : 'Save', 'primary', 'save')
    const discardBtn = makeBtn(zh ? '丢弃' : "Don't Save", 'secondary', 'discard')
    const cancelBtn = makeBtn(zh ? '取消' : 'Cancel', 'secondary', 'cancel')

    // Esc 等同取消；Enter 等同保存（主按钮）
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish('cancel')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        finish('save')
      }
    }
    document.addEventListener('keydown', onKeydown, true)

    // 点遮罩即取消；框内点击不穿透
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish('cancel')
    })

    left.append(saveBtn, discardBtn)
    right.append(cancelBtn)
    footer.append(left, right)
    modal.append(title, message, footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    saveBtn.focus()
  })
}

// Open a file in a tab of its own. Reuses a blank current tab, and never opens
// the same file twice: an already open document just gets focused.
async function openFileInNewTab(path: string): Promise<void> {
  const existing = tabs.find((tab) => tab.filePath === path)
  if (existing) {
    await activateTab(existing.id)
    return
  }
  const current = activeTab()
  if (current && !current.filePath && !current.dirty) {
    await window.electronAPI.openSibling(path)
    return
  }
  await openNewTab()
  // Claim the path before the 'file-opened' round-trip lands: a burst of
  // queued tab-opens would otherwise see this tab as still blank and reuse it
  // for the next file, overwriting the one just opened (#99).
  const claimed = activeTab()
  if (claimed) claimed.filePath = path
  await window.electronAPI.openSibling(path)
}

/**
 * 从类 docx 标签页打开一个 Markdown 文件（导出 md 之后用）。
 * 不能直接交给 openFileInNewTab：它会复用「干净且未命名」的当前标签页，而
 * canvas 标签页正好符合这个条件 —— 结果文件内容被塞进隐藏的 #editor，界面上
 * 还停在画布，看起来像没反应。先开一个空白文档标签页再打开就对了。
 */
async function openMarkdownPathFromCanvas(path: string): Promise<void> {
  if (activeTab()?.kind === 'canvas') await openNewTab()
  await openFileInNewTab(path)
}

// Closing several tabs runs one at a time: each close may need its own unsaved
// confirmation, and a cancelled one stops the rest.
async function closeTabsMatching(keep: (index: number) => boolean): Promise<void> {
  for (;;) {
    const index = tabs.findIndex((_tab, i) => keep(i))
    if (index < 0) return
    const before = tabs.length
    await closeTab(tabs[index].id)
    if (tabs.length === before) return
  }
}

function bindTabBar(api: import('../preload/index').ElectronAPI): void {
  // Tab-opens are serialized: each request awaits main (activateFile,
  // file-opened) before the next runs. Without this, a burst of queued opens
  // (multi-file launch, fast second-instance) interleaves and two documents
  // land in one tab (#99).
  let tabOpenQueue: Promise<void> = Promise.resolve()
  const enqueueTabOpen = (path: string): void => {
    tabOpenQueue = tabOpenQueue.then(() => openFileInNewTab(path)).catch(() => { /* next file still opens */ })
  }
  // Tabs are also created from the File menu / ⌘T and from the file list; the
  // strip's own plus is bound above, in renderTabBar.
  api.onMenuNewTab(() => { void openNewTab() })
  api.onMenuCloseTab(() => { if (activeTabId) void closeTab(activeTabId) })
  // 菜单「文件 → PDF转md」：在当前窗口开对照标签页（已存在就聚焦它）。
  api.onMenuPdfTab(() => { void openPdfTab() })
  // 菜单「文件 → 图片转md」：开图片转md 标签页（已存在就聚焦它）。
  api.onMenuImageTab(() => { void openImageTab() })
  // 菜单「帮助 → 工具箱」：开工具标签页（目前只有 PDF拆分，已存在就聚焦它）。
  api.onMenuToolboxTab(() => openToolTab('pdf-split'))
  api.onOpenInNewTab(enqueueTabOpen)
  const handleTabMenuAction = ({ action, tabId }: { action: string; tabId: string }) => {
    if (action === 'close') { void closeTab(tabId); return }
    if (action === 'close-others') { void closeTabsMatching((i) => tabs[i].id !== tabId); return }
    if (action === 'close-right') {
      void closeTabsMatching((i) => i > tabs.findIndex((tab) => tab.id === tabId))
    }
  }
  api.onTabMenuAction(handleTabMenuAction)
  // Chromium re-dispatches hover events after the DOM under the pointer changes,
  // with the same coordinates. Closing a tab rebuilds the strip, so the hint used
  // to re-arm itself under a pointer that never moved and looked like it refused
  // to go away (#90). A real hover always comes with new coordinates.
  let lastHoverPoint = ''
  tabBarEl().addEventListener('mouseover', (e) => {
    const point = `${e.clientX},${e.clientY}`
    if (point === lastHoverPoint) return
    lastHoverPoint = point
    const target = e.target as HTMLElement
    const entry = target.closest('.tab-entry') as HTMLElement | null
    if (entry) scheduleTip(entry, tabTipText(entry), 'below', TAB_TIP_DELAY)
    else hideTabTip()
  })
  tabBarEl().addEventListener('mouseleave', () => {
    // Leaving clears the gate: coming back to the same pixel is a real hover.
    lastHoverPoint = ''
    hideTabTip()
  })
  tabBarEl().addEventListener('contextmenu', (e) => {
    const entry = (e.target as HTMLElement).closest('.tab-entry') as HTMLElement | null
    const id = entry?.dataset.tabId
    if (!id) return
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    e.preventDefault()
    void api.showTabContextMenu({
      tabId: id,
      filePath: tabs[index].filePath,
      canCloseOthers: tabs.length > 1,
      canCloseRight: index < tabs.length - 1
    })
  })
  api.onFocusFile((path) => {
    const tab = tabs.find((candidate) => candidate.filePath === path)
    if (tab) void activateTab(tab.id)
  })
  tabBarEl().addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const entry = target.closest('.tab-entry') as HTMLElement | null
    const id = entry?.dataset.tabId
    if (!id) return
    if (target.closest('.tab-entry-close')) {
      void closeTab(id)
      return
    }
    void activateTab(id)
  })
  // Middle click closes, the browser convention; the bar stays free of a
  // permanent close affordance (design.md).
  tabBarEl().addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    const entry = (e.target as HTMLElement).closest('.tab-entry') as HTMLElement | null
    const id = entry?.dataset.tabId
    if (!id) return
    e.preventDefault()
    void closeTab(id)
  })
}

// Keep the active tab's record in step with a successful write, so switching
// back to it later can tell whether the file changed underneath us.
function noteTabSaved(content: string): void {
  const tab = activeTab()
  if (!tab) return
  tab.diskContent = content
  tab.filePath = currentFilePath
  tab.dirty = dirty
}

function setDirty(): void {
  documentRevision += 1
  dirty = true
  cachedMarkdown = null
  reportDirty()
  showSaveStatus('dirty')
  markActiveTabDirty()
  scheduleAutosave()
}

function clearDirty(): void {
  dirty = false
  clearAutosaveTimer()
  reportDirty()
  markActiveTabDirty()
}

// Invalidate any in-flight save captured from the previous document before
// replacing editor content from disk.
function resetDirty(): void {
  documentRevision += 1
  clearDirty()
  clearSaveStatus()
}

function enqueueSave(operation: () => Promise<string | null>): Promise<string | null> {
  const next = saveQueue.then(operation, operation)
  saveQueue = next.then(() => undefined, () => undefined)
  return next
}

function clearAutosaveTimer(): void {
  if (!autosaveTimer) return
  clearInterval(autosaveTimer)
  autosaveTimer = null
}

// 自动保存间隔（毫秒）：偏好设置「通用 → 自动保存间隔」的分钟数，0 = 不自动保存。
// 1–5 分钟，越界值夹取（历史配置里可能存过 60）。
function autoSaveIntervalMs(): number {
  const minutes = getPrefs<number>('general.autoSaveIntervalMinutes') ?? 0
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  return Math.min(5, Math.round(minutes)) * 60_000
}

// 有未保存修改时启动周期计时器（首次编辑时武装，保存成功即由 clearDirty 撤销）；
// 间隔为 0 时不启动——用户选择了「不自动保存」。
function scheduleAutosave(): void {
  if (!currentFilePath) return
  // Paused while an external-modification conflict is unresolved: the user
  // must decide between their version and the disk version first.
  if (externalConflictPending) return
  const every = autoSaveIntervalMs()
  if (every === 0) return
  if (autosaveTimer) return // 周期计时器已在跑，等到点统一保存
  autosaveTimer = setInterval(() => {
    // 间隔被改成 0（关掉自动保存）→ 撤掉计时器，不再写盘
    if (autoSaveIntervalMs() === 0) {
      clearAutosaveTimer()
      return
    }
    void runAutosave()
  }, every)
}

// 「离开时自动保存」：窗口失焦（切到别的应用 / 另一个窗口）时立即落盘。
function flushOnBlur(): void {
  if (getPrefs<boolean>('general.autoSaveOnBlur') !== true) return
  if (!dirty || !currentFilePath) return
  if (externalConflictPending) return
  void runAutosave()
}

async function runAutosave(): Promise<void> {
  if (!dirty || !currentFilePath) return
  if (externalConflictPending) return
  const revision = documentRevision
  const filePath = currentFilePath
  const content = getContent()
  // rebuildMenu=false: autosave must never rebuild the app menu (macOS IME)
  // autosave=true: the main process may refuse the write when the file changed
  // on disk since our last read or write, and ask the user instead.
  const path = await enqueueSave(() => window.electronAPI.saveFile(content, filePath, false, true))
  if (path && revision === documentRevision && currentFilePath === filePath) {
    currentFilePath = path
    clearDirty()
    noteTabSaved(content)
    showSaveStatus('saved')
  }
}

// 保存 / ⌘S / 顶部条「保存」：文档已经有落点就直接覆盖，中途任何改动都静默
// 落盘，不弹框也不问。只有未命名的文档才弹另存为；对话框停在哪儿由主进程统一
// 决定（工作目录 → D:\TeyooData → AppData），这里不掺和。
async function saveCurrent(saveAs = false): Promise<boolean> {
  // 提交页 / 类docx文档页没有 Markdown 文档可存：⌘S 在这里不该打开另存为
  // 去存上一个文档标签页的内容。
  const current = activeTab()
  if (current && current.kind !== 'document') return false
  const revision = documentRevision
  const content = getContent()
  const expectedPath = currentFilePath
  // '' states plainly that the active document is untitled, so a save can never
  // be written into a file the window happens to have open in another tab.
  const path = await enqueueSave(() => {
    if (saveAs) return window.electronAPI.saveFileAs(content, expectedPath ?? '')
    if (!expectedPath) return window.electronAPI.saveFileAs(content, '')
    return window.electronAPI.saveFile(content, expectedPath ?? '', true)
  })
  if (!path || currentFilePath !== expectedPath) return false

  currentFilePath = path
  updateFileTitle()
  refreshSiblings()
  noteTabSaved(content)
  if (path !== expectedPath) renderTabBar()
  if (revision === documentRevision) {
    clearDirty()
    showSaveStatus('saved')
    return true
  }
  if (dirty) scheduleAutosave()
  return false
}

function applyContent(content: string): void {
  // Reached only when the document identity changes (New file, loading a disk
  // version after an external conflict), so the undo stack must not survive.
  setContent(content, true)
}

// --- Document statistics (top-right hover indicator) ---
function countCharacters(content: string): number {
  return content.replace(/\s/g, '').length
}

function countTokens(content: string): number {
  const tokens = content.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[A-Za-z]+(?:['’\\-][A-Za-z]+)*|\d+(?:[.,]\d+)*/g)
  return tokens?.length ?? 0
}

function countParagraphs(content: string): number {
  const normalized = content.replace(/\r\n?/g, '\n').trim()
  return normalized ? normalized.split(/\n\s*\n+/).filter((block) => block.trim()).length : 0
}

// 偏好设置「外观 → 状态栏 → 显示状态栏」：关掉时标题栏右侧的文档统计按钮
// （窗口控制按钮往左数第 4 个）隐藏，统计计算一并跳过。
function statusBarEnabled(): boolean {
  return getPrefs<boolean>('appearance.showStatusBar') !== false
}

function updateWordCount(content?: string): void {
  const el = wordCountEl()
  const enabled = statusBarEnabled()
  el.hidden = !enabled
  if (!enabled) return
  const text = content ?? getContent()
  const tip = el.querySelector('.word-count-tip')
  if (!tip) return
  tip.textContent = isChinese()
    ? `${countCharacters(text)} 字 · ${countTokens(text)} 词 · ${countParagraphs(text)} 段`
    : `${countCharacters(text)} chars · ${countTokens(text)} words · ${countParagraphs(text)} paragraphs`
}

// --- Reveal the current file in the OS file manager ---
function fileLocationLabel(): string {
  if (isChinese()) {
    return fileManagerName === 'finder'
      ? '在 Finder 中显示'
      : fileManagerName === 'explorer'
        ? '在资源管理器中显示'
        : '打开所在文件夹'
  }
  return fileManagerName === 'finder'
    ? 'Reveal in Finder'
    : fileManagerName === 'explorer'
      ? 'Reveal in File Explorer'
      : 'Open Containing Folder'
}

// The titlebar is a window drag region, so the button cannot rely on
// `#titlebar:hover`. Its gate lives on the file title instead; this keeps the
// label and the disabled state in sync with the loaded document.
// --- Markdown source / WYSIWYG toggle ---
function updateSourceToggle(): void {
  const btn = sourceToggleBtnEl()
  btn.classList.toggle('active', sourceModeActive)
  const label = sourceModeActive
    ? (isChinese() ? '切换回所见即所得' : 'Switch to WYSIWYG')
    : (isChinese() ? '切换 Markdown 源码' : 'Switch to Markdown source')
  btn.setAttribute('aria-label', label)
  const tip = btn.querySelector('.toolbar-tip')
  if (tip) tip.textContent = label
}

function updateUiLanguage(): void {
  const zh = isChinese()
  document.documentElement.lang = zh ? 'zh-CN' : 'en'
  document.title = 'Teyoo'
  untitledName = zh ? '未命名' : 'Untitled'
  fileTabEl().textContent = zh ? '文件' : 'Files'
  outlineTabEl().textContent = zh ? '大纲' : 'Outline'
  fileToggleBtnEl().setAttribute('aria-label', zh ? '显示 / 隐藏文件列表' : 'Show / hide file list')
  sourceToggleBtnEl().setAttribute('aria-label', zh ? '切换 Markdown 源码 / 所见即所得' : 'Toggle Markdown source / WYSIWYG')
  const wordTip = wordCountEl().querySelector('.word-count-tip')
  if (wordTip) wordTip.textContent = zh ? '0 字 · 0 词 · 0 段' : '0 chars · 0 words · 0 paragraphs'
  updateSourceToggle()
  updateWordCount()
}
function scrollRatio(el: HTMLElement): number {
  const range = el.scrollHeight - el.clientHeight
  return range > 0 ? el.scrollTop / range : 0
}

function restoreScrollRatio(el: HTMLElement, ratio: number): void {
  requestAnimationFrame(() => {
    const range = el.scrollHeight - el.clientHeight
    el.scrollTop = Math.max(0, Math.min(range, range * ratio))
  })
}

function toggleSourceMode(): void {
  // 提交页 / 类docx文档页没有 Markdown 可切换（编辑器已整体隐藏），按钮与快捷键都不响应
  const tab = activeTab()
  if (tab && tab.kind !== 'document') return
  if (sourceModeActive) {
    // Source → WYSIWYG: 如果 textarea 内容自进入 Source 模式后未修改，跳过解析
    const currentText = sourceEl().value
    if (sourceEnterText !== null && currentText === sourceEnterText) {
      const ratio = scrollRatio(sourceEl())
      setCurrentImageFilePath(currentFilePath)
      exitSourceMode()
      restoreScrollRatio(editorEl(), ratio)
    } else {
      // textarea 内容已修改，需要重新解析
      const ratio = scrollRatio(sourceEl())
      setCurrentImageFilePath(currentFilePath)
      exitSourceMode()
      setMarkdownProgrammatically(unfoldBase64(currentText))
      restoreScrollRatio(editorEl(), ratio)
    }
  } else {
    // WYSIWYG → Source: 如果文档未修改且有缓存，跳过序列化
    let markdown: string
    if (!dirty && cachedMarkdown !== null) {
      markdown = cachedMarkdown
    } else {
      markdown = getMarkdown()
      cachedMarkdown = markdown
    }
    setCurrentImageFilePath(currentFilePath)
    enterSourceMode(markdown, scrollRatio(editorEl()))
    sourceEnterText = sourceEl().value
  }
  updateWordCount()
  scheduleOutlineUpdate()
}

function updatePanelVisibility(): void {
  // PDF 对照 / 图片转md 标签页没有文件面板：左边已经是源文件，右边就是要编辑的
  // 那一个文档。
  const show = !manualHidden && !activeTab()?.pdfTab && !activeTab()?.imageTab && !activeTab()?.tool
  filePanelEl().hidden = !show
  document.body.classList.toggle('show-file-panel', show)
  fileToggleBtnEl().classList.toggle('active', show)
  fileListEl().hidden = panelMode !== 'files'
  outlineListEl().hidden = panelMode !== 'outline'
  fileTabEl().classList.toggle('active', panelMode === 'files')
  fileTabEl().setAttribute('aria-selected', String(panelMode === 'files'))
  outlineTabEl().classList.toggle('active', panelMode === 'outline')
  outlineTabEl().setAttribute('aria-selected', String(panelMode === 'outline'))
}

function setPanelMode(mode: 'files' | 'outline'): void {
  panelMode = mode
  updatePanelVisibility()
  if (mode === 'outline') renderOutline()
}

interface OutlineItem {
  level: number
  title: string
  element?: HTMLElement
  line?: number
}

function sourceOutline(content: string): OutlineItem[] {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line)
    if (!match) return []
    const title = match[2].replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim()
    return title ? [{ level: match[1].length, title, line: index }] : []
  })
}

function visualOutline(): OutlineItem[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#editor .ProseMirror h1, #editor .ProseMirror h2, #editor .ProseMirror h3, #editor .ProseMirror h4, #editor .ProseMirror h5, #editor .ProseMirror h6'))
    .map((element) => ({ level: Number(element.tagName.slice(1)), title: element.textContent?.trim() ?? '', element }))
    .filter((item) => item.title)
}

function outlineVisible(): boolean {
  return !manualHidden && panelMode === 'outline'
}

function renderOutline(): void {
  // The outline is only ever read from the panel, which is hidden by default.
  // Rebuilding it on every keystroke (and on every scroll) burned a full DOM
  // teardown plus forced layout per frame for output nobody could see.
  if (!outlineVisible()) return
  const list = outlineListEl()
  outlineItems = sourceModeActive ? sourceOutline(sourceEl().value) : visualOutline()
  list.innerHTML = ''
  if (outlineItems.length === 0) {
    outlineActiveIndex = -1
    return
  }
  outlineItems.forEach((item, index) => {
    const entry = document.createElement('li')
    const button = document.createElement('button')
    button.dataset.headingIndex = String(index)
    button.type = 'button'
    button.textContent = item.title
    // Hover keeps truncated headings readable while the panel width stays
    // as-is in this change (#64).
    button.title = item.title
    button.style.paddingLeft = `${8 + (item.level - 1) * 12}px`
    button.addEventListener('click', () => {
      // Re-resolve the entry against the live DOM: cached element references
      // die when the editor content is re-set (#64).
      const current = (sourceModeActive ? sourceOutline(sourceEl().value) : visualOutline())[index]
      if (!current) return
      if (current.element) {
        // flashHeadingOnArrival signals the jump phase, which engages the
        // outline jump lock for visual-mode jumps.
        current.element.scrollIntoView({ behavior: 'smooth', block: 'start' })
        flashHeadingOnArrival(current.element)
      } else if (current.line !== undefined) {
        beginOutlineJump()
        const source = sourceEl()
        const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 24
        source.scrollTop = Math.max(0, current.line * lineHeight - lineHeight)
        source.focus()
        revealSourceHeading(source, current.line)
      }
      setActiveOutlineIndex(index)
    })
    entry.appendChild(button)
    list.appendChild(entry)
  })
  applyOutlineActive()
  scheduleOutlineActiveSync()
}

function applyOutlineActive(): void {
  const list = outlineListEl()
  const buttons = list.querySelectorAll<HTMLButtonElement>('button')
  buttons.forEach((button, index) => {
    button.classList.toggle('active', index === outlineActiveIndex)
  })
  // Keep the tracked section visible in long documents.
  const active = buttons[outlineActiveIndex]
  if (active) revealOutlineEntry(active)
}

// Manual reveal of the active entry inside the panel. scrollIntoView() must
// not be used here: it would also interrupt the smooth scroll of the content
// pane started by an outline click, so only the panel's own scroller moves.
function revealOutlineEntry(button: HTMLButtonElement): void {
  const panel = filePanelEl()
  const panelTop = panel.getBoundingClientRect().top
  const top = button.getBoundingClientRect().top - panelTop + panel.scrollTop
  const bottom = top + button.offsetHeight
  if (top < panel.scrollTop) {
    panel.scrollTop = top
  } else if (bottom > panel.scrollTop + panel.clientHeight) {
    panel.scrollTop = bottom - panel.clientHeight
  }
}

function beginOutlineJump(): void {
  outlineJumping = true
  if (outlineJumpTimer) clearTimeout(outlineJumpTimer)
  outlineJumpStartTop = (sourceModeActive ? sourceEl() : editorEl()).scrollTop
  // scrollend releases the lock earlier; this fallback exists for the
  // no-scroll case. Re-arming while the position keeps changing keeps long
  // smooth jumps locked for their whole duration (review on #68).
  outlineJumpTimer = setTimeout(releaseOutlineJumpIfSettled, 1500)
}

function releaseOutlineJumpIfSettled(): void {
  if (!outlineJumping) return
  const top = (sourceModeActive ? sourceEl() : editorEl()).scrollTop
  if (top !== outlineJumpStartTop) {
    outlineJumpStartTop = top
    outlineJumpTimer = setTimeout(releaseOutlineJumpIfSettled, 400)
    return
  }
  endOutlineJump()
}

function endOutlineJump(): void {
  if (!outlineJumping) return
  outlineJumping = false
  if (outlineJumpTimer) {
    clearTimeout(outlineJumpTimer)
    outlineJumpTimer = null
  }
  scheduleOutlineActiveSync()
}

function setActiveOutlineIndex(index: number): void {
  if (index === outlineActiveIndex) return
  outlineActiveIndex = index
  applyOutlineActive()
}

function scheduleOutlineActiveSync(): void {
  if (!outlineVisible()) return
  if (outlineJumping) return
  if (outlineSyncQueued) return
  outlineSyncQueued = true
  requestAnimationFrame(() => {
    outlineSyncQueued = false
    syncOutlineActive()
  })
}

// Scrollspy: highlight the outline entry for the section at the top of the
// viewport so the outline tracks reading progress (#64).
function syncOutlineActive(): void {
  if (outlineItems.length === 0) return
  setActiveOutlineIndex(sourceModeActive ? sourceActiveIndex() : visualActiveIndex())
}

function visualActiveIndex(): number {
  const container = editorEl()
  const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2
  if (atBottom) return outlineItems.length - 1
  const threshold = container.getBoundingClientRect().top + Math.min(96, container.clientHeight * 0.2)
  // Cached references are refreshed by renderOutline; the loop stops at the
  // first heading below the viewport top, so steady-state scrolling only
  // touches the entries it activates. Fall back to a live query when a cached
  // node went missing (content re-set mid-frame) — a detached node must never
  // win the race (#64).
  const items = outlineItems.some((item) => !item.element?.isConnected) ? visualOutline() : outlineItems
  let index = -1
  for (let i = 0; i < items.length; i += 1) {
    const element = items[i].element
    if (!element || !element.isConnected) continue
    if (element.getBoundingClientRect().top > threshold) break
    index = i
  }
  return index
}

function sourceActiveIndex(): number {
  const source = sourceEl()
  const lineHeight = Number.parseFloat(getComputedStyle(source).lineHeight) || 24
  const firstLine = Math.round(source.scrollTop / lineHeight)
  let index = -1
  for (let i = 0; i < outlineItems.length; i += 1) {
    if ((outlineItems[i].line ?? 0) > firstLine + 1) break
    index = i
  }
  return index
}

// Source mode cannot render a heading band; selecting the heading line gives
// the same "you have arrived" feedback as the visual flash (#64).
function revealSourceHeading(source: HTMLTextAreaElement, line: number): void {
  let start = 0
  for (let i = 0; i < line; i += 1) {
    const next = source.value.indexOf('\n', start)
    if (next === -1) {
      start = source.value.length
      break
    }
    start = next + 1
  }
  const end = source.value.indexOf('\n', start)
  source.setSelectionRange(start, end === -1 ? source.value.length : end)
}

function scheduleOutlineUpdate(): void {
  if (!outlineVisible()) return
  if (outlineUpdateQueued) return
  outlineUpdateQueued = true
  requestAnimationFrame(() => {
    outlineUpdateQueued = false
    renderOutline()
  })
}

// 偏好设置「外观 → 侧边栏 → 允许折叠和展开侧边栏的大纲视图」：
// 未勾选时禁用「显示 / 隐藏文件列表」按钮（含 ⌘\ 与菜单项），默认禁止。
function filePanelToggleEnabled(): boolean {
  return getPrefs<boolean>('appearance.allowCollapseOutline') === true
}

function updateFileToggleButton(): void {
  const btn = fileToggleBtnEl()
  const enabled = filePanelToggleEnabled()
  btn.disabled = !enabled
  btn.setAttribute('aria-disabled', String(!enabled))
  btn.title = enabled
    ? (isChinese() ? '显示 / 隐藏文件列表 (⌘\\)' : 'Show / hide file list (⌘\\)')
    : (isChinese() ? '已在偏好设置中禁用：外观 → 侧边栏' : 'Disabled in Preferences: Appearance → Sidebar')
}

function togglePanel(): void {
  if (!filePanelToggleEnabled()) return
  manualHidden = !manualHidden
  localStorage.setItem('file-panel-hidden', manualHidden ? '1' : '0')
  updatePanelVisibility()
}

// Drag the panel's right edge to resize it; the width clamps to the
// FILE_PANEL_* range and persists on release. Pointer capture keeps the drag
// alive over iframes and selected text.
function initPanelResize(): void {
  const resizer = document.getElementById('panel-resizer') as HTMLDivElement | null
  if (!resizer) return
  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    resizer.setPointerCapture(event.pointerId)
    resizer.classList.add('dragging')
    document.body.classList.add('panel-resizing')
    let width = FILE_PANEL_DEFAULT_WIDTH
    const move = (moveEvent: PointerEvent) => {
      // The panel hangs off the left edge, so the pointer's distance from the
      // window's left edge is the width.
      width = clampFilePanelWidth(moveEvent.clientX)
      applyFilePanelWidth(width)
    }
    const finish = () => {
      resizer.removeEventListener('pointermove', move)
      resizer.removeEventListener('pointerup', finish)
      resizer.removeEventListener('pointercancel', finish)
      resizer.classList.remove('dragging')
      document.body.classList.remove('panel-resizing')
      localStorage.setItem('file-panel-width', String(width))
    }
    resizer.addEventListener('pointermove', move)
    resizer.addEventListener('pointerup', finish)
    resizer.addEventListener('pointercancel', finish)
  })
}

function updateFileTitle(): void {
  // The filename is shown by the tab; the window title is the only place left
  // that needs it spelled out (there is no centred title in the title bar).
  const name = currentFilePath ? (currentFilePath.split(/[\\/]/).pop() || currentFilePath) : (isChinese() ? '未命名' : 'Untitled')
  document.title = name
}

// --- File panel: one root, expanded downward ---
// The root is the open document's directory and `..` stays the one way back
// up; a directory is read only when it is expanded, so a deep tree costs
// nothing until the reader asks for it. Expansion lives in memory only — no
// workspace, nothing restored on the next launch.
const PANEL_INDENT = 12
let panelRoot: import('../preload/index').SiblingFile[] = []
const panelChildren = new Map<string, import('../preload/index').SiblingFile[]>()
const panelExpanded = new Set<string>()
const panelLoading = new Set<string>()

type PanelRow = {
  file: import('../preload/index').SiblingFile
  depth: number
  expandable: boolean
  expanded: boolean
  empty: boolean
}

// Flatten the expanded tree into visible rows. Rendering stays a flat list, so
// hover, active state and hit-testing keep working the way they always have.
function panelRows(): PanelRow[] {
  const rows: PanelRow[] = []
  const walk = (entries: import('../preload/index').SiblingFile[], depth: number): void => {
    for (const file of entries) {
      const expanded = file.kind === 'directory' && panelExpanded.has(file.path)
      rows.push({ file, depth, expandable: file.kind === 'directory', expanded, empty: false })
      if (!expanded) continue
      const children = panelChildren.get(file.path)
      if (!children) {
        void loadPanelDirectory(file.path)
        continue
      }
      if (children.length === 0) rows.push({ file, depth: depth + 1, expandable: false, expanded: false, empty: true })
      else walk(children, depth + 1)
    }
  }
  walk(panelRoot, 0)
  return rows
}

function loadPanelDirectory(dir: string): void {
  if (panelLoading.has(dir)) return
  panelLoading.add(dir)
  void window.electronAPI.listDirectory(dir).then((children) => {
    panelLoading.delete(dir)
    if (!children) return
    panelChildren.set(dir, children)
    renderFileList(panelRoot)
  })
}

function togglePanelDirectory(dir: string): void {
  if (panelExpanded.has(dir)) panelExpanded.delete(dir)
  else {
    panelExpanded.add(dir)
    loadPanelDirectory(dir)
  }
  renderFileList(panelRoot)
}

function renderFileList(files: import('../preload/index').SiblingFile[]): void {
  panelRoot = files
  hideTip()
  const list = fileListEl()
  list.innerHTML = ''
  for (const row of panelRows()) {
    const li = document.createElement('li')
    const indent = 8 + row.depth * PANEL_INDENT
    if (row.empty) {
      const empty = document.createElement('div')
      empty.className = 'file-empty'
      empty.style.paddingLeft = `${indent}px`
      empty.textContent = isChinese() ? '这个文件夹是空的' : 'This folder is empty'
      li.appendChild(empty)
      list.appendChild(li)
      continue
    }
    const f = row.file
    const btn = document.createElement('button')
    btn.style.paddingLeft = `${indent}px`
    const chevron = document.createElement('span')
    chevron.className = `file-entry-chevron${row.expanded ? ' expanded' : ''}${f.kind === 'parent' ? ' back' : ''}`
    chevron.setAttribute('aria-hidden', 'true')
    // Same 10-unit box and stroke as the expander chevrons: drawing the way back
    // in a 16-unit box scaled into the same 10px slot made it smaller and its
    // stroke lighter, so the two arrows read as different controls (2026-09-15).
    if (f.kind === 'parent') chevron.innerHTML = '<svg viewBox="0 0 10 10"><path d="M8.5 5H2M4.5 2.5 2 5l2.5 2.5"/></svg>'
    else if (row.expandable) chevron.innerHTML = '<svg viewBox="0 0 10 10"><path d="M3.5 1.5 7 5l-3.5 3.5"/></svg>'
    const icon = document.createElement('span')
    icon.className = `file-entry-icon ${f.kind}`
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = f.kind === 'directory'
      ? '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.5 1.5h6v6.5h-11.5z"/><path d="M2.5 4.5v-1h4l1.5 1.5"/></svg>'
      : '<svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>'
    const label = document.createElement('span')
    label.className = 'file-entry-name'
    // Words, not two dots: the row has the space and ".." never said where it goes.
    label.textContent = f.kind === 'parent' ? (isChinese() ? '返回' : 'Back') : f.name
    btn.addEventListener('mouseenter', () => {
      // Only a name that is actually cut off is worth a label; one that fits
      // says itself. No marquee: sliding the name under the icon to read it
      // covers the row it belongs to.
      if (label.scrollWidth <= label.clientWidth + 1) return
      scheduleTip(btn, label.textContent ?? '', 'right', ROW_TIP_DELAY)
    })
    btn.addEventListener('mouseleave', hideTip)
    btn.title = f.kind === 'directory'
      ? (isChinese()
          ? `${row.expanded ? '收起' : '展开'} ${f.name}`
          : `${row.expanded ? 'Collapse' : 'Expand'} ${f.name}`)
      : f.kind === 'parent' ? (isChinese() ? '返回上级目录' : 'Go to parent directory') : f.name
    btn.dataset.path = f.path
    btn.dataset.kind = f.kind
    btn.classList.toggle('directory', f.kind === 'directory')
    btn.classList.toggle('parent', f.kind === 'parent')
    if (f.path === currentFilePath) btn.classList.add('active')
    // The way back sits in the expander's column and its name takes the icon's,
    // so the row reads left to right like every other one instead of hanging a
    // column in. It has no icon of its own, which is why no slot is skipped.
    if (f.kind === 'parent') btn.append(chevron, label)
    else btn.append(chevron, icon, label)
    li.appendChild(btn)
    list.appendChild(li)
  }
}

async function refreshSiblings(): Promise<void> {
  const files = await window.electronAPI.listSiblings()
  if (files) renderFileList(files)
}

// ─── 源码模式 base64 图片折叠 ───────────────────────────────────────────────
// 源码 textarea 中 data:image/...;base64,xxxx 可能长达数万字符，淹没正文。
// 显示时替换为 [(data:image/png;base64,iVBORw0KGgoAAAANSUhEUg ...] 形式的短占位符
// （保留完整 data 头 + 前 24 个 base64 字符 + 空格省略号），完整字符串保存在映射表中；
// 所有数据出口（getContent 保存/导出、切回所见即所得）先还原，保证数据无损。
// 用户若手动删除/改写占位符，则该图无法还原（与手动改坏图片链接同理）。

const base64FoldMap = new Map<string, string>()
const BASE64_FOLD_THRESHOLD = 200
// 省略号前保留的 base64 字符数（20+，用户要求）
const BASE64_PREVIEW_LEN = 24

// 匹配 data URI（base64 图片典型字符集，不含 ) " ' 空白，避免越过 markdown/HTML 边界）
const RE_DATA_URI = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)(;[a-zA-Z0-9.+=;-]*)?;base64,[A-Za-z0-9+/=]+/g
// 折叠占位符：[(data:<mime>;base64,<24字符> ...]
const RE_FOLDED_PLACEHOLDER = /\[\(data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9.+=;-]*)?;base64,[A-Za-z0-9+/=]+ \.\.\.\]/g

// 折叠结果缓存：模式切换时如果 Markdown 未变（dirty=false 走 cachedMarkdown），
// foldBase64 输入相同 → 直接返回上次折叠结果，跳过全文正则扫描。
// 对于含多张大 base64 图片的文档，这个正则扫描是主要瓶颈之一。
let foldBase64Cache: { input: string; output: string } | null = null

function foldBase64(markdown: string): string {
  if (foldBase64Cache && foldBase64Cache.input.length === markdown.length) {
    // 长度相同再比较内容（V8 对等长字符串逐字符比较，仍远快于全文正则）
    if (foldBase64Cache.input === markdown) {
      return foldBase64Cache.output
    }
  }
  const output = markdown.replace(RE_DATA_URI, (uri, mime: string, params?: string) => {
    if (uri.length <= BASE64_FOLD_THRESHOLD) return uri
    const header = `data:${mime}${params ?? ''};base64,`
    const data = uri.slice(header.length)
    // 两张图前 24 字符恰好相同时（如同格式截图头部），逐步加长预览直到占位符唯一
    let previewLen = BASE64_PREVIEW_LEN
    let placeholder = ''
    while (previewLen < data.length) {
      placeholder = `[(${header}${data.slice(0, previewLen)} ...]`
      const existing = base64FoldMap.get(placeholder)
      if (existing === undefined || existing === uri) break
      previewLen += BASE64_PREVIEW_LEN
    }
    base64FoldMap.set(placeholder, uri)
    return placeholder
  })
  foldBase64Cache = { input: markdown, output }
  return output
}

function unfoldBase64(text: string): string {
  return text.replace(RE_FOLDED_PLACEHOLDER, (placeholder) => base64FoldMap.get(placeholder) ?? placeholder)
}

// ─── Typora 式顶部菜单栏 ───────────────────────────────────────────────────
// 一级标签在标题栏横向排开；点击标签时在其正下方弹出对应的原生菜单（main 进程
// 负责），所以二级菜单的快捷键、勾选态、最近文件/主题等动态内容全部复用原生实现。
// 仅 Windows 启用（与旧汉堡按钮的平台范围一致）；macOS 用系统菜单栏。
let menubarOpen = false

async function setupMenubar(): Promise<void> {
  const bar = document.getElementById('app-menubar')
  if (!bar || !/Windows/i.test(navigator.userAgent)) return
  bar.removeAttribute('hidden')

  const setActive = (btn: Element | null): void => {
    for (const el of bar.querySelectorAll('.menubar-item')) {
      el.classList.toggle('active', el === btn)
    }
  }

  const refreshLabels = async (): Promise<void> => {
    const labels = await window.electronAPI.getMenubarLabels()
    for (const btn of bar.querySelectorAll<HTMLElement>('.menubar-item')) {
      const text = labels[btn.dataset.menu ?? '']
      if (text) btn.textContent = text
    }
  }
  await refreshLabels()
  window.electronAPI.onMenubarLabelsChanged(() => { void refreshLabels() })
  // 原生菜单关闭（选择条目/Esc/点击外部）后取消标签高亮
  window.electronAPI.onMenubarClosed(() => {
    menubarOpen = false
    setActive(null)
  })

  const popupAt = (btn: HTMLElement): void => {
    const key = btn.dataset.menu
    if (!key) return
    const rect = btn.getBoundingClientRect()
    // 只传视口内坐标（DIP）；主进程用窗口内容区 getContentBounds() 换算
    // 屏幕坐标。切勿在此加 window.screenX/Y——那是窗口外框坐标，非最大化
    // 窗口会因 Windows 不可见调整边框产生偏移，导致菜单错位。
    window.electronAPI.popupMenubar(
      key,
      Math.round(rect.left),
      Math.round(rect.bottom),
    )
  }

  // 与工具栏按钮同一手法：按下时不把焦点给菜单栏按钮，编辑器继续持有光标。
  // 否则点击标签后 ProseMirror 失焦，菜单里的格式命令会被 hasFocus() 门控拦掉。
  bar.addEventListener('mousedown', (e) => {
    if (!(e.target as HTMLElement).closest('.menubar-item')) return
    e.preventDefault()
  })

  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.menubar-item')
    if (!btn) return
    menubarOpen = true
    setActive(btn)
    popupAt(btn)
  })

  // 菜单弹出期间悬停到其他标签即切换菜单（平台在菜单模态循环中仍派发指针
  // 事件时生效；不生效也无副作用——再点一次即可）
  bar.addEventListener('mouseover', (e) => {
    if (!menubarOpen) return
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.menubar-item')
    if (!btn || btn.classList.contains('active')) return
    setActive(btn)
    popupAt(btn)
  })
}

// 原生菜单弹出再关闭后，编辑器常常已经失焦（焦点落在菜单栏按钮或窗口上），
// 而格式命令由 view.hasFocus() 门控（防止误写进隐藏文档/搜索面板）。这里在
// 「焦点不在任何输入控件」的前提下把光标还给编辑器，菜单项才能真正生效。
function restoreEditorFocusForMenu(): void {
  if (sourceModeActive) return
  if (document.body.classList.contains('submit-view')) return
  const active = document.activeElement as HTMLElement | null
  if (active) {
    const isField = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable
    // 正在别处输入（搜索框、弹窗表单）→ 不抢焦点，命令照旧被门控拦下
    if (isField && !active.closest('#editor')) return
  }
  focusEditor()
}

function enterSourceMode(content: string, ratio = 0): void {
  sourceModeActive = true
  editorEl().classList.add('hidden')
  const ta = sourceEl()
  ta.classList.add('visible')
  ta.value = foldBase64(content)
  restoreScrollRatio(ta, ratio)
  updateSourceToggle()
  // 源码模式下没有 ProseMirror 文档可改，助手这一轮不可用（说明同步刷新）
  refreshAssistantContext()
}

function exitSourceMode(): void {
  sourceModeActive = false
  editorEl().classList.remove('hidden')
  sourceEl().classList.remove('visible')
  updateSourceToggle()
  refreshAssistantContext()
}

// 右侧栏顶部条的 Markdown / JSON 切换：编辑面的显示交给 CSS 的 body.doc-json，
// 工具栏留在原位但整条置灰并禁用 —— 格式按钮对 JSON 没有意义，收起来反倒像是
// 换了个界面；禁用控件既不派发点击，也不再弹悬停提示。
function setDocFormat(format: DocFormat): void {
  const jsonMode = format === 'json'
  document.body.classList.toggle('doc-json', jsonMode)
  // 源码模式会把工具栏收起（--toolbar-height 归零，且那条 :has 规则优先级更高），
  // 两者叠在一起会让工具栏按源码模式算高度却仍显示出来 —— 互斥。
  if (jsonMode && sourceModeActive) exitSourceMode()
  setToolbarEnabled(!jsonMode)
  // 两侧各是各的内容：Markdown 就是编辑器里的文档（来自 full.md），JSON 就是
  // 中间结果那份文件 —— 切换只换视图，不再做 JSON → Markdown 的转换。
  // JSON 面板此前是 display:none，量不到可视高度：切过来才重新量并画第一屏。
  if (jsonMode) refreshJsonLayout()
}

function isAbsoluteLike(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/')
}

/** (baseKey, imagePath) → 读图任务：同一张图在同一份文档里只读一次磁盘。 */
const layoutImageTasks = new Map<string, Promise<string | null>>()

function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '')
}

/** 本地绝对路径 → file:// URL（Windows 盘符前要三道斜杠，否则解析成主机名为 D:）。 */
function absoluteToFileUrl(absolutePath: string): string {
  const flat = absolutePath.replace(/\\/g, '/')
  return /^[a-zA-Z]:\//.test(flat) ? `file:///${flat}` : `file://${flat}`
}

/** 最近一次读进编辑器的 full.md 所在目录（见 applyMarkdownFile）。 */
let markdownImageDir: string | null = null

/**
 * 图片的基准目录，按谁更可能是图片真正所在处排序：
 *   1. 最近那份 Markdown 的目录 —— 结果包解压出来就是这种形状：full.md 与
 *      images/ 同级，跟 PDF 在哪、有没有 layout.json 都无关；
 *   2. 打开的是谁就先认谁的目录 —— 手动「打开 JSON…」认 JSON 目录，PDF 旁边
 *      带出来的 JSON 认 PDF 目录；
 *   3. 程序默认目录 D:\TeyooData；
 *   4. 偏好设置 → 图片 → 工作目录 里指定的目录。
 */
function layoutImageBaseDirs(): string[] {
  const jsonPath = getJsonPath()
  const pdfPath = getOpenedPdfPath()
  const jsonDir = jsonPath ? dirOf(jsonPath) : null
  const pdfDir = pdfPath ? dirOf(pdfPath) : null
  const opened = getJsonOrigin() === 'dialog' ? [jsonDir, pdfDir] : [pdfDir, jsonDir]
  // 偏好里没设（或 store 还没就绪）就退回程序默认的工作目录。
  const workDir = getPrefs<string>('image.workDir') || DEFAULT_WORK_DIR
  const candidates = [markdownImageDir, ...opened, DEFAULT_WORK_DIR, workDir]
  return [...new Set(candidates.filter((dir): dir is string => !!dir))]
}

/**
 * MinerU 的图片路径 → 可直接写进 Markdown 的 src。
 *
 * 图片落在基准目录下的 images/ 里（MinerU 的输出结构），image_path 有时带
 * images/ 前缀、有时只是文件名，两种都试。读得到就内嵌成 data URL；读不到
 * （没有 Electron 通道 / images 目录不在这几处 / 文件缺失）就退回第一个候选
 * 的 file:// 绝对路径 —— 裸文件名在编辑器里是必然加载不出来的。
 */
function resolveLayoutImage(imagePath: string): Promise<string | null> {
  const flat = imagePath.replace(/\\/g, '/')
  const name = flat.replace(/^.*\//, '')
  const baseDirs = layoutImageBaseDirs()
  const candidates = isAbsoluteLike(flat)
    ? [flat]
    : baseDirs.flatMap((dir) => [`${dir}/images/${name}`, `${dir}/${flat}`])
  if (!candidates.length) return Promise.resolve(null)

  const key = `${baseDirs.join('|')} ${imagePath}`
  const cached = layoutImageTasks.get(key)
  if (cached) return cached
  const task = (async (): Promise<string | null> => {
    // 偏好里关掉内嵌就只写路径：不读盘，Markdown 里留一条 file:// 绝对路径。
    const embed = getPrefs<boolean>('image.embedImages') ?? true
    if (!embed) return absoluteToFileUrl(candidates[0])
    // 走可选访问：WebView2 / 纯浏览器里根本没有 Electron 通道，别抛异常
    const api = window.electronAPI as Partial<typeof window.electronAPI> | undefined
    const read = api?.readImageAsDataUrl
    if (read) {
      for (const candidate of new Set(candidates)) {
        try {
          const result = await read(candidate)
          if (result?.dataUrl) return result.dataUrl
        } catch {
          // 单个候选读失败（权限/占用）不影响其它候选
        }
      }
    }
    // 内嵌不成也别再退回裸文件名：file:// 绝对路径至少指向了真实位置。
    console.warn('[layout2md] 图片读不到，退回 file:// 路径：', candidates[0], '（readImageAsDataUrl 可用：', !!read, '）')
    return absoluteToFileUrl(candidates[0])
  })()
  layoutImageTasks.set(key, task)
  return task
}

/** Markdown 图片语法：![alt](src "title") */
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
/**
 * HTML 图片：<img src="..." …>。MinerU 的表格是整块 HTML，单元格里的图就用
 * img 标签写的（不是 Markdown 语法），所以这两种都得认。
 */
const HTML_IMAGE_RE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

const IMAGE_PATTERNS: Array<{ re: RegExp; pick: (match: RegExpMatchArray) => string | undefined }> = [
  { re: MD_IMAGE_RE, pick: (match) => match[1] },
  // 无引号写法 `<img src=a.jpg/>` 会把结尾那个 / 也吃掉，去了再找文件。
  { re: HTML_IMAGE_RE, pick: (match) => match[1] ?? match[2] ?? match[3]?.replace(/\/$/, '') },
]

/**
 * full.md 里的图片路径是相对结果包的（images/xxx.jpg），编辑器页面在 file:// 下
 * 按自身 URL 解析，裸相对路径必然加载不出来 —— 换成内嵌 data URL（或至少是
 * file:// 绝对路径），逻辑与 layout.json 那条路一样走 resolveLayoutImage。
 */
async function inlineMarkdownImages(markdown: string): Promise<string> {
  // 每处 src 记成「子串范围」：替换时只动 src 那一段，alt/title 里同名的文本不动。
  const hits = IMAGE_PATTERNS.flatMap(({ re, pick }) =>
    [...markdown.matchAll(re)].flatMap((match) => {
      const src = pick(match)
      if (!src || match.index === undefined) return []
      const offset = match[0].indexOf(src)
      if (offset < 0) return []
      return [{ at: match.index + offset, src }]
    })
  )
  if (!hits.length) return markdown
  hits.sort((a, b) => a.at - b.at)
  const resolved = await Promise.all(hits.map((hit) => resolveLayoutImage(hit.src)))

  let out = ''
  let cursor = 0
  hits.forEach((hit, index) => {
    const src = resolved[index]
    if (!src) return
    out += markdown.slice(cursor, hit.at)
    out += src
    cursor = hit.at + hit.src.length
  })
  out += markdown.slice(cursor)
  return out
}

/**
 * 读一份 Markdown 文件（在线解析结果里的 full.md）写进编辑器。
 * 不再经过 JSON → Markdown 转换：服务端给什么就显示什么。
 */
async function applyMarkdownFile(path: string, onlyWhenEmpty = false): Promise<void> {
  // 自动带出来的那一次：编辑器里已经有内容就别覆盖（可能是用户打开的文档）。
  if (onlyWhenEmpty && getContent().trim()) return
  const result = await window.electronAPI.readTextFile(path)
  if (!result) return
  // 先记住这份 Markdown 的目录：里面图片都在它同级的 images/ 下（见 layoutImageBaseDirs）。
  markdownImageDir = dirOf(result.path)
  const markdown = await inlineMarkdownImages(result.content)
  if (!markdown.trim()) return
  // flushHistory: 这是另一份文档，不该让撤销退回到它之前的空文档。
  setContent(markdown, true)
  // 内容换过了：标题栏/标签页显示未保存，关闭时问一句（自动保存因为没有
  // currentFilePath，不会去找地方写）。
  setDirty()
}

// 工具栏控件进入 JSON 模式前的 disabled 值：切回来按原值还原（「清除样式」这类
// 按钮本来就可能在光标不在样式里时是禁用的）。
const toolbarWasDisabled = new WeakMap<HTMLElement, boolean>()

function setToolbarEnabled(enabled: boolean): void {
  const toolbar = document.getElementById('toolbar')
  if (!toolbar) return
  const controls = toolbar.querySelectorAll<
    HTMLButtonElement | HTMLSelectElement | HTMLInputElement
  >('button, select, input')
  controls.forEach((control) => {
    if (enabled) {
      control.disabled = toolbarWasDisabled.get(control) ?? false
      toolbarWasDisabled.delete(control)
    } else {
      toolbarWasDisabled.set(control, control.disabled)
      control.disabled = true
    }
  })
}

const LARGE_DOCUMENT_SOURCE_THRESHOLD = 512 * 1024

function setContent(content: string, flushHistory = false): void {
  // 同步当前文件路径，供图片路径转换使用
  setCurrentImageFilePath(currentFilePath)
  // 换了文档：上一份的块锚点作废（由 PDF 解析结果重新装的会紧接着装回来）。
  clearPdfBlockAnchors()
  // 文档切换，清空模式切换缓存
  cachedMarkdown = null
  sourceEnterText = null
  foldBase64Cache = null
  // Follow the incoming document's Markdown style before it is parsed, so a
  // save writes the same markers the file already used.
  const detectedStyle = detectMarkdownStyle(content)
  applyMarkdownStyle(detectedStyle)
  if (content.length >= LARGE_DOCUMENT_SOURCE_THRESHOLD) {
    // ProseMirror renders the whole document eagerly. Keep very large files in
    // the existing source editor so opening them stays responsive on Windows.
    enterSourceMode(content)
    updateWordCount(content)
    return
  }
  exitSourceMode()
  setMarkdownProgrammatically(content, flushHistory)
  updateWordCount(content)
}

function getContent(): string {
  if (sourceModeActive) return unfoldBase64(sourceEl().value)
  return getMarkdown()
}

function getExportSnapshot(content: string): {
  content: string
  html: string
  styles: string
  bodyClass: string
  background: string
} {
  let styles = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      styles += Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n') + '\n'
    } catch {
      // Ignore stylesheets that the browser marks as inaccessible.
    }
  }
  return {
    content,
    html: document.querySelector('#editor .ProseMirror')?.innerHTML ?? '',
    styles,
    bodyClass: Array.from(document.body.classList).filter((name) => name !== 'show-file-panel').join(' '),
    background: getComputedStyle(document.body).backgroundColor,
  }
}

async function exportCurrentHTML(): Promise<void> {
  const wasSourceMode = sourceModeActive
  const sourceScrollRatio = wasSourceMode ? scrollRatio(sourceEl()) : 0
  const content = getContent()

  // Render the latest source text before taking the DOM snapshot, then restore
  // source mode so exporting does not change the user's editing context.
  if (wasSourceMode) {
    exitSourceMode()
    setMarkdownProgrammatically(content)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve())
      })
    })
  }

  await window.electronAPI.exportHTML(getExportSnapshot(content))

  if (wasSourceMode) {
    enterSourceMode(content, sourceScrollRatio)
  }
}

async function exportCurrentImage(preset: 'desktop' | 'mobile'): Promise<void> {
  const wasSourceMode = sourceModeActive
  const sourceScrollRatio = wasSourceMode ? scrollRatio(sourceEl()) : 0
  const content = getContent()

  if (wasSourceMode) {
    exitSourceMode()
    setMarkdownProgrammatically(content)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }

  await window.electronAPI.exportImage(getExportSnapshot(content), preset)

  if (wasSourceMode) enterSourceMode(content, sourceScrollRatio)
}

// 目标是否可编辑（所见即所得区是 contenteditable，源码框是 textarea）
function isEditableTarget(target: HTMLElement): boolean {
  return target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'
}

// 右键处是否有选中的文本：输入框看 selectionStart/End，其余看 window 选区
function hasTextSelectionAt(target: HTMLElement): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return (target.selectionEnd ?? 0) > (target.selectionStart ?? 0)
  }
  return (window.getSelection()?.toString().length ?? 0) > 0
}

// 编辑区右键菜单（撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选）。
// Electron 不自带上下文菜单，而此前只有标签栏与文件面板自己实现了右键菜单，
// 编辑区（所见即所得 + 源码框）点了没反应。这里在文档层补一个：
// 那两处会先 preventDefault 弹自己的菜单，靠 defaultPrevented 让路，不会重复弹。
function bindEditorContextMenu(api: typeof window.electronAPI): void {
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return
    const target = e.target as HTMLElement | null
    if (!target) return
    const editable = isEditableTarget(target)
    // 只服务于编辑区（#editor 所见即所得 / #source-editor 源码框）
    if (!editable && !target.closest('#editor, #source-editor')) return
    e.preventDefault()
    // 原生 role 命令作用于聚焦元素：右键不一定已把焦点给它，先补一次
    if (editable && document.activeElement !== target) target.focus?.()
    void api.showEditorContextMenu?.({ editable, hasSelection: hasTextSelectionAt(target) })
  })
}

async function init(): Promise<void> {
  const api = window.electronAPI
  // 尽早初始化偏好 store（从主进程拉 userSetting.json + 迁移旧 localStorage key）；
  // 后续 math-engine / preferences-modal 模块读取偏好依赖此快照已就绪。
  await initPrefsStore()
  // macOS keeps its own overlay scrollbars (drawn while you scroll, no layout
  // space, never in the way). The thin custom scrollbar is only for Windows and
  // Linux, where the platform default is a chunky always-on bar.
  if (!/^Mac/i.test(navigator.platform)) document.body.classList.add('platform-non-mac')
  // Windows has no traffic lights on the left and draws its window controls inside
  // the row on the right (titleBarOverlay), so it needs both ends of the row told
  // apart from macOS. The custom Typora-style top menu bar shows there too.
  if (/Windows/i.test(navigator.userAgent)) {
    document.body.classList.add('platform-win')
  }
  void setupMenubar()
  setupToolbar()
  const language = await api.getLanguage()
  fileManagerName = await api.getFileManagerName()
  setUiLanguage(language)
  const savedTheme = loadSavedTheme()
  if (savedTheme.startsWith('custom:')) {
    // Load before applying: a newly opened window must not briefly paint the
    // custom class without its stylesheet. Missing files self-heal to elegant.
    const css = await api.loadThemeCSS(savedTheme.slice(7))
    applyTheme(css ? savedTheme : 'elegant', css ?? undefined)
  } else {
    applyTheme(savedTheme)
  }
  applyAppearanceFontSize()

  const searchPanel = new SearchPanel()
  searchPanel.setLanguage(language)
  setMathModalLanguage(language)
  api.onSearch(() => searchPanel.show())
  api.onMathModal(() => showMathModal())
  // 菜单栏「格式」等菜单项与工具栏按钮共用同一条命令管线（runToolbarCommand），
  // 所以菜单里可以有任务列表、引用、表格、弹窗类命令等全部工具栏功能。
  api.onFormatCommand((id) => {
    restoreEditorFocusForMenu()
    runToolbarCommand(id)
  })
  api.onFontCommand((attrs) => applyFont(attrs))
  updateUiLanguage()

  await createEditor('editor', (markdown) => {
    updateWordCount(markdown)
  }, () => {
    if (!editorReady) return
    if (!applyingProgrammaticChange) setDirty()
    scheduleOutlineUpdate()
    // 正文动过了：块与 PDF 矩形的对应要重新对一次（模块内部防抖）。
    scheduleBlockLinkRebuild()
  })
  // 编辑器就绪：把 view 交给联动层，它要靠 Decoration 给正文块打标记。
  setBlockLinkView(getEditorView())
  updateWordCount()
  editorReady = true
  resetDirty()

  // Main asks for an authoritative snapshot before any close or quit.
  api.onRequestDocumentState(async (requestId) => {
    captureActiveTab()
    // Report every tab that still has unsaved content. The main process writes
    // the ones with a path and refuses to close on the untitled ones, so a
    // background tab can never be dropped silently.
    window.electronAPI.respondDocumentState(requestId, {
      dirty,
      content: getContent(),
      tabs: tabs.filter((tab) => tab.dirty).map((tab) => ({ path: tab.filePath, content: tab.content }))
    })
  })
  // 偏好设置「外观 → 字体大小」（Typora 式）：
//   自动（推荐）→ 沿用主题自带字号；自定义 → 用 appearance.fontSizePx 作为
//   编辑器正文字号。字体名偏好（编辑器字体弹窗里设的）两种模式下都保留。
function applyAppearanceFontSize(): void {
  const family = loadSavedEditorFont()?.family ?? ''
  if (getPrefs<string>('appearance.fontSizeMode') !== 'custom') {
    applyEditorFont(family ? { family, size: 0 } : null)
    return
  }
  const raw = getPrefs<number>('appearance.fontSizePx') ?? 16
  const size = Math.min(40, Math.max(10, Math.round(Number(raw) || 16)))
  applyEditorFont({ family, size })
}

// 偏好设置「通用 → 离开时自动保存」：窗口失去焦点即落盘（浏览器窗口失焦
  // 同样触发，故 web 版行为一致）。
  window.addEventListener('blur', () => flushOnBlur())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnBlur()
  })

  // Report readiness only after every listener is registered — the main process
  // reacts to this signal by flushing queued tab-opens and by trusting the
  // window with close/quit flows. It sat mid-init once and the flush raced
  // bindTabBar: files handed over at launch were dropped silently.
  api.reportRendererReady()

  // Save before switching files. If saving is cancelled or fails, preserve the
  // current document rather than opening another file over it.
  fileListEl().addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-path]') as HTMLButtonElement | null
    if (!btn || !btn.dataset.path) return
    // A directory expands in place; the tree only ever grows downward.
    if (btn.dataset.kind === 'directory') {
      togglePanelDirectory(btn.dataset.path)
      return
    }
    if (btn.dataset.path === currentFilePath) return
    // ⌘/Ctrl click opens the file in a tab of its own (design.md).
    if (btn.dataset.kind === 'file' && (e.metaKey || e.ctrlKey)) {
      await openFileInNewTab(btn.dataset.path)
      return
    }
    if (btn.dataset.kind === 'file' && dirty && !await saveCurrent()) return
    await api.openSibling(btn.dataset.path)
  })

  fileToggleBtnEl().addEventListener('click', togglePanel)
  updateFileToggleButton()
  // Right-click on a file panel entry opens the native context menu. The
  // parent entry has no target worth acting on, so it keeps the default.
  fileListEl().addEventListener('contextmenu', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-path]') as HTMLButtonElement | null
    const path = btn?.dataset.path
    const kind = btn?.dataset.kind
    if (!path || kind === 'parent') return
    e.preventDefault()
    void api.showEntryContextMenu(path, kind === 'directory' ? 'directory' : 'file')
  })
  initPanelResize()
  bindEditorContextMenu(api)
  bindTabBar(api)
  bindSubmitPanel()
  // 类 docx 工具栏的窗口级动作（新建标签页承载导入结果、按路径打开文件）
  setCanvasDocHooks({
    newTab: (init?: CanvasDocInit) => openCanvasDocTab(init),
    openPath: (path: string) => openMarkdownPathFromCanvas(path)
  })
  // 解析结果里的 full.md 到位 → 填进编辑器。窗口默认停在 Markdown 模式，
  // 不用用户再去点一下 Markdown 按钮。
  // 打印预览层：按钮与 Esc 的绑定（预览内容由菜单触发，见 onMenuPrintPreview）
  initPrintPreview(api)
  initPdfView(api, {
    onMarkdownFile: (path, options) => applyMarkdownFile(path, options?.onlyWhenEmpty ?? false),
    // 用户在对照面板里选了源文件：记回标签页，标签条上的名字跟着变。
    onPdfSourceChange: (path) => {
      const tab = activeTab()
      if (!tab || !tab.pdfTab) return
      tab.pdfPath = path
      reportActiveSource(tab)
      renderTabBar()
    }
  })
  // 图片转md：转换结果里的 full.md → 填进编辑器；只有 layout.json 时退一步把
  // 现转出来的 Markdown 直接写进去。
  initImageView(api, {
    onMarkdownFile: (path) => applyMarkdownFile(path),
    onMarkdownText: (markdown) => {
      setContent(markdown, true)
      setDirty()
    },
    // 用户在面板里选了图片：记回标签页（标签条上的名字跟着变），并告诉主进程 ——
    // 「另存为」会用图片名当默认文件名。
    onImageSourceChange: (path) => {
      const tab = activeTab()
      if (!tab || !tab.imageTab) return
      tab.imagePath = path
      reportActiveSource(tab)
      renderTabBar()
    }
  })
  // 工具箱（帮助 → 工具箱）：整页工具界面。选中的源文件记回标签页。
  initToolView(api, {
    onToolSourceChange: (path) => {
      const tab = activeTab()
      if (!tab || !tab.tool) return
      tab.toolPath = path
      renderTabBar()
    }
  })
  // 文档助手侧边栏（LLM）：开关在偏好设置 → 外观，产出先落建议卡片、确认后才写入。
  // 可用性判断放在这里而不是 assistant.ts —— 它要知道当前标签页类型与源码模式。
  initAssistant(api, {
    isAvailable: () => {
      const tab = activeTab()
      if (!tab || tab.kind !== 'document' || tab.pdfTab || tab.imageTab || tab.tool) return false
      // 源码模式（含大文件被强制切进去的那种）下没有 ProseMirror 文档可改。
      return !sourceModeActive
    },
    unavailableReason: () => {
      const tab = activeTab()
      if (sourceModeActive) {
        return isChinese() ? '源码模式下不可用（切回所见即所得）' : 'Not available in source mode'
      }
      if (!tab || tab.kind !== 'document' || tab.pdfTab || tab.imageTab || tab.tool) {
        return isChinese() ? '当前标签页没有可编辑的 Markdown' : 'This tab has no editable Markdown'
      }
      return ''
    },
    // 整篇应用：走编辑器自己的 setMarkdown。不传 flushHistory ⇒ 走事务而不是
    // 重建 state，所以这一步是可以 Ctrl+Z 撤销的（与格式工具栏一致）。
    applyDocument: (markdown) => {
      setMarkdown(markdown)
    },
    onApplied: () => {
      setDirty()
      updateWordCount()
      scheduleOutlineUpdate()
    },
    onRequestClose: () => {
      // 收起按钮与「偏好设置 → 外观」里那个开关是同一份状态：写回偏好，
      // 主进程广播回来后本窗口再收起（单一数据源）。
      void setPrefsPath('assistant.sidebarOpen', false)
    }
  })
  // 启动时按偏好摆一次（快照在 initPrefsStore 之后已就绪）
  setAssistantOpen(getPrefs<boolean>('assistant.sidebarOpen') === true)
  initJsonView()
  // 右侧栏顶部条（保存 + 复制）：PDF 对照与图片转md 两个视图都有，绑定不分视图
  // —— 可见性由 CSS 的 body.pdf-view / body.image-view 决定（图片视图里那组
  // Markdown/JSON 分段控件被 CSS 收起来，见 base.css）。
  initDocBar({
    getText: (format) => (format === 'json' ? getJsonText() : getContent()),
    onFormatChange: setDocFormat,
    onSave: () => saveCurrent()
  })
  // The launch document (the welcome screen or a restored file) is a tab from
  // the first frame, so the strip never renders without one.
  ensureTab()
  renderTabBar()
  fileTabEl().addEventListener('click', () => setPanelMode('files'))
  outlineTabEl().addEventListener('click', () => setPanelMode('outline'))
  api.onToggleFilePanel(() => togglePanel())

  sourceToggleBtnEl().addEventListener('click', toggleSourceMode)
  api.onToggleSourceMode(() => toggleSourceMode())
  // Source-mode edits update the word count and mark the doc dirty in real time
  sourceEl().addEventListener('input', () => {
    setDirty()
    updateWordCount()
    scheduleOutlineUpdate()
  })
  // The outline tracks scrolling in both modes so it doubles as a progress
  // view (#64); rAF keeps the rect reads to one batch per frame. `scrollend`
  // also releases the outline jump lock as soon as a jump scroll settles.
  editorEl().addEventListener('scroll', scheduleOutlineActiveSync, { passive: true })
  sourceEl().addEventListener('scroll', scheduleOutlineActiveSync, { passive: true })
  editorEl().addEventListener('scrollend', endOutlineJump)
  sourceEl().addEventListener('scrollend', endOutlineJump)
  // Anchor-link jumps start inside the editor; the phase signal engages the
  // same jump lock the outline clicks use, so the highlight cannot be stolen
  // by sections passed along the way (review on #68).
  onEditorJumpPhase((phase) => (phase === 'start' ? beginOutlineJump() : endOutlineJump()))

  api.onSiblingsChanged((files) => {
    // A watcher refresh can change any directory that is open, so drop the
    // cached levels and let the expanded ones read themselves again.
    panelChildren.clear()
    renderFileList(files)
  })
  updatePanelVisibility()
  await refreshSiblings()

  api.onMenuOpen(async () => {
    // 'file-opened' event drives the content load (and file-panel refresh)
    await api.openFile()
  })

  api.onMenuSave(() => { void saveCurrent() })
  api.onMenuSaveAs(() => { void saveCurrent(true) })
  api.onMenuExportPDF(() => api.exportPDF())
  // 菜单「打印 → 打印预览」：预览层在渲染端（主进程先把 PDF 生成好）
  api.onMenuPrintPreview(() => { void showPrintPreview() })
  api.onMenuExportHTML(() => { void exportCurrentHTML() })
  api.onMenuExportDOCX(() => { void api.exportDOCX(getContent(), getExportFormulaEnginePreference()) })
  api.onMenuExportImage((preset) => { void exportCurrentImage(preset) })
  api.onMenuImportDocx(async () => {
    releaseMermaidRenderer()
    const result = await api.importDocx()
    if (!result) return // 用户取消或转换失败
    // 当前 tab 为空/未保存 → 复用它；否则新建 tab 避免覆盖未保存内容
    //（提交页 / 类docx文档页都是表单/画布视图，不能承载文档内容，一律走新建）
    const current = activeTab()
    if (current && current.kind === 'document' && !current.filePath && !current.dirty) {
      currentFilePath = null
      applyContent(result.content)
      current.filePath = null
      current.content = result.content
      current.diskContent = null
    } else {
      await openNewTab()
      applyContent(result.content)
      const tab = activeTab()
      if (tab) {
        tab.filePath = null
        tab.content = result.content
        tab.diskContent = null
      }
    }
    updateFileTitle()
    updatePanelVisibility()
    refreshSiblings()
    scheduleOutlineUpdate()
    renderTabBar()
    // 导入结果以所见即所得呈现（applyContent → setContent 末尾已
    // exitSourceMode）：转换后的 Markdown 由编辑器即时渲染，可直接校对版式。
    const tab = activeTab()
    if (tab) tab.sourceMode = false
  })

  api.onNewFile(() => {
    releaseMermaidRenderer()
    exitSourceMode()
    ensureTab()
    applyContent('')
    scheduleOutlineUpdate()
    renderTabBar()
  })
  api.onFileOpened((data) => {
    releaseMermaidRenderer()
    // A document opened into a window that has none yet (a launch with a file)
    // lands in the first tab rather than creating a second one.
    ensureTab()
    currentFilePath = data.path
    dirty = false
    const tab = activeTab()
    if (tab) {
      tab.filePath = data.path
      tab.dirty = false
      tab.revision = documentRevision
      tab.diskContent = data.content
    }
    resetDirty()
    setContent(data.content, true)
    const resetScroll = () => {
      editorEl().scrollTop = 0
      sourceEl().scrollTop = 0
    }
    resetScroll()
    requestAnimationFrame(resetScroll)
    updateFileTitle()
    updatePanelVisibility()
    refreshSiblings()
    scheduleOutlineUpdate()
    renderTabBar()
  })
  api.onFileChanged((content) => {
    if (dirty) {
      raiseExternalConflict()
      return
    }
    if (sourceModeActive) {
      sourceEl().value = foldBase64(content)
    } else {
      // An external write is not something the reader can undo into; making it
      // one undo step would also let a stray undo write stale content back.
      setMarkdownProgrammatically(content, true)
    }
    updateSourceToggle()
    updateWordCount()
    resetDirty()
    scheduleOutlineUpdate()
  })

  api.onSetTheme((theme) => applyTheme(theme))

  // macOS takes the traffic lights away in full screen, so the row drops the 96px
  // they sit in. The main process owns the window state and reports it here, both
  // on the transitions and once at startup for a window restored into full screen.
  api.onFullscreenChange((isFullscreen) => {
    document.body.classList.toggle('fullscreen', isFullscreen)
  })

  api.onLanguageChanged((language: UiLanguage) => {
    setUiLanguage(language)
    searchPanel.setLanguage(language)
    setMathModalLanguage(language)
    updateUiLanguage()
    // Tab labels and the close tooltip are built in the current language.
    renderTabBar()
  })
  api.onExternalConflictResult((result) => {
    if (result.action === 'load' && typeof result.content === 'string') {
      applyContent(result.content)
      resetDirty()
      updateWordCount()
      scheduleOutlineUpdate()
    } else {
      // Keep mine: resume autosave; the next save overwrites the external edit.
      showSaveStatus('dirty')
      if (dirty) scheduleAutosave()
    }
    externalConflictPending = false
  })
  api.onOpenFontSettings(() => showFontSettingsModal())
  api.onToggleToolbar(() => toggleToolbarVisible())
  api.onEditorFontChanged((prefs) => applyEditorFont(prefs.family || prefs.size ? prefs : null))
  // 偏好「外观 → 字体大小」改动即时生效（含本窗口与其它窗口的广播）
  onPrefsChanged((key, value) => {
    if (key === 'appearance.fontSizeMode' || key === 'appearance.fontSizePx') applyAppearanceFontSize()
    if (key === 'appearance.showStatusBar') updateWordCount()
    if (key === 'appearance.allowCollapseOutline') updateFileToggleButton()
    // 「外观 → 文档助手侧边栏」开关（含别的窗口改的情况，靠主进程广播同步）
    if (key === 'assistant.sidebarOpen') setAssistantOpen(value === true)
  })
  api.onSetCustomCSS((css) => {
    const theme = loadSavedTheme()
    applyTheme(theme, css)
  })

  api.onMenuImportTheme(async () => {
    const result = await api.loadCustomTheme()
    if (result) applyTheme(`custom:${result.name}`, result.css)
  })

  api.onMenuPreferences(() => showPreferencesModal())

  // 菜单「文件 → 新建类docx文档」：canvas-editor 标签页
  api.onMenuNewCanvasDoc(() => { void openCanvasDocTab() })

  // --- Auto update banner (weak, non-blocking) ---
  let updateDownloaded = false
  function showUpdateBanner(version: string): void {
    updateBannerTextEl().textContent = updateDownloaded
      ? (isChinese() ? `新版本 v${version} 已就绪` : `Update v${version} is ready`)
      : (isChinese() ? `发现新版本 v${version}` : `Update v${version} available`)
    updateBannerActionEl().textContent = updateDownloaded ? (isChinese() ? '重启安装' : 'Restart') : (isChinese() ? '更新' : 'Update')
    updateBannerActionEl().disabled = false
    updateBannerEl().hidden = false
  }

  api.onUpdateAvailable((version) => {
    updateDownloaded = false
    showUpdateBanner(version)
  })
  api.onUpdateDownloaded((version) => {
    updateDownloaded = true
    showUpdateBanner(version)
  })
  api.onUpdateProgress((percent) => {
    if (updateDownloaded) return
    updateBannerActionEl().textContent = isChinese() ? `下载中 ${percent}%` : `Downloading ${percent}%`
  })
  api.onUpdateError(() => {
    if (updateDownloaded) return
    updateBannerActionEl().textContent = isChinese() ? '下载失败，点击重试' : 'Failed, retry'
    updateBannerActionEl().disabled = false
  })

  updateBannerActionEl().addEventListener('click', async () => {
    if (updateDownloaded) {
      await api.installUpdate()
    } else {
      updateBannerActionEl().textContent = isChinese() ? '下载中…' : 'Downloading…'
      updateBannerActionEl().disabled = true
      try {
        await api.downloadUpdate()
      } catch {
        // The 'update-error' event may already have reset the label; this
        // catch covers the path where the IPC call itself rejects.
        updateBannerActionEl().textContent = isChinese() ? '下载失败，点击重试' : 'Failed, retry'
        updateBannerActionEl().disabled = false
      }
    }
  })
  document.getElementById('update-banner-dismiss')!.addEventListener('click', () => {
    updateBannerEl().hidden = true
  })

  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', async (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const filePath = api.getPathForFile(file)
    if (!filePath) return
    const result = await api.openFilePath(filePath)
    // 'file-opened' event drives the content load when opened into this window
    void result
  })
}

init().catch((e) => console.error('ColaMD init failed:', e))