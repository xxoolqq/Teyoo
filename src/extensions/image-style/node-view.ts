// 图片 NodeView —— WYSIWYG 单击选中出现定位框，拖拽手柄自由调整尺寸
// ────────────────────────────────────────────────────────────────────────────
// 结构：dom = 包裹层 span.teyoo-image-view（position:relative）> img + 定位框
// （.teyoo-image-frame，8 手柄）。img 的属性/样式渲染与 schema.toDOM 完全一致。
//
// - 显隐：ProseMirror 原生 selectNode / deselectNode（点击 inline atom 节点即
//   产生 NodeSelection），定位框画在 nodeView 内部，天然跟随滚动/重排，
//   无需全局 overlay 插件（表格工具条模式的简化版）。
// - 拖拽：手柄 pointerdown → preventDefault（掐断兼容 mouse 事件，PM 不会
//   误当选区拖动）→ setPointerCapture → pointermove 只写 img.style 预览
//   （不进事务）→ pointerup 一次 setNodeMarkup 提交 width/height attrs，
//   单步 undo；attrs 提交后 schema.toMarkdown 自动把新尺寸写回 alt 参数串。
// - 手柄策略：四角锁定宽高比；四边单向调整。
// - 单位策略：原 px / auto → 提交 px；原 % → 按拖拽比例缩放百分数；
//   height 为空（auto）时角拖只提交 width，浏览器按固有比例渲染，与预览一致；
//   边拖（n/s）则显式提交 px 高度。
// - 与 imageEditorPlugin（双击弹参数模态框）天然共存：单击选中、双击编辑。
//
// 样式见 themes/base.css 的「图片 NodeView」区块。

import { $view } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'
import { toFileUrl } from './lib'
import { imageStyleSchema } from './schema'

// 结构化最小类型（避免直接依赖 prosemirror 类型，与 math-engine/node-views.ts 同策略）
interface ImageLikeNode {
  type: { name: string }
  attrs: Record<string, unknown>
}
interface TransactionLike {
  setNodeMarkup: (pos: number, type?: unknown, attrs?: Record<string, unknown>) => unknown
}
interface EditorViewLike {
  state: { tr: TransactionLike }
  dispatch: (tr: unknown) => void
}

type Dir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLES: Array<{ dir: Dir; cursor: string }> = [
  { dir: 'nw', cursor: 'nwse-resize' },
  { dir: 'n', cursor: 'ns-resize' },
  { dir: 'ne', cursor: 'nesw-resize' },
  { dir: 'e', cursor: 'ew-resize' },
  { dir: 'se', cursor: 'nwse-resize' },
  { dir: 's', cursor: 'ns-resize' },
  { dir: 'sw', cursor: 'nesw-resize' },
  { dir: 'w', cursor: 'ew-resize' },
]

/** 最小宽/高（px），拖拽钳制 */
const MIN_SIZE = 32

/** 解析尺寸 attr（'' / 'auto' / '123px' / '45%'）→ has=false 表示未设置（auto） */
function parseSize(raw: unknown): { value: number; unit: 'px' | '%'; has: boolean } {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s || s === 'auto') return { value: 0, unit: 'px', has: false }
  const v = Number.parseFloat(s)
  if (!Number.isFinite(v)) return { value: 0, unit: 'px', has: false }
  return s.endsWith('%') ? { value: v, unit: '%', has: true } : { value: v, unit: 'px', has: true }
}

/** 尺寸数值 → attr 字符串（% 保留两位小数，px 取整） */
function sizeToAttr(value: number, unit: 'px' | '%'): string {
  return unit === '%' ? `${Math.round(value * 100) / 100}%` : `${Math.round(value)}px`
}

interface DragState {
  dir: Dir
  startX: number
  startY: number
  startW: number
  startH: number
  wUnit: 'px' | '%'
  hUnit: 'px' | '%'
  wValue: number
  hValue: number
  wHas: boolean
  hHas: boolean
}

