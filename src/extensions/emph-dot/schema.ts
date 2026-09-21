// 规约A：字下着重号（点）—— milkdown ProseMirror mark
//
// mark 名：emphDot
// 形态：内联 mark，包裹文字节点，渲染为文字下方小圆点
//
// 视觉：toDOM 生成 <span class="emph-dot">...</span>，
//       CSS 用 text-decoration: underline dotted 模拟点状下划线，
//       通过 text-underline-offset 把下划线移到汉字下边缘附近。
//
// 参考实现：src/renderer/editor/highlight.ts（==text== 高亮 mark）
//   - $markAttr：暴露 mark 的 attribute 接口（可注入额外 attrs）
//   - $markSchema：声明 parseDOM / toDOM / parseMarkdown / toMarkdown
//   - parseMarkdown：把 mdast emphDot 节点转成 ProseMirror mark，
//     openMark → 遍历 children（递归加 mark）→ closeMark
//   - toMarkdown：把 ProseMirror mark 转成 mdast emphDot 节点，
//     withMark(mark, 'emphDot') 在序列化时打开 mark 上下文

import { $markAttr, $markSchema } from '@milkdown/kit/utils'

// mark attribute 入口；外部可通过 ctx.get(emphDotAttr.key)(mark) 注入
// 额外 DOM 属性，这里默认空对象，与 highlight.ts 一致。
export const emphDotAttr = $markAttr('emphDot')

export const emphDotSchema = $markSchema('emphDot', (ctx) => ({
  // 序列化嵌套优先级：低于默认 50（strong/emphasis/delete/highlight
  // 均为默认 50），milkdown SerializerState 按优先级升序套 mark——数值最小者
  // 最外层。着重号必须最外层，否则「@.首先**加粗**么。聊天.@」这类跨节点
  // 着重号在 PM→mdast 时会被 strong 拆成三段独立着重号（@.首先.@**@.加粗.@**
  // @.么。聊天。.@），源码被改写。取 45 后序列化为 @.首先**加粗**么。聊天。.@
  // 无损往返。注意：**@.x.@** 这类旧写法会一次性规范成 @.**x**.@（渲染等价）。
  priority: 45,
  parseDOM: [
    {
      // 从 HTML 粘贴 / 外部 DOM 导入时匹配 .emph-dot span
      tag: 'span.emph-dot',
    },
  ],
  toDOM: (mark) => ['span', { class: 'emph-dot', ...ctx.get(emphDotAttr.key)(mark) }, 0],
  parseMarkdown: {
    // mdast 端：node.type === 'emphDot'（来自 remark.ts 拆分）
    match: (node) => (node as { type: string }).type === 'emphDot',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    // prose 端：mark.type.name === 'emphDot'
    match: (mark) => mark.type.name === 'emphDot',
    runner: (state, mark) => {
      // 第二个参数 'emphDot' 是 mdast 节点类型，与 remark.ts 中的 type 对齐
      state.withMark(mark, 'emphDot')
    },
  },
}))
