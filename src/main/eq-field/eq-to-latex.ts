// Word EQ 域公式 → LaTeX 转换器（纯逻辑模块，无 DOM / Node 依赖）
//
// 背景：Word 的老式公式以 EQ 域存储，docx 中表现为 w:instrText 文本
// （如 ` EQ \F(2,3)`），而非 OMML。本模块把 EQ 域代码解析并转换为
// LaTeX 内容串（不含 $ 定界符，由调用方按行内/块级自行包装）：
//
//   eqToLatex('EQ \\F(2,3)') → { latex: '\\frac{2}{3}', warnings: [] }
//
// 语法要点（微软官方文档 "Field codes: Eq (Equation) field" 与
// Murray Sargent 博客 "Microsoft Word EQ Field"，2026-09 查证）：
//   - 主开关 = 反斜杠 + 单字母：\a 数组 \b 括号 \d 位移 \f 分数 \i 积分
//     \l 列表 \o 叠加 \r 根式 \s 上下标 \x 边框（大小写不敏感）
//   - 选项 = 反斜杠 + 双字母 + 可选数字（\co2 \up8 \hs3），位于主开关
//     与参数组之间；\bc\c 等选项的字符参数写作 `\` + 单字符（可为字母）
//   - 参数组用 `(...)` 包裹，深度 0 的逗号/分号（区域设置相关）分隔；
//     裸括号只分组不显示（要显示括号用 \b 或 \( 转义）
//   - 转义：`\` + 标点 = 字面字符（官方列出 \, \( \\，此处泛化处理）
//   - 裸文本原样输出（含 Unicode 数学字符），空格保留
//   - 未知开关 / 括号不配对等一律降级并记录 warning，解析永不抛异常
//
// 计划集成（本文件暂不接入）：docx-import.ts 提取 w:instrText →
// eqToLatex() → `$…$` / `$$…$$`。保持纯字符串进出，便于独立测试复用。

/** EQ 域转换结果 */
export interface EqToLatexResult {
  /** LaTeX 内容（不含 $ 定界符，由调用方按行内/块级自行包装） */
  latex: string
  /** 非致命问题（未知开关、括号不配对、参数缺失等）；均已降级处理 */
  warnings: string[]
}

/** EQ 域主开关（反斜杠 + 单字母） */
const MAIN_SWITCHES = new Set(['a', 'b', 'd', 'f', 'i', 'l', 'o', 'r', 's', 'x'])

/** 后跟字符参数的选项（\bc\{ / \fc\c 等，字符写作 `\` + 单字符） */
const CHAR_OPTIONS = new Set(['bc', 'lc', 'rc', 'fc', 'vc'])

/** 选项值：数字（\co2）| 字符（\bc\{）| 布尔开关（\al \su） */
type OptionValue = number | string | boolean

/**
 * 解析 Word EQ 域代码并转换为 LaTeX。
 *
 * 输入为域代码文本（w:instrText 拼接结果），自动去除 `EQ` 前缀（官方：
 * EQ 或 eq 均可）与通用域开关（\* MERGEFORMAT 等）。解析永不抛异常：
 * 无法识别的部分降级为文本输出并记录 warning。
 */
export function eqToLatex(instr: string): EqToLatexResult {
  const warnings: string[] = []
  let src = (instr ?? '').replace(/[\r\n\t]/g, ' ')
  // 通用域开关（\* MERGEFORMAT / CHARFORMAT / MERGEFORMATINET）不属于 EQ 内容
  src = src.replace(/\\\*\s*(MERGEFORMATINET|MERGEFORMAT|CHARFORMAT)\b/gi, '')
  const m = src.match(/^\s*EQ\b/i)
  if (m) src = src.slice(m[0].length)
  // EQ 与首个开关之间的空白是结构性分隔，不进入输出
  src = src.trim()
  if (!src) return { latex: '', warnings: [] }

  const latex = new EqParser(src, warnings).parseSequence()
  if (!latex.trim()) {
    // 整体解析后无输出（病态输入）：降级为转义原文，保证信息不丢
    warnings.push(`EQ 域无法解析：${src.trim()}`)
    return { latex: [...src.trim()].map(latexEscapeChar).join(''), warnings: [...new Set(warnings)] }
  }
  return { latex, warnings: [...new Set(warnings)] }
}

/** EQ 域序列解析器：裸文本与开关交替，参数组递归下降 */
class EqParser {
  private readonly chars: string[]
  private readonly len: number
  private pos = 0

