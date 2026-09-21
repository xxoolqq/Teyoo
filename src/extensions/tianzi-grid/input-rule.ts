// 规约G：汉字田字格 —— 输入规则
//
// 键入结尾第二个 + 时，若 ++...++ 内容是合法形态（汉字 / (N) / () / (拼音)），
// 立即把整段 token 替换成一个 tianzi_grid 原子节点。
// 非法内容（++abc++ 等）不触发，保留普通文本。
//
// 实现与 blank-line 同款三步（delete → insert → setSelection），
// 不能用 tr.replaceRangeWith（atom 节点 slice 拟合会静默失败）。

import { InputRule } from '@milkdown/kit/prose/inputrules'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'

import { tianziGridSchema } from './schema'
import { RE_TIANZI_INPUT, parseCells } from './lib'

export const tianziGridInputRule = $inputRule((ctx) => {
  return new InputRule(RE_TIANZI_INPUT, (state, match, start, end) => {
    const inner = match[1]
    // 非法 token 不识别
    if (!parseCells(inner)) return null
    const type = tianziGridSchema.type(ctx)
    const node = type.create({ raw: inner })
    const tr = state.tr
    tr.delete(start, end)
    tr.insert(start, node)
    tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize))
    return tr
  })
})
