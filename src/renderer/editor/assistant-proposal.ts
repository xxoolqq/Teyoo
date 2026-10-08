// 文档助手：正文内的建议预览（P3）。
//
// 侧边栏那张卡片解决的是"看清楚改了什么"，这里解决的是"在文档里看清楚"：
//   · 将被替换的原文 → Decoration.inline 打上 .assistant-inline-remove（划掉 + 淡底）
//   · 模型给出的建议 → Decoration.widget 就地插在区间末尾（.assistant-inline-add + 接受）
//
// 区间跟着编辑走（mapping）：先把请求发出去、之后在别处改字，高亮仍然贴着原来那一段；
// 那段被删掉/并空时装饰自动消失。
//
// 这里只管"画"和"就地接受一次替换"。解析 Markdown 用调用方注入的 parse（编辑器那套
// remark 管线），所以与侧边栏的「应用」是同一份解析、同样是单步可撤销的一个事务。
// 拒绝 / 丢弃由上层清掉（见 editor.ts 的 clearAssistantProposal）。

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { contentForRange } from './apply-markdown'
import { isChinese } from '../ui-language'

export interface AssistantProposalPayload {
  /** 将被替换的区间（当前文档坐标） */
  from: number
  to: number
  /** 模型给出的建议 Markdown */
  markdown: string
  /** 在正文里接受之后（上层用它标记卡片、标脏、刷大纲） */
  onAccepted?: () => void
  /** 在正文里丢弃之后（上层用它把卡片标成已丢弃） */
  onRejected?: () => void
}

export const assistantProposalKey = new PluginKey<AssistantProposalPayload | null>('teyoo-assistant-proposal')

/** 同一份建议只造一次 widget DOM：decorations() 每次状态变化都会跑，不能每次 new。 */
let widgetCache: { markdown: string; node: HTMLElement } | null = null

function buildWidget(payload: AssistantProposalPayload, accept: () => void, reject: () => void): HTMLElement {
  if (widgetCache && widgetCache.markdown === payload.markdown) return widgetCache.node
  const wrap = document.createElement('span')
  wrap.className = 'assistant-inline-add'
  const text = document.createElement('span')
  text.className = 'assistant-inline-add-text'
  // 空建议（“清空这段”）也要看得见，否则正文里只剩一块被划掉的原文，看不出要干什么
  text.textContent = payload.markdown.trim() ? payload.markdown : isChinese() ? '清空这段' : 'clear this'
  if (!payload.markdown.trim()) text.classList.add('is-empty')
  // 两枚按钮：接受 / 丢弃（与侧边栏卡片一致）
  const makeButton = (className: string, label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = className
    node.textContent = label
    node.title = title
    // 按下就拦住：不然编辑器会把这一下当成"点进正文"，选区一跑，替换位置就不是原处了。
    node.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    node.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onClick()
    })
    return node
  }
  wrap.append(
    text,
    makeButton('assistant-inline-accept', isChinese() ? '接受' : 'Accept', isChinese() ? '用这段替换左边的原文（可 Ctrl+Z 撤销）' : 'Replace the text on the left (undoable)', accept),
    makeButton('assistant-inline-cancel', isChinese() ? '丢弃' : 'Discard', isChinese() ? '丢掉这处建议，正文不动' : 'Discard this suggestion without touching the document', reject)
  )
  widgetCache = { markdown: payload.markdown, node: wrap }
  return wrap
}

/**
 * 裸 ProseMirror 插件（不依赖 milkdown 的 ctx）。
 * 单独导出是为了能拿一个最小 schema + 真 EditorView 直接测它，不必起编辑器全栈。
 *
 * @param parse Markdown → 顶层节点（编辑器注入 parseMarkdownToNodes，走完整 remark 管线）
 */
export function createAssistantProposalPluginRaw(
  parse: (markdown: string) => ProseMirrorNode[]
): Plugin<AssistantProposalPayload | null> {
  let view: EditorView | null = null
  return new Plugin<AssistantProposalPayload | null>({
      key: assistantProposalKey,
      view: (editorView) => {
        view = editorView
        return {
          destroy: () => {
            view = null
          }
        }
      },
      state: {
        init: () => null,
        apply(tr, value) {
          const meta = tr.getMeta(assistantProposalKey)
          // 'clear' = 明确清掉；'consumed' = 这一次替换就是这处建议，装饰随之消失
          if (meta === 'clear' || meta === 'consumed' || meta === null) return null
          if (meta && typeof meta === 'object') {
            const payload = meta as AssistantProposalPayload
            const from = tr.mapping.map(payload.from, 1)
            const to = tr.mapping.map(payload.to, -1)
            return from < to ? { ...payload, from, to } : null
          }
          if (!value) return null
          const from = tr.mapping.map(value.from, 1)
          const to = tr.mapping.map(value.to, -1)
          // 原区间被删/被并空 → 这处建议已经没有落点了
          return from < to && to <= tr.doc.content.size ? { ...value, from, to } : null
        }
      },
      props: {
        decorations(state) {
          const payload = assistantProposalKey.getState(state)
          if (!payload) return null
          const accept = (): void => {
            const editorView = view
            if (!editorView) return
            const current = assistantProposalKey.getState(editorView.state)
            if (!current) return
            // 空建议 = "把这段清空"（用户让删掉，模型就该回空）
            if (!current.markdown.trim()) {
              editorView.dispatch(
                editorView.state.tr
                  .delete(current.from, current.to)
                  .setMeta(assistantProposalKey, 'consumed')
              )
              current.onAccepted?.()
              return
            }
            // 行内 / 块级落法交给 contentForRange 判（与侧边栏「替换选中内容」同一处
            // 判定）：选中一行里的几个字时只塞行内内容，否则 ProseMirror 会把段落劈开。
            const content = contentForRange(
              editorView,
              { from: current.from, to: current.to },
              parse(current.markdown)
            )
            if (!content.nodes.length) return
            editorView.dispatch(
              editorView.state.tr
                .replaceWith(content.from, content.to, content.nodes)
                // 同一个事务里说明白"这次替换吃掉了这处建议"：分成两次 dispatch 的话，
                // 中间那一帧会把刚写进去的新内容又标成"待替换"（闪一下）。
                .setMeta(assistantProposalKey, 'consumed')
            )
            current.onAccepted?.()
          }
          const reject = (): void => {
            const editorView = view
            if (!editorView) return
            const current = assistantProposalKey.getState(editorView.state)
            if (!current) return
            // 只撤掉正文里的标记，正文一字不动；侧边栏那张卡片由上层标成已丢弃
            editorView.dispatch(editorView.state.tr.setMeta(assistantProposalKey, 'clear'))
            current.onRejected?.()
          }
          return DecorationSet.create(state.doc, [
            Decoration.inline(payload.from, payload.to, { class: 'assistant-inline-remove' }),
            Decoration.widget(payload.to, buildWidget(payload, accept, reject), {
              side: 1,
              key: `assistant-proposal-${payload.from}-${payload.markdown.length}`
            })
          ])
        }
      }
    })
}

/** 编辑器里用的形态：包成 milkdown 插件 */
export const createAssistantProposalPlugin = (parse: (markdown: string) => ProseMirrorNode[]) =>
  $prose(() => createAssistantProposalPluginRaw(parse))

/** 挂上 / 清掉一处建议（payload 传 null 即清） */
export function setProposal(view: EditorView, payload: AssistantProposalPayload | null): void {
  if (payload && !(payload.from < payload.to)) return
  view.dispatch(view.state.tr.setMeta(assistantProposalKey, payload ?? 'clear'))
}
