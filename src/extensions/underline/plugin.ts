// 文字下划线 —— milkdown 插件装配
//
// 把 markAttr、markSchema 组装成 MilkdownPlugin 数组，
// editor.ts 用 .use(underlinePlugin) 一次性注册。
//
// 刻意不含输入规则：格式操作走工具栏 / Ctrl+U / 源码模式，
// wysiwyg 下敲 <u> 保持字面文本（「格式不手动输入」原则）。

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { underlineAttr, underlineSchema } from './schema'

export const underlinePlugin = [
  underlineAttr,
  underlineSchema,
] as unknown as MilkdownPlugin[]
