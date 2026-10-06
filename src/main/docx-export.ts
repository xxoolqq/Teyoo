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
//   规约G tianziGrid   ++xx++     → DrawingML 行内形状格子（外框+十字虚线+内嵌文字）
//   规约H fontBlock    ::: font{…} → 段落对齐 + 字体字号（子树继承）
//   规约H fontSpan     {= …: …}   → Run 字体/字号覆盖
//   规约I htmlTable    <table>…    → Word 表格（MinerU 抽表格的原生形态，见下）
//   公式   $…$ / $$…$$ → OMML（LaTeX → MathML → OMML，方案注册表 src/main/formula）
//   高亮 ==text==      → TextRun highlight 黄色
//   内联 <u>…</u>      → 下划线 Run（遗留文档兼容）

import { nativeImage } from 'electron'
import { readFileSync } from 'node:fs'
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
  HeightRule,
  HorizontalPositionAlign,
  HorizontalPositionRelativeFrom,
  ImageRun,
  ImportedXmlComponent,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  TextWrappingSide,
  TextWrappingType,
  VerticalAlign,
  VerticalPositionRelativeFrom,
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
import { parseCells, type TianziCell } from '../extensions/tianzi-grid/lib'
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
// docx 库未提供 phonetic guide（w:ruby）等声明式 API，
// 通过 ImportedXmlComponent.fromXmlString 注入原始 OOXML。注意 w:rPr 子元素
// 顺序须符合 CT_RPr 序列：rFonts → color → sz → szCs。

/** 构造一个 Run 的 rPr 片段（保持 CT_RPr 元素顺序） */
function rprXml(style: RunStyle): string {
  const parts: string[] = []
  if (style.family) {
    parts.push(`<w:rFonts w:ascii="${xmlEscape(style.family)}" w:eastAsia="${xmlEscape(style.family)}" w:hAnsi="${xmlEscape(style.family)}"/>`)
  }
  const half = ptToHalfPoints(style.fontSize)
  if (half) {
    parts.push(`<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`)
  }
  return parts.length > 0 ? `<w:rPr>${parts.join('')}</w:rPr>` : ''
}

/**
 * 构造注音 Run（w:ruby）：rt 拼音显示在 base 基字上方。
 * 注音字号取基字的一半（与 Word 拼音指南默认行为一致）。
 */
function rubyRunXml(base: string, rt: string, style: RunStyle): ImportedXmlComponent {
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
    rprXml(style) +
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
// 方案注册表见 src/main/formula（默认 MathJax；另一方案是 Temml：
// LaTeX → MathML → OMML，设置面板里显示为 KaTeX）。
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

// ─── 规约G：田字格 Run 序列（DrawingML 行内形状） ────────────────────────────
//
// 旧方案（w:bdr 字符边框 + w:ruby 拼音）在 Word 中不可靠：纯空白字符不画
// 字符边框 → 空白格/拼音格整格消失。改为每格一个 wp:inline 行内形状组合
// （a:graphicData uri=wordprocessingGroup → wpg:wgp，Word 2010+ 格式）：
//   - 外框矩形：0.75pt 实线 #444444（对应编辑器 .tz-box border）
//   - 横/竖虚线：0.75pt 虚线 #D38B8B（对应 .tz-box::before/::after）
//   - 有字格：矩形内嵌文本（楷体 1.35em #111，anchor=ctr 水平垂直居中）
//   - 拼音格：顶部加拼音文本框（Segoe UI 0.62em #555，无边框无填充）
// 尺寸以正文字号为 em 基准（1pt 字号 = 1em），与编辑器 CSS 完全对应：
//   格边 2.2em；拼音行 1em + 0.3em 间距（所有格子上方都占位，格底对齐）。
// 相邻格共享边线（与编辑器 margin-left:-1px 边框折叠一致），格间不插空格。

const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup'
const NS_WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'

/** EMU（English Metric Unit）：1pt = 12700 EMU */
const EMU_PER_PT = 12700

/** wp:docPr 全文档唯一 id（须 ≥1 且不重复，Word 打开时校验） */
let tianziShapeIdCounter = 0

/** 形状描边 XML（CT_LineProperties：实色填充 → 虚线样式） */
function shapeStrokeXml(widthEmu: number, color: string, dashed: boolean): string {
  return (
    `<a:ln w="${widthEmu}">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    (dashed ? '<a:prstDash val="dash"/>' : '') +
    '</a:ln>'
  )
}

/** 田字格内嵌文本段落（w:txbxContent）：水平居中、无段距、行距单倍 */
function txbxParagraphXml(text: string, font: string, halfPt: number, color: string): string {
  return (
    '<w:p>' +
    '<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' +
    '<w:r>' +
    `<w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}"/>` +
    `<w:color w:val="${color}"/><w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/></w:rPr>` +
    `<w:t xml:space="preserve">${xmlEscape(text)}</w:t>` +
    '</w:r>' +
    '</w:p>'
  )
}

