// 公式转换模块出口
//
// 使用方（docx-export.ts / 未来设置面板）只 import 本文件：
//   import { getFormulaConverter, listFormulaConverters } from './formula'
//
// 设置面板接入路径（规划）：
//   1. 面板调 listFormulaConverters()（或经 IPC 暴露）枚举方案下拉项；
//   2. 选择结果随应用设置持久化；
//   3. 导出时在 src/main/index.ts 的 export-docx handler 组装
//      markdownToDocx({ ..., formulaConverter: <所选 id> })，完成替换。

import { registerFormulaConverter } from './registry'
import { temmlConverter } from './converters/temml-omml'
import { mathjaxConverter } from './converters/mathjax-omml'

export type { FormulaConverter, FormulaToOmmlOptions, FormulaConverterInfo } from './types'
export { getFormulaConverter, listFormulaConverters, registerFormulaConverter } from './registry'

// 注册内置方案。MathJax 显式设为默认：宏覆盖面最广（physics 等官方包），
// 与预览端默认引擎（markdown.latexEngine = 'mathjax'）一致。
// Temml 是 KaTeX 的 MathML 分支，设置面板下拉里显示为 KaTeX。
registerFormulaConverter(mathjaxConverter, { makeDefault: true })
registerFormulaConverter(temmlConverter)
