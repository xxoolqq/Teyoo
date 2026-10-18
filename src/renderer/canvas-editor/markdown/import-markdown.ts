// ─── Markdown → 画布元素 ──────────────────────────────────────────────────
// 与 export-markdown.ts 配套：自己实现的一份，替代官方的
// @hufe921/canvas-editor-plugin-markdown（它导出漏了 LaTeX；导入用的 marked 又
// 不认 $$，公式往返会降解）。
// 流程：remark 解析出 mdast，按节点类型铺成 canvas 的元素序列。

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import type { List, PhrasingContent, Root, RootContent, Table } from 'mdast'
import { ElementType, ListStyle, ListType, TitleLevel } from '@hufe921/canvas-editor'
import type { IElement } from '@hufe921/canvas-editor'
// math-guard（货币误判守卫）已停用，与下方 processor 的注释保持一致
// import { remarkMathFalsePositiveGuard } from '../../editor/math-guard'
import { parseImageAlt, type ImageParams } from '../../../extensions/image-style/lib'

/** 零宽空格：canvas 里用它表示软换行（Shift+Enter） */
const ZERO = '\u200b'

/** 图片元素 → alt 里的尺寸参数（#100% / #320px），只在本模块内部传递 */
const IMAGE_PARAMS = new WeakMap<IElement, ImageParams>()

/** 图片加载不出来时的兜底尺寸：至少能画出那个加载失败的占位块 */
const FALLBACK_SIZE = { width: 200, height: 150 }

/** 单张图片的测量超时：外链挂住不能把整个导入拖死 */
const MEASURE_TIMEOUT = 10_000

const TITLE_LEVEL: TitleLevel[] = [
  TitleLevel.FIRST,
  TitleLevel.SECOND,
  TitleLevel.THIRD,
  TitleLevel.FOURTH,
  TitleLevel.FIFTH,
  TitleLevel.SIXTH
]

/** remark-math 的节点不在 mdast 标准类型里，自己补上以便判别联合 */
interface MathNode {
  type: 'math' | 'inlineMath'
  value: string
}

type BlockNode = RootContent | MathNode
type InlineNode = PhrasingContent | MathNode

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkBreaks)
  // 货币误判守卫（math-guard.ts）已按需求停用：$…$ 一律交给 remark-math 当公式
  // 解析（与主编辑器 editor.ts 保持一致）。恢复防误判时取消下一行注释即可。
  // .use(remarkMathFalsePositiveGuard)

export function markdownToElements(markdown: string): IElement[] {
  const tree = processor.runSync(processor.parse(markdown)) as Root
  return toBlocks(tree.children as BlockNode[])
}

// ─── 图片尺寸 ──────────────────────────────────────────────────────────────
//
// 图片必须自带宽高：canvas 排版行高时直接算 `element.width * scale`，绘制也用
// 这两个数 —— 没有就是 NaN，drawImage 收到 NaN 宽高会静默不画，看上去就是
// 「导进来了但图片不见了」（公式没有这个问题，排版时 canvas 会给它补上尺寸）。
// Markdown 里不写尺寸，只能加载一次图片量出原始宽高，所以这一步是异步的。

/** 递归收集图片元素：正文、标题/列表里的行内、表格单元格都要 */
function collectImages(elements: IElement[], out: IElement[]): void {
  for (const element of elements) {
    if (element.type === ElementType.IMAGE) out.push(element)
    if (element.valueList?.length) collectImages(element.valueList, out)
    if (element.trList) {
      for (const row of element.trList) {
        for (const cell of row.tdList) collectImages(cell.value ?? [], out)
      }
    }
  }
}

function measureImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    const image = new Image()
    const settle = (result: { width: number; height: number } | null) => resolve(result)
    const timer = window.setTimeout(() => settle(null), MEASURE_TIMEOUT)
    image.onload = () => {
      window.clearTimeout(timer)
      settle({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      window.clearTimeout(timer)
      settle(null)
    }
    image.src = url
  })
}

/**
 * 给没有宽高的图片元素量出宽高（就地修改）。
 *
 * @param innerWidth 正文可用宽度，用于换算 alt 里的百分比宽度
 */
export async function fillImageSizes(elements: IElement[], innerWidth: number): Promise<void> {
  const images: IElement[] = []
  collectImages(elements, images)
  const targets = images.filter(image => !image.width || !image.height)
  await Promise.all(
    targets.map(async image => {
      const natural = await measureImage(image.value)
      if (!natural || !natural.width || !natural.height) {
        Object.assign(image, FALLBACK_SIZE)
        return
      }
      const [width, height] = applySizeParam(image, natural, innerWidth)
      image.width = width
      image.height = height
    })
  )
}

/** alt 里的尺寸参数优先；只认宽度，高度按原比例走（避免拉伸变形） */
function applySizeParam(
  image: IElement,
  natural: { width: number; height: number },
  innerWidth: number
): [number, number] {
  const param = IMAGE_PARAMS.get(image)?.width
  if (!param) return [natural.width, natural.height]
  if (param.endsWith('%')) {
    const width = Math.max(1, Math.round((innerWidth * Number.parseFloat(param)) / 100))
    return [width, Math.max(1, Math.round((natural.height * width) / natural.width))]
  }
  if (param.endsWith('px')) {
    const width = Number.parseFloat(param)
    return [width, Math.max(1, Math.round((natural.height * width) / natural.width))]
  }
  return [natural.width, natural.height]
}

