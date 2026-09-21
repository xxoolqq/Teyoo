// Word (docx) 导出 —— 含全部自定义扩展语法支持
//
// 解析管线与 renderer 编辑器保持一致（见 src/renderer/editor/editor.ts 的
// remarkPluginsCtx 注册顺序）：
//   remarkParse → remarkGfm → remarkColumns → remarkFontBlock →
//   remarkResidualEmphasis → remarkEmphDot → remarkFontSpan → remarkBreaks →
//   remarkHighlight(本地轻量版) → remarkBlankLine → remarkPinyinRuby →
//   remarkPinyinInline → remarkCircledSup → remarkTianziGrid
//
// 关键点：所有自定义扩展都是「树 transformer」，必须用
//   processor.runSync(processor.parse(md), vfile)
// 执行；只调 parse 不会运行任何 transformer（历史实现踩过的坑）。
// VFile 携带原始文本：remarkColumns（区域识别）、remarkFontSpan（转义回查）依赖它。
//
// 各扩展的 docx 映射（行内 → Run，块级 → 段落/表格，不残留任何字面标记）：
//   规约A emphDot      @..@       → TextRun emphasisMark（字下加点）
//   规约B pinyinRuby   汉字(pi)   → OOXML w:ruby（拼音在汉字上方）
//   规约B2 pinyinInline 汉字[pi]  → 汉字 Run + 灰色小号拼音 Run（同行并列）
//   规约C blankLine    --(N)      → 全角空格 + 下划线（原有实现）
//   规约D image        ![a#w#h#对齐#B](url) → 尺寸/对齐；data: URL 直接嵌入
//   规约E circledSup   字^{n}     → 汉字 + 上标带圈数字（①…⑳㉑…㉟㊱…㊿）
//   规约F subBlock/cols @box/@@cols → 单元格表格（boxed 带边框，比例分栏）
//   规约G tianziGrid   ++xx++     → 虚线字符边框格子；拼音格用 w:ruby 置顶
//   规约H fontBlock    ::: font{…} → 段落对齐 + 字体字号（子树继承）
//   规约H fontSpan     {= …: …}   → Run 字体/字号覆盖
//   公式   $…$ / $$…$$ → OMML（LaTeX → MathML → OMML，方案注册表 src/main/formula）
//   高亮 ==text==      → TextRun highlight 黄色
//   内联 <u>…</u>      → 下划线 Run（遗留文档兼容）

import { nativeImage } from 'electron'
import { basename, dirname, extname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import { VFile } from 'vfile'
import {
  AlignmentType,
  BorderStyle,
  Document,
  EmphasisMarkType,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  ImportedXmlComponent,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type ParagraphChild,
} from 'docx'

// 注意：从各扩展的具体模块文件导入 remark transformer，不走 barrel index——
// index 会连带引入 milkdown schema/plugin（ProseMirror 渲染层），主进程用不到。
import { remarkBlankLine } from '../extensions/blank-line/remark'
import { blankLineToDocxRuns } from '../extensions/blank-line/docx'
import { remarkEmphDot } from '../extensions/emph-dot/remark'
import { remarkPinyinRuby } from '../extensions/pinyin-ruby/remark'
import { convertPinyin } from '../extensions/pinyin-ruby/pinyin'
import { remarkPinyinInline } from '../extensions/pinyin-inline/remark'
import { remarkCircledSup } from '../extensions/circled-sup/remark'
import { remarkColumns } from '../extensions/columns/remark'
import { remarkFontBlock, remarkFontSpan } from '../extensions/font-style/remark'
import { remarkTianziGrid } from '../extensions/tianzi-grid/remark'
import { parseCells } from '../extensions/tianzi-grid/lib'
import { parseImageAlt, type ImageParams } from '../extensions/image-style/lib'
// 残余强调重解析与编辑器共用同一实现（**紧邻标点的侧翼规则修正）
import { remarkResidualEmphasis } from '../renderer/editor/residual-emphasis'
// 公式误判防护（$价格$ 之类不算 LaTeX）与编辑器共用同一实现
import { remarkMathFalsePositiveGuard } from '../renderer/editor/math-guard'
// LaTeX 公式转换（LaTeX → OMML），方案注册表见 ./formula
import { getFormulaConverter, type FormulaConverter } from './formula'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface MarkdownNode {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  start?: number
  url?: string
  alt?: string
  lang?: string
  // 自定义扩展节点的属性（emphDot/pinyinRuby/circledSup/subBlock/cols/font…）
  chars?: number
  blank?: boolean
  text?: string
  pinyin?: string
  char?: string
  num?: string
  raw?: string
  boxed?: boolean
  align?: string
  spec?: string
  family?: string
  size?: string
  children?: MarkdownNode[]
}

export interface DocxExportInput {
  content: string
  sourcePath: string | null
  /**
   * LaTeX 公式转换方案 id（对应 formula 注册表，见 src/main/formula）。
   * 未来设置面板选择后经导出入口传入；缺省用注册表默认方案。
   */
  formulaConverter?: string
}

// ─── 行内样式上下文（随节点递归累积） ────────────────────────────────────────

interface RunStyle {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  /** <u>…</u> 内联 HTML 包裹时置 true */
  underline?: boolean
  /** ==高亮== 内时置 true */
  highlight?: boolean
  /** @..@ 着重号内时置 true */
  emphDot?: boolean
  /** 字体名（fontBlock 继承 / fontSpan 覆盖） */
  family?: string
  /** 字号，形如 "14pt"（fontBlock 继承 / fontSpan 覆盖） */
  fontSize?: string
}

// 块级样式上下文：fontBlock / subBlock 向子树传递
interface BlockStyle {
  family?: string
  size?: string
  align?: string
}

// ─── 小工具 ─────────────────────────────────────────────────────────────────

function headingForDepth(depth: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  const headings = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ]
  return headings[Math.max(0, Math.min(5, depth - 1))] as (typeof HeadingLevel)[keyof typeof HeadingLevel]
}

