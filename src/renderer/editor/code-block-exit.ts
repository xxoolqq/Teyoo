// 代码块 —— 文档末尾哨兵段落
//
// 问题：code_block（``` 围栏）是 CodeMirror 节点视图，当它位于文档最后一个
// 节点时，块后没有任何可落点：ArrowDown 走到代码最后一行无处可去，鼠标
// 点击块下方也没有节点可选中，光标被「困」在代码块里出不来。
//
// 解决方案：与 columns / font-style 的 exit-keymap 相同的文档末尾哨兵
// （appendTransaction）：code_block 是 doc.lastChild 时自动追加一个空段落，
// 保证块后始终存在可编辑节点，方向键与鼠标点击都能离开代码块。
//
// 序列化影响：空段落序列化为空，文件内容至多多一个行尾空行；重新解析时
// remark 会丢弃末尾空段落、哨兵重新补上——稳定无累积。
// mermaid 代码块同为 code_block 节点（语言属性区分），一并受益。

import { Plugin } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

export const codeBlockExitPlugin = $prose(() => {
  return new Plugin({
    // 文档末尾哨兵：代码块是 doc.lastChild 时追加空段落
    appendTransaction(_trs, _oldState, newState) {
      const last = newState.doc.lastChild
      if (!last || last.type.name !== 'code_block') return null
      // 避免无意义的事务：仅在文档实际以代码块结尾时追加
      return newState.tr.insert(
        newState.doc.content.size,
        newState.schema.nodes.paragraph.create()
      )
    },
  })
})
