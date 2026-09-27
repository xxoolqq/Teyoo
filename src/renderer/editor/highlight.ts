import { $markAttr, $markSchema } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { visit, SKIP } from 'unist-util-visit'

// ==text== highlight syntax (Typora / Obsidian style)

export const highlightAttr = $markAttr('highlight')

export const highlightSchema = $markSchema('highlight', (ctx) => ({
  parseDOM: [{ tag: 'mark' }],
  toDOM: (mark) => ['mark', ctx.get(highlightAttr.key)(mark)],
  parseMarkdown: {
    match: (node) => node.type === 'mark',
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next(node.children)
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'highlight',
    runner: (state, mark) => {
      state.withMark(mark, 'mark')
    },
  },
}))

// 无输入规则：格式操作不允许手动输入触发（用户规约），== 高亮只能通过
// 工具栏 / 快捷键或源码模式的 ==text== 语法（解析路径）获得。
// markRule 亦不检查 escaped_literal，会吞掉用户转义的定界符（见
// format-input-rules-off.ts）。

// $markSchema's declared type is a tuple+helpers shape; it is a valid
// MilkdownPlugin at runtime (same as preset-gfm's internal usage)
export const highlight = [highlightAttr, highlightSchema] as unknown as MilkdownPlugin[]

// ─── remark side ────────────────────────────────────────────────────────────

interface MdastNode {
  type: string
  value?: string
  children?: MdastNode[]
}

function splitHighlight(value: string): MdastNode[] {
  const parts: MdastNode[] = []
  let last = 0
  const re = /==([^=\n]+)==/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) parts.push({ type: 'text', value: value.slice(last, m.index) })
    parts.push({ type: 'mark', children: [{ type: 'text', value: m[1] }] })
    last = m.index + m[0].length
  }
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
  return parts
}

// Turn ==text== inside text nodes into mdast 'mark' nodes so files containing
// the syntax load with highlights applied.
export function remarkHighlight(): (tree: unknown) => void {
  return (tree) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      if (!parent || index === undefined || index === null) return undefined
      const parts = splitHighlight(String(node.value ?? ''))
      // skip when nothing was split out (no ==...== found)
      if (!parts.some((p) => p.type === 'mark')) return undefined
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}

// remark-stringify handler so the 'mark' node round-trips back to ==text==
// instead of throwing on an unknown node type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function highlightStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('mark')
  const tracker = state.createTracker(info)
  let value = tracker.move('==')
  value += tracker.move(state.containerPhrasing(node, { before: value, after: '==', ...tracker.current() }))
  value += tracker.move('==')
  exit()
  return value
}
