// 规约G：汉字田字格 —— remark 插件
//
// 在 mdast text 节点中扫描 ++...++，对每个 token 用 lib.parseCells 分类：
// 合法 → 替换为 tianziGrid mdast 节点（attr raw 保存 ++ 之间的完整 inner）；
// 非法 → 保留为普通文本。
//
// 代码块 / 行内代码内不解析：mdast code 节点的 value 不会作为 text 被遍历。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'
import { RE_TIANZI, parseCells } from './lib'

function splitTianzi(value: string): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_TIANZI.lastIndex = 0
  while ((m = RE_TIANZI.exec(value)) !== null) {
    // 非法 token（++abc++ 等）不识别，整体当普通文本，继续向后找
    if (!parseCells(m[1])) continue
    hit = true
    if (m.index > last) {
      parts.push({ type: 'text', value: value.slice(last, m.index) })
    }
    parts.push({ type: 'tianziGrid', raw: m[1] })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < value.length) {
    parts.push({ type: 'text', value: value.slice(last) })
  }
  return parts
}

export function remarkTianziGrid(): (tree: unknown) => void {
  return (tree) => {
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      if (!parent || index === undefined || index === null) return undefined
      const value = String(node.value ?? '')
      if (!value.includes('++')) return undefined
      const parts = splitTianzi(value)
      if (!parts) return undefined
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}
