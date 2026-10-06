import { $prose } from '@milkdown/kit/utils'
import { rootCtx } from '@milkdown/kit/core'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import {
  addRowBeforeCommand,
  addRowAfterCommand,
  addColBeforeCommand,
  addColAfterCommand,
} from '@milkdown/preset-gfm'
import { deleteRow, deleteColumn, deleteTable } from '@milkdown/kit/prose/tables'
import { setTableAlignment } from './editor'

/**
 * 表格悬浮工具条（P1）：
 * - 当光标落在表格单元格内时，在表格上方浮现工具条，提供增删行列、列对齐、删除表格等操作。
 * - 所有结构变更走 milkdown 已注册的 GFM 表格命令 / prosemirror-tables 原生命令，
 *   不手拼 DOM，保证 schema 一致性（见经验 100009448）。
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

  // $Command 对象自带 .run(payload)，内部走 commandsCtx.call(key, payload) 完整调度链
  // （含 editorViewCtx 解析）。不能直接 commandsCtx.get($Command)——$Command 是插件函数
  // 不是 CmdKey，Container 会取 function.name "plugin" 去查找并报 "plugin" not found。
  const runCmd = <T>(cmd: { run: (payload?: T) => boolean }, payload?: T): void => {
    cmd.run(payload)
    view?.focus()
  }

  const runDelete = (fn: (state: EditorView['state'], dispatch: EditorView['dispatch']) => boolean): void => {
    if (!view) return
    fn(view.state, view.dispatch)
    view.focus()
  }

  // 列对齐：走 editorInstance.action → editorViewCtx 通道（和 insertTable 等一致），
  // 不用插件 view() 回调的 dispatch——那在 milkdown 里可能不是真正生效的 dispatch。
  const setAlign = (alignment: 'left' | 'center' | 'right'): void => {
    setTableAlignment(alignment)
  }

  const isEditorVisible = (): boolean => {
    if (!view) return false
    // 直接查 #editor 的 hidden 类——main.ts 源码切换时就是这么标记的。
    // 不用 offsetParent（依赖布局计算时序），也不用 view.dom.parentElement
    // （milkdown 中间有 wrapper，不是 #editor 本身）。
    const root = document.getElementById('editor')
    return !root?.classList.contains('hidden')
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
      btn('⬆', '上方插入行', () => runCmd(addRowBeforeCommand)),
      btn('⬇', '下方插入行', () => runCmd(addRowAfterCommand)),
      btn('⬅', '左侧插入列', () => runCmd(addColBeforeCommand)),
      btn('➡', '右侧插入列', () => runCmd(addColAfterCommand)),
      sep(),
      btn('删行', '删除当前行', () => runDelete(deleteRow)),
      btn('删列', '删除当前列', () => runDelete(deleteColumn)),
      sep(),
      btn('左', '列左对齐', () => setAlign('left')),
      btn('中', '列居中', () => setAlign('center')),
      btn('右', '列右对齐', () => setAlign('right')),
      sep(),
      btn('🗑', '删除表格', () => runDelete(deleteTable)),
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
