// 「把一段 Markdown 写进文档的某个区间」—— 行内 / 块级两种落法，这里是**唯一**的判定处。
//
// 为什么必须判：选中一行里的几个字去替换时，解析出来的建议通常是**段落节点**。把一个
// 块节点塞进行内位置，ProseMirror 会把原来的段落切开 —— 用户看到的就是"选中间几个字
// 替换后，本来一整行变成了三段"（左半段 / 建议 / 右半段）。另一种写法（直接
// replaceWith）更糟：块节点会被整段丢掉，只剩选区外的文字。
//
// 规矩：
//   · 区间落在**同一个文本块内**（选中一行中的几个字）→ 只取解析结果的行内内容
//     （段落取它的 content；多段之间用空格连起来，不丢字）
//   · 否则（整块 / 跨块 / 空选区落点）→ 整块替换
//
// 侧边栏「替换选中内容」「替换当前段落」与正文内建议的「接受」都走这里，
// 免得同一个坑在两条路上各踩一次。

import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'

export interface RangeWrite {
  from: number
  to: number
}

export interface RangeContent {
  nodes: ProseMirrorNode[]
  /** 是否按"行内替换"落地（只塞行内内容，不动段落结构） */
  inline: boolean
  /** **实际**要替换的区间：行内区间里出现块级内容时会扩到所在的顶层块 */
  from: number
  to: number
}

/**
 * 算出这个区间里该写进去哪些节点、以及实际替换哪个区间。
 *
 * @param parsed 解析好的顶层节点（调用方各自解析：编辑器侧走 parseMarkdownToNodes）
 */
export function contentForRange(view: EditorView, range: RangeWrite, parsed: ProseMirrorNode[]): RangeContent {
  const doc = view.state.doc
  const from = Math.max(0, Math.min(range.from, doc.content.size))
  const to = Math.max(from, Math.min(range.to, doc.content.size))
  if (!parsed.length) return { nodes: [], inline: false, from, to }
  if (from >= to) return { nodes: parsed, inline: false, from, to }
  const $from = doc.resolve(from)
  const $to = doc.resolve(to)
  const sameBlock = $from.parent.isTextblock && $from.parent === $to.parent
  if (!sameBlock) return { nodes: parsed, inline: false, from, to }

  // 行内区间（段落里的一段文字 / 一个行内对象）：段落取它的 content；多段用空格连上
  const nodes: ProseMirrorNode[] = []
  let lastWasInline = false
  let hasBlock = false
  for (const node of parsed) {
    if (!node.isTextblock) {
      hasBlock = true
      break
    }
    if (lastWasInline) nodes.push(view.state.schema.text(' '))
    node.content.forEach((child) => nodes.push(child))
    lastWasInline = true
  }
  if (!hasBlock) return { nodes, inline: true, from, to }

  // 行内放不下块级内容（典型：选中一张图，模型回了一整个 $$公式$$）→ 把**所在的顶层块
  // 整体**换掉。硬塞进行内位置会被 ProseMirror 吞掉（实测：正文一点没变，或只剩选区
  // 外的字）。用户的预期本来就是"这张图变成那个公式"。
  const start = $from.depth > 0 ? $from.before(1) : from
  const end = $to.depth > 0 ? $to.after(1) : to
  return { nodes: parsed, inline: false, from: start, to: end }
}