/** 单个 wps:wsp 子形状（矩形/直线，可选内嵌文本），坐标为组内子坐标系 */
function tianziShapeXml(opts: {
  x: number
  y: number
  cx: number
  cy: number
  /** a:prstGeom 预设：rect / line */
  preset: string
  stroke?: { width: number; color: string; dashed?: boolean }
  text?: { content: string; font: string; halfPt: number; color: string }
}): string {
  const parts: string[] = [
    `<wps:wsp xmlns:wps="${NS_WPS}">`,
    '<wps:cNvSpPr/>',
    '<wps:spPr>',
    `<a:xfrm><a:off x="${opts.x}" y="${opts.y}"/><a:ext cx="${opts.cx}" cy="${opts.cy}"/></a:xfrm>`,
    `<a:prstGeom prst="${opts.preset}"><a:avLst/></a:prstGeom>`,
    '<a:noFill/>',
    opts.stroke
      ? shapeStrokeXml(opts.stroke.width, opts.stroke.color, opts.stroke.dashed ?? false)
      : '<a:ln><a:noFill/></a:ln>',
    '</wps:spPr>',
  ]
  if (opts.text) {
    parts.push(
      '<wps:txbx><w:txbxContent>',
      txbxParagraphXml(opts.text.content, opts.text.font, opts.text.halfPt, opts.text.color),
      '</w:txbxContent></wps:txbx>',
    )
  }
  parts.push('<wps:bodyPr rot="0" anchor="ctr" lIns="0" tIns="0" rIns="0" bIns="0"/>', '</wps:wsp>')
  return parts.join('')
}

/**
 * 单个田字格的行内形状组合（外层 <w:r> XML，经 fromXml 注入）。
 * baseHalf：正文字号半点值（fontBlock/fontSpan 继承），无则按五号 10.5pt。
 */
function tianziCellXml(cell: TianziCell, baseHalf: number): string {
  const basePt = baseHalf / 2
  const side = Math.round(2.2 * basePt * EMU_PER_PT)
  // 拼音行 1em + 0.3em 间距：所有格子上方都留（编辑器 .tz-py 占位保底对齐）
  const pyRow = Math.round(1.3 * basePt * EMU_PER_PT)
  const height = pyRow + side
  const mid = Math.round(side / 2)
  tianziShapeIdCounter += 1

  const shapes =
    (cell.pinyin
      ? tianziShapeXml({
          x: 0,
          y: 0,
          cx: side,
          cy: Math.round(1.0 * basePt * EMU_PER_PT),
          preset: 'rect',
          text: {
            content: cell.pinyin,
            font: 'Segoe UI',
            halfPt: Math.max(10, Math.round(0.62 * baseHalf)),
            color: '555555',
          },
        })
      : '') +
    tianziShapeXml({
      x: 0,
      y: pyRow,
      cx: side,
      cy: side,
      preset: 'rect',
      stroke: { width: 9525, color: '444444' },
      ...(cell.char
        ? { text: { content: cell.char, font: 'KaiTi', halfPt: Math.round(1.35 * baseHalf), color: '111111' } }
        : {}),
    }) +
    tianziShapeXml({
      x: 0,
      y: pyRow + mid,
      cx: side,
      cy: 0,
      preset: 'line',
      stroke: { width: 9525, color: 'D38B8B', dashed: true },
    }) +
    tianziShapeXml({
      x: mid,
      y: pyRow,
      cx: 0,
      cy: side,
      preset: 'line',
      stroke: { width: 9525, color: 'D38B8B', dashed: true },
    })

  return (
    '<w:r><w:drawing>' +
    `<wp:inline xmlns:wp="${NS_WP}" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${side}" cy="${height}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${tianziShapeIdCounter}" name="田字格 ${tianziShapeIdCounter}"/>` +
    '<wp:cNvGraphicFramePr/>' +
    `<a:graphic xmlns:a="${NS_A}"><a:graphicData uri="${NS_WPG}">` +
    `<wpg:wgp xmlns:wpg="${NS_WPG}">` +
    '<wpg:cNvGrpSpPr/>' +
    '<wpg:grpSpPr>' +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${side}" cy="${height}"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="${side}" cy="${height}"/></a:xfrm>` +
    '</wpg:grpSpPr>' +
    shapes +
    '</wpg:wgp>' +
    '</a:graphicData></a:graphic>' +
    '</wp:inline>' +
    '</w:drawing></w:r>'
  )
}

