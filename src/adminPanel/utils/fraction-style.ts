// 「规范分式」：把完整数学环境里的分式统一成「主体放大、内层紧凑」。
//
// 规则来自 MathBank 后端的 `mathbank/fraction_style.py`（`normalize_fraction_style`），
// 这里是它在渲染端的移植版。原版约 340 行，含大量环境级保护（tikz/verbatim 环境、
// `<mathbank-math>` 锁定块、`[[MBM_*]]` 占位符、smallmatrix…），那些标记 Teyoo
// 的编辑器里根本不存在，所以只保留真正会影响结果的判定：
//
//   1. 只动**成对**的数学定界符内部：`$…$`、`$$…$$`、`\(…\)`、`\[…\]`。
//      裸公式（没有定界符）一律不动 —— 分不清哪段是数学。
//   2. 分式命令只认 `\frac \dfrac \tfrac \cfrac`：
//        · 主层（普通位置）：`\frac` → `\dfrac`，`\dfrac` 保持
//        · 内层（上下标里、另一个分式的分子/分母里）：`\dfrac` → `\frac`
//        · `\tfrac` / `\cfrac` 有明确语义，原样保留
//   3. 保守优先：出现任何拿不准的结构（`\over`、`\atop`、`\choose`、`\displaystyle`、
//      `\genfrac`、`\binom`、`\def` 一类重定义），或 `\left`/`\right` 不配平，
//      **整段数学原样返回**。宁可不动，也不能把题目改坏。
//   4. 不增删定界符、不碰代码块与行内 code、不递归进 `\text{}` 这类文本宏的参数。
//
// 返回值约定：没有可改的地方时返回 `null`，调用方据此判断「不用替换」。

/** 参与规范化的分式命令 */
const FRAC_COMMANDS = new Set(['\\frac', '\\dfrac', '\\tfrac', '\\cfrac'])

/** 文本类宏：参数是正文，里面的分式不参与规范化（原版同样保护） */
const TEXT_MACROS = new Set([
  '\\text',
  '\\textrm',
  '\\textbf',
  '\\textit',
  '\\mbox',
  '\\hbox',
  '\\operatorname',
  '\\mathrm',
  '\\mathbf',
  '\\mathit',
  '\\mathbb',
  '\\mathcal',
  '\\mathsf',
  '\\mathtt'
])

/** 出现即放弃整段（分式语义不明或已被重定义） */
const UNSAFE_TOKENS = [
  '\\over',
  '\\atop',
  '\\choose',
  '\\displaystyle',
  '\\genfrac',
  '\\binom',
  '\\dbinom',
  '\\tbinom',
  '\\def',
  '\\newcommand',
  '\\renewcommand',
  '\\let',
  '\\smallmatrix'
]

