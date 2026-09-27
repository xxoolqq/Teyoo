// 规约H：字体大小规约 —— remark 插件（块级 + 行内）
//
// 块级容器（fontBlock）：
//   ::: {family=SimSun size=14pt align=justify}
//   内容（多段落、列表、嵌套块等）
//   :::
//
//   采用 mdast 树遍历（非原始文本扫描），在 remark-parse 产出段落树后
//   查找「整段文本恰好是 ::: {attrs}」的段落作为起始标记，向后扫描配对
//   的 ::: 结束段落，用栈处理嵌套。这种方式天然与 columns 等块级扩展
//   组合：columns 已把 @box 区域切为 subBlock 节点，fontBlock 仅在
//   剩余的段落级子节点中识别标记，不会重复处理。
//
// 行内标记（fontSpan）：
//   {= family=KaiTi size=12pt : 目标文本}
//
//   在 mdast text 节点中扫描上述语法，拆成自定义 fontSpan mdast 节点。
//   与 emphDot 同模式：在 remark-breaks 之前运行，保证跨软换行可匹配。
//   \{= 转义：remark-parse 已消费反斜杠，text 节点值为 {=，会被匹配——
//   此为已知限制（与 emphDot 的 \@. 同行为），后续可按 position 回查原始文本。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'
import { parseFontAttrs } from './lib'
import type { FontAttrs } from './lib'

// ─── 块级容器：mdast 树遍历 ──────────────────────────────────────────────────

const RE_BLOCK_START = /^(:{3,})font\s*\{([^}]*)\}\s*$/
const RE_BLOCK_END = /^(:{3,})\s*$/

interface BlockStart {
  colons: number
  attrs: FontAttrs
}

function matchBlockStart(text: string): BlockStart | null {
  const m = RE_BLOCK_START.exec(text)
  if (!m) return null
  const attrs = parseFontAttrs(m[2])
  if (!attrs) return null
  return { colons: m[1].length, attrs }
}

function matchBlockEnd(text: string): { colons: number } | null {
  const m = RE_BLOCK_END.exec(text)
  if (!m) return null
  return { colons: m[1].length }
}

// 取段落的纯文本内容（拼接所有 text 子节点）
function paragraphText(node: any): string {
  if (!node || !node.children) return ''
  return node.children.map((c: any) => (c.type === 'text' ? c.value ?? '' : '')).join('')
}

