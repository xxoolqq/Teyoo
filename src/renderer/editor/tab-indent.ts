// Tab 键缩进 —— 偏好设置「编辑器 → Tab 设置 → Tab 键行为：缩进」
//
// 浏览器默认行为：contenteditable 里按 Tab 把焦点移到下一个可聚焦元素。
// 编辑器在 DOM 里靠后，焦点便绕回标题栏的菜单栏——既不是预期行为，也没有
// 任何编辑器逻辑消费这个键（Tab 键此前完全没有绑定）。这里接管 Tab：
//   - 列表项内：Tab 降一级（sinkListItem），Shift+Tab 升一级（liftListItem）
//   - 代码块内：CodeMirror 节点视图自己处理 Tab，不拦截
//   - 其余（段落 / 标题 / 表格单元格等）：插入或删除缩进
//
// 缩进字符用全角空格 U+3000，不用半角空格或 \t：
//   - 连续半角空格会被 HTML 渲染折叠，且可能被 Markdown 序列化规整；
//   - 行首的半角空格 / 制表符在 CommonMark 里构成「缩进代码块」。
// 全角空格是普通 CJK 字符，两种风险都没有（与工具栏「长空白」同一手法）。

import { Plugin } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import { liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list'
import { getPrefs } from '../preferences-store'

const IDEOGRAPHIC_SPACE = '　'

// 缩进宽度：Tab 大小（2/4/8 个半角空格）换算成全角空格个数，缺省 2。
function indentWidth(): number {
  const tabSize = getPrefs<number>('editor.tabSize') ?? 4
  return Math.max(1, Math.round(tabSize / 2))
}

export const tabIndentPlugin = $prose(() => {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'Tab') return false
        const { state } = view
        const { $from, from, to } = state.selection

        // 代码块是 CodeMirror 节点视图，Tab 交给它自己
        if ($from.parent.type.name === 'code_block') return false

        // 列表项内：升降级
        const listItemType = state.schema.nodes.list_item
        if (listItemType) {
          let listDepth = -1
          for (let d = $from.depth; d > 0; d -= 1) {
            if ($from.node(d).type.name === 'list_item') {
              listDepth = d
              break
            }
          }
          if (listDepth > 0) {
            const cmd = event.shiftKey ? liftListItem(listItemType) : sinkListItem(listItemType)
            cmd(state, view.dispatch.bind(view), view)
            // 已在最外层时 sink 会失败：仍然吞掉 Tab，免得焦点跑出编辑器
            return true
          }
        }

        const unit = IDEOGRAPHIC_SPACE.repeat(indentWidth())
        const tr = state.tr

        if (event.shiftKey) {
          // 反缩进：删掉光标前最多一个缩进宽度的全角空格
          const parent = $from.parent
          const start = Math.max(0, $from.parentOffset - unit.length)
          const before = parent.textBetween(start, $from.parentOffset, undefined, '￼')
          let count = 0
          for (let i = before.length - 1; i >= 0; i -= 1) {
            if (before[i] === IDEOGRAPHIC_SPACE) count += 1
            else break
          }
          if (count > 0) {
            tr.delete(from - count, to)
            view.dispatch(tr.scrollIntoView())
          }
          return true
        }

        tr.insertText(unit, from, to)
        view.dispatch(tr.scrollIntoView())
        return true
      },
    },
  })
})
