// WebView2 宿主页：把桌面版同一套 Milkdown 编辑器内核塞进一个静态页面。
//
// 谁会加载它：
//   - VSTO / WinForms / WPF 里的 WebView2
//     （CoreWebView2.Navigate，或 SetVirtualHostNameToFolderMapping + https://）
//   - 普通浏览器（没有 window.chrome.webview 时退化成 window.parent.postMessage）
//
// 与 C# 对话的三种方式，任选其一：
//   1) C# → 页面：CoreWebView2.PostWebMessageAsJson({"type":"setMarkdown","markdown":"…"})
//   2) 页面 → C#：window.chrome.webview.postMessage({type:'ready'|'change'|'markdown'|'error'})
//   3) C# 直接调：ExecuteScriptAsync("TeyooEditor.getMarkdown()")（同步返回字符串）
//
// 编辑器内核不依赖 Electron（未判空的两处调用见 ./host-stub），所以这个产物是
// 纯前端的：单个 HTML 文件，JS/CSS 全部内联，file:// 直接打开也能跑。
//
// 一页两个独立文档：习题 / 答案，共用上方那一条工具栏。
// 工具栏作用在「有焦点那一栏」上，切换由内核的 setActiveEditor 负责
// （见 editor.ts：root 的 focusin / mousedown 捕获）。
//
// 所有面向宿主的接口都可以带 target: 'exercise' | 'answer'；不写就是当前活跃
// 那一栏，所以老调用方式（单参数）行为不变。
//
// 消息协议（in）：
//   {type:'setMarkdown', markdown, target?}  整篇替换（会清空撤销栈）
//   {type:'getMarkdown', id, target?}        回 {type:'markdown', id, markdown, target}
//   {type:'setTheme', theme}                 light/dark/… 十二个主题之一
//   {type:'insert', text, target?}           在光标处插入文本
//   {type:'run', command, target?}           格式命令：bold/italic/underline/…
//   {type:'focus', target?}                  把焦点放进指定栏（并设为活跃）
//   {type:'ping', id}                        回 {type:'pong', id}
//   {type:'setDocxBase', base}               文件名取数前缀，配好之后只发文件名即可
//   {type:'importDocx', id, target?, mode?, data?|url?|file?, ocr?}
//                                            Word 文档 → Markdown → 写进目标栏。
//                                            data = base64；url = 完整地址；
//                                            file = 拼到 setDocxBase 前缀上的文件名。
//                                            mode 缺省 append（追加到栏尾）。
// 消息协议（out）：
//   {type:'ready'}      两个编辑器都已就绪
//   {type:'change', target}  哪一栏的正文变了（防抖 300ms，内容按需取）
//   {type:'markdown', id, markdown, target} / {type:'result', id, ok} / {type:'error', message}
//   {type:'imported', id, target, mode, markdown, warnings}  导入成功
//   {type:'requestSelection', target}  请宿主把 Word 当前选区送过来
//                                      （页面上的「传输选区」按钮就是发这条）
//
// VSTO 一侧的最小用法：把选区另存 docx → 读成字节 → base64 →
//   webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new {
//     type = "importDocx", target = "exercise", mode = "append",
//     data = Convert.ToBase64String(bytes) }))
//
// 反向那条：页面点「传输选区」时发 requestSelection，宿主收到后读 Word 选区、
// 另存 docx，再回一条 importDocx（选区为空就回 selectionEmpty）。

// host-stub 必须最先：它在编辑器内核求值之前补好那两个未判空的 Electron 调用。
import './host-stub'

