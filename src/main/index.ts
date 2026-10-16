import { app, BrowserWindow, ipcMain, dialog, Menu, shell, session, clipboard, screen, nativeTheme } from 'electron'
import { execFile } from 'child_process'
import { autoUpdater } from 'electron-updater'
import { join, basename, dirname, extname, isAbsolute, resolve, relative } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { appendFile, readFile, writeFile, readdir, copyFile, mkdir, stat } from 'fs/promises'
import { watch, FSWatcher, existsSync, readdirSync, readFileSync, writeFileSync, statSync, accessSync, constants } from 'fs'
import { mkdirSync } from 'fs'
import { getUserSetting, getUserSettingByPath, setUserSetting, setUserSettingBatch, DEFAULT_WORK_DIR } from './user-setting'
import { parsePdfOnline, findExtractedResult } from './http/mineru'
import { ocrImageToLatex, readAttachment, savePastedImage } from './assistant-attach'
import { splitPdfByPageCount, type SplitResult } from './pdf-split'
import { completeChat, streamChat, type ChatContentPart, type ChatMessage, type ChatResult } from './llm'
import { setAsDefaultApp } from './default-app'
import { recognizeTexoFormula } from './texo-ocr'
import { saveFormulaRecord } from './formula-db'
import { startSnipCapture } from './snip-window'

const startupStartedAt = performance.now()
const startupTraceEnabled = process.env.COLAMD_STARTUP_TRACE === '1'
const startupMarks: Record<string, number> = { 'main-loaded': 0 }
let startupTraceWritten = false

function markStartup(name: string): void {
  if (!startupTraceEnabled || startupTraceWritten) return
  startupMarks[name] = Math.round(performance.now() - startupStartedAt)
}

function writeStartupTrace(): void {
  if (!startupTraceEnabled || startupTraceWritten || !('renderer-ready' in startupMarks)) return
  startupTraceWritten = true
  const trace = JSON.stringify({ platform: process.platform, electron: process.versions.electron, ...startupMarks })
  void appendFile(join(app.getPath('userData'), 'startup-trace.jsonl'), `${trace}\n`).catch(() => {})
  console.info(`Teyoo startup trace: ${trace}`)
}


const themesDir = join(app.getPath('home'), '.colamd', 'themes')
const releaseNoticePath = join(app.getPath('userData'), 'release-notice.json')

// The shell's top row, in CSS pixels: the window controls overlay on Windows has
// to be told the same height the renderer draws (design.md, one row).
const TITLEBAR_HEIGHT = 40
// What the overlay shows before the renderer reports its theme. The app's theme is
// independent of the system's, so this can only be a guess: follow the system, and
// the renderer corrects it on first paint (a wrong guess would otherwise flash a
// light strip over a dark row).
const lightOverlay = { bg: '#e4e1de', symbol: '#6f6b67' }
const darkOverlay = { bg: '#1a1e24', symbol: '#8b939c' }

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd']

// Bundled examples are opened on demand from Help. Browsing the user's
// Documents folder on macOS can trigger a privacy prompt before they have even
// opened a file.
const demoDir = app.isPackaged
  ? join(process.resourcesPath, 'demo')
  : join(__dirname, '../../resources/demo')
const cheatsheetDir = app.isPackaged
  ? join(process.resourcesPath, 'templates')
  : join(__dirname, '../../resources/templates')

interface SiblingFile {
  name: string
  path: string
  kind: 'file' | 'directory' | 'parent'
}

// One directory level: subdirectories first, then Markdown files, each sorted
// by name. Hidden directories stay out of the list.
async function listDirectoryChildren(dir: string): Promise<SiblingFile[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(dir, e.name), kind: 'directory' as const }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const files = entries
      .filter((e) => e.isFile() && MARKDOWN_EXTENSIONS.includes(extname(e.name).toLowerCase()))
      .map((e) => ({ name: e.name, path: join(dir, e.name), kind: 'file' as const }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return [...directories, ...files]
  } catch {
    return []
  }
}

// The file panel's root: the open document's directory, with `..` as the one
// way back up. Deeper levels are read one directory at a time as the tree is
// expanded, so nothing walks the whole tree up front.
async function listSiblingFiles(filePath: string | null, browseDir?: string): Promise<SiblingFile[]> {
  const dir = browseDir ?? (filePath ? dirname(filePath) : null)
  if (!dir) return []
  const parent = dirname(dir)
  const children = await listDirectoryChildren(dir)
  return parent === dir ? children : [{ name: '..', path: parent, kind: 'parent' }, ...children]
}

function ensureThemesDir(): void {
  if (!existsSync(themesDir)) {
    mkdir(themesDir, { recursive: true }).catch(() => {})
  }
}

// --- Recent files + session restore (#28, #45) ---
const recentStorePath = join(app.getPath('home'), '.colamd', 'recent.json')
let recentStore: { recent: string[]; restoreOnLaunch: boolean } = { recent: [], restoreOnLaunch: true }
const languagePreferencePath = join(app.getPath('userData'), 'language.json')

// Window size, position and view zoom survive a restart. Having to resize and
// re-zoom on every launch is a daily annoyance on a large display (#95), and
// these are the same kind of choice the app already remembers for themes, panel
// width and language.
const windowStatePath = join(app.getPath('userData'), 'window-state.json')
interface SavedWindowState {
  bounds?: { x: number; y: number; width: number; height: number }
  zoom?: number
}

function loadWindowState(): SavedWindowState {
  try {
    const parsed = JSON.parse(readFileSync(windowStatePath, 'utf-8')) as SavedWindowState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

let savedWindowState: SavedWindowState = loadWindowState()

// A saved position can point at a display that is no longer attached, which
// would put the window somewhere the user cannot reach. Keep it only when it
// still overlaps a screen that exists right now.
function usableBounds(): { x: number; y: number; width: number; height: number } | undefined {
  const bounds = savedWindowState.bounds
  if (!bounds) return undefined
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined
  if (bounds.width < 600 || bounds.height < 400) return undefined
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
      && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y
  })
  return onScreen ? bounds : undefined
}

let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  // getNormalBounds keeps a full-screen or maximised window from being stored
  // as the size of the screen.
  const bounds = win.getNormalBounds()
  const zoom = win.webContents.getZoomFactor()
  savedWindowState = { bounds, zoom }
  void mkdir(dirname(windowStatePath), { recursive: true })
    .then(() => writeFile(windowStatePath, JSON.stringify({ bounds, zoom }), 'utf-8'))
    .catch(() => { /* a preference that cannot be written is not worth a dialog */ })
}

function scheduleWindowStateSave(win: BrowserWindow): void {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
  windowStateSaveTimer = setTimeout(() => saveWindowState(win), 600)
}
type UiLanguage = 'zh' | 'en'
let preferredLanguage: UiLanguage | null = null
try {
  const parsed = JSON.parse(readFileSync(languagePreferencePath, 'utf-8')) as { language?: unknown }
  if (parsed.language === 'zh' || parsed.language === 'en') preferredLanguage = parsed.language
} catch { /* first run or unreadable preference */ }

function getPreferredLanguage(): UiLanguage {
  return preferredLanguage ?? (app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en')
}

// Dialogs the user sees during normal use follow the UI language too: they were
// hardcoded Chinese, so an English window got Chinese buttons and vice versa
// (2026-09-15).
function uiText(zh: string, en: string): string {
  return getPreferredLanguage() === 'zh' ? zh : en
}

function setPreferredLanguage(language: UiLanguage): void {
  preferredLanguage = language
  try {
    mkdir(dirname(languagePreferencePath), { recursive: true }).catch(() => {})
    writeFileSync(languagePreferencePath, JSON.stringify({ language }), 'utf-8')
  } catch { /* best effort */ }
  setTimeout(() => buildMenu(), 0)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('language-changed', language)
  }
}
try {
  const parsed = JSON.parse(readFileSync(recentStorePath, 'utf-8'))
  if (Array.isArray(parsed.recent)) {
    recentStore.recent = parsed.recent.filter((p: unknown): p is string => typeof p === 'string')
  }
  if (typeof parsed.restoreOnLaunch === 'boolean') recentStore.restoreOnLaunch = parsed.restoreOnLaunch
} catch { /* first run or unreadable store */ }

function persistRecentStore(): void {
  try {
    mkdir(dirname(recentStorePath), { recursive: true }).catch(() => {})
    writeFileSync(recentStorePath, JSON.stringify(recentStore, null, 2), 'utf-8')
  } catch { /* best effort */ }
}

function pushRecentFile(filePath: string, rebuildMenu = false): void {
  const recent = [filePath, ...recentStore.recent.filter((p) => p !== filePath)].slice(0, 10)
  if (recent.length === recentStore.recent.length && recent.every((p, index) => p === recentStore.recent[index])) return
  recentStore.recent = recent
  persistRecentStore()
  // NEVER rebuild the menu from the autosave path: setApplicationMenu during
  // typing cancels the macOS IME composition and loses in-flight characters.
  // The File menu draws from recentStore on every platform now; macOS additionally
  // gets the file in its own recent list, which feeds the Dock menu.
  if (process.platform === 'darwin') {
    app.addRecentDocument(filePath)
  } else if (rebuildMenu) {
    buildMenu()
  }
}

function recentFiles(): string[] {
  return recentStore.recent.filter((p) => existsSync(p)).slice(0, 10)
}

function clearRecentFiles(): void {
  recentStore.recent = []
  persistRecentStore()
  if (process.platform === 'darwin') app.clearRecentDocuments()
  buildMenu()
}

function setRestoreOnLaunch(enabled: boolean): void {
  recentStore.restoreOnLaunch = enabled
  persistRecentStore()
  buildMenu()
}

async function scanCustomThemes(): Promise<string[]> {
  try {
    const files = await readdir(themesDir)
    return files.filter(f => f.endsWith('.css')).sort()
  } catch {
    return []
  }
}

// Per-window state
interface WindowState {
  filePath: string | null
  browsePath: string | null
  watcher: FSWatcher | null
  isInternalSave: boolean
  internalSaveCount: number
  // mtime of the file as of our last read or write. An autosave refuses to
  // write when the file on disk is newer, so an edit that landed while the
  // save was queued is never silently overwritten.
  lastKnownMtime: number
  // Content of our last internal write/load. Delayed FSEvents echoes of our
  // own writes are skipped when the disk still holds exactly this content.
  lastInternalSaveContent: string | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  siblingsTimer: ReturnType<typeof setTimeout> | null
  dirty: boolean
  closePromise: Promise<boolean> | null
  rendererReady: boolean
  writeQueue: Promise<void>
  closeAuthorized: boolean
  // Every file this window holds open in a tab, reported by the renderer. Used
  // to focus an existing tab instead of opening a duplicate window.
  tabFiles: string[]
  // Files handed to a window whose renderer has not finished loading yet. Sent
  // as tab-open requests once the renderer is ready AND the initial document
  // has been delivered — an early tab-open would otherwise race the first
  // 'file-opened' and both would land in the same tab.
  pendingTabFiles: string[]
  // True once the window's opening document (if any) has been handed to the
  // renderer, i.e. tab-open requests can be processed safely.
  initialDocDelivered: boolean
  // Shows a window that was created hidden (see createWindow): the renderer's
  // own signal, or the first paint, whichever lands first. Null once shown.
  reveal: (() => void) | null
  // 当前活动标签页挂着的那份 PDF 源文件（没有就是 null）：由渲染端在切标签页、
  // 选中源文件时上报。PDF 对照是窗口里的一个标签页，所以它是「活动标签页的」，
  // 不再属于窗口。「另存为」的默认文件名按它取（见 suggestFileName）。
  pdfPath: string | null
  // 菜单「PDF转md」在无窗口可发时先建窗，请求暂存在这里，等渲染端就绪再补发
  //（与 pendingTabFiles 同一套时机，见 flushPendingTabFiles）。
  pendingPdfTab: boolean
  // 菜单「图片转md」同上（同一套时机，见 importImageDocument）。
  pendingImageTab: boolean
  // 图片转md 标签页挂着的那张图片（渲染端在切标签页、选图时上报）：与 pdfPath
  // 同一个用途 —— 「另存为」的默认文件名按它取（见 suggestFileName）。
  imagePath: string | null
  // 前台标签页的类型（渲染端在切标签页时上报，见 set-active-tab-kind）。目前只
  // 服务于一件事：类 docx 文档（canvas-editor）标签页自成一套，菜单栏的
  // 打印/打印预览不该对它生效 —— 打印只走它自己工具栏里那一个（canvas 把内容
  // 渲成图再印，窗口级的 printToPDF 对它没有意义）。null = 还没上报，按文档算。
  activeTabKind: ActiveTabKind | null
}

/** 渲染端上报的活动标签页类型；'canvas' 就是类 docx 文档（canvas-editor）标签页 */
type ActiveTabKind = 'document' | 'submit' | 'canvas'

interface DocumentSnapshot {
  dirty: boolean
  content: string
  // Every tab of the window that still has unsaved content. `path === null`
  // means an untitled tab, which cannot be written without asking the user.
  tabs?: { path: string | null; content: string }[]
}

interface PendingDocumentStateRequest {
  webContentsId: number
  resolve: (snapshot: DocumentSnapshot | null) => void
  timer: ReturnType<typeof setTimeout>
}

const windowStates = new Map<number, WindowState>()
let pendingFilePaths: string[] = []
let isQuitting = false
let nextDocumentStateRequestId = 0
const pendingDocumentStateRequests = new Map<string, PendingDocumentStateRequest>()

function getState(win: BrowserWindow): WindowState {
  let state = windowStates.get(win.id)
  if (!state) {
    state = { filePath: null, browsePath: null, watcher: null, isInternalSave: false, internalSaveCount: 0, lastKnownMtime: 0, lastInternalSaveContent: null, debounceTimer: null, siblingsTimer: null, dirty: false, closePromise: null, rendererReady: false, writeQueue: Promise.resolve(), closeAuthorized: false, tabFiles: [], pendingTabFiles: [], initialDocDelivered: false, reveal: null, pdfPath: null, pendingPdfTab: false, pendingImageTab: false, imagePath: null, activeTabKind: null }
    windowStates.set(win.id, state)
  }
  return state
}

