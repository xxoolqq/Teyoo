// 通用上下标（化学式）—— milkdown 插件装配
//
// 把两个 markSchema 组装成 MilkdownPlugin 数组，editor.ts 用
// .use(subSupPlugin) 一次性注册（emph-dot plugin.ts 同模式）。
//
// 无输入规则：格式操作不允许手动输入触发（用户规约），上下标只能通过
// 工具栏 / 快捷键或源码模式的 _{x} / ^{x} 语法（解析路径）获得。
// markRule 亦不检查 escaped_literal，会吞掉用户转义的定界符（见
// renderer/editor/format-input-rules-off.ts）。

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { subscriptSchema, superscriptSchema } from './schema'

export const subSupPlugin = [
  subscriptSchema,
  superscriptSchema,
] as unknown as MilkdownPlugin[]