import {
  createEditor,
  getMarkdown,
  setMarkdown,
  insertTextAtCursor,
  getSelectionMarkdown,
  insertMarkdownAtCursor,
  setActiveEditor,
  getActiveEditorId,
  hasEditor
} from '../renderer/editor/editor'
// 桌面版工具栏的接线层：只读 DOM（id/class/data-tb-cmd）+ 调 editor.ts 的命令，
// 不碰 Electron，所以整份复用。按钮 DOM 见 index.html。
import { setupToolbar, runToolbarCommand } from '../renderer/toolbar'
import { applyTheme } from '../renderer/themes/theme-manager'
// Word → Markdown 转换器原本是主进程模块（桌面版「导入 Word 文档」用的就是
// 它）。本模块现已是「浏览器可运行」：只吃字节、不碰 fs/Buffer，唯一的 Node
// 依赖 @napi-rs/canvas 在 vite.webview2.config.ts 里别名到 canvas-shim.ts。
// 所以 VSTO 产出的 .docx 与桌面版走的是同一套解析结果，不存在两份实现。
import { docxToMarkdown } from '../main/docx-import'
import '../renderer/themes/base.css'
import '../renderer/themes/premium.css'
import './webview2.css'

// 与桌面版非 macOS 一致：系统覆盖式滚动条在窗口里显得笨重。
document.body.classList.add('web-playground')

/** 两个栏位：习题与答案。DOM 里的容器 id 见 webview2/index.html。 */
const PANE_ROOTS = {
  exercise: 'exercise-root',
  answer: 'answer-root',
} as const

type PaneId = keyof typeof PANE_ROOTS

type HostMessage = {
  type?: string
  id?: string | number
  target?: string
  markdown?: string
  theme?: string
  text?: string
  command?: string
  // docx 导入专用
  url?: string
  file?: string
  data?: string
  mode?: string
  base?: string
  ocr?: boolean
}

/** 'exercise' → '#exercise-root'（传给内核的是容器 id）。未知/缺省 → undefined = 活跃那栏。 */
function rootOf(target?: string): string | undefined {
  if (!target) return undefined
  return PANE_ROOTS[target as PaneId]
}

/** 反过来：容器 id → 栏位名，用于把具体某一栏的变化报给宿主。 */
function paneOf(rootId: string): PaneId | 'exercise' {
  return rootId === PANE_ROOTS.answer ? 'answer' : 'exercise'
}

type WebviewHost = {
  postMessage: (message: unknown) => void
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void
}

const DEFAULT_THEME = 'light'

// WebView2 注入的宿主对象。浏览器里没有它，退化成 parent.postMessage，
// 这样把页面塞进 iframe 也能调试。
const host = (window as unknown as { chrome?: { webview?: WebviewHost } }).chrome?.webview

// 自己发出的消息打个标记。浏览器直接打开时 window.parent === window，
// postMessage 会被自己的监听器收到并再次 handle：'change' 之类还算无害，
// 但 default 分支会回一条 {type:'error'}，于是自激成死循环。
// iframe 里 parent 是真正的宿主，照常发。
const OUTBOUND = 'teyoo-webview2'

function post(message: Record<string, unknown>): void {
  const payload = { source: OUTBOUND, ...message }
  if (host) host.postMessage(payload)
  else if (window.parent !== window) window.parent.postMessage(payload, '*')
}

function initialTheme(): string {
  const fromQuery = new URLSearchParams(location.search).get('theme')
  return fromQuery ?? DEFAULT_THEME
}

function setTheme(name: string): void {
  applyTheme(name)
  localStorage.setItem('teyoo-theme', name)
}

// ─── Word 选区导入（VSTO → 任务窗格）───────────────────────────────────
//
// VSTO 把 Word 里的选区（比如一道数学题）另存为 .docx，例如在
// D:\TeyooDocx\question_20260929_152138.docx，然后把字节送进页面。四种送法
// 任选，页面按下面的顺序挑第一个给出来的：
//   bytes —— JS 直接传 Uint8Array（TeyooEditor.importDocx({ bytes })）
//   data  —— base64 字符串，塞在 PostWebMessageAsJson 里（C# 改动最小；
//            选区级别的 docx 通常几十 KB，走这条最省事）
//   url   —— 完整 URL，页面自己 fetch（C# 用 SetVirtualHostNameToFolderMapping
//            把目录映射成 https://teyoo-docx/ 时走这条，不受消息体积限制）
//   file  —— 只有文件名时拼到 docxBase 上（?docxBase=… 或消息 setDocxBase）
//
// 落地方式 mode：append（默认，追加到该栏末尾）/ replace（整栏替换）/
// insert（插到光标处）。解析完成后焦点自动落到目标栏，好接着编辑。