function getWinFromEvent(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

// Modification time of the file on disk, or 0 when it cannot be read.
function fileMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

// True when the file changed after our own last read or write, meaning there is
// an external edit this window has not seen yet. A 1ms tolerance absorbs
// filesystem timestamp rounding.
function fileChangedExternally(filePath: string, state: WindowState): boolean {
  if (!state.lastKnownMtime || filePath !== state.filePath) return false
  const diskMtime = fileMtimeMs(filePath)
  if (!diskMtime) return false
  return diskMtime > state.lastKnownMtime + 1
}

// Hand the renderer the version now on disk so the existing external-change
// flow can ask the user which side to keep.
function notifyExternalChange(win: BrowserWindow, filePath: string): void {
  void readFile(filePath, 'utf-8')
    .then((data) => {
      if (!win.isDestroyed()) win.webContents.send('file-changed', resolveImagePaths(data, filePath))
    })
    .catch(() => { /* the watcher picks it up on the next event */ })
}

function createWindow(filePath?: string, initialContent?: string, initialBrowsePath?: string): BrowserWindow {
  // Windows gets ONE row for its shell. A normal Windows frame stacks three
  // bars: the system title bar, the in-window menu bar, and our own 40px row,
  // which is what made the app read as heavy there (2026-09-15). So: no system
  // title bar, no menu bar, and the OS draws the window controls as an overlay
  // inside our row instead (Chrome's arrangement). macOS keeps its traffic
  // lights inside the same row, and Linux keeps its frame and its menu bar.
  const isWindows = process.platform === 'win32'
  const win = new BrowserWindow({
    ...(usableBounds() ?? { width: 960, height: 720 }),
    minWidth: 600,
    minHeight: 400,
    // 先藏起来：样式全靠渲染端 JS 注入（main.ts 的 import './themes/base.css'），
    // 窗口一开始就可见的话，用户看到的是没穿衣服的 DOM（doc-bar、JSON 空态、
    // 复制/保存的「勾」全都裸着）。显示时机见下面的 revealWindow。
    show: false,
    // 藏起来的这段时间不能是白板：底色跟着系统明暗走，和 titleBarOverlay 同一套。
    backgroundColor: nativeTheme.shouldUseDarkColors ? darkOverlay.bg : lightOverlay.bg,
    titleBarStyle: isWindows ? 'hidden' : 'hiddenInset',
    ...(isWindows
      ? { titleBarOverlay: { ...(nativeTheme.shouldUseDarkColors ? { color: darkOverlay.bg, symbolColor: darkOverlay.symbol } : { color: lightOverlay.bg, symbolColor: lightOverlay.symbol }), height: TITLEBAR_HEIGHT } }
      : {}),
    trafficLightPosition: { x: 16, y: 14 },
    // Windows only: the menu bar is the second of the three bars, so it starts
    // hidden and Alt still reveals it the way Windows users expect. The row gets
    // its own menu button, which pops the same menu.
    ...(isWindows ? { autoHideMenuBar: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Dev 模式渲染页来自 http://localhost，而本地图片是 file:// URL；
      // Electron 默认 webSecurity 会拦截跨源加载，导致图片不显示。
      // 生产环境用 loadFile 从 file:// 加载，同源无需关闭。
      webSecurity: app.isPackaged,
      // No spellcheck UI in ColaMD — avoid red squiggles in the editor (issue #7)
      spellcheck: false
    }
  })
  markStartup('window-created')

  // 露脸的时机：渲染端自己报就绪（renderer-ready，样式至此一定已注入）与浏览器
  // 首次绘制（ready-to-show）谁先到算谁；两条路都断了（页面加载失败 / 脚本崩）
  // 就靠超时兜底，否则用户会以为程序没启动。
  let revealed = false
  const revealTimer = setTimeout(revealWindow, 5000)
  function revealWindow(): void {
    if (revealed || win.isDestroyed()) return
    revealed = true
    clearTimeout(revealTimer)
    win.show()
  }
  getState(win).reveal = revealWindow
  win.once('ready-to-show', revealWindow)

  // The renderer owns the shell's layout, so it needs to know when the window
  // enters or leaves macOS full screen: full screen takes the traffic lights
  // away, and the 96px they occupy has to go with them.
  const sendFullscreen = (isFullscreen: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen-changed', isFullscreen)
  }
  win.on('enter-full-screen', () => sendFullscreen(true))
  win.on('leave-full-screen', () => sendFullscreen(false))
  // 换窗口聚焦时打印项的可用状态可能不同（一个窗口在 canvas 标签页、另一个在
  // 文档上）：同步一次，状态没变不会重建菜单。
  win.on('focus', () => syncPrintMenuState())

  const state = getState(win)
  if (initialBrowsePath) state.browsePath = initialBrowsePath
  // 所有窗口加载同一份 index.html、同一个入口：PDF 对照不再是「另一种窗口」，
  // 而是窗口里的一个标签页，由渲染端的标签页逻辑把外壳换成左右分栏。
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('did-finish-load', () => {
    markStartup('renderer-loaded')
    // The zoom level lives on the webContents, so a new window has to be told.
    if (typeof savedWindowState.zoom === 'number' && savedWindowState.zoom > 0) {
      win.webContents.setZoomFactor(savedWindowState.zoom)
    }
    const deliver = (): void => {
      if (filePath) {
        // The queued tab-opens must go out only after this document's
        // 'file-opened', otherwise both land in the same tab.
        void loadFileInWindow(win, filePath).then(() => {
          getState(win).initialDocDelivered = true
          flushPendingTabFiles(win)
        })
      } else if (initialContent) {
        // In-memory content (e.g. the Markdown cheatsheet) — no file, no watcher
        win.webContents.send('file-opened', { path: null, content: initialContent })
        getState(win).initialDocDelivered = true
        flushPendingTabFiles(win)
      } else {
        getState(win).initialDocDelivered = true
        flushPendingTabFiles(win)
      }
    }
    // Wait for the renderer to be listening: a 'file-opened' that arrives
    // before init registers its handlers is dropped, and the window opens
    // empty. Polling here is bounded by the renderer's own init time.
    if (getState(win).rendererReady) {
      deliver()
    } else {
      const poll = setInterval(() => {
        if (win.isDestroyed() || getState(win).rendererReady) {
          clearInterval(poll)
          if (!win.isDestroyed()) deliver()
        }
      }, 30)
      // Unstoppable safety net: never block delivery forever.
      setTimeout(() => {
        clearInterval(poll)
        if (!win.isDestroyed() && !getState(win).initialDocDelivered) deliver()
      }, 10_000)
    }
  })

  // Remember the window's own geometry, so the next launch opens where this one
  // was left instead of at the default size (#95).
  win.on('resize', () => scheduleWindowStateSave(win))
  win.on('move', () => scheduleWindowStateSave(win))
  win.on('close', () => saveWindowState(win))

  // Intercept window close: confirm unsaved changes before the window dies.
  // cmd+w (role: 'close') and quit both funnel through here.
  win.on('close', (e) => {
    const st = getState(win)
    if (isQuitting || st.closeAuthorized || (!st.rendererReady && !st.dirty)) return
    e.preventDefault()
    void confirmWindowClose(win, st).then((ok) => {
      if (ok && !win.isDestroyed()) {
        st.closeAuthorized = true
        win.close()
      }
    })
  })

  win.on('closed', () => {
    stopWatching(state)
    windowStates.delete(win.id)
  })

  updateTitle(win)
  return win
}

// 「文件 → PDF转md」：在当前窗口开一个空的对照标签页（左 PDF / 右编辑器），PDF
// 由用户在标签页里点「打开 PDF…」选。以前是为此单开一个窗口，现在窗口里多一个
// 标签页就够（选文件那一步仍在主进程的 pick-pdf-file 里）。
// 没有窗口可发时（macOS 关完窗口菜单还在）先建一个，请求存进窗口状态，等渲染端
// 就绪补发 —— 直接 send 会打在还没监听的渲染端上。
function importPdfDocument(): void {
  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) {
    getState(createWindow()).pendingPdfTab = true
    return
  }
  const state = getState(win)
  if (!state.rendererReady || !state.initialDocDelivered) {
    state.pendingPdfTab = true
    return
  }
  win.webContents.send('menu-pdf-tab')
}

// 「文件 → 图片转md」：在当前窗口开一个标签页（左图片预览 / 右编辑器），图片由
// 用户在标签页里点「选择图片…」选，转换走与 PDF 同一套 MinerU 在线解析（服务
// 端认 PDF 也认图片）。时机与上面那条完全一样。
function importImageDocument(): void {
  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) {
    getState(createWindow()).pendingImageTab = true
    return
  }
  const state = getState(win)
  if (!state.rendererReady || !state.initialDocDelivered) {
    state.pendingImageTab = true
    return
  }
  win.webContents.send('menu-image-tab')
}

// 「文件 → 新建md文件」：在当前窗口开一个空的 Markdown 标签页（不是新窗口）。
// 窗口一个都没有时就先建一个 —— 新窗口首屏本来就带一个空文档标签页，正好就是
// 用户要的东西，所以这条分支不需要再补发 IPC；窗口还没就绪时同理，直接返回。
function openNewDocumentTab(): void {
  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) {
    createWindow()
    return
  }
  const state = getState(win)
  if (!state.rendererReady || !state.initialDocDelivered) return
  win.webContents.send('menu-new-tab')
}

function updateTitle(win: BrowserWindow): void {
  const state = getState(win)
  const fileName = state.filePath ? basename(state.filePath) : 'Untitled'
  win.setTitle(`${fileName} — Teyoo`)
}

function suggestFileName(win: BrowserWindow, content?: string): string | undefined {
  const state = getState(win)
  if (state.filePath) return basename(state.filePath, '.md')
  // PDF 对照标签页：默认就用源文件的同名 md，这样下次开该 PDF 能直接带出来。
  if (state.pdfPath) return basename(state.pdfPath, extname(state.pdfPath))
  // 图片转md 同一条规则：存出来的 md 与源图同名（xxx.png → xxx.md）。
  if (state.imagePath) return basename(state.imagePath, extname(state.imagePath))
  if (!content) return undefined
  // Extract first heading or first non-empty line
  const match = content.match(/^#\s+(.+)/m) || content.match(/^(.+)/m)
  if (!match) return undefined
  return match[1].trim().replace(/[/\\:*?"<>|]/g, '').slice(0, 60) || undefined
}

// Save dialogs should open beside the currently edited Markdown file. When
// the document is still untitled there is no meaningful sibling directory, so
// Electron keeps its normal platform-specific default (typically Documents).
// ── 文件对话框的默认目录 ────────────────────────────────────────────────────
// 打开 / 导入 / 保存 / 导出一律从同一个地方起步：偏好里的「工作目录」→ 没设就
// 用程序默认目录 D:\TeyooData → 两者都不可用时退回 %APPDATA%\<AppName>（app 的
// userData，一定存在）。目录不存在（没插盘 / 被删）先补建一次，建不出来（无
// 权限）才回退；回退是静默的，只在控制台留一行。
// 结果按「偏好里配置的那个值」缓存：偏好没改就不重复试探磁盘。
let cachedDirKey = ''
let cachedDirValue = ''

// mode 区分两类对话框：保存 / 导出要能写（目录不在就补建）；打开 / 导入只要能读
// （不给用户凭空造目录，读不到就回退）。
function usableDir(dir: string, mode: 'read' | 'write'): boolean {
  try {
    // 目录已存在时 recursive mkdir 是空操作；不存在才真正建。
    if (mode === 'write') mkdirSync(dir, { recursive: true })
    accessSync(dir, mode === 'write' ? constants.W_OK : constants.R_OK)
    return true
  } catch {
    return false
  }
}

function defaultDialogDir(mode: 'read' | 'write' = 'write'): string {
  const configured = getUserSettingByPath<string>('image.workDir') || DEFAULT_WORK_DIR
  const key = `${mode}:${configured}`
  if (key === cachedDirKey && cachedDirValue) return cachedDirValue
  const resolved = usableDir(configured, mode) ? configured : app.getPath('userData')
  if (resolved !== configured) {
    console.info(`[dialog] 工作目录不可用（${configured}），改用 ${resolved}`)
  } else if (startupTraceEnabled) {
    // 排查用：COLAMD_STARTUP_TRACE=1 时能看到每个对话框实际落在哪儿。
    console.info(`[dialog] 默认目录（${mode}）：${resolved}`)
  }
  cachedDirKey = key
  cachedDirValue = resolved
  return resolved
}

/** 保存/导出对话框的默认路径：默认目录 + 文档名（扩展名交给对话框过滤器补）。 */
function defaultSavePath(win: BrowserWindow, fileName?: string, ext?: string): string {
  const name = fileName ?? suggestFileName(win) ?? 'untitled'
  return join(defaultDialogDir(), ext ? `${name}.${ext}` : name)
}

function stopWatching(state: WindowState): void {
  if (state.watcher) {
    state.watcher.close()
    state.watcher = null
  }
}

function watchFile(win: BrowserWindow, state: WindowState): void {
  if (!state.filePath) return
  if (state.watcher) {
    state.watcher.close()
    state.watcher = null
  }

  const filePath = state.filePath
  const dir = dirname(filePath)
  const fileName = basename(filePath)
  // macOS FSEvents replays recent history when a watcher starts; drop events
  // fired within this window so opening a file doesn't trigger a spurious reload.
  let suppressUntil = 0

  const scheduleReload = (): void => {
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(() => {
      readFile(filePath, 'utf-8')
        .then((data) => {
          // Our own writes echo back through FSEvents long after the internal
          // save window closes; reloading them would revert the editor and
          // wipe anything typed since the save. Skip self-echoes.
          if (state.lastInternalSaveContent !== null && data === state.lastInternalSaveContent) return
          state.lastInternalSaveContent = null
          state.lastKnownMtime = fileMtimeMs(filePath)
          if (!win.isDestroyed()) win.webContents.send('file-changed', resolveImagePaths(data, filePath))
        })
        .catch(() => { /* file mid-replace; a follow-up event will re-trigger */ })
    }, 100)
  }

  const onExternalChange = (): void => {
    if (state.isInternalSave) return
    if (Date.now() < suppressUntil) return

    scheduleReload()
  }

  // Agent created/renamed/deleted a sibling file — refresh the file panel list
  const scheduleSiblingsRefresh = (): void => {
    if (state.siblingsTimer) clearTimeout(state.siblingsTimer)
    state.siblingsTimer = setTimeout(() => {
      state.siblingsTimer = null
      if (state.filePath !== filePath) return // file switched meanwhile; new watcher handles it
      listSiblingFiles(filePath, state.browsePath ?? dirname(filePath)).then((files) => {
        if (!win.isDestroyed()) win.webContents.send('siblings-changed', files)
      })
    }, 300)
  }

  const establish = (): void => {
    if (state.filePath !== filePath) return
    suppressUntil = Date.now() + 300
    if (state.watcher) {
      state.watcher.close()
      state.watcher = null
    }
    try {
      // Watch the parent directory instead of the file: agents often save
      // atomically (write temp + rename over), which replaces the file's
      // inode and silently kills a watcher bound to the old file. A
      // directory watcher survives those and keeps reporting our filename.
      const watcher = watch(dir, (eventType, filename) => {
        if (state.isInternalSave) return
        // filename may be null on some platforms — treat as our file
        if (filename !== null && filename !== fileName) {
          // A sibling file changed (agent created / renamed / deleted it)
          if (MARKDOWN_EXTENSIONS.includes(extname(filename).toLowerCase())) {
            scheduleSiblingsRefresh()
          }
          return
        }

        if (eventType === 'rename') {
          // Atomic save / file replacement. The dir watcher itself stays
          // valid, but re-establish anyway to cover platform quirks.
          onExternalChange()
          if (filename === fileName && existsSync(filePath)) establish()
        } else if (eventType === 'change') {
          onExternalChange()
        }
      })
      watcher.on('error', () => {
        // Watcher died (directory removed, permissions…). Retry so we
        // recover automatically when the file comes back.
        establish()
      })
      state.watcher = watcher
    } catch {
      // Fallback: watch the file directly if the directory isn't watchable
      try {
        const watcher = watch(filePath, (eventType) => {
          if (eventType !== 'change' || state.isInternalSave) return
          onExternalChange()
        })
        watcher.on('error', () => establish())
        state.watcher = watcher
      } catch { /* file not watchable; nothing to do */ }
    }
  }

  establish()
}

// Rewrite local image paths to encoded file:// URLs. This handles both
// standard Markdown images and the raw <img src="..."> HTML that Milkdown
// accepts, including Windows drive letters, backslashes, spaces and Unicode.
function localImageUrl(src: string, dir: string): string {
  const value = src.trim().replace(/^<|>$/g, '')
  if (/^(?:https?:|file:|data:|blob:)/i.test(value)) return src
  return pathToFileURL(isAbsolute(value) ? value : resolve(dir, value)).href
}

// 从 `![alt](...)` 的 `(...)` 内容中分离 URL 与可选 title。
// 之前的实现把 `[^)]+` 整体当作 URL 传给 localImageUrl，导致
// `C:\path "title"` 被整体 pathToFileURL 编码、title 被拼进 URL；
// 重新解析时 title 又被解码回 src 字符串，使 src 含空格，
// 触发 remark-stringify 的角括号包裹（[<url "title">]），表现为
// 「程序莫名其妙给图片加尖括号」。
// 本函数支持三种形态：裸 URL / 裸 URL + "title" / <url> + "title"。
function parseImageDestination(content: string): { url: string; title: string | null } {
  const trimmed = content.trim()
  // 角括号 URL：<url> 可选 "title"
  const angleMatch = trimmed.match(/^<([^>]*)>(?:\s+"([^"]*)")?\s*$/)
  if (angleMatch) {
    return { url: angleMatch[1].trim(), title: angleMatch[2] ?? null }
  }
  // 裸 URL：第一段非空白为 url，可选 "title"
  const nakedMatch = trimmed.match(/^(\S+)(?:\s+"([^"]*)")?\s*$/)
  if (nakedMatch) {
    return { url: nakedMatch[1], title: nakedMatch[2] ?? null }
  }
  // 兜底：整段当作 URL
  return { url: trimmed, title: null }
}

// 重新拼装 `![alt](url "title")`，保留 title（若有）。URL 若含空格/括号
// 会被 markdownImagePath 自动加角括号；title 始终在 URL 之外、引号之内。
function assembleImageMarkdown(alt: string, url: string, title: string | null): string {
  const wrapped = markdownImagePath(url)
  return title !== null
    ? `![${alt}](${wrapped} "${title}")`
    : `![${alt}](${wrapped})`
}

function resolveImagePaths(content: string, filePath: string): string {
  const dir = dirname(filePath)
  const markdown = content.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_match, alt, dest) => {
    const { url, title } = parseImageDestination(dest)
    // 只处理本地路径；http/file/data/blob URL 原样保留（localImageUrl 内部也会判）
    const value = url.trim().replace(/^<|>$/g, '')
    if (/^(?:https?:\/\/|file:\/\/|data:|blob:)/i.test(value)) {
      return assembleImageMarkdown(alt, url, title)
    }
    return assembleImageMarkdown(alt, localImageUrl(url, dir), title)
  })

  return markdown.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (_match, prefix, quote, src) => {
    return `${prefix}${quote}${localImageUrl(src, dir)}${quote}`
  })
}

// Keep the editor's display URLs out of the Markdown source. Image paths are
// rewritten to file:// URLs for rendering, then converted back to paths that
// are portable relative to the file being saved.
function sourceImageUrl(src: string, dir: string): string {
  const value = src.trim()
  if (!/^file:/i.test(value)) return src

  try {
    const target = fileURLToPath(value)
    const portable = relative(dir, target).replaceAll('\\', '/')
    return portable || './'
  } catch {
    return src
  }
}

function markdownImagePath(value: string): string {
  return /[\s()]/.test(value) ? `<${value}>` : value
}

function restoreImagePaths(content: string, filePath: string): string {
  const dir = dirname(filePath)
  const markdown = content.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_match, alt, dest) => {
    const { url, title } = parseImageDestination(dest)
    // 只处理 file: URL；其他原样保留
    if (!/^file:/i.test(url.trim())) {
      return _match
    }
    return assembleImageMarkdown(alt, sourceImageUrl(url, dir), title)
  })

  return markdown.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])(file:[^"']+)\2/gi, (_match, prefix, quote, src) => {
    return `${prefix}${quote}${sourceImageUrl(src, dir)}${quote}`
  })
}

function loadFileInWindow(win: BrowserWindow, filePath: string): Promise<void> {
  const state = getState(win)
  const operation = async (): Promise<void> => {
    try {
      const data = await readFile(filePath, 'utf-8')
      if (win.isDestroyed()) return
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(filePath, true)
      state.lastInternalSaveContent = data
      state.lastKnownMtime = fileMtimeMs(filePath)
      win.webContents.send('file-opened', { path: filePath, content: resolveImagePaths(data, filePath) })
    } catch {
      // Keep the current document when the selected file cannot be read.
    }
  }
  const next = state.writeQueue.then(operation, operation)
  state.writeQueue = next.then(() => undefined, () => undefined)
  return next
}

// Find window that already has this file open, either as its active document or
// in one of its tabs.
function findWindowForFile(filePath: string): BrowserWindow | null {
  for (const [id, state] of windowStates) {
    if (state.filePath === filePath || state.tabFiles.includes(filePath)) {
      const win = BrowserWindow.fromId(id)
      if (win && state.filePath !== filePath) win.webContents.send('focus-file', filePath)
      return win
    }
  }
  return null
}

