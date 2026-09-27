// 文字下划线 —— remark 插件
//
// 语法：<u>内容</u>（HTML 内联标签，Typora / 遗留文档同款）
//
// 解析原理：CommonMark（micromark）把内联 HTML 标签解析为独立 `html`
// mdast 节点——`<u>` 与 `</u>` 各占一个节点，中间内容保持原结构：
//   <u>**粗体**文字</u>
//     → html('<u>') strong('粗体') text('文字') html('</u>')
// 因此不能像 ==高亮== 那样在单个 text 节点内正则拆分，而是在同一
// parent 的直接子节点序列中「配对」：html('<u>') 开、html('</u>') 闭，
// 闭包区间整体替换为一个 `underline` mdast 节点（children = 中间节点）。
//
// 配对规则（保守，非法一律不识别、保留 html 原样）：
//   - 只认小写精确值 '<u>' / '</u>'（与 docx 导出的遗留兼容口径一致）
//   - 未闭合（有开无闭）→ 不识别
//   - 嵌套（配对区间内又出现 <u> 或 </u>）→ 整对放弃，从闭标签后重扫
//   - 跨行内容（段内软换行）支持：在 remarkBreaks 之前运行，
//     配对区间内的 text 仍含 \n，包进 children 后随 mark 跨行
//
// 注册顺序：residual-emphasis 之后（它展开错误配对的 emphasis 时
// `<u>` 是 html 节点天然不受影响）、remarkBreaks 之前（跨行支持）。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'

const OPEN = '<u>'
const CLOSE = '</u>'

function isInlineHtml(node: any, value: string): boolean {
  return node?.type === 'html' && node.value === value
}

export function remarkUnderline(): (tree: unknown) => void {
  return (tree) => {
    visit(tree as any, (node: any) => {
      const children = node?.children
      if (!Array.isArray(children)) return undefined
      let open = -1
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i]
        if (isInlineHtml(child, OPEN)) {
          // 只记第一层未配对的开标签（多余的 <u> 保持 html 原样）
          if (open === -1) open = i
          continue
        }
        if (isInlineHtml(child, CLOSE)) {
          if (open === -1) continue // 无开有闭：保留原样
          const inner = children.slice(open + 1, i)
          // 嵌套不支持：区间内再遇 <u>/</u> 整对放弃
          if (inner.some((n: any) => isInlineHtml(n, OPEN) || isInlineHtml(n, CLOSE))) {
            open = -1
            continue
          }
          const underline = { type: 'underline', children: inner.length > 0 ? inner : [] }
          children.splice(open, i - open + 1, underline)
          i = open // 从替换后的位置继续向后扫
          open = -1
        }
      }
      return undefined
    })
  }
}

// 防止 tree-shaking 误判（visit 的 SKIP 本插件未用，保持导入形态与
// 其他扩展一致）
void SKIP