type ImportMode = 'append' | 'replace' | 'insert'

type DocxSource = {
  bytes?: Uint8Array
  data?: string
  url?: string
  file?: string
}

type ImportOptions = DocxSource & { target?: string; mode?: string; ocr?: boolean }

type ImportOutcome = {
  markdown: string
  warnings: string[]
  target: PaneId
  mode: ImportMode
}

const PANE_LABEL: Record<PaneId, string> = { exercise: '习题栏', answer: '答案栏' }

/** 文件名的取数前缀。空 = 未配置，此时只接受完整 url / base64 */
let docxBase = new URLSearchParams(location.search).get('docxBase') ?? ''

function setDocxBase(base: string): void {
  docxBase = base.trim()
}

/** 前缀 + 文件名 → URL（两侧斜杠都可能有，各自补一个再拼） */
function joinBase(base: string, file: string): string {
  const head = base.endsWith('/') ? base : `${base}/`
  const tail = file.startsWith('/') ? file.slice(1) : file
  return head + tail
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function fetchDocx(url: string): Promise<Uint8Array> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`读取 ${url} 失败：HTTP ${resp.status}`)
  return new Uint8Array(await resp.arrayBuffer())
}

async function loadDocxBytes(source: DocxSource): Promise<Uint8Array> {
  if (source.bytes) return source.bytes
  if (source.data) return base64ToBytes(source.data.trim())
  if (source.url) return fetchDocx(source.url)
  if (source.file) {
    if (!docxBase) {
      throw new Error('只给了文件名，但没有配置取数前缀（URL 加 ?docxBase=… 或发消息 setDocxBase）')
    }
    return fetchDocx(joinBase(docxBase, source.file))
  }
  throw new Error('缺少文档来源：url / file / data / bytes 至少给一个')
}

/** 把转换结果写进某一栏。追加是默认行为：多次「传输选区」可以累积成一份卷子 */
function writeIntoPane(pane: PaneId, markdown: string, mode: ImportMode): void {
  const rootId = PANE_ROOTS[pane]
  if (mode === 'insert') {
    insertMarkdownAtCursor(markdown, rootId)
    return
  }
  if (mode === 'replace') {
    setMarkdown(markdown, true, rootId)
    return
  }
  const existing = getMarkdown(rootId).trimEnd()
  setMarkdown(existing ? `${existing}\n\n${markdown}` : markdown, true, rootId)
}

/** 底部一行状态条：Word 插件里没有 F12，成功/失败要让用户看见。错误不自动消失 */
let statusTimer: number | undefined
function setStatus(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  const bar = document.getElementById('status-bar')
  if (!bar) return
  bar.textContent = text
  bar.dataset.kind = kind
  bar.hidden = text === ''
  if (statusTimer) window.clearTimeout(statusTimer)
  if (text !== '' && kind !== 'error') {
    statusTimer = window.setTimeout(() => {
      bar.hidden = true
    }, 4000)
  }
}

/**
 * 取一份 .docx → 解析成 Markdown → 放进指定栏。
 * 任何一步失败都抛 Error（同时写到状态条上），调用方按需变成 postMessage 的
 * error 消息或 JS 的 rejected promise。
 */
