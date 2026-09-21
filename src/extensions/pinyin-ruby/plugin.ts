// 规约B：ruby 上方汉字拼音 —— milkdown 插件装配
//
// 把 schema 和 input rule 组装成一个 MilkdownPlugin 数组，
// editor.ts 用 .use(pinyinRubyPlugin) 一次性注册。

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { pinyinRubySchema } from './schema'
import { pinyinRubyInputRule } from './input-rule'

export const pinyinRubyPlugin = [
  pinyinRubySchema,
  pinyinRubyInputRule,
] as unknown as MilkdownPlugin[]
