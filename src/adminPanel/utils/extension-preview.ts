// 渲染预览（导入中心审查卡）的完整扩展语法渲染器。
//
// 解析管线与「录入题目」编辑器 / Word 导出完全一致 —— 插件注册顺序镜像
// src/renderer/editor/editor.ts 的 remarkPluginsCtx（也即 main/docx-export.ts
// buildProcessor，唯一差异：不挂 remarkEscapedLiteral / 误判防护，与导出端同水位）：
//   remarkParse → remarkGfm → remarkMath → remarkColumns → remarkFontBlock →
//   remarkResidualEmphasis → remarkEmphDot → remarkUnderline → remarkFontSpan →
//   remarkBreaks → 高亮(轻量) → remarkBlankLine → remarkPinyinRuby →
//   remarkPinyinInline → remarkCircledSup → remarkSubSup → remarkTianziGrid
//
// 解析产物（mdast）由本文件的 walk 渲染成真实 DOM：
//   · 公式节点（inlineMath/math）→ 数学引擎（默认 MathJax，与编辑器同一 renderMath）
//   · 各扩展节点 → 与各扩展 schema.toDOM 相同的类名与结构，视觉样式直接复用
//     extensions/*/style.css（editor.ts 已全局引入，选择器不带 .ProseMirror 前缀）
//
// 整行 `---`（模型拆题的辅助记号）在解析前删除 —— 题面不该有分割线，这是拆题
// 阶段的既定规则（见 math-parse/parse.ts 的 stripDividerLines），渲染端兜底。

/* eslint-disable @typescript-eslint/no-explicit-any */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkBreaks from 'remark-breaks'
import { VFile } from 'vfile'

import { remarkColumns } from '../../extensions/columns/remark'
import { remarkFontBlock, remarkFontSpan } from '../../extensions/font-style/remark'
import {
  buildBlockStyle,
  buildInlineStyle,
  type FontAttrs,
} from '../../extensions/font-style/lib'
import { remarkResidualEmphasis } from '../../renderer/editor/residual-emphasis'
import { remarkEmphDot } from '../../extensions/emph-dot/remark'
import { remarkUnderline } from '../../extensions/underline/remark'
import { remarkBlankLine } from '../../extensions/blank-line/remark'
import { remarkPinyinRuby } from '../../extensions/pinyin-ruby/remark'
import { convertPinyin } from '../../extensions/pinyin-ruby/pinyin'
import { remarkPinyinInline } from '../../extensions/pinyin-inline/remark'
import { remarkCircledSup } from '../../extensions/circled-sup/remark'
import { remarkSubSup } from '../../extensions/sub-sup/remark'
import { remarkTianziGrid } from '../../extensions/tianzi-grid/remark'
import { parseCells } from '../../extensions/tianzi-grid/lib'
import { parseImageAlt } from '../../extensions/image-style/lib'
import { renderMath } from '../../renderer/math-engine'

// ─── 解析管线（单例；transformer 插件无状态，可复用） ────────────────────────

// spec → grid-template-columns（与 columns/schema.ts 的 gridTemplate 一致；
// 不直接 import 是为了不把 @milkdown/kit 拖进这条纯解析链路）
function gridTemplate(spec: string): string {
  if (spec.includes(':')) {
    const [a, b] = spec.split(':')
    return `${a}fr ${b}fr`
  }
  return `repeat(${spec}, minmax(0, 1fr))`
}