async function importDocx(options: ImportOptions = {}): Promise<ImportOutcome> {
  await ready
  // 目标栏优先级：调用方显式指定 > 刚点过的那个按钮（pendingTarget）> 有焦点那栏
  const pane: PaneId =
    options.target === 'exercise' || options.target === 'answer'
      ? options.target
      : pendingTarget ?? paneOf(getActiveEditorId() ?? PANE_ROOTS.exercise)
  const mode: ImportMode =
    options.mode === 'replace' || options.mode === 'insert' ? options.mode : 'append'
  const label = options.file ? `${options.file} → ` : ''
  setStatus('正在解析 Word 文档…')
  try {
    if (!hasEditor(PANE_ROOTS[pane])) throw new Error(`编辑器尚未就绪（${pane}）`)
    const bytes = await loadDocxBytes(options)
    const { markdown, warnings } = await docxToMarkdown(bytes, {
      imageFormulaOcr: options.ocr === true,
    })
    writeIntoPane(pane, markdown, mode)
    focusPane(pane)
    clearPending()
    setStatus(`已导入${PANE_LABEL[pane]}：${label}${markdown.length} 字符`, 'ok')
    return { markdown, warnings, target: pane, mode }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    clearPending()
    setStatus(`导入失败：${message}`, 'error')
    throw error
  }
}

/** ?debug=1 才显形的本地自测入口：直接选 D:\TeyooDocx 里的样例 docx。 */
function setupDebugImport(): void {
  if (new URLSearchParams(location.search).get('debug') !== '1') return
  const panel = document.getElementById('debug-panel')
  const input = document.getElementById('debug-file') as HTMLInputElement | null
  const select = document.getElementById('debug-target') as HTMLSelectElement | null
  if (!panel || !input || !select) return
  panel.hidden = false
  input.addEventListener('change', () => {
    void (async () => {
      const target = select.value === 'auto' ? undefined : select.value
      for (const file of Array.from(input.files ?? [])) {
        await importDocx({ bytes: new Uint8Array(await file.arrayBuffer()), target }).catch(
          () => {},
        )
      }
      input.value = ''
    })()
  })
}

/** 按钮写的是目的地，所以源永远是另一栏。 */
const TRANSFER_SOURCE: Record<PaneId, PaneId> = { exercise: 'answer', answer: 'exercise' }

/**
 * 把源栏当前选中的内容搬到目标栏光标处；选区为空时退化为光标所在那段。
 * 走的是编辑器自己的序列化/解析管线，加粗、字体/字号标记这些都跟着过去。
 * @returns 搬过去的 markdown（空串 = 源栏没内容可搬）
 */
function transferTo(dest?: string): string {
  const pane: PaneId =
    dest === 'exercise' || dest === 'answer' ? dest : paneOf(getActiveEditorId() ?? PANE_ROOTS.exercise)
  const source = TRANSFER_SOURCE[pane]
  const markdown = getSelectionMarkdown(PANE_ROOTS[source])
  if (!markdown) return ''
  insertMarkdownAtCursor(markdown, PANE_ROOTS[pane])
  // 搬完把光标给目标栏：用户多半要接着在那儿编辑。
  focusPane(pane)
  return markdown
}

// 「传输选区到习题 / 答案」按钮：向 VSTO 宿主索要 Word 里当前的选区。
//
// 宿主负责：读选区 → 另存 .docx 到 D:\TeyooDocx → 回一条 importDocx。
// 页面只负责记住「这次要落到哪一栏」（pendingTarget），宿主回传时即便不带
// target（或者回传走的是它自己那条 C# 按钮链路，顺序可能错开）也能对上。
let pendingTarget: PaneId | null = null
let pendingTimer: number | undefined

function clearPending(): void {
  if (pendingTimer) window.clearTimeout(pendingTimer)
  pendingTimer = undefined
  pendingTarget = null
}

