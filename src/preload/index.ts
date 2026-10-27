import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface SiblingFile {
  name: string
  path: string
  kind: 'file' | 'directory' | 'parent'
}

type FileOpenedData = { path: string | null; content: string }
// 内置文档（菜单「帮助 → Teyoo用法指南 / Markdown 语法」）：内容随包分发
// （resources/demo、resources/templates），渲染端读不到盘，由主进程读出来连
// 同标题送过来，渲染端据此在标签页里开一份没有文件路径的内存文档。
export interface BundledDocPayload {
  /** 去重标识（changelog.md / cheatsheet）：同一份文档不重复开标签页 */
  key: string
  /** 标签页标题（主进程已按界面语言定好，渲染端不掺和语言判断） */
  title: string
  content: string
}
// canvas-editor 的 IEditorData 形状（header/main/footer 元素列表）。preload 工程只
// 收 src/preload，用不了 renderer 侧的模块垫片，这里就地表结构声明；渲染端拿到后
// 自行按 IEditorData 消费（主进程已保证 main 是数组）。
type CanvasEditorData = { header?: unknown[]; main: unknown[]; footer?: unknown[]; graffiti?: unknown[] }
// 一份 PDF 的字节 +（可能有的）已解析结果那两份文件 —— full.md → 右侧 Markdown，
// layout.json → 右侧 JSON，没解析过就没有。渲染端无法自己 fetch file://，只能
// 由主进程读盘送过来，所以「打开 PDF…」和「切回 PDF 标签页」都是这个形状。
type PickPdfResult = { path: string; data: Uint8Array; markdownPath?: string; jsonPath?: string }
/** 文档助手附件（主进程 assistant-attach.ts 的形状，同上面一个理由在本地重声明） */
export interface AssistantAttachment {
  path: string
  name: string
  kind: 'image' | 'text' | 'unsupported'
  /** 给模型用的文本（图片=识别结果；文件=转出来的 markdown/文本） */
  text?: string
  /** 图片附件的 data URL（缩略图） */
  dataUrl?: string
  /** 图片识别出的 LaTeX（不含 $ 定界符） */
  latex?: string
  source?: 'simpletex' | 'mineru' | 'file'
  error?: string
  bytes?: number
  truncated?: boolean
}
export interface AssistantOcrResult {
  ok: boolean
  latex?: string
  text?: string
  source?: 'simpletex' | 'mineru'
  error?: string
}
// 「工具箱 → PDF拆分」的结果（主进程 pdf-split.ts 的形状，同上面一个理由在本地重声明）。
export interface PdfSplitShard {
  name: string
  startPage: number
  endPage: number
  bytes: number
}
// 文档助手（LLM）的一轮消息与结果。与主进程 llm.ts 的形状一致，同样在本地重声明
// （跨工程 import 会让 tsc 报 TS6307，理由同 MineruProgressPayload）。
/**
 * OpenAI 兼容的多模态分片。渲染端发图用二进制分片 `image`（几万字符的 base64 在
 * 提示词 / IPC 里来回搬没意义），主进程发出去之前才转成 image_url 的 data URL。
 */
export type AssistantContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'image'; mime: string; data: Uint8Array }

export interface AssistantMessage {
  role: 'system' | 'user' | 'assistant'
  /** 纯文本，或分片数组（多模态） */
  content: string | AssistantContentPart[]
}
export interface AssistantResult {
  ok: boolean
  /** 成功时的完整回答（Markdown） */
  text?: string
  /** 失败原因：NO_API_KEY / BAD_BASE_URL / NO_MODEL / HTTP_<code>: … / TIMEOUT / … */
  error?: string
}

/** 可视化解题的一条历史：题目 + 模型原文 + 时间（id 由渲染端生成） */
export interface VisualSolveHistoryEntry {
  id: string
  problem: string
  answer: string
  at: number
}
export interface PdfSplitResult {
  ok: boolean
  /** 输出文件夹（原 PDF 同级的 <原名>_拆分_<日期>/） */
  dir?: string
  shards?: PdfSplitShard[]
  pageCount?: number
  error?: string
}
// 在线解析（MinerU）的两份载荷在这里重新声明，而不是 import 主进程那份：
// preload 是独立 bundle（tsconfig.preload.json 只收 src/preload），跨工程 import
// 会让 tsc 报 TS6307（文件不在工程列表里）。
export type MineruProgressStage =
  | 'applying'
  | 'uploading'
  | 'waiting'
  | 'running'
  | 'converting'
  | 'downloading'
  | 'done'
  | 'failed'
