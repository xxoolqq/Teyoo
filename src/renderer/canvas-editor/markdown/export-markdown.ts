// ─── 画布元素 → Markdown ──────────────────────────────────────────────────
// 原先这活儿是官方插件 @hufe921/canvas-editor-plugin-markdown 干的，但它导出时
// 漏了 LaTeX 元素：顶层按类型分派，没有 LATEX 分支，公式落到 else 里把 value
// 裸拼出去，不带 $ 定界符 —— 画布里渲染得好好的公式，导出的 md 渲染不出来。
// 所以照它的思路自己写一份：顶层按元素类型分派，行内递归 valueList。

import { ElementType, ListType, TitleLevel } from '@hufe921/canvas-editor'
import type { IEditorResult, IElement } from '@hufe921/canvas-editor'

/** 零宽空格：canvas 用它表示软换行（Shift+Enter），导出时还原成真换行 */
const ZERO = '\u200b'

const TITLE_DEPTH: Partial<Record<TitleLevel, number>> = {
  [TitleLevel.FIRST]: 1,
  [TitleLevel.SECOND]: 2,
  [TitleLevel.THIRD]: 3,
  [TitleLevel.FOURTH]: 4,
  [TitleLevel.FIFTH]: 5,
  [TitleLevel.SIXTH]: 6
}

export function exportMarkdown(result: IEditorResult): string {
  return normalize(toBlocks(result.data.main ?? []))
}

/** 收尾：去掉行尾空白，连续空行压成一个，首尾不留空行 */
function normalize(text: string): string {
  return `${text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd()}\n`
}

/** 多行 / 环境类公式用块级 $$ 独占一段，其余走行内 $…$ */
function isBlockFormula(value: string): boolean {
  return value.includes('\\\\') || value.includes('\\begin') || value.includes('\n')
}

// ─── 块级 ────────────────────────────────────────────────────────────────

/** 自成一段的元素类型；其余（含没有 type 的裸文本）都按行内内容处理 */
const BLOCK_TYPES = new Set<ElementType>([
  ElementType.TABLE,
  ElementType.TITLE,
  ElementType.LIST,
  ElementType.SEPARATOR,
  ElementType.PAGE_BREAK,
  ElementType.IMAGE
])

function isBlockElement(el: IElement): boolean {
  return el.type !== undefined && BLOCK_TYPES.has(el.type)
}

function toBlocks(list: IElement[]): string {
  let out = ''
  let index = 0
  while (index < list.length) {
    const el = list[index]
    if (!isBlockElement(el)) {
      // 行内元素成段处理：一整段加粗在画布里是多个元素，逐个套会写成
      // **a** **b**，交给 toInlineList 整段合并才是 **a b**
      let end = index + 1
      while (end < list.length && !isBlockElement(list[end])) end++
      out += toInlineList(list.slice(index, end), true)
      index = end
      continue
    }
    switch (el.type) {
      case ElementType.TABLE:
        out += toTable(el)
        break
      case ElementType.TITLE: {
        const depth = TITLE_DEPTH[el.level ?? TitleLevel.FIRST] ?? 1
        out += `${'#'.repeat(depth)} ${toInlineList(el.valueList ?? [], false)}\n\n`
        break
      }
      case ElementType.LIST: {
        // 一项就是一个 LIST 元素，连续的凑成一段才能一起编号
        let end = index + 1
        while (end < list.length && list[end].type === ElementType.LIST) end++
        out += toList(list.slice(index, end))
        index = end
        continue
      }
      case ElementType.SEPARATOR:
        out += '\n---\n\n'
        break
      case ElementType.PAGE_BREAK:
        out += '\n<!-- page break -->\n\n'
        break
      case ElementType.IMAGE:
        // 图片单独占一段，否则后面的文字会被当成同一段
        out += `${toInline(el, false)}\n\n`
        break
    }
    index += 1
  }
  return out
}

