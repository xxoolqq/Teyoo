// 残余强调/强调/删除线重解析插件
//
// 问题：CommonMark 的 emphasis/strong/strikethrough 解析依赖"侧翼"规则。
// 当 ** / * / ~~ 紧邻 Unicode 标点字符（如 @ . < ~）时，分隔符不满足
// left-flanking / right-flanking 条件。这会导致两种问题：
// 1. **@.内容.@** 不被识别为粗体，标记留在 text 节点里，序列化时被转义。
// 2. 更严重的是，CommonMark 可能把 **@.x.@** 的最后一个 * 和远处 *@.y.@*
//    的第一个 * 错误配对成 emphasis，把 ** 拆散，导致整段结构混乱。
//
// 本插件的策略：
// 1. 先把 CommonMark 解析出的 emphasis / strong / delete 节点全部"展开"
//    回 text（用对应标记包裹内容），消除错误配对。
// 2. 在合并后的 text 上重新匹配 **..** / *..* / ~~..~~（含已转义形式），
//    拆为正确的 strong / emphasis / delete 节点。
// 3. 处理跨兄弟节点的情况（** 被 html 等节点拆开）。
//
// 注册顺序：必须在 remarkGfm（提供 ~~ 删除线）之后、remarkEmphDot /
// remarkUnderline（处理 @..@ / <u>..</u>）之前。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'

// ─── 标记定义 ─────────────────────────────────────────────────────────────

const MARK_OPENERS: Record<string, string> = {
  strong: '**',
  emphasis: '*',
  delete: '~~',
}
const MARK_CLOSERS: Record<string, string> = {
  strong: '**',
  emphasis: '*',
  delete: '~~',
}

