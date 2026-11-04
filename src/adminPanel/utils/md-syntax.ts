// 工具栏按钮 → markdown 语法串的插入表与插入算法。
//
// 表里的每一项都是 Teyoo 自己的语法（见《语文Markdown扩展-设计规约》，内联长下划线
// 与长空白那条是规约 C）。语法串本身不能改：题干最终按这份 markdown 入库，改一个
// 字符就是另一种语义。
//
// 插入算法（选中就包起来、已包着的再点一次拆掉、没选中就插带占位文字的模板）是从
// ctbapp 的 CommitExercise.vue / utils/toolbar-icon.js 移植的，并修掉它三处缺陷
// （见 insertSyntax 的注释）。这不是「用 ctbapp 的按钮」—— 按钮集与图标只取本项目
// 格式工具栏（src/renderer/index.html 的 #toolbar）里有的。

import { parseFontAttrs, serializeAttrs, type FontAttrs } from '../../extensions/font-style/lib'

export interface SyntaxSpec {
  /** 插在选区（或光标）前的标记 */
  prefix: string
  /** 插在后的标记 */
  subfix: string
  /** 没选中文字时插入的占位文字；会处于选中态，直接打字即替换 */
  text: string
}

/**
 * 长空白：4 个全角空格（U+3000）。
 *
 * 必须用全角空格而非半角（U+0020）：连续半角空格会被 HTML 折叠、也可能被 markdown
 * 序列化规整；全角空格是普通 CJK 字符，不参与语法、不被 trim、源码原样保存。
 * 宽度原来默认 10 个，按用户要求改 4；宿主编辑器工具栏（editor.ts 的
 * insertLongBlank）同步改为 4，两边保持一致。
 */
export const LONG_BLANK = '　'.repeat(4)

/**
 * 插入顺序无关紧要，展示顺序在 EditorToolbar 里定。
 * 只留本项目格式工具栏里有对应按钮的那些：mark / 居左中右 / 代码 / 块公式 /
 * 注音 / 词拼音 / 行内字体 / 整段字体 / 图片块 / 空格 都已去掉。
 */
export const MD_SYNTAX = {
  // ── 行内文字样式 ──
  bold: { prefix: '**', subfix: '**', text: '粗体' },
  italic: { prefix: '*', subfix: '*', text: '斜体' },
  underline: { prefix: '<u>', subfix: '</u>', text: '下划线' },
  throughline: { prefix: '~~', subfix: '~~', text: '中划线' },
  emphdot: { prefix: '@.', subfix: '.@', text: '着重文字' },
  sub: { prefix: '_{', subfix: '}', text: 'x' },
  sup: { prefix: '^{', subfix: '}', text: '2' },

  // ── 空白 / 填空 / 带圈（汉字排版）──
  longblank: { prefix: LONG_BLANK, subfix: '', text: '' },
  // 规约 C 的行内填空线：--(N)，N 是 em 数（1 em = 1 个汉字宽）
  blankline: { prefix: '--(3)', subfix: '', text: '' },
  // 规约「汉字^{数字}」：右上角带圈序号
  circled: { prefix: '^{', subfix: '}', text: '1' },

  // ── 块级 ──
  quotation: { prefix: '> ', subfix: '', text: '引用' },
  ul: { prefix: '- ', subfix: '', text: '列表项' },
  ol: { prefix: '1. ', subfix: '', text: '列表项' },

  // 图片、子块、分栏、田字格、表格、公式都不在这张表里：它们带参数 / 带形状，各走
  // 一个弹出框或划格子面板，产出分别由 stringifyImageAlt / 规约F、G 的写法 /
  // tableMarkdown / 宿主源码模式那套公式串拼出来，见那几个 Modal.vue 与
  // EditorToolbar 的划格子面板
} as const satisfies Record<string, SyntaxSpec>

export type SyntaxKey = keyof typeof MD_SYNTAX

export interface InsertResult {
  /** 替换后的全文 */
  text: string
  /** 新的选区起止；相等即光标 */
  start: number
  end: number
}

/**
 * 把一条语法插到 [start, end)。
 *
 * 与 ctbapp 的 insertHandler 有三处不同，都是修它的缺陷，不是改设计：
 *   1. 包裹选中文字时它写的是 `source.slice(end + subfix.length)` —— 会**吃掉选区
 *      后面 subfix 那么长的字符**。这里不丢字符。
 *   2. 它的占位文字表里有一批 `txt` 是 undefined（title1 那几条），插出来的正文里
 *      直接是字面 `undefined`。这里一律显式给空串或占位词。
 *   3. 多行模板（表格 / 子块）插入后它把整段模板设成选区，随手一打字模板就没了。
 *      这里改成光标落在末尾。
 */
// ─── 标题（块级） ───────────────────────────────────────────────────────────────
//
// 编辑器那边是 `setBlockKind`（把光标所在块整块换类型），序列化出来就是行首的
// `#` 前缀。这里没有文档树，只有源文本，等价做法就是改行首前缀。
// 选区跨多行时逐行都改 —— 与编辑器对多块选区的处理一致。