/** 由指针位置算出应提交的 width/height attr；undefined = 该方向不动 */
function computeAttrs(
  d: DragState,
  e: PointerEvent,
): { width?: string; height?: string } {
  const dx = e.clientX - d.startX
  const dy = e.clientY - d.startY
  const dirX = d.dir.includes('w') ? -1 : d.dir.includes('e') ? 1 : 0
  const dirY = d.dir.includes('n') ? -1 : d.dir.includes('s') ? 1 : 0
  const corner = dirX !== 0 && dirY !== 0

  // 目标像素尺寸（水平/垂直驱动分开求；钳制最小值）
  let newW = dirX !== 0 ? Math.max(MIN_SIZE, d.startW + dirX * dx) : null
  let newH = dirY !== 0 ? Math.max(MIN_SIZE, d.startH + dirY * dy) : null

  // 角拖锁定宽高比：以水平驱动为准反推高度；高度触底时回推宽度
  if (corner && newW != null && newH != null) {
    newH = (newW / d.startW) * d.startH
    if (newH < MIN_SIZE) {
      newH = MIN_SIZE
      newW = (newH / d.startH) * d.startW
    }
  }

  // 格式化回原单位：% 按拖拽比例缩放原百分数，px/auto 直接提交 px
  let width: string | undefined
  let height: string | undefined
  if (newW != null) {
    width = d.wHas && d.wUnit === '%' ? sizeToAttr((d.wValue * newW) / d.startW, '%') : sizeToAttr(newW, 'px')
  }
  if (newH != null) {
    if (d.hHas) {
      height = d.hUnit === '%' ? sizeToAttr((d.hValue * newH) / d.startH, '%') : sizeToAttr(newH, 'px')
    } else if (!corner) {
      // 高度原本 auto：仅边拖（n/s）显式提交 px；角拖保持 auto（见文件头注释）
      height = sizeToAttr(newH, 'px')
    }
  }
  return { width, height }
}

