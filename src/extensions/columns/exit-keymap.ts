// 规约F：子块与分栏 —— 容器退出键位 + 文档末尾哨兵段落
//
// 问题：子块/分栏是块级容器，光标在最后一个段落里按 Enter 默认只会在
// 容器内新建段落，用户没有直观方式离开容器继续写正文。
//
// 解决方案有两层：
//
// 1. Enter 退出（handleKeyDown）
//    光标在「子块最后一个直接子段落」且该段落为空时按 Enter：
//      - 独立子块 → 在子块之后插入空段落并跳过去；
//      - 分栏内最后一列的子块 → 在分栏之后插入空段落并跳过去；
//      - 分栏内非最后一列 → 不拦截（正常在子块内换行；用户可用鼠标/方向键
//        进入下一列）。
//    段落嵌套在列表等更深结构中时不拦截，避免破坏列表的 Enter 行为。
//
// 2. 文档末尾哨兵段落（appendTransaction）
//    当 sub_block 或 cols 是文档的最后一个节点时，光标无法跳出容器——
//    方向键、鼠标点击都找不到后续可编辑节点。此 plugin 在每次事务后
//    检查 doc.lastChild，若为容器节点则自动追加一个空段落，确保光标
//    总能落在容器之后。

import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

export const columnsExitKeymap = $prose(() => {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'Enter') return false
        const { state } = view
        const { $from, empty } = state.selection
        if (!empty) return false
        // 必须位于空段落
        const para = $from.parent
        if (para.type.name !== 'paragraph' || para.content.size > 0) return false

        // 找最近的 sub_block 祖先
        let subDepth = -1
        for (let d = $from.depth; d > 0; d--) {
          const name = $from.node(d).type.name
          if (name === 'sub_block') {
            subDepth = d
            break
          }
          if (name === 'cols') return false
        }
        if (subDepth === -1) return false

        // 段落必须是子块的直接最后一个子节点
        const subNode = $from.node(subDepth)
        if (subNode.lastChild !== para) return false

        // 若子块位于分栏内，仅最后一列允许跳出
        let exitDepth = subDepth
        for (let d = subDepth - 1; d > 0; d--) {
          if ($from.node(d).type.name === 'cols') {
            if ($from.node(d).lastChild !== subNode) return false
            exitDepth = d
            break
          }
        }

        // 在容器之后插入空段落并移动光标
        const insertPos = $from.end(exitDepth) + 1
        const tr = state.tr.insert(insertPos, state.schema.nodes.paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
        view.dispatch(tr)
        return true
      },
    },

    // 文档末尾哨兵：容器是 doc.lastChild 时追加空段落
    appendTransaction(_trs, oldState, newState) {
      const last = newState.doc.lastChild
      if (!last) return null
      if (last.type.name !== 'sub_block' && last.type.name !== 'cols') return null
      // 避免无意义的事务：仅在文档实际以容器结尾时追加
      const tr = newState.tr.insert(
        newState.doc.content.size,
        newState.schema.nodes.paragraph.create()
      )
      return tr
    },
  })
})
