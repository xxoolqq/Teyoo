// 通用上下标（化学式）—— milkdown ProseMirror marks
//
// 两个 mark：
//   subscript   → 渲染为 <sub>（下标，如 H₂O 的 2）
//   superscript → 渲染为 <sup>（上标，如 SO₄²⁻ 的 2-）
//
// mdast 协议（见 remark.ts）：
//   { type: 'subscript',   children: [text] }
//   { type: 'superscript', children: [text] }
//
// 参考实现：src/extensions/emph-dot/schema.ts
//   parseMarkdown：openMark → next(children) → closeMark
//   toMarkdown：withMark(mark, 'subscript'|'superscript')，序列化时
//   打开 mark 上下文，交给 stringify.ts 的 handler 原样输出语法。
//
// 序列化优先级用默认 50（与 strong/em/highlight 同级）：上下标内容几乎
// 总是纯文本/数字，与加粗嵌套的场景（**x^{2}**）极少，且无论谁外包谁，
// 两个方向都走各自的 handler 原样输出，往返无损。

import { $markSchema } from '@milkdown/kit/utils'

export const subscriptSchema = $markSchema('subscript', () => ({
  // 从 HTML 粘贴 / 外部 DOM 导入时匹配原生 <sub>
  parseDOM: [{ tag: 'sub' }],
  toDOM: () => ['sub', 0],
  parseMarkdown: {
    // mdast 端：node.type === 'subscript'（micromark 层产出，见 remark.ts）
    match: (node) => (node as { type: string }).type === 'subscript',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    // prose 端：mark.type.name === 'subscript'
    match: (mark) => mark.type.name === 'subscript',
    runner: (state, mark) => {
      // 第二个参数 'subscript' 是 mdast 节点类型，与 remark.ts 中的 type 对齐
      state.withMark(mark, 'subscript')
    },
  },
}))

export const superscriptSchema = $markSchema('superscript', () => ({
  parseDOM: [{ tag: 'sup' }],
  toDOM: () => ['sup', 0],
  parseMarkdown: {
    // mdast 端：node.type === 'superscript'（mdast 后置扫描产出，见 remark.ts）
    match: (node) => (node as { type: string }).type === 'superscript',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'superscript',
    runner: (state, mark) => {
      state.withMark(mark, 'superscript')
    },
  },
}))
