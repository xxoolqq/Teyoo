// 规约H：字体大小规约 —— 块容器退出与删除键位 + 文档末尾哨兵段落
//
// 问题：font_block（:::font 块容器）包裹多段内容后，若容器内最后一个段落
// 处于文档末尾（或容器本身是文档最后一个节点），光标无法离开容器继续写
// 不带样式的段落——Enter 只会在容器内新建段落，方向键/鼠标也找不到后续
// 可编辑节点。
//
// 与规约F（columns/exit-keymap.ts）同一套方案，另增 Backspace 删容器：
//
// 1. Enter 退出（handleKeyDown）
//    光标位于 font_block 最后一个「直接子空段落」时按 Enter：
//    在该容器之后插入空段落并把光标移出去。嵌套容器时只退出最内层
//    一级，再次 Enter 可继续向外退出。段落处于列表等更深结构中（即不是
//    容器的直接子节点）时不拦截，保留列表原有 Enter 条件。
//
// 2. Backspace 删除容器（handleKeyDown）
//    光标停在容器第一个直接子空段落的开头（parentOffset === 0）时按
//    Backspace：提升（lift）解除最近一层 font_block，内容原样保留，
//    与 ProseMirror 引用块的 Backspace 惯例一致。光标不在段落开头时
//    不拦截（正常删字）。
//
// 3. 文档末尾哨兵段落（appendTransaction）
//    每次事务后若 doc.lastChild 是 font_block，自动在其后追加空段落，
//    保证方向键、鼠标点击总有容器之外的落脚点。该空段落不写任何字体
//    属性，序列化时按普通空段落处理。

import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { liftTarget } from '@milkdown/kit/prose/transform'
import { $prose } from '@milkdown/kit/utils'

export const fontBlockExitKeymap = $prose(() => {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        const key = event.key
        if (key !== 'Enter' && key !== 'Backspace') return false
        const { state } = view
        const { $from, empty } = state.selection
        if (!empty) return false
        // 必须位于空段落
        const para = $from.parent
        if (para.type.name !== 'paragraph' || para.content.size > 0) return false

        // 找最近的 font_block 祖先
        let fontDepth = -1
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === 'font_block') {
            fontDepth = d
            break
          }
        }
        if (fontDepth === -1) return false

        // ── Backspace：容器第一个直接子空段落开头 → 解除容器 ──
        if (key === 'Backspace') {
          // 必须在段落开头；且段落是容器的第一个直接子节点（在列表等更深
          // 结构内时 $from 向上先遇到列表，fontDepth 对应层关系不成立，
          // 这里通过 index === 0 再兜一层）。
          if ($from.parentOffset !== 0) return false
          const indexInContainer = $from.index(fontDepth)
          if (indexInContainer !== 0) return false
          // blockRange 谓词锁定到 font_block 层，liftTarget 给出提升目标，
          // tr.lift 仅删除容器包裹层，段落内容原样保留。
          const range = $from.blockRange($from, (node) => node.type.name === 'font_block')
          if (!range) return false
          const target = liftTarget(range)
          if (target == null) return false
          view.dispatch(state.tr.lift(range, target).scrollIntoView())
          return true
        }

        // ── Enter：容器最后一个直接子空段落 → 跳出容器 ──
        // 段落必须是容器的直接最后一个子节点（在列表等更深结构内时不拦截）
        if ($from.node(fontDepth).lastChild !== para) return false

        // 在容器之后插入空段落并移动光标：end(depth) 是容器内容结束位置，
        // +1 即容器闭合边界之外
        const insertPos = $from.end(fontDepth) + 1
        const tr = state.tr.insert(insertPos, state.schema.nodes.paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
        view.dispatch(tr)
        return true
      },
    },

    // 文档末尾哨兵：font_block 是 doc.lastChild 时追加空段落
    appendTransaction(_trs, _oldState, newState) {
      const last = newState.doc.lastChild
      if (!last) return null
      if (last.type.name !== 'font_block') return null
      return newState.tr.insert(
        newState.doc.content.size,
        newState.schema.nodes.paragraph.create()
      )
    },
  })
})
