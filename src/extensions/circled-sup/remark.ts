// 规约E：汉字右上角带圈序号 —— remark 插件
//
// 语法：<汉字>^{<数字>}
// 紧贴汉字，渲染为右上角带圈上标数字。示例：
//   人之履^{1} 忧患，大较^{2}有三：
//
// 正则 /([\u4e00-\u9fa5])\^\{(\d+)\}/g：恰好一个汉字 + ^{纯数字}
// 非汉字紧贴不解析；代码块内不解析（mdast code 的 value 不会被遍历）。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'

const RE_CIRCLED_SUP = /([\u4e00-\u9fa5])\^\{(\d+)\}/g

// 把一个 text 节点的 value 切成 [text?, circledSup, text?, ...]
function splitCircledSup(value: string): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_CIRCLED_SUP.lastIndex = 0
  while ((m = RE_CIRCLED_SUP.exec(value)) !== null) {
    hit = true
    if (m.index > last) {
      parts.push({ type: 'text', value: value.slice(last, m.index) })
    }
    parts.push({
      type: 'circledSup',
      char: m[1],
      num: m[2],
    })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < value.length) {
    parts.push({ type: 'text', value: value.slice(last) })
  }
  return parts
}

export function remarkCircledSup(): (tree: unknown) => void {
  return (tree) => {
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      if (!parent || index === undefined || index === null) return undefined
      const parts = splitCircledSup(String(node.value ?? ''))
      if (!parts) return undefined
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}