// A document that is already open — in another window, or in a background tab of
// this one — is focused rather than opened a second time: a second copy gets its
// own watcher and its own write queue, so the later save silently wins over the
// earlier one. Returns true when some window already holds the file (it has been
// focused, and told to raise the tab that holds it).
function focusWindowHoldingFile(filePath: string): boolean {
  const holder = findWindowForFile(filePath)
  if (!holder) return false
  holder.focus()
  return true
}

// The focused window, or the most recently created one when nothing is
// focused (e.g. the user clicked a dock icon). Used to decide where documents
// arriving from outside the window land.
function focusedOrLastWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  const windows = BrowserWindow.getAllWindows()
  for (let i = windows.length - 1; i >= 0; i--) {
    if (!windows[i].isDestroyed()) return windows[i]
  }
  return null
}

// Hand a file to a window as a new tab. Until the renderer is up AND its
// opening document has been delivered it cannot process the request, so park
// it and flush later.
function openFileAsTab(target: BrowserWindow, filePath: string): void {
  const state = getState(target)
  if (!state.rendererReady || !state.initialDocDelivered) {
    state.pendingTabFiles.push(filePath)
    return
  }
  target.webContents.send('open-in-new-tab', filePath)
}

function flushPendingTabFiles(win: BrowserWindow): void {
  const state = getState(win)
  if (!state.rendererReady || !state.initialDocDelivered) return
  const queued = state.pendingTabFiles.splice(0)
  for (const fp of queued) win.webContents.send('open-in-new-tab', fp)
  // 建窗期间点过「PDF转md」的（无窗口可发那条路）在这里补发。
  if (state.pendingPdfTab) {
    state.pendingPdfTab = false
    win.webContents.send('menu-pdf-tab')
  }
  // 「图片转md」同上。
  if (state.pendingImageTab) {
    state.pendingImageTab = false
    win.webContents.send('menu-image-tab')
  }
}

// Open file: reuse existing window, else land as a tab in the current window
// (design.md: files open into the current window, not a new one each time).
function openFile(filePath: string): void {
  // If already open, focus that window
  if (focusWindowHoldingFile(filePath)) return

  // Find an untitled empty window to reuse
  const emptyWin = findEmptyWindow()
  if (emptyWin) {
    loadFileInWindow(emptyWin, filePath)
    emptyWin.focus()
    return
  }

  // The document is open nowhere: it becomes a new tab of the window the user
  // is in, instead of one more window on the pile (#99).
  const target = focusedOrLastWindow()
  if (target) {
    openFileAsTab(target, filePath)
    if (target.isMinimized()) target.restore()
    target.focus()
    return
  }

  // Create new window
  const win = createWindow(filePath)
  win.focus()
}

function findEmptyWindow(): BrowserWindow | null {
  for (const [id, state] of windowStates) {
    if (!state.filePath) {
      return BrowserWindow.fromId(id) || null
    }
  }
  return null
}

// Serialize writes per window. A save is valid only while its source document
// remains active; stale queued work must neither overwrite window state nor
// make a later document appear saved.
function saveToPath(win: BrowserWindow, filePath: string, content: string, sourcePath: string | null, rebuildMenu = false): Promise<boolean> {
  const state = getState(win)
  const operation = async (): Promise<boolean> => {
    if (win.isDestroyed() || state.filePath !== sourcePath) return false
    try {
      state.internalSaveCount += 1
      state.isInternalSave = true
      const dataToWrite = restoreImagePaths(content, filePath)
      await writeFile(filePath, dataToWrite, 'utf-8')
      state.lastInternalSaveContent = dataToWrite
      state.lastKnownMtime = fileMtimeMs(filePath)
      if (win.isDestroyed() || state.filePath !== sourcePath) return false
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(filePath, rebuildMenu)
      return true
    } catch {
      return false
    } finally {
      setTimeout(() => {
        state.internalSaveCount = Math.max(0, state.internalSaveCount - 1)
        state.isInternalSave = state.internalSaveCount > 0
      }, 100)
    }
  }
  const next = state.writeQueue.then(operation, operation)
  state.writeQueue = next.then(() => undefined, () => undefined)
  return next
}

// IPC Handlers

ipcMain.on('open-external', (_event, url: string) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url)
  }
})

ipcMain.handle('get-file-manager-name', () => fileManagerName())

// Renderer clipboard reads have no transient user activation when the request
// comes from a menu accelerator, so the link command reads it in the main
// process (review on #87).
ipcMain.handle('read-clipboard-text', () => clipboard.readText())

// Electron 44 rebuilt the clipboard on the W3C API, so writes return a promise
// at runtime, while the shipped types still declare void. A rejected write must
// not surface as an unhandled rejection: node terminates the process on those.
function copyToClipboard(text: string): void {
  const write = clipboard.writeText(text) as unknown as Promise<void> | undefined
  void write?.catch((err: unknown) => { console.error('clipboard write failed:', err) })
}

function fileManagerName(): 'finder' | 'explorer' | 'file-manager' {
  if (process.platform === 'darwin') return 'finder'
  if (process.platform === 'win32') return 'explorer'
  return 'file-manager'
}

function revealLabel(zh: boolean): string {
  return fileManagerName() === 'explorer'
    ? (zh ? '在资源管理器中显示' : 'Reveal in File Explorer')
    : (zh ? '在 Finder 中显示' : 'Reveal in Finder')
}

// Right-click menu for a tab: the closing actions, plus the path actions that
// make sense for the document in it. Same native menu as the file list.
ipcMain.handle('tab-context-menu', (event, payload: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof payload !== 'object' || payload === null) return
  const { tabId, filePath, canCloseOthers, canCloseRight } = payload as Record<string, unknown>
  if (typeof tabId !== 'string' || tabId.length === 0) return
  const zh = getPreferredLanguage() === 'zh'
  const send = (action: string) => win.webContents.send('tab-menu-action', { action, tabId })
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: zh ? '关闭' : 'Close', click: () => send('close') }
  ]
  if (canCloseOthers === true) {
    items.push({ label: zh ? '关闭其他标签页' : 'Close Other Tabs', click: () => send('close-others') })
  }
  if (canCloseRight === true) {
    items.push({ label: zh ? '关闭右侧标签页' : 'Close Tabs to the Right', click: () => send('close-right') })
  }
  if (typeof filePath === 'string' && filePath.length > 0) {
    items.push({ type: 'separator' })
    // The rest of the menu sends actions back to the renderer; this one is a
    // main-process job, so it runs here and needs no round trip.
    items.push({
      label: zh ? '在新窗口打开' : 'Open in New Window',
      click: () => {
        const opened = createWindow(filePath)
        opened.focus()
      }
    })
    items.push({ label: zh ? '复制路径' : 'Copy path', click: () => copyToClipboard(filePath) })
    items.push({ label: revealLabel(zh), click: () => shell.showItemInFolder(filePath) })
  }
  Menu.buildFromTemplate(items).popup({ window: win })
})

// Right-click menu for a file panel entry. Native menu on purpose: no custom
// popup to theme, keep it accessible and platform familiar.
ipcMain.handle('entry-context-menu', (event, targetPath: unknown, kind: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof targetPath !== 'string' || targetPath.length === 0) return
  const zh = getPreferredLanguage() === 'zh'
  const items: Electron.MenuItemConstructorOptions[] = []
  if (kind !== 'directory') {
    // First item: opening a document in its own tab is the reason this menu is
    // reached for (design.md).
    items.push({
      label: zh ? '在新标签页打开' : 'Open in New Tab',
      click: () => {
        const state = getState(win)
        // Tabs live in the renderer, so the menu only reports the intent.
        if (state.filePath === targetPath) return
        win.webContents.send('open-in-new-tab', targetPath)
      }
    })
    items.push({ type: 'separator' })
  }
  items.push({ label: zh ? '复制路径' : 'Copy path', click: () => copyToClipboard(targetPath) })
  if (kind !== 'directory') {
    items.push({ label: zh ? '用默认应用打开' : 'Open in default app', click: () => { void shell.openPath(targetPath) } })
  }
  items.push({
    label: revealLabel(zh),
    click: () => shell.showItemInFolder(targetPath)
  })
  Menu.buildFromTemplate(items).popup({ window: win })
})

// 编辑区右键菜单（#editor 的所见即所得区与 #source-editor 源码框）。
// Electron 不提供默认上下文菜单，编辑区此前完全没有复制/粘贴入口；这里用
// 原生菜单补齐，编辑类命令一律走 role（作用于当前聚焦窗口的 webContents），
// 与标签栏/文件面板的右键菜单同一套原生外观。
ipcMain.handle('editor-context-menu', (event, payload: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof payload !== 'object' || payload === null) return
  const { editable, hasSelection } = payload as Record<string, unknown>
  const zh = getPreferredLanguage() === 'zh'
  const canEdit = editable === true
  const canCopy = hasSelection === true
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: zh ? '撤销' : 'Undo', role: 'undo', enabled: canEdit },
    { label: zh ? '重做' : 'Redo', role: 'redo', enabled: canEdit },
    { type: 'separator' },
    { label: zh ? '剪切' : 'Cut', role: 'cut', enabled: canEdit && canCopy },
    { label: zh ? '复制' : 'Copy', role: 'copy', enabled: canCopy },
    { label: zh ? '粘贴' : 'Paste', role: 'paste', enabled: canEdit },
    { label: zh ? '删除' : 'Delete', role: 'delete', enabled: canEdit && canCopy },
    { type: 'separator' },
    { label: zh ? '全选' : 'Select All', role: 'selectAll', enabled: canEdit }
  ]
  Menu.buildFromTemplate(items).popup({ window: win })
})

ipcMain.handle('reveal-file', (event) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const filePath = getState(win).filePath
  if (!filePath) return false
  try {
    shell.showItemInFolder(filePath)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('open-file', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile'],
    // 和导入 / 保存 / 导出同一条规则：一律从工作目录起步。偏好里的
    // 「启动 → 打开指定文件夹」只决定启动时开什么，不插队到打开对话框。
    defaultPath: defaultDialogDir('read')
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const filePath = result.filePaths[0]

  // A window with no file used to load in place unconditionally, which skipped
  // the dedupe above: a document already open in another window (or in a
  // background tab of this one) was opened a second time, with its own watcher
  // and write queue. Hand it to whoever already holds it first.
  if (focusWindowHoldingFile(filePath)) return null

  // If this window has no file, load here; otherwise open in new window
  const state = getState(win)
  if (!state.filePath) {
    try {
      const content = await readFile(filePath, 'utf-8')
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(filePath, true)
      state.lastInternalSaveContent = content
      win.webContents.send('file-opened', { path: filePath, content: resolveImagePaths(content, filePath) })
      return { path: filePath, content }
    } catch {
      return null
    }
  } else {
    openFile(filePath)
    return null
  }
})

ipcMain.handle('open-file-path', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)

  // Same rule as the dialog above: never open a second copy of a document some
  // window already holds.
  if (focusWindowHoldingFile(filePath)) return null

  // If this window has no file, load here
  if (!state.filePath) {
    try {
      const content = await readFile(filePath, 'utf-8')
      state.filePath = filePath
      state.browsePath = dirname(filePath)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(filePath, true)
      state.lastInternalSaveContent = content
      win.webContents.send('file-opened', { path: filePath, content: resolveImagePaths(content, filePath) })
      return { path: filePath, content }
    } catch {
      return null
    }
  } else {
    openFile(filePath)
    return null
  }
})

// Switch the window's active document without touching the renderer's content.
// Tabs keep their own editor state in the renderer, so this only re-points what
// belongs to the window: watcher, title, recent list and file panel. The disk
// version is returned so the caller can tell whether it changed while this tab
// was in the background. Passing null (or an empty string) means the active
// document is untitled, which must clear the window's file binding: otherwise a
// save of that untitled document would be written into the previous file.
ipcMain.handle('activate-file', async (event, filePath: unknown) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  if (filePath !== null && filePath !== '' && typeof filePath !== 'string') return null
  const target = typeof filePath === 'string' && filePath.length > 0 ? filePath : null
  const state = getState(win)
  const operation = async (): Promise<{ content: string; mtime: number } | null> => {
    if (!target) {
      stopWatching(state)
      state.filePath = null
      state.lastInternalSaveContent = null
      state.lastKnownMtime = 0
      updateTitle(win)
      return null
    }
    try {
      const data = await readFile(target, 'utf-8')
      if (win.isDestroyed()) return null
      state.filePath = target
      state.browsePath = dirname(target)
      state.lastInternalSaveContent = data
      state.lastKnownMtime = fileMtimeMs(target)
      watchFile(win, state)
      updateTitle(win)
      pushRecentFile(target, true)
      return { content: resolveImagePaths(data, target), mtime: state.lastKnownMtime }
    } catch {
      return null
    }
  }
  const next = state.writeQueue.then(operation, operation)
  state.writeQueue = next.then(() => undefined, () => undefined)
  return next
})

// Same-directory file panel: list markdown files next to the open file
ipcMain.handle('list-siblings', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)
  return listSiblingFiles(state.filePath, state.browsePath ?? undefined)
})

// Expanding a directory in the file panel reads that one directory.
ipcMain.handle('list-directory', async (_event, dirPath: unknown) => {
  if (typeof dirPath !== 'string' || !dirPath) return null
  return listDirectoryChildren(dirPath)
})

// Open a Markdown file, or walk the panel's root back up, from the file panel.
ipcMain.handle('open-sibling', async (event, filePath: string) => {
  const win = getWinFromEvent(event)
  if (!win || typeof filePath !== 'string') return false
  try {
    const info = await stat(filePath)
    const state = getState(win)
    if (info.isDirectory()) {
      state.browsePath = filePath
      const files = await listSiblingFiles(state.filePath, filePath)
      if (!win.isDestroyed()) win.webContents.send('siblings-changed', files)
      return true
    }
    // Already open in another tab of this window: focus that tab instead of
    // loading the same file twice.
    if (state.tabFiles.includes(filePath) && state.filePath !== filePath) {
      win.webContents.send('focus-file', filePath)
      return true
    }
  } catch {
    return false
  }
  loadFileInWindow(win, filePath)
  return true
})

ipcMain.on('set-tab-files', (event, paths: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const state = getState(win)
  state.tabFiles = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
})

ipcMain.handle('save-file', async (event, content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const state = getState(win)
  const sourcePath = state.filePath
  // The caller states which document this content belongs to; '' means untitled.
  // Comparing strictly (rather than only when a path is given) is what stops a
  // save from landing in whatever file the window happened to open last.
  if (typeof expectedPath === 'string' && sourcePath !== (expectedPath.length > 0 ? expectedPath : null)) return null
  let filePath = sourcePath
  if (!filePath) {
    const result = await dialog.showSaveDialog(win, {
      title: uiText('保存 Markdown 文档', 'Save Markdown document'),
      buttonLabel: uiText('保存', 'Save'),
      nameFieldLabel: uiText('文件名：', 'File name:'),
      defaultPath: defaultSavePath(win, suggestFileName(win, content)),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    filePath = result.filePath
  }
  // Auto-save never overwrites an edit that landed after our last read or
  // write: the watcher can miss it (an event during our own write is dropped as
  // a self-echo), so probe the mtime and let the user decide instead. A manual
  // save keeps the old behavior, because the user asked for it explicitly.
  if (autosave && fileChangedExternally(filePath, state)) {
    notifyExternalChange(win, filePath)
    return null
  }
  const ok = await saveToPath(win, filePath, content, sourcePath, rebuildMenu ?? false)
  return ok ? filePath : null
})

ipcMain.handle('save-file-as', async (event, content: string, expectedPath?: string) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const sourcePath = getState(win).filePath
  if (typeof expectedPath === 'string' && sourcePath !== (expectedPath.length > 0 ? expectedPath : null)) return null
  const result = await dialog.showSaveDialog(win, {
    title: uiText('另存为', 'Save As'),
    buttonLabel: uiText('保存', 'Save'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: defaultSavePath(win, suggestFileName(win, content)),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return null
  const ok = await saveToPath(win, result.filePath, content, sourcePath, true)
  return ok ? result.filePath : null
})

ipcMain.handle('export-docx', async (event, content: unknown, formulaEngine?: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof content !== 'string') return false
  win.show()
  win.focus()
  const baseName = suggestFileName(win, content) ?? 'untitled'
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出 Word 文档', 'Export Word document'),
    buttonLabel: uiText('导出', 'Export'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: defaultSavePath(win, baseName, 'docx'),
    filters: [{ name: 'Word Document', extensions: ['docx'] }]
  })
  if (result.canceled || !result.filePath) return false
  try {
    const { markdownToDocx } = await import('./docx-export')
    // 渲染端传来的偏好是 'Temml' / 'MathJax'（设置面板下拉里 Temml 显示为
    // KaTeX），映射成注册表 id（'temml' / 'mathjax'）；渲染端没传时
    // fallback 读主进程 userSetting，这样即使渲染端没参与偏好管理（如旧版本）
    // 也能正常按偏好导出。
    const displayName = typeof formulaEngine === 'string'
      ? formulaEngine
      : getUserSettingByPath<string>('export.formulaEngine') ?? 'MathJax'
    const formulaConverter = displayName === 'MathJax' ? 'mathjax' : 'temml'
    await writeFile(result.filePath, await markdownToDocx({ content, sourcePath: getState(win).filePath, formulaConverter }))
    shell.showItemInFolder(result.filePath)
    return true
  } catch (error) {
    console.error('Word export failed', error)
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法导出 Word 文档', 'Could not export the Word document'),
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  }
})

// 导入 .docx 文档 → Markdown。主进程负责弹文件对话框 + 调用 mammoth 转换，
// 转换结果通过 file-opened 事件发给 renderer，与普通 .md 打开走同一条渲染链。
ipcMain.handle('import-docx', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  win.show()
  win.focus()
  const result = await dialog.showOpenDialog(win, {
    title: uiText('导入 Word 文档', 'Import Word document'),
    buttonLabel: uiText('导入', 'Import'),
    filters: [
      { name: 'Word Document', extensions: ['docx'] },
    ],
    properties: ['openFile'],
    defaultPath: defaultDialogDir('read')
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  try {
    const { docxToMarkdown } = await import('./docx-import')
    const imageFormulaOcr = getUserSettingByPath<boolean>('docx.imageFormulaOcr') ?? false
    const formulaOcrUrl = getUserSettingByPath<string>('docx.formulaOcrUrl') ?? ''
    // 默认用内置大模型识别行内公式图片；勾选了「公式 OCR 地址」才走 HTTP 端点。
    const useCustomOcrUrl = getUserSettingByPath<boolean>('docx.useCustomOcrUrl') === true
    // docx-import 只吃字节（它同时要在 WebView2 页面里跑，那里没有 fs）
    const fileBytes = await readFile(filePath)
    const { markdown, warnings } = await docxToMarkdown(fileBytes, {
      imageFormulaOcr,
      formulaOcrUrl,
      recognizeFormula: useCustomOcrUrl
        ? undefined
        : (dataUrl) => recognizeTexoFormula(dataUrl).catch(() => null),
    })
    if (warnings.length > 0) {
      console.warn('[docx-import] warnings:', warnings)
    }
    return { path: filePath, content: markdown }
  } catch (error) {
    console.error('Word import failed', error)
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法导入 Word 文档', 'Could not import the Word document'),
      detail: error instanceof Error ? error.message : String(error),
    })
    return null
  }
})

// ─── 类 docx 文档标签页（canvas-editor）的读写通道 ─────────────────────────
// 画布 ↔ Markdown 的转换在渲染端做（见 renderer/canvas-editor/markdown/，原先
// 用官方插件，它两头都不认 $ 定界符，所以换成自己那份）；主进程这边只管弹系
// 统对话框 + 读写文本。

// 选一个 .md，把文本交给渲染端（渲染端解析成画布元素）
ipcMain.handle('canvas-pick-md', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  win.show()
  win.focus()
  const result = await dialog.showOpenDialog(win, {
    title: uiText('打开 Markdown 文档', 'Open Markdown document'),
    buttonLabel: uiText('打开', 'Open'),
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
    defaultPath: defaultDialogDir('read')
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  try {
    return { path: filePath, content: await readFile(filePath, 'utf-8') }
  } catch (error) {
    console.error('canvas markdown read failed', error)
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法读取 Markdown 文档', 'Could not read the Markdown document'),
      detail: error instanceof Error ? error.message : String(error),
    })
    return null
  }
})