function textContent(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') return node.value ?? ''
  if (node.type === 'break') return '\n'
  // 公式在纯文本上下文（blockquote/脚注等）降级为 LaTeX 原文
  if (node.type === 'math' || node.type === 'inlineMath') return `$${node.value ?? ''}$`
  return node.children?.map(textContent).join('') ?? ''
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** "14pt" → docx 半点值 28；非法输入返回 undefined */
function ptToHalfPoints(size: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)pt$/.exec(size ?? '')
  if (!m) return undefined
  return Math.max(2, Math.round(Number(m[1]) * 2))
}

const ALIGN_MAP: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
}

function alignmentOf(align: string | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  return align ? ALIGN_MAP[align] : undefined
}

// ─── OOXML 原生 XML 注入（ruby 注音 / 字符边框） ─────────────────────────────
//
// docx 库未提供 phonetic guide（w:ruby）与字符边框（w:bdr）的声明式 API，
// 通过 ImportedXmlComponent.fromXmlString 注入原始 OOXML。注意 w:rPr 子元素
// 顺序须符合 CT_RPr 序列：rFonts → color → spacing → sz → szCs → bdr。

/** 字符边框（虚线方框）rPr 片段 —— 田字格用，颜色与编辑器 #444 一致 */
const TIANZI_BORDER_RPR = '<w:bdr w:val="dashed" w:sz="6" w:space="1" w:color="444444"/>'

/** 构造一个 Run 的 rPr 片段（保持 CT_RPr 元素顺序） */
function rprXml(style: RunStyle, opts: { border?: boolean } = {}): string {
  const parts: string[] = []
  if (style.family) {
    parts.push(`<w:rFonts w:ascii="${xmlEscape(style.family)}" w:eastAsia="${xmlEscape(style.family)}" w:hAnsi="${xmlEscape(style.family)}"/>`)
  }
  const half = ptToHalfPoints(style.fontSize)
  if (half) {
    parts.push(`<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`)
  }
  if (opts.border) parts.push(TIANZI_BORDER_RPR)
  return parts.length > 0 ? `<w:rPr>${parts.join('')}</w:rPr>` : ''
}

/**
 * 构造注音 Run（w:ruby）：rt 拼音显示在 base 基字上方。
 * opts.baseBorder：基字加虚线字符边框（田字格拼音格的空格底座）。
 * 注音字号取基字的一半（与 Word 拼音指南默认行为一致）。
 */
