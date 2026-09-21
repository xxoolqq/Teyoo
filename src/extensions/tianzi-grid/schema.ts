// 规约G：汉字田字格 —— milkdown ProseMirror 内联原子节点
//
// 节点名：tianzi_grid
// 形态：inline + atom，content: ''，attrs: { raw }
//   raw = ++ 之间的完整 inner（'你好' / '3'? 否——是 '(3)' / '()' / '(tian1qi4)'）
// 一个节点代表一整组格子（++你好++ = 一个节点渲染两个格），
// 这样序列化天然按组输出 ++raw++，不会把 ++你好++ 拆成 ++你++++好++。
//
// toDOM 结构（每格）：
//   <span class="tz-cell">
//     <span class="tz-py">带调拼音（可空，占位保对齐）</span>
//     <span class="tz-box"><span class="tz-char">汉字（可空）</span></span>
//   </span>
// 十字虚线由 .tz-box 的 ::before/::after 绘制，不依赖图片/字体。

import { $nodeSchema } from '@milkdown/kit/utils'
import { parseCells } from './lib'

export const tianziGridSchema = $nodeSchema('tianzi_grid', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  content: '',
  attrs: {
    raw: { default: '' },
  },
  parseDOM: [
    {
      // 从编辑器 HTML / 外部粘贴还原：读 data-raw；缺失则不识别
      tag: 'span.tianzi-grid[data-raw]',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { raw: '' }
        return { raw: dom.getAttribute('data-raw') ?? '' }
      },
    },
  ],
  toDOM: (node) => {
    const raw = String(node.attrs.raw ?? '')
    const model = parseCells(raw)
    // 数据异常（理论不会发生）时降级为字面文本，避免渲染崩溃
    if (!model) {
      return ['span', { class: 'tianzi-grid', 'data-raw': raw }, `++${raw}++`]
    }
    const children = model.cells.map((cell) => [
      'span',
      { class: 'tz-cell' },
      ['span', { class: 'tz-py' }, cell.pinyin ?? ' '],
      [
        'span',
        { class: 'tz-box' },
        ['span', { class: 'tz-char' }, cell.char ?? ''],
      ],
    ])
    return ['span', { class: 'tianzi-grid', 'data-raw': raw }, ...children] as [
      string,
      Record<string, string>,
      ...unknown[]
    ]
  },
  parseMarkdown: {
    match: (node) => (node as { type: string }).type === 'tianziGrid',
    runner: (state, node, type) => {
      state.addNode(type, {
        raw: (node as { raw?: string }).raw ?? '',
      })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'tianzi_grid',
    runner: (state, node) => {
      state.addNode('tianziGrid', undefined, undefined, {
        raw: node.attrs.raw,
      })
    },
  },
}))