// 选一个画布导出的 .json（「导出 JSON」= getValue() 的 IEditorResult），校验出
// IEditorData 后交给渲染端（渲染端 setValue 整体替换）。JSON.parse / 形状校验
// 放在这一层：出错能弹系统对话框，渲染端拿到的必然可用。
ipcMain.handle('canvas-pick-json', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  win.show()
  win.focus()
  const result = await dialog.showOpenDialog(win, {
    title: uiText('打开 JSON 文档', 'Open JSON document'),
    buttonLabel: uiText('打开', 'Open'),
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
    defaultPath: defaultDialogDir('read')
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  const showError = async (detail: string): Promise<void> => {
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法读取 JSON 文档', 'Could not read the JSON document'),
      detail,
    })
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf-8'))
    // getValue() 导出的顶层是 IEditorResult（带 version/options 包一层 data），
    // 直接认 IEditorData 也可以 —— 手写的极简 JSON 不必凑齐包装。
    const asRecord = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    const inner = asRecord && typeof asRecord.data === 'object' && asRecord.data !== null
      ? asRecord.data as Record<string, unknown>
      : null
    const data =
      Array.isArray(asRecord?.main) ? asRecord
      : Array.isArray(inner?.main) ? inner
      : null
    if (!data) {
      await showError(uiText(
        '不是 canvas-editor 导出的 JSON（缺少 main 元素列表）',
        'Not a canvas-editor JSON (missing the main element list)'
      ))
      return null
    }
    return { path: filePath, data }
  } catch (error) {
    console.error('canvas json read failed', error)
    await showError(error instanceof Error ? error.message : String(error))
    return null
  }
})

// 画布导出的 Markdown 文本落地；返回落盘路径（渲染端拿它开新标签页对照）
ipcMain.handle('canvas-save-md', async (event, content: unknown, fileName?: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || typeof content !== 'string') return null
  const baseName = typeof fileName === 'string' && fileName ? fileName : undefined
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出 Markdown', 'Export Markdown'),
    buttonLabel: uiText('保存', 'Save'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: defaultSavePath(win, baseName, 'md'),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  if (result.canceled || !result.filePath) return null
  try {
    await writeFile(result.filePath, content, 'utf-8')
    shell.showItemInFolder(result.filePath)
    return result.filePath
  } catch (error) {
    console.error('canvas markdown save failed', error)
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法导出 Markdown', 'Could not export the Markdown'),
      detail: error instanceof Error ? error.message : String(error),
    })
    return null
  }
})

// 偏好设置「打开指定文件夹」的「浏览」：选一个目录，返回绝对路径。
ipcMain.handle('pick-directory', async (event, current?: unknown) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const start = typeof current === 'string' && current.length > 0 ? current : undefined
  const result = await dialog.showOpenDialog(win, {
    title: uiText('选择文件夹', 'Choose Folder'),
    buttonLabel: uiText('选择文件夹', 'Choose Folder'),
    properties: ['openDirectory', 'createDirectory'],
    // 浏览工作目录时从工作目录起步（没传起点时）。
    defaultPath: start ?? defaultDialogDir('read')
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// JSON 视图：只读一个文本文件，不碰窗口的文档绑定（既不动标题/最近列表，
// 也不注册监听）。渲染端拿它读 PDF 旁边的同名 .json（sidecar）。
ipcMain.handle('read-text-file', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || !filePath) return null
  try {
    const content = await readFile(filePath, 'utf-8')
    return { path: filePath, content }
  } catch {
    // 没有同名 .json 是常态，不是错误：交给调用方判断。
    return null
  }
})

// MinerU 抽出来的图片 → data URL。渲染端要把它内嵌进 Markdown（转换不是在本
// 地网页里跑，没有同源/协议限制的前提就不能直接 src=file://），render 侧没有
// 读磁盘的权限，只能借主进程读一次。读不到返回 null，由调用方决定退路。
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

/**
 * 按文件头判断真实 MIME。不能只信扩展名：MinerU 抽出来的图经常是 .jpg 的名字
 * 装着 PNG 数据，按扩展名写出去的 data URL 就成了"image/jpeg + PNG 字节"，
 * 编辑器能嗅探显示，导出 Word 时却对不上（见 docx-export 的 sniffImageType）。
 */
function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 3) === 'GIF') return 'image/gif'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'
  return null
}

ipcMain.handle('read-image-as-data-url', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || !filePath) return null
  try {
    const buffer = await readFile(filePath)
    // 文件头优先，扩展名兜底（webp/svg 之类嗅探不到的格式仍按扩展名走）。
    const mime = sniffImageMime(buffer) ?? IMAGE_MIME[extname(filePath).toLowerCase()] ?? 'image/png'
    return { path: filePath, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
  } catch {
    // 图片缺失是常态（老解析结果只有 json 没有 images/）：不是错误。
    return null
  }
})

// JSON 视图的「打开 JSON…」：选一个 .json，连内容一起带回来。
ipcMain.handle('pick-json-file', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: uiText('选择 JSON 文件', 'Choose JSON File'),
    buttonLabel: uiText('打开', 'Open'),
    properties: ['openFile'],
    defaultPath: defaultDialogDir('read'),
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  try {
    return { path: filePath, content: await readFile(filePath, 'utf-8') }
  } catch {
    return null
  }
})

// PDF 对照标签页里的「打开 PDF…」：选一份 PDF，读成字节一起带回去（渲染端
// fetch 不了 file://）。顺带把上一次解析留下的那两份文件路径一起给出。
ipcMain.handle('pick-pdf-file', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: uiText('打开 PDF 文件', 'Open PDF File'),
    buttonLabel: uiText('打开', 'Open'),
    properties: ['openFile'],
    defaultPath: defaultDialogDir('read'),
    filters: [
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  try {
    const bytes = await readFile(filePath)
    // 旁边（或包里）已经解析过就把那两份文件一起带出去，右侧的 Markdown /
    // JSON 才有东西显示。
    return { path: filePath, data: new Uint8Array(bytes), ...findExtractedResult(filePath) }
  } catch {
    return null
  }
})

// 切回一个已经挂着源文件的 PDF 标签页：按路径再读一次字节。切走时渲染端把文档
// 与 worker 都放了，不留常驻内存，所以回来要重新读（文件被挪走/删掉就是 null）。
ipcMain.handle('read-pdf-file', async (_event, pdfPath: unknown): Promise<{ path: string; data: Uint8Array; markdownPath?: string; jsonPath?: string } | null> => {
  if (typeof pdfPath !== 'string' || !pdfPath) return null
  try {
    return { path: pdfPath, data: new Uint8Array(await readFile(pdfPath)), ...findExtractedResult(pdfPath) }
  } catch {
    return null
  }
})

// 「工具箱 → PDF拆分」：按「每 N 页一份」把 PDF 切开，结果写进原文件旁边的
// <原名>_拆分_<日期>/ 目录。真正的活在主进程做（pdf-lib 跑在 Node 侧），渲染端
// 只管把路径与页数递进来、把结果画出来。
ipcMain.handle('split-pdf', async (_event, payload: unknown): Promise<SplitResult> => {
  const { path: sourcePath, pagesPerFile } = (payload ?? {}) as { path?: unknown; pagesPerFile?: unknown }
  if (typeof sourcePath !== 'string' || !sourcePath) return { ok: false, error: 'BAD_PATH' }
  if (typeof pagesPerFile !== 'number') return { ok: false, error: 'INVALID_PAGES' }
  const result = await splitPdfByPageCount(sourcePath, pagesPerFile)
  // 与导出 docx / pdf / 图片同一个习惯：文件写完就在系统文件管理器里亮出来，
  // 用户不用自己去翻那个新建的文件夹。
  if (result.ok && result.dir && result.shards?.length) {
    shell.showItemInFolder(join(result.dir, result.shards[0].name))
  }
  return result
})

// 渲染端上报当前活动标签页挂着的那份 PDF（切到别的标签页就是 null）：只有它
// 知道哪个标签页在前台。「另存为」的默认文件名按它取（见 suggestFileName）。
ipcMain.on('set-active-pdf-path', (event, pdfPath: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  getState(win).pdfPath = typeof pdfPath === 'string' && pdfPath ? pdfPath : null
})

// 图片转md 标签页挂着的那张图片：同一套上报方式、同一个用途（另存为的默认名）。
ipcMain.on('set-active-image-path', (event, imagePath: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  getState(win).imagePath = typeof imagePath === 'string' && imagePath ? imagePath : null
})

// 渲染端上报前台标签页的类型（切标签页时发）。类 docx 文档标签页（canvas-editor）
// 自成一体的那套：打印只走它自己工具栏里那一个（executePrint 把页面渲成图再
// 交给打印），窗口级的 print/printToPDF 对它没有意义 —— 所以菜单栏的打印相关
// 项在这个标签页上前台时一律不生效，并且显示成不可用（见 syncPrintMenuState）。
ipcMain.on('set-active-tab-kind', (event, kind: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const next: ActiveTabKind =
    kind === 'canvas' || kind === 'submit' || kind === 'document' ? kind : 'document'
  const state = getState(win)
  if (state.activeTabKind === next) return
  state.activeTabKind = next
  syncPrintMenuState()
})

// ── 在线解析（MinerU 精准解析 API）───────────────────────────────────────
// 网络与落盘的实现都在 src/main/http/mineru.ts；这里只做窗口侧的编排：取 token、
// 把进度推回发起请求的那个窗口、把解压目录里两份文件的路径交回渲染端。
//
// 结果包原样解压到 PDF 同目录的 <pdf 名>.mineru/，渲染端按路径直接读：
// Markdown 读 full.md、JSON 读 layout.json（不再做 json → md 的转换）。
interface MineruParseResponse {
  ok: boolean
  /** 失败原因；'NO_TOKEN' 是给渲染端识别的约定值 */
  error?: string
  /** 结果包解压出来的目录（<pdf 目录>/<pdf 名>.mineru） */
  extractDir?: string
  /** 目录里的 full.md —— 右侧 Markdown 面板读它 */
  markdownPath?: string
  /** 目录里的中间结果 json —— 右侧 JSON 面板读它 */
  jsonPath?: string
  imageCount?: number
  batchId?: string
}

ipcMain.handle('mineru-parse', async (event, pdfPath: unknown): Promise<MineruParseResponse> => {
  const win = getWinFromEvent(event)
  if (!win) return { ok: false, error: uiText('窗口已关闭', 'Window is closed') }
  // 同一个接口也服务「图片转md」：服务端认 PDF 也认图片，所以这里不再说 PDF。
  if (typeof pdfPath !== 'string' || !pdfPath) {
    return { ok: false, error: uiText('还没有选中文件', 'No file selected yet') }
  }
  // token：环境变量优先（调试/CI 不用改 userSetting.json），其次偏好设置。
  const token =
    (typeof process.env.MINERU_TOKEN === 'string' ? process.env.MINERU_TOKEN.trim() : '') ||
    (getUserSettingByPath<string>('mineru.token') ?? '').trim()
  if (!token) return { ok: false, error: 'NO_TOKEN' }

  const result = await parsePdfOnline({
    filePath: pdfPath,
    token,
    // 结果 CDN 证书过期时的逃生开关（偏好设置里的勾选），详见 http/mineru.ts。
    // 每次调用都现读：勾上后不用重启软件，下一次解析就生效。
    insecureDownload: getUserSettingByPath<boolean>('mineru.insecureDownload') === true,
    onProgress: (progress) => {
      // 窗口可能中途关掉 —— 那时不再推进度，但任务继续跑（已花掉的额度不浪费）。
      if (win.isDestroyed()) return
      win.webContents.send('mineru-progress', progress)
    }
  })
  if (!result.ok) {
    // 超时不是"失败"：任务还在服务端跑，batch_id 交给渲染端提示可以稍后重开窗口再取。
    return { ok: false, error: result.error ?? uiText('解析失败', 'Parsing failed'), batchId: result.batchId }
  }
  return {
    ok: true,
    extractDir: result.extractDir,
    markdownPath: result.markdownPath,
    jsonPath: result.jsonPath,
    imageCount: result.imageCount,
    batchId: result.batchId
  }
})

// 文档助手：把一轮对话发给 OpenAI 兼容端点，拿回完整回答（P0 非流式）。
// 连接信息每次现读偏好设置 —— 改完不用重启。密钥与 mineru.token 同一约定：
// 环境变量 ASSISTANT_API_KEY 优先，只作 Authorization 头，不进日志。
ipcMain.handle('assistant-complete', async (_event, payload: unknown): Promise<ChatResult> => {
  const clean = readAssistantMessages(payload)
  if (!clean) return { ok: false, error: 'BAD_MESSAGES' }
  return completeChat({ ...assistantConnection(), messages: clean })
})

// 文档助手的流式版本：每收到一块就经 assistant-delta 推给发起的那窗口。
// 同一窗口同一时刻只允许一个在跑（发起新的先中止旧的）—— 侧边栏也只有一个输入框。
const assistantStreams = new Map<string, AbortController>()

/** 窗口 + 通道：侧边栏助手与可视化解题各占一条流，互不打断（同一个窗口可以同时跑）。 */
type StreamChannel = 'assistant' | 'solver'
function readStreamChannel(payload: unknown): StreamChannel {
  return (payload as { channel?: unknown })?.channel === 'solver' ? 'solver' : 'assistant'
}
/** 通道 → 用哪套连接信息：可视化解题的字段留空就沿用文档助手的。 */
function streamConnection(channel: StreamChannel): { baseUrl: string; apiKey: string; model: string } {
  return channel === 'solver' ? visualSolveConnection() : assistantConnection()
}

ipcMain.handle('assistant-stream', async (event, payload: unknown): Promise<ChatResult> => {
  const win = getWinFromEvent(event)
  if (!win) return { ok: false, error: 'NO_WINDOW' }
  const clean = readAssistantMessages(payload)
  if (!clean) return { ok: false, error: 'BAD_MESSAGES' }
  const channel = readStreamChannel(payload)
  const key = `${event.sender.id}:${channel}`
  assistantStreams.get(key)?.abort()
  const controller = new AbortController()
  assistantStreams.set(key, controller)
  try {
    return await streamChat(
      { ...streamConnection(channel), messages: clean },
      (chunk) => {
        if (win.isDestroyed()) return
        win.webContents.send('assistant-delta', { text: chunk, channel })
      },
      controller.signal
    )
  } finally {
    if (assistantStreams.get(key) === controller) assistantStreams.delete(key)
  }
})

// 「停止生成」：中止发起窗口那一条流（按通道；其余窗口不受影响）
ipcMain.on('assistant-cancel', (event, payload?: unknown) => {
  assistantStreams.get(`${event.sender.id}:${readStreamChannel(payload)}`)?.abort()
})

// ─── 文档助手：附件与公式识别 ──────────────────────────────────────────
// 附件一律先转成**文本**再进对话（图片→OCR、pdf→MinerU、docx→本地转换、md/txt→直读），
// 这样换任何模型都能用；转换逻辑在 assistant-attach.ts。
function attachmentOptions(): { mineruToken: string; insecureDownload: boolean } {
  return {
    mineruToken: (getUserSettingByPath<string>('mineru.token') ?? '').trim(),
    insecureDownload: getUserSettingByPath<boolean>('mineru.insecureDownload') === true
  }
}