function tianziRuns(raw: string, style: RunStyle): ParagraphChild[] {
  const model = parseCells(raw)
  // 数据异常（理论上 remark 已过滤）时降级为字面文本
  if (!model) return [new TextRun({ text: `++${raw}++`, ...runOptions(style) })]
  // em 基准：继承字号（fontBlock/fontSpan 可设），缺省按五号 10.5pt（21 半点）
  const baseHalf = ptToHalfPoints(style.fontSize) ?? 21
  return model.cells.map((cell) => asParagraphChild(fromXml(tianziCellXml(cell, baseHalf))))
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

type ImageType = 'png' | 'jpg' | 'gif' | 'bmp'

/**
 * 由文件头判断真实格式。扩展名和 data URL 里的 MIME 都不可信 —— MinerU 抽出的
 * 图常是 .jpg 的名字装着 PNG 数据（data URL 也就跟着写成 image/jpeg），按声明
 * 走会把 PNG 字节标成 jpg 塞进 docx，Word 打不开那张图。
 */
function sniffImageType(bytes: Buffer): ImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (bytes.length >= 6 && bytes.toString('latin1', 0, 3) === 'GIF') return 'gif'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  return null
}

/** PNG 的 IHDR 里自带宽高：拿不到 nativeImage（纯 Node）时仍能算出正确比例。 */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (sniffImageType(bytes) !== 'png' || bytes.length < 24) return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** 图片原始字节：data: URL 解 base64，其余按源文件目录解析成路径后读盘。 */
function imageBytes(url: string, sourcePath: string | null): Buffer | null {
  if (/^data:/i.test(url)) {
    const comma = url.indexOf(',')
    if (comma < 0 || !/;base64/i.test(url.slice(0, comma))) return null
    try {
      return Buffer.from(url.slice(comma + 1), 'base64')
    } catch {
      return null
    }
  }
  const path = imagePath(url, sourcePath)
  if (!path) return null
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

/** 原始尺寸；nativeImage 缺席时退到 PNG 头，再不行返回 null 由调用方兜底。 */
function imageNaturalSize(bytes: Buffer): { width: number; height: number } | null {
  try {
    const image = nativeImage?.createFromBuffer?.(bytes)
    if (image && !image.isEmpty()) {
      const size = image.getSize()
      if (size.width > 0 && size.height > 0) return size
    }
  } catch {
    // 纯 Node 环境（离线测试）没有 nativeImage：走下面的兜底
  }
  return pngSize(bytes)
}

/**
 * 加载图片 → ImageRun 数据。data: URL（内嵌）与本地路径均支持。
 * 关键是 type 与 data 必须一致：类型按文件头嗅探，data 用原始字节（不再统一
 * 转 PNG），否则 Word 会因为"声明 jpg、内容 PNG"而显示不出这张图。
 */
function loadImageData(
  url: string,
  sourcePath: string | null
): { data: Buffer; type: ImageType; natural: { width: number; height: number } } | null {
  const bytes = imageBytes(url, sourcePath)
  if (!bytes) return null
  const type = sniffImageType(bytes)
  if (!type) return null
  return { data: bytes, type, natural: imageNaturalSize(bytes) ?? { width: 800, height: 600 } }
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
 * float-left/float-right → wp:anchor 浮动定位（文字环绕）。
 */
function imageRunOf(node: MarkdownNode, sourcePath: string | null): { run: ImageRun; params: ImageParams } | null {
  const { params } = parseImageAlt(node.alt ?? '')
  const url = node.url ?? ''
  const loaded = loadImageData(url, sourcePath)
  if (!loaded) return null
  const size = imagePixelSize(loaded.natural, params)
  const isFloating = params.align === 'float-left' || params.align === 'float-right'
  const run = new ImageRun({
    type: loaded.type,
    data: loaded.data,
    transformation: size,
    ...(isFloating ? {
      floating: {
        horizontalPosition: {
          relative: HorizontalPositionRelativeFrom.COLUMN,
          align: params.align === 'float-right' ? HorizontalPositionAlign.RIGHT : HorizontalPositionAlign.LEFT,
        },
        verticalPosition: {
          relative: VerticalPositionRelativeFrom.PARAGRAPH,
          offset: 0,
        },
        allowOverlap: true,
        behindDocument: false,
        layoutInCell: true,
        wrap: {
          type: TextWrappingType.SQUARE,
          side: TextWrappingSide.BOTH_SIDES,
        },
      },
    } : {}),
  })
  return { run, params }
}

function imageAlignment(params: ImageParams): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  if (!params.align) return undefined
  if (params.align === 'center') return AlignmentType.CENTER
  if (params.align === 'right') return AlignmentType.RIGHT
  if (params.align === 'left') return AlignmentType.LEFT
  // float-left/float-right: 不设置段落对齐，由 ImageRun 的 floating 配置处理
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
        // 内联 HTML：识别 <br>（Typora 风格换行 → Word 真换行）与 <u>/</u>
        // （遗留文档下划线），其余内联标记丢弃但保留后续文本。
        const v = (node.value ?? '').trim()
        if (/^<br\s*\/?>$/i.test(v)) {
          runs.push(new TextRun({ break: 1, ...runOptions(style) }))
          break
        }
        // 切换当前样式（在循环内原地生效，</u> 时复位）
        const lv = v.toLowerCase()
        if (lv === '<u>') style.underline = true
        else if (lv === '</u>') style.underline = false
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
/**
 * 表格边框（Markdown 表格）：淡灰细线，与编辑器里的 #d8d8d8 同色。
 * 六个方向都画 —— 不给 borders 时 Word 是一张无框表，观感很糙。
 */
const TABLE_BORDERS = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'D8D8D8' },
}