// 单 text 节点内的标记正则（同时支持未转义和已转义形式）。
// 注意 emphasis 的 * 前后都不能是 *，避免把 ** 拆成两个 *。
// ***..*** 必须排在 **..** 之前，否则 ** 会先匹配 *** 中的前两个 *。
const PATTERNS: { re: RegExp; type: string; delim: number; escaped: boolean }[] = [
  // 已转义优先
  { re: /\\\*\\\*\\\*((?:[^*]|\\*(?!\\\*\\*))+?)\\\*\\\*\\\*/g, type: 'emphasisStrong', delim: 6, escaped: true },
  { re: /\\\*\\\*((?:[^*]|\\*(?!\\\*))+?)\\\*\\\*/g, type: 'strong', delim: 4, escaped: true },
  { re: /(?<!\\\*)\\\*(?!\\\*)([^*]+?)(?<!\\\*)\\\*(?!\\\*)/g, type: 'emphasis', delim: 2, escaped: true },
  { re: /\\\~\\\~([^~]+?)\\\~\\\~/g, type: 'delete', delim: 4, escaped: true },
  // 未转义
  { re: /\*\*\*((?:[^*]|\*(?!\*\*))+?)\*\*\*/g, type: 'emphasisStrong', delim: 3, escaped: false },
  { re: /\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, type: 'strong', delim: 2, escaped: false },
  { re: /(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, type: 'emphasis', delim: 1, escaped: false },
  { re: /~~([^~]+?)~~/g, type: 'delete', delim: 2, escaped: false },
]

function findEarliest(value: string): { start: number; end: number; content: string; type: string; delim: number; escaped: boolean } | null {
  let best: { start: number; end: number; content: string; type: string; delim: number; escaped: boolean } | null = null
  for (const { re, type, delim, escaped } of PATTERNS) {
    re.lastIndex = 0
    const m = re.exec(value)
    if (m && (!best || m.index < best.start)) {
      best = { start: m.index, end: m.index + m[0].length, content: m[1], type, delim, escaped }
    }
  }
  return best
}

function makePos(start: number, end: number): any {
  return {
    start: { line: 1, column: 1, offset: start },
    end: { line: 1, column: 1, offset: end },
  }
}

// 递归拆分单个 text 节点内的残余标记。
function splitResidual(value: string, base: number, fileValue?: string): any[] | null {
  const hit = findEarliest(value)
  if (!hit) return null

  const parts: any[] = []
  if (hit.start > 0) {
    parts.push({ type: 'text', value: value.slice(0, hit.start), position: makePos(base, base + hit.start) })
  }

  let innerValue = hit.content
  if (hit.escaped) {
    innerValue = innerValue.replace(/\\([*~])/g, '$1')
  }

  // 确保 position offset 指向实际的 * 或 ~ 字符
  let markerOffset = base + hit.start
  if (fileValue) {
    const markerChar = hit.type === 'delete' ? '~' : '*'
    for (let o = markerOffset; o < Math.min(markerOffset + 8, fileValue.length); o++) {
      if (fileValue[o] === markerChar) { markerOffset = o; break }
    }
  }

  const innerBase = base + hit.start + hit.delim
  const inner = splitResidual(innerValue, innerBase, fileValue)
  const innerChildren = inner || [{ type: 'text', value: innerValue, position: makePos(innerBase, innerBase + innerValue.length) }]

  // *** (emphasisStrong) 包裹为嵌套结构 emphasis{strong{children}}，
  // 序列化时输出 ***...***（先 * 开 emphasis，再 ** 开 strong；
  // 关闭时 ** 关 strong，* 关 emphasis）。
  if (hit.type === 'emphasisStrong') {
    parts.push({
      type: 'emphasis',
      children: [{
        type: 'strong',
        children: innerChildren,
        position: makePos(markerOffset, base + hit.end),
      }],
      position: makePos(markerOffset, base + hit.end),
    })
  } else {
    parts.push({
      type: hit.type,
      children: innerChildren,
      position: makePos(markerOffset, base + hit.end),
    })
  }

  const rest = value.slice(hit.end)
  if (rest) {
    const restBase = base + hit.end
    const restParts = splitResidual(rest, restBase, fileValue)
    if (restParts) parts.push(...restParts)
    else parts.push({ type: 'text', value: rest, position: makePos(restBase, restBase + rest.length) })
  }
  return parts
}

// ─── 展开 CommonMark 的 emphasis/strong/delete 节点 ──────────────────────

// 只展开"可疑的"（错误配对的）emphasis/strong/delete 节点。
// 判断依据：mark 节点的前面或后面存在以标记字符结尾/开头的 text 兄弟节点
// （中间可以隔着 html/emphDot/delete/strong/emphasis 等任意非 text 节点），
// 说明 CommonMark 把本不属于这个 mark 的 * 错误配对进来了。
// 对于 CommonMark 正确解析的嵌套结构（如 emphasis{strong}），由于没有
// 散落的标记 text 兄弟，依然保持不变。
// 注意：不能在遇到其他 MARK_TYPES 时 break——否则 `**<u>~~text~~</u>**...***~~text~~***`
// 这种 CommonMark 跨节点错配的情形无法被识别（错配的 strong 和 emphasis 之间隔着 delete）。
function isMismatchedMark(node: any, index: number, parent: any): boolean {
  if (!parent || !Array.isArray(parent.children)) return false

  // 向前查找：跳过任意非 text 节点（html/emphDot/delete/strong/emphasis 等），
  // 直到遇到以标记字符结尾的 text。纯文本（不以标记结尾）也跳过，继续向前找。
  for (let i = index - 1; i >= 0; i--) {
    const sib = parent.children[i]
    if (!sib) break
    if (sib.type === 'text' && typeof sib.value === 'string') {
      if (sib.value.match(/(\\?[*~]{1,2})$/)) return true
      // 纯文本不以标记结尾，继续向前找
      continue
    }
    // 其他类型节点（html/mark 等），跳过继续找
  }
  // 向后查找：跳过任意非 text 节点，直到遇到以标记字符开头的 text。
  for (let i = index + 1; i < parent.children.length; i++) {
    const sib = parent.children[i]
    if (!sib) break
    if (sib.type === 'text' && typeof sib.value === 'string') {
      if (sib.value.match(/^(\\?[*~]{1,2})/)) return true
      // 纯文本不以标记开头，继续向后找
      continue
    }
  }
  return false
}

function flattenMismatchedMarks(node: any, index: number | null, parent: any): any[] {
  if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
    // 只有错误配对的 mark 才展开
    if (index !== null && parent && isMismatchedMark(node, index, parent)) {
      const opener = MARK_OPENERS[node.type]
      const closer = MARK_CLOSERS[node.type]
      const startOff = node.position?.start?.offset ?? 0
      const endOff = node.position?.end?.offset ?? 0
      const openerLen = opener.length
      const closerLen = closer.length
      const result: any[] = [
        { type: 'text', value: opener, position: makePos(startOff, startOff + openerLen) },
      ]
      for (const child of node.children || []) {
        result.push(...flattenMismatchedMarks(child, null, node))
      }
      result.push({
        type: 'text',
        value: closer,
        position: makePos(endOff - closerLen, endOff),
      })
      return result
    }
    // 正确配对的 mark，递归处理子节点但保持 mark 结构
    if (node.children) {
      node.children = node.children.flatMap((child: any, i: number) => flattenMismatchedMarks(child, i, node))
    }
    return [node]
  }
  if (node.children) {
    node.children = node.children.flatMap((child: any, i: number) => flattenMismatchedMarks(child, i, node))
  }
  return [node]
}

