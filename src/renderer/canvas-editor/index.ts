// ─── 类 docx 文档标签页（canvas-editor） ────────────────────────────────────
// 菜单「文件 → 新建类docx文档」开出的标签页：一个 canvas-editor 实例（
// 所见即所得的画布排版，类 Word 的分页文档）+ 官方 demo 那套工具栏。
// 它不承载 Markdown 内容，也不进标签页的保存/脏标记体系 —— 与提交页同一
// 层级，只复用标签条的切换与关闭机制。
//
// 对外只有四个入口，供 main.ts 在标签页生命周期里调用：
//   showCanvasDocView(tabId)    切到该标签页（首次即建实例）
//   hideCanvasDocView()         切走
//   releaseCanvasDocTab(tabId)  关闭标签页（销毁实例）
//   文案见 document.ts（canvasDocTabLabel / canvasDocWindowTitle）
//
// 每个标签页一份 view：工具栏（官方 DOM，见 toolbar/menu-html.ts）+ 自己的
// 滚动区（多页文档在这儿滚，也是 canvas-editor 的 scrollContainerSelector）
// + 宿主页（纸张）。纸张尺寸固定 A4，窗口缩放不需要重建实例。

import Editor from '@hufe921/canvas-editor'
// 官方插件（Hufe921/canvas-editor-plugin）：特殊字符选择面板。它在实例上挂一
// 条命令（editor.use → plugin(editor)），命令随实例一起销毁。
import specialCharactersPlugin from '@hufe921/canvas-editor-plugin-special-characters'
import { PANEL_ID, createCanvasEditorOptions } from './options'
import { createCanvasDocData } from './document'
import { MENU_HTML } from './toolbar/menu-html'
import { bindMenu } from './toolbar/menu'
import type { CanvasDocInit } from './host'
import { installMathJaxLatexRenderer } from './latex-renderer'
import './canvas-editor.css'

export { canvasDocTabLabel, canvasDocWindowTitle } from './document'

interface CanvasDocEntry {
  view: HTMLDivElement
  editor: Editor
  /** 工具栏的全局监听（点击关闭下拉）要跟着标签页一起注销 */
  disposeMenu: () => void
}

const entries = new Map<string, CanvasDocEntry>()

// 下一次建实例时要跑的动作（导入内容）：showCanvasDocView 带进来，createEntry
// 里在实例建好后消费掉。之所以走这里而不是返回值，是因为实例是懒创建的 ——
// 切到一个已存在的标签页时根本不会走到创建分支。
let pendingInit: CanvasDocInit | null = null

// 面板是 body 的直接子块：与 #submit-panel 同层，编辑面被 body class 隐藏后
// 它就顶到内容区顶部。面板本身不滚动，滚动交给每个 view 里的滚动区。
function ensurePanel(): HTMLElement {
  const existing = document.getElementById(PANEL_ID)
  if (existing) return existing
  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.hidden = true
  document.body.appendChild(panel)
  return panel
}

function createEntry(tabId: string): CanvasDocEntry {
  const view = document.createElement('div')
  view.className = 'canvas-editor-view'
  view.dataset.tabId = tabId
  view.innerHTML = MENU_HTML

  // 滚动区插在工具栏与状态栏之间（MENU_HTML 的顺序是 menu → catalog → footer）
  const scroll = document.createElement('div')
  scroll.className = 'canvas-editor-scroll'
  // canvas-editor 用 document.querySelector 找滚动容器：selector 必须唯一
  scroll.id = `canvas-editor-scroll-${tabId}`
  const host = document.createElement('div')
  host.className = 'canvas-editor-host'
  scroll.appendChild(host)
  const footer = view.querySelector<HTMLElement>('.footer')
  if (footer) view.insertBefore(scroll, footer)
  else view.appendChild(scroll)

  ensurePanel().appendChild(view)

  const editor = new Editor(
    host,
    createCanvasDocData(),
    createCanvasEditorOptions(`#${scroll.id}`)
  )
  // 官方插件把命令挂在实例上：打开特殊字符面板。必须在 bindMenu 之前 ——
  // 工具栏要用这条命令。
  editor.use(specialCharactersPlugin)
  // 把画布里的公式渲染换成 MathJax（自带的是描边字体，排版质量差）。必须赶在
  // 任何内容进来之前 —— 首次排版时公式的宽高就定了，之后不再变。
  installMathJaxLatexRenderer()
  // 官方工具栏的命令绑定（scoped 到这个 view）
  const disposeMenu = bindMenu(editor, view)
  // 建实例时带进来的初始化（导入内容）：失败只记日志，标签页本身照常可用
  const init = pendingInit
  pendingInit = null
  if (init) {
    void Promise.resolve(init(editor)).catch((error: unknown) => {
      console.error('canvas doc init failed:', error)
    })
  }
  return { view, editor, disposeMenu }
}

/**
 * 切到类 docx 文档标签页：面板接管编辑区，实例按需创建。
 * init 只在本次真的要建实例时才执行（导入 docx / md 的结果落在新建的标签页上）。
 */
export function showCanvasDocView(tabId: string, init?: CanvasDocInit): void {
  const panel = ensurePanel()
  document.body.classList.add('canvas-doc-view')
  panel.hidden = false
  pendingInit = init ?? null
  const entry = entries.get(tabId) ?? createEntry(tabId)
  entries.set(tabId, entry)
  for (const [id, item] of entries) {
    item.view.hidden = id !== tabId
  }
}

/** 离开类 docx 文档标签页：收起面板，Markdown 编辑面归位（实例留在内存里）。 */
export function hideCanvasDocView(): void {
  document.body.classList.remove('canvas-doc-view')
  ensurePanel().hidden = true
}

/** 关闭标签页：销毁实例并移除整个 view（工具栏 + 宿主页）。 */
export function releaseCanvasDocTab(tabId: string): void {
  const entry = entries.get(tabId)
  if (!entry) return
  entry.disposeMenu()
  try {
    entry.editor.destroy()
  } catch (error) {
    // 销毁失败也要把 DOM 收干净：留一个空 view 比留整块画布好。
    console.error('canvas-editor destroy failed:', error)
  }
  entry.view.remove()
  entries.delete(tabId)
}
