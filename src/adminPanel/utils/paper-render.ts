// 组卷页的轻量 markdown → HTML：题目卡片与卷面 PDF 共用一套解析。
//
// 为什么不用 Milkdown 只读实例：一页 20 张卡 + 一份卷面，只读实例是全局串行创建的，
// 排队建完要好几秒；而组卷只需要「公式排对、选项分行、加粗保留」这几件事。
// 公式仍走 KaTeX（与编辑器同一个渲染器），所以 `$` 没闭合时只会退化成原文。
//
// 两种输出模式：
//   · 页面内（默认）→ KaTeX 的 HTML 输出，样式来自页面已加载的 katex.min.css
//   · 卷面打印（mathml: true）→ KaTeX 的 MathML 输出：隐藏打印窗口里没有任何
//     外部样式表与字体文件可用，MathML 由 Chromium 原生排版，不依赖 CSS

import katex from 'katex'
import 'katex/dist/katex.min.css'

/** $$…$$ 优先，其次 $…$（行内公式不跨行） */
const MATH_TOKEN = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g

/** 选项行：A. / A、 / A． / A) —— MathBank 的题面两种写法都有 */
const OPTION_LINE = /^\s*([A-H])\s*[.、．)]\s*/

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch)
}

export interface RenderOptions {
  /** 卷面打印用：公式出 MathML，不依赖 katex 的 CSS 与字体 */
  mathml?: boolean
  /** 是否保留插图（默认保留；卡片里也显示，卷面更需要） */
  images?: boolean
}

function renderMath(token: string, mathml: boolean): string {
  const body = token.startsWith('$$') ? token.slice(2, -2) : token.slice(1, -1)
  try {
    return katex.renderToString(body, {
      displayMode: false,
      throwOnError: false,
      output: mathml ? 'mathml' : 'html'
    })
  } catch {
    return escapeHtml(token)
  }
}

/** 一段不含公式的文本：转义 + 保住插图 / 加粗 / 行内代码 */
function renderText(raw: string, images: boolean): string {
  let out = escapeHtml(raw)
  if (images) {
    out = out.replace(
      /!\[([^\]]*)\]\(([^)\s]+)\)/g,
      (_match, alt: string, src: string) =>
        `<img class="pr-img" src="${src}" alt="${alt}" loading="lazy">`
    )
  } else {
    out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  }
  return out
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** 行内（含公式）→ HTML */
export function renderInlineHtml(raw: string, options: RenderOptions = {}): string {
  const source = raw ?? ''
  const images = options.images !== false
  const mathml = options.mathml === true
  let html = ''
  let cursor = 0
  MATH_TOKEN.lastIndex = 0
  for (let match = MATH_TOKEN.exec(source); match; match = MATH_TOKEN.exec(source)) {
    html += renderText(source.slice(cursor, match.index), images)
    html += renderMath(match[1], mathml)
    cursor = match.index + match[1].length
  }
  html += renderText(source.slice(cursor), images)
  return html
}

/**
 * 整段题面 → HTML 块。
 *
 * 保留行结构（段内换行用 <br>），连续的 A./B./C./D. 行收成一个选项块，
 * 这样卡片里能做两列选项、卷面里能保持每行一项。
 */
export function renderBodyHtml(markdown: string, options: RenderOptions = {}): string {
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    const body = paragraph
      .map((line) => renderInlineHtml(line, options))
      .join('<br>')
    if (body.trim()) blocks.push(`<p>${body}</p>`)
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) {
      flushParagraph()
      continue
    }
    if (OPTION_LINE.test(line)) {
      flushParagraph()
      const items: string[] = []
      while (index < lines.length && OPTION_LINE.test(lines[index])) {
        items.push(
          `<span class="pr-option"><b>${escapeHtml(lines[index].match(OPTION_LINE)?.[1] ?? '')}.</b>${renderInlineHtml(
            lines[index].replace(OPTION_LINE, ''),
            options
          )}</span>`
        )
        index += 1
      }
      // 循环退出时 index 指向第一个非选项行，退回一步交给外层继续
      index -= 1
      blocks.push(`<div class="pr-options">${items.join('')}</div>`)
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  return blocks.join('')
}