  constructor(src: string, private readonly warnings: string[]) {
    this.chars = Array.from(src)
    this.len = this.chars.length
  }

  /** 解析一段 EQ 序列（裸文本 + 开关交替拼接）直到结尾 */
  parseSequence(): string {
    let out = ''
    while (this.pos < this.len) {
      const c = this.chars[this.pos]
      if (c === '\\') {
        out += this.parseBackslash()
        continue
      }
      if (c === '(') {
        out += this.parsePlainGroup()
        continue
      }
      // 游离的 `)`（病态残留）与其余字符均按字面文本处理
      out += latexEscapeChar(c)
      this.pos++
    }
    return out
  }

  /** 处理 `\`：后随标点为字面转义，后随字母为开关（官方：大小写不敏感） */
  private parseBackslash(): string {
    const next = this.pos + 1 < this.len ? this.chars[this.pos + 1] : ''
    if (next === '') {
      this.pos++
      this.warnings.push('EQ 域以孤立的反斜杠结尾')
      return ''
    }
    if (!isAsciiLetter(next)) {
      // `\` + 标点 = 字面字符转义（\, \( \\ \{ …）
      this.pos += 2
      return latexEscapeChar(next)
    }
    // `\` + 字母（贪婪）+ 可选数字后缀（\co2 \up8 \fo10）
    this.pos++
    let rawName = ''
    while (this.pos < this.len && isAsciiLetter(this.chars[this.pos])) {
      rawName += this.chars[this.pos]
      this.pos++
    }
    let numStr = ''
    while (this.pos < this.len && isAsciiDigit(this.chars[this.pos])) {
      numStr += this.chars[this.pos]
      this.pos++
    }
    const name = rawName.toLowerCase()
    if (name.length === 1 && MAIN_SWITCHES.has(name)) {
      return this.applyMainSwitch(name)
    }
    // 游离的选项或未知开关：忽略开关名本身，渲染其参数组（如有）
    this.warnings.push(`忽略未知开关 \\${rawName}${numStr}`)
    const args = this.tryParseGroupArgs()
    return args ? args.map(a => this.renderArg(a)).join('') : ''
  }

  /** 裸括号组：只分组不显示，组内逗号等按字面处理 */
  private parsePlainGroup(): string {
    this.pos++ // 消费 '('
    const raw = this.collectUntilClose()
    return this.renderArg(raw)
  }

  /** 从 pos 起收集到配对的 `)`（一并消费），返回中间原始内容 */
  private collectUntilClose(): string {
    let depth = 0
    let raw = ''
    while (this.pos < this.len) {
      const c = this.chars[this.pos]
      if (c === '\\') {
        // 转义或嵌套开关：原样保留两字符，渲染阶段再处理
        const next = this.pos + 1 < this.len ? this.chars[this.pos + 1] : ''
        raw += next ? c + next : c
        this.pos += next ? 2 : 1
        continue
      }
      if (c === '(') {
        depth++
      } else if (c === ')') {
        if (depth === 0) {
          this.pos++
          return raw
        }
        depth--
      }
      raw += c
      this.pos++
    }
    this.warnings.push('EQ 域括号不配对')
    return raw
  }

  /** 渲染一段原始 EQ 片段（参数 / 括号组内容）为 LaTeX */
  private renderArg(raw: string): string {
    if (!raw) return ''
    return new EqParser(raw, this.warnings).parseSequence()
  }

  /** 返回从 pos 起跳过空白后的索引（不移动 pos） */
  private peekNonWs(): number {
    let i = this.pos
    while (i < this.len && /\s/.test(this.chars[i])) i++
    return i
  }

