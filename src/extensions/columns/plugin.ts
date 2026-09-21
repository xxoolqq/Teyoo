// 规约F：子块与分栏 —— milkdown 插件装配

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { subBlockSchema, colsSchema } from './schema'
import { subBlockInputRule, colsInputRule } from './input-rule'
import { columnsExitKeymap } from './exit-keymap'

export const columnsPlugin = [
  subBlockSchema,
  colsSchema,
  subBlockInputRule,
  colsInputRule,
  columnsExitKeymap,
] as unknown as MilkdownPlugin[]
