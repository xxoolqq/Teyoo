// 规约B：ruby 上方汉字拼音 —— milkdown ProseMirror 内联原子节点
//
// 节点名：pinyin_ruby
// 形态：inline + atom，content: ''，attrs: { text, pinyin }
// 用户不能把光标放入节点内部编辑汉字，整体作为一个单位被选中/删除。
//
// 为什么用 atom 而非 content:'text*'：
//   非 atom 节点 + content 时，input rule 把光标设到 `start + nodeSize`
//   （ruby 的 close tag 之后），但 ProseMirror 在该边界处的文本输入会
//   落入 ruby 的 content（append 到汉字末尾），导致后续输入的汉字跑到
//   ruby 内部、拼音渲染到错误的字上。改成 atom 后 nodeSize=1，光标
//   在 `start + 1`，是 ruby 之外的明确位置，后续输入必然进入段落
//   的兄弟文本节点。
//
// 视觉占位：toDOM 生成 <ruby data-pinyin="..."><span class="ruby-base">汉字</span><rt>带调拼音</rt></ruby>，
//           浏览器原生 ruby 渲染把 rt 放在汉字上方。
//           data-pinyin / data-text 保留原始串供序列化与 DOM 解析回写。
//
// 参考实现：node_modules/@milkdown/preset-commonmark 的 hardbreak / image
//           （同样是 inline + atom 的内联节点）

import { $nodeSchema } from '@milkdown/kit/utils'
import { convertPinyin } from './pinyin'

export const pinyinRubySchema = $nodeSchema('pinyin_ruby', () => ({
  group: 'inline',
  inline: true,
  // 原子节点：用户不能把光标放入节点内部编辑其内容
  atom: true,
  content: '',
  attrs: {
    text: { default: '' },
    pinyin: { default: '' },
  },
  parseDOM: [
    {
      // 匹配带 data-pinyin 的 ruby 元素（从 HTML 粘贴 / 外部 DOM 导入）
      tag: 'ruby[data-pinyin]',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { text: '', pinyin: '' }
        // 从 .ruby-base 取汉字；若结构不含 span 则用 ruby 直接文本（剔除 rt 后）
        const baseSpan = dom.querySelector('.ruby-base')
        let text: string
        if (baseSpan) {
          text = baseSpan.textContent ?? ''
        } else {
          const clone = dom.cloneNode(true) as HTMLElement
          clone.querySelectorAll('rt').forEach((rt) => rt.remove())
          text = clone.textContent ?? ''
        }
        return {
          text,
          pinyin: dom.getAttribute('data-pinyin') ?? '',
        }
      },
    },
  ],
  toDOM: (node) => [
    'ruby',
    { 'data-pinyin': node.attrs.pinyin, 'data-text': node.attrs.text },
    ['span', { class: 'ruby-base' }, node.attrs.text],
    ['rt', {}, convertPinyin(node.attrs.pinyin)],
  ],
  parseMarkdown: {
    // mdast 端：node.type === 'pinyinRuby'（来自 remark.ts 拆分）
    match: (node) => (node as { type: string }).type === 'pinyinRuby',
    runner: (state, node, type) => {
      state.addNode(type, {
        text: (node as { text?: string }).text ?? '',
        pinyin: (node as { pinyin?: string }).pinyin ?? '',
      })
    },
  },
  toMarkdown: {
    // prose 端：node.type.name === 'pinyin_ruby'
    match: (node) => node.type.name === 'pinyin_ruby',
    runner: (state, node) => {
      // SerializerState.addNode(type, children, value, props)
      // atom 节点无 children/value；text 与 pinyin 通过 props 传递到 mdast 节点
      state.addNode('pinyinRuby', undefined, undefined, {
        text: node.attrs.text,
        pinyin: node.attrs.pinyin,
      })
    },
  },
}))