/**
 * 表格行高：Word 默认单行约 240 twips（单倍行距），+50% → 360。
 * 用 ATLEAST（最小高度）而不是 EXACT —— 单元格内容更高（多行 / 大字 / 图片）时仍会自动撑开。
 */
const TABLE_ROW_TWIPS = 360

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
    rows: [new TableRow({ height: { value: TABLE_ROW_TWIPS, rule: HeightRule.ATLEAST }, children: cells })],
  })
}

/** 规约F：独立子块 → 带框单行表格（无框子块由 blockNodes 直接展开为段落） */
function subBlockTable(node: MarkdownNode, sourcePath: string | null, ctx: BlockStyle, formula: FormulaConverter | null = null): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: BOX_BORDERS,
    rows: [new TableRow({
      height: { value: TABLE_ROW_TWIPS, rule: HeightRule.ATLEAST },
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
      output.push(tableForNode(node, sourcePath, ctx, formula))
    } else if (node.type === 'thematicBreak') {
      output.push(new Paragraph({ border: { bottom: { color: 'AEB7C2', space: 1, style: 'single', size: 6 } } }))
    } else if (node.type === 'html') {
      // 块级 HTML：<br> 单独成行（Typora 常见）→ 空段落（换行语义），
      // 避免字面 "<br/>" 出现在 Word 正文；其余 HTML 块原样输出文本
      const v = (node.value ?? '').trim()
      if (/^<br\s*\/?>$/i.test(v)) {
        output.push(new Paragraph({ children: [] }))
      } else {
        output.push(new Paragraph({ children: [new TextRun({ text: node.value ?? '' })] }))
      }
    } else if (node.type === 'footnoteDefinition') {
      output.push(new Paragraph({ children: [new TextRun({ text: textContent(node), size: 18, color: '667085' })] }))
    } else {
      output.push(...blockNodes(node.children, sourcePath, listDepth, ctx, formula))
    }
  }
  return output
}