// 「添加附件」：选文件（可多选）→ 转文本。与编辑器插图那个选择器分开：这里 pdf/docx/md
// 都要能选，而且不做"插入正文"的动作。
ipcMain.handle('assistant-pick-attachment', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return []
  const result = await dialog.showOpenDialog(win, {
    title: uiText('选择附件（图片 / PDF / Word / 文本）', 'Choose attachment (image / PDF / Word / text)'),
    buttonLabel: uiText('添加', 'Add'),
    properties: ['openFile', 'multiSelections'],
    defaultPath: defaultDialogDir('read'),
    filters: [
      { name: uiText('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp'] },
      { name: uiText('文档', 'Documents'), extensions: ['pdf', 'docx', 'md', 'markdown', 'txt', 'json', 'csv'] },
      { name: uiText('全部文件', 'All Files'), extensions: ['*'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return []
  const options = attachmentOptions()
  return Promise.all(result.filePaths.map((filePath) => readAttachment(filePath, options)))
})

// 「识别公式」：一张图片 → LaTeX（先 MinerU，失败退本地 OCR 契约）
ipcMain.handle('assistant-ocr-image', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'BAD_PATH' }
  return ocrImageToLatex(filePath, attachmentOptions())
})

// ─── 可视化解题：历史记录 + 另存为 ─────────────────────────────────────
// 历史存在 userData 的独立文件里，**不塞进 userSetting.json** —— 那是设置，会被
// 每次写盘整份重写，塞正文进去既臃肿又容易互相踩。保留最近 N 条，超了丢最老的。
const VISUAL_SOLVE_HISTORY_MAX = 50
function visualSolveHistoryPath(): string {
  return join(app.getPath('userData'), 'visual-solve-history.json')
}
function readVisualSolveHistory(): unknown[] {
  try {
    const parsed = JSON.parse(readFileSync(visualSolveHistoryPath(), 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // 文件不存在 / 坏了都当空历史（不是错误）
    return []
  }
}
function writeVisualSolveHistory(items: unknown[]): void {
  try {
    writeFileSync(visualSolveHistoryPath(), JSON.stringify(items.slice(0, VISUAL_SOLVE_HISTORY_MAX)), 'utf-8')
  } catch {
    /* 写不进去就算了：历史是附赠品，不该打断解题 */
  }
}

ipcMain.handle('visual-solve-history', () => readVisualSolveHistory())

ipcMain.handle('visual-solve-history-add', (_event, entry: unknown) => {
  const item = entry as { id?: unknown; problem?: unknown; answer?: unknown; at?: unknown }
  if (typeof item?.id !== 'string' || typeof item?.problem !== 'string' || typeof item?.answer !== 'string') return false
  const clean = { id: item.id, problem: item.problem.slice(0, 4000), answer: item.answer.slice(0, 200_000), at: Number(item.at) || Date.now() }
  writeVisualSolveHistory([clean, ...readVisualSolveHistory()])
  return true
})

ipcMain.handle('visual-solve-history-clear', () => {
  writeVisualSolveHistory([])
  return true
})

// 「保存为 .md」：解题过程存成文件（弹保存对话框；文件名由渲染端给个建议）
ipcMain.handle('visual-solve-save', async (event, payload: unknown) => {
  const { markdown, name } = (payload ?? {}) as { markdown?: unknown; name?: unknown }
  if (typeof markdown !== 'string' || !markdown.trim()) return { ok: false, error: 'EMPTY' }
  const suggested = typeof name === 'string' && name.trim() ? name.trim() : '可视化解题.md'
  const win = getWinFromEvent(event)
  const options = { defaultPath: suggested, filters: [{ name: 'Markdown', extensions: ['md'] }] }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { ok: false, error: 'CANCELED' }
  try {
    writeFileSync(result.filePath, markdown, 'utf-8')
    return { ok: true, path: result.filePath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// 「粘贴的图片」：剪切板里的图先落成临时文件，再按普通图片附件走
ipcMain.handle('assistant-paste-image', async (_event, dataUrl: unknown) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null
  try {
    return await savePastedImage(dataUrl)
  } catch {
    return null
  }
})

// LaTeX公式：图片 data URL → 本地 Texo 模型识别出的 LaTeX（主进程 onnxruntime-node）
ipcMain.handle('texo-recognize', async (_event, payload: unknown) => {
  const { dataUrl, source } = (payload ?? {}) as { dataUrl?: unknown; source?: unknown }
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null
  try {
    const latex = await recognizeTexoFormula(dataUrl)
    // 认出来就存一条历史：这是识别的唯一入口，手写板与上传图片都经这里，
    // 不必在渲染端各记一次。存失败也不影响这次识别的结果（见 formula-db.ts）。
    if (typeof latex === 'string' && latex.trim()) {
      saveFormulaRecord(latex, typeof source === 'string' ? source : null, dataUrl)
    }
    return latex
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

// 菜单「帮助 → 截屏识别公式…」：藏起自己的窗口抓一屏 → 浮层里框选 → 交回那一块。
// 整个流程收在一次 invoke 里，取消时返回 null（== 用户什么都没选，渲染端不用管）。
ipcMain.handle('snip-start', async (event) => {
  // 发起窗口：浮层关掉之后要把焦点还回去，否则 Windows 上用户会以为程序被自己关掉了
  const origin = BrowserWindow.fromWebContents(event.sender)
  try {
    return await startSnipCapture(origin)
  } catch (error) {
    // 抓屏失败与「用户取消」都返回 null，渲染端不区分这两者，这里记一笔日志
    console.error('[snip] capture failed:', error instanceof Error ? error.message : String(error))
    return null
  }
})

/** 多模态消息的内容分片上限（防手滑塞一堆）与单张图片的体积上限 */
const ASSISTANT_CONTENT_PARTS_MAX = 16
const ASSISTANT_IMAGE_URL_MAX = 12 * 1024 * 1024
/** 二进制图片分片的字节上限（渲染端解码后的图片本体） */
const ASSISTANT_IMAGE_BYTES_MAX = 8 * 1024 * 1024

/** 校验一条消息的 content：纯文本，或白名单内容分片（text / image_url） */
function readAssistantContent(content: unknown): string | ChatContentPart[] | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.length === 0 || content.length > ASSISTANT_CONTENT_PARTS_MAX) return null
  const parts: ChatContentPart[] = []
  for (const raw of content) {
    const part = raw as {
      type?: unknown
      text?: unknown
      image_url?: { url?: unknown }
      mime?: unknown
      data?: unknown
    }
    if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text })
      continue
    }
    // 二进制图片分片（渲染端解出来的图片本体）：只收 image/*，且限个体积
    if (part?.type === 'image') {
      const bytes = part.data
      if (
        typeof part.mime === 'string' &&
        part.mime.startsWith('image/') &&
        bytes instanceof Uint8Array &&
        bytes.byteLength > 0 &&
        bytes.byteLength <= ASSISTANT_IMAGE_BYTES_MAX
      ) {
        parts.push({ type: 'image', mime: part.mime, data: bytes })
        continue
      }
      return null
    }
    const url = part?.type === 'image_url' ? part.image_url?.url : undefined
    // 图片只收 data URL 与 http(s)：本地路径递给模型没有任何意义
    if (
      typeof url === 'string' &&
      url.length <= ASSISTANT_IMAGE_URL_MAX &&
      (url.startsWith('data:image/') || /^https?:\/\//.test(url))
    ) {
      parts.push({ type: 'image_url', image_url: { url } })
      continue
    }
    return null
  }
  return parts
}

/** 校验渲染端递来的消息数组；不合法返回 null */
function readAssistantMessages(payload: unknown): ChatMessage[] | null {
  const { messages } = (payload ?? {}) as { messages?: unknown }
  if (!Array.isArray(messages) || messages.length === 0) return null
  const clean: ChatMessage[] = []
  for (const item of messages) {
    const role = (item as { role?: unknown })?.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null
    const content = readAssistantContent((item as { content?: unknown })?.content)
    if (content === null) return null
    clean.push({ role, content })
  }
  return clean
}

/** 连接信息每次现读偏好设置：改完不用重启。密钥约定见 user-setting.ts。 */
function assistantConnection(): { baseUrl: string; apiKey: string; model: string } {
  return {
    baseUrl: getUserSettingByPath<string>('assistant.baseUrl') ?? '',
    apiKey:
      (typeof process.env.ASSISTANT_API_KEY === 'string' ? process.env.ASSISTANT_API_KEY.trim() : '') ||
      (getUserSettingByPath<string>('assistant.apiKey') ?? '').trim(),
    model: getUserSettingByPath<string>('assistant.model') ?? ''
  }
}

/**
 * 可视化解题的连接信息：字段留空就沿用文档助手那套（端点/密钥共用），
 * 所以「只想给解题换个模型」只需要填 visualSolve.model 一项。
 */
function visualSolveConnection(): { baseUrl: string; apiKey: string; model: string } {
  const fallback = assistantConnection()
  const pick = (key: 'baseUrl' | 'apiKey' | 'model'): string =>
    (getUserSettingByPath<string>(`visualSolve.${key}`) ?? '').trim() || fallback[key]
  return { baseUrl: pick('baseUrl'), apiKey: pick('apiKey'), model: pick('model') }
}

// 图片模态框的「浏览」按钮：打开系统文件对话框选一张本地图片，
// 返回绝对路径（渲染端填入 src，插入模式下随即插入）。
ipcMain.handle('pick-image-file', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: uiText('选择图片', 'Choose Image'),
    buttonLabel: uiText('选择', 'Choose'),
    properties: ['openFile'],
    defaultPath: defaultDialogDir('read'),
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// 「图片转md」的选图：只列 MinerU 认的图片格式（官方「文件限制」表）。
// 与上面共用的 pick-image-file 分开是故意的 —— 那个也服务编辑器插图，要支持
// svg / avif 这类只用来显示的格式，而 MinerU 收到它们只会回 -60002。
ipcMain.handle('pick-mineru-image-file', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: uiText('选择图片（交给 MinerU 解析）', 'Choose Image for MinerU'),
    buttonLabel: uiText('选择', 'Choose'),
    properties: ['openFile'],
    defaultPath: defaultDialogDir('read'),
    filters: [
      { name: 'Images (MinerU)', extensions: ['png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('export-image', async (event, snapshot: unknown, preset: unknown) => {
  const win = getWinFromEvent(event)
  if (!win || (preset !== 'desktop' && preset !== 'mobile') || !snapshot || typeof snapshot !== 'object') return false
  win.show()
  win.focus()
  const { html, styles, bodyClass, background } = snapshot as { html?: unknown; styles?: unknown; bodyClass?: unknown; background?: unknown }
  if (typeof html !== 'string' || typeof styles !== 'string' || typeof bodyClass !== 'string' || typeof background !== 'string') return false
  const baseName = suggestFileName(win) ?? 'untitled'
  const suffix = preset === 'desktop' ? 'desktop' : 'mobile'
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出 PNG 图片', 'Export PNG images'),
    buttonLabel: uiText('导出', 'Export'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: defaultSavePath(win, `${baseName}-${suffix}`, 'png'),
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  })
  if (result.canceled || !result.filePath) return false
  try {
    const { renderDocumentPNGs } = await import('./image-export')
    const pages = await renderDocumentPNGs({ html, styles, bodyClass, background }, preset)
    if (pages.length === 0) throw new Error('没有可导出的内容')

    const extension = extname(result.filePath)
    const basePath = extension ? result.filePath.slice(0, -extension.length) : result.filePath
    const digits = String(pages.length).length
    const outputPaths = pages.map((_, index) => index === 0
      ? result.filePath
      : `${basePath}-${String(index + 1).padStart(digits, '0')}${extension}`)
    const conflicts = outputPaths.slice(1).filter((path) => existsSync(path))
    if (conflicts.length > 0) {
      const response = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: [uiText('取消', 'Cancel'), uiText('替换', 'Replace')],
        defaultId: 0,
        cancelId: 0,
        message: uiText('部分图片已存在', 'Some images already exist'),
        detail: uiText(`将替换 ${conflicts.length} 张同名图片。`, `${conflicts.length} image${conflicts.length === 1 ? '' : 's'} with the same name will be replaced.`),
      })
      if (response.response !== 1) return false
    }

    await Promise.all(pages.map((page, index) => writeFile(outputPaths[index], page)))
    shell.showItemInFolder(outputPaths[0])
    return true
  } catch (error) {
    console.error('Image export failed', error)
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法导出图片', 'Could not export the images'),
      detail: error instanceof Error ? error.message : String(error),
    })
    return false
  }
})

// 打印用样式（导出 PDF 与打印预览共用）：主题背景跟着页面走，编辑区铺满
// 内容不再留内边距/内部滚动。插入后必须由调用方 removeInsertedCSS 撤销。
async function insertPrintCss(win: BrowserWindow): Promise<string> {
  const background = await win.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor') as string
  return await win.webContents.insertCSS(
    `@media print {
      /* The margins are the page's, so they repeat, and the page carries the
         theme background: without it the margin area stays paper white and a
         warm or dark theme ends up with a bright frame around every page. */
      @page { margin: 20mm 18mm; background: ${background}; }
      html, body, #editor { height: auto !important; overflow: visible !important; background: ${background} !important; }
      #editor { margin: 0 !important; padding: 0 !important; }
      #editor .ProseMirror { min-height: auto !important; }
    }`
  )
}

const PRINT_PDF_OPTIONS = { margins: { top: 0, bottom: 0, left: 0, right: 0 }, printBackground: true, pageSize: 'A4' } as const

ipcMain.handle('export-pdf', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出 PDF', 'Export PDF'),
    buttonLabel: uiText('导出', 'Export'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: defaultSavePath(win, suggestFileName(win), 'pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) return false

  try {
    const cssKey = await insertPrintCss(win)
    try {
      const pdfData = await win.webContents.printToPDF(PRINT_PDF_OPTIONS)
      await writeFile(result.filePath, pdfData)
      return true
    } finally {
      await win.webContents.removeInsertedCSS(cssKey)
    }
  } catch {
    return false
  }
})

// 打印：直接开原生打印对话框。@media print（base.css）已把标题栏/工具栏/
// 面板等界面元素隐藏，纸上只剩正文。
function printWindow(win: BrowserWindow): boolean {
  try {
    win.webContents.print()
    return true
  } catch (error) {
    console.error('Print failed', error)
    return false
  }
}

// 打印预览：Electron 的打印对话框自带预览区，但 Chromium 的预览渲染器在
// Electron 里没实现 —— 那块永远是「此应用不支持打印预览」。所以预览自己做：
// 先按打印样式生成 PDF（printToPDF），再交回渲染端用 pdf.js 画出来（见
// renderer/print-preview.ts）。返回字节而不是临时文件：渲染端开着 webSecurity
// fetch 不了 file://，而 pdf.js 本来就吃字节（PDF 对照标签页同一条路）。
async function printPreviewBytes(win: BrowserWindow): Promise<Uint8Array | null> {
  try {
    const cssKey = await insertPrintCss(win)
    try {
      return new Uint8Array(await win.webContents.printToPDF(PRINT_PDF_OPTIONS))
    } finally {
      await win.webContents.removeInsertedCSS(cssKey)
    }
  } catch (error) {
    console.error('Print preview failed', error)
    return null
  }
}

// 菜单「打印 / 打印预览」与主进程 IPC 共用上面两个实现：菜单项没有 event，
// 取当前聚焦窗口（自定义顶部菜单栏弹出的原生子菜单也指向本窗口）。
function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

// canvas-editor 标签页是自成一体的画布文档：它的打印走自己工具栏里那一个，
// 菜单栏的打印/打印预览在前台是它时一律不生效（点击被挡住、菜单项也置灰）。
function isCanvasTabActive(win: BrowserWindow | null): boolean {
  return !!win && getState(win).activeTabKind === 'canvas'
}

/** 打印相关菜单项此刻是否可用（按聚焦窗口的前台标签页算） */
function printMenuEnabled(): boolean {
  return !isCanvasTabActive(focusedWindow())
}

// 菜单是全局的、构建时 enabled 就定死了，所以状态翻转时要重建一次；用缓存挡掉
// 重复重建（只在「能印 ↔ 不能印」真的变了那次动手，切标签页不会次次重建）。
let printMenuEnabledCache = true

function syncPrintMenuState(): void {
  const next = printMenuEnabled()
  if (next === printMenuEnabledCache) return
  printMenuEnabledCache = next
  buildMenu()
}

ipcMain.handle('print', (event) => {
  const win = getWinFromEvent(event)
  if (!win || isCanvasTabActive(win)) return false
  return printWindow(win)
})

ipcMain.handle('print-preview', async (event) => {
  const win = getWinFromEvent(event)
  if (!win || isCanvasTabActive(win)) return null
  return await printPreviewBytes(win)
})

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] ?? char)
}

ipcMain.handle('export-html', async (event, snapshot: {
  content: string
  html: string
  styles: string
  bodyClass: string
}) => {
  const win = getWinFromEvent(event)
  if (!win) return false
  const baseName = suggestFileName(win, snapshot.content) ?? 'untitled'
  const result = await dialog.showSaveDialog(win, {
    title: uiText('导出 HTML', 'Export HTML'),
    buttonLabel: uiText('导出', 'Export'),
    nameFieldLabel: uiText('文件名：', 'File name:'),
    defaultPath: defaultSavePath(win, baseName, 'html'),
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (result.canceled || !result.filePath) return false

  const title = escapeHTML(baseName)
  const bodyClass = escapeHTML(snapshot.bodyClass)
  const renderedContent = snapshot.html || `<pre>${escapeHTML(snapshot.content)}</pre>`
  const exportStyles = snapshot.styles || ''
  const documentHTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${exportStyles}
    html, body { height: auto; overflow: visible; }
    body { min-width: 320px; }
    #titlebar, #file-panel, #source-editor { display: none !important; }
    #editor { height: auto !important; min-height: 100vh; overflow: visible !important; padding: 40px !important; }
  </style>
</head>
<body class="${bodyClass}">
  <div id="editor"><div class="ProseMirror">${renderedContent}</div></div>
</body>
</html>
`

  try {
    await writeFile(result.filePath, documentHTML, 'utf-8')
    shell.showItemInFolder(result.filePath)
    return true
  } catch {
    return false
  }
})

// 随包文档（用法指南 / Markdown 语法）开成前台窗口的一个标签页，而不是另起
// 一个窗口：它们是只读的参考资料，放在正在编辑的文档旁边才有用，也不该再开
// 一个窗口去抢焦点。内容随包分发（读不了盘也能用），所以仍然没有文件监听。
// 没有任何窗口能接收时才退回开窗口。
function sendBundledDocToWindow(payload: { key: string; title: string; content: string }): boolean {
  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) return false
  win.webContents.send('menu-help-doc', payload)
  return true
}

async function openBundledDocument(fileName: string, title: string): Promise<void> {
  try {
    const content = await readFile(join(demoDir, fileName), 'utf-8')
    if (sendBundledDocToWindow({ key: fileName, title, content })) return
    createWindow(undefined, content, demoDir)
  } catch {
    createWindow(undefined, undefined, demoDir)
  }
}

async function openChangelogOnceForVersion(): Promise<void> {
  if (!app.isPackaged) return
  const version = app.getVersion()
  try {
    const saved = JSON.parse(await readFile(releaseNoticePath, 'utf-8')) as { changelogVersion?: unknown }
    if (saved.changelogVersion === version) return
  } catch {
    // First launch or an invalid marker: show the changelog and rewrite it.
  }

  try {
    const content = await readFile(join(demoDir, 'changelog.md'), 'utf-8')
    createWindow(undefined, content, demoDir)
    await writeFile(releaseNoticePath, JSON.stringify({ changelogVersion: version }), 'utf-8')
  } catch {
    // Do not mark the version as seen if the bundled changelog could not open.
  }
}

// 与 openBundledDocument 同一套路（标签页优先，没有窗口才退回开窗口），只是
// 文件在 templates 目录、且分中英文两份。
async function openCheatsheet(language: 'zh' | 'en' = 'zh', title = 'Markdown 语法'): Promise<void> {
  try {
    const fileName = language === 'en' ? 'cheatsheet-en.md' : 'cheatsheet.md'
    const content = await readFile(join(cheatsheetDir, fileName), 'utf-8')
    if (sendBundledDocToWindow({ key: fileName, title, content })) return
    createWindow(undefined, content, demoDir)
  } catch {
    createWindow(undefined, undefined, demoDir)
  }
}

ipcMain.handle('load-custom-theme', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    filters: [{ name: 'CSS', extensions: ['css'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  try {
    const srcPath = result.filePaths[0]
    const fileName = basename(srcPath)
    const destPath = join(themesDir, fileName)
    await copyFile(srcPath, destPath)
    const css = await readFile(destPath, 'utf-8')
    buildMenu() // rebuild menu to include new theme
    return { name: fileName, css }
  } catch {
    return null
  }
})

ipcMain.handle('load-theme-css', async (_event, fileName: string) => {
  try {
    return await readFile(join(themesDir, fileName), 'utf-8')
  } catch {
    return null
  }
})

// Renderer reports the applied theme; the Theme menu checkmarks are updated
// in place (never rebuild the menu from an IPC callback — setApplicationMenu
// inside a menu-triggered path hangs the main process).
let currentTheme = 'elegant'
let themeMenuItems: Array<{ id: string; theme: string }> = []
// Enumerate installed system font families for the font settings dialog (#7752855).
// Uses NSFontManager via JXA — the same source as the macOS font panel — so the
// list matches what the system and other apps (e.g. Typora) show, with
// localized family names. Result is cached after the first load.
let systemFontFamilies: string[] | null = null
let systemFontFamiliesPromise: Promise<string[]> | null = null

function loadSystemFontFamilies(): Promise<string[]> {
  if (systemFontFamilies) return Promise.resolve(systemFontFamilies)
  if (systemFontFamiliesPromise) return systemFontFamiliesPromise
  systemFontFamiliesPromise = new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve([])
      return
    }
    const script = [
      'ObjC.import("AppKit")',
      'const nm = $.NSFontManager.sharedFontManager',
      'const out = []',
      'const fams = nm.availableFontFamilies.js',
      'for (const f of fams) { out.push(nm.localizedNameForFamilyFace($(f), $()).js) }',
      'out.join("\\n")'
    ].join('; ')
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { maxBuffer: 4 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      try {
        if (err) {
          console.error('[font-list] osascript failed:', (err as NodeJS.ErrnoException).message)
          throw err
        }
        const collator = new Intl.Collator(app.getLocale().startsWith('zh') ? 'zh-Hans' : 'en', { sensitivity: 'base', numeric: true })
        systemFontFamilies = [...new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))].sort(collator.compare)
      } catch {
        systemFontFamilies = []
      }
      resolve(systemFontFamilies)
    })
  })
  return systemFontFamiliesPromise
}

ipcMain.handle('list-system-fonts', () => loadSystemFontFamilies())

// Broadcast editor font changes from one window to the others (#7752855)
ipcMain.handle('set-editor-font', (_event, prefs: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents === _event.sender) continue
    if (!win.webContents.isDestroyed()) win.webContents.send('editor-font-changed', prefs)
  }
})

// External edit collided with unsaved local changes. Pause the editor's
// autosave (renderer side) and ask the user which version survives.
ipcMain.handle('report-external-conflict', async (event) => {
  const win = getWinFromEvent(event)
  if (!win) {
    event.sender.send('external-conflict-result', { action: 'keep' })
    return
  }
  const state = getState(win)
  const filePath = state.filePath
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [
      uiText('保留我的版本（继续编辑）', 'Keep my version (keep editing)'),
      uiText('加载磁盘上的版本（丢弃未保存的输入）', 'Load the version on disk (discard unsaved input)')
    ],
    defaultId: 0,
    cancelId: 0,
    message: uiText('文件已被其他程序修改', 'The file was changed by another program'),
    detail: uiText(
      '你正在编辑的内容尚未保存，同时磁盘上的文件已被外部修改。请选择保留哪个版本。',
      'Your edits are not saved yet, and the file on disk changed. Choose which version to keep.'
    )
  })
  if (win.isDestroyed()) return
  if (choice.response === 1 && filePath) {
    try {
      const data = await readFile(filePath, 'utf-8')
      state.lastInternalSaveContent = data
      event.sender.send('external-conflict-result', { action: 'load', content: resolveImagePaths(data, filePath) })
      return
    } catch {
      // fall through to keep-mine when the file cannot be read
    }
  }
  event.sender.send('external-conflict-result', { action: 'keep' })
})

ipcMain.handle('report-theme', (_event, theme: unknown) => {
  const next = typeof theme === 'string' && theme ? theme : 'elegant'
  if (next === currentTheme) return
  currentTheme = next
  updateThemeMenuChecks()
})

// The Windows window controls are painted by the OS inside our own row, so their
// strip has to carry the theme's chrome colour. The renderer resolves the live
// computed colours and reports them on every theme change; the overlay only
// exists on Windows, and older runtimes without the API simply keep the default.
ipcMain.handle('report-titlebar-colors', (event, colors: unknown) => {
  if (process.platform !== 'win32') return
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  const payload = colors as { background?: unknown; symbol?: unknown } | null
  // Plain #rrggbb only: the platform parses no CSS Color 4, and a value it cannot
  // read fails the whole call, leaving the buttons on whatever they were created
  // with (2026-09-15, a light strip over a black row shipped to a Windows tester
  // because the renderer handed over `color(srgb …)`).
  const hex = (value: unknown): string | null =>
    typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null
  const background = hex(payload?.background)
  if (!background) return
  const symbol = hex(payload?.symbol)
  try {
    win.setTitleBarOverlay({ color: background, ...(symbol ? { symbolColor: symbol } : {}), height: TITLEBAR_HEIGHT })
  } catch (error) {
    // Not silent: a swallowed failure here is invisible in the UI, and that is
    // exactly how the colours above went unnoticed until a Windows screenshot.
    console.error('title bar overlay update failed:', error)
  }
})

// The row's own menu button (Windows, where the menu bar is hidden). It pops the
// application menu in place, so the menu stays the same native menu everywhere.
ipcMain.handle('popup-app-menu', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  Menu.getApplicationMenu()?.popup({ window: win })
})

// ─── Typora 式自定义顶部菜单栏 ──────────────────────────────────────────────
// 顶部五个一级标签（文件/编辑/视图/主题/帮助）由 renderer 绘制，二级菜单仍弹出
// 原生菜单：复用全部 accelerator / checkbox / 动态子菜单（最近文件、主题）。
// buildMenu 每次重建后按 key 保存当前顶层 MenuItem 引用。
type MenubarKey = 'file' | 'edit' | 'format' | 'insert' | 'font' | 'fontSize' | 'view' | 'theme' | 'print' | 'help'
let menubarItems: Partial<Record<MenubarKey, Electron.MenuItem>> = {}

// renderer 拉取当前界面语言下的五个标签文本
ipcMain.handle('menubar-get-labels', () => {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(menubarItems)) {
    if (item) result[key] = item.label
  }
  return result
})

// 弹出某个一级菜单的原生子菜单。
// 渲染层只传「视口内坐标」（getBoundingClientRect，DIP）；主进程用
// getContentBounds() 把它换算成屏幕坐标。不能用渲染层的 window.screenX/Y：
// 那是窗口外框坐标（Windows 含约 7-8px 不可见调整边框），与视口基准不同，
// 非最大化窗口时菜单会整体偏左上（最大化时外框溢出屏幕恰好抵消，所以只在
// 还原窗口时错位）。getContentBounds 精确对应网页视口，与边框/标题栏/
// DPI/窗口位置无关。
ipcMain.handle('menubar-popup', (event, key: unknown, x: unknown, y: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  if (typeof key !== 'string') return
  const item = menubarItems[key as MenubarKey]
  if (!item?.submenu) return
  const offsetX = Number(x)
  const offsetY = Number(y)
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return
  // 坐标基准（实测校准，Windows / Electron 44）：
  // 传入 window 参数后，popup 的 x/y 是「相对该窗口客户区左上角」的 DIP，
  // Electron 内部自行换算屏幕坐标——绝不能再加 getContentBounds() 的原点，
  // 否则窗口越偏离屏幕左上角、菜单越偏右下（最大化时客户区原点≈(0,0) 恰好
  // 抵消，所以旧版只在还原窗口时错位）。
  // 渲染端 getBoundingClientRect 是 CSS px，页面缩放（zoomFactor，本应用
  // 视图缩放会持久化）下 1 CSS px = zoomFactor DIP，需乘该系数。
  // 系统 DPI scaleFactor 双方同为 DIP，已抵消，不参与。
  const zoom = event.sender.getZoomFactor()
  const popX = Math.round(offsetX * zoom)
  const popY = Math.round(offsetY * zoom)
  item.submenu.popup({ window: win, x: popX, y: popY })
})

ipcMain.handle('get-language', () => getPreferredLanguage())

// ─── 用户偏好设置 IPC ────────────────────────────────────────────────────

ipcMain.handle('get-preferences', () => getUserSetting())

ipcMain.handle('set-preference', (_event, key: unknown, value: unknown) => {
  if (typeof key !== 'string') return false
  return setUserSetting(key, value)
})

ipcMain.handle('set-preferences-batch', (_event, changes: unknown) => {
  if (!changes || typeof changes !== 'object') return false
  setUserSettingBatch(changes as Record<string, unknown>)
  return true
})

// Menu — targets the focused window

function getFocusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow()
}

function getPreferredCheatsheetLanguage(): 'zh' | 'en' {
  return getPreferredLanguage()
}

let latestVersion: string | null = null

function sendToFocused(channel: string, ...args: unknown[]): void {
  const win = getFocusedWindow() ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (win) win.webContents.send(channel, ...args)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'

  // Scan custom themes synchronously for menu building
  const customThemeItems: Electron.MenuItemConstructorOptions[] = []
  try {
    const files = readdirSync(themesDir).filter((f: string) => f.endsWith('.css')).sort()
    for (const file of files) {
      customThemeItems.push({
        label: file.replace(/\.css$/, ''),
        id: `theme-custom-${file}`,
        checked: currentTheme === `custom:${file}`,
        type: 'checkbox' as const,
        click: async () => {
          try {
            const css = await readFile(join(themesDir, file), 'utf-8')
            sendToFocused('set-theme', `custom:${file}`)
            sendToFocused('set-custom-css', css)
          } catch { /* ignore */ }
        }
      })
    }
  } catch { /* themes dir may not exist yet */ }

  const preferredCheatsheetLanguage = getPreferredCheatsheetLanguage()
  const labels = preferredCheatsheetLanguage === 'zh'
    ? {
        file: '文件', edit: '编辑', format: '格式', insert: '插入', view: '视图', theme: '主题', window: '窗口', help: '帮助',
        print: '打印', printPage: '打印', printPreview: '打印预览',
        newFile: '新建markdown', newMdFile: '新建md文件', open: '打开', save: '保存', saveAs: '另存为',
        newTab: '新建标签页', closeTab: '关闭标签页',
        recentOpen: '最近打开', restoreOnLaunch: '启动时打开上次文档', clearRecent: '清除最近记录', noRecent: '没有最近打开的文件',
        exportWord: '导出md为docx', exportHTML: '导出md为HTML', exportPDF: '导出md为PDF', exportImageDesktop: '导出图片（电脑阅读）', exportImageMobile: '导出图片（手机阅读）', find: '查找',
        importDocx: 'docx转md', importPdf: 'PDF转md', importImage: '图片转md',
        setDefault: '设置为默认应用',
        insertFormula: '插入公式', filePanel: '显示 / 隐藏文件列表', sourceMode: '切换 Markdown 源码',
        // 菜单栏「格式」/「插入」里与工具栏一一对应的功能项
        emphDot: '字下着重号', subscript: '下标', superscript: '上标', highlight: '高亮', taskList: '任务列表',
        quote: '引用块', hr: '分割线', longUnderscore: '长下划线', longBlank: '长空白',
        circledSup: '带圈序号…', pinyin: '拼音…', tianzi: '田字格…',
        image: '图片…', table: '表格…', subblock: '子块…', cols: '分栏…',
        latexFormula: 'LaTex公式…', bulletList: '无序列表', orderedList: '有序列表',
        light: '浅色', dark: '深色', elegant: '雅致',
        sepia: '羊皮纸', notion: '简白', bear: '熊红', writer: '作家',
        solarizedDark: '夜航', nord: '极地', gruvbox: '暖木', dracula: '德古拉', midnight: '午夜',
        importTheme: '导入主题', usageGuide: 'Teyoo用法指南',
        cheatsheet: 'Markdown 语法', about: '关于 Teyoo', checkForUpdates: '检查更新', updateAvailable: '发现新版本', close: '关闭窗口',
        preferences: '偏好设置…', toolbox: '工具箱', visualSolve: '可视化解题', latexOcr: 'LaTeX公式',
        adminPanel: '后台管理系统',
        snipFormula: '截屏识别公式…',
        font: '字体', fontFamily: '字体名', fontSize: '字号', clearFont: '清除字体',
        newCanvasDoc: '新建类docx文档',
        undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
        actualSize: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '切换全屏',
        devTools: '开发者工具',
        fontSettings: '编辑器字体…',
        toolbar: '工具栏',
        language: '界面语言', chinese: '中文', english: 'English',
        hide: '隐藏 Teyoo', hideOthers: '隐藏其他应用', showAll: '显示全部', quit: '退出 Teyoo',
        minimize: '最小化', zoom: '缩放', front: '前置全部窗口',
      }
    : {
        file: 'File', edit: 'Edit', format: 'Format', insert: 'Insert', view: 'View', theme: 'Theme', window: 'Window', help: 'Help',
        print: 'Print', printPage: 'Print', printPreview: 'Print Preview',
        newFile: 'New Markdown', newMdFile: 'New MD File', open: 'Open', save: 'Save', saveAs: 'Save As',
        newTab: 'New Tab', closeTab: 'Close Tab',
        recentOpen: 'Open Recent', restoreOnLaunch: 'Reopen last document at launch', clearRecent: 'Clear Recent', noRecent: 'No recent files',
        exportWord: 'Export MD to DOCX', exportHTML: 'Export MD to HTML', exportPDF: 'Export MD to PDF', exportImageDesktop: 'Export Image (Desktop)', exportImageMobile: 'Export Image (Mobile)', find: 'Find',
        importDocx: 'DOCX to MD', importPdf: 'PDF to MD', importImage: 'Image to MD',
        setDefault: 'Set as Default',
        insertFormula: 'Insert Formula', filePanel: 'Show / Hide File List', sourceMode: 'Toggle Markdown Source',
        // Format / Insert menu counterparts of the toolbar buttons
        emphDot: 'Emphasis Dot', subscript: 'Subscript', superscript: 'Superscript', highlight: 'Highlight', taskList: 'Task List',
        quote: 'Blockquote', hr: 'Horizontal Rule', longUnderscore: 'Long Underscore', longBlank: 'Long Blank',
        circledSup: 'Circled Number…', pinyin: 'Pinyin…', tianzi: 'Tianzi Grid…',
        image: 'Image…', table: 'Table…', subblock: 'Sub-block…', cols: 'Columns…',
        latexFormula: 'LaTeX Formula…', bulletList: 'Bullet List', orderedList: 'Ordered List',
        light: 'Light', dark: 'Dark', elegant: 'Elegant',
        sepia: 'Sepia', notion: 'Notion', bear: 'Bear', writer: 'Writer',
        solarizedDark: 'Solarized Dark', nord: 'Nord', gruvbox: 'Gruvbox', dracula: 'Dracula', midnight: 'Midnight',
        importTheme: 'Import Theme', usageGuide: 'Teyoo Guide',
        cheatsheet: 'Markdown Syntax', about: 'About Teyoo', checkForUpdates: 'Check for Updates', updateAvailable: 'Update Available', close: 'Close Window',
        preferences: 'Preferences…', toolbox: 'Toolbox', visualSolve: 'Visual Solver', latexOcr: 'LaTeX OCR',
        adminPanel: 'Admin',
        snipFormula: 'Snip Formula…',
        font: 'Font', fontFamily: 'Font Family', fontSize: 'Font Size', clearFont: 'Clear Font',
        newCanvasDoc: 'New DOCX-like Document',
        undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
        actualSize: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Full Screen',
        devTools: 'Toggle Developer Tools',
        fontSettings: 'Editor Font…',
        toolbar: 'Toolbar',
        language: 'Language', chinese: '中文', english: 'English',
        hide: 'Hide Teyoo', hideOthers: 'Hide Others', showAll: 'Show All', quit: 'Quit Teyoo',
        minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front',
      }

  const themeIdByLabel = new Map<string, string>([
    [labels.light, 'light'],
    [labels.elegant, 'elegant'],
    [labels.notion, 'notion'],
    [labels.writer, 'writer'],
    [labels.bear, 'bear'],
    [labels.sepia, 'sepia'],
    [labels.dark, 'dark'],
    [labels.gruvbox, 'gruvbox'],
    [labels.midnight, 'midnight'],
    [labels.solarizedDark, 'solarized-dark'],
    [labels.nord, 'nord'],
    [labels.dracula, 'dracula'],
  ])
  const themeSubmenu: Electron.MenuItemConstructorOptions[] = [
    { label: labels.light, id: 'theme-light', type: 'checkbox' as const, checked: currentTheme === 'light', click: () => sendToFocused('set-theme', 'light') },
    { label: labels.elegant, id: 'theme-elegant', type: 'checkbox' as const, checked: currentTheme === 'elegant', click: () => sendToFocused('set-theme', 'elegant') },
    { label: labels.notion, id: 'theme-notion', type: 'checkbox' as const, checked: currentTheme === 'notion', click: () => sendToFocused('set-theme', 'notion') },
    { label: labels.writer, id: 'theme-writer', type: 'checkbox' as const, checked: currentTheme === 'writer', click: () => sendToFocused('set-theme', 'writer') },
    { label: labels.bear, id: 'theme-bear', type: 'checkbox' as const, checked: currentTheme === 'bear', click: () => sendToFocused('set-theme', 'bear') },
    { label: labels.sepia, id: 'theme-sepia', type: 'checkbox' as const, checked: currentTheme === 'sepia', click: () => sendToFocused('set-theme', 'sepia') },
    { type: 'separator' },
    { label: labels.dark, id: 'theme-dark', type: 'checkbox' as const, checked: currentTheme === 'dark', click: () => sendToFocused('set-theme', 'dark') },
    { label: labels.gruvbox, id: 'theme-gruvbox', type: 'checkbox' as const, checked: currentTheme === 'gruvbox', click: () => sendToFocused('set-theme', 'gruvbox') },
    { label: labels.midnight, id: 'theme-midnight', type: 'checkbox' as const, checked: currentTheme === 'midnight', click: () => sendToFocused('set-theme', 'midnight') },
    { label: labels.solarizedDark, id: 'theme-solarized-dark', type: 'checkbox' as const, checked: currentTheme === 'solarized-dark', click: () => sendToFocused('set-theme', 'solarized-dark') },
    { label: labels.nord, id: 'theme-nord', type: 'checkbox' as const, checked: currentTheme === 'nord', click: () => sendToFocused('set-theme', 'nord') },
    { label: labels.dracula, id: 'theme-dracula', type: 'checkbox' as const, checked: currentTheme === 'dracula', click: () => sendToFocused('set-theme', 'dracula') },
  ]
  if (customThemeItems.length > 0) {
    themeSubmenu.push({ type: 'separator' }, ...customThemeItems)
  }
  themeSubmenu.push({ type: 'separator' }, {
    label: labels.importTheme,
    click: () => sendToFocused('menu-import-theme')
  })

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'Teyoo',
      submenu: [
        { label: labels.about, role: 'about' as const },
        { type: 'separator' as const },
        { label: labels.hide, role: 'hide' as const },
        { label: labels.hideOthers, role: 'hideOthers' as const },
        { label: labels.showAll, role: 'unhide' as const },
        { type: 'separator' as const },
        { label: labels.quit, role: 'quit' as const }
      ]
    }] : []),
    {
      label: labels.file,
      submenu: [
        // 已停用：新建markdown（原来是开一个**新窗口**）。新建文档现在一律落在
        // 当前窗口的标签页里，与「打开」「PDF转md」等行为一致，见下一项。
        // 底层的 createWindow() 保留未删，取消注释即可恢复。
        // {
        //   label: labels.newFile,
        //   accelerator: 'CmdOrCtrl+N',
        //   click: () => createWindow()
        // },
        {
          // 新建一个空的 Markdown 标签页（不是新窗口）。走的是原本「新建标签页」
          // 那条还在的通道 —— 渲染端 menu-new-tab → openNewTab()：建标签页、
          // 切过去、光标落进编辑器。
          label: labels.newMdFile,
          accelerator: 'CmdOrCtrl+N',
          click: () => openNewDocumentTab()
        },
        {
          label: labels.open,
          accelerator: 'CmdOrCtrl+O',
          click: () => sendToFocused('menu-open')
        },
        {
          label: labels.importDocx,
          click: () => sendToFocused('menu-import-docx')
        },
        {
          // 在当前窗口开一个标签页；窗口都没有时才建一个（见 importPdfDocument）。
          label: labels.importPdf,
          click: () => importPdfDocument()
        },
        {
          // 开一个「左图片预览 / 右 Markdown」的标签页（见 importImageDocument）。
          label: labels.importImage,
          click: () => importImageDocument()
        },
        {
          label: labels.recentOpen,
          // Our own label and submenu on every platform: the recentDocuments role
          // draws a clock icon and an English label, which no other menu item has.
          submenu: recentFiles().length
            ? recentFiles().map((p, index) => ({
                label: `${index + 1}. ${basename(p)}`,
                click: () => openFile(p)
              }))
            : [{ label: labels.noRecent, enabled: false }]
        },
        // 已停用：启动时打开上次文档（restoreOnLaunch）。底层 setRestoreOnLaunch /
        // recentStore.restoreOnLaunch 保留未删，取消注释即可恢复。
        // {
        //   label: labels.restoreOnLaunch,
        //   type: 'checkbox' as const,
        //   checked: recentStore.restoreOnLaunch,
        //   click: () => setRestoreOnLaunch(!recentStore.restoreOnLaunch)
        // },
        {
          label: labels.clearRecent,
          click: () => clearRecentFiles()
        },
        { type: 'separator' },
        // 已停用：新建标签页 / 关闭标签页（连带 CmdOrCtrl+T、CmdOrCtrl+W 快捷键）。
        // 相应的 menu-new-tab / menu-close-tab IPC 与渲染端监听保留未删。
        // {
        //   label: labels.newTab,
        //   accelerator: 'CmdOrCtrl+T',
        //   click: () => sendToFocused('menu-new-tab')
        // },
        // {
        //   label: labels.closeTab,
        //   accelerator: 'CmdOrCtrl+W',
        //   click: () => sendToFocused('menu-close-tab')
        // },
        // { type: 'separator' },
        {
          label: labels.save,
          accelerator: 'CmdOrCtrl+S',
          click: () => sendToFocused('menu-save')
        },
        {
          label: labels.saveAs,
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendToFocused('menu-save-as')
        },
        { type: 'separator' },
        {
          label: labels.exportWord,
          click: () => sendToFocused('menu-export-docx')
        },
        {
          label: labels.exportHTML,
          click: () => sendToFocused('menu-export-html')
        },
        {
          label: labels.exportPDF,
          click: () => sendToFocused('menu-export-pdf')
        },
        // 「导出图片（电脑阅读）/（手机阅读）」已从菜单移除（labels.exportImage*
        // 与 export-image IPC、src/main/image-export.ts 都保留着 —— 加回下面
        // 这两项即可恢复，无需重新实现）：
        //   { label: labels.exportImageDesktop, click: () => sendToFocused('menu-export-image', 'desktop') },
        //   { label: labels.exportImageMobile,  click: () => sendToFocused('menu-export-image', 'mobile')  },
        { type: 'separator' },
        {
          label: labels.setDefault,
          click: () => setAsDefaultApp(uiText, getFocusedWindow())
        },
        { type: 'separator' },
        // 画布版类 docx 文档（canvas-editor）的入口，见 renderer/canvas-editor。
        {
          label: labels.newCanvasDoc,
          click: () => sendToFocused('menu-new-canvas-doc')
        },
        { type: 'separator' },
        isMac ? { label: labels.close, accelerator: 'CmdOrCtrl+Shift+W', role: 'close' } : { label: labels.quit, role: 'quit' }
      ]
    },
    {
      label: labels.edit,
      submenu: [
        { label: labels.undo, role: 'undo' },
        { label: labels.redo, role: 'redo' },
        { type: 'separator' },
        { label: labels.cut, role: 'cut' },
        { label: labels.copy, role: 'copy' },
        { label: labels.paste, role: 'paste' },
        { label: labels.selectAll, role: 'selectAll' },
        { type: 'separator' },
        // 「插入公式」原在这里，已移到「插入 → LaTex公式」（避免重复的
        // CmdOrCtrl+Shift+E 快捷键；该快捷键现由插入菜单接管）。
        {
          label: labels.find,
          accelerator: 'CmdOrCtrl+F',
          click: () => sendToFocused('editor:search')
        }
      ]
    },
    {
      // #58: discoverable format shortcuts; the menu is the documentation.
      label: labels.format,
      submenu: [
        // 填空 / 标记类排在最前（教学场景高频）：长下划线、长空白、上标、下标、高亮
        { label: labels.longUnderscore, click: () => sendToFocused('editor:format', 'longUnderscore') },
        { label: labels.longBlank, click: () => sendToFocused('editor:format', 'longBlank') },
        { type: 'separator' },
        { label: labels.superscript, click: () => sendToFocused('editor:format', 'superscript') },
        { label: labels.subscript, click: () => sendToFocused('editor:format', 'subscript') },
        // ==text== 高亮（highlight mark，见 renderer/editor/highlight.ts）
        { label: labels.highlight, click: () => sendToFocused('editor:format', 'highlight') },
        { type: 'separator' },
        { label: preferredCheatsheetLanguage === 'zh' ? '加粗' : 'Bold', accelerator: 'CmdOrCtrl+B', click: () => sendToFocused('editor:format', 'bold') },
        { label: preferredCheatsheetLanguage === 'zh' ? '斜体' : 'Italic', accelerator: 'CmdOrCtrl+I', click: () => sendToFocused('editor:format', 'italic') },
        { label: preferredCheatsheetLanguage === 'zh' ? '下划线' : 'Underline', accelerator: 'CmdOrCtrl+U', click: () => sendToFocused('editor:format', 'underline') },
        { label: preferredCheatsheetLanguage === 'zh' ? '行内代码' : 'Inline Code', accelerator: 'CmdOrCtrl+E', click: () => sendToFocused('editor:format', 'inlineCode') },
        { label: preferredCheatsheetLanguage === 'zh' ? '删除线' : 'Strikethrough', accelerator: 'CmdOrCtrl+Shift+X', click: () => sendToFocused('editor:format', 'strikethrough') },
        { label: preferredCheatsheetLanguage === 'zh' ? '链接' : 'Link', accelerator: 'CmdOrCtrl+K', click: () => sendToFocused('editor:format', 'link') },
        // 以下是工具栏里其余的块级格式项：全部走同一条命令管线
        // （renderer 的 runToolbarCommand），行为与工具栏按钮完全一致。
        // 「插入」类项目（着重号、公式、图片、拼音、表格、带圈序号、田字格、
        // 子块、分栏、任务列表、列表）已移到独立的「插入」菜单。
        { type: 'separator' },
        { label: labels.quote, click: () => sendToFocused('editor:format', 'quote') },
        { label: labels.hr, click: () => sendToFocused('editor:format', 'hr') }
      ]
    },
    {
      // 「插入」：往文档里加新内容的项目（工具栏对应按钮的同一条命令管线）。
      label: labels.insert,
      submenu: [
        { label: labels.emphDot, click: () => sendToFocused('editor:format', 'emphDot') },
        { type: 'separator' },
        { label: labels.latexFormula, accelerator: 'CmdOrCtrl+Shift+E', click: () => sendToFocused('editor:format', 'math') },
        { label: labels.image, click: () => sendToFocused('editor:format', 'image') },
        { label: labels.pinyin, click: () => sendToFocused('editor:format', 'pinyin') },
        { label: labels.table, click: () => sendToFocused('editor:format', 'table') },
        { label: labels.circledSup, click: () => sendToFocused('editor:format', 'circledSup') },
        { label: labels.tianzi, click: () => sendToFocused('editor:format', 'tianzi') },
        { type: 'separator' },
        { label: labels.subblock, click: () => sendToFocused('editor:format', 'subblock') },
        { label: labels.cols, click: () => sendToFocused('editor:format', 'cols') },
        { type: 'separator' },
        { label: labels.taskList, click: () => sendToFocused('editor:format', 'taskList') },
        { label: labels.bulletList, accelerator: 'CmdOrCtrl+Shift+8', click: () => sendToFocused('editor:format', 'bulletList') },
        { label: labels.orderedList, accelerator: 'CmdOrCtrl+Shift+7', click: () => sendToFocused('editor:format', 'orderedList') }
      ]
    },
    {
      label: labels.font,
      submenu: [
        { label: '宋体 SimSun', click: () => sendToFocused('editor:font', { family: 'SimSun' }) },
        { label: '黑体 SimHei', click: () => sendToFocused('editor:font', { family: 'SimHei' }) },
        { label: '楷体 KaiTi', click: () => sendToFocused('editor:font', { family: 'KaiTi' }) },
        { label: '仿宋 FangSong', click: () => sendToFocused('editor:font', { family: 'FangSong' }) },
        { label: '微软雅黑 Microsoft YaHei', click: () => sendToFocused('editor:font', { family: 'Microsoft YaHei' }) },
        // 开源替代字体：方正书宋→思源宋体、方正黑体→思源黑体、方正楷体→霞鹜文楷
        { label: '思源宋体 Noto Serif SC', click: () => sendToFocused('editor:font', { family: 'Noto Serif SC' }) },
        { label: '思源黑体 Noto Sans SC', click: () => sendToFocused('editor:font', { family: 'Noto Sans SC' }) },
        { label: '霞鹜文楷 LXGW WenKai', click: () => sendToFocused('editor:font', { family: 'LXGW WenKai' }) },
        { type: 'separator' as const },
        { label: 'Times New Roman', click: () => sendToFocused('editor:font', { family: 'Times New Roman' }) },
        { label: 'Arial', click: () => sendToFocused('editor:font', { family: 'Arial' }) },
        { label: 'Courier New', click: () => sendToFocused('editor:font', { family: 'Courier New' }) },
        // 数学字体：Cambria Math 的开源替代
        { label: 'STIX Two Math', click: () => sendToFocused('editor:font', { family: 'STIX Two Math' }) },
        { type: 'separator' as const },
        { label: labels.clearFont, accelerator: 'CmdOrCtrl+Space', click: () => sendToFocused('editor:font', { clear: true }) },
      ]
    },
    {
      label: labels.fontSize,
      submenu: [
        { label: '小初 36pt', click: () => sendToFocused('editor:font', { size: '36pt' }) },
        { label: '一号 26pt', click: () => sendToFocused('editor:font', { size: '26pt' }) },
        { label: '小一 24pt', click: () => sendToFocused('editor:font', { size: '24pt' }) },
        { label: '二号 22pt', click: () => sendToFocused('editor:font', { size: '22pt' }) },
        { label: '小二 18pt', click: () => sendToFocused('editor:font', { size: '18pt' }) },
        { label: '三号 16pt', click: () => sendToFocused('editor:font', { size: '16pt' }) },
        { label: '小三 15pt', click: () => sendToFocused('editor:font', { size: '15pt' }) },
        { label: '四号 14pt', click: () => sendToFocused('editor:font', { size: '14pt' }) },
        { label: '小四 12pt', click: () => sendToFocused('editor:font', { size: '12pt' }) },
        { label: '五号 10.5pt', click: () => sendToFocused('editor:font', { size: '10.5pt' }) },
        { label: '小五 9pt', click: () => sendToFocused('editor:font', { size: '9pt' }) },
      ]
    },
    {
      label: labels.view,
      submenu: [
        { label: labels.actualSize, role: 'resetZoom' },
        { label: labels.zoomIn, role: 'zoomIn' },
        { label: labels.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        {
          label: labels.filePanel,
          accelerator: 'CmdOrCtrl+\\',
          click: () => sendToFocused('toggle-file-panel')
        },
        {
          label: labels.sourceMode,
          accelerator: 'CmdOrCtrl+/',
          click: () => sendToFocused('toggle-source-mode')
        },
        { type: 'separator' },
        { label: labels.toolbar, click: () => sendToFocused('toggle-toolbar') },
        { label: labels.fontSettings, click: () => sendToFocused('open-font-settings') },
        {
          label: labels.language,
          submenu: [
            { label: labels.chinese, type: 'checkbox' as const, checked: getPreferredLanguage() === 'zh', click: () => setPreferredLanguage('zh') },
            { label: labels.english, type: 'checkbox' as const, checked: getPreferredLanguage() === 'en', click: () => setPreferredLanguage('en') }
          ]
        },
        { type: 'separator' },
        { label: labels.fullscreen, role: 'togglefullscreen' },
        { label: labels.devTools, role: 'toggleDevTools' }
      ]
    },
    {
      label: labels.theme,
      submenu: themeSubmenu
    },
    // The Window menu is not cosmetic: macOS injects the system window-tiling
    // commands (System Settings → Keyboard → Keyboard Shortcuts → Windows, e.g.
    // ⌃⌥⌘←) into whichever menu is registered via setWindowsMenu. Electron does
    // that only for role 'windowMenu' — without it every tiling shortcut is
    // dead in the app (#97). The role supplies the items; the label is ours, so
    // the menu speaks the interface language like every other one (an English
    // "Window" sat between 主题 and 帮助 until 2026-09-15).
    ...(isMac ? [{ role: 'windowMenu' as const, label: labels.window }] : []),
    {
      label: labels.print,
      submenu: [
        {
          label: labels.printPage,
          accelerator: 'CmdOrCtrl+P',
          // 类 docx 文档（canvas-editor）标签页上前台时置灰：打印只走它自己工具栏
          enabled: printMenuEnabled(),
          click: () => {
            const win = focusedWindow()
            if (!win || isCanvasTabActive(win)) return
            printWindow(win)
          }
        },
        // 「打印预览」：预览由应用自己画（main 生成 PDF、渲染端 pdf.js 显示），
        // 系统打印对话框里那块「此应用不支持打印预览」是 Electron 的固有缺口，
        // 不是这里能补的 —— 详见 main 的 printPreviewBytes 与
        // renderer/print-preview.ts。
        {
          label: labels.printPreview,
          enabled: printMenuEnabled(),
          click: () => {
            const win = focusedWindow()
            if (!win || isCanvasTabActive(win)) return
            sendToFocused('menu-print-preview')
          }
        }
      ]
    },
    {
      label: labels.help,
      submenu: [
        {
          label: labels.preferences,
          accelerator: 'CmdOrCtrl+,',
          click: () => sendToFocused('menu-preferences')
        },
        // 工具箱：独立工具页（目前只有 PDF拆分）。与「PDF转md / 图片转md」同一
        // 套路 —— 开在当前窗口的标签页里，不另起窗口。
        {
          label: labels.toolbox,
          click: () => sendToFocused('menu-toolbox-tab')
        },
        // 可视化解题：整页解题标签页（题目输入 / 分步求解 / 步骤插入正文）。
        // 与工具箱同一套路 —— 开在当前窗口的标签页里。
        {
          label: labels.visualSolve,
          click: () => sendToFocused('menu-solver-tab')
        },
        // LaTeX公式：本地 Texo 模型（Transformers.js）图片 → LaTeX，整页标签页。
        {
          label: labels.latexOcr,
          click: () => sendToFocused('menu-texo-tab')
        },
        // 后台管理系统：整页的 Vue 3 应用（src/adminPanel），登录后才能用。
        // 与上面几个同一套路：开在当前窗口的标签页里。
        {
          label: labels.adminPanel,
          click: () => sendToFocused('menu-admin-panel')
        },
        // 截屏识别公式：同一份本地模型，只是配方从「选一张图」换成「屏幕上框一块」。
        // 菜单事件只发通知，抓屏由渲染端发起（preload 的 requestSnip）：要看是哪个
        // 标签页点的才插得回去。快捷键用 Alt 组合 —— Shift+X 已经是删除线了。
        {
          label: labels.snipFormula,
          accelerator: 'CmdOrCtrl+Alt+X',
          click: () => sendToFocused('menu-snip-formula')
        },
        { type: 'separator' },
        // 用法指南读 resources/demo/usage-guide.md，不再借 changelog.md：那一份由
        // openChangelogOnceForVersion() 在每次升级后的首次启动自动打开，两者内容
        // 不同，共用一个文件会互相覆盖。
        {
          label: labels.usageGuide,
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => { void openBundledDocument('usage-guide.md', labels.usageGuide) }
        },
        {
          label: labels.cheatsheet,
          accelerator: 'CmdOrCtrl+Shift+/',
          click: () => { void openCheatsheet(preferredCheatsheetLanguage, labels.cheatsheet) }
        },
        {
          label: labels.checkForUpdates,
          enabled: app.isPackaged,
          click: () => { void checkForUpdates(true) }
        },
        ...(latestVersion ? [{
          label: `${labels.updateAvailable} v${latestVersion}`,
          click: () => {
            updateDownloadRequested = true
            void autoUpdater.downloadUpdate()
          }
        }] : []),
        { type: 'separator' },
        { label: labels.about, role: 'about' }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  localizeWindowMenu(menu, labels)

  // 保存五个一级菜单的当前引用，供自定义顶部菜单栏按坐标弹出
  menubarItems = {
    file: menu.items.find((item) => item.label === labels.file),
    edit: menu.items.find((item) => item.label === labels.edit),
    format: menu.items.find((item) => item.label === labels.format),
    insert: menu.items.find((item) => item.label === labels.insert),
    font: menu.items.find((item) => item.label === labels.font),
    fontSize: menu.items.find((item) => item.label === labels.fontSize),
    view: menu.items.find((item) => item.label === labels.view),
    theme: menu.items.find((item) => item.label === labels.theme),
    print: menu.items.find((item) => item.label === labels.print),
    help: menu.items.find((item) => item.label === labels.help),
  }
  // 原生菜单关闭时通知 renderer 取消标签高亮
  menu.on('menu-will-close', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('menubar-closed')
    }
  })
  // 这次构建用的就是当前的打印可用状态，记下来给 syncPrintMenuState 比对
  printMenuEnabledCache = printMenuEnabled()
  // 菜单可能因语言切换/主题变更/更新状态而重建，通知 renderer 刷新标签文本
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('menubar-labels-changed')
  }
  themeMenuItems = [
    ...themeSubmenu.filter((item): item is Electron.MenuItemConstructorOptions & { id: string } => typeof item.id === 'string')
      .map((item) => ({ id: item.id, theme: themeIdByLabel.get(item.label ?? '') ?? (item.id.startsWith('theme-custom-') ? `custom:${String(item.label)}.css` : '') })),
  ]
}

// The Window menu's three standard items come from the 'windowMenu' role, and
// Electron leaves their labels to the system language. In an app whose interface
// is Chinese on an English system that left "Minimize / Zoom / Bring All to
// Front" sitting in an otherwise Chinese menu (2026-09-15), so the labels are
// rewritten to the interface language. The role stays: it is what registers the
// menu with macOS and keeps the system window-tiling shortcuts alive (#97).
function localizeWindowMenu(menu: Menu, labels: { minimize: string; zoom: string; front: string }): void {
  // Compared lowercased because Electron reports the role as 'windowmenu' while
  // its own types spell the constructor option 'windowMenu'.
  const windowMenu = menu.items.find((item) => String(item.role).toLowerCase() === 'windowmenu')
  if (!windowMenu?.submenu) return
  const byRole: Record<string, string> = {
    minimize: labels.minimize,
    zoom: labels.zoom,
    front: labels.front
  }
  for (const item of windowMenu.submenu.items) {
    const label = item.role ? byRole[item.role] : undefined
    if (label) item.label = label
  }
}

function updateThemeMenuChecks(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const entry of themeMenuItems) {
    const item = menu.getMenuItemById(entry.id)
    if (item) item.checked = entry.theme === currentTheme
  }
}

// --- Auto update (weak, non-blocking) ---
let manualUpdateCheck = false
let updateDownloadRequested = false

function showUpdateMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = getFocusedWindow()
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
}

async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) return
  manualUpdateCheck = manual
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    if (!manualUpdateCheck) return
    manualUpdateCheck = false
    const chinese = getPreferredCheatsheetLanguage() === 'zh'
    await showUpdateMessage({
      type: 'error',
      buttons: [chinese ? '好' : 'OK'],
      message: chinese ? '无法检查更新' : 'Unable to check for updates',
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}

function setupAutoUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const broadcast = (channel: string, version: string): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, version)
    }
  }

  autoUpdater.on('update-available', (info) => {
    manualUpdateCheck = false
    latestVersion = info.version
    buildMenu()
    broadcast('update-available', info.version)
  })
  autoUpdater.on('update-not-available', () => {
    if (!manualUpdateCheck) return
    manualUpdateCheck = false
    const chinese = getPreferredCheatsheetLanguage() === 'zh'
    void showUpdateMessage({
      type: 'info',
      buttons: [chinese ? '好' : 'OK'],
      message: chinese ? 'Teyoo 已是最新版本' : 'Teyoo is up to date',
      detail: chinese ? `当前版本：v${app.getVersion()}` : `Current version: v${app.getVersion()}`
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloadRequested = false
    broadcast('update-downloaded', info.version)
  })
  autoUpdater.on('download-progress', (progress) => {
    if (!updateDownloadRequested) return
    broadcast('update-progress', String(Math.min(100, Math.round(progress.percent))))
  })
  autoUpdater.on('error', (err) => {
    console.error('autoUpdater:', err.message)
    // Only surface failures for a user-initiated download; background
    // update checks fail silently (weak, non-blocking philosophy).
    if (!updateDownloadRequested) return
    updateDownloadRequested = false
    broadcast('update-error', '')
  })

  // Defer the first check so it never delays startup.
  setTimeout(() => {
    void checkForUpdates()
  }, 8000)
}

ipcMain.handle('download-update', async () => {
  updateDownloadRequested = true
  await autoUpdater.downloadUpdate()
})

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true)
})

// App lifecycle

// --- Single instance (#99, #100) ---
// A second launch while ColaMD runs must not become a second process: it
// doubles memory, shows two menu bars, and its renderer stalls ~4 seconds on
// the first instance's LevelDB lock for Local Storage before giving up on
// writing theme/state preferences. The second launch's files arrive in
// 'second-instance' and open as tabs of the existing window instead.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Keep files only: the app-path argument (".") and stray directories are
    // not documents.
    const fileArgs = argv.slice(app.isPackaged ? 1 : 2)
      .filter((arg) => !arg.startsWith('-'))
      .filter((arg) => {
        try { return !statSync(arg).isDirectory() } catch { return true }
      })
    if (fileArgs.length === 0) {
      // Plain re-launch: bring the app the user already has back to front.
      const target = focusedOrLastWindow()
      if (target) {
        if (target.isMinimized()) target.restore()
        target.show()
        target.focus()
      } else {
        createWindow()
      }
      return
    }
    for (const fp of fileArgs) openFile(fp)
  })
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  markStartup('app-ready')
  ensureThemesDir()
  buildMenu()

  // Check command line args for file paths
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  const fileArgs = args.filter((arg) => !arg.startsWith('-'))
  if (fileArgs.length > 0) {
    pendingFilePaths = fileArgs
  }

  if (pendingFilePaths.length > 0) {
    // The first argument becomes the window; the rest open as its tabs (#99)
    // instead of one window per file.
    const [first, ...rest] = pendingFilePaths
    const firstWindow = createWindow(first)
    for (const fp of rest) openFileAsTab(firstWindow, fp)
    pendingFilePaths = []
  } else {
    // Start with an empty editor and no directory scan. Bundled examples stay
    // available from Help and are loaded only when explicitly requested.
    // With session restore on, reopen the most recent document instead (#45).
    const lastDoc = recentStore.restoreOnLaunch ? recentStore.recent.find((p) => existsSync(p)) : undefined
    if (lastDoc) {
      createWindow(lastDoc)
    } else {
      createWindow()
    }
  }

  setupAutoUpdater()
  void openChangelogOnceForVersion()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// --- Unsaved-changes guard (auto-save is the primary defense; this is the backstop) ---

// Ask one specific renderer for an atomic dirty/content snapshot. A timeout is
// a failed request, never a signal that the document is clean.
function requestDocumentState(win: BrowserWindow): Promise<DocumentSnapshot | null> {
  const requestId = `${win.webContents.id}:${++nextDocumentStateRequestId}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingDocumentStateRequests.get(requestId)
      if (!pending) return
      pendingDocumentStateRequests.delete(requestId)
      pending.resolve(null)
    }, 3000)
    pendingDocumentStateRequests.set(requestId, { webContentsId: win.webContents.id, resolve, timer })
    win.webContents.send('request-document-state', requestId)
  })
}

ipcMain.on('document-state-response', (event, requestId: unknown, snapshot: unknown) => {
  if (typeof requestId !== 'string' || !snapshot || typeof snapshot !== 'object') return
  const { dirty, content, tabs } = snapshot as DocumentSnapshot
  if (typeof dirty !== 'boolean' || typeof content !== 'string') return
  const pending = pendingDocumentStateRequests.get(requestId)
  if (!pending || pending.webContentsId !== event.sender.id) return
  pendingDocumentStateRequests.delete(requestId)
  clearTimeout(pending.timer)
  pending.resolve({
    dirty,
    content,
    tabs: Array.isArray(tabs)
      ? tabs.filter((tab) => tab && typeof tab.content === 'string' && (tab.path === null || typeof tab.path === 'string'))
      : undefined
  })
})

ipcMain.on('renderer-ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) {
    const state = getState(win)
    state.rendererReady = true
    // 渲染端报就绪说明样式已注入、监听已注册，可以让窗口露脸了（幂等）。
    state.reveal?.()
    state.reveal = null
    // The renderer is listening now, so it can be told the state it cannot read
    // for itself: a window restored into full screen must not keep the traffic
    // light clearance.
    win.webContents.send('fullscreen-changed', win.isFullScreen())
    // Files queued before the renderer could listen (multi-file launch, early
    // second-instance) go out now.
    flushPendingTabFiles(win)
  }
  markStartup('renderer-ready')
  writeStartupTrace()
})

