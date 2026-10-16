// PDF ↔ Markdown 双向定位（悬停高亮，点击才滚过去）。
//
// 做法与 WorkBuddy 那份 demo 同源：id 不是"匹配"出来的，是转换时构造的 ——
// layout2md 一次遍历同时产出 Markdown 文本和块锚点，两边共用 `p{页序}_{块序}`。
//
// 与 demo 的差别是右栏换成了真编辑器（Milkdown/ProseMirror），文档由 Markdown
// 解析而来，id 没地方写在文本里（写进去就会被存盘、被复制走）。所以走
// Decoration：按"顶层节点 ↔ 锚点"打 `data-block-id` 属性，纯内存态。
//
//   · 未编辑时：顶层节点与锚点一一对应，按序号对齐；
//   · 编辑之后：按文本指纹顺序贪心对齐（块首 20 字 + 节点大类），容忍插删段落。
//
// 高亮：悬停只让两侧同时亮（视口不动），点击才把对面滚到眼前。

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { blockFingerprint, type BlockAnchor } from './layout2md'
import { hostEditorEl } from './host-editor'

const blockLinkKey = new PluginKey<DecorationSet>('block-link')

// ── 单例状态（PDF 对照窗口只有一个编辑器）────────────────────────────────
let view: EditorView | null = null
let anchors: BlockAnchor[] = []
let pageSizes: Array<number[] | null> = []
/** 块 id → 它在文档里的顶层节点范围。重建对齐时整体换掉。 */
let nodeRanges = new Map<string, { from: number; to: number }>()
let highlightId: string | null = null
let domBound = false
let rebuildTimer: ReturnType<typeof setTimeout> | null = null

// 指纹匹配时向前看几个锚点：用户在中间插/删一段，后面的块整体偏一位也认得出来。
const LOOKAHEAD = 8

export interface PdfLinkApi {
  /** 只高亮（不滚动）。 */
  highlight: (id: string | null) => void
  /** 滚动到该块并高亮。 */
  reveal: (id: string) => void
}

let pdfApi: PdfLinkApi | null = null

/**
 * 编辑器就绪后把 EditorView 交进来：Decoration 全靠它派发。
 *
 * 不走插件自带的 view hook（PluginSpec.view）：它返回与否取决于 Milkdown 何时
 * 建好视图，事实上这条链上没被调用到，放在那儿只是一段"看着生效"的死代码 ——
 * 曾经就写在 props.view 里（prosemirror-view 1.4x 的 EditorProps 已无此键）。
 * 显式注入才能保证 PdfLinkApi 就绪时 view 一定在。
 */
export function setBlockLinkView(editorView: EditorView | null): void {
  view = editorView
}

/** 挂到 Milkdown 上：提供 decorations。 */
export const blockLinkProse = $prose(() => {
  return new Plugin({
    key: blockLinkKey,
    state: {
      init() {
        return DecorationSet.empty
      },
      apply(tr, old) {
        const meta = tr.getMeta(blockLinkKey)
        if (meta !== undefined) return meta
        return old.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations(state) {
        return blockLinkKey.getState(state)
      }
    }
  })
})

// ── 对齐 ────────────────────────────────────────────────────────────────
/** 顶层节点 → 锚点里的节点大类。表格/图片/公式块之外的都当段落。 */
function nodeKindOf(typeName: string): BlockAnchor['kind'] {
  if (typeName === 'heading') return 'heading'
  if (typeName === 'math_block') return 'math'
  return 'paragraph'
}

interface DocNode {
  from: number
  to: number
  kind: BlockAnchor['kind']
  fingerprint: string
  /** 图片、HTML 表格这类没有文字的块：靠"节点里挂着 image/html 子节点"认。 */
  hostsAsset: boolean
}

function docTopNodes(doc: EditorView['state']['doc']): DocNode[] {
  const nodes: DocNode[] = []
  doc.forEach((node, offset) => {
    let hostsAsset = false
    node.forEach((child) => {
      if (child.type.name === 'image' || child.type.name === 'html') hostsAsset = true
    })
    nodes.push({
      from: offset,
      to: offset + node.nodeSize,
      kind: nodeKindOf(node.type.name),
      fingerprint: blockFingerprint(node.textContent),
      hostsAsset
    })
  })
  return nodes
}

/** 节点与锚点是否同一块：有文字的比指纹，没文字的比"挂着资源节点"。 */
function isSameBlock(node: DocNode, anchor: BlockAnchor): boolean {
  if (node.kind !== anchor.kind) return false
  return anchor.fingerprint ? anchor.fingerprint === node.fingerprint : node.hostsAsset
}

function align(): void {
  const next = new Map<string, { from: number; to: number }>()
  if (view && anchors.length) {
    const nodes = docTopNodes(view.state.doc)
    const sameShape =
      nodes.length === anchors.length && nodes.every((node, index) => isSameBlock(node, anchors[index]))
    if (sameShape) {
      // 未编辑（或编辑后仍严丝合缝）：直接按序号对，最省也最准。
      nodes.forEach((node, index) => next.set(anchors[index].id, { from: node.from, to: node.to }))
    } else {
      // 编辑过：按指纹顺序贪心 —— 允许跳过对不上的节点（用户新写的段落），
      // 也允许锚点被跳过（用户删掉的块）。
      let cursor = 0
      for (const node of nodes) {
        const limit = Math.min(anchors.length, cursor + LOOKAHEAD)
        for (let index = cursor; index < limit; index++) {
          const anchor = anchors[index]
          if (!isSameBlock(node, anchor)) continue
          next.set(anchor.id, { from: node.from, to: node.to })
          cursor = index + 1
          break
        }
      }
    }
  }
  nodeRanges = next
}

function pushDecorations(): void {
  if (!view) return
  const size = view.state.doc.content.size
  const decorations: Decoration[] = []
  for (const [id, range] of nodeRanges) {
    // 文档被改短了（对齐结果是上一次的）就别画越界的位置。
    if (range.from >= size || range.to > size) continue
    decorations.push(
      Decoration.node(range.from, range.to, {
        class: id === highlightId ? 'pdf-block is-linked-hover' : 'pdf-block',
        'data-block-id': id
      })
    )
  }
  view.dispatch(view.state.tr.setMeta(blockLinkKey, DecorationSet.create(view.state.doc, decorations)))
}

// ── 对外 ────────────────────────────────────────────────────────────────

/**
 * 锚点变化的通知，PDF 侧据此重画矩形层。
 *
 * 必须有这一步：PDF 页面是先渲染的（layoutPages 里按当时的锚点画矩形），而
 * 锚点来自另一条链路 —— 读 sidecar JSON → 转 Markdown（图片还要一张张读盘）
 * → 最后才到这里。谁先谁后不定，PDF 先画完时页面上就一个矩形都没有，之后
 * 不补画的话鼠标悬停只能落在 canvas 上，两侧永远联动不起来。
 */
let anchorsListener: (() => void) | null = null
export function onBlockAnchorsChanged(listener: (() => void) | null): void {
  anchorsListener = listener
}

/** 一份新的解析结果转换完成：换掉锚点并重算对齐。 */
export function setPdfBlockAnchors(blocks: BlockAnchor[], sizes: Array<number[] | null>): void {
  anchors = blocks
  pageSizes = sizes
  highlightId = null
  bindEditorDom()
  rebuild()
  anchorsListener?.()
}

/** 换了文档/关掉对照窗口：清掉标记与锚点。 */
export function clearPdfBlockAnchors(): void {
  anchors = []
  pageSizes = []
  highlightId = null
  rebuild()
  pdfApi?.highlight(null)
  anchorsListener?.()
}

/** 文档被编辑过：重新对齐（防抖，输入时不逐个事务重算）。 */
export function scheduleBlockLinkRebuild(): void {
  if (!anchors.length) return
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    rebuild()
  }, 200)
}