// 合并相邻的 text 节点，保留第一个 text 的 position（作为起始 offset）。
// 注意必须透传 node.data：columns 的内层解析会先跑行内扩展，转义字面量
// （如 \{=...}）节点带 data.__fontSpanLiteral 标记供外层 remarkFontSpan
// 跳过二次解析；此处若重建节点时丢掉 data，外层会把字面量重新解析成
// fontSpan，导致反斜杠与 {= 前缀丢失。
function mergeAdjacentTexts(children: any[]): any[] {
  const result: any[] = []
  for (const node of children) {
    if (node.type === 'text') {
      const last = result[result.length - 1]
      if (last && last.type === 'text') {
        last.value += node.value
      } else {
        result.push({ type: 'text', value: node.value, position: node.position, data: node.data })
      }
    } else {
      result.push(node)
    }
  }
  return result
}

// ─── 跨兄弟节点的残余标记 ───────────────────────────────────────────────────

// 标记的字面形式（未转义 / 已转义），用于在 text 中查找位置。
// *** 必须排在 ** 之前，否则 ** 会先匹配到 *** 中的前两个 *，导致拆散三连标记。
const MARKER_LITERALS: { type: string; marker: string; escaped: boolean }[] = [
  // 三连标记 ***..*** —— 等价于 emphasis{strong{...}}，需特殊包裹
  { type: 'emphasisStrong', marker: '***', escaped: false },
  { type: 'emphasisStrong', marker: '\\*\\*\\*', escaped: true },
  { type: 'strong', marker: '**', escaped: false },
  { type: 'strong', marker: '\\*\\*', escaped: true },
  { type: 'emphasis', marker: '*', escaped: false },
  { type: 'emphasis', marker: '\\*', escaped: true },
  { type: 'delete', marker: '~~', escaped: false },
  { type: 'delete', marker: '\\~\\~', escaped: true },
]

// 根据 type + escaped 返回对应的字面标记字符串。
function markerLiteral(type: string, escaped: boolean): string {
  if (escaped) {
    if (type === 'emphasisStrong') return '\\*\\*\\*'
    if (type === 'strong') return '\\*\\*'
    if (type === 'emphasis') return '\\*'
    if (type === 'delete') return '\\~\\~'
  } else {
    if (type === 'emphasisStrong') return '***'
    if (type === 'strong') return '**'
    if (type === 'emphasis') return '*'
    if (type === 'delete') return '~~'
  }
  return ''
}

// 在 text 中查找第一个标记的位置，返回 { index, type, marker, escaped } 或 null。
// 对于 emphasis，确保 * 前后都不是 *（避免把 ** 拆开）。
// 对于 strong，确保 ** 前后都不是 *（避免把 *** 拆成 ** + *）。
function findMarkerInText(value: string, from = 0): { index: number; type: string; marker: string; escaped: boolean } | null {
  let best: { index: number; type: string; marker: string; escaped: boolean } | null = null
  for (const { type, marker, escaped } of MARKER_LITERALS) {
    let idx = value.indexOf(marker, from)
    while (idx !== -1) {
      // 对于 emphasis（单 *），确保前后都不是 *，避免拆 ** 或 ***
      if (type === 'emphasis') {
        const before = value[idx - 1]
        const after = value[idx + marker.length]
        if (before === '*' || after === '*') {
          idx = value.indexOf(marker, idx + 1)
          continue
        }
      }
      // 对于 strong（**），确保前后都不是 *，避免拆 *** 或 ****
      if (type === 'strong') {
        const before = value[idx - 1]
        const after = value[idx + marker.length]
        if (before === '*' || after === '*') {
          idx = value.indexOf(marker, idx + 1)
          continue
        }
      }
      if (!best || idx < best.index) {
        best = { index: idx, type, marker, escaped }
      }
      break
    }
  }
  return best
}

