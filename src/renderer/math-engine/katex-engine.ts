import katex from 'katex'
// 化学式（\ce / \pu）在 KaTeX 里是 contrib 扩展，必须显式 import 才注册；
// 副作用导入，不用它的返回值。类型声明见 src/renderer/env.d.ts。
import 'katex/contrib/mhchem'
import type { MathEngine } from './types'
import { PHYSICS_MACROS } from './physics-macros'

// KaTeX 引擎：与原先 @milkdown/plugin-math 内置渲染等价
// （throwOnError: false —— 出错时以红色展示源码而不是抛异常）。
export const katexEngine: MathEngine = {
  id: 'katex',
  label: 'KaTeX',
  render(latex, displayMode) {
    const el = document.createElement(displayMode ? 'div' : 'span')
    el.classList.add('math-engine-katex')
    try {
      el.innerHTML = katex.renderToString(latex, {
        throwOnError: false,
        displayMode,
        macros: PHYSICS_MACROS, // physics 近似宏，缺了 \dv / \bra 会报未定义
      })
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
