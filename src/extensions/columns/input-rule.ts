// 规约F：子块与分栏 —— 输入规则（所见即所得模式下的交互创建）
//
// 块级标记不像行内扩展那样靠键入结尾字符触发，而是借助 prosemirror-inputrules
// 对 Enter 的处理：在「只包含开始标记的段落」里按回车，规则把整段替换成
// 对应的容器节点，光标落入容器内第一个空段落。
//
//   @box            + Enter → 带框子块
//   @#center        + Enter → 无框居中子块
//   @box#right      + Enter → 带框右对齐子块
//   @@cols 2        + Enter → 2 列等宽分栏（内含 2 个无框空子块）
//   @@cols 1:2      + Enter → 1:2 比例分栏（内含 2 个空子块）
//
// 约束：
//   - 规则锚定 ^，段落必须只有开始标记（避免误伤普通文本）；
//   - 已在 sub_block / cols 内不触发（禁止嵌套）；
//   - 只在普通 paragraph 内触发（标题等不响应）。

import { InputRule } from '@milkdown/kit/prose/inputrules'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'

import { subBlockSchema, colsSchema, columnCount } from './schema'
import type { Align } from './lexer'

// 组1 = box（可选）；组2 = #align（可选）；组3 = left/center/right
const RE_SUB = /^@(box)?(#(left|center|right))?\n$/
// 组1 = spec：N 或 A:B
const RE_COLS = /^@@cols[ ]+(\d+|\d+:\d+)\n$/

/** 判断位置是否已处于容器内部（禁止嵌套） */
function insideContainer($pos: { depth: number; node: (d: number) => { type: { name: string } } }): boolean {
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name
    if (name === 'sub_block' || name === 'cols') return true
  }
  return false
}

export const subBlockInputRule = $inputRule((ctx) => {
  return new InputRule(RE_SUB, (state, match, start, _end) => {
    const $s = state.doc.resolve(start)
    if ($s.parent.type.name !== 'paragraph') return null
    if (insideContainer($s)) return null

    const boxed = match[1] === 'box'
    const align = (match[3] ?? 'left') as Align
    const type = subBlockSchema.type(ctx)
    const para = state.schema.nodes.paragraph.create()
    const node = type.create({ boxed, align }, [para])

    // 整段替换（match 锚定 ^，段落内只有标记，块范围即整个段落）
    const from = $s.before($s.depth)
    const to = $s.after($s.depth)
    const tr = state.tr.replaceWith(from, to, node)
    // 光标进入子块内空段落：sub_block open(1) + paragraph open(1)
    tr.setSelection(TextSelection.create(tr.doc, from + 2))
    return tr
  })
})

export const colsInputRule = $inputRule((ctx) => {
  return new InputRule(RE_COLS, (state, match, start, _end) => {
    const $s = state.doc.resolve(start)
    if ($s.parent.type.name !== 'paragraph') return null
    if (insideContainer($s)) return null

    const spec = match[1]
    const colsType = colsSchema.type(ctx)
    const subType = subBlockSchema.type(ctx)
    const count = columnCount(spec)
    const subs = Array.from({ length: count }, () =>
      subType.create({ boxed: true, align: 'left' }, [state.schema.nodes.paragraph.create()])
    )
    const node = colsType.create({ spec }, subs)

    const from = $s.before($s.depth)
    const to = $s.after($s.depth)
    const tr = state.tr.replaceWith(from, to, node)
    // 光标进入第一个子块的空段落：
    // cols open(1) + sub_block open(1) + paragraph open(1)
    tr.setSelection(TextSelection.create(tr.doc, from + 3))
    return tr
  })
})