// 递归处理一个节点的 children 数组：识别 ::: 标记，用栈配对。
// CommonMark 把连续非空行合并为单个段落，所以标记行可能与内容行混在
// 同一个 paragraph 的 text 节点里（用 \n 分隔）。这里按 \n 拆行逐行检查，
// 遇到标记行就拆分段落：标记前的内容 → 新段落，标记行 → 开/闭块级容器，
// 标记后的内容 → 新段落或块级容器内部内容。
function transformChildren(children: any[]): any[] {
  const result: any[] = []
  // 栈：每个 open 项记录冒号数、属性、已收集的内部子节点
  const stack: { colons: number; attrs: FontAttrs; kids: any[] }[] = []

  const pushChild = (child: any): void => {
    if (stack.length > 0) {
      stack[stack.length - 1].kids.push(child)
    } else {
      result.push(child)
    }
  }

  // 把已累积的内容行刷出为段落
  const flushContent = (contentLines: string[]): void => {
    if (contentLines.length > 0) {
      const text = contentLines.join('\n')
      if (text.trim()) {
        pushChild({ type: 'paragraph', children: [{ type: 'text', value: text }] })
      }
      contentLines.length = 0
    }
  }

  for (const child of children) {
    if (child.type === 'paragraph') {
      const text = paragraphText(child)
      // 按行拆分，检查是否包含标记行
      const lines = text.split('\n')
      const hasMarker = lines.some(
        (line) => matchBlockStart(line) || matchBlockEnd(line)
      )
      if (!hasMarker) {
        pushChild(transformNode(child))
        continue
      }
      // 逐行处理：标记行触发开/闭栈，内容行累积后刷出
      const contentLines: string[] = []
      for (const line of lines) {
        const start = matchBlockStart(line)
        if (start) {
          flushContent(contentLines)
          stack.push({ colons: start.colons, attrs: start.attrs, kids: [] })
          continue
        }
        const end = matchBlockEnd(line)
        if (end && stack.length > 0 && stack[stack.length - 1].colons === end.colons) {
          flushContent(contentLines)
          const open = stack.pop()!
          // 空容器注入空段落，保证光标可进入
          const kids = open.kids.length > 0 ? open.kids : [{ type: 'paragraph', children: [] }]
          pushChild({ type: 'fontBlock', family: open.attrs.family, size: open.attrs.size, align: open.attrs.align, children: kids })
          continue
        }
        // 非标记行：累积为内容（含不匹配的结束标记，当字面文本）
        contentLines.push(line)
      }
      flushContent(contentLines)
    } else {
      // 容器节点（list / blockquote / subBlock 等）：
      // 先按当前栈顶的冒号数尝试剥离被懒延续吞入容器末段的 ::: 结束行
      //（栈为空时不剥离——无打开的 fontBlock，::: 是字面内容），
      // 再递归处理容器；容器归位后若剥离成功则立即关闭当前 fontBlock。
      let closeAfter = false
      if (stack.length > 0) {
        closeAfter = stripTrailingEndMarker(child, stack[stack.length - 1].colons)
      }
      pushChild(transformNode(child))
      if (closeAfter) {
        const open = stack.pop()!
        // 空容器注入空段落，保证光标可进入
        const kids = open.kids.length > 0 ? open.kids : [{ type: 'paragraph', children: [] }]
        pushChild({ type: 'fontBlock', family: open.attrs.family, size: open.attrs.size, align: open.attrs.align, children: kids })
      }
    }
  }

  // 未闭合的标记：回退为普通段落 + 原始子节点
  for (const open of stack) {
    const marker = ':'.repeat(open.colons) + 'font {' + serializeAttrsSafe(open.attrs) + '}'
    result.push({ type: 'paragraph', children: [{ type: 'text', value: marker }] })
    result.push(...open.kids)
  }

  return result
}

// serializeAttrs 在 remark.ts 中避免循环依赖，用简单拼接
function serializeAttrsSafe(attrs: FontAttrs): string {
  const parts: string[] = []
  if (attrs.family) parts.push(/\s/.test(attrs.family) ? `family="${attrs.family}"` : `family=${attrs.family}`)
  if (attrs.size) parts.push(`size=${attrs.size}`)
  if (attrs.align) parts.push(`align=${attrs.align}`)
  return parts.join(' ')
}

// 递归处理任意节点：若有 children 则递归 transformChildren
function transformNode(node: any): any {
  if (node && Array.isArray(node.children)) {
    return { ...node, children: transformChildren(node.children) }
  }
  return node
}

// ─── 被容器吞入的结束行剥离 ─────────────────────────────────────────────────
//
// CommonMark 的懒延续（lazy continuation）会把 fontBlock 末尾的 ::: 结束行
// 吞进前一个块容器内部最后一个段落，例如：
//
//   :::font {family=黑体 size=12pt}
//
//   1. 阅读下文，完成第3－7题。（16分）
//      :::
//
//   「   :::」与列表项之间无空行，被并入列表项的段落文本（"…（16分）\n:::"）。
//   走 mdast 路径时该 ::: 不再是独立段落，上面的逐行配对在当前递归层看不到
//   它（容器递归有自己独立的栈），fontBlock 永不闭合 → 回退为字面文本。
//
// 处理方式：遇到容器节点且当前栈上有打开的 fontBlock 时，检查容器文档序
// 最后一个段落的最后一行是否恰好是匹配冒号数的结束标记；是则把该行从段落
// 文本中剥离（段落因此变空时连同段落移除，空的 listItem/list/blockquote
// 一并移除），容器处理完后立即关闭 fontBlock。这样「结束行写在容器内」
// 也能正确闭块，与原始文本上 0~3 空格缩进的书写习惯一致。

