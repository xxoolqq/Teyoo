// ─── 粘贴：把网页里的公式还原成公式节点 ────────────────────────────────────
//
// 从渲染过数学的网页（KaTeX / MathJax 站点）复制时，剪贴板的 text/html 里是
// 排版后的 DOM：HTML spans 画的公式 + 一份 MathML。LaTeX 源码只藏在 MathML 的
// <annotation encoding="application/x-tex"> 或 <math alttext="..."> 里，而 `$`
// 定界符在 DOM 中根本不存在 —— 它是源码标记，不是渲染结果。
//
// ProseMirror 按 schema 解析这段 HTML 时认不出公式（math_inline 只认
// span[data-type=math_inline][data-value]，见 @milkdown/plugin-math），于是
// MathML 里的源码和排版的 Unicode 字符一起降级成普通文本：公式不渲染，切到
// 源码也看不到 `$` —— 源码还在，只是没有定界符，不再是公式。
//
// 修法：粘贴前把公式容器整块换成 math_inline / math_block 认得的 DOM，排出
// 来的公式节点与手写的 `$..$` 完全一样（渲染、双击编辑、导出都走同一条路）。

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'

/** MathML 里放 TeX 源码的标准位置 */
const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]'

/** 图片式公式：Wikipedia 的 img.tex、知乎的 img[eeimg]，源码在 alt 里 */
const MATH_IMAGE = 'img.tex, img[eeimg], img[data-eeimg]'

function texOf(container: Element): string | null {
  const annotation = container.querySelector(TEX_ANNOTATION)
  const fromAnnotation = annotation?.textContent?.trim()
  if (fromAnnotation) return fromAnnotation
  // MathJax 的 MathML 根元素把 TeX 放在 alttext 上
  const math =
    container.tagName.toLowerCase() === 'math' ? container : container.querySelector('math')
  const alttext = math?.getAttribute('alttext')?.trim()
  return alttext || null
}

function mathNode(doc: Document, latex: string, block: boolean): HTMLElement {
  const node = doc.createElement(block ? 'div' : 'span')
  node.setAttribute('data-type', block ? 'math_block' : 'math_inline')
  node.setAttribute('data-value', latex)
  return node
}

/** 就地替换：容器连同里面的排版 DOM 一起换掉，避免残留 Unicode 数学字符 */
function replaceAll(body: HTMLElement, selector: string, isBlock: (el: Element) => boolean): void {
  for (const el of Array.from(body.querySelectorAll(selector))) {
    const latex = texOf(el)
    if (!latex) continue
    el.replaceWith(mathNode(el.ownerDocument, latex, isBlock(el)))
  }
}

/** 供探针/测试直接调用；异常一律原样返回（粘贴不该因公式识别失败而坏掉） */
export function convertPastedMathHtml(html: string): string {
  if (!html) return html
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // 顺序：先整块容器，再裸 MathML，最后图片式。前一步替换掉的节点已脱离
    // 文档树，后续 querySelectorAll 不会再命中。
    for (const el of Array.from(doc.body.querySelectorAll('.katex'))) {
      const latex = texOf(el)
      if (!latex) continue
      // 展示态外层还有一个 .katex-display，要连它一起换，否则留下空 span
      const display = el.closest('.katex-display')
      const target = display ?? el
      target.replaceWith(mathNode(target.ownerDocument, latex, !!display))
    }
    replaceAll(doc.body, 'mjx-container', el => el.getAttribute('display') === 'true')
    replaceAll(doc.body, 'math', () => false)
    for (const el of Array.from(doc.body.querySelectorAll(MATH_IMAGE))) {
      const alt = (el.getAttribute('alt') ?? '').trim()
      if (!alt) continue
      el.replaceWith(mathNode(el.ownerDocument, alt, false))
    }
    return doc.body.innerHTML
  } catch {
    return html
  }
}

export const pasteMathPlugin = $prose(
  () =>
    new Plugin({
      props: {
        transformPastedHTML: convertPastedMathHtml
      }
    })
)