function requestSelectionTo(dest?: string): void {
  const pane: PaneId =
    dest === 'exercise' || dest === 'answer' ? dest : paneOf(getActiveEditorId() ?? PANE_ROOTS.exercise)
  pendingTarget = pane
  setActiveEditor(PANE_ROOTS[pane])

  // 浏览器里没有宿主页右下角这套 PostMessage 通道：退化成「把另一栏的选区搬
  // 过来」，按钮不至于点不动，也方便不挂 Word 自测。
  if (!host) {
    const moved = transferTo(pane)
    setStatus(
      moved ? '未连接宿主：已把另一栏的选区搬过来' : '未连接宿主：另一栏没有可选内容',
      moved ? 'ok' : 'error',
    )
    clearPending()
    return
  }

  setStatus('正在读取 Word 选区…')
  post({ type: 'requestSelection', target: pane })
  if (pendingTimer) window.clearTimeout(pendingTimer)
  pendingTimer = window.setTimeout(() => {
    if (pendingTarget === null) return
    pendingTarget = null
    setStatus('宿主没有响应：C# 侧没有处理 requestSelection（或 Word 里没有选中内容）', 'error')
  }, 15000)
}

function setupTransferButtons(): void {
  for (const button of document.querySelectorAll<HTMLElement>('[data-transfer-to]')) {
    const dest = button.dataset.transferTo as PaneId | undefined
    if (dest !== 'exercise' && dest !== 'answer') continue
    button.addEventListener('click', () => { requestSelectionTo(dest) })
  }
}

/** 把焦点放进某一栏。给了 target 就顺带设为活跃那一栏。 */
function focusPane(pane?: string): void {
  const rootId = rootOf(pane) ?? getActiveEditorId() ?? PANE_ROOTS.exercise
  if (pane) setActiveEditor(rootId)
  document.querySelector<HTMLElement>(`#${rootId} .ProseMirror`)?.focus()
}

// 正文变化只报「变了」，不搬运全文：Word 插件里文档可能很大，
// 需要内容的一方按自己的节奏调 getMarkdown。
// 每一栏一个计时器：两栏同时改动时不会互相顶掉通知。
const changeTimers = new Map<PaneId, number>()
function onChanged(pane: PaneId): () => void {
  return () => {
    const prev = changeTimers.get(pane)
    if (prev) window.clearTimeout(prev)
    changeTimers.set(pane, window.setTimeout(() => post({ type: 'change', target: pane }), 300))
  }
}

// 就绪之后宿主消息同步生效：C# 连着发 setMarkdown + getMarkdown 时，
// 第二条必须看到第一条的结果（否则会读回旧正文）。
let booted = false

async function boot(): Promise<void> {
  setTheme(initialTheme())
  // 串行创建：内核里每个实例的插件是逐个注册的，并发会交错。
  // 第一个创建的自动成为活跃实例，最后再把焦点明确放回习题栏。
  await createEditor(PANE_ROOTS.exercise, onChanged('exercise'), onChanged('exercise'))
  await createEditor(PANE_ROOTS.answer, onChanged('answer'), onChanged('answer'))
  // 工具栏接线要在编辑器之后：按下态同步要读编辑器选区。
  setupToolbar()
  setupTransferButtons()
  setupDebugImport()
  booted = true
  document.documentElement.dataset.bootState = 'ready'
  focusPane('exercise')
  post({ type: 'ready' })
}

const ready: Promise<void> = boot().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  document.documentElement.dataset.bootState = 'error'
  const box = document.getElementById('boot-error')
  if (box) {
    box.textContent = `编辑器启动失败：\n${message}`
    box.hidden = false
  }
  post({ type: 'error', message })
})

