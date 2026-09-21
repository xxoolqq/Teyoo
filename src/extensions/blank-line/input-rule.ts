// 规约C：行内填空线 —— 输入规则
//
// 用户在编辑器中键入 `--(5)` 或 `--(5,blank)`，结尾 `)` 一旦键入立即把
// 命中的字面 token 替换成 blank_line 节点。否则需保存后重载文件才会渲染
// （与 highlight.ts 的 ==text== 输入规则思路一致）。
//
// 实现要点：不能用 tr.replaceRangeWith —— 它对内联原子节点的 slice
// 做"智能"拟合时会静默失败（slice.openStart/openEnd 不匹配周围文本）。
// 改用与 markRule 同款的显式模式：先 delete 删匹配区间，再 insert 节点，
// 最后 setSelection 把光标移到节点之后。

import { InputRule } from '@milkdown/kit/prose/inputrules'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'

import { blankLineSchema } from './schema'

// 组1 = N（整数或小数），组2 = 可选的 ,blank
// $ 锚定光标位置：键入 `)` 后 textBefore 以 `--(N)` 或 `--(N,blank)` 结尾即命中。
const RE_INPUT = /--\((\d+(?:\.\d+)?)(,blank)?\)$/

export const blankLineInputRule = $inputRule((ctx) => {
  return new InputRule(RE_INPUT, (state, match, start, end) => {
    const type = blankLineSchema.type(ctx)
    const node = type.create({
      chars: Number(match[1]),
      blank: match[2] === ',blank',
    })
    const tr = state.tr
    // 1. 删除整个匹配区间 [--(N)] 或 [--(N,blank)]
    //    delete 后 start 位置成为空位（原匹配起点的位置）
    tr.delete(start, end)
    // 2. 在 start 位置插入 blank_line 内联原子节点
    //    ProseMirror 的 tr.insert 会在需要时自动拆分文本节点，
    //    让内联节点正确落入段落内
    tr.insert(start, node)
    // 3. 把光标移到节点之后，便于继续输入后续文本
    //    node.nodeSize 对原子节点=1，所以 start + 1 即节点后位置
    tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize))
    return tr
  })
})
