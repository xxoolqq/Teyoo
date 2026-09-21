// 规约H：字体大小规约 —— milkdown ProseMirror 节点与 mark 定义
//
// 1) font_block（块级容器节点）
//    - group: block；content: block*（完整块级内容：段落/列表/引用/图片/嵌套块容器）
//    - attrs: { family?, size?, align? }
//    - 渲染：<div class="font-block" style="font-family:SimSun;font-size:14pt;text-align:justify">
//    - 可跨多段、可嵌套列表/引用/代码块/其他块容器
//
// 2) font_span（行内 mark）
//    - 与 strong/em 同级，包裹行内文字
//    - attrs: { family?, size?, align? }
//    - 渲染：<span class="font-span" style="font-family:KaiTi;font-size:12pt">
//    - align 仅标记透传，不在行内 style 中输出（由外层块生效）
//
// 参考：columns/schema.ts（node）、emph-dot/schema.ts（mark）

import { $nodeSchema, $markAttr, $markSchema } from '@milkdown/kit/utils'
import { type FontAttrs, buildBlockStyle, buildInlineStyle, parseStyleFromDOM } from './lib'

// ─── 块级容器节点 ───────────────────────────────────────────────────────────

export const fontBlockSchema = $nodeSchema('font_block', () => ({
  group: 'block',
  content: 'block*',
  defining: true,
  attrs: {
    family: { default: '' },
    size: { default: '' },
    align: { default: '' },
  },
  parseDOM: [
    {
      tag: 'div.font-block',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { family: '', size: '', align: '' }
        const style = dom.getAttribute('style') ?? ''
        const attrs = parseStyleFromDOM(style)
        return {
          family: attrs.family ?? '',
          size: attrs.size ?? '',
          align: attrs.align ?? '',
        }
      },
    },
  ],
  toDOM: (node) => {
    const attrs: FontAttrs = {}
    if (node.attrs.family) attrs.family = node.attrs.family
    if (node.attrs.size) attrs.size = node.attrs.size
    if (node.attrs.align) attrs.align = node.attrs.align as FontAttrs['align']
    const style = buildBlockStyle(attrs)
    return ['div', { class: 'font-block', style }, 0]
  },
  parseMarkdown: {
    match: (n) => (n as { type: string }).type === 'fontBlock',
    runner: (state, node, type) => {
      const mdNode = node as { family?: string; size?: string; align?: string }
      state.openNode(type, {
        family: mdNode.family ?? '',
        size: mdNode.size ?? '',
        align: mdNode.align ?? '',
      })
      const children =
        (node as { children?: any[] }).children &&
        (node as { children: any[] }).children.length > 0
          ? (node as { children: any[] }).children
          : [{ type: 'paragraph', children: [] }]
      state.next(children)
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'font_block',
    runner: (state, node) => {
      const props: Record<string, string> = {}
      if (node.attrs.family) props.family = node.attrs.family
      if (node.attrs.size) props.size = node.attrs.size
      if (node.attrs.align) props.align = node.attrs.align
      state.openNode('fontBlock', undefined, props)
      state.next(node.content)
      state.closeNode()
    },
  },
}))

// ─── 行内 mark ──────────────────────────────────────────────────────────────

export const fontSpanAttr = $markAttr('fontSpan')

export const fontSpanSchema = $markSchema('font_span', (ctx) => ({
  attrs: {
    family: { default: '' },
    size: { default: '' },
    align: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span.font-span',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { family: '', size: '', align: '' }
        const style = dom.getAttribute('style') ?? ''
        const attrs = parseStyleFromDOM(style)
        return {
          family: attrs.family ?? '',
          size: attrs.size ?? '',
          align: attrs.align ?? '',
        }
      },
    },
  ],
  toDOM: (mark) => {
    const attrs: FontAttrs = {}
    if (mark.attrs.family) attrs.family = mark.attrs.family
    if (mark.attrs.size) attrs.size = mark.attrs.size
    // align 不在行内 style 输出（仅标记透传，由外层块生效）
    const style = buildInlineStyle(attrs)
    return ['span', { class: 'font-span', style, ...ctx.get(fontSpanAttr.key)(mark) }, 0]
  },
  parseMarkdown: {
    match: (node) => (node as { type: string }).type === 'fontSpan',
    runner: (state, node, markType) => {
      const mdNode = node as { family?: string; size?: string; align?: string }
      state.openMark(markType, {
        family: mdNode.family ?? '',
        size: mdNode.size ?? '',
        align: mdNode.align ?? '',
      })
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'font_span',
    runner: (state, mark) => {
      const props: Record<string, string> = {}
      if (mark.attrs.family) props.family = mark.attrs.family
      if (mark.attrs.size) props.size = mark.attrs.size
      if (mark.attrs.align) props.align = mark.attrs.align
      state.withMark(mark, 'fontSpan', undefined, props)
    },
  },
}))
