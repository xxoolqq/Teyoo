// 规约A：字下着重号（点）—— milkdown 插件装配
//
// 把 markAttr、markSchema 和 input rule 组装成一个 MilkdownPlugin 数组，
// editor.ts 用 .use(emphDotPlugin) 一次性注册三者。
//
// 参考 highlight.ts 末尾的写法：
//   export const highlight = [highlightAttr, highlightSchema, highlightInputRule]
//     as unknown as MilkdownPlugin[]

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { emphDotAttr, emphDotSchema } from './schema'
import { emphDotInputRule } from './input-rule'

export const emphDotPlugin = [
  emphDotAttr,
  emphDotSchema,
  emphDotInputRule,
] as unknown as MilkdownPlugin[]
