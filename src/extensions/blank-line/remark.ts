// 规约C：行内填空线 —— 独立 remark 插件
//
// 语法：
//   --(N)        → N 个全角空格（U+2003）+ 下划线（带线填空线）
//   --(N,blank)  → N 个全角空格，无下划线（纯空白填空线）
//
// 本文件提供与 milkdown 无依赖的 unified/remark transformer：
// 在 mdast 的 text 节点中扫描上述语法，把命中的子串拆成自定义 `blankLine`
// mdast 节点（attrs { chars, blank }），交由后续 schema / stringify / docx 消费。
//
// 复用范围：renderer 的 milkdown remark 管线（remarkPluginsCtx）与 main 的
// unified().use(remarkParse) 管线（docx-export.ts）共用同一解析器，
// 保证两端解析行为一致。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'

// 匹配 --(N) 与 --(N,blank) 的统一正则：
//   组1 = N（整数或小数）
//   组2 = 可选的 ",blank"（命中即纯空白模式）
// JS 默认 . 不匹配换行符，因此天然不跨行。
const RE_BLANK_LINE = /--\((\d+(?:\.\d+)?)(,blank)?\)/g

// 把一个 text 节点的 value 切成 [text?, blankLine, text?, blankLine, ...]。
// 若没有任何匹配，返回 null 表示调用方无需替换原节点。
function splitBlankLine(value: string): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_BLANK_LINE.lastIndex = 0
  while ((m = RE_BLANK_LINE.exec(value)) !== null) {
    hit = true
    if (m.index > last) {
      parts.push({ type: 'text', value: value.slice(last, m.index) })
    }
    parts.push({
      type: 'blankLine',
      chars: Number(m[1]),
      blank: m[2] === ',blank',
    })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < value.length) {
    parts.push({ type: 'text', value: value.slice(last) })
  }
  return parts
}

// unified 插件工厂：返回 transformer。
// remark-parse 把 Markdown 源串解析成 mdast 树后调用本 transformer 遍历。
export function remarkBlankLine(): (tree: unknown) => void {
  return (tree) => {
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      // root 节点的 text（没有 parent 或 index）跳过
      if (!parent || index === undefined || index === null) return undefined
      const parts = splitBlankLine(String(node.value ?? ''))
      if (!parts) return undefined // 没命中语法，保持原节点
      // 用拆分结果替换当前 text 节点
      parent.children.splice(index, 1, ...parts)
      // 跳过刚插入的节点们，避免在它们上面重复扫描
      return [SKIP, index + parts.length]
    })
  }
}
