// 规约F：子块与分栏 —— 行级栈扫描器（lexer）
//
// 本模块与 milkdown / remark 均无依赖，只做一件事：
// 在「原始 Markdown 字符串」上按行扫描，识别出合法配对的子块 / 分栏区域，
// 返回每个区域在原文中的字节偏移区间与解析后的属性（boxed / align / spec），
// 以及区域内部内容的原文切片（inner）。
//
// 为什么不用 mdast 遍历：
//   规约F 是块级容器语法，开始/结束标记跨多行，内部允许空行、代码块、图片等。
//   remark-parse 之后这些行会被切成多个 mdast 块节点，无法在 mdast 层可靠
//   重组。直接在原始文本上按行扫描最直接、最可靠（与规约给出的「用栈解析」
//   词法一致）。
//
// 词法（规约原文）：
//   子块开始（行首）：/^[ ]{0,3}@(box)?(#(left|center|right))?[ ]*$/
//   子块结束（行尾）：/(.*?)[ ]{0,3}@[ ]*$/
//   分栏开始：       /^[ ]{0,3}@@cols\s+(\d+|\d+:\d+)\s*$/
//   分栏结束：       /^[ ]{0,3}@@[ ]*$/
//   - 行首允许 0~3 个空格缩进；
//   - 块外遇到行首 @ = 子块开始，块内遇到行尾 @ = 子块结束；
//   - 必须配对；代码围栏（``` / ~~~）内不解析；\@ 转义；
//   - 禁止分栏嵌套分栏。

export type Align = 'left' | 'center' | 'right'

// ─── 数据结构（扫描产物，字段协议固定，供 remark/schema/stringify 共用）───────

/** 一个已配对子块的全部信息（含原文偏移） */
export interface SubRegion {
  boxed: boolean
  align: Align
  /** 结束标记之前、开始标记行之后的内部原文（已做公共缩进去除） */
  inner: string
  /** 区域在原文中的起止偏移（含开始/结束行的换行符，便于切片重组） */
  start: number
  end: number
  /** 去缩进前内部原始切片在整篇原文中的起点偏移 */
  innerStart: number
  /** 去缩进前内部原始切片在整篇原文中的终点偏移（结束标记前） */
  innerEnd: number
  /** 去缩进后文本偏移 → 去缩进前原始切片偏移 的位置映射 */
  innerMap: number[]
}

/** 分栏内的子块（偏移为整篇原文绝对偏移） */
export interface ColsSub {
  boxed: boolean
  align: Align
  inner: string
  innerStart: number
  innerEnd: number
  innerMap: number[]
}

export type Region =
  | ({ kind: 'sub' } & SubRegion)
  | {
      kind: 'cols'
      spec: string
      subs: ColsSub[]
      start: number
      end: number
    }

// ─── 行模型 ─────────────────────────────────────────────────────────────────

interface Line {
  /** 不含换行符的行文本 */
  text: string
  /** 行首在原文中的偏移 */
  start: number
  /** 行尾（不含换行符）的偏移 */
  end: number
  /** 换行符长度（\r\n = 2，\n = 1，末行 = 0） */
  sepLen: number
}

function splitLines(raw: string): Line[] {
  const lines: Line[] = []
  const re = /\r\n|\n|\r/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    lines.push({ text: raw.slice(last, m.index), start: last, end: m.index, sepLen: m[0].length })
    last = m.index + m[0].length
  }
  if (last < raw.length) {
    lines.push({ text: raw.slice(last), start: last, end: raw.length, sepLen: 0 })
  }
  return lines
}

// ─── 行级匹配 ───────────────────────────────────────────────────────────────