function rubyRunXml(base: string, rt: string, style: RunStyle, opts: { baseBorder?: boolean } = {}): ImportedXmlComponent {
  const half = ptToHalfPoints(style.fontSize)
  const rtHalf = half ? Math.max(10, Math.round(half / 2)) : 15
  const xml =
    '<w:r><w:ruby>' +
    '<w:rubyPr><w:rubyAlign w:val="center"/></w:rubyPr>' +
    '<w:rt><w:r>' +
    `<w:rPr><w:sz w:val="${rtHalf}"/><w:szCs w:val="${rtHalf}"/></w:rPr>` +
    `<w:t xml:space="preserve">${xmlEscape(rt)}</w:t>` +
    '</w:r></w:rt>' +
    '<w:rubyBase><w:r>' +
    rprXml(style, { border: opts.baseBorder }) +
    `<w:t xml:space="preserve">${xmlEscape(base)}</w:t>` +
    '</w:r></w:rubyBase>' +
    '</w:ruby></w:r>'
  return fromXml(xml)
}

/** 注音 Run 在 docx 库类型里没有专有类型，运行时可正常参与 prepForXml */
function asParagraphChild(c: ImportedXmlComponent): ParagraphChild {
  return c as unknown as ParagraphChild
}

// ─── LaTeX 公式 → OMML ──────────────────────────────────────────────────────
//
// 方案注册表见 src/main/formula（内置 Temml：LaTeX → MathML → OMML）。
// 行内公式 m:oMath 直接进入段落 run 流；块级公式包 m:oMathPara（Word
// 「显示公式」形态）。mml2omml 输出的 m:oMath 自带 xmlns:m 声明，
// oMathPara 外层自行补一份（XML 重复声明合法），保证独立解析也成立。
// 转换失败降级为斜体等宽 LaTeX 原文，导出不因公式失败而中断。

const OMML_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

function formulaChildren(latex: string, displayMode: boolean, formula: FormulaConverter | null): ParagraphChild[] {
  const source = latex.trim()
  if (!source) return []
  const omml = formula?.latexToOmml(source, { displayMode })
  if (!omml) return [new TextRun({ text: source, font: 'Menlo', italics: true })]
  const xml = displayMode
    ? `<m:oMathPara xmlns:m="${OMML_NS}">${omml}</m:oMathPara>`
    : omml
  return [asParagraphChild(fromXml(xml))]
}

/**
 * 解析原始 OOXML 片段为 docx 组件。
 * fromXmlString 返回的根包装对象 rootKey 为 undefined（序列化会输出
 * <undefined> 标签损坏文档），真正的组件位于 .root[0]，此处摘出。
 */
function fromXml(xml: string): ImportedXmlComponent {
  const wrapper = ImportedXmlComponent.fromXmlString(xml) as unknown as { root?: Array<{ rootKey?: string }> }
  const inner = wrapper.root?.[0]
  if (!inner || typeof inner.rootKey !== 'string') {
    throw new Error(`docx-export: 非法 OOXML 片段: ${xml.slice(0, 80)}`)
  }
  return inner as unknown as ImportedXmlComponent
}

// ─── 规约E：带圈数字（1–50 之外退化为括号上标） ─────────────────────────────

function circledDigit(numStr: string): string | null {
  const n = Number(numStr)
  if (!Number.isInteger(n) || n < 1 || n > 50) return null
  if (n <= 20) return String.fromCodePoint(0x2460 + n - 1) // ①…⑳
  if (n <= 35) return String.fromCodePoint(0x3251 + n - 21) // ㉑…㉟
  return String.fromCodePoint(0x32b1 + n - 36) // ㊱…㊿
}

// ─── 规约G：田字格 Run 序列 ──────────────────────────────────────────────────
//
// 每格 = 一个带虚线字符边框的 Run（汉字或全角空格底座）；
// 拼音格 = w:ruby（拼音在上，全角空格底座带边框）。
// 相邻同边框 Run 会被 Word 合并成一个大框，格子之间插入细空格 Run 断开，
// 与编辑器渲染的格间距对应。

function tianziRuns(raw: string, style: RunStyle): ParagraphChild[] {
  const model = parseCells(raw)
  // 数据异常（理论上 remark 已过滤）时降级为字面文本
  if (!model) return [new TextRun({ text: `++${raw}++`, ...runOptions(style) })]
  const runs: ParagraphChild[] = []
  for (const cell of model.cells) {
    if (runs.length > 0) runs.push(new TextRun({ text: '\u2009' }))
    if (cell.pinyin) {
      // 拼音格：拼音在上方，下方为带框全角空格
      runs.push(asParagraphChild(rubyRunXml('\u2003', cell.pinyin, style, { baseBorder: true })))
    } else if (cell.char) {
      // 有字格：边框内直接放汉字
      runs.push(asParagraphChild(fromXml(
        '<w:r>' + rprXml(style, { border: true }) + `<w:t xml:space="preserve">${xmlEscape(cell.char)}</w:t></w:r>`
      )))
    } else {
      // 空白格：带框全角空格
      runs.push(asParagraphChild(fromXml(
        '<w:r>' + rprXml(style, { border: true }) + '<w:t xml:space="preserve">\u2003</w:t></w:r>'
      )))
    }
  }
  return runs
}

