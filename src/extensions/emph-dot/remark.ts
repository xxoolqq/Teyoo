// 规约A：字下着重号（点）—— remark 插件
//
// 语法：@.<内容>.@
// 成对 @. 开始、.@ 结束；内容渲染为汉字下方小圆点（高考着重号）。
//
// 两遍扫描：
// 第一遍（单节点）：在 mdast 的单个 text 节点内扫描上述语法，把命中的子串
//   拆成自定义 `emphDot` mdast 节点（children 为原内容），交由 schema / stringify 消费。
// 第二遍（跨节点）：@. 与 .@ 落在不同 text 节点的情况——典型如内容中夹有
//   `**加粗**`、`<u>下划线</u>` 等行内节点：
//     @.首先**得知道你手机里有什**么。聊天.@记录在某信。
//   CommonMark 先把 `**…**` 解析成 strong 节点，@. 与 .@ 被切进两个 text
//   节点，第一遍正则（限定单节点）无法命中。第二遍在同一 parent 的直接
//   子节点序列中配对，把中间的任意行内节点一并包进 emphDot 的 children。
//
// 关键：规约A「支持段落内换行」——意味着内容可含 \n。本插件须在
// remark-breaks 之前运行，否则 \n 已被 remark-breaks 切成 break 节点，
// 单个 text 节点内不再含有 \n，跨 break 的 @..@ 无法匹配。
// 在 editor.ts 的 remarkPluginsCtx 中本插件放在 remarkBreaks 之前。
//
// 不解析场景（规约要求）：
//   - 行内代码 / 代码块内不解析：mdast 中 inline_code / code 节点 value
//     本就是代码字面量，不会被当作 text 节点遍历，自然不会触发本插件。
//   - \@. 转义输出字面 @.：remark-parse 已把 `\@` 解析为转义，text 节点
//     的 value 中不会出现 `\@.` 模式（转义符已消费），不会被误匹配。
//   - 不嵌套：emphDot 子树不参与第二遍配对，中间内容含 emphDot 时放弃配对。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'

// 匹配 @.<内容>.@ 的正则（单 text 节点内）：
//   组1 = 内容（不含 @，但可含 \n —— 支持段落内换行）
// JS 默认 [^@] 匹配换行符，天然支持跨行。
const RE_EMPH_DOT = /@\.([^@]+)\.@/g

// 把一个 text 节点的 value 切成 [text?, emphDot, text?, emphDot, ...]。
// 若没有任何匹配，返回 null 表示调用方无需替换原节点。
function splitEmphDot(value: string): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_EMPH_DOT.lastIndex = 0
  while ((m = RE_EMPH_DOT.exec(value)) !== null) {
    hit = true
    if (m.index > last) {
      parts.push({ type: 'text', value: value.slice(last, m.index) })
    }
    parts.push({
      type: 'emphDot',
      children: [{ type: 'text', value: m[1] }],
    })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < value.length) {
    parts.push({ type: 'text', value: value.slice(last) })
  }
  return parts
}

// ─── 第二遍：跨节点配对 ─────────────────────────────────────────────────────
//
// opener：某 text 节点中的 `@.`，要求其后（到节点末尾）不含 `@`——
//         与单节点正则 `[^@]+` 的「内容不含 @」语义一致。
// closer：opener 之后某 text 节点中的 `.@`，要求其前（到节点起点）不含 `@`。
// 中间的 text 节点若含 `@`（既无 .@ 可配又含 @）视为配对歧义，放弃本次配对。
// 中间若出现 emphDot（含嵌套在子树里）也放弃——规约要求着重号不嵌套。

// 找第一个「其后不含 @ 的 @.」起点；无则 -1。
// 第一个 @. 之后若还有 @，说明它的内容会吞到别的 @，跳过它看下一个。
function findOpener(value: string): number {
  let from = 0
  for (;;) {
    const p = value.indexOf('@.', from)
    if (p < 0) return -1
    if (!value.slice(p + 2).includes('@')) return p
    from = p + 2
  }
}

