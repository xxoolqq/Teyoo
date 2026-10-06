// 公式转换模块 —— 接口契约
//
// 设计目标（面向未来设置面板的多方案选择）：
//   - 所有 LaTeX → OMML 的转换方案实现同一 FormulaConverter 接口；
//   - 方案在 registry.ts 中注册，导出时按 id 选取（DocxExportInput.formulaConverter）；
//   - 设置面板通过 listFormulaConverters() 枚举可选项，选择结果持久化后
//     在导出入口（src/main/index.ts 的 export-docx handler）传入 id 即可，
//     本模块与 docx-export.ts 无需再改动。
//
// 接口保持「纯字符串进出」：不依赖 docx 库类型，便于单测与未来复用
// （如导出图片、HTML 等其它格式时同样能取到 MathML/OMML 中间产物）。

/** LaTeX → OMML 转换的选项 */
export interface FormulaToOmmlOptions {
  /** 块级公式（display mode，如 $$...$$）；false 为行内（$...$） */
  displayMode: boolean
}

/**
 * LaTeX 公式转换器统一接口。
 *
 * latexToOmml 返回 `<m:oMath>…</m:oMath>` XML 片段（行内形态；块级由
 * 调用方按需包 `<m:oMathPara>`）。转换失败返回 null，由调用方降级为
 * LaTeX 原文文本，保证导出永不因公式失败而中断。
 */
export interface FormulaConverter {
  /** 唯一 id，用于设置面板持久化与导出时选取（如 'temml' / 'mathjax'） */
  readonly id: string
  /** 展示名（设置面板下拉显示用） */
  readonly label: string
  /** LaTeX 转换为 OMML XML 字符串；失败返回 null */
  latexToOmml(latex: string, options: FormulaToOmmlOptions): string | null
}

/** 转换器枚举项（设置面板下拉选项的形状） */
export interface FormulaConverterInfo {
  id: string
  label: string
}
