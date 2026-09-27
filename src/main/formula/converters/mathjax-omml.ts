// MathJax 方案：LaTeX → MathML（mathjax-full TeX 编译 + SerializedMmlVisitor）
// → OMML（mathml2omml）
//
// 与编辑器预览端（src/renderer/math-engine/mathjax-engine.ts）同源：
//   - mathjax-full v3 无独立 MathML OutputJax（js/output 只有 svg/chtml），
//     标准做法是「无输出 Jax + SerializedMmlVisitor」直接序列化内部 MmlTree；
//   - TeX 包列表剔除 require/autoload（与 Vite/rollup 打包不兼容）以及
//     bussproofs（其编译期 postfilter 强制要求 outputJax.getBBox()，无输出
//     Jax 时每个公式都抛错，详见渲染端 mathjax-engine.ts 注释）。
//
// 主进程（Node）环境用 liteAdaptor（不依赖 DOM），与 Temml 同为纯 JS 链路；
// mathjax 实例懒初始化，首次导出才付出启动开销，之后单例复用 convert。
//
// 错误策略：编译/序列化/mml2omml 任一步异常返回 null，由调用方降级为
// LaTeX 原文文本，保证导出永不因公式失败而中断。

import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SerializedMmlVisitor } from 'mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import { mml2omml } from 'mathml2omml'
import type { FormulaConverter, FormulaToOmmlOptions } from '../types'

const TEX_PACKAGES = AllPackages.filter(
  (name) => name !== 'require' && name !== 'autoload' && name !== 'bussproofs',
)

// 懒初始化的单例；主进程可能并发导出，但 convert 为同步纯函数调用，
// 单例复用安全（不持有请求级状态）。
let compiled: {
  doc: ReturnType<typeof mathjax.document>
  visitor: SerializedMmlVisitor
} | null = null

function ensureCompiled(): {
  doc: ReturnType<typeof mathjax.document>
  visitor: SerializedMmlVisitor
} {
  if (compiled) return compiled
  RegisterHTMLHandler(liteAdaptor())
  const doc = mathjax.document('', { InputJax: new TeX({ packages: TEX_PACKAGES }) })
  compiled = { doc, visitor: new SerializedMmlVisitor() }
  return compiled
}

export const mathjaxConverter: FormulaConverter = {
  id: 'mathjax',
  label: 'MathJax（LaTeX → MathML → OMML）',

  latexToOmml(latex: string, options: FormulaToOmmlOptions): string | null {
    const source = latex.trim()
    if (!source) return null
    try {
      const { doc, visitor } = ensureCompiled()
      // 无输出 Jax 时 convert 返回内部 MmlNode 树
      // （MathDocument.convert 尾行：mitem.typesetRoot || mitem.root）
      const node = doc.convert(source, { display: options.displayMode })
      if (!node) return null
      const mathml = visitor.visitTree(
        node as Parameters<SerializedMmlVisitor['visitTree']>[0],
      )
      // disableDecode: 保持 MathML 中的 XML 实体原样透传，避免公式含
      // < > & 时输出非法 XML（与 temml-omml.ts 同一防护，详见其注释）。
      const omml = mml2omml(mathml, { disableDecode: true })
      return omml.includes('<m:oMath') ? omml : null
    } catch {
      return null
    }
  },
}
