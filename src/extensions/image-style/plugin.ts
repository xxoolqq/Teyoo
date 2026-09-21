// 图片样式扩展 —— 插件装配
//
// 把覆盖后的 image schema 与输入规则组装成一个 MilkdownPlugin 数组。
// editor.ts 用 .use(imageStylePlugin) 注册，必须在 commonmark preset 之后，
// 才能覆盖 preset 内部的 image schema。

import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { imageStyleSchema } from './schema'
import { imageStyleInputRule } from './input-rule'

export const imageStylePlugin = [
  imageStyleSchema,
  imageStyleInputRule,
] as unknown as MilkdownPlugin[]
