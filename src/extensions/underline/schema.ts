// 文字下划线 —— milkdown ProseMirror mark
//
// mark 名：underline
// 形态：内联 mark，包裹文字节点，渲染为原生 <u> 元素
//
// 源码语法：<u>内容</u>；wysiwyg 下由工具栏 / Ctrl+U 切换
// （遵守「格式操作不手动输入」原则，不注册输入规则）。
//
// 参考实现：extensions/emph-dot/schema.ts（mark 四件套范本）、
// renderer/editor/highlight.ts（==text== 高亮 mark）。

import { $markAttr, $markSchema } from '@milkdown/kit/utils'

// mark attribute 入口；外部可通过 ctx.get(underlineAttr.key)(mark) 注入
// 额外 DOM 属性（与 highlight / emph-dot 一致，默认空对象）。
export const underlineAttr = $markAttr('underline')

export const underlineSchema = $markSchema('underline', (ctx) => ({
  // 序列化嵌套优先级：默认 50（与 strong/emphasis/delete 同级）。
  // <u> 与其他 mark 的嵌套顺序语义等价，无需特殊优先级。
  parseDOM: [
    {
      // HTML 粘贴 / 外部 DOM 导入：<u> 标签自动转 underline mark
      tag: 'u',
    },
  ],
  toDOM: (mark) => ['u', ctx.get(underlineAttr.key)(mark)],
  parseMarkdown: {
    // mdast 端：node.type === 'underline'（来自 remark.ts 配对）
    match: (node) => (node as { type: string }).type === 'underline',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    // prose 端：mark.type.name === 'underline'
    match: (mark) => mark.type.name === 'underline',
    runner: (state, mark) => {
      // 第二个参数 'underline' 是 mdast 节点类型，与 remark.ts 对齐
      state.withMark(mark, 'underline')
    },
  },
}))
