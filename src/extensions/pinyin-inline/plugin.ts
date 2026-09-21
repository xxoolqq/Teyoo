// 规约B2：同行平级拼音 —— milkdown 插件装配

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { pinyinInlineSchema } from './schema'
import { pinyinInlineInputRule } from './input-rule'

export const pinyinInlinePlugin = [
  pinyinInlineSchema,
  pinyinInlineInputRule,
] as unknown as MilkdownPlugin[]