function handle(message: HostMessage): void {
  switch (message.type) {
    case 'ping':
      post({ type: 'pong', id: message.id })
      return
    case 'setMarkdown': {
      const markdown = message.markdown ?? ''
      const target = rootOf(message.target)
      if (booted) setMarkdown(markdown, true, target)
      else void ready.then(() => setMarkdown(markdown, true, target))
      break
    }
    case 'getMarkdown':
      post({ type: 'markdown', id: message.id, target: message.target, markdown: getMarkdown(rootOf(message.target)) })
      return
    case 'setTheme':
      if (message.theme) setTheme(message.theme)
      break
    case 'insert':
      if (message.text) insertTextAtCursor(message.text, rootOf(message.target))
      break
    // 走工具栏同一条管线：格式命令（bold/underline/emphDot/highlight…）与
    // 弹窗类命令（math/table/cols/tianzi/pinyin/circledSup/subblock）都能用。
    // 带了 target 就先把那一栏设为活跃（弹窗类命令一律作用于活跃那一栏）。
    case 'run': {
      if (message.command) {
        const target = rootOf(message.target)
        if (target) setActiveEditor(target)
        runToolbarCommand(message.command)
      }
      break
    }
    case 'focus':
      focusPane(message.target)
      break
    // 宿主发现 Word 里没有选区：给个提示，比「点了没反应」强
    case 'selectionEmpty':
      clearPending()
      setStatus(message.message ?? 'Word 里的选区是空的，请先选中内容再点传输', 'error')
      break
    // 文件名取数前缀：C# 之后只发 {type:'importDocx', file:'question_xxx.docx'}
    case 'setDocxBase':
      if (message.base) setDocxBase(message.base)
      break
    // 异步：结果走专门的 imported / error 消息，不发通用的 result
    case 'importDocx':
      void importDocx({
        target: message.target,
        mode: message.mode,
        url: message.url,
        file: message.file,
        data: message.data,
        ocr: message.ocr,
      })
        .then((outcome) =>
          post({
            type: 'imported',
            id: message.id,
            target: outcome.target,
            mode: outcome.mode,
            markdown: outcome.markdown,
            warnings: outcome.warnings,
          }),
        )
        .catch((error: unknown) =>
          post({
            type: 'error',
            id: message.id,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      return
    default:
      post({ type: 'error', message: `未知消息：${String(message.type)}` })
      return
  }
  post({ type: 'result', id: message.id, ok: true })
}

if (host) host.addEventListener('message', (event) => handle((event.data ?? {}) as HostMessage))

// 同源 iframe 调试用（宿主不是 WebView2 时）。忽略自己发出去的那些消息。
window.addEventListener('message', (event) => {
  if (host) return
  if (event.source !== window.parent) return
  const data = event.data as HostMessage | null
  if (!data || (data as { source?: string }).source === OUTBOUND) return
  handle(data)
})

// C# 侧 ExecuteScriptAsync 可以直接调用这个对象；ready 用来等待就绪。
// 每个方法都可带一个 target 参数（'exercise' | 'answer'），不写就作用于当前
// 有焦点那一栏 —— 单参数的旧调用方式不受影响。
;(window as unknown as { TeyooEditor: unknown }).TeyooEditor = {
  ready,
  getMarkdown: (target?: string) => getMarkdown(rootOf(target)),
  setMarkdown: (markdown: string, target?: string) => setMarkdown(markdown, true, rootOf(target)),
  setTheme,
  focus: focusPane,
  insert: (text: string, target?: string) => insertTextAtCursor(text, rootOf(target)),
  run: (command: string, target?: string) => {
    const targetRoot = rootOf(target)
    if (targetRoot) setActiveEditor(targetRoot)
    return runToolbarCommand(command)
  },
  // 把另一栏的选区搬到这一栏；不写 target 就搬到当前活跃那一栏
  transfer: transferTo,
  // Word 选区：docx 字节/URL/base64 → Markdown → 写进目标栏。
  // { target?: 'exercise'|'answer', mode?: 'append'|'replace'|'insert',
  //   data?: string(, base64), url?: string, file?: string, ocr?: boolean }
  // 返回 Promise<{ markdown, warnings, target, mode }>
  importDocx,
  setDocxBase,
  // 向宿主索要 Word 当前选区（等价于点「传输选区到 XX」按钮）
  requestSelection: requestSelectionTo,
  // 当前工具栏作用在谁身上（'exercise' | 'answer'）
  active: () => paneOf(getActiveEditorId() ?? PANE_ROOTS.exercise)
}