export function createImageNodeView(
  node: ImageLikeNode,
  view: EditorViewLike,
  getPos: () => number | undefined,
): {
  dom: HTMLElement
  stopEvent: (e: Event) => boolean
  ignoreMutation: () => boolean
  update: (n: ImageLikeNode) => boolean
  selectNode: () => void
  deselectNode: () => void
  destroy: () => void
} {
  const wrap = document.createElement('span')
  wrap.classList.add('teyoo-image-view')

  const img = document.createElement('img')
  img.draggable = false // 屏蔽浏览器原生图片拖拽，移动节点交给 PM 自身 drag 机制
  wrap.appendChild(img)

  // 定位框：pointer-events none 不挡点击，仅手柄可交互
  const frame = document.createElement('div')
  frame.className = 'teyoo-image-frame'
  for (const { dir, cursor } of HANDLES) {
    const h = document.createElement('span')
    h.className = 'teyoo-image-handle'
    h.dataset.dir = dir
    h.style.cursor = cursor
    frame.appendChild(h)
  }
  wrap.appendChild(frame)

  let current = node
  let drag: DragState | null = null

  // attrs → img 属性/样式（与 schema.toDOM 一致：宽高走 style，样式走 class，
  // 浮动对齐与块级对齐由包裹层承担 img-float-* / img-align-*，img class 只承担
  // border/shadow/radius 这类自身外观）
  const render = (n: ImageLikeNode): void => {
    current = n
    const a = n.attrs
    img.src = toFileUrl(String(a.src ?? ''))
    img.alt = String(a.alt ?? '')
    const title = String(a.title ?? '')
    if (title) img.setAttribute('title', title)
    else img.removeAttribute('title')

    img.style.width = String(a.width ?? '')
    img.style.height = String(a.height ?? '')

    const align = String(a.align ?? '')
    wrap.classList.remove(
      'img-float-left',
      'img-float-right',
      'img-align-left',
      'img-align-center',
      'img-align-right',
    )
    if (align === 'float-left' || align === 'float-right') {
      wrap.classList.add(`img-${align}`)
    } else if (align) {
      // 块级对齐也挂在包裹层：img 的 margin:auto 在 shrink-to-fit 的
      // inline-block 包裹层内无法居中，必须由外层盒子承担对齐
      wrap.classList.add(`img-align-${align}`)
    }

    img.className = ''
    if (a.border === true) img.classList.add('img-border')
    if (a.shadow === true) img.classList.add('img-shadow')
    if (a.radius === true) img.classList.add('img-radius')
  }

  const onHandleDown = (e: PointerEvent): void => {
    const handle = (e.target as HTMLElement | null)?.closest?.('.teyoo-image-handle') as HTMLElement | null
    const dir = handle?.dataset.dir as Dir | undefined
    if (!handle || !dir) return
    e.preventDefault() // 掐断后续兼容 mouse 事件，PM 不会把它当拖选
    e.stopPropagation()
    const rect = img.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const w = parseSize(current.attrs.width)
    const h = parseSize(current.attrs.height)
    drag = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startW: rect.width,
      startH: rect.height,
      wUnit: w.unit,
      hUnit: h.unit,
      wValue: w.value,
      hValue: h.value,
      wHas: w.has,
      hHas: h.has,
    }
    // capture 让 move/up 全部派发给手柄（拖出编辑区也不丢事件）
    handle.setPointerCapture(e.pointerId)
    handle.addEventListener('pointermove', onHandleMove)
    handle.addEventListener('pointerup', onHandleUp)
    handle.addEventListener('pointercancel', onHandleUp)
  }

  const onHandleMove = (e: PointerEvent): void => {
    if (!drag) return
    const { width, height } = computeAttrs(drag, e)
    // 纯样式预览，不进 ProseMirror 事务；width/height undefined 表示该方向不动
    if (width != null) img.style.width = width
    if (height != null) img.style.height = height
  }

  const onHandleUp = (e: PointerEvent): void => {
    const handle = e.currentTarget as HTMLElement | null
    if (handle) {
      handle.removeEventListener('pointermove', onHandleMove)
      handle.removeEventListener('pointerup', onHandleUp)
      handle.removeEventListener('pointercancel', onHandleUp)
      if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId)
    }
    const d = drag
    drag = null
    if (!d) return
    const { width, height } = computeAttrs(d, e)
    const pos = getPos()
    if (typeof pos !== 'number') return
    const attrs: Record<string, unknown> = { ...current.attrs }
    let changed = false
    if (width != null && width !== String(current.attrs.width ?? '')) {
      attrs.width = width
      changed = true
    }
    if (height != null && height !== String(current.attrs.height ?? '')) {
      attrs.height = height
      changed = true
    }
    if (!changed) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, attrs))
  }

  for (const h of frame.children) {
    h.addEventListener('pointerdown', onHandleDown as EventListener)
  }

  // 首次渲染：update 里用 n !== current 判断变更，构造时 current 已是 node，
  // 不在这里画一次 img 就永远是空白（无 src），表现为所有图片不显示
  render(node)

  return {
    dom: wrap,
    // 手柄上的事件全部拦下（capture 期间事件 target 均为手柄），img 上的不拦，
    // PM 默认点击 → NodeSelection 仍生效
    stopEvent: (e) => e.target instanceof Element && e.target.closest('.teyoo-image-handle') != null,
    ignoreMutation: () => true, // atom 节点，内部 DOM 变更全是我们自己的
    update(n) {
      if (n.type.name !== 'image') return false
      if (n !== current) render(n)
      return true
    },
    selectNode: () => wrap.classList.add('is-selected'),
    deselectNode: () => wrap.classList.remove('is-selected'),
    destroy: () => {
      drag = null // 拖拽中节点被销毁：事件监听挂在手柄上，随 DOM 一并回收
    },
  }
}

/** 图片 nodeView：单击选中出现定位框，拖拽手柄调整尺寸 */
export const imageResizeView: MilkdownPlugin = $view(
  imageStyleSchema.node,
  (): NodeViewConstructor =>
    (node, view, getPos) =>
      createImageNodeView(
        node as unknown as ImageLikeNode,
        view as unknown as EditorViewLike,
        getPos as () => number | undefined,
      ),
)