export interface MineruProgressPayload {
  stage: MineruProgressStage
  extracted?: number
  total?: number
  detail?: string
  batchId?: string
}
export interface MineruParseResponse {
  ok: boolean
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
type ImageExportPreset = 'desktop' | 'mobile'
type ImageExportSnapshot = { html: string; styles: string; bodyClass: string; background: string }
export type FileManagerName = 'finder' | 'explorer' | 'file-manager'

const pendingFileOpened: FileOpenedData[] = []
let fileOpenedHandler: ((data: FileOpenedData) => void) | null = null

// Register this listener as soon as preload starts. The main process can send
// the initial content before the renderer finishes registering its callbacks.
ipcRenderer.on('file-opened', (_event, data: FileOpenedData) => {
  if (fileOpenedHandler) {
    fileOpenedHandler(data)
  } else {
    pendingFileOpened.push(data)
  }
})

export interface ElectronAPI {
  openFile: () => Promise<{ path: string; content: string } | null>
  openFilePath: (path: string) => Promise<{ path: string; content: string } | null>
  getFileManagerName: () => Promise<FileManagerName>
  revealFile: () => Promise<boolean>
  showEntryContextMenu: (path: string, kind: 'file' | 'directory') => Promise<void>
  showTabContextMenu: (payload: { tabId: string; filePath: string | null; canCloseOthers: boolean; canCloseRight: boolean }) => Promise<void>
  // 编辑区右键菜单（撤销/重做/剪切/复制/粘贴/全选）
  showEditorContextMenu: (payload: { editable: boolean; hasSelection: boolean }) => Promise<void>
  onTabMenuAction: (callback: (payload: { action: string; tabId: string }) => void) => void
  listSiblings: () => Promise<SiblingFile[] | null>
  listDirectory: (path: string) => Promise<SiblingFile[] | null>
  openSibling: (path: string) => Promise<boolean>
  activateFile: (path: string | null) => Promise<{ content: string; mtime: number } | null>
  setTabFiles: (paths: string[]) => void
  onFocusFile: (callback: (path: string) => void) => void
  onOpenInNewTab: (callback: (path: string) => void) => void
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => Promise<string | null>
  saveFileAs: (content: string, expectedPath?: string) => Promise<string | null>
  exportPDF: () => Promise<boolean>
  /** 打印预览：主进程按打印样式生成 PDF，返回字节（渲染端用 pdf.js 画出来） */
  printPreview: () => Promise<Uint8Array | null>
  /** 开系统打印对话框（@media print 已把界面元素收干净） */
  print: () => Promise<boolean>
  exportHTML: (snapshot: { content: string; html: string; styles: string; bodyClass: string }) => Promise<boolean>
  exportDOCX: (content: string, formulaEngine?: string) => Promise<boolean>
  // 「docx转md」标签页：选 Word 文档（只弹对话框，转换要另外点按钮）
  pickDocxFile: () => Promise<string | null>
  // 「docx转md」标签页：把选中的 docx 转成 Markdown（mammoth/dwml-ts，选项读主进程偏好）
  convertDocx: (path: string) => Promise<{ ok: boolean; markdown?: string; warnings?: string[]; error?: string }>
  // 「docx转md」标签页左栏的版式预览：docx 由本机 Word 另存为 PDF，返回 PDF 路径
  //（渲染端再用 readPdfFile 取字节、pdf.js 画）。没装 Word 时 ok=false，不影响 Markdown。
  // PDF 落在 userData 缓存里，同一份文档（内容哈希相同）第二次直接命中，fromCache=true。
  docxToPdf: (path: string) => Promise<{ ok: boolean; pdfPath?: string; error?: string; fromCache?: boolean }>
  // 预览 PDF 在缓存目录里，不在用户眼皮底下：在系统文件管理器里定位它
  docxRevealPreview: (pdfPath: string) => Promise<boolean>
  // 把预览 PDF 复制到 docx 同目录（<name>.pdf）；同名文件已存在时由主进程询问是否覆盖
  docxExportPdf: (sourcePath: string, pdfPath: string) =>
    Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  // docx转md 标签页挂着的源文档：主进程用它给「另存为」起默认文件名
  setActiveDocxPath: (path: string | null) => void
  // 类 docx 文档标签页（canvas-editor）的读写通道：文本 ↔ 元素树的转换在做
  // 渲染端，主进程只管弹系统对话框与读写文件。与上面那条（Markdown ↔ docx）
  // 是两套互不相关的东西。
  pickCanvasMarkdown: () => Promise<{ path: string; content: string } | null>
  /** 类 docx 文档「导入 JSON」：选一个 canvas-editor 导出的 .json，主进程已校验出元素树 */
  pickCanvasJson: () => Promise<{ path: string; data: CanvasEditorData } | null>
  saveCanvasMarkdown: (content: string, fileName?: string) => Promise<string | null>
  // 图片模态框「浏览」：主进程弹系统文件对话框，返回图片绝对路径
  pickImageFile: () => Promise<string | null>
  // 「图片转md」专用的选图：只列 MinerU 认的格式（与上面那个共用的分开，
  // 编辑器插图要支持 svg/avif 这类 MinerU 不认的格式）。
  pickMineruImageFile: () => Promise<string | null>
  // 偏好设置里选目录（工作目录「浏览…」）：返回绝对路径
  pickDirectory: (current?: string) => Promise<string | null>
  // JSON 视图：只读一个文本文件（PDF 旁边的同名 .json），读不到返回 null
  readTextFile: (path: string) => Promise<{ path: string; content: string } | null>
  // Markdown 还原：把 MinerU 抽出来的图片读成 data URL（要在正文里内嵌显示）
  readImageAsDataUrl: (path: string) => Promise<{ path: string; dataUrl: string } | null>
  // JSON 视图的「打开 JSON…」：弹系统对话框选 .json，连内容一起返回
  pickJsonFile: () => Promise<{ path: string; content: string } | null>
  // PDF 对照标签页的「打开 PDF…」：弹系统对话框选 .pdf，内容以字节返回
  //（生产环境是 file:// 页面 + webSecurity，渲染端自己取不到那份文件）
  pickPdfFile: () => Promise<PickPdfResult | null>
  // 切回一个已经挂着源文件的 PDF 标签页：按路径再读一次字节（切走时文档与
  // worker 都放了，不留常驻内存）。读不到（文件被挪走/删掉）就是 null。
  readPdfFile: (path: string) => Promise<PickPdfResult | null>
  // 上报当前活动标签页挂着的那份 PDF（切到别的标签页就传 null）：主进程用它给
  // 「另存为」起默认文件名。
  setActivePdfPath: (path: string | null) => void
  // 工具箱的 PDF拆分：按「每 N 页一份」切开，写进原文件旁边的 <原名>_拆分_<日期>/。
  splitPdf: (path: string, pagesPerFile: number) => Promise<PdfSplitResult>
  // 文档助手：把一轮对话发给 OpenAI 兼容端点（Base URL / Key / 模型都在偏好设置里，
  // 主进程现读）。密钥不出主进程。
  assistantComplete: (messages: AssistantMessage[]) => Promise<AssistantResult>
  // 流式：返回整段结果（text = 全文），中途的分片走 onAssistantDelta。
  assistantStream: (messages: AssistantMessage[]) => Promise<AssistantResult>
  // 「停止生成」：中止本窗口正在跑的那一个流。
  assistantCancel: () => void
  onAssistantDelta: (callback: (payload: { text: string }) => void) => void
  // 可视化解题：与文档助手同一套对话接口，但走**独立的一条流**（channel: 'solver'），
  // 两边同时用不会互相打断；连接信息见偏好设置里的「可视化解题」。
  visualSolveStream: (messages: AssistantMessage[]) => Promise<AssistantResult>
  visualSolveCancel: () => void
  onVisualSolveDelta: (callback: (payload: { text: string }) => void) => void
  /** 可视化解题的非流式调用（偏好设置里的「测试连接」用；走 solver 通道与配置） */
  visualSolveComplete: (messages: AssistantMessage[]) => Promise<AssistantResult>
  /** 解题历史（最近 50 条，存 userData/visual-solve-history.json，不进设置文件） */
  visualSolveHistory: () => Promise<VisualSolveHistoryEntry[]>
  visualSolveHistoryAdd: (entry: VisualSolveHistoryEntry) => Promise<boolean>
  visualSolveHistoryClear: () => Promise<boolean>
  /** 把解题过程存成 .md 文件（弹保存对话框，返回落盘路径） */
  visualSolveSave: (markdown: string, name?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  /** 菜单「帮助 → 可视化解题」 */
  onMenuSolverTab: (callback: () => void) => void
  // 菜单「帮助 → LaTeX公式」：开一个本地公式识别（Texo 模型）标签页。
  onMenuTexoTab: (callback: () => void) => void
  // 菜单「帮助 → 后台管理系统」：开一个整页的后台管理标签页（Vue 3 应用）
  onMenuAdminPanel: (callback: () => void) => void
  // 菜单「帮助 → 截屏识别公式…」：菜单事件只负责通知，抓屏由渲染端自己发起
  // （requestSnip）—— 它才知道这一屏该进哪个窗口、又是从哪个标签页点出来的，
  // 主进程拿不到「当前在编辑哪个文档」这件事。
  onMenuSnipFormula: (callback: () => void) => void
  // 菜单「帮助 → Teyoo用法指南 / Markdown 语法」：随包文档开成标签页
  // （内容已由主进程读好，见 BundledDocPayload）。
  onMenuHelpDoc: (callback: (payload: BundledDocPayload) => void) => void
  // LaTeX公式：图片 data URL → 本地 Texo 模型识别出的 LaTeX（主进程推理）。
  // source 只是给历史库标注来源（上传的图片 / 手写板）；认出的结果由主进程
  // 存进 SQLite 历史（见 main/formula-db.ts），不用渲染端再操心。
  recognizeTexoFormula: (dataUrl: string, source?: 'image' | 'hand' | 'snip') => Promise<string | null>
  // 菜单「帮助 → 截屏识别公式…」：主进程藏起自己的窗口抓一屏，用户框出一块后
  // 把那块（data URL）交回来；取消 / 放弃则返回 null。整个流程是一次 invoke，
  // 不需要再来一条回传通道。
  requestSnip: () => Promise<string | null>
  // 文档助手附件：选文件（可多选）→ 主进程把它转成文本再交给模型
  // （图片=data URL + 可选公式、pdf=MinerU、docx=本地转换、md/txt=直读）。
  pickAssistantAttachment: () => Promise<AssistantAttachment[]>
  // 「识别公式」：一张图片 → LaTeX（先 MinerU，失败退本地 OCR 契约）
  ocrAssistantImage: (path: string) => Promise<AssistantOcrResult>
  // 粘贴的图片（截图）：落成临时文件后按普通图片附件处理
  pasteAssistantImage: (dataUrl: string) => Promise<AssistantAttachment | null>
  // 图片转md 标签页挂着的那张图片：主进程用它给「另存为」起默认文件名。
  setActiveImagePath: (path: string | null) => void
  // 上报前台标签页类型。类 docx 文档（canvas-editor）标签页有自己的打印通道，
  // 菜单栏的打印/打印预览对它不生效（见 main 的 isCanvasTabActive）；
  // 'admin' 是后台管理系统整页视图，主进程靠它判断该窗口能不能被当作空窗口复用。
  setActiveTabKind: (kind: 'document' | 'submit' | 'canvas' | 'admin') => void
  // 在线解析（MinerU）：请求全在主进程发起（渲染端 CSP 拦外部请求、上传链接是
  // 签名 URL 不能外泄）。progress 由主进程逐条推回来。
  parsePdfOnline: (pdfPath: string) => Promise<MineruParseResponse>
  // 「图片转md」：与上面同一个主进程接口（MinerU 认 PDF 也认图片），单独起名
  // 只为让调用处看得懂传的是图片路径。
  parseImageOnline: (imagePath: string) => Promise<MineruParseResponse>
  onMineruProgress: (callback: (payload: MineruProgressPayload) => void) => void
  // 用户偏好设置（主进程 userSetting.json，经 IPC 访问）
  getPreferences: () => Promise<Record<string, unknown>>
  setPreference: (key: string, value: unknown) => Promise<boolean>
  setPreferencesBatch: (changes: Record<string, unknown>) => Promise<boolean>
  onPreferencesChanged: (callback: (payload: { key: string; value: unknown }) => void) => void
  onPreferencesBatchChanged: (callback: (payload: { changes: Record<string, unknown> }) => void) => void
  // 后台管理系统登录态（主进程 session-store.ts：token 走 safeStorage，其余存
  // electron-store）。save 收整份登录返回 data（含 token），load 还原成同形状。
  saveAdminSession: (data: Record<string, unknown>) => Promise<boolean>
  loadAdminSession: () => Promise<Record<string, unknown> | null>
  clearAdminSession: () => Promise<boolean>
  exportImage: (snapshot: ImageExportSnapshot, preset: ImageExportPreset) => Promise<boolean>
  getLanguage: () => Promise<'zh' | 'en'>
  onLanguageChanged: (callback: (language: 'zh' | 'en') => void) => void
  loadCustomTheme: () => Promise<{ name: string; css: string } | null>
  loadThemeCSS: (fileName: string) => Promise<string | null>
  reportTheme: (theme: string) => Promise<void>
  reportTitlebarColors: (colors: { background: string; symbol: string }) => Promise<void>
  popupAppMenu: () => Promise<void>
  getMenubarLabels: () => Promise<Record<string, string>>
  popupMenubar: (key: string, x: number, y: number) => Promise<void>
  onMenubarLabelsChanged: (callback: () => void) => void
  onMenubarClosed: (callback: () => void) => void
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => void
  getPathForFile: (file: File) => string
  openExternal: (url: string) => void
  onFileChanged: (callback: (content: string) => void) => void
  onNewFile: (callback: () => void) => void
  onFileOpened: (callback: (data: FileOpenedData) => void) => void
  onMenuOpen: (callback: () => void) => void
  onMenuSave: (callback: () => void) => void
  onMenuSaveAs: (callback: () => void) => void
  onMenuNewTab: (callback: () => void) => void
  onMenuCloseTab: (callback: () => void) => void
  // 菜单「文件 → PDF转md」：在当前窗口开一个 PDF 对照标签页。
  onMenuPdfTab: (callback: () => void) => void
  // 菜单「文件 → 图片转md」：开一个图片转md 标签页。
  onMenuImageTab: (callback: () => void) => void
  // 菜单「文件 → docx转md」：开一个 docx转md 标签页（文档在页面里选）。
  onMenuDocxTab: (callback: () => void) => void
  // 菜单「文件 → 新建类docx文档」：开一个 canvas-editor 标签页。
  onMenuNewCanvasDoc: (callback: () => void) => void
  // 菜单「帮助 → 工具箱」：开一个工具箱标签页（目前是 PDF拆分）。
  onMenuToolboxTab: (callback: () => void) => void
  onMenuExportPDF: (callback: () => void) => void
  /** 菜单「打印 → 打印预览」：预览层在渲染端（main 先把 PDF 生成好） */
  onMenuPrintPreview: (callback: () => void) => void
  onMenuExportHTML: (callback: () => void) => void
  onMenuExportDOCX: (callback: () => void) => void
  onMenuExportImage: (callback: (preset: ImageExportPreset) => void) => void
  onSetTheme: (callback: (theme: string) => void) => void
  onSetCustomCSS: (callback: (css: string) => void) => void
  onMenuImportTheme: (callback: () => void) => void
  onMenuPreferences: (callback: () => void) => void
  onSearch: (callback: () => void) => void
  onMathModal: (callback: () => void) => void
  onFormatCommand: (callback: (id: string) => void) => void
  onFontCommand: (callback: (attrs: { family?: string; size?: string; clear?: boolean }) => void) => void
  readClipboardText: () => Promise<string>
  onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => void
  onToggleFilePanel: (callback: () => void) => void
  onToggleSourceMode: (callback: () => void) => void
  setEditorFont: (prefs: { family: string; size: number }) => Promise<void>
  listSystemFonts: () => Promise<string[]>
  onEditorFontChanged: (callback: (prefs: { family: string; size: number }) => void) => void
  onOpenFontSettings: (callback: () => void) => void
  onToggleToolbar: (callback: () => void) => void
  reportExternalConflict: () => Promise<void>
  onExternalConflictResult: (callback: (result: { action: 'keep' | 'load'; content?: string }) => void) => void
  onUpdateAvailable: (callback: (version: string) => void) => void
  onUpdateDownloaded: (callback: (version: string) => void) => void
  onUpdateProgress: (callback: (percent: number) => void) => void
  onUpdateError: (callback: () => void) => void
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>
  reportDirty: (isDirty: boolean) => void
  reportRendererReady: () => void
  onRequestDocumentState: (callback: (requestId: string) => void) => void
  respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string; tabs?: { path: string | null; content: string }[] }) => void
}

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  openFilePath: (path: string) => ipcRenderer.invoke('open-file-path', path),
  getFileManagerName: () => ipcRenderer.invoke('get-file-manager-name') as Promise<FileManagerName>,
  revealFile: () => ipcRenderer.invoke('reveal-file') as Promise<boolean>,
  showEntryContextMenu: (path: string, kind: 'file' | 'directory') => ipcRenderer.invoke('entry-context-menu', path, kind) as Promise<void>,
  showTabContextMenu: (payload: { tabId: string; filePath: string | null; canCloseOthers: boolean; canCloseRight: boolean }) => ipcRenderer.invoke('tab-context-menu', payload) as Promise<void>,
  showEditorContextMenu: (payload: { editable: boolean; hasSelection: boolean }) => ipcRenderer.invoke('editor-context-menu', payload) as Promise<void>,
  onTabMenuAction: (callback: (payload: { action: string; tabId: string }) => void) => {
    ipcRenderer.on('tab-menu-action', (_event, payload: { action: string; tabId: string }) => callback(payload))
  },
  listSiblings: () => ipcRenderer.invoke('list-siblings'),
  listDirectory: (path: string) => ipcRenderer.invoke('list-directory', path),
  openSibling: (path: string) => ipcRenderer.invoke('open-sibling', path),
  activateFile: (path: string | null) => ipcRenderer.invoke('activate-file', path) as Promise<{ content: string; mtime: number } | null>,
  setTabFiles: (paths: string[]) => { ipcRenderer.send('set-tab-files', paths) },
  onFocusFile: (callback: (path: string) => void) => {
    ipcRenderer.on('focus-file', (_event, path: string) => callback(path))
  },
  onOpenInNewTab: (callback: (path: string) => void) => {
    ipcRenderer.on('open-in-new-tab', (_event, path: string) => callback(path))
  },
  saveFile: (content: string, expectedPath?: string, rebuildMenu?: boolean, autosave?: boolean) => ipcRenderer.invoke('save-file', content, expectedPath, rebuildMenu, autosave),
  saveFileAs: (content: string, expectedPath?: string) => ipcRenderer.invoke('save-file-as', content, expectedPath),
  exportPDF: () => ipcRenderer.invoke('export-pdf'),
  printPreview: () => ipcRenderer.invoke('print-preview') as Promise<Uint8Array | null>,
  print: () => ipcRenderer.invoke('print') as Promise<boolean>,
  exportHTML: (snapshot: { content: string; html: string; styles: string; bodyClass: string }) => ipcRenderer.invoke('export-html', snapshot),
  exportDOCX: (content: string, formulaEngine?: string) => ipcRenderer.invoke('export-docx', content, formulaEngine),
  pickDocxFile: () => ipcRenderer.invoke('pick-docx-file') as Promise<string | null>,
  convertDocx: (path: string) =>
    ipcRenderer.invoke('convert-docx', path) as Promise<{
      ok: boolean
      markdown?: string
      warnings?: string[]
      error?: string
    }>,
  docxToPdf: (path: string) =>
    ipcRenderer.invoke('docx-to-pdf', path) as Promise<{
      ok: boolean
      pdfPath?: string
      error?: string
      fromCache?: boolean
    }>,
  docxRevealPreview: (pdfPath: string) => ipcRenderer.invoke('docx-reveal-preview', pdfPath) as Promise<boolean>,
  docxExportPdf: (sourcePath: string, pdfPath: string) =>
    ipcRenderer.invoke('docx-export-pdf', sourcePath, pdfPath) as Promise<{
      ok: boolean
      path?: string
      canceled?: boolean
      error?: string
    }>,
  setActiveDocxPath: (path: string | null) => ipcRenderer.send('set-active-docx-path', path),
  pickCanvasMarkdown: () => ipcRenderer.invoke('canvas-pick-md') as Promise<{ path: string; content: string } | null>,
  pickCanvasJson: () => ipcRenderer.invoke('canvas-pick-json') as Promise<{ path: string; data: CanvasEditorData } | null>,
  saveCanvasMarkdown: (content: string, fileName?: string) => ipcRenderer.invoke('canvas-save-md', content, fileName) as Promise<string | null>,
  pickImageFile: () => ipcRenderer.invoke('pick-image-file') as Promise<string | null>,
  pickMineruImageFile: () => ipcRenderer.invoke('pick-mineru-image-file') as Promise<string | null>,
  pickDirectory: (current?: string) => ipcRenderer.invoke('pick-directory', current) as Promise<string | null>,
  // JSON 视图：只读文本 + 选一个 .json，都不动窗口的文档绑定。
  readTextFile: (path: string) => ipcRenderer.invoke('read-text-file', path) as Promise<{ path: string; content: string } | null>,
  readImageAsDataUrl: (path: string) => ipcRenderer.invoke('read-image-as-data-url', path) as Promise<{ path: string; dataUrl: string } | null>,
  pickJsonFile: () => ipcRenderer.invoke('pick-json-file') as Promise<{ path: string; content: string } | null>,
  pickPdfFile: () => ipcRenderer.invoke('pick-pdf-file') as Promise<PickPdfResult | null>,
  readPdfFile: (path: string) => ipcRenderer.invoke('read-pdf-file', path) as Promise<PickPdfResult | null>,
  setActivePdfPath: (path: string | null) => ipcRenderer.send('set-active-pdf-path', path),
  splitPdf: (path: string, pagesPerFile: number) =>
    ipcRenderer.invoke('split-pdf', { path, pagesPerFile }) as Promise<PdfSplitResult>,
  assistantComplete: (messages: AssistantMessage[]) =>
    ipcRenderer.invoke('assistant-complete', { messages }) as Promise<AssistantResult>,
  assistantStream: (messages: AssistantMessage[]) =>
    ipcRenderer.invoke('assistant-stream', { messages }) as Promise<AssistantResult>,
  assistantCancel: () => ipcRenderer.send('assistant-cancel'),
  onAssistantDelta: (callback: (payload: { text: string }) => void) => {
    ipcRenderer.on('assistant-delta', (_event, payload: { text: string; channel?: string }) => {
      // 可视化解题那条流有自己的监听者（onVisualSolveDelta），别串台
      if (payload?.channel === 'solver') return
      callback(payload)
    })
  },
  visualSolveStream: (messages: AssistantMessage[]) =>
    ipcRenderer.invoke('assistant-stream', { messages, channel: 'solver' }) as Promise<AssistantResult>,
  visualSolveCancel: () => ipcRenderer.send('assistant-cancel', { channel: 'solver' }),
  visualSolveComplete: (messages: AssistantMessage[]) =>
    ipcRenderer.invoke('assistant-complete', { messages, channel: 'solver' }) as Promise<AssistantResult>,
  visualSolveHistory: () => ipcRenderer.invoke('visual-solve-history') as Promise<VisualSolveHistoryEntry[]>,
  visualSolveHistoryAdd: (entry: VisualSolveHistoryEntry) =>
    ipcRenderer.invoke('visual-solve-history-add', entry) as Promise<boolean>,
  visualSolveHistoryClear: () => ipcRenderer.invoke('visual-solve-history-clear') as Promise<boolean>,
  visualSolveSave: (markdown: string, name?: string) =>
    ipcRenderer.invoke('visual-solve-save', { markdown, name }) as Promise<{ ok: boolean; path?: string; error?: string }>,
  onVisualSolveDelta: (callback: (payload: { text: string }) => void) => {
    ipcRenderer.on('assistant-delta', (_event, payload: { text: string; channel?: string }) => {
      if (payload?.channel !== 'solver') return
      callback(payload)
    })
  },
  pickAssistantAttachment: () => ipcRenderer.invoke('assistant-pick-attachment') as Promise<AssistantAttachment[]>,
  ocrAssistantImage: (path: string) => ipcRenderer.invoke('assistant-ocr-image', path) as Promise<AssistantOcrResult>,
  pasteAssistantImage: (dataUrl: string) =>
    ipcRenderer.invoke('assistant-paste-image', dataUrl) as Promise<AssistantAttachment | null>,
  setActiveImagePath: (path: string | null) => ipcRenderer.send('set-active-image-path', path),
  setActiveTabKind: (kind: 'document' | 'submit' | 'canvas' | 'admin') => ipcRenderer.send('set-active-tab-kind', kind),
  parsePdfOnline: (pdfPath: string) => ipcRenderer.invoke('mineru-parse', pdfPath) as Promise<MineruParseResponse>,
  parseImageOnline: (imagePath: string) => ipcRenderer.invoke('mineru-parse', imagePath) as Promise<MineruParseResponse>,
  onMineruProgress: (callback: (payload: MineruProgressPayload) => void) => {
    ipcRenderer.on('mineru-progress', (_event, payload: MineruProgressPayload) => callback(payload))
  },
  getPreferences: () => ipcRenderer.invoke('get-preferences'),
  setPreference: (key: string, value: unknown) => ipcRenderer.invoke('set-preference', key, value),
  setPreferencesBatch: (changes: Record<string, unknown>) => ipcRenderer.invoke('set-preferences-batch', changes),
  saveAdminSession: (data: Record<string, unknown>) => ipcRenderer.invoke('admin-session:save', data) as Promise<boolean>,
  loadAdminSession: () => ipcRenderer.invoke('admin-session:load') as Promise<Record<string, unknown> | null>,
  clearAdminSession: () => ipcRenderer.invoke('admin-session:clear') as Promise<boolean>,
  onPreferencesChanged: (callback: (payload: { key: string; value: unknown }) => void) => {
    ipcRenderer.on('preferences-changed', (_event, payload: { key: string; value: unknown }) => callback(payload))
  },
  onPreferencesBatchChanged: (callback: (payload: { changes: Record<string, unknown> }) => void) => {
    ipcRenderer.on('preferences-batch-changed', (_event, payload: { changes: Record<string, unknown> }) => callback(payload))
  },
  exportImage: (snapshot: ImageExportSnapshot, preset: ImageExportPreset) => ipcRenderer.invoke('export-image', snapshot, preset),
  getLanguage: () => ipcRenderer.invoke('get-language') as Promise<'zh' | 'en'>,
  onLanguageChanged: (callback: (language: 'zh' | 'en') => void) => {
    ipcRenderer.on('language-changed', (_event, language) => {
      if (language === 'zh' || language === 'en') callback(language)
    })
  },
  loadCustomTheme: () => ipcRenderer.invoke('load-custom-theme'),
  loadThemeCSS: (fileName: string) => ipcRenderer.invoke('load-theme-css', fileName),
  reportTheme: (theme: string) => ipcRenderer.invoke('report-theme', theme),
  reportTitlebarColors: (colors: { background: string; symbol: string }) => ipcRenderer.invoke('report-titlebar-colors', colors),
  popupAppMenu: () => ipcRenderer.invoke('popup-app-menu'),
  getMenubarLabels: () => ipcRenderer.invoke('menubar-get-labels') as Promise<Record<string, string>>,
  popupMenubar: (key: string, x: number, y: number) => ipcRenderer.invoke('menubar-popup', key, x, y) as Promise<void>,
  onMenubarLabelsChanged: (callback: () => void) => {
    ipcRenderer.on('menubar-labels-changed', () => callback())
  },
  onMenubarClosed: (callback: () => void) => {
    ipcRenderer.on('menubar-closed', () => callback())
  },
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
    ipcRenderer.on('fullscreen-changed', (_event, isFullscreen) => callback(isFullscreen === true))
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  onFileChanged: (callback: (content: string) => void) => {
    ipcRenderer.on('file-changed', (_event, content) => callback(content))
  },
  onNewFile: (callback: () => void) => {
    ipcRenderer.on('new-file', () => callback())
  },
  onFileOpened: (callback: (data: FileOpenedData) => void) => {
    fileOpenedHandler = callback
    for (const data of pendingFileOpened.splice(0)) callback(data)
  },

  onMenuOpen: (callback: () => void) => {
    ipcRenderer.on('menu-open', () => callback())
  },
  onMenuSave: (callback: () => void) => {
    ipcRenderer.on('menu-save', () => callback())
  },
  onMenuNewTab: (callback: () => void) => {
    ipcRenderer.on('menu-new-tab', () => callback())
  },
  onMenuCloseTab: (callback: () => void) => {
    ipcRenderer.on('menu-close-tab', () => callback())
  },
  onMenuPdfTab: (callback: () => void) => {
    ipcRenderer.on('menu-pdf-tab', () => callback())
  },
  onMenuImageTab: (callback: () => void) => {
    ipcRenderer.on('menu-image-tab', () => callback())
  },
  onMenuDocxTab: (callback: () => void) => {
    ipcRenderer.on('menu-docx-tab', () => callback())
  },
  onMenuNewCanvasDoc: (callback: () => void) => {
    ipcRenderer.on('menu-new-canvas-doc', () => callback())
  },
  onMenuToolboxTab: (callback: () => void) => {
    ipcRenderer.on('menu-toolbox-tab', () => callback())
  },
  onMenuSolverTab: (callback: () => void) => {
    ipcRenderer.on('menu-solver-tab', () => callback())
  },
  onMenuTexoTab: (callback: () => void) => {
    ipcRenderer.on('menu-texo-tab', () => callback())
  },
  onMenuAdminPanel: (callback: () => void) => {
    ipcRenderer.on('menu-admin-panel', () => callback())
  },
  onMenuSnipFormula: (callback: () => void) => {
    ipcRenderer.on('menu-snip-formula', () => callback())
  },
  onMenuHelpDoc: (callback: (payload: BundledDocPayload) => void) => {
    ipcRenderer.on('menu-help-doc', (_event, payload: BundledDocPayload) => callback(payload))
  },
  recognizeTexoFormula: (dataUrl: string, source?: 'image' | 'hand' | 'snip') =>
    ipcRenderer.invoke('texo-recognize', { dataUrl, source: source ?? null }) as Promise<string | null>,
  requestSnip: () => ipcRenderer.invoke('snip-start') as Promise<string | null>,
  onMenuSaveAs: (callback: () => void) => {
    ipcRenderer.on('menu-save-as', () => callback())
  },
  onMenuExportPDF: (callback: () => void) => {
    ipcRenderer.on('menu-export-pdf', () => callback())
  },
  onMenuPrintPreview: (callback: () => void) => {
    ipcRenderer.on('menu-print-preview', () => callback())
  },
  onMenuExportHTML: (callback: () => void) => {
    ipcRenderer.on('menu-export-html', () => callback())
  },
  onMenuExportDOCX: (callback: () => void) => {
    ipcRenderer.on('menu-export-docx', () => callback())
  },
  onMenuExportImage: (callback: (preset: ImageExportPreset) => void) => {
    ipcRenderer.on('menu-export-image', (_event, preset) => {
      if (preset === 'desktop' || preset === 'mobile') callback(preset)
    })
  },
  onSetTheme: (callback: (theme: string) => void) => {
    ipcRenderer.on('set-theme', (_event, theme) => callback(theme))
  },
  onSetCustomCSS: (callback: (css: string) => void) => {
    ipcRenderer.on('set-custom-css', (_event, css) => callback(css))
  },
  onMenuImportTheme: (callback: () => void) => {
    ipcRenderer.on('menu-import-theme', () => callback())
  },
  onMenuPreferences: (callback: () => void) => {
    ipcRenderer.on('menu-preferences', () => callback())
  },
  onSearch: (callback: () => void) => {
    ipcRenderer.on('editor:search', () => callback())
  },
  onMathModal: (callback: () => void) => {
    ipcRenderer.on('editor:math', () => callback())
  },
  onFormatCommand: (callback: (id: string) => void) => {
    ipcRenderer.on('editor:format', (_event, id: string) => callback(id))
  },
  onFontCommand: (callback: (attrs: { family?: string; size?: string; clear?: boolean }) => void) => {
    ipcRenderer.on('editor:font', (_event, attrs: { family?: string; size?: string; clear?: boolean }) => callback(attrs))
  },
  readClipboardText: () => ipcRenderer.invoke('read-clipboard-text') as Promise<string>,
  onSiblingsChanged: (callback: (files: SiblingFile[]) => void) => {
    ipcRenderer.on('siblings-changed', (_event, files) => callback(files))
  },
  onToggleFilePanel: (callback: () => void) => {
    ipcRenderer.on('toggle-file-panel', () => callback())
  },
  onToggleSourceMode: (callback: () => void) => {
    ipcRenderer.on('toggle-source-mode', () => callback())
  },
  setEditorFont: (prefs: { family: string; size: number }) => {
    return ipcRenderer.invoke('set-editor-font', prefs)
  },
  listSystemFonts: () => {
    return ipcRenderer.invoke('list-system-fonts')
  },
  onEditorFontChanged: (callback: (prefs: { family: string; size: number }) => void) => {
    ipcRenderer.on('editor-font-changed', (_event, prefs) => callback(prefs))
  },
  onOpenFontSettings: (callback: () => void) => {
    ipcRenderer.on('open-font-settings', () => callback())
  },
  onToggleToolbar: (callback: () => void) => {
    ipcRenderer.on('toggle-toolbar', () => callback())
  },
  reportExternalConflict: () => {
    return ipcRenderer.invoke('report-external-conflict')
  },
  onExternalConflictResult: (callback: (result: { action: 'keep' | 'load'; content?: string }) => void) => {
    ipcRenderer.on('external-conflict-result', (_event, result) => callback(result))
  },
  onUpdateAvailable: (callback: (version: string) => void) => {
    ipcRenderer.on('update-available', (_event, version) => callback(version))
  },
  onUpdateDownloaded: (callback: (version: string) => void) => {
    ipcRenderer.on('update-downloaded', (_event, version) => callback(version))
  },
  onUpdateProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on('update-progress', (_event, percent) => callback(percent))
  },
  onUpdateError: (callback: () => void) => {
    ipcRenderer.on('update-error', () => callback())
  },
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  reportDirty: (isDirty: boolean) => ipcRenderer.send('set-dirty', isDirty),
  reportRendererReady: () => ipcRenderer.send('renderer-ready'),
  onRequestDocumentState: (callback: (requestId: string) => void) => {
    ipcRenderer.on('request-document-state', (_event, requestId) => callback(requestId))
  },
  respondDocumentState: (requestId: string, snapshot: { dirty: boolean; content: string; tabs?: { path: string | null; content: string }[] }) => {
    ipcRenderer.send('document-state-response', requestId, snapshot)
  }
} satisfies ElectronAPI)