/**
 * 尝试从 container 的文档序最后一个段落中剥离「::: 结束行」。
 * 仅当该段落的最后一行（mdast 层前导缩进已被 CommonMark 剥离，此处仍
 * 容忍 0~3 空格以防御性兜底）恰好是 expectColons 个冒号的结束标记时才
 * 修改内容；不匹配时不做任何修改。
 * 命中返回 true，否则返回 false。
 */
function stripTrailingEndMarker(container: any, expectColons: number): boolean {
  const children = container?.children
  if (!Array.isArray(children) || children.length === 0) return false
  const last = children[children.length - 1]
  if (last.type === 'paragraph') {
    const kids = Array.isArray(last.children) ? last.children : []
    const lastText = kids[kids.length - 1]
    if (!lastText || lastText.type !== 'text') return false
    const value = String(lastText.value ?? '')
    const nl = value.lastIndexOf('\n')
    const lastLine = nl >= 0 ? value.slice(nl + 1) : value
    const m = /^[ ]{0,3}(:{3,})\s*$/.exec(lastLine)
    if (!m || m[1].length !== expectColons) return false
    const rest = nl >= 0 ? value.slice(0, nl) : ''
    if (rest.trim() === '') {
      // 该 text 节点只剩标记行：移除；段落随之变空则整段删除
      kids.pop()
      if (kids.length === 0) children.pop()
    } else {
      lastText.value = rest
    }
    return true
  }
  if (!Array.isArray(last.children)) return false
  if (!stripTrailingEndMarker(last, expectColons)) return false
  // 递归剥离后，末尾子容器可能变空（如只剩标记行的 listItem）
  if (
    last.children.length === 0 &&
    (last.type === 'listItem' || last.type === 'list' || last.type === 'blockquote')
  ) {
    children.pop()
  }
  return true
}

export function remarkFontBlock(): (tree: unknown) => void {
  return (tree) => {
    const root = tree as any
    if (!root || !Array.isArray(root.children)) return
    root.children = transformChildren(root.children)
  }
}

// ─── 行内标记：text 节点扫描 ─────────────────────────────────────────────────

// 匹配 {= attrs : text} 的正则：
//   组1 = 属性区（不含 :，因为 : 是分隔符）
//   组2 = 文本区（不含 }，可含 : ）
// \{= 开始，\} 结束；中间 : 分隔属性与文本
const RE_FONT_SPAN = /\{=\s*([^:]+?)\s*:\s*([^}]+)\}/g

// 构建从 text 节点 value 索引到原始 Markdown 偏移的映射。
// 注意 micromark 实测并不消费 `\{`（{ 不在其反斜杠转义表内），因此 value
// 可能与 raw 完全对应（反斜杠保留），也可能已被消费（remark-parse 在其他
// 转义场景下消费反斜杠）。这里逐字符对齐：raw 处是反斜杠时，若 value 当前
// 字符也是反斜杠则视为保留（前进 1），否则视为已消费（前进 2）。
function buildOffsets(value: string, raw: string, rawStart: number): number[] {
  const offsets: number[] = []
  let rp = rawStart
  for (let i = 0; i < value.length; i++) {
    offsets.push(rp)
    if (rp < raw.length && raw[rp] === '\\' && rp + 1 < raw.length) {
      rp += value[i] === '\\' ? 1 : 2
    } else {
      rp += 1
    }
  }
  return offsets
}

// 检查 value 中 matchIndex 处的 { 在原始 Markdown 中是否被反斜杠转义。
// 两种形态都覆盖：
//   已消费：value 以 { 开头，offsets[matchIndex] 指向 raw 中的反斜杠；
//   未消费：value 前一字符就是反斜杠，offsets[matchIndex - 1] 指向它。
function isEscaped(matchIndex: number, offsets: number[], raw: string): boolean {
  const rp = offsets[matchIndex]
  if (rp !== undefined && rp < raw.length && raw[rp] === '\\') return true
  if (matchIndex > 0) {
    const prev = offsets[matchIndex - 1]
    if (prev !== undefined && prev < raw.length && raw[prev] === '\\') return true
  }
  return false
}