// ─── 块级 ────────────────────────────────────────────────────────────────

/** 段落结束：canvas 用一个换行元素收尾 */
function paragraphEnd(): IElement {
  return { type: ElementType.TEXT, value: '\n' }
}

function toBlocks(nodes: BlockNode[]): IElement[] {
  const out: IElement[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        out.push(...toInline(node.children as InlineNode[]), paragraphEnd())
        break
      case 'heading': {
        const level = TITLE_LEVEL[node.depth - 1] ?? TitleLevel.FIRST
        out.push({
          type: ElementType.TITLE,
          value: '',
          level,
          valueList: toInline(node.children as InlineNode[])
        })
        out.push(paragraphEnd())
        break
      }
      case 'list':
        out.push(...toList(node, 0), paragraphEnd())
        break
      case 'blockquote':
        // 画布没有引用块，退化成普通段落
        out.push(...toBlocks(node.children as BlockNode[]))
        break
      case 'code':
        // 画布没有代码块，退化成纯文本（按用户约定，代码块不还原）
        out.push({ type: ElementType.TEXT, value: node.value }, paragraphEnd())
        break
      case 'math':
        out.push({ type: ElementType.LATEX, value: node.value }, paragraphEnd())
        break
      case 'thematicBreak':
        out.push({ type: ElementType.SEPARATOR, value: '\n' })
        break
      case 'table':
        out.push(toTable(node), paragraphEnd())
        break
      case 'html':
        // 裸 HTML 不做处理
        break
      default:
        break
    }
  }
  return out
}

function toList(node: List, level: number): IElement[] {
  const out: IElement[] = []
  const listType = node.ordered ? ListType.OL : ListType.UL
  for (const item of node.children) {
    const inline: IElement[] = []
    let nested: IElement[] = []
    for (const child of item.children) {
      if (child.type === 'paragraph') {
        inline.push(...toInline(child.children as InlineNode[]))
      } else if (child.type === 'list') {
        nested = toList(child, level + 1)
      } else {
        // 列表项里夹了别的块（引用、代码块）：退化成文本跟着本项
        inline.push(...toBlocks([child as BlockNode]))
      }
    }
    const checked = item.checked
    const isTask = typeof checked === 'boolean'
    out.push({
      type: ElementType.LIST,
      value: '',
      listType,
      listStyle: isTask
        ? ListStyle.CHECKBOX
        : listType === ListType.OL
          ? ListStyle.DECIMAL
          : ListStyle.DISC,
      listLevel: level,
      valueList: isTask
        ? [{ type: ElementType.CHECKBOX, value: '', checkbox: { value: checked } }, ...inline]
        : inline
    })
    out.push(...nested)
  }
  return out
}

function toTable(node: Table): IElement {
  return {
    type: ElementType.TABLE,
    value: '',
    trList: node.children.map(row => ({
      // 行高交给 canvas 重排，这里给个能落地的初始值
      height: 32,
      tdList: row.children.map(cell => ({
        colspan: 1,
        rowspan: 1,
        value: cell.children.length
          ? toInline(cell.children as InlineNode[])
          : [{ type: ElementType.TEXT, value: '' }]
      }))
    }))
  }
}

// ─── 行内 ────────────────────────────────────────────────────────────────

interface TextStyle {
  bold?: boolean
  italic?: boolean
  strikeout?: boolean
}

function toInline(nodes: InlineNode[], style: TextStyle = {}): IElement[] {
  const out: IElement[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ type: ElementType.TEXT, value: node.value, ...style })
        break
      case 'strong':
        out.push(...toInline(node.children as InlineNode[], { ...style, bold: true }))
        break
      case 'emphasis':
        out.push(...toInline(node.children as InlineNode[], { ...style, italic: true }))
        break
      case 'delete':
        out.push(...toInline(node.children as InlineNode[], { ...style, strikeout: true }))
        break
      case 'inlineCode':
        // 画布没有行内代码类型，退化成普通文本（保留等宽要改字体，先不做）
        out.push({ type: ElementType.TEXT, value: node.value, ...style })
        break
      case 'inlineMath':
        out.push({ type: ElementType.LATEX, value: node.value })
        break
      case 'link':
        out.push({
          type: ElementType.HYPERLINK,
          value: '',
          url: node.url,
          valueList: toInline(node.children as InlineNode[], style)
        })
        break
      case 'image': {
        // alt 里可能带 image-style 扩展的参数串（![描述#100%](url)），宽度在这里
        // 定不了（百分比要等知道正文宽度），先挂在元素上，fillImageSizes 里再算。
        const element: IElement = { type: ElementType.IMAGE, value: node.url }
        const { params } = parseImageAlt(node.alt ?? '')
        if (params.width || params.height) IMAGE_PARAMS.set(element, params)
        out.push(element)
        break
      }
      case 'break':
        out.push({ type: ElementType.TEXT, value: ZERO })
        break
      case 'html':
        out.push({ type: ElementType.TEXT, value: node.value, ...style })
        break
      default:
        // 脚注引用之类：画布没有对应类型，有文本就当文本落
        if ('children' in node) {
          out.push(...toInline(node.children as InlineNode[], style))
        } else if ('value' in node && typeof node.value === 'string') {
          out.push({ type: ElementType.TEXT, value: node.value, ...style })
        }
        break
    }
  }
  return out
}
