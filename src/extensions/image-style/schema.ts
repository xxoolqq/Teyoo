// 图片样式扩展 —— 覆盖 commonmark 内置 image schema
//
// commonmark preset 已注册 image 节点（attrs: src/alt/title）。
// 本文件用同名 $nodeSchema('image', ...) 在 preset 之后注册，覆盖其
// parseMarkdown / toDOM / toMarkdown，让 image 节点支持 cherry 风格的
// #宽#高#对齐#样式 参数，同时保留 src/alt/title 的标准行为。
//
// 覆盖安全性：
//   - commonmark 的 insertImageInputRule / insertImageCommand 通过
//     imageSchema.type(ctx) 取类型，ctx 里的 'image' 已被本 schema 覆盖，
//     因此它们会自动用新类型，无需重写。
//   - parseDOM 保持基础还原（src/alt/title），粘贴外部 HTML 时不丢图；
//     自定义参数暂不从 DOM 反推（外部 HTML 不会带我们的 class）。

import { $nodeSchema } from '@milkdown/kit/utils'
import { parseImageAlt, stringifyImageAlt, type ImageAlign, toFileUrl, fromFileUrl } from './lib'

export const imageStyleSchema = $nodeSchema('image', () => ({
  inline: true,
  group: 'inline',
  selectable: true,
  draggable: true,
  marks: '',
  atom: true,
  defining: true,
  isolating: true,
  attrs: {
    src: { default: '', validate: 'string' },
    alt: { default: '', validate: 'string' },
    title: { default: '', validate: 'string' },
    width: { default: '' },
    height: { default: '' },
    align: { default: '' },
    border: { default: false },
    shadow: { default: false },
    radius: { default: false },
  },
  parseDOM: [
    {
      // 浮动对齐：<span class="img-float-left|right"><img ...></span>
      // 用 wrapper span 作为 atom 节点，避免裸 img float 后 PM 无法在其左侧定位光标
      tag: 'span.img-float-left > img, span.img-float-right > img',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return null
        const span = dom.parentElement
        if (!span) return null
        const cls = dom.getAttribute('class') || ''
        const style = dom.getAttribute('style') || ''
        const widthMatch = style.match(/width\s*:\s*(auto|[\d.]+px|[\d.]+%)/)
        const heightMatch = style.match(/height\s*:\s*(auto|[\d.]+px|[\d.]+%)/)
        const spanCls = span.getAttribute('class') || ''
        const align = spanCls.includes('img-float-left') ? 'float-left' : 'float-right'
        return {
          // src 存本地路径，file:// 还原
          src: fromFileUrl(dom.getAttribute('src') || ''),
          alt: dom.getAttribute('alt') || '',
          title: dom.getAttribute('title') || '',
          width: widthMatch ? widthMatch[1] : '',
          height: heightMatch ? heightMatch[1] : '',
          align,
          border: cls.includes('img-border'),
          shadow: cls.includes('img-shadow'),
          radius: cls.includes('img-radius'),
        }
      },
    },
    {
      // 普通对齐与无对齐：裸 <img>
      tag: 'img[src]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return null
        // 已被上面的 span 规则匹配的跳过
        if (dom.parentElement?.classList.contains('img-float-left') ||
            dom.parentElement?.classList.contains('img-float-right')) return null
        const cls = dom.getAttribute('class') || ''
        const style = dom.getAttribute('style') || ''
        const widthMatch = style.match(/width\s*:\s*(auto|[\d.]+px|[\d.]+%)/)
        const heightMatch = style.match(/height\s*:\s*(auto|[\d.]+px|[\d.]+%)/)
        const alignMatch = cls.match(/img-align-(left|center|right)/)
        return {
          src: fromFileUrl(dom.getAttribute('src') || ''),
          alt: dom.getAttribute('alt') || '',
          title: dom.getAttribute('title') || '',
          width: widthMatch ? widthMatch[1] : '',
          height: heightMatch ? heightMatch[1] : '',
          align: alignMatch ? alignMatch[1] : '',
          border: cls.includes('img-border'),
          shadow: cls.includes('img-shadow'),
          radius: cls.includes('img-radius'),
        }
      },
    },
  ],
  toDOM: (node) => {
    const attrs: Record<string, string> = {
      // src attr 存本地路径，渲染时转 file:// 供浏览器加载
      src: toFileUrl(node.attrs.src),
      alt: node.attrs.alt || '',
    }
    if (node.attrs.title) attrs.title = node.attrs.title

    const style: string[] = []
    if (node.attrs.width) style.push(`width:${node.attrs.width}`)
    if (node.attrs.height) style.push(`height:${node.attrs.height}`)
    if (style.length) attrs.style = style.join(';')

    const classes: string[] = []
    const align = node.attrs.align as ImageAlign | undefined
    if (align && align !== 'float-left' && align !== 'float-right') {
      classes.push(`img-align-${align}`)
    }
    if (node.attrs.border) classes.push('img-border')
    if (node.attrs.shadow) classes.push('img-shadow')
    if (node.attrs.radius) classes.push('img-radius')
    if (classes.length) attrs.class = classes.join(' ')

    // 浮动对齐用 wrapper span，让 PM 把 span 当作 atom 节点，
    // 光标可在 span 前（左侧）正常定位
    if (align === 'float-left' || align === 'float-right') {
      const wrapperClass = align === 'float-left' ? 'img-float-left' : 'img-float-right'
      return ['span', { class: wrapperClass }, ['img', attrs]]
    }
    return ['img', attrs]
  },
  parseMarkdown: {
    match: ({ type }) => type === 'image',
    runner: (state, node, type) => {
      const { alt, params } = parseImageAlt((node as { alt?: string }).alt ?? '')
      // src attr 存本地路径：file:// 还原为相对/绝对路径，其余原样保留
      // （打开文件时 main 已转 file://，这里还原；粘贴的本地路径保持原样）
      const url = (node as { url?: string }).url ?? ''
      state.addNode(type, {
        src: fromFileUrl(url),
        alt,
        title: (node as { title?: string }).title ?? '',
        width: params.width ?? '',
        height: params.height ?? '',
        align: params.align ?? '',
        border: params.border,
        shadow: params.shadow,
        radius: params.radius,
      })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'image',
    runner: (state, node) => {
      const alt = stringifyImageAlt(node.attrs.alt, {
        width: node.attrs.width,
        height: node.attrs.height,
        align: node.attrs.align,
        border: node.attrs.border,
        shadow: node.attrs.shadow,
        radius: node.attrs.radius,
      })
      // src 已是本地路径，直接输出
      state.addNode('image', undefined, undefined, {
        title: node.attrs.title,
        url: node.attrs.src,
        alt,
      })
    },
  },
}))