// 判定匹配在 raw 中是否「反斜杠已被 remark-parse 消费」：
// 已消费时 value[matchIndex] 是 { 而 offsets[matchIndex] 指向 raw 的 \；
// 未消费时两者字符相同（value 原样保留反斜杠）。
function isBackslashConsumed(matchIndex: number, offsets: number[], value: string, raw: string): boolean {
  const rp = offsets[matchIndex]
  if (rp === undefined || rp >= raw.length) return false
  return raw[rp] === '\\' && value[matchIndex] !== '\\'
}

// 无原始文本时的简单拆分（position 缺失时的回退，如递归解析生成的节点）
function splitFontSpanSimple(value: string): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_FONT_SPAN.lastIndex = 0
  while ((m = RE_FONT_SPAN.exec(value)) !== null) {
    const attrs = parseFontAttrs(m[1])
    if (!attrs) continue
    hit = true
    if (m.index > last) {
      parts.push({ type: 'text', value: value.slice(last, m.index) })
    }
    parts.push({
      type: 'fontSpan',
      family: attrs.family,
      size: attrs.size,
      align: attrs.align,
      children: [{ type: 'text', value: m[2] }],
    })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < value.length) {
    parts.push({ type: 'text', value: value.slice(last) })
  }
  return parts
}

// 带转义检查的拆分：通过 position 回查原始 Markdown，若 {= 被反斜杠转义
// 则不解析为 fontSpan，而是原样输出（恢复反斜杠），保证无损往返。
function splitFontSpanWithEscape(
  value: string,
  raw: string,
  rawStart: number
): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_FONT_SPAN.lastIndex = 0
  const offsets = buildOffsets(value, raw, rawStart)

  while ((m = RE_FONT_SPAN.exec(value)) !== null) {
    // 转义检查：若 { 在原始 Markdown 中被 \ 转义，输出字面 \{= ... }
    if (isEscaped(m.index, offsets, raw)) {
      if (m.index > last) {
        parts.push({ type: 'text', value: value.slice(last, m.index) })
      }
      // 转义命中的输出为字面文本：反斜杠已被 remark-parse 消费时需补回 '\'；
      // 未消费时 value 原样保留着反斜杠，直接原样输出即可。
      // data.__fontSpanLiteral 标记：columns 的 parseChildren 会用内层
      // processor.runSync 先跑一遍本插件，生成的新 text 节点没有 position，
      // 外层链再次访问时会落入 splitFontSpanSimple 重新解析成 fontSpan。
      // 打上标记后，visit 回调见标记直接跳过，保证字面量只解析一次。
      parts.push({
        type: 'text',
        value: isBackslashConsumed(m.index, offsets, value, raw) ? '\\' + m[0] : m[0],
        data: { __fontSpanLiteral: true },
      })
      last = m.index + m[0].length
      hit = true
      continue
    }
    const attrs = parseFontAttrs(m[1])
    if (!attrs) continue // 属性非法，跳过此匹配
    hit = true
    if (m.index > last) {
      parts.push({ type: 'text', value: value.slice(last, m.index) })
    }
    parts.push({
      type: 'fontSpan',
      family: attrs.family,
      size: attrs.size,
      align: attrs.align,
      children: [{ type: 'text', value: m[2] }],
    })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < value.length) {
    parts.push({ type: 'text', value: value.slice(last) })
  }
  return parts
}

export function remarkFontSpan(): (tree: unknown, file?: unknown) => void {
  return (tree, file) => {
    const raw = String((file as any)?.value ?? '')
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      if (!parent || index === undefined || index === null) return undefined
      // 已标记的字面量节点（\{= 转义命中产物）不再二次解析
      if (node.data?.__fontSpanLiteral) return undefined
      const value = String(node.value ?? '')
      if (!value.includes('{=')) return undefined
      const rawStart = node.position?.start?.offset
      const parts = (rawStart !== undefined && raw)
        ? splitFontSpanWithEscape(value, raw, rawStart)
        : splitFontSpanSimple(value)
      if (!parts) return undefined
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}