// ─── 行内扩展节点 ───────────────────────────────────────────────────────────

/** 规约B2：同行平级拼音 —— 汉字 Run + 灰色 85% 小号拼音 Run（对应编辑器 CSS） */
function pinyinInlineRuns(node: MarkdownNode, style: RunStyle): ParagraphChild[] {
  const runs: ParagraphChild[] = [new TextRun({ text: node.text ?? '', ...runOptions(style) })]
  const baseHalf = ptToHalfPoints(style.fontSize)
  const pyHalf = baseHalf ? Math.max(10, Math.round(baseHalf * 0.85)) : 18 // 无块级字号时按 9pt
  const pyOpts: Record<string, unknown> = {}
  if (style.bold) pyOpts.bold = true
  if (style.family) pyOpts.font = style.family
  runs.push(new TextRun({ text: convertPinyin(node.pinyin ?? ''), color: '666666', size: pyHalf, ...pyOpts }))
  return runs
}

/** 把 RunStyle 展开成 docx TextRun 选项 */
function runOptions(style: RunStyle): Record<string, unknown> {
  const opts: Record<string, unknown> = {}
  if (style.bold) opts.bold = true
  if (style.italics) opts.italics = true
  if (style.strike) opts.strike = true
  if (style.underline) opts.underline = { type: 'single' as const }
  if (style.highlight) opts.highlight = 'yellow'
  if (style.emphDot) opts.emphasisMark = { type: EmphasisMarkType.DOT }
  if (style.family) opts.font = style.family
  const half = ptToHalfPoints(style.fontSize)
  if (half) opts.size = half
  return opts
}

// ─── 图片（规约D + 标准图片） ────────────────────────────────────────────────

const MAX_IMAGE_WIDTH = 560
const MAX_IMAGE_HEIGHT = 420

function imagePath(url: string, sourcePath: string | null): string | null {
  if (/^(https?:|data:|blob:)/i.test(url)) return null
  try {
    if (url.startsWith('file:')) return fileURLToPath(url)
  } catch {
    return null
  }
  if (!sourcePath) return null
  return isAbsolute(url) ? url : resolve(dirname(sourcePath), decodeURIComponent(url))
}

/** 由扩展名/data URL MIME 推断 docx ImageRun 的 type */
function imageRunType(src: string): 'png' | 'jpg' | 'gif' | 'bmp' | null {
  const ext = extname(src).toLowerCase()
  if (ext === '.png') return 'png'
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg'
  if (ext === '.gif') return 'gif'
  if (ext === '.bmp') return 'bmp'
  const m = /^data:image\/(png|jpe?g|gif|bmp)[;,]/i.exec(src)
  if (m) return m[1].startsWith('jpeg') ? 'jpg' : (m[1] as 'png' | 'jpg' | 'gif' | 'bmp')
  return null
}

/**
 * 加载图片为 ImageRun 数据。data: URL（粘贴产生）与本地路径均支持；
 * 纯 Node/无 electron nativeImage 的环境下优雅降级返回 null（导出占位文本）。
 */
function loadImageData(url: string): { data: Buffer; type: 'png' | 'jpg' | 'gif' | 'bmp'; natural: { width: number; height: number } } | null {
  const type = imageRunType(url)
  if (!type) return null
  // 纯 Node 环境（如离线测试）下 electron 模块仅返回路径字符串，无 nativeImage
  if (!nativeImage || typeof nativeImage.createFromPath !== 'function') return null
  const image = /^data:/i.test(url)
    ? nativeImage.createFromDataURL(url)
    : nativeImage.createFromPath(url.startsWith('file:') ? (() => { try { return fileURLToPath(url) } catch { return null } })() ?? url : url)
  if (image.isEmpty()) return null
  return { data: image.toPNG(), type, natural: image.getSize() }
}

