// 规约A：字下着重号（点）—— 输入规则
//
// 用户在编辑器中键入 `@.内容.@`，结尾 `.@` 一旦键入立即把
// 命中的字面 token 替换成带 emphDot mark 的文字内容。
// 否则需保存后重载文件才会渲染（与 highlight.ts 的 ==text== 输入规则一致）。
//
// 实现：用 milkdown 内置 markRule，模式为 tr.delete + tr.addMark，
// 对 mark 节点天然有效（与 atom 节点的 replaceRangeWith 不同，后者会
// 因 slice openStart/openEnd 不匹配静默失败 —— 见 blank-line input-rule）。

import { markRule } from '@milkdown/kit/prose'
import { $inputRule } from '@milkdown/kit/utils'

import { emphDotSchema } from './schema'

// 组1 = 内容（不含 @，但可含 \n —— 输入场景下通常单行）
// $ 锚定光标位置：键入 `.@` 后 textBefore 以 `@.内容.@` 结尾即命中。
const RE_INPUT = /@\.([^@]+)\.@$/

export const emphDotInputRule = $inputRule((ctx) => {
  return markRule(RE_INPUT, emphDotSchema.type(ctx))
})