/** 代码块与行内 code：里面的 `$` 不是公式 */
const CODE_SEGMENT = /```[\s\S]*?```|`[^`\n]*`/g

/** 成对的数学段（含定界符） */
const MATH_SEGMENT = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\))/g

/** `{...}` 配对读取，start 指向 `{` */
function readGroup(src: string, start: number): { body: string; end: number } | null {
  if (src[start] !== '{') return null
  let depth = 0
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]
    // 转义字符整体跳过：`\{` 不算括号
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { body: src.slice(start + 1, i), end: i + 1 }
    }
  }
  return null
}

/** 读一个宏参数：`{...}` 或单个 token（`\alpha` / `x` / `1`） */
function readArg(
  src: string,
  start: number
): { body: string; end: number; braced: boolean } | null {
  let i = start
  while (i < src.length && /\s/.test(src[i])) i += 1
  if (i >= src.length) return null
  if (src[i] === '{') {
    const group = readGroup(src, i)
    return group ? { body: group.body, end: group.end, braced: true } : null
  }
  if (src[i] === '\\') {
    const macro = /^\\[a-zA-Z]+/.exec(src.slice(i))
    if (!macro) return null
    return { body: macro[0], end: i + macro[0].length, braced: false }
  }
  return { body: src[i], end: i + 1, braced: false }
}

/** 按原括号形式写回：`_1` 不要变成 `_{1}`（等价，但属于无谓改动） */
function wrap(body: string, braced: boolean): string {
  return braced ? `{${body}}` : body
}

/**
 * 读上下标（`_` / `^`）后面那一段。
 *
 * 比 readArg 多一步：`x^\dfrac{1}{2}` 里 `\dfrac` 的**两个参数也在脚本范围内**
 * （LaTeX 就是这么吃的），只吃命令名会把参数漏给外层，既算不对层级也读不全参数，
 * 最后触发「参数不全就放弃」的保护，白改不了。
 */
function readScriptArg(src: string, start: number): { body: string; end: number; braced: boolean } | null {
  let i = start
  while (i < src.length && /\s/.test(src[i])) i += 1
  if (i >= src.length) return null
  if (src[i] === '{') {
    const group = readGroup(src, i)
    return group ? { body: group.body, end: group.end, braced: true } : null
  }
  const macro = /^\\[a-zA-Z]+/.exec(src.slice(i))
  if (macro) {
    const cmd = macro[0]
    if (FRAC_COMMANDS.has(cmd)) {
      const numerator = readArg(src, i + cmd.length)
      const denominator = numerator ? readArg(src, numerator.end) : null
      if (numerator && denominator) {
        return { body: src.slice(i, denominator.end), end: denominator.end, braced: false }
      }
    }
    return { body: cmd, end: i + cmd.length, braced: false }
  }
  return { body: src[i], end: i + 1, braced: false }
}

/**
 * 规范化一段数学（不含定界符）。
 *
 * @param small 当前是否处在「内层」上下文（上下标、分式参数）
 * @returns 改写后的串；不需要改或不确定时返回 null
 */
function normalizeMath(src: string): string | null {
  for (const token of UNSAFE_TOKENS) {
    if (src.includes(token)) return null
  }
  const leftCount = (src.match(/\\left\b/g) ?? []).length
  const rightCount = (src.match(/\\right\b/g) ?? []).length
  if (leftCount !== rightCount) return null

  let changed = false

  const walk = (text: string, small: boolean): string => {
    let out = ''
    let i = 0
    while (i < text.length) {
      const ch = text[i]

      if (ch === '\\') {
        const macro = /^\\[a-zA-Z]+/.exec(text.slice(i))
        // `\{`、`\}`、`\\`、`\,` 这类：连同下一个字符原样搬走
        if (!macro) {
          out += text.slice(i, i + 2)
          i += 2
          continue
        }
        const cmd = macro[0]

        if (FRAC_COMMANDS.has(cmd)) {
          const numerator = readArg(text, i + cmd.length)
          const denominator = numerator ? readArg(text, numerator.end) : null
          if (!numerator || !denominator) {
            // 参数读不全（写作不完整）：整段放弃，返回 null 由外层兜底
            throw new Error('INCOMPLETE_FRACTION')
          }
          const target = cmd === '\\tfrac' || cmd === '\\cfrac' ? cmd : small ? '\\frac' : '\\dfrac'
          if (target !== cmd) changed = true
          out += `${target}{${walk(numerator.body, true)}}{${walk(denominator.body, true)}}`
          i = denominator.end
          continue
        }

        if (TEXT_MACROS.has(cmd)) {
          const arg = readArg(text, i + cmd.length)
          if (arg) {
            out += `${cmd}${wrap(arg.body, arg.braced)}`
            i = arg.end
            continue
          }
          out += cmd
          i += cmd.length
          continue
        }

        out += cmd
        i += cmd.length
        continue
      }

      if (ch === '_' || ch === '^') {
        const arg = readScriptArg(text, i + 1)
        if (!arg) {
          out += ch
          i += 1
          continue
        }
        out += `${ch}${wrap(walk(arg.body, true), arg.braced)}`
        i = arg.end
        continue
      }

      if (ch === '{') {
        const group = readGroup(text, i)
        if (group) {
          out += `{${walk(group.body, small)}}`
          i = group.end
          continue
        }
        out += ch
        i += 1
        continue
      }

      out += ch
      i += 1
    }
    return out
  }

  try {
    const next = walk(src, false)
    return changed ? next : null
  } catch {
    return null
  }
}

/**
 * 对整段 Markdown 做规范分式。
 *
 * @returns 规范化后的文本；没有任何变化时原样返回入参（引用相同，便于调用方判断）
 */
export function normalizeFractionStyle(markdown: string): string {
  const source = markdown ?? ''
  if (!source.includes('$') && !source.includes('\\(') && !source.includes('\\[')) return source

  // 先把代码块/行内 code 挖出来占位，避免里面的 `$` 被当成公式
  const codes: string[] = []
  const masked = source.replace(CODE_SEGMENT, (segment) => {
    codes.push(segment)
    // 占位符用 Unicode 私有区字符：不会出现在题目文本里，也不是控制字符（ESLint
    // 的 no-control-regex 会拦 \x00 那一套）
    return `\uE000CODE${codes.length - 1}\uE001`
  })

  const normalized = masked.replace(MATH_SEGMENT, (segment) => {
    const delimiters = [
      ['$$', '$$'],
      ['$', '$'],
      ['\\[', '\\]'],
      ['\\(', '\\)']
    ] as const
    for (const [open, close] of delimiters) {
      if (!segment.startsWith(open) || !segment.endsWith(close)) continue
      const body = segment.slice(open.length, segment.length - close.length)
      const next = normalizeMath(body)
      return next === null ? segment : `${open}${next}${close}`
    }
    return segment
  })

  return normalized.replace(/\uE000CODE(\d+)\uE001/g, (_match, index: string) => codes[Number(index)] ?? '')
}