/** 按规约D参数计算像素尺寸（无参数时按原始尺寸等比缩放进页面安全区） */
function imagePixelSize(natural: { width: number; height: number }, params: ImageParams): { width: number; height: number } {
  let width: number | undefined
  let height: number | undefined
  const px = (v?: string) => {
    const m = /^(\d+(?:\.\d+)?)px$/.exec(v ?? '')
    return m ? Number(m[1]) : undefined
  }
  const pct = (v?: string) => {
    const m = /^(\d+(?:\.\d+)?)%$/.exec(v ?? '')
    return m ? (Number(m[1]) / 100) * MAX_IMAGE_WIDTH : undefined
  }
  width = px(params.width) ?? pct(params.width)
  height = px(params.height) ?? pct(params.height)
  if (!width && !height) {
    const scale = Math.min(1, MAX_IMAGE_WIDTH / natural.width, MAX_IMAGE_HEIGHT / natural.height)
    return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) }
  }
  // 只给一维时按原始比例推另一维
  if (width && !height) height = width * (natural.height / natural.width)
  if (height && !width) width = height * (natural.width / natural.height)
  // 超出安全区时整体等比缩小
  const scale = Math.min(1, MAX_IMAGE_WIDTH / width!, MAX_IMAGE_HEIGHT / height!)
  return { width: Math.max(1, Math.round(width! * scale)), height: Math.max(1, Math.round(height! * scale)) }
}

/**
 * 构建图片 Run；无法加载时返回 null（调用方降级为占位文本）。
 * 规约D的 border/shadow/radius 修饰符为纯视觉装饰，docx 阶段不呈现。
 */
function imageRunOf(node: MarkdownNode, sourcePath: string | null): { run: ImageRun; params: ImageParams } | null {
  const { params } = parseImageAlt(node.alt ?? '')
  const url = node.url ?? ''
  // data:/http(s)/blob 直接使用；其余按源文件目录解析为绝对路径
  const resolved = /^(data:|https?:|blob:)/i.test(url) ? url : imagePath(url, sourcePath)
  if (!resolved) return null
  const loaded = loadImageData(resolved)
  if (!loaded) return null
  const size = imagePixelSize(loaded.natural, params)
  const run = new ImageRun({ type: loaded.type, data: loaded.data, transformation: size })
  return { run, params }
}

function imageAlignment(params: ImageParams): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  if (!params.align) return undefined
  if (params.align === 'center') return AlignmentType.CENTER
  if (params.align === 'right') return AlignmentType.RIGHT
  if (params.align === 'left' || params.align === 'float-left') return AlignmentType.LEFT
  if (params.align === 'float-right') return AlignmentType.RIGHT
  return undefined
}

/** 独立成段的图片段落（含规约D尺寸/对齐参数） */
function imageParagraph(node: MarkdownNode, sourcePath: string | null): Paragraph {
  const loaded = imageRunOf(node, sourcePath)
  if (!loaded) {
    const { alt } = parseImageAlt(node.alt ?? '')
    return new Paragraph({ children: [new TextRun({ text: alt ? `[${alt}]` : '[image]', italics: true })] })
  }
  return new Paragraph({
    alignment: imageAlignment(loaded.params),
    children: [loaded.run],
  })
}

// ─── 行内节点 → Run 序列 ────────────────────────────────────────────────────

