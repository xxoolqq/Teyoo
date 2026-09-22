import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SerializedMmlVisitor } from 'mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js'
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import type { MathEngine, MathOutputFormat } from './types'
import { renderError } from './katex-engine'

// MathJax 引擎（mathjax-full v3）。
// ────────────────────────────────────────────────────────────────────────────
// 输出链路：TeX 输入编译 → 内部 MmlTree → SerializedMmlVisitor 序列化为
// MathML 字符串 → Chromium 原生渲染 <math>（Electron 109+ 支持 MathML Core）。
// v3 没有独立的 MathML OutputJax（js/output 下只有 svg / chtml），
// "无输出 Jax + 序列化访问器" 是官方 demo（tex2mml）的标准做法。
//
// svg / chtml 输出形态已在接口预留（MathOutputFormat），按需在此扩展：
//   new SVG() / new CHTML() 作为 OutputJax 挂进 mathjax.document 即可。
//
// TeX 包列表取 AllPackages 并剔除 require / autoload：
// 这两个包依赖运行时动态加载组件，与 Vite 打包方式不兼容；
// 其余（mhchem、cancel、mathtools、physics 等）全部静态可用。
const TEX_PACKAGES = AllPackages.filter((name) => name !== 'require' && name !== 'autoload')

// mathjax 实例懒初始化：选 KaTeX 的用户不为 MathJax 付出启动开销
let compiled: {
  doc: ReturnType<typeof mathjax.document>
  visitor: SerializedMmlVisitor
} | null = null

function ensureCompiled(): { doc: ReturnType<typeof mathjax.document>; visitor: SerializedMmlVisitor } {
  if (compiled) return compiled
  RegisterHTMLHandler(browserAdaptor())
  const doc = mathjax.document('', {
    InputJax: new TeX({ packages: TEX_PACKAGES }),
  })
  compiled = { doc, visitor: new SerializedMmlVisitor() }
  return compiled
}

export const mathjaxEngine: MathEngine = {
  id: 'mathjax',
  label: 'MathJax',
  render(latex, displayMode, format: MathOutputFormat = 'mathml') {
    if (format !== 'mathml') {
      // 预留接口：svg / chtml 输出待后续实现
      console.warn(`[math-engine] MathJax 输出格式 ${format} 尚未实现，回退到 mathml`)
    }
    const el = document.createElement(displayMode ? 'div' : 'span')
    el.classList.add('math-engine-mathjax')
    try {
      const { doc, visitor } = ensureCompiled()
      // 无输出 Jax 时 convert 返回内部 MmlNode 树（MathDocument.convert 尾行：typesetRoot || root）
      const node = doc.convert(latex, { display: displayMode })
      if (!node) throw new Error('MathJax compile returned empty output')
      const mml = visitor.visitTree(node as Parameters<SerializedMmlVisitor['visitTree']>[0])
      el.innerHTML = mml
    } catch (err) {
      el.replaceChildren(renderError(String(err instanceof Error ? err.message : err), latex))
    }
    return el
  },
}