function tableForNode(node: MarkdownNode, sourcePath: string | null, ctx: BlockStyle, formula: FormulaConverter | null = null): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
    rows: (node.children ?? []).map((row) => new TableRow({
      height: { value: TABLE_ROW_TWIPS, rule: HeightRule.ATLEAST },
      children: (row.children ?? []).map((cell) => new TableCell({
        borders: TABLE_BORDERS,
        // 上下留 3pt 内边距，文字不再贴着线（左右沿用 Word 默认的 108 twips）
        margins: { top: 60, bottom: 60, left: 108, right: 108 },
        // sourcePath 必须传下去：单元格里的图片是相对路径（规约I 的 <img src="images/…">
        // 和 GFM 的 ![](…) 都是），传 null 的话 imagePath 解析不出文件，图上不去
        // 只剩 [image] 占位。
        children: [new Paragraph({ alignment: alignmentOf(ctx.align), children: inlineRuns(cell.children, { family: ctx.family, fontSize: ctx.size }, sourcePath, formula) })],
      })),
    })),
  })
}

// ─── 规约I：HTML 表格 → Word 表格 ───────────────────────────────────────────
//
// MinerU 抽出来的表格在 Markdown 里就是一整行 <table>…</table>（见
// renderer/layout2md.ts 的 tableHtmlToMarkdown：同一来源，那边转成 GFM 给编辑器）。
// remark 不加 rehype 时不会解释 HTML，整块原样收成 html 节点 —— 直接导出就会在
// Word 正文里看到一段字面的 "<table><tr>…"，表格和里头的图全没了。
//
// 这里在 transformer 链里把它换成 mdast table 节点，后面仍走 tableForNode
// （边框、行高、单元格内边距与 GFM 表格完全一致）。
//
// 降级策略与 layout2md 保持一致：colspan 按占位数补空单元格、rowspan 忽略。
// MinerU 的表大多不带合并，真带了的不会错位，只是把合并格摊平。

const HTML_ROW_RE = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi
const HTML_CELL_RE = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi
/** 单元格内的行内标记：<img> 要变成真图片，<br> 要变成真换行 */
const HTML_INLINE_TOKEN_RE = /<img\b[^>]*>|<br\s*\/?>/gi