function inlineRuns(nodes: MarkdownNode[] | undefined, style: RunStyle = {}, sourcePath: string | null = null, formula: FormulaConverter | null = null): ParagraphChild[] {
  if (!nodes) return []
  const runs: ParagraphChild[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        runs.push(new TextRun({ text: node.value ?? '', ...runOptions(style) }))
        break
      case 'break':
        runs.push(new TextRun({ break: 1, ...runOptions(style) }))
        break
      case 'inlineMath':
        // 行内公式 $...$ → OMML（方案见 src/main/formula）
        runs.push(...formulaChildren(node.value ?? '', false, formula))
        break
      case 'inlineCode':
        runs.push(new TextRun({ text: node.value ?? '', font: 'Menlo', shading: { fill: 'F1F3F5' } }))
        break
      case 'strong':
        runs.push(...inlineRuns(node.children, { ...style, bold: true }, sourcePath, formula))
        break
      case 'emphasis':
        runs.push(...inlineRuns(node.children, { ...style, italics: true }, sourcePath, formula))
        break
      case 'delete':
        runs.push(...inlineRuns(node.children, { ...style, strike: true }, sourcePath, formula))
        break
      case 'mark': // ==高亮==（与编辑器 highlight 扩展一致）
        runs.push(...inlineRuns(node.children, { ...style, highlight: true }, sourcePath, formula))
        break
      case 'link':
        if (node.url) runs.push(new ExternalHyperlink({ link: node.url, children: inlineRuns(node.children, style, sourcePath, formula) }))
        break
      case 'image': {
        // 行内图片：能加载则内嵌 Run，否则占位文本
        const loaded = imageRunOf(node, sourcePath)
        if (loaded) {
          runs.push(loaded.run)
        } else {
          const { alt } = parseImageAlt(node.alt ?? '')
          runs.push(new TextRun({ text: alt ? `[${alt}]` : '[image]', italics: true }))
        }
        break
      }
      case 'blankLine':
        // 规约C：行内填空线 → N 个全角空格 + 下划线/无下划线
        runs.push(...blankLineToDocxRuns({ chars: node.chars, blank: node.blank }))
        break
      case 'emphDot':
        // 规约A：字下着重号
        runs.push(...inlineRuns(node.children, { ...style, emphDot: true }, sourcePath, formula))
        break
      case 'pinyinRuby':
        // 规约B：拼音在汉字上方（OOXML ruby）
        runs.push(asParagraphChild(rubyRunXml(node.text ?? '', convertPinyin(node.pinyin ?? ''), style)))
        break
      case 'pinyinInline':
        // 规约B2：拼音与汉字同行并列
        runs.push(...pinyinInlineRuns(node, style))
        break
      case 'circledSup': {
        // 规约E：汉字 + 上标带圈数字
        const { char, num } = node
        const s = runOptions(style)
        runs.push(new TextRun({ text: char ?? '', ...s }))
        const circled = num ? circledDigit(num) : null
        runs.push(
          circled
            ? new TextRun({ text: circled, superScript: true, ...s })
            : new TextRun({ text: `(${num ?? ''})`, superScript: true, ...s }),
        )
        break
      }
      case 'tianziGrid':
        // 规约G：田字格
        runs.push(...tianziRuns(node.raw ?? '', style))
        break
      case 'fontSpan':
        // 规约H 行内：字体/字号覆盖（align 对行内无效，由块级生效）
        runs.push(...inlineRuns(node.children, {
          ...style,
          family: node.family ?? style.family,
          fontSize: node.size ?? style.fontSize,
        }, sourcePath, formula))
        break
      case 'html': {
        // 内联 HTML：仅识别 <u>/</u>（遗留文档下划线），其余内联标记丢弃但保留后续文本。
        // 切换当前样式（在循环内原地生效，</u> 时复位）
        const v = (node.value ?? '').trim().toLowerCase()
        if (v === '<u>') style.underline = true
        else if (v === '</u>') style.underline = false
        break
      }
      default:
        runs.push(...inlineRuns(node.children, style, sourcePath, formula))
        break
    }
  }
  return runs
}

// ─── 块级节点 → 段落/表格 ───────────────────────────────────────────────────

// 表格边框集：子块带框（浅灰，与编辑器 #d8d8d8 一致）与无框
const BOX_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
}
const NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
}

/** 规约F：分栏 spec → 百分比列宽（'2' → [50,50]；'1:2' → [33.33,66.67]） */
function colWidthsPct(spec: string): number[] | null {
  const round = (n: number): number => Math.round(n * 100) / 100
  if (/^\d+$/.test(spec)) {
    const n = Math.max(1, Number(spec))
    return Array.from({ length: n }, () => round(100 / n))
  }
  if (/^\d+:\d+$/.test(spec)) {
    const [a, b] = spec.split(':').map(Number)
    const total = a + b
    if (total <= 0) return null
    return [round((a / total) * 100), round((b / total) * 100)]
  }
  return null
}

/** 子块 → 单元格内容（应用子块对齐；空内容注入空段落） */
function subBlockCellChildren(node: MarkdownNode, sourcePath: string | null, ctx: BlockStyle, formula: FormulaConverter | null = null): Paragraph[] {
  const subCtx: BlockStyle = { ...ctx, align: node.align ?? ctx.align }
  const blocks = blockNodes(node.children, sourcePath, 0, subCtx, formula)
  return blocks.length > 0 ? (blocks as Paragraph[]) : [new Paragraph({})]
}