export type BlockKind =
  | 'paragraph'
  | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6'

const HEADING_LEVEL: Record<BlockKind, number> = {
  paragraph: 0,
  heading1: 1,
  heading2: 2,
  heading3: 3,
  heading4: 4,
  heading5: 5,
  heading6: 6
}

/** 行首的「缩进 + 已有标题前缀」 */
const RE_LINE_HEAD = /^[ \t]*(?:#{1,6}[ \t]+)?/

/**
 * 把 [start, end) 覆盖到的每一行设为 kind 这一级。
 *
 * 前缀长度会变，选区要跟着平移：行内位置按该行的位移整体挪，落在被吃掉的前缀里
 * 的位置（比如光标停在第 2 个 `#` 上）收到新前缀之后，避免光标落在标记内部。
 */
export function applyHeading(source: string, start: number, end: number, kind: BlockKind): InsertResult {
  const level = HEADING_LEVEL[kind]
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const rawEnd = source.indexOf('\n', end)
  const lineEnd = rawEnd === -1 ? source.length : rawEnd

  const lines = source.slice(lineStart, lineEnd).split('\n')
  let total = 0
  const next = lines.map((line) => {
    const head = RE_LINE_HEAD.exec(line)![0]
    const indent = /^[ \t]*/.exec(head)![0]
    const mark = level > 0 ? `${'#'.repeat(level)} ` : ''
    const out = indent + mark + line.slice(head.length)
    total += out.length - line.length
    return out
  })

  // 前缀在行首，行内任意位置都只是整体平移：起点用首行位移、终点用各行累计位移。
  const firstDelta = next[0].length - lines[0].length
  let mappedStart = start + firstDelta
  let mappedEnd = end + total

  // 原本落在前置标记里的位置（如光标停在 `##` 中间、或紧贴标记之后），一律收拢到
  // 新前缀之后 —— 前缀变了还留在原偏移上，光标会落在 `###` 这种标记内部。
  const firstHead = RE_LINE_HEAD.exec(lines[0])![0]
  const firstNewPrefix = /^[ \t]*/.exec(firstHead)![0].length + (level > 0 ? level + 1 : 0)
  if (start - lineStart <= firstHead.length) mappedStart = lineStart + firstNewPrefix
  if (end - lineStart <= firstHead.length) mappedEnd = Math.max(mappedStart, lineStart + firstNewPrefix)

  return {
    text: source.slice(0, lineStart) + next.join('\n') + source.slice(lineEnd),
    start: mappedStart,
    end: Math.max(mappedStart, mappedEnd)
  }
}

// ─── 字体 / 字号（行内，规约H 4.1） ─────────────────────────────────────────────
//
// 属性串的拼法与解析一律交给规约H 自己的模块（src/extensions/font-style/lib.ts）：
// 引号规则、`pt` 校验、属性顺序都在那边，这里不复制一份语法。
//
// 形态与编辑器一致：选中文字 → `{= family=KaiTi size=12pt : 选中文字}`。
// 只选字体就只写 family，只选字号就只写 size（工具栏两个下拉各自只带一个属性，
// 与编辑器那边 applyFont({family}) / applyFont({size}) 一致）；重复应用在同一个
// 位置上则合并属性，而不是套两层 —— 编辑器那边是读出现有 mark 再合并。

/** 紧贴选区前、且紧挨着选区的那一层 `{= … : ` */
const RE_OPEN_WRAPPER = /\{=[ \t]*([^:{}]*?)[ \t]*:[ \t]*$/

/**
 * 给 [start, end) 套上行内字体/字号。
 *
 * 调用方负责前置条件（规约H 8.2：只对同一自然段内的局部文字可用）—— 这里是纯文本
 * 变换，不做校验。
 */
export function applyInlineFont(
  source: string,
  start: number,
  end: number,
  attrs: FontAttrs
): InsertResult {
  const before = source.slice(0, start)
  const after = source.slice(end)
  const selected = source.slice(start, end)
  const hit = RE_OPEN_WRAPPER.exec(before)

  if (hit && after.startsWith('}')) {
    // 已经包着这一层 → 合并属性后重建，保留原有但这次没改的属性（如 align）
    const merged: FontAttrs = { ...(parseFontAttrs(hit[1]) ?? {}), ...attrs }
    const head = `{= ${serializeAttrs(merged)} : `
    const at = hit.index
    return {
      text: before.slice(0, at) + head + selected + source.slice(end),
      start: at + head.length,
      end: at + head.length + selected.length
    }
  }

  const head = `{= ${serializeAttrs(attrs)} : `
  return {
    text: before + head + selected + '}' + after,
    start: start + head.length,
    end: end + head.length
  }
}

/**
 * 纯文本插入（符号面板、插入图片）：替换选区、光标落在插入内容之后。
 * 插的就是源文本本身，不带额外处理 —— 符号是普通字符，图片串则由「插入图片」
 * 弹出框拼好再交进来 —— 与编辑器工具栏的 insertTextAtCursor 一致。
 */
export function insertPlain(source: string, start: number, end: number, insert: string): InsertResult {
  const at = start + insert.length
  return {
    text: source.slice(0, start) + insert + source.slice(end),
    start: at,
    end: at
  }
}

/**
 * 按语法表插一段行内/行首标记。三条规矩（表里每一项都是这套）：
 *   1. 没选中文字 → 插一份带占位文字的模板，占位文字处于选中态，直接打字即替换；
 *   2. 选中的这段已经紧贴着这层标记 → 再点一次是拆掉；
 *   3. 否则把选中的文字包起来。
 * 「前置标记 + 内容 + 后置标记」都是空的条目不存在（表格那种整块模板走
 * tableMarkdown + insertBlockMarkdown，见 EditorToolbar 的划格子面板）。
 */
export function insertSyntax(source: string, start: number, end: number, key: SyntaxKey): InsertResult {
  const { prefix, subfix, text } = MD_SYNTAX[key]
  const before = source.slice(0, start)
  const after = source.slice(end)

  // 1. 没选中任何文字：插一份模板，光标/选区落在中间那段占位文字上
  if (start === end) {
    const inserted = prefix + text + subfix
    return {
      text: before + inserted + after,
      start: start + prefix.length,
      end: start + prefix.length + text.length
    }
  }

  // 2. 选中的这段已经带着这层标记 → 再点一次是拆掉（只认紧贴选区的那一对）
  if (before.endsWith(prefix) && after.startsWith(subfix)) {
    const outer = before.slice(0, before.length - prefix.length)
    const inner = source.slice(start, end)
    const rest = after.slice(subfix.length)
    return {
      text: outer + inner + rest,
      start: start - prefix.length,
      end: end - prefix.length
    }
  }

  // 3. 否则把选中的文字包起来，选区随之前后各平移一截标记
  const selected = source.slice(start, end)
  return {
    text: before + prefix + selected + subfix + after,
    start: start + prefix.length,
    end: end + prefix.length
  }
}

// ─── 表格（GFM 管道表） ───────────────────────────────────────────────────────
//
// 行列数由工具栏那个划格子面板给出（参考 tiptap 的表格选择器：划到几格就插几行几列）。
// 首行是表头，所以「N 行」= 表头行 + (N-1) 个内容行。单元格留空白，不预置占位文字。

/** 行列数上限。与工具栏面板的格数一致（6×6），也给手写调用兜个底 */
export const TABLE_MAX = 6

/**
 * 拼一段 GFM 管道表：单元格为空白（单元格之间用单个空格占位，保证管道符成对），
 * 分隔行每列 6 个短横线，行列数可变。
 */
export function tableMarkdown(rows: number, cols: number): string {
  const r = Math.min(Math.max(rows, 1), TABLE_MAX)
  const c = Math.min(Math.max(cols, 1), TABLE_MAX)
  const row = (): string =>
    `|${Array.from({ length: c }, () => ' ').join('|')}|`
  const lines = [row(), `|${Array.from({ length: c }, () => '------').join('|')}|`]
  // 首行已经是表头，剩下的才是内容行
  for (let i = 1; i < r; i++) lines.push(row())
  return lines.join('\n')
}

// ─── 块级插入：子块 / 分栏 ────────────────────────────────────────────────────
//
// 这两者的开始/结束标记必须**各自独占一行**：规约F 的 `columns/lexer.ts` 里
// RE_SUB_START / RE_COLS_START / RE_COLS_END 全是整行匹配 `^…$`。像行内标记那样插在
// 光标处就会得到「……题干文字@box」，标记不占行首 → 解析端认不出来 → 预览里只是一行
// 普通文字。所以插入点一律移到**光标所在段落之后的新段落**。
// 段落边界按 markdown 本身的规矩认：空行分段，单个换行是段内软换行，不算分段。

/** 空行 = 段落分隔 */
const RE_BLANK_LINE = /\n[ \t]*\n/

/**
 * 把弹出框产出的整块 markdown（子块 / 分栏）插到光标所在段落之后的新段落，
 * 光标落在块尾。
 *
 * 光标位置只用来认「哪一段」，插在哪儿与它无关 —— 这是块级插入，不是行内包裹：
 * 光标停在段中、段首、段尾，结果都一样。块里的内容由弹出框收，不留占位文字，
 * 所以落的就是光标，不选中什么。
 */
export function insertBlockMarkdown(
  source: string,
  start: number,
  block: string
): InsertResult {
  // 段落末尾：下一个空行的第一个换行处；后面没有空行就到文末
  const hit = RE_BLANK_LINE.exec(source.slice(start))
  const paraEnd = hit ? start + hit.index : source.length

  // 段前留一个空行（= 新起一段）；文首本来就是开头，不留
  const lead = paraEnd === 0 ? '' : '\n\n'
  // 收尾后再留一个换行：接着写时不会粘在结束标记上（文末则让文件以换行结束）
  const tail = paraEnd >= source.length ? '\n' : ''
  const caret = paraEnd + lead.length + block.length

  return {
    text: source.slice(0, paraEnd) + lead + block + tail + source.slice(paraEnd),
    start: caret,
    end: caret
  }
}