/** 表格单元格：管道符会打断表格，换行在 Markdown 表格里也得换成 <br> */
function tableCell(list: IElement[]): string {
  return toInlineList(list, false).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function toTable(el: IElement): string {
  const rows = el.trList ?? []
  if (!rows.length) return ''
  let out = '\n'
  rows.forEach((tr, rowIndex) => {
    // colspan / rowspan 在 Markdown 表格里没法表达，合并的单元格退化成重复或
    // 留空 —— 这块不追求还原，先把结构保住
    const cells = tr.tdList.map(td => tableCell(td.value ?? []))
    out += `| ${cells.join(' | ')} |\n`
    if (rowIndex === 0) {
      out += `| ${cells.map(() => '---').join(' | ')} |\n`
    }
  })
  return `${out}\n`
}

function toList(items: IElement[]): string {
  let out = ''
  const counters: number[] = []
  items.forEach(item => {
    const level = item.listLevel ?? 0
    let marker = '- '
    if (item.listType === ListType.OL) {
      // 遇到更深/更浅的层级都要重新起数，所以先把计数器截到当前层
      counters.length = level + 1
      counters[level] = (counters[level] ?? 0) + 1
      marker = `${counters[level]}. `
    }
    out += `${'    '.repeat(level)}${marker}${toInlineList(item.valueList ?? [], false)}\n`
  })
  return `${out}\n`
}

// ─── 行内 ────────────────────────────────────────────────────────────────

/**
 * 行内样式签名。一整段加粗在画布里常常是多个相邻元素（夹在中间的代码、公式各
 * 占一个），逐个套 ** 会写成 `**a** **b**` —— 所以先按签名把相邻的同款元素合成
 * 一组，整组套一次。
 */
function styleKey(el: IElement): string {
  return [
    el.bold ? 'b' : '',
    el.italic ? 'i' : '',
    el.strikeout ? 's' : '',
    el.underline ? 'u' : '',
    el.highlight ? `h${el.highlight}` : ''
  ].join('')
}

/** 行内元素 → Markdown 片段（不产生块级空行，除非是块级公式） */
function toInline(el: IElement, allowBlock: boolean, skipStyle = false): string {
  switch (el.type) {
    case ElementType.LATEX: {
      const value = (el.value ?? '').trim()
      if (!value) return ''
      return isBlockFormula(value) && allowBlock
        ? `\n$$\n${value}\n$$\n\n`
        : `$${value}$`
    }
    case ElementType.IMAGE:
      return `![${el.imgCaption?.value ?? 'image'}](${el.value ?? ''})`
    case ElementType.HYPERLINK:
      return `[${toInlineList(el.valueList ?? [], false)}](${el.url ?? ''})`
    case ElementType.SUPERSCRIPT:
      return `<sup>${el.value ?? ''}</sup>`
    case ElementType.SUBSCRIPT:
      return `<sub>${el.value ?? ''}</sub>`
    case ElementType.CHECKBOX:
      // 任务列表的勾选框：Markdown 里是列表标记后的 [x]
      return el.checkbox?.value ? '[x] ' : '[ ] '
    case ElementType.DATE:
      return (el.valueList ?? []).map(item => item.value ?? '').join('')
    default: {
      // AREA / BLOCK 这类容器：内容在 valueList 里，value 只是占位符
      if (el.valueList?.length) return toInlineList(el.valueList, false)
      const value = (el.value ?? '').split(ZERO).join('\n')
      // 单独一个换行的元素是画布的段落结束标记；Markdown 的段落之间要空一行，
      // 只给一个 \n 的话两段会被渲染器并成一段
      if (value === '\n') return '\n\n'
      return skipStyle ? value : styled(value, el)
    }
  }
}

/**
 * 一串行内元素拼起来（控件、日期这类容器内容的通用做法）。
 * 相邻的同款样式合并成一组，由整组套格式（见 styleKey）。
 */
function toInlineList(list: IElement[], allowBlock: boolean): string {
  let out = ''
  let index = 0
  while (index < list.length) {
    const key = styleKey(list[index])
    let end = index + 1
    while (end < list.length && styleKey(list[end]) === key) end++
    // 组内元素不再各自定义样式，交给下面整组套一次
    const inner = list
      .slice(index, end)
      .map(el => toInline(el, allowBlock, true))
      .join('')
    // 同组样式一致，拿第一个元素当样本即可
    out += key ? styled(inner, list[index]) : inner
    index = end
  }
  return out
}

/** 加粗/斜体等样式套上去；前后空白留在外面，否则 `**文本 **` 标记会失效 */
function styled(text: string, el: IElement): string {
  if (!text) return ''
  const lead = /^\s*/.exec(text)?.[0] ?? ''
  const tail = /\s*$/.exec(text)?.[0] ?? ''
  const core = text.slice(lead.length, text.length - tail.length)
  if (!core) return text
  let out = core
  if (el.bold) out = `**${out}**`
  if (el.italic) out = `*${out}*`
  if (el.strikeout) out = `~~${out}~~`
  if (el.underline) out = `<u>${out}</u>`
  if (el.highlight) out = `==${out}==`
  return lead + out + tail
}