/** 规约F：分栏 → Table（每列一个子块；子块 boxed 决定该单元格边框） */
function colsTable(node: MarkdownNode, sourcePath: string | null, ctx: BlockStyle, formula: FormulaConverter | null = null): Table {
  const widths = colWidthsPct(node.spec ?? '2') ?? [100]
  const subs = node.children ?? []
  const cells = widths.map((pct, i) => {
    const sub = subs[i]
    if (!sub) return new TableCell({ width: { size: pct, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, children: [new Paragraph({})] })
    return new TableCell({
      width: { size: pct, type: WidthType.PERCENTAGE },
      borders: sub.boxed ? BOX_BORDERS : NO_BORDERS,
      verticalAlign: VerticalAlign.TOP,
      children: subBlockCellChildren(sub, sourcePath, ctx, formula),
    })
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [new TableRow({ children: cells })],
  })
}

/** 规约F：独立子块 → 带框单行表格（无框子块由 blockNodes 直接展开为段落） */
function subBlockTable(node: MarkdownNode, sourcePath: string | null, ctx: BlockStyle, formula: FormulaConverter | null = null): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: BOX_BORDERS,
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: BOX_BORDERS,
        children: subBlockCellChildren(node, sourcePath, ctx, formula),
      })],
    })],
  })
}

function blockNodes(
  nodes: MarkdownNode[] | undefined,
  sourcePath: string | null,
  listDepth = 0,
  ctx: BlockStyle = {},
  formula: FormulaConverter | null = null,
): Array<Paragraph | Table> {
  if (!nodes) return []
  const output: Array<Paragraph | Table> = []
  for (const node of nodes) {
    if (node.type === 'fontBlock') {
      // 规约H 块级容器：属性并入上下文，子树继承（内层覆盖同名属性）
      output.push(...blockNodes(node.children, sourcePath, listDepth, {
        family: node.family ?? ctx.family,
        size: node.size ?? ctx.size,
        align: node.align ?? ctx.align,
      }, formula))
    } else if (node.type === 'subBlock') {
      // 规约F 子块：boxed → 单元格表格；无框 → 内容直接展开（对齐生效）
      if (node.boxed) {
        output.push(subBlockTable(node, sourcePath, ctx, formula))
      } else {
        output.push(...blockNodes(node.children, sourcePath, listDepth, { ...ctx, align: node.align ?? ctx.align }, formula))
      }
    } else if (node.type === 'cols') {
      output.push(colsTable(node, sourcePath, ctx, formula))
    } else if (node.type === 'math') {
      // 块级公式 $$...$$ → 独立段落（m:oMathPara），默认居中（Word 显示公式惯例）
      output.push(new Paragraph({
        alignment: alignmentOf(ctx.align) ?? AlignmentType.CENTER,
        children: formulaChildren(node.value ?? '', true, formula),
        spacing: { before: 120, after: 120 },
      }))
    } else if (node.type === 'heading') {
      output.push(new Paragraph({ heading: headingForDepth(node.depth ?? 1), alignment: alignmentOf(ctx.align), children: inlineRuns(node.children, { family: ctx.family, fontSize: ctx.size }, sourcePath, formula) }))
    } else if (node.type === 'paragraph') {
      const image = node.children?.length === 1 && node.children[0]?.type === 'image' ? node.children[0] : null
      const style: RunStyle = { family: ctx.family, fontSize: ctx.size }
      output.push(image
        ? imageParagraph(image, sourcePath)
        : new Paragraph({ alignment: alignmentOf(ctx.align), children: inlineRuns(node.children, style, sourcePath, formula), spacing: { after: 120 } }))
    } else if (node.type === 'image') {
      output.push(imageParagraph(node, sourcePath))
    } else if (node.type === 'blockquote') {
      output.push(new Paragraph({
        children: [new TextRun({ text: textContent(node), italics: true, ...runOptions({ family: ctx.family, fontSize: ctx.size }) })],
        alignment: alignmentOf(ctx.align),
        indent: { left: 720 },
        border: { left: { color: 'AEB7C2', space: 8, style: 'single', size: 12 } },
      }))
    } else if (node.type === 'code') {
      output.push(new Paragraph({
        children: [new TextRun({ text: node.value ?? '', font: 'Menlo', size: 18 })],
        shading: { fill: 'F1F3F5' },
        alignment: alignmentOf(ctx.align),
        spacing: { before: 120, after: 120 },
      }))
    } else if (node.type === 'list') {
      const start = node.start ?? 1
      for (const [index, item] of (node.children ?? []).entries()) {
        const first = item.children?.find((child) => child.type === 'paragraph')
        const prefix = node.ordered ? `${start + index}. ` : '• '
        output.push(new Paragraph({
          children: [new TextRun({ text: prefix, ...runOptions({ family: ctx.family, fontSize: ctx.size }) }), ...inlineRuns(first?.children, { family: ctx.family, fontSize: ctx.size }, sourcePath, formula)],
          alignment: alignmentOf(ctx.align),
          indent: { left: 360 + listDepth * 360, hanging: 240 },
          spacing: { after: 60 },
        }))
        output.push(...blockNodes(item.children?.filter((child) => child !== first), sourcePath, listDepth + 1, ctx, formula))
      }
    } else if (node.type === 'table') {
      output.push(tableForNode(node, ctx, formula))
    } else if (node.type === 'thematicBreak') {
      output.push(new Paragraph({ border: { bottom: { color: 'AEB7C2', space: 1, style: 'single', size: 6 } } }))
    } else if (node.type === 'html') {
      output.push(new Paragraph({ children: [new TextRun({ text: node.value ?? '' })] }))
    } else if (node.type === 'footnoteDefinition') {
      output.push(new Paragraph({ children: [new TextRun({ text: textContent(node), size: 18, color: '667085' })] }))
    } else {
      output.push(...blockNodes(node.children, sourcePath, listDepth, ctx, formula))
    }
  }
  return output
}

