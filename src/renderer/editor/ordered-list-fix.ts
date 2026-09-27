// 有序列表序号保真（修复 milkdown preset-commonmark 7.19.2 的三处缺陷）
//
// 上游问题（node_modules/@milkdown/preset-commonmark/src/node/ordered-list.ts）：
// 1. parseMarkdown runner 丢弃 mdast list 的 start 属性——粘贴/打开
//    「13. …」起头的列表时 PM attrs.order 恒为 1；
// 2. toMarkdown runner 硬编码 start: 1——即使 attrs.order 为 13 也输出 1.；
// 3. toDOM 的展开写法 `...(order === 1 ? {} : order)` 生成 {13: 13} 无效
//    属性，DOM 的 <ol> 丢 start，wysiwyg 里序号显示也被重置。
// 三处叠加：粘贴带连续序号（如 13-24）的文档，序号全部重置为 1。
//
// 修复：同名 $nodeSchema('ordered_list') 在 commonmark 预设之后注册，
// nodesCtx 中直接替换官方 schema（$node 按 id 后写覆盖，项目已有
// image-style 同名覆盖 image 的先例）。keymap / inputRule / commands 等
// 独立插件通过 schemaCtx.nodes['ordered_list'] 取 NodeType，不受影响。
// attrs 结构与官方一致，历史文档状态兼容。

import { orderedListAttr } from '@milkdown/kit/preset/commonmark'
import { $nodeSchema } from '@milkdown/kit/utils'
import { expectDomTypeError } from '@milkdown/exception'

export const orderedListFixSchema = $nodeSchema('ordered_list', (ctx) => ({
  content: 'listItem+',
  group: 'block',
  attrs: {
    order: {
      default: 1,
      validate: 'number',
    },
    spread: {
      default: false,
      validate: 'boolean',
    },
  },
  parseDOM: [
    {
      tag: 'ol',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) throw expectDomTypeError(dom)

        return {
          spread: dom.dataset.spread,
          order: dom.hasAttribute('start')
            ? Number(dom.getAttribute('start'))
            : 1,
        }
      },
    },
  ],
  toDOM: (node) => [
    'ol',
    {
      ...ctx.get(orderedListAttr.key)(node),
      ...(node.attrs.order === 1 ? {} : { start: node.attrs.order }),
      'data-spread': node.attrs.spread,
    },
    0,
  ],
  parseMarkdown: {
    match: ({ type, ordered }) => type === 'list' && !!ordered,
    runner: (state, node, type) => {
      const spread = node.spread != null ? `${node.spread}` : 'true'
      // 修复 1：保留 mdast 的 start（缺省 1）
      const order = typeof node.start === 'number' && node.start > 0 ? node.start : 1
      state.openNode(type, { spread, order }).next(node.children).closeNode()
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'ordered_list',
    runner: (state, node) => {
      state.openNode('list', undefined, {
        ordered: true,
        // 修复 2：使用节点实际的 order，而非硬编码 1
        start: node.attrs.order,
        spread: node.attrs.spread === 'true',
      })
      state.next(node.content)
      state.closeNode()
    },
  },
}))