  /**
   * 收集主开关后的选项区（其间空白仅作分隔），遇 `(`、转义、裸文本
   * 或下一个主开关即止。返回 选项名(小写) → 值 的映射；未知选项名
   * 仅记录、不被任何构造消费（等价于忽略）。
   */
  private gatherOptions(): Map<string, OptionValue> {
    const opts = new Map<string, OptionValue>()
    for (;;) {
      const i = this.peekNonWs()
      if (i >= this.len) break
      if (this.chars[i] !== '\\') break // 参数组、转义或裸文本：选项区结束
      const next = i + 1 < this.len ? this.chars[i + 1] : ''
      if (!isAsciiLetter(next)) break
      // 读完整选项 token（字母 + 可选数字），先不消费
      let j = i + 1
      let rawName = ''
      while (j < this.len && isAsciiLetter(this.chars[j])) rawName += this.chars[j++]
      let numStr = ''
      while (j < this.len && isAsciiDigit(this.chars[j])) numStr += this.chars[j++]
      const name = rawName.toLowerCase()
      if (name.length === 1 && MAIN_SWITCHES.has(name)) break // 嵌套主开关
      this.pos = j // 消费该选项
      if (CHAR_OPTIONS.has(name)) {
        const ch = this.readOptionChar()
        if (ch === null) this.warnings.push(`选项 \\${name} 后缺少字符参数`)
        else opts.set(name, ch)
      } else {
        opts.set(name, numStr ? parseInt(numStr, 10) : true)
      }
    }
    return opts
  }

  /**
   * 读取 \bc/\lc/\rc/\fc/\vc 选项的字符参数（`\` + 单字符，或裸字符）。
   * 仅在成功时消费；分组符 `(` 与分隔符不作字符参数。
   */
  private readOptionChar(): string | null {
    const i = this.peekNonWs()
    if (i >= this.len) return null
    const c = this.chars[i]
    if (c === '\\') {
      const next = i + 1 < this.len ? this.chars[i + 1] : ''
      if (next === '') return null
      this.pos = i + 2
      return next
    }
    if (c === '(' || c === ')' || c === ',' || c === ';') return null
    this.pos = i + 1
    return c
  }

  /**
   * 尝试解析主开关的参数组：跳过空白后若为 `(` 则收集并按深度 0 的
   * 逗号/分号拆分为原始参数；否则返回 null（不消费任何字符）。
   */
  private tryParseGroupArgs(): string[] | null {
    const i = this.peekNonWs()
    if (i >= this.len || this.chars[i] !== '(') return null
    this.pos = i + 1 // 消费 '('（含其前的结构性空白）
    return splitArgs(this.collectUntilClose())
  }

  /** 主开关分派：先收选项，再取参数组，交给对应构造器 */
  private applyMainSwitch(name: string): string {
    const opts = this.gatherOptions()
    const args = this.tryParseGroupArgs()
    switch (name) {
      case 'f': return this.buildFraction(args)
      case 'r': return this.buildRadical(args)
      case 'b': return this.buildBracket(opts, args)
      case 'i': return this.buildIntegral(opts, args)
      case 'a': return this.buildArray(opts, args)
      case 'l': return this.buildList(args)
      case 'o': return this.buildOverstrike(args)
      case 's': return this.buildScript(opts, args)
      case 'x': return this.buildBox(opts, args)
      case 'd': return this.buildDisplacement(opts, args)
      default: return '' // 不可达（MAIN_SWITCHES 已过滤）
    }
  }

  /** \f(分子,分母) → \frac{..}{..} */
  private buildFraction(args: string[] | null): string {
    if (!args || args.length === 0) {
      this.warnings.push('\\f 缺少参数')
      return ''
    }
    if (args.length > 2) this.warnings.push(`\\f 参数过多（${args.length} 个），已忽略多余项`)
    const num = this.renderArg(args[0])
    const den = args.length > 1 ? this.renderArg(args[1]) : ''
    return `\\frac{${num}}{${den}}`
  }

  /** \r(被开方数) / \r(次数,被开方数) → \sqrt{..} / \sqrt[..]{..}；次数为空按平方根 */
  private buildRadical(args: string[] | null): string {
    if (!args || args.length === 0) {
      this.warnings.push('\\r 缺少参数')
      return ''
    }
    if (args.length > 2) this.warnings.push(`\\r 参数过多（${args.length} 个），已忽略多余项`)
    if (args.length === 1 || !args[0].trim()) {
      // 单元素或次数为空（Murray 例 \R(,b²−4ac)）→ 平方根
      return `\\sqrt{${this.renderArg(args[args.length - 1])}}`
    }
    return `\\sqrt[${this.renderArg(args[0])}]{${this.renderArg(args[1])}}`
  }

