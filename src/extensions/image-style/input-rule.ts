// 图片样式扩展 —— 输入规则
//
// commonmark preset 自带 insertImageInputRule，但它绑定的是 preset 内部的
// imageSchema。覆盖 image schema 后，为确保键入 ![alt](url) 仍能即时生成
// 图片节点，这里用覆盖后的 imageStyleSchema.type(ctx) 重新提供一份输入规则。
//
// 正则与 commonmark 一致，支持可选 title。

import { InputRule } from '@milkdown/kit/prose/inputrules'
import { $inputRule } from '@milkdown/kit/utils'
import { imageStyleSchema } from './schema'

// ![alt](url "title?") 完整匹配
//   组1 = alt 文本（可含 #参数）
//   组2 = url
//   组3 = 可选 title
const RE_IMAGE = /!\[(?<alt>[^\]]*)\]\((?<url>[^)\s]+)(?:\s+"(?<title>[^"]*)")?\)$/

export const imageStyleInputRule = $inputRule((ctx) => {
  return new InputRule(RE_IMAGE, (state, match, start, end) => {
    const type = imageStyleSchema.type(ctx)
    return state.tr.replaceRangeWith(start, end, type.create({
      src: match[2],
      alt: match[1],
      title: match[3] ?? '',
    }))
  })
})