// 在 text 中查找指定类型的 closing marker 位置。
function findClosingMarker(value: string, type: string, escaped: boolean, from = 0): number {
  const marker = markerLiteral(type, escaped)
  let idx = value.indexOf(marker, from)
  while (idx !== -1) {
    if (type === 'emphasis') {
      const before = value[idx - 1]
      const after = value[idx + marker.length]
      if (before === '*' || after === '*') {
        idx = value.indexOf(marker, idx + 1)
        continue
      }
    }
    if (type === 'strong') {
      const before = value[idx - 1]
      const after = value[idx + marker.length]
      if (before === '*' || after === '*') {
        idx = value.indexOf(marker, idx + 1)
        continue
      }
    }
    return idx
  }
  return -1
}

function processCrossSibling(parent: any, fileValue?: string): void {
  const children: any[] = parent.children
  if (!Array.isArray(children)) return

  let i = 0
  while (i < children.length) {
    const node = children[i]
    if (!node || node.type !== 'text') { i++; continue }

    const value = String(node.value ?? '')
    const openInfo = findMarkerInText(value)
    if (!openInfo) { i++; continue }

    const { index: openIdx, type, marker: openMarker, escaped } = openInfo
    const openLen = openMarker.length

    // 向后搜索同类型的 closing marker（只在后续 text 节点中找，
    // 同一 text 节点内的匹配由 splitResidual 处理）
    let closeFound = false
    for (let j = i + 1; j < children.length && !closeFound; j++) {
      const closeNode = children[j]
      if (!closeNode || closeNode.type !== 'text') continue
      const closeVal = String(closeNode.value ?? '')

      const closeIdx = findClosingMarker(closeVal, type, escaped, 0)
      if (closeIdx === -1) continue

      const closeMarkerStr = markerLiteral(type, escaped)
      const closeLen = closeMarkerStr.length

      // 构造替换
      const beforeText = value.slice(0, openIdx)
      const afterText = closeVal.slice(closeIdx + closeLen)
      const wrapped = children.slice(i + 1, j)

      // opening text 中 marker 后面的部分
      const openRemainder = value.slice(openIdx + openLen)
      if (openRemainder) {
        wrapped.unshift({ type: 'text', value: openRemainder })
      }
      // closing text 中 marker 前面的部分
      if (j > i) {
        const closeBefore = closeVal.slice(0, closeIdx)
        if (closeBefore) {
          wrapped.push({ type: 'text', value: closeBefore })
        }
      }

      // 已转义标记：去掉 wrapped 中 text 的反斜杠
      if (escaped) {
        for (const w of wrapped) {
          if (w && w.type === 'text' && typeof w.value === 'string') {
            w.value = w.value.replace(/\\([*~])/g, '$1')
          }
        }
      }

      const baseOpen = node.position?.start?.offset ?? 0
      let delimStart = baseOpen + openIdx
      if (fileValue) {
        const markerChar = type === 'delete' ? '~' : '*'
        for (let o = delimStart; o < Math.min(delimStart + 8, fileValue.length); o++) {
          if (fileValue[o] === markerChar) { delimStart = o; break }
        }
      }
      const baseClose = closeNode.position?.start?.offset ?? 0
      const closeEnd = baseClose + closeIdx + closeLen

      const replacement: any[] = []
      if (beforeText) {
        replacement.push({ type: 'text', value: beforeText, position: makePos(baseOpen, delimStart) })
      }

      // *** (emphasisStrong) 需要包裹为嵌套结构 emphasis{strong{children}}，
      // 这样序列化时会输出 ***...***（先 * 开 emphasis，再 ** 开 strong，
      // 关闭时 ** 关 strong，* 关 emphasis）。
      let markNode: any
      const innerChildren = wrapped.length > 0 ? wrapped : [{ type: 'text', value: '' }]
      if (type === 'emphasisStrong') {
        const strongNode: any = {
          type: 'strong',
          children: innerChildren,
          position: makePos(delimStart, closeEnd),
        }
        markNode = {
          type: 'emphasis',
          children: [strongNode],
          position: makePos(delimStart, closeEnd),
        }
      } else {
        markNode = {
          type,
          children: innerChildren,
          position: makePos(delimStart, closeEnd),
        }
      }
      replacement.push(markNode)
      if (afterText) {
        replacement.push({ type: 'text', value: afterText, position: makePos(baseClose + closeIdx + closeLen, baseClose + closeVal.length) })
      }

      children.splice(i, j - i + 1, ...replacement)

      // 递归处理 mark 节点内部（对 emphasisStrong，递归到 strong 的 children）
      const recurseRoot = type === 'emphasisStrong' ? markNode.children[0] : markNode
      processCrossSibling(recurseRoot, fileValue)
      for (let k = 0; k < recurseRoot.children.length; k++) {
        const child = recurseRoot.children[k]
        if (child && child.type === 'text') {
          const cb = child.position?.start?.offset ?? 0
          const cp = splitResidual(String(child.value ?? ''), cb, fileValue)
          if (cp) {
            recurseRoot.children.splice(k, 1, ...cp)
            k += cp.length - 1
          }
        }
      }

      closeFound = true
    }

    if (!closeFound) i++
  }
}