// Renderer reports its unsaved state as a fast path for quit coordination.
ipcMain.on('set-dirty', (event, isDirty: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) getState(win).dirty = !!isDirty
})

// Concurrent close events for the same window must share one prompt and save.
function confirmWindowClose(win: BrowserWindow, state: WindowState): Promise<boolean> {
  if (!state.closePromise) {
    state.closePromise = handleWindowClose(win, state).finally(() => {
      state.closePromise = null
    })
  }
  return state.closePromise
}

// Confirm before losing unsaved edits. Returns true only after a verified save
// or an explicit discard; every failure leaves the window open and dirty.
async function handleWindowClose(win: BrowserWindow, state: WindowState): Promise<boolean> {
  if (!state.rendererReady && !state.dirty) return true

  const snapshot = await requestDocumentState(win)
  if (!snapshot) {
    // Renderer is unresponsive: it cannot report state or save anything, so
    // blocking forever would trap the user. Offer an explicit escape instead.
    if (!state.dirty) return true
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [uiText('仍要关闭', 'Close anyway'), uiText('取消', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      message: uiText('无法与编辑窗口通信', 'Cannot reach the editor window'),
      detail: uiText(
        '窗口可能已停止响应，无法确认是否有未保存的修改。强行关闭可能丢失内容。',
        'The window is not responding, so unsaved changes cannot be checked. Closing it may lose content.'
      )
    })
    return response === 0
  }
  state.dirty = snapshot.dirty
  if (!snapshot.dirty) return true

  const detail = state.filePath
    ? uiText(`“${basename(state.filePath)}” 有未保存的修改。`, `“${basename(state.filePath)}” has unsaved changes.`)
    : uiText('当前未命名文档有未保存的修改。', 'The current untitled document has unsaved changes.')
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [uiText('保存', 'Save'), uiText('不保存', "Don't Save"), uiText('取消', 'Cancel')],
    defaultId: 0,
    cancelId: 2,
    message: uiText('未保存的修改', 'Unsaved changes'),
    detail
  })
  if (response === 2) return false
  if (response === 1) {
    state.dirty = false
    return true
  }

  const sourcePath = state.filePath
  let filePath = sourcePath
  if (!filePath) {
    const saveAs = await dialog.showSaveDialog(win, {
      title: uiText('保存 Markdown 文档', 'Save Markdown document'),
      buttonLabel: uiText('保存', 'Save'),
      nameFieldLabel: uiText('文件名：', 'File name:'),
      defaultPath: defaultSavePath(win, suggestFileName(win, snapshot.content)),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (saveAs.canceled || !saveAs.filePath) return false
    filePath = saveAs.filePath
  }

  // Background tabs are not the window's active document, so they bypass the
  // active-file guards and are written straight to their own paths. An untitled
  // background tab cannot be written without a dialog, so it is reported
  // instead of being dropped silently.
  const backgroundTabs = (snapshot.tabs ?? []).filter((tab) => tab.path && tab.path !== sourcePath)
  const untitledTabs = (snapshot.tabs ?? []).filter((tab) => !tab.path)
  for (const tab of backgroundTabs) {
    try {
      await writeFile(tab.path as string, restoreImagePaths(tab.content, tab.path as string), 'utf-8')
    } catch {
      await dialog.showMessageBox(win, {
        type: 'error',
        buttons: [uiText('好', 'OK')],
        message: uiText('无法保存标签页', 'Could not save the tab'),
        detail: uiText(
          `“${basename(tab.path as string)}” 写入失败，为保护内容已取消关闭。`,
          `Writing “${basename(tab.path as string)}” failed, so closing was cancelled to protect the content.`
        )
      })
      return false
    }
  }
  if (untitledTabs.length > 0) {
    const untitled = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [uiText('取消', 'Cancel'), uiText('丢弃未命名标签页', 'Discard untitled tabs')],
      defaultId: 0,
      cancelId: 0,
      message: uiText('还有未命名的标签页没有保存', 'Some untitled tabs are still unsaved'),
      detail: uiText(
        '关闭窗口会丢掉它们里的内容。请先切到那些标签页保存。',
        'Closing the window would lose their content. Switch to those tabs and save them first.'
      )
    })
    if (untitled.response === 0) return false
  }

  const saved = await saveToPath(win, filePath, snapshot.content, sourcePath, true)
  if (!saved) {
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: [uiText('好', 'OK')],
      message: uiText('无法保存文档', 'Could not save the document'),
      detail: uiText(
        '为保护未保存的内容，已取消关闭。请检查文件权限和可用磁盘空间。',
        'Closing was cancelled to protect the unsaved content. Check file permissions and free disk space.'
      )
    })
    return false
  }
  state.dirty = false
  return true
}

app.on('before-quit', (e) => {
  if (isQuitting) return
  e.preventDefault()
  void (async () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      const ok = await confirmWindowClose(win, getState(win))
      if (!ok) return // user cancelled or saving failed; abort the quit entirely
    }
    isQuitting = true
    app.quit()
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (app.isReady()) {
    openFile(filePath)
  } else {
    pendingFilePaths.push(filePath)
  }
})
