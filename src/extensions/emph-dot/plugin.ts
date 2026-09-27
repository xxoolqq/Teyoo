// 规约A：字下着重号（点）—— milkdown 插件装配
//
// 把 markAttr、markSchema 组装成一个 MilkdownPlugin 数组，
// editor.ts 用 .use(emphDotPlugin) 一次性注册。
//
// 无输入规则：格式操作不允许手动输入触发（用户规约），着重号只能通过
// 工具栏 / 快捷键或源码模式的 @.内容.@ 语法（解析路径）获得。
// markRule 亦不检查 escaped_literal，会吞掉用户转义的定界符（见
// renderer/editor/format-input-rules-off.ts）。

import type { MilkdownPlugin } from '@milkdown/kit/ctx'

import { emphDotAttr, emphDotSchema } from './schema'

export const emphDotPlugin = [
  emphDotAttr,
  emphDotSchema,
] as unknown as MilkdownPlugin[]
