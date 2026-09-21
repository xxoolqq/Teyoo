// 规约B2：同行平级拼音 —— milkdown ProseMirror 内联原子节点
//
// 节点名：pinyin_inline
// 形态：inline + atom，content: ''，attrs: { text, pinyin }
// 用户不能把光标放入节点内部编辑汉字，整体作为一个单位被选中/删除。
//
// 视觉占位：toDOM 生成
//   <span class="pinyin-inline" data-pinyin data-text>
//     <span class="pinyin-inline-text">汉字</span>
//     <span class="pinyin-inline-annot">带调拼音</span>
//   </span>
// 拼音在汉字右侧同一行（由 CSS 控制间距与字号），与规约B（ruby 上方）不同。
//
// 复用 pinyin-ruby 的 convertPinyin（数字声调 → 带调 Unicode）。

import { $nodeSchema } from '@milkdown/kit/utils'
import { convertPinyin } from '../pinyin-ruby/pinyin'

export const pinyinInlineSchema = $nodeSchema('pinyin_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  content: '',
  attrs: {
    text: { default: '' },
    pinyin: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span.pinyin-inline[data-pinyin]',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { text: '', pinyin: '' }
        const textSpan = dom.querySelector('.pinyin-inline-text')
        return {
          text: textSpan?.textContent ?? dom.getAttribute('data-text') ?? '',
          pinyin: dom.getAttribute('data-pinyin') ?? '',
        }
      },
    },
  ],
  toDOM: (node) => [
    'span',
    { class: 'pinyin-inline', 'data-pinyin': node.attrs.pinyin, 'data-text': node.attrs.text },
    ['span', { class: 'pinyin-inline-text' }, node.attrs.text],
    ['span', { class: 'pinyin-inline-annot' }, convertPinyin(node.attrs.pinyin)],
  ],
  parseMarkdown: {
    match: (node) => (node as { type: string }).type === 'pinyinInline',
    runner: (state, node, type) => {
      state.addNode(type, {
        text: (node as { text?: string }).text ?? '',
        pinyin: (node as { pinyin?: string }).pinyin ?? '',
      })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'pinyin_inline',
    runner: (state, node) => {
      state.addNode('pinyinInline', undefined, undefined, {
        text: node.attrs.text,
        pinyin: node.attrs.pinyin,
      })
    },
  },
}))
