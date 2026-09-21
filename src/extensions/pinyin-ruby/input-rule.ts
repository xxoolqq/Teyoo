// 规约B：ruby 上方汉字拼音 —— 输入规则
//
// 用户键入 `汉字(拼音)` 后，结尾 `)` 一旦键入立即把命中的字面 token
// 替换成一个 pinyin_ruby 原子节点。汉字作为 text 属性存储，pinyin 作为
// pinyin 属性存储。
//
// 实现要点：不能用 tr.replaceRangeWith —— 它对内联原子节点的 slice
// 拟合会静默失败（与 blank-line 同样的坑）。
// 改用显式三步：tr.delete → tr.insert 节点 → setSelection 移到节点之后。
// atom 节点 nodeSize=1，光标在 start + 1，是 ruby 之外的明确位置，
// 后续输入必然进入段落的兄弟文本节点（不会跑到 ruby 内部）。

import { InputRule } from '@milkdown/kit/prose/inputrules'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'

import { trimHanziToSyllables } from './pinyin'
import { pinyinRubySchema } from './schema'

// 组1 = 汉字串（[\u4e00-\u9fa5] 基本 CJK 区）
// 组2 = 完整拼音串（小写字母 + 数字声调，可多音节）
// $ 锚定光标位置：键入 `)` 后 textBefore 以 `汉字(拼音)` 结尾即命中。
// 注意：组1 是贪婪匹配，会吃掉紧贴括号之前的整段连续汉字，
// 命中后须用 trimHanziToSyllables 按音节数裁剪基串（见 pinyin.ts）。
const RE_INPUT = /([\u4e00-\u9fa5]+)\(((?:[a-z]+[1-4]?)+)\)$/

export const pinyinRubyInputRule = $inputRule((ctx) => {
  return new InputRule(RE_INPUT, (state, match, start, end) => {
    const type = pinyinRubySchema.type(ctx)
    // 多音节拼音按音节数裁剪汉字基串；被裁掉的前导汉字留在原处作为普通文本
    const hanzi = trimHanziToSyllables(match[1], match[2])
    // 实际被替换的区间从裁剪后的基串起点开始（组1 从整个匹配起点开始）
    const from = start + (match[1].length - hanzi.length)
    // 创建 atom 节点：text + pinyin 都作为属性
    const node = type.create({
      text: hanzi,
      pinyin: match[2],
    })
    const tr = state.tr
    // 1. 删除匹配区间内 [from, end)，前导汉字文本保留
    tr.delete(from, end)
    // 2. 在 from 位置插入 ruby 原子节点
    tr.insert(from, node)
    // 3. 把光标移到节点之后，便于继续输入后续文本
    // atom 节点 nodeSize=1，from + 1 是 ruby 之外的明确位置
    tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize))
    return tr
  })
})