// ==高亮== 轻量插件（与 editor/highlight.ts、docx-export 的轻量版同一正则）
function remarkHighlightLite() {
  return (tree: any): void => {
    const visitText = (node: any): void => {
      if (!node || !Array.isArray(node.children)) return
      node.children = node.children.flatMap((child: any) => {
        if (child.type !== 'text' || typeof child.value !== 'string' || !child.value.includes('=='))
          return [child]
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

let processor: ReturnType<typeof buildProcessor> | null = null

function buildProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    // $...$ / $$...$$ → inlineMath/math（与编辑器同水位：$ 一律当公式）
    .use(remarkMath)
    // 注册顺序与 renderer 编辑器管线一致，保证两端解析结果相同
    .use(remarkColumns)
    .use(remarkFontBlock)
    .use(remarkResidualEmphasis)
    .use(remarkEmphDot)
    .use(remarkUnderline)
    .use(remarkFontSpan)
    .use(remarkBreaks)
    .use(remarkHighlightLite)
    .use(remarkBlankLine)
    .use(remarkPinyinRuby)
    .use(remarkPinyinInline)
    .use(remarkCircledSup)
    .use(remarkSubSup)
    .use(remarkTianziGrid)
}

function parseMarkdown(markdown: string): any {
  if (!processor) processor = buildProcessor()
  const file = new VFile({ value: markdown })
  // runSync 执行全部 transformer；只 parse 不跑任何扩展
  return processor.runSync(processor.parse(markdown), file)
}

/** 诊断用：暴露 mdast 解析（导出以便页面内直接排查语法问题） */
export function parseMarkdownAst(markdown: string): any {
  return parseMarkdown(markdown)
}

// ─── mdast → DOM ─────────────────────────────────────────────────────────────

/** 整行水平分隔记号：3 个以上同类字符，可夹空白（`---` / `***` / `___`） */
const DIVIDER_LINE = /^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/

const FULL_WIDTH_SPACE = '\u2003'

function element(tag: string, attrs?: Record<string, string>): HTMLElement {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) el.setAttribute(k, v)
    }
  }
  return el
}

function appendChildren(parent: HTMLElement, nodes: any[] | undefined): void {
  for (const node of nodes ?? []) {
    // 容器块（子块/字体块等）的 children 是块级节点（段落等），
    // 走 renderBlock；纯行内节点 renderBlock 不认，退回 renderNode
    const rendered = renderBlock(node) ?? renderNode(node)
    if (rendered) parent.append(rendered)
  }
}

/** 行内渲染：返回 Node（文本节点或元素），null 表示丢弃 */
function renderNode(node: any): Node | null {
  if (!node) return null
  switch (node.type) {
    case 'text':
      return document.createTextNode(String(node.value ?? ''))

    case 'break':
      return document.createElement('br')

    case 'inlineMath':
      return renderMath(String(node.value ?? ''), false)

    case 'math': {
      const wrap = element('div', { class: 'pc-preview-math' })
      wrap.append(renderMath(String(node.value ?? ''), true))
      return wrap
    }

    case 'strong':
      return withChildren('strong', node)
    case 'emphasis':
      return withChildren('em', node)
    case 'delete':
      return withChildren('del', node)
    case 'inlineCode': {
      const code = element('code')
      code.textContent = String(node.value ?? '')
      return code
    }
    case 'mark':
      return withChildren('mark', node)

    case 'link': {
      const a = element('a', {
        href: String(node.url ?? ''),
        target: '_blank',
        rel: 'noreferrer',
      })
      appendChildren(a, node.children)
      return a
    }

    case 'image': {
      const { alt, params } = parseImageAlt(String(node.alt ?? ''))
      const img = element('img', { src: String(node.url ?? ''), alt })
      const style: string[] = ['max-width:100%']
      if (params.width) style.push(`width:${params.width}`)
      if (params.height) style.push(`height:${params.height}`)
      if (params.align === 'center') style.push('display:block;margin:0.25em auto')
      else if (params.align === 'right') style.push('display:block;margin:0.25em 0 0.25em auto')
      else if (params.align === 'float-left') style.push('float:left;margin:0.25em 1em 0.25em 0')
      else if (params.align === 'float-right') style.push('float:right;margin:0.25em 0 0.25em 1em')
      if (params.border) style.push('border:1px solid #e2e8f0')
      if (params.shadow) style.push('box-shadow:0 2px 8px rgba(15,23,42,0.12)')
      if (params.radius) style.push('border-radius:6px')
      img.setAttribute('style', style.join(';'))
      img.setAttribute('loading', 'lazy')
      return img
    }

    // ── 扩展：行内 ──
    case 'emphDot':
      return withChildren('span', node, { class: 'emph-dot' })
    case 'underline':
      return withChildren('u', node)
    case 'subscript':
      return withChildren('sub', node)
    case 'superscript':
      return withChildren('sup', node)
    case 'blankLine': {
      const chars = Math.max(1, Math.ceil(Number(node.chars ?? 1)))
      // 结构与 blank-line/schema.ts 的 toDOM 一致：全角空格占位 + CSS 下划线
      const span = element('span', {
        class: node.blank ? 'blank-space' : 'blank-line',
        'data-chars': String(node.chars ?? 1),
      })
      span.append(document.createTextNode(FULL_WIDTH_SPACE.repeat(chars)))
      return span
    }
    case 'pinyinRuby': {
      // 与 pinyin-ruby/schema.ts 的 toDOM 一致：<ruby>原生上标拼音
      const ruby = element('ruby', {
        'data-pinyin': String(node.pinyin ?? ''),
        'data-text': String(node.text ?? ''),
      })
      const base = element('span', { class: 'ruby-base' })
      base.textContent = String(node.text ?? '')
      const rt = document.createElement('rt')
      rt.textContent = convertPinyin(String(node.pinyin ?? ''))
      ruby.append(base, rt)
      return ruby
    }
    case 'pinyinInline': {
      // 与 pinyin-inline/schema.ts 的 toDOM 一致：拼音并列在汉字右侧
      const span = element('span', {
        class: 'pinyin-inline',
        'data-pinyin': String(node.pinyin ?? ''),
        'data-text': String(node.text ?? ''),
      })
      const text = element('span', { class: 'pinyin-inline-text' })
      text.textContent = String(node.text ?? '')
      const annot = element('span', { class: 'pinyin-inline-annot' })
      annot.textContent = convertPinyin(String(node.pinyin ?? ''))
      span.append(text, annot)
      return span
    }
    case 'circledSup': {
      // 与 circled-sup/schema.ts 的 toDOM 一致：汉字 + 右上角带圈序号
      const span = element('span', {
        class: 'circled-sup',
        'data-char': String(node.char ?? ''),
        'data-num': String(node.num ?? ''),
      })
      const char = element('span', { class: 'circled-sup-char' })
      char.textContent = String(node.char ?? '')
      const sup = element('sup', { class: 'circled-num' })
      sup.textContent = String(node.num ?? '')
      span.append(char, sup)
      return span
    }
    case 'tianziGrid': {
      // 与 tianzi-grid/schema.ts 的 toDOM 一致：格子组（拼音行 + 田字框）
      const raw = String(node.raw ?? '')
      const span = element('span', { class: 'tianzi-grid', 'data-raw': raw })
      const model = parseCells(raw)
      if (!model) {
        span.textContent = `++${raw}++`
        return span
      }
      for (const cell of model.cells) {
        const cellEl = element('span', { class: 'tz-cell' })
        const py = element('span', { class: 'tz-py' })
        py.textContent = cell.pinyin ?? ' '
        const box = element('span', { class: 'tz-box' })
        const ch = element('span', { class: 'tz-char' })
        ch.textContent = cell.char ?? ''
        box.append(ch)
        cellEl.append(py, box)
        span.append(cellEl)
      }
      return span
    }
    case 'fontSpan': {
      // 与 font-style 的 schema 一致：inline style 生效，class 仅作标识
      const attrs: FontAttrs = {
        family: node.family,
        size: node.size,
        align: node.align,
      }
      return withChildren('span', node, {
        class: 'font-span',
        style: buildInlineStyle(attrs),
      })
    }

    // ── 扩展：块级 ──
    case 'subBlock': {
      // 与 columns/schema.ts 的 toDOM 一致：子块（可带框、可对齐）
      const div = element('div', {
        class: `sub-block${node.boxed ? ' boxed' : ''}`,
        'data-align': String(node.align ?? 'left'),
      })
      appendChildren(div, node.children)
      return div
    }
    case 'cols': {
      // 与 columns/schema.ts 的 toDOM 一致：CSS Grid 分栏
      const spec = String(node.spec ?? '2')
      const div = element('div', {
        class: 'cols',
        'data-spec': spec,
        style: `grid-template-columns:${gridTemplate(spec)}`,
      })
      appendChildren(div, node.children)
      return div
    }
    case 'fontBlock': {
      const attrs: FontAttrs = {
        family: node.family,
        size: node.size,
        align: node.align,
      }
      const div = element('div', {
        class: 'font-block',
        style: buildBlockStyle(attrs),
      })
      appendChildren(div, node.children)
      return div
    }

    default:
      return null
  }
}

function withChildren(
  tag: string,
  node: any,
  attrs?: Record<string, string>
): HTMLElement {
  const el = element(tag, attrs)
  appendChildren(el, node.children)
  return el
}

/** 块级渲染：返回块元素，null 表示丢弃 */
function renderBlock(node: any): HTMLElement | null {
  if (!node) return null
  switch (node.type) {
    case 'paragraph': {
      const p = element('p')
      appendChildren(p, node.children)
      return p
    }
    case 'heading': {
      const depth = Math.min(6, Math.max(1, Number(node.depth ?? 1)))
      const h = element(`h${depth}`)
      appendChildren(h, node.children)
      return h
    }
    case 'blockquote': {
      const bq = element('blockquote')
      for (const child of node.children ?? []) {
        const rendered = renderBlock(child)
        if (rendered) bq.append(rendered)
      }
      return bq
    }
    case 'list': {
      const list = element(node.ordered ? 'ol' : 'ul')
      if (node.ordered && node.start !== undefined && node.start !== null) {
        list.setAttribute('start', String(node.start))
      }
      for (const item of node.children ?? []) {
        if (item?.type !== 'listItem') continue
        const li = element('li')
        if (item.checked !== null && item.checked !== undefined) {
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.disabled = true
          box.checked = Boolean(item.checked)
          li.append(box, document.createTextNode(' '))
        }
        for (const child of item.children ?? []) {
          const rendered = renderBlock(child) ?? renderNode(child)
          if (rendered) li.append(rendered)
        }
        list.append(li)
      }
      return list
    }
    case 'code': {
      const pre = element('pre')
      const code = element('code')
      if (node.lang) code.setAttribute('data-lang', String(node.lang))
      code.textContent = String(node.value ?? '')
      pre.append(code)
      return pre
    }
    case 'thematicBreak':
      return element('hr')
    case 'table': {
      // gfm 表格；align 是逐列的对齐方式
      const table = element('table')
      const aligns: (string | null)[] = node.align ?? []
      const rows: any[] = node.children ?? []
      rows.forEach((row, rowIdx) => {
        const tr = element('tr')
        const headRow = rowIdx === 0 && rows.length > 1
        ;(row.children ?? []).forEach((cell: any, colIdx: number) => {
          const td = element(headRow ? 'th' : 'td')
          const align = aligns[colIdx]
          if (align === 'left' || align === 'center' || align === 'right') {
            td.setAttribute('style', `text-align:${align}`)
          }
          appendChildren(td, cell.children)
          tr.append(td)
        })
        table.append(tr)
      })
      return table
    }
    case 'html': {
      // 块级 HTML：与编辑器 html 节点视图一致按原文渲染
      const div = element('div', { class: 'pc-preview-html' })
      const template = document.createElement('template')
      template.innerHTML = String(node.value ?? '')
      div.append(template.content.cloneNode(true))
      return div
    }
    case 'math': {
      const wrap = element('div', { class: 'pc-preview-math' })
      wrap.append(renderMath(String(node.value ?? ''), true))
      return wrap
    }
    default: {
      // subBlock / cols / fontBlock 在块级同样合法（parseChildren 产物）
      const inline = renderNode(node)
      if (inline instanceof HTMLElement) return inline
      return null
    }
  }
}

/**
 * 一段原文（题干或答案）→ 渲染好的块容器。
 *
 * 整行 `---` 先删（拆题辅助记号，见文件头）；空内容返回 null。
 */
export function renderMarkdownSection(source: string, className: string): HTMLElement | null {
  const text = (source ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !DIVIDER_LINE.test(line))
    .join('\n')
    // 行首「数字 + . 或 ) + 空格」是 Markdown 的有序列表标记（CommonMark），
    // 题号「2. 已知…」会被解析成 <ol><li>，编号随着列表样式被吞掉 —— 题面里这
    // 永远不是真的列表，是题号/小问号。转义点号让它按普通文本渲染（`2\.` → "2."）；
    // 已转义的形式（数字后跟反斜杠）不匹配，重复调用不叠加。
    .replace(/(^|\n)([ \t]*)(\d{1,3})([.)])(?=[ \t])/g, '$1$2$3\\$4')
    .trim()
  if (!text) return null

  const section = element('div', { class: className })
  try {
    const tree = parseMarkdown(text)
    for (const child of tree.children ?? []) {
      const rendered = renderBlock(child)
      if (rendered) section.append(rendered)
    }
  } catch (error) {
    // 解析器理论上不抛（插件内部对非法语法一律按普通文本处理）；
    // 万一抛了，退化为纯文本展示，保证题面可见。
    console.warn('[extension-preview] 解析失败，退化为纯文本：', error)
    const p = element('p')
    p.textContent = text
    section.append(p)
  }
  return section.childElementCount > 0 ? section : null
}
