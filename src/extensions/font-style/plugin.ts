// 规约H：字体大小规约 —— milkdown 插件装配
//
// 把 font_block 节点、font_span mark 及块容器退出键位装配成一个
// MilkdownPlugin 数组，editor.ts 用 .use(fontStylePlugin) 一次性注册。

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { fontBlockSchema, fontSpanSchema, fontSpanAttr } from './schema'
import { fontBlockExitKeymap } from './exit-keymap'

export const fontStylePlugin = [
  fontBlockSchema,
  fontSpanAttr,
  fontSpanSchema,
  fontBlockExitKeymap,
] as unknown as MilkdownPlugin[]
