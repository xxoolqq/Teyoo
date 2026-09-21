// 规约G：汉字田字格 —— milkdown 插件装配

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { tianziGridSchema } from './schema'
import { tianziGridInputRule } from './input-rule'

export const tianziGridPlugin = [
  tianziGridSchema,
  tianziGridInputRule,
] as unknown as MilkdownPlugin[]