function rebuild(): void {
  align()
  pushDecorations()
}

/** PDF 侧注册自己那两个动作（高亮 / 滚过去）。 */
export function registerPdfLinkApi(api: PdfLinkApi | null): void {
  pdfApi = api
}

export interface BlockRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * 某一页要画的矩形（CSS 像素）。MinerU 的 bbox 与 page_size 同为左上原点、y 向下，
 * 等比换算即可（demo 已验证；旋转页由调用方判断后整页不画）。
 */
export function getPageBlockRects(pageIdx: number, cssWidth: number): BlockRect[] {
  const size = pageSizes[pageIdx]
  if (!size || !size[0]) return []
  const scale = cssWidth / size[0]
  const result: BlockRect[] = []
  for (const anchor of anchors) {
    if (anchor.pageIdx !== pageIdx || !anchor.bbox || anchor.bbox.length < 4) continue
    const [x0, y0, x1, y1] = anchor.bbox
    result.push({
      id: anchor.id,
      x: x0 * scale,
      y: y0 * scale,
      width: Math.max(1, (x1 - x0) * scale),
      height: Math.max(1, (y1 - y0) * scale)
    })
  }
  return result
}

/** PDF 侧悬停：编辑器里对应的块亮起来（不滚动）。 */
export function notePdfHover(id: string | null): void {
  setHighlight(id)
}

/** PDF 侧点击：编辑器滚到那一块并高亮。 */
export function notePdfClick(id: string): void {
  setHighlight(id)
  revealInEditor(id)
}

function setHighlight(id: string | null): void {
  if (id === highlightId) return
  highlightId = id
  pushDecorations()
}

function revealInEditor(id: string): void {
  const range = nodeRanges.get(id)
  if (!range || !view) return
  const dom = view.nodeDOM(range.from)
  if (dom instanceof HTMLElement) {
    dom.scrollIntoView({ block: 'center' })
  } else if (dom instanceof Element) {
    const host = dom.parentElement
    if (host instanceof HTMLElement) host.scrollIntoView({ block: 'center' })
  }
}

// ── 编辑器侧事件 ────────────────────────────────────────────────────────
function blockIdOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest<HTMLElement>('[data-block-id]') : null
  return element?.dataset.blockId ?? null
}

function bindEditorDom(): void {
  if (domBound) return
  // 绑宿主自己那块 #editor：按 id 取会拿到文档里第一个，后台管理面板那一页里也有一块
  // 同 id 的壳（见 host-editor.ts）—— 绑错了就再也收不到正文的 mouseover，块链接整条失效。
  const host = hostEditorEl()
  if (!host) return
  domBound = true
  host.addEventListener('mouseover', (event) => {
    if (!anchors.length) return
    const id = blockIdOf(event.target)
    setHighlight(id)
    pdfApi?.highlight(id)
  })
  host.addEventListener('mouseleave', () => {
    if (!anchors.length) return
    setHighlight(null)
    pdfApi?.highlight(null)
  })
  // 点击才把 PDF 滚过来：悬停只高亮，视口不动。
  host.addEventListener('click', (event) => {
    if (!anchors.length) return
    const id = blockIdOf(event.target)
    if (id) pdfApi?.reveal(id)
  })
}