function tableForNode(node: MarkdownNode, ctx: BlockStyle, formula: FormulaConverter | null = null): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: (node.children ?? []).map((row) => new TableRow({
      children: (row.children ?? []).map((cell) => new TableCell({
        children: [new Paragraph({ alignment: alignmentOf(ctx.align), children: inlineRuns(cell.children, { family: ctx.family, fontSize: ctx.size }, null, formula) })],
      })),
    })),
  })
}

// ─── ==高亮== 轻量 remark 插件（避免把 @milkdown/kit 引入主进程） ─────────────
// 与 src/renderer/editor/highlight.ts 的正则保持一致：==text== → mark 节点

function remarkHighlightLite() {
  return (tree: any): void => {
    const visitText = (node: any): void => {
      if (!node || !Array.isArray(node.children)) return
      node.children = node.children.flatMap((child: any) => {
        if (child.type !== 'text' || typeof child.value !== 'string' || !child.value.includes('==')) return [child]
        const parts: any[] = []
        let last = 0
        const re = /==([^=\n]+)==/g
        let m: RegExpExecArray | null
        while ((m = re.exec(child.value)) !== null) {
          if (m.index > last) parts.push({ type: 'text', value: child.value.slice(last, m.index) })
          parts.push({ type: 'mark', children: [{ type: 'text', value: m[1] }] })
          last = m.index + m[0].length
        }
        if (last < child.value.length) parts.push({ type: 'text', value: child.value.slice(last) })
        return parts.length > 0 ? parts : [child]
      })
      for (const child of node.children) visitText(child)
    }
    visitText(tree)
  }
}

// ─── 入口 ───────────────────────────────────────────────────────────────────

function buildProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    // 公式（remark-math 是 micromark 解析扩展，$...$ / $$...$$ → inlineMath/math）
    .use(remarkMath)
    // 以下插件的注册顺序与 renderer 编辑器管线一致，保证两端解析结果相同
    .use(remarkColumns)
    .use(remarkFontBlock)
    .use(remarkResidualEmphasis)
    .use(remarkEmphDot)
    .use(remarkFontSpan)
    .use(remarkBreaks)
    .use(remarkHighlightLite)
    .use(remarkBlankLine)
    .use(remarkPinyinRuby)
    .use(remarkPinyinInline)
    .use(remarkCircledSup)
    .use(remarkTianziGrid)
    // 公式误判防护放链尾（镜像编辑器：在 remarkMath 产出的 inlineMath 节点上回退误判项）
    .use(remarkMathFalsePositiveGuard)
}

export async function markdownToDocx(input: DocxExportInput): Promise<Buffer> {
  const processor = buildProcessor()
  const file = new VFile({ value: input.content })
  // runSync 执行全部 transformer 插件；仅 parse 不会运行任何自定义扩展
  const tree = processor.runSync(processor.parse(input.content), file) as unknown as MarkdownNode
  // 公式转换方案：按 id 选取（未来设置面板），缺省用注册表默认（Temml）
  const formula = getFormulaConverter(input.formulaConverter)
  const document = new Document({
    creator: 'Teyoo',
    title: input.sourcePath ? basename(input.sourcePath, extname(input.sourcePath)) : 'Untitled',
    sections: [{ children: blockNodes(tree.children, input.sourcePath, 0, {}, formula) }],
  })
  return Packer.toBuffer(document)
}
