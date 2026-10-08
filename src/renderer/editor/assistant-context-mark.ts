// 文档助手：把"这一轮会带上的选区"一直亮着。
//
// 为什么不能靠原生选区高亮：点进助手的输入框后焦点进了 textarea，浏览器会把
// 文档里的 DOM 选区清掉；prosemirror-view 同时给可编辑区加上
// `ProseMirror-hideselection`（它自带的样式把 ::selection 抹成透明）。于是
// 「选中一段 → 点输入框写指令」时用户看不见自己选的是哪一段了 —— 虽然内容照旧
// 会随请求带过去（选区在 ProseMirror 的 state 里，没有丢）。
//
// 做法与 block-link / 建议预览同源：一个只读的 Decoration。**开与关由
// assistant.ts 按焦点决定**（侧边栏拿到焦点就亮、焦点回到编辑器就撤），这里只画。

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

export interface ContextRange {
  from: number
  to: number
}

export const assistantContextMarkKey = new PluginKey<ContextRange | null>('teyoo-assistant-context-mark')

/** 裸插件（不依赖 milkdown ctx）：便于用最小 schema + 真 EditorView 单独测 */
export function createAssistantContextMarkPluginRaw(): Plugin<ContextRange | null> {
  return new Plugin<ContextRange | null>({
    key: assistantContextMarkKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(assistantContextMarkKey)
        if (meta === 'clear') return null
        if (meta && typeof meta === 'object') {
          const range = meta as ContextRange
          const from = tr.mapping.map(range.from, 1)
          const to = tr.mapping.map(range.to, -1)
          return from < to ? { from, to } : null
        }
        if (!value) return null
        // 文档变了跟着映射；区间被删空/失效就撤（与建议预览同一套规矩）
        const from = tr.mapping.map(value.from, 1)
        const to = tr.mapping.map(value.to, -1)
        return from < to && to <= tr.doc.content.size ? { from, to } : null
      }
    },
    props: {
      decorations(state) {
        const range = assistantContextMarkKey.getState(state)
        if (!range) return null
        return DecorationSet.create(state.doc, [
          Decoration.inline(range.from, range.to, { class: 'assistant-context-mark' })
        ])
      }
    }
  })
}

/** 编辑器里用的形态：包成 milkdown 插件 */
export const createAssistantContextMarkPlugin = () => $prose(() => createAssistantContextMarkPluginRaw())

/** 亮上 / 撤掉（range 传 null 即撤） */
export function setContextMark(view: EditorView, range: ContextRange | null): void {
  view.dispatch(view.state.tr.setMeta(assistantContextMarkKey, range ?? 'clear'))
}
