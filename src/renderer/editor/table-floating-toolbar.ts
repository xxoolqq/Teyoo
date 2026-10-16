import { $prose } from '@milkdown/kit/utils'
import { rootCtx, editorViewCtx } from '@milkdown/kit/core'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import {
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
  isInTable,
  selectedRect,
} from '@milkdown/kit/prose/tables'
import { setTableAlignment } from './editor'
import { hostEditorEl } from '../host-editor'

/**
 * 表格悬浮工具条（P1）：
 * - 当光标落在表格单元格内时，在表格上方浮现工具条，提供增删行列、列对齐、删除表格等操作。
 * - 行列操作不走 milkdown 命令层（$command 是模块级单例，同一文档挂第二个编辑器后
 *   .run/.key 会被重绑到新编辑器，主编辑器的派发会错位），统一用本实例的 view 直接
 *   派发事务；行操作做了 GFM 表头感知（见 insertRow / deleteRowSmart 的注释）。
 * - 定位：position:fixed，锚定到表格 DOM 的 getBoundingClientRect，渲染到 body 层
 *   避免被祖先 overflow 裁剪，做视口边界 clamp（见经验 100001967）。
 */

export const tableToolbarPluginKey = new PluginKey('colamd-table-toolbar')

// 沿着选区 $from 向上查找 table 祖先，返回 table 在文档中的起始位置。
function findTablePos(state: EditorState): number | null {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') {
      return $from.before(d)
    }
  }
  return null
}

