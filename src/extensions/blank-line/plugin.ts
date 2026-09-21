// 规约C：行内填空线 —— milkdown 插件装配
//
// 把 schema 和 input rule 组装成一个 MilkdownPlugin 数组，
// editor.ts 用 .use(blankLinePlugin) 一次性注册两者。
//
// 参考 highlight.ts 末尾的写法：
//   export const highlight = [highlightAttr, highlightSchema, highlightInputRule]
//     as unknown as MilkdownPlugin[]

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { blankLineSchema } from './schema'
import { blankLineInputRule } from './input-rule'

export const blankLinePlugin = [
  blankLineSchema,
  blankLineInputRule,
] as unknown as MilkdownPlugin[]