  /** \b(元素) → \left..\right 包裹；\bc\c \lc\c \rc\c 指定括号字符 */
  private buildBracket(opts: Map<string, OptionValue>, args: string[] | null): string {
    if (!args || args.length === 0) {
      this.warnings.push('\\b 缺少参数')
      return ''
    }
    if (args.length > 1) this.warnings.push(`\\b 规范上只接受单个元素，已将 ${args.length} 个参数拼接处理`)
    const content = args.map(a => this.renderArg(a)).join('')
    // 官方语义：\bc 指定 { [ ( < 时右侧自动配对闭括号，其它字符两侧同字；
    // \lc/\rc 只画单边（另一边留空）；缺省圆括号
    let left: string | null = null
    let right: string | null = null
    const bc = opts.get('bc')
    if (typeof bc === 'string') {
      left = bc
      right = autoCloseBracket(bc)
    }
    const lc = opts.get('lc')
    if (typeof lc === 'string') left = lc
    const rc = opts.get('rc')
    if (typeof rc === 'string') right = rc
    if (left === null && right === null) {
      left = '('
      right = ')'
    }
    const l = left === null ? '.' : bracketToLatex(left)
    const r = right === null ? '.' : bracketToLatex(right)
    return `\\left${l}${content}\\right${r}`
  }

  /** \i(下限,上限,被积项) → 符号_{..}^{..}被积项；\su \pr \fc\c \vc\c \in */
  private buildIntegral(opts: Map<string, OptionValue>, args: string[] | null): string {
    // 官方语义：\su → Σ 求和、\pr → Π 求积、\fc\c/\vc\c 用字符替代符号、
    // \in 上下限改排符号右侧（LaTeX 以 \nolimits 近似）
    let symbol = '\\int'
    if (opts.has('su')) symbol = '\\sum'
    else if (opts.has('pr')) symbol = '\\prod'
    else {
      const fc = opts.get('fc')
      const vc = opts.get('vc')
      const ch = typeof fc === 'string' ? fc : typeof vc === 'string' ? vc : null
      if (ch) symbol = `\\mathop{${ch}}`
    }
    const r = (args ?? []).map(a => this.renderArg(a))
    if (r.length > 3) this.warnings.push('\\i 只接受 3 个参数（下限,上限,被积项），已忽略多余项')
    let out = symbol + (opts.has('in') ? '\\nolimits' : '')
    if (r[0]) out += `_{${r[0]}}`
    if (r[1]) out += `^{${r[1]}}`
    if (r.length > 2) out += r.slice(2).join('')
    return out
  }

  /** \a(元素,…) → matrix/array；\co n 列数（缺省 1）、\al/\ac/\ar 对齐、\vs/\hs 忽略 */
  private buildArray(opts: Map<string, OptionValue>, args: string[] | null): string {
    if (!args || args.length === 0) {
      this.warnings.push('\\a 缺少参数')
      return ''
    }
    const co = opts.get('co')
    let cols = typeof co === 'number' ? co : 1
    if (!(cols >= 1)) {
      this.warnings.push(`\\co 列数非法（${co}），按 1 列处理`)
      cols = 1
    }
    const r = args.map(a => this.renderArg(a))
    // 元素按行填充 n 列
    const rows: string[][] = []
    for (let i = 0; i < r.length; i += cols) rows.push(r.slice(i, i + cols))
    const body = rows.map(row => row.join(' & ')).join(' \\\\ ')
    let align: string | null = null
    if (opts.has('al')) align = 'l'
    else if (opts.has('ac')) align = 'c'
    else if (opts.has('ar')) align = 'r'
    if (align) return `\\begin{array}{${align.repeat(cols)}}${body}\\end{array}`
    return `\\begin{matrix}${body}\\end{matrix}`
  }

  /** \l(项,…) → 官方语义：以逗号/分号连接的列表（可整体作为单元素使用） */
  private buildList(args: string[] | null): string {
    return (args ?? []).map(a => this.renderArg(a)).join(',')
  }

  /** \o(项,…) → 官方语义：后一个元素叠在前一个之上（最后者最上） */
  private buildOverstrike(args: string[] | null): string {
    const r = (args ?? []).map(a => this.renderArg(a))
    if (r.length === 0) {
      this.warnings.push('\\o 缺少参数')
      return ''
    }
    if (r.length === 1) return r[0]
    // 用零宽 \rlap 逐个叠印近似：全部左对齐于同一起点（官方 \al/\ac/\ar
    // 的盒对齐差异在单字符场景可忽略，作近似不处理）
    const overlaid = r.slice(0, -1).map(x => `\\rlap{${x}}`).join('')
    return `{${overlaid}${r[r.length - 1]}}`
  }