export const tableFloatingToolbarPlugin = $prose((ctx) => {
  // 本实例自己的根元素。原来写死 getElementById('editor')，一页两个编辑器时
  // 两个实例的工具条都会跟着第一个容器的 hidden class 走。
  const editorRoot = ctx.get(rootCtx) as HTMLElement | null
  let view: EditorView | null = null
  let toolbarEl: HTMLDivElement | null = null
  // 监听编辑器根元素的可见性变化（切源码模式时 PM 不发 transaction，
  // 需主动重算以避免工具条残留在 textarea 上方）。
  let visObserver: MutationObserver | null = null

  // ── 行列操作 ─────────────────────────────────────────────────────────────
  // 统一用本实例的 view 派发，不走 milkdown 命令层。
  //
  // GFM schema 的关键约束：表格内容表达式是 "table_header_row table_row+"——
  // 表头行必须存在且必须是首行。prosemirror-tables 的原生命令对此不感知，
  // Node 探针复现的两个后果（.tmp 探针已清理，结论记录于此）：
  //   ① 在表头行删行 / 删唯一表体行 → ProseMirror 的替换拟合删不动会产生
  //      非法文档的整行，退而只把该行的单元格吃掉、留一个空行，光标落到
  //      下一行（用户看到的「删不掉、光标下移」）。空表头行还会让 TableMap
  //      把第一行的「单元格」映射到表头行节点本身，之后增删行列全部错位，
  //      产出「单元格是表头行」的畸形结构（用户看到的「删列反而变多」）。
  //   ② 在表头行「上方插入行」→ 表体行插不进表头之前，替换拟合直接把表格
  //      拆成两张表（用户看到的「插入了一个单独的表格」）。
  // 因此行操作在这里自己做：插行位置钳到表头之后，删行走表头晋升语义。

  const currentView = (): EditorView => ctx.get(editorViewCtx)

  // 插入一个带列对齐的空表体行（列对齐跟随表头行，与 preset-gfm 的
  // addRowWithAlignment 同口径）。GFM 要求表头行是首行，所以插入下标
  // 钳到 [1, height]：在表头行点「上方插入行」等价于插到表头正下方。
  const insertRow = (where: 'above' | 'below'): void => {
    const v = currentView()
    const state = v.state
    if (!isInTable(state)) return
    const rect = selectedRect(state)
    const at = where === 'above' ? Math.max(1, rect.top) : rect.bottom
    let rowPos = rect.tableStart
    for (let i = 0; i < at; i++) rowPos += rect.table.child(i).nodeSize
    const { table_cell: cellType, table_row: rowType } = state.schema.nodes
    if (!cellType || !rowType) return
    const cells: ProseNode[] = []
    for (let col = 0; col < rect.map.width; col++) {
      // 第一行的第 col 格即表头格，取其对齐作为新行的列对齐
      const headerCell = rect.table.nodeAt(rect.map.map[col])
      const cell = cellType.createAndFill({ alignment: headerCell?.attrs.alignment })
      if (cell) cells.push(cell)
    }
    const tr: Transaction = state.tr.insert(rowPos, rowType.create(null, cells))
    v.dispatch(tr.scrollIntoView())
    v.focus()
  }

  // 删行（GFM 表头感知）：
  // - 光标在表体行：prosemirror-tables 原生 deleteRow（此时结果合法）。
  // - 光标在表头行：表头行不能直接删。「删掉这一行」的等价语义 = 第一个
  //   表体行晋升为新表头（单元格换成 table_header），原表头行消失。
  // - 无论哪种，删完必须仍剩 ≥1 表头行 + ≥1 表体行，否则不动（删到只剩
  //   表头会触发替换拟合吃单元格留空行的问题）。
  const deleteRowSmart = (): void => {
    const v = currentView()
    const state = v.state
    if (!isInTable(state)) return
    const rect = selectedRect(state)
    const { table, tableStart } = rect
    if (table.childCount - (rect.bottom - rect.top) < 2) return
    if (rect.top > 0) {
      deleteRow(state, v.dispatch)
      v.focus()
      return
    }
    const { table_header: headerType, table_header_row: headerRowType } = state.schema.nodes
    if (!headerType || !headerRowType) return
    const headerRow = table.child(0)
    const firstBody = table.child(1)
    const newCells: ProseNode[] = []
    for (let i = 0; i < firstBody.childCount; i++) {
      const cell = firstBody.child(i)
      newCells.push(headerType.create(cell.attrs, cell.content))
    }
    const tr = state.tr.replaceWith(
      tableStart,
      tableStart + headerRow.nodeSize + firstBody.nodeSize,
      headerRowType.create(null, newCells),
    )
    // 光标放回新表头行的同列单元格
    let cellPos = tableStart + 1
    for (let i = 0; i < Math.min(rect.left, newCells.length); i++) {
      cellPos += newCells[i].nodeSize
    }
    tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos)))
    v.dispatch(tr.scrollIntoView())
    v.focus()
  }

  // 删列 / 删表 / 增列：prosemirror-tables 原生命令在表头/表体均安全
  // （列操作不触碰「表头行必须存在且是首行」的结构约束），直接派发即可。
  const runRaw = (fn: (state: EditorState, dispatch: EditorView['dispatch']) => boolean): void => {
    const v = currentView()
    fn(v.state, v.dispatch)
    v.focus()
  }

  // 列对齐：走 editorInstance.action → editorViewCtx 通道（和 insertTable 等一致），
  // 不用插件 view() 回调的 dispatch——那在 milkdown 里可能不是真正生效的 dispatch。
  const setAlign = (alignment: 'left' | 'center' | 'right'): void => {
    setTableAlignment(alignment)
  }

  const isEditorVisible = (): boolean => {
    if (!view) return false
    // 直接查本实例根元素的 hidden 类——main.ts 源码切换时就是这么标记的。
    // 不用 offsetParent（依赖布局计算时序），也不用 view.dom.parentElement
    // （milkdown 中间有 wrapper，不是 #editor 本身）。
    // 根元素优先用本实例自己的（上面已取）：写死 getElementById('editor') 会拿到文档里
    // 第一个 #editor —— 后台管理面板那页也有一块同 id 的壳（见 host-editor.ts）。
    const root = editorRoot ?? hostEditorEl()
    if (root?.classList.contains('hidden')) return false
    // 纯渲染区不浮工具条：后台管理预览（.preview-root）与宿主提交视图的 #editor
    // 都用 pointer-events: none 锁只读。pointer-events 是继承属性，根元素的计算
    // 样式无论 none 设在自身还是祖先都会是 none。工具条渲染在 body 层不受
    // pointer-events 管，必须在这里显式挡——否则 setMarkdown 的 replaceAll 把
    // 光标重置到文档开头、表格恰为首节点时，工具条会浮在只读区表格上方。
    if (root && getComputedStyle(root).pointerEvents === 'none') return false
    return true
  }

  const position = (): void => {
    if (!view || !toolbarEl) return
    if (!isEditorVisible()) {
      toolbarEl.style.display = 'none'
      return
    }
    const pos = findTablePos(view.state)
    if (pos === null) {
      toolbarEl.style.display = 'none'
      return
    }
    const dom = view.nodeDOM(pos) as HTMLElement | null
    // nodeDOM 可能在表格结构变化后短暂为 null。
    if (!dom) {
      toolbarEl.style.display = 'none'
      return
    }
    const rect = dom.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      toolbarEl.style.display = 'none'
      return
    }
    const tbRect = toolbarEl.getBoundingClientRect()
    // 标题栏 40px，避免被遮住。
    const MIN_TOP = 44
    let top = rect.top - tbRect.height - 6
    let left = rect.left
    if (top < MIN_TOP) top = rect.bottom + 6
    if (left + tbRect.width > window.innerWidth - 8) {
      left = window.innerWidth - tbRect.width - 8
    }
    if (left < 8) left = 8
    toolbarEl.style.top = `${Math.round(top)}px`
    toolbarEl.style.left = `${Math.round(left)}px`
    toolbarEl.style.display = 'flex'
  }

  const btn = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'colamd-tb-btn'
    b.title = title
    b.textContent = label
    // mousedown preventDefault 维持编辑器选区焦点，避免点击导致选区丢失
    // （项目记忆：工具栏按钮必须 mousedown preventDefault）。
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', onClick)
    return b
  }

  const sep = (): HTMLSpanElement => {
    const s = document.createElement('span')
    s.className = 'colamd-tb-sep'
    return s
  }

  const buildToolbar = (): HTMLDivElement => {
    const el = document.createElement('div')
    el.className = 'colamd-table-toolbar'
    el.style.display = 'none'

    el.append(
      btn('⬆', '上方插入行', () => insertRow('above')),
      btn('⬇', '下方插入行', () => insertRow('below')),
      btn('⬅', '左侧插入列', () => runRaw(addColumnBefore)),
      btn('➡', '右侧插入列', () => runRaw(addColumnAfter)),
      sep(),
      btn('删行', '删除当前行', deleteRowSmart),
      btn('删列', '删除当前列', () => runRaw(deleteColumn)),
      sep(),
      btn('左', '列左对齐', () => setAlign('left')),
      btn('中', '列居中', () => setAlign('center')),
      btn('右', '列右对齐', () => setAlign('right')),
      sep(),
      btn('🗑', '删除表格', () => runRaw(deleteTable)),
    )
    return el
  }

  return new Plugin({
    key: tableToolbarPluginKey,
    view: (v) => {
      view = v
      toolbarEl = buildToolbar()
      document.body.appendChild(toolbarEl)
      // 捕获阶段监听所有滚动容器的滚动，实时重算位置。
      window.addEventListener('scroll', position, true)
      window.addEventListener('resize', position)
      // 监听本编辑器根元素的 class 变化（源码切换时在其上加 hidden 类）。
      // 不能用 view.dom.parentElement——milkdown 7 在 PM 根节点外又包了一层，
      // 那个 wrapper 不是根元素，observer 根本不会被触发。
      if (editorRoot) {
        visObserver = new MutationObserver(position)
        visObserver.observe(editorRoot, { attributes: true, attributeFilter: ['class'] })
      }
      return {
        update: (vu) => {
          view = vu
          position()
        },
        destroy: () => {
          window.removeEventListener('scroll', position, true)
          window.removeEventListener('resize', position)
          visObserver?.disconnect()
          visObserver = null
          toolbarEl?.remove()
          toolbarEl = null
          view = null
        },
      }
    },
  })
})