const RE_SUB_START = /^[ ]{0,3}@(box)?(#(left|center|right))?[ ]*$/
const RE_COLS_START = /^[ ]{0,3}@@cols[ ]+(\d+|\d+:\d+)[ ]*$/
const RE_COLS_END = /^[ ]{0,3}@@[ ]*$/
/** 代码围栏行：0~3 空格 + 至少 3 个 ` 或 ~ */
const RE_FENCE = /^[ ]{0,3}(`{3,}|~{3,})/

interface SubStartMatch {
  boxed: boolean
  align: Align
  /** @ 在行内的下标（用于检查 \@ 转义） */
  atIndex: number
}

interface SubEndMatch {
  /** @ 在行内的下标 */
  atIndex: number
}

/** 判断 @ 前一个字符是否为反斜杠（\@ 转义） */
function isEscaped(text: string, atIndex: number): boolean {
  return atIndex > 0 && text[atIndex - 1] === '\\'
}

function matchSubStart(text: string): SubStartMatch | null {
  const m = RE_SUB_START.exec(text)
  if (!m) return null
  const atIndex = text.indexOf('@')
  if (isEscaped(text, atIndex)) return null
  return { boxed: m[1] === 'box', align: (m[2] ? m[2].slice(1) : 'left') as Align, atIndex }
}

function matchSubEnd(text: string): SubEndMatch | null {
  // 结束标记：行尾的 @（允许其前 0~3 空格、其后 0~3 空格）
  const m = /[ ]{0,3}@[ ]*$/.exec(text)
  if (!m) return null
  const atIndex = m.index + m[0].indexOf('@')
  if (isEscaped(text, atIndex)) return null
  return { atIndex }
}

function matchColsStart(text: string): { spec: string; atIndex: number } | null {
  const m = RE_COLS_START.exec(text)
  if (!m) return null
  const atIndex = text.indexOf('@')
  if (isEscaped(text, atIndex)) return null
  return { spec: m[1], atIndex }
}

function matchColsEnd(text: string): { atIndex: number } | null {
  const m = RE_COLS_END.exec(text)
  if (!m) return null
  const atIndex = text.indexOf('@')
  if (isEscaped(text, atIndex)) return null
  return { atIndex }
}

/** 返回代码围栏字符（'`' / '~'），非围栏行返回 null */
function fenceChar(text: string): string | null {
  const m = RE_FENCE.exec(text)
  return m ? m[1][0] : null
}

// ─── 公共缩进去除 ───────────────────────────────────────────────────────────

/**
 * 对子块内部原文去除「所有非空行的最小公共前导空白」。
 * 制表符按 4 空格计；空行不参与统计；换行统一规范为 \n。
 *
 * 返回 dedent 后的文本，以及一份「位置映射」relMap：
 *   relMap[k] === 去缩进后文本第 k 个字符在「去缩进前原始切片」中的偏移。
 * 被移除的前导空白在输出中不存在，因此没有映射项；规范化产生的 \n 映射到
 * 原换行符起点。供 remark 插件把内部 mdast 的 position 偏移重定位回整篇
 * 原文坐标（修复子块内 strong/emphasis 的 marker 读取错位问题）。
 */
function dedent(inner: string): { text: string; relMap: number[] } {
  // 切成带原始偏移与换行符的段
  const segs: { text: string; start: number; sep: string; sepStart: number }[] = []
  const re = /\r\n|\n|\r/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    segs.push({ text: inner.slice(last, m.index), start: last, sep: m[0], sepStart: m.index })
    last = m.index + m[0].length
  }
  if (last < inner.length) {
    segs.push({ text: inner.slice(last), start: last, sep: '', sepStart: inner.length })
  }

  // 统计最小公共前导空白列
  let min = Infinity
  for (const seg of segs) {
    if (seg.text.trim() === '') continue
    let n = 0
    for (const ch of seg.text) {
      if (ch === ' ') n += 1
      else if (ch === '\t') n += 4
      else break
    }
    if (n < min) min = n
  }

  // 无需去缩进：文本原样返回，映射为恒等映射
  if (!isFinite(min) || min === 0) {
    const relMap = new Array(inner.length)
    for (let i = 0; i < inner.length; i++) relMap[i] = i
    return { text: inner, relMap }
  }

  let out = ''
  const relMap: number[] = []
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    if (seg.text.trim() !== '') {
      // 按「视觉列」移除 min 列（空格=1 列，制表符=4 列）
      let remain = min
      let i = 0
      while (remain > 0 && i < seg.text.length) {
        const ch = seg.text[i]
        const w = ch === '\t' ? 4 : 1
        if (remain < w) break
        remain -= w
        i += 1
      }
      // 保留下来的字符：逐个映射回原始切片偏移
      for (let k = i; k < seg.text.length; k++) {
        relMap.push(seg.start + k)
        out += seg.text[k]
      }
    }
    if (seg.sep) {
      relMap.push(seg.sepStart)
      out += '\n'
    }
  }
  return { text: out, relMap }
}

// ─── 扫描器 ─────────────────────────────────────────────────────────────────

interface ScanSubResult {
  region: SubRegion
  /** 结束行的下一行下标（继续扫描的位置） */
  nextLine: number
}

/**
 * 从子块开始行 startIdx 起扫描到配对的结束标记。
 * 内容中遇到代码围栏时，围栏内的 @ 不算结束标记。
 * 找不到配对结束 → null（调用方放弃整个区域，按普通文本处理）。
 */