/** 取标签里的属性值（属性值可带引号也可不带，与 layout2md 同款正则）。 */
function htmlAttr(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\s*=\\s*["']?([^"'\\s>]*)`, 'i'))
  return match ? match[1] : ''
}

/** 实体解码。&amp; 必须最后解，否则 &amp;lt; 会提前露出一个 < 出来。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/gi, '&')
}

/** HTML 片段 → 纯文本：标签剥掉、实体解码、空白压缩（<br>/<img> 已单独成节点）。 */
function htmlText(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/** 单元格内容 → 行内节点：<img> 成 image 节点（src 留给 imageRunOf 去解析路径）。 */
function htmlCellChildren(raw: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  HTML_INLINE_TOKEN_RE.lastIndex = 0
  while ((match = HTML_INLINE_TOKEN_RE.exec(raw)) !== null) {
    const text = htmlText(raw.slice(last, match.index))
    if (text) nodes.push({ type: 'text', value: text })
    const tag = match[0]
    if (/^<img/i.test(tag)) {
      const url = htmlAttr(tag, 'src')
      if (url) nodes.push({ type: 'image', url, alt: htmlAttr(tag, 'alt') })
    } else {
      nodes.push({ type: 'break' })
    }
    last = match.index + match[0].length
  }
  const tail = htmlText(raw.slice(last))
  if (tail) nodes.push({ type: 'text', value: tail })
  return nodes
}

interface HtmlCell {
  children: MarkdownNode[]
  colspan: number
}

function parseHtmlRow(rowHtml: string): HtmlCell[] {
  const cells: HtmlCell[] = []
  let match: RegExpExecArray | null
  HTML_CELL_RE.lastIndex = 0
  while ((match = HTML_CELL_RE.exec(rowHtml)) !== null) {
    const span = Number.parseInt(htmlAttr(match[2], 'colspan'), 10)
    cells.push({
      children: htmlCellChildren(match[3]),
      colspan: Number.isFinite(span) && span > 1 ? span : 1,
    })
  }
  return cells
}

/**
 * <table> HTML → mdast table 节点。解析不出任何一行/一格就返回 null，
 * 调用方保持原 html 节点（原来的降级行为），不吞内容。
 */
function htmlTableToMdast(value: string): MarkdownNode | null {
  const rowHtmls = value.match(HTML_ROW_RE)
  if (!rowHtmls?.length) return null
  const rows = rowHtmls.map(parseHtmlRow).filter((cells) => cells.length > 0)
  if (!rows.length) return null
  const columnCount = rows.reduce(
    (widest, cells) => Math.max(widest, cells.reduce((sum, cell) => sum + cell.colspan, 0)),
    0,
  )
  if (columnCount <= 0) return null

  const expand = (cells: HtmlCell[]): MarkdownNode[][] => {
    const out: MarkdownNode[][] = []
    for (const cell of cells) {
      // 空单元格也要占位（colspan 拆出来的留空格）
      out.push(cell.children.length > 0 ? cell.children : [{ type: 'text', value: '' }])
      for (let extra = 1; extra < cell.colspan; extra += 1) out.push([{ type: 'text', value: '' }])
    }
    while (out.length < columnCount) out.push([{ type: 'text', value: '' }])
    return out.slice(0, columnCount)
  }

  return {
    type: 'table',
    children: rows.map((cells) => ({
      type: 'tableRow',
      children: expand(cells).map((children) => ({ type: 'tableCell', children })),
    })),
  }
}

/** 规约I 插件：把 html 块节点里的 <table> 换成 mdast table（含嵌套容器）。 */
function remarkHtmlTable() {
  return (tree: any): void => {
    const walk = (parent: any): void => {
      if (!parent || !Array.isArray(parent.children)) return
      parent.children = parent.children.flatMap((child: any) => {
        if (child?.type !== 'html' || typeof child.value !== 'string') return [child]
        if (!/<table\b/i.test(child.value) || !/<\/table\s*>/i.test(child.value)) return [child]
        const table = htmlTableToMdast(child.value)
        return table ? [table] : [child]
      })
      for (const child of parent.children) walk(child)
    }
    walk(tree)
  }
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
    // 规约I：HTML 表格要先变成 table 节点，后面的插件（高亮/字体/拼音…）才认得它
    .use(remarkHtmlTable)
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
  // 公式转换方案：按 id 选取（'mathjax' / 'temml'），缺省用注册表默认（MathJax）
  const formula = getFormulaConverter(input.formulaConverter)
  const document = new Document({
    creator: 'Teyoo',
    title: input.sourcePath ? basename(input.sourcePath, extname(input.sourcePath)) : 'Untitled',
    // Word 内置「标题 N」样式的文字色是主题蓝灰（docx 库默认给的是 2E74B5 /
    // 1F4D78），看起来不像正文那种纯黑，这里统一压成黑。字号/粗体/段间距按库
    // 的默认值照写 —— 覆盖是整体替换 run，只给 color 会把这几个也一起抹掉。
    styles: {
      default: {
        heading1: { run: { size: 32, bold: true, color: '000000' } },
        heading2: { run: { size: 26, bold: true, color: '000000' } },
        heading3: { run: { size: 24, bold: true, color: '000000' } },
        heading4: { run: { size: 24, bold: true, italics: true, color: '000000' } },
        heading5: { run: { color: '000000' } },
        heading6: { run: { color: '000000' } },
      },
    },
    sections: [{ children: blockNodes(tree.children, input.sourcePath, 0, {}, formula) }],
  })
  return Packer.toBuffer(document)
}
