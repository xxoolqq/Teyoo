// 规约F：子块与分栏 —— milkdown ProseMirror 块级节点
//
// 两个节点（协议固定）：
//
// 1) sub_block（子块）
//    - group: block；content: block*（完整块级内容：段落/图片/列表/表格…）
//    - attrs: { boxed: boolean 是否带边框, align: 'left'|'center'|'right' }
//    - 独立存在时宽度撑满可用区；位于 cols 内时宽度由 grid 轨道决定。
//    - 嵌套约束靠解析端保证：lexer 禁止分栏嵌套、子块内不识别子块标记；
//      content 表达式不做精细排除（编辑器内也没有插入嵌套的 UI 入口）。
//
// 2) cols（分栏）
//    - group: block；content: sub_block+（只装子块）
//    - attrs: { spec: 'N' 等宽 N 列 | 'A:B' 两列比例 }
//    - 默认宽 54em（CSS），CSS Grid 布局，列高由最高列决定，顶部对齐。

import { $nodeSchema } from '@milkdown/kit/utils'

// '2'      → repeat(2, minmax(0, 1fr))
// '1:2'    → 1fr 2fr
export function gridTemplate(spec: string): string {
  if (spec.includes(':')) {
    const [a, b] = spec.split(':')
    return `${a}fr ${b}fr`
  }
  return `repeat(${spec}, minmax(0, 1fr))`
}

// 合法 spec：纯数字（≥1）或 数字:数字
export function isValidSpec(spec: string): boolean {
  return /^\d+$/.test(spec)
    ? Number(spec) >= 1
    : /^\d+:\d+$/.test(spec)
}

// spec → 应包含的子块列数（用于交互创建时分栏初始子块数）
export function columnCount(spec: string): number {
  if (spec.includes(':')) return 2
  return Math.max(1, Number(spec))
}

// ─── 子块 ───────────────────────────────────────────────────────────────────

export const subBlockSchema = $nodeSchema('sub_block', () => ({
  group: 'block',
  content: 'block*',
  defining: true,
  attrs: {
    boxed: { default: true },
    align: { default: 'left' },
  },
  parseDOM: [
    {
      tag: 'div.sub-block',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { boxed: true, align: 'left' }
        return {
          boxed: dom.classList.contains('boxed'),
          align: dom.getAttribute('data-align') ?? 'left',
        }
      },
    },
  ],
  toDOM: (node) => [
    'div',
    {
      class: `sub-block${node.attrs.boxed ? ' boxed' : ''}`,
      'data-align': node.attrs.align,
    },
    0,
  ],
  parseMarkdown: {
    match: (n) => (n as { type: string }).type === 'subBlock',
    runner: (state, node, type) => {
      state.openNode(type, {
        boxed: (node as { boxed?: boolean }).boxed ?? false,
        align: (node as { align?: string }).align ?? 'left',
      })
      // 空子块（@box\n@）注入一个空段落，保证光标可进入编辑
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
    match: (node) => node.type.name === 'sub_block',
    runner: (state, node) => {
      state.openNode('subBlock', undefined, {
        boxed: node.attrs.boxed,
        align: node.attrs.align,
      })
      state.next(node.content)
      state.closeNode()
    },
  },
}))

// ─── 分栏 ───────────────────────────────────────────────────────────────────

export const colsSchema = $nodeSchema('cols', () => ({
  group: 'block',
  content: 'sub_block+',
  defining: true,
  attrs: {
    spec: { default: '2' },
  },
  parseDOM: [
    {
      tag: 'div.cols',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { spec: '2' }
        return { spec: dom.getAttribute('data-spec') ?? '2' }
      },
    },
  ],
  toDOM: (node) => [
    'div',
    {
      class: 'cols',
      'data-spec': node.attrs.spec,
      style: `grid-template-columns:${gridTemplate(String(node.attrs.spec))}`,
    },
    0,
  ],
  parseMarkdown: {
    match: (n) => (n as { type: string }).type === 'cols',
    runner: (state, node, type) => {
      state.openNode(type, {
        spec: (node as { spec?: string }).spec ?? '2',
      })
      state.next(((node as { children?: any[] }).children ?? []) as any[])
      state.closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'cols',
    runner: (state, node) => {
      state.openNode('cols', undefined, { spec: node.attrs.spec })
      state.next(node.content)
      state.closeNode()
    },
  },
}))
