// 规约E：汉字右上角带圈序号 —— 输入规则
//
// 键入 `汉字^{数字}` 后，结尾 `}` 一旦键入立即替换为 circled_sup 原子节点。

import { InputRule } from '@milkdown/kit/prose/inputrules'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'

import { circledSupSchema } from './schema'

// 组1 = 单个汉字，组2 = 纯数字
const RE_INPUT = /([\u4e00-\u9fa5])\^\{(\d+)\}$/

export const circledSupInputRule = $inputRule((ctx) => {
  return new InputRule(RE_INPUT, (state, match, start, end) => {
    const type = circledSupSchema.type(ctx)
    const node = type.create({
      char: match[1],
      num: match[2],
    })
    const tr = state.tr
    tr.delete(start, end)
    tr.insert(start, node)
    tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize))
    return tr
  })
})
