// 规约B2：同行平级拼音 —— 输入规则
//
// 用户键入 `汉字[拼音]` 后，结尾 `]` 一旦键入立即把命中的字面 token
// 替换成一个 pinyin_inline 原子节点。汉字作为 text 属性存储，pinyin 作为
// pinyin 属性存储。
//
// 实现要点与 pinyin-ruby 相同：不能用 tr.replaceRangeWith（atom 节点 slice
// 拟合静默失败），改用显式三步 delete → insert → setSelection。

import { InputRule } from '@milkdown/kit/prose/inputrules'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'

import { trimHanziToSyllables } from '../pinyin-ruby/pinyin'
import { pinyinInlineSchema } from './schema'

// 组1 = 汉字串（[\u4e00-\u9fa5] 基本 CJK 区）
// 组2 = 完整拼音串（小写字母 + 数字声调，可多音节）
// $ 锚定光标位置：键入 `]` 后 textBefore 以 `汉字[拼音]` 结尾即命中。
// 注意：组1 是贪婪匹配，会吃掉紧贴括号之前的整段连续汉字，
// 命中后须用 trimHanziToSyllables 按音节数裁剪基串（见 pinyin-ruby/pinyin.ts）。
const RE_INPUT = /([\u4e00-\u9fa5]+)\[((?:[a-z]+[1-4]?)+)\]$/

export const pinyinInlineInputRule = $inputRule((ctx) => {
  return new InputRule(RE_INPUT, (state, match, start, end) => {
    const type = pinyinInlineSchema.type(ctx)
    // 多音节拼音按音节数裁剪汉字基串；被裁掉的前导汉字留在原处作为普通文本
    const hanzi = trimHanziToSyllables(match[1], match[2])
    // 实际被替换的区间从裁剪后的基串起点开始（组1 从整个匹配起点开始）
    const from = start + (match[1].length - hanzi.length)
    const node = type.create({
      text: hanzi,
      pinyin: match[2],
    })
    const tr = state.tr
    tr.delete(from, end)
    tr.insert(from, node)
    tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize))
    return tr
  })
})