function processTree(node: any, fileValue?: string): void {
  if (!node) return
  if (Array.isArray(node.children)) {
    processCrossSibling(node, fileValue)
    for (const child of node.children) {
      processTree(child, fileValue)
    }
  }
}

// 把 mark 节点（emphasis/strong/delete）首尾的纯空格 text 移到外面。
// milkdown SerializerState 的 #moveSpaces 会把 mark 首尾空格移出，若 mark 内容
// 全是空格会变成空 mark（如 emphasis{text("")} → "**"），导致往返错乱。
function moveSpacesOutOfMarks(tree: any): void {
  const MARK_TYPES = new Set(['emphasis', 'strong', 'delete'])
  visit(tree as any, (node: any, index: any, parent: any) => {
    if (!node || !MARK_TYPES.has(node.type) || !parent || index === undefined) return
    const children = node.children
    if (!Array.isArray(children) || children.length === 0) return

    const leading = children[0]
    if (leading && leading.type === 'text' && leading.value.startsWith(' ')) {
      const spaces = leading.value.match(/^[ \t]+/)![0]
      leading.value = leading.value.slice(spaces.length)
      if (leading.value === '') children.shift()
      parent.children.splice(index, 0, { type: 'text', value: spaces })
      return [SKIP, index + 1]
    }

    const trailing = children[children.length - 1]
    if (trailing && trailing.type === 'text' && trailing.value.endsWith(' ')) {
      const spaces = trailing.value.match(/[ \t]+$/)![0]
      trailing.value = trailing.value.slice(0, trailing.value.length - spaces.length)
      if (trailing.value === '') children.pop()
      parent.children.splice(index + 1, 0, { type: 'text', value: spaces })
      return [SKIP, index + 1]
    }
  })
}

// ─── unified 插件入口 ─────────────────────────────────────────────────────

export function remarkResidualEmphasis(): (tree: unknown, file: any) => void {
  return (tree, file) => {
    const fileValue = file?.value ? String(file.value) : undefined

    // 第一步：只展开错误配对的 emphasis/strong/delete 节点，
    // 保留 CommonMark 正确解析的嵌套结构（如 emphasis{strong}）
    flattenMismatchedMarks(tree as any, null, null)

    // 第二步：合并相邻 text 节点
    visit(tree as any, (node: any) => {
      if (Array.isArray(node.children)) {
        node.children = mergeAdjacentTexts(node.children)
      }
    })

    // 第三步：先处理跨兄弟节点的残余标记（** 被 html 等节点拆开的情况），
    // 避免单 text 内的 ** 和 ** 被误配对（如 "** 和 **"）。
    processTree(tree, fileValue)

    // 第四步：单 text 节点内的残余标记重解析
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      if (!parent || index === undefined || index === null) return undefined
      const value = String(node.value ?? '')
      const base = node.position?.start?.offset ?? 0
      const parts = splitResidual(value, base, fileValue)
      if (!parts) return undefined
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })

    // 第五步：再次处理跨兄弟节点（splitResidual 可能产生新的跨节点标记）
    processTree(tree, fileValue)

    // 第六步：把 mark 节点首尾的空格移到外面，避免 milkdown #moveSpaces 产生空 mark
    moveSpacesOutOfMarks(tree)
  }
}
