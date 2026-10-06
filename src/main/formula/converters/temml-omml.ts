// Temml 方案：LaTeX → MathML（Temml）→ OMML（mathml2omml）
//
// 设置面板「导出公式引擎」下拉里的 KaTeX 项就是本转换器（显示名 KaTeX，
// 存储值仍是 'Temml'）：Temml 是 KaTeX 的 MathML 输出分支（ronkok/Temml），
// 纯 JS、无 DOM 依赖，可在 Electron 主进程（Node 环境）直接运行；
// mathml2omml（fiduswriter/mathml2omml）把 MathML 字符串转为 Word 的
// OMML（Office Math Markup Language），输出自带 m/w 命名空间声明，
// 可经 ImportedXmlComponent 直接注入 docx 段落。
//
// 错误策略：throwOnError: false 时 Temml 对非法 LaTeX 输出红色错误片段
// 而不抛异常（与编辑器 katexOptionsCtx 行为一致）；仅对空输入与
// mml2omml 异常/空输出返回 null，由调用方降级为原文文本。

import temml from 'temml'
import { mml2omml } from 'mathml2omml'
import type { FormulaConverter, FormulaToOmmlOptions } from '../types'
// 与编辑器 KaTeX 预览共用同一份 physics 宏，避免「预览能渲染、导出报错」。
// 实测：Temml 能正常渲染 \ce 化学式（\ce{SO4^2- + Ba^2+ -> BaSO4 v} →
// SO₄²⁻ + Ba²⁺ → BaSO₄↓，比 MathJax 少两处隐形占位字母 A），因此不存在
// 「\ce 必须改用 MathJax」的限制；physics 等宏在 KaTeX 侧仍是近似实现。
import { PHYSICS_MACROS } from '../../../renderer/math-engine/physics-macros'

export const temmlConverter: FormulaConverter = {
  id: 'temml',
  label: 'Temml（LaTeX → MathML → OMML）',

  latexToOmml(latex: string, options: FormulaToOmmlOptions): string | null {
    const source = latex.trim()
    if (!source) return null
    try {
      const mathml = temml.renderToString(source, {
        displayMode: options.displayMode,
        throwOnError: false,
        macros: PHYSICS_MACROS,
      })
      // disableDecode: 保持输入 MathML 中的 XML 实体（&lt; &gt; &amp;）原样透传。
      // 默认（解码开启）会把实体解码成裸字符再拼进 <m:t> 且不重新转义，
      // 公式含 < > & 时输出非法 XML，docx 库解析报 "Unexpected close tag"。
      // 保留实体后输出恒为合法 XML（字符引用 Word 可正常解析）。
      const omml = mml2omml(mathml, { disableDecode: true })
      return omml.includes('<m:oMath') ? omml : null
    } catch {
      return null
    }
  },
}