  /** \s\up n(x)/\do n(x) → ^{x}/_{x}；官方语义：未给方向时默认上标（b\S(2)=b²） */
  private buildScript(opts: Map<string, OptionValue>, args: string[] | null): string {
    // \ai n/\di n 是段内行距调整（非上下标），忽略；\up n 默认抬升 2 磅
    const kind = opts.has('do') ? 'sub' : 'sup'
    const r = (args ?? []).map(a => this.renderArg(a))
    if (r.length === 0) return ''
    // 官方语义：多元素垂直堆叠左对齐；以 \substack 近似（KaTeX 支持）
    const content = r.length === 1 ? r[0] : `\\substack{${r.join(' \\\\ ')}}`
    if (!content) return ''
    return kind === 'sup' ? `^{${content}}` : `_{${content}}`
  }

  /** \x(元素) → \boxed{..}；\le \ri \to \bo 选边（LaTeX 只有整框，选边时近似） */
  private buildBox(opts: Map<string, OptionValue>, args: string[] | null): string {
    if (!args || args.length === 0) {
      this.warnings.push('\\x 缺少参数')
      return ''
    }
    if (args.length > 1) this.warnings.push(`\\x 规范上只接受单个元素，已将 ${args.length} 个参数拼接处理`)
    const sides = ['le', 'ri', 'to', 'bo'].filter(s => opts.has(s))
    if (sides.length > 0 && sides.length < 4) {
      this.warnings.push(`\\x 仅请求 ${sides.length} 边框，LaTeX 以完整方框近似`)
    }
    return `\\boxed{${args.map(a => this.renderArg(a)).join('')}}`
  }

  /** \d 位移：\fo n/\ba n → 右/左移间距；\li → 下划线（官方延伸到域外下一字符，以 2em 近似） */
  private buildDisplacement(opts: Map<string, OptionValue>, args: string[] | null): string {
    let out = ''
    if (opts.has('li')) out += '\\underline{\\hspace{2em}}'
    const fo = opts.get('fo')
    if (typeof fo === 'number') out += `\\hspace{${fo}pt}`
    const ba = opts.get('ba')
    if (typeof ba === 'number') out += `\\hspace{-${ba}pt}`
    // 官方约定参数组为空括号；若有内容则原样渲染跟随
    if (args && args.length) out += args.map(a => this.renderArg(a)).join('')
    return out
  }
}

/** 把参数组原始内容按深度 0 的逗号/分号（区域设置相关）拆分为参数 */
function splitArgs(raw: string): string[] {
  const chars = Array.from(raw)
  const args: string[] = []
  let cur = ''
  let depth = 0
  let i = 0
  while (i < chars.length) {
    const c = chars[i]
    if (c === '\\') {
      // 转义或嵌套开关：原样保留（渲染阶段处理），跳过被转义字符
      cur += c + (chars[i + 1] ?? '')
      i += 2
      continue
    }
    if (c === '(') {
      depth++
    } else if (c === ')') {
      if (depth > 0) depth--
    } else if ((c === ',' || c === ';') && depth === 0) {
      args.push(cur)
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  args.push(cur)
  return args
}

/** 单个字面字符 → LaTeX（对数学模式特殊字符加转义） */
function latexEscapeChar(c: string): string {
  switch (c) {
    case '&':
    case '%':
    case '$':
    case '#':
    case '_':
      return '\\' + c
    case '{':
      return '\\{'
    case '}':
      return '\\}'
    case '\\':
      return '\\backslash'
    case '^':
      return '\\^{}'
    case '~':
      return '\\~{}'
    default:
      // 字母数字与 ( ) [ ] , ; . + - = / < > | 等原样
      return c
  }
}

/** 括号字符 → LaTeX 定界符（配 \left/\right 使用） */
function bracketToLatex(c: string): string {
  switch (c) {
    case '{':
      return '\\{'
    case '}':
      return '\\}'
    case '<':
      return '\\langle'
    case '>':
      return '\\rangle'
    default:
      return c // ( ) [ | 等原样
  }
}

/** 官方语义：\bc 指定 { [ ( < 时右侧自动用配对闭括号，其它字符原样 */
function autoCloseBracket(c: string): string {
  switch (c) {
    case '{':
      return '}'
    case '[':
      return ']'
    case '(':
      return ')'
    case '<':
      return '>'
    default:
      return c
  }
}

function isAsciiLetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

function isAsciiDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}