// 找第一个「其前不含 @ 的 .@」起点；无则 -1。
function findCloser(value: string): number {
  let from = 0
  for (;;) {
    const q = value.indexOf('.@', from)
    if (q < 0) return -1
    if (!value.slice(0, q).includes('@')) return q
    from = q + 2
  }
}

// 子树中是否含 emphDot 节点（用于禁止嵌套）。
function subtreeHasEmphDot(node: any): boolean {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'emphDot') return true
  if (!Array.isArray(node.children)) return false
  return node.children.some((c: any) => subtreeHasEmphDot(c))
}

// 在同一个 parent 的直接子节点序列中配对 @. 与 .@。
// 中间的任意非 text 行内节点（strong/emphasis/html/…）全部
// 成为 emphDot 的 children；两端 text 节点按命中位置切开。
function pairCrossNode(parent: any): void {
  const children = parent.children
  let i = 0
  while (i < children.length) {
    const child = children[i]
    if (!child || child.type !== 'text' || typeof child.value !== 'string') {
      i += 1
      continue
    }
    const p = findOpener(child.value)
    if (p < 0) {
      i += 1
      continue
    }
    // 从 i+1 向后找 closer
    let j = i + 1
    let closerIdx = -1
    let closerOff = -1
    while (j < children.length) {
      const mid = children[j]
      if (mid && mid.type === 'text' && typeof mid.value === 'string') {
        const q = findCloser(mid.value)
        if (q >= 0) {
          closerIdx = j
          closerOff = q
          break
        }
        if (mid.value.includes('@')) {
          // 中间 text 含 @ 又配不上对 → 歧义，放弃
          break
        }
        j += 1
        continue
      }
      if (subtreeHasEmphDot(mid)) {
        // 中间已有着重号 → 不嵌套，放弃
        break
      }
      j += 1
    }
    if (closerIdx < 0) {
      i += 1
      continue
    }
    const closer = children[closerIdx]
    const openerBefore = child.value.slice(0, p)
    const openerAfter = child.value.slice(p + 2)
    const closerBefore = closer.value.slice(0, closerOff)
    const closerAfter = closer.value.slice(closerOff + 2)
    // emphDot 内容 = opener 之后文本 + 中间节点 + closer 之前文本
    const inner: any[] = []
    if (openerAfter) inner.push({ type: 'text', value: openerAfter })
    for (let k = i + 1; k < closerIdx; k++) inner.push(children[k])
    if (closerBefore) inner.push({ type: 'text', value: closerBefore })
    const dot = { type: 'emphDot', children: inner }
    const replacement: any[] = []
    if (openerBefore) replacement.push({ type: 'text', value: openerBefore })
    replacement.push(dot)
    if (closerAfter) replacement.push({ type: 'text', value: closerAfter })
    children.splice(i, closerIdx - i + 1, ...replacement)
    // 继续扫描 dot 之后的节点（closerAfter 文本可能还有新的 opener）
    i += replacement.indexOf(dot) + 1
  }
}

// 递归遍历所有含 children 数组的节点，逐层做跨节点配对。
// emphDot 子树跳过（已匹配内容不重复配对，也保证不嵌套）。
function walkPair(node: any): void {
  if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return
  if (node.type === 'emphDot') return
  pairCrossNode(node)
  for (const child of node.children) walkPair(child)
}

// unified 插件工厂：返回 transformer。
// remark-parse 把 Markdown 源串解析成 mdast 树后调用本 transformer 遍历。
export function remarkEmphDot(): (tree: unknown) => void {
  return (tree) => {
    // 第一遍：单 text 节点内匹配
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      // root 节点的 text（没有 parent 或 index）跳过
      if (!parent || index === undefined || index === null) return undefined
      const parts = splitEmphDot(String(node.value ?? ''))
      if (!parts) return undefined // 没命中语法，保持原节点
      // 用拆分结果替换当前 text 节点
      parent.children.splice(index, 1, ...parts)
      // 跳过刚插入的节点们，避免在它们上面重复扫描
      return [SKIP, index + parts.length]
    })
    // 第二遍：跨节点配对（@. … 行内节点 … .@）
    walkPair(tree)
  }
}
