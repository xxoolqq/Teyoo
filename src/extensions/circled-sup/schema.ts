// 规约E：汉字右上角带圈序号 —— milkdown ProseMirror 内联原子节点
//
// 节点名：circled_sup
// attrs: { char（单个汉字）, num（数字串） }
// toDOM:
//   <span class="circled-sup" data-char data-num>
//     <span class="circled-sup-char">汉字</span>
//     <sup class="circled-num">数字</sup>
//   </span>
// CSS 用 border + border-radius 画圆圈，vertical-align:super 做上标。

import { $nodeSchema } from '@milkdown/kit/utils'

export const circledSupSchema = $nodeSchema('circled_sup', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  content: '',
  attrs: {
    char: { default: '' },
    num: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span.circled-sup[data-num]',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { char: '', num: '' }
        const charSpan = dom.querySelector('.circled-sup-char')
        return {
          char: charSpan?.textContent ?? dom.getAttribute('data-char') ?? '',
          num: dom.getAttribute('data-num') ?? '',
        }
      },
    },
  ],
  toDOM: (node) => [
    'span',
    { class: 'circled-sup', 'data-char': node.attrs.char, 'data-num': node.attrs.num },
    ['span', { class: 'circled-sup-char' }, node.attrs.char],
    ['sup', { class: 'circled-num' }, node.attrs.num],
  ],
  parseMarkdown: {
    match: (node) => (node as { type: string }).type === 'circledSup',
    runner: (state, node, type) => {
      state.addNode(type, {
        char: (node as { char?: string }).char ?? '',
        num: (node as { num?: string }).num ?? '',
      })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'circled_sup',
    runner: (state, node) => {
      state.addNode('circledSup', undefined, undefined, {
        char: node.attrs.char,
        num: node.attrs.num,
      })
    },
  },
}))