function scanSub(
  raw: string,
  lines: Line[],
  startIdx: number,
  start: SubStartMatch
): ScanSubResult | null {
  let fence: string | null = null
  for (let j = startIdx + 1; j < lines.length; j++) {
    const line = lines[j]
    const fc = fenceChar(line.text)
    if (fc) {
      if (!fence) fence = fc
      else if (fence === fc) fence = null
      continue
    }
    if (fence) continue
    const end = matchSubEnd(line.text)
    if (!end) continue
    // 命中结束行：内部原文 = 开始行换行之后 → 结束 @ 之前
    // （去掉 @ 前属于语法的 0~3 空格），再做公共缩进去除
    const startLine = lines[startIdx]
    const innerStart = startLine.end + startLine.sepLen
    let innerEnd = line.start + end.atIndex
    const beforeAt = line.text.slice(0, end.atIndex)
    const spaces = beforeAt.length - beforeAt.replace(/[ ]{0,3}$/, '').length
    innerEnd -= spaces
    const { text: inner, relMap } = dedent(raw.slice(innerStart, innerEnd))
    return {
      region: {
        boxed: start.boxed,
        align: start.align,
        inner,
        start: startLine.start,
        end: line.end + line.sepLen,
        innerStart,
        innerEnd,
        innerMap: relMap,
      },
      nextLine: j + 1,
    }
  }
  return null
}

interface ScanColsResult {
  spec: string
  subs: ColsSub[]
  start: number
  end: number
  nextLine: number
}

/**
 * 从分栏开始行扫描配对的 @@。
 * - 分栏内只允许出现：子块（必须配对）、空白行、代码围栏；
 * - 再次遇到 @@cols → 嵌套，整个分栏作废；
 * - @@ 缺失 → 作废。
 * 作废返回 null，调用方按普通文本处理（不识别）。
 */
function scanCols(
  raw: string,
  lines: Line[],
  startIdx: number,
  spec: string
): ScanColsResult | null {
  const subs: ColsSub[] = []
  let fence: string | null = null
  let j = startIdx + 1
  while (j < lines.length) {
    const line = lines[j]
    const fc = fenceChar(line.text)
    if (fc) {
      if (!fence) fence = fc
      else if (fence === fc) fence = null
      j += 1
      continue
    }
    if (fence) {
      j += 1
      continue
    }
    // 嵌套分栏 → 非法
    if (matchColsStart(line.text)) return null
    // 分栏结束
    if (matchColsEnd(line.text)) {
      return {
        spec,
        subs,
        start: lines[startIdx].start,
        end: line.end + line.sepLen,
        nextLine: j + 1,
      }
    }
    // 子块开始
    const subStart = matchSubStart(line.text)
    if (subStart) {
      const sub = scanSub(raw, lines, j, subStart)
      if (!sub) return null
      subs.push({
        boxed: sub.region.boxed,
        align: sub.region.align,
        inner: sub.region.inner,
        innerStart: sub.region.innerStart,
        innerEnd: sub.region.innerEnd,
        innerMap: sub.region.innerMap,
      })
      j = sub.nextLine
      continue
    }
    // 子块之间只允许空白行
    if (line.text.trim() !== '') return null
    j += 1
  }
  return null
}

/**
 * 扫描整篇原始 Markdown，返回所有合法区域（按出现顺序）。
 * 区域之间互不重叠；未配对 / 非法嵌套一律不识别（保留为普通文本）。
 */
export function scanRegions(raw: string): Region[] {
  const lines = splitLines(raw)
  const regions: Region[] = []
  let fence: string | null = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fc = fenceChar(line.text)
    if (fc) {
      if (!fence) fence = fc
      else if (fence === fc) fence = null
      i += 1
      continue
    }
    if (fence) {
      i += 1
      continue
    }
    const cols = matchColsStart(line.text)
    if (cols) {
      const r = scanCols(raw, lines, i, cols.spec)
      if (r) {
        regions.push({
          kind: 'cols',
          spec: r.spec,
          subs: r.subs,
          start: r.start,
          end: r.end,
        })
        i = r.nextLine
        continue
      }
      // 非法分栏：按普通行跳过，不做任何识别
      i += 1
      continue
    }
    const sub = matchSubStart(line.text)
    if (sub) {
      const r = scanSub(raw, lines, i, sub)
      if (r) {
        regions.push({ kind: 'sub', ...r.region })
        i = r.nextLine
        continue
      }
      i += 1
      continue
    }
    i += 1
  }
  return regions
}
