// 规约C：行内填空线 —— milkdown ProseMirror 内联原子节点
//
// 节点名：blank_line
// 形态：inline + atom + content:''（节点本身不承载用户文本，视觉占位由 toDOM 生成）
// attrs：
//   chars  - 填空宽度（em 单位，1 em = 1 个汉字宽）；正数（含小数）
//   blank  - true=纯空白（无下划线）；false=带下划线
//
// 视觉占位：toDOM 生成 Math.ceil(chars) 个全角空格（U+2003）作为占位字符，
//           用 CSS 的 border-bottom 控制是否带下划线。
//           之所以用全角空格而非不可见占位符，是为了让 docx 导出时也能
//           用同样的字符产生等宽占位，避免渲染/导出两套逻辑。
//
// 参考实现：node_modules/@milkdown/preset-commonmark/src/node/hardbreak.ts
//           （同样是 inline + atom 的内联节点）

import { $nodeSchema } from '@milkdown/kit/utils'

// 全角空格 U+2003，宽度等于一个汉字
const FULL_WIDTH_SPACE = '\u2003'

export const blankLineSchema = $nodeSchema('blank_line', () => ({
  group: 'inline',
  inline: true,
  // 原子节点：用户不能把光标放入节点内部编辑其内容，
  // 整体作为一个单位被选中/删除。
  atom: true,
  content: '',
  attrs: {
    chars: { default: 1 },
    blank: { default: false },
  },
  parseDOM: [
    {
      // 匹配 .blank-line / .blank-space 两种 span，从 class 与 data-chars
      // 还原 attrs（用于从 HTML 粘贴 / 从外部 DOM 导入）
      tag: 'span.blank-line, span.blank-space',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { chars: 1, blank: false }
        return {
          chars: Number(dom.getAttribute('data-chars') ?? '1'),
          blank: dom.classList.contains('blank-space'),
        }
      },
    },
  ],
  toDOM: (node) => {
    const chars = Math.max(1, Math.ceil(Number(node.attrs.chars)))
    const cls = node.attrs.blank ? 'blank-space' : 'blank-line'
    const filler = FULL_WIDTH_SPACE.repeat(chars)
    return [
      'span',
      { class: cls, 'data-chars': String(node.attrs.chars) },
      filler,
    ]
  },
  parseMarkdown: {
    // mdast 端：node.type === 'blankLine'（来自 remark.ts 拆分）
    match: (node) => (node as { type: string }).type === 'blankLine',
    runner: (state, node, type) => {
      state.addNode(type, {
        chars: (node as { chars?: number }).chars ?? 1,
        blank: (node as { blank?: boolean }).blank ?? false,
      })
    },
  },
  toMarkdown: {
    // prose 端：node.type.name === 'blank_line'
    match: (node) => node.type.name === 'blank_line',
    runner: (state, node) => {
      // SerializerState.addNode(type, children, value, props)
      // 我们的 atom 节点没有 children/value，chars 与 blank 通过 props
      // 传递；emit 时 props 被展开到 mdast 节点上，stringify.ts 可直接
      // 读 node.chars / node.blank。
      state.addNode('blankLine', undefined, undefined, {
        chars: node.attrs.chars,
        blank: node.attrs.blank,
      })
    },
  },
}))
