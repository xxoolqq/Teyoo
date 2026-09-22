import katex from 'katex'
import type { MathEngine } from './types'

// KaTeX 引擎：与原先 @milkdown/plugin-math 内置渲染等价
// （throwOnError: false —— 出错时以红色展示源码而不是抛异常）。
export const katexEngine: MathEngine = {
  id: 'katex',
  label: 'KaTeX',
  render(latex, displayMode) {
    const el = document.createElement(displayMode ? 'div' : 'span')
    el.classList.add('math-engine-katex')
    try {
      el.innerHTML = katex.renderToString(latex, { throwOnError: false, displayMode })
    } catch (err) {
      el.replaceChildren(renderError(String(err instanceof Error ? err.message : err), latex))
    }
    return el
  },
}

/** 渲染失败时的占位展示（红字源码 + 提示），各引擎复用 */
export function renderError(message: string, latex: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'math-render-error'
  el.title = message
  el.textContent = latex
  return el
}
