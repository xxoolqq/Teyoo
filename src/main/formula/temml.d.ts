// temml 包无类型定义（main: dist/temml.js），这里声明本项目用到的最小 API。
// 选项完整列表见 https://github.com/ronkok/Temml（KaTeX 兼容选项的超集），
// 未使用的选项以索引签名兜底，避免上游新增选项时本声明过窄。
declare module 'temml' {
  export interface TemmlOptions {
    /** 块级公式（$$...$$）时为 true */
    displayMode?: boolean
    /** 非法 LaTeX 输出错误片段而非抛异常 */
    throwOnError?: boolean
    /** 错误片段颜色 */
    errorColor?: string
    /** 严格模式告警策略 */
    strict?: boolean | 'ignore' | 'warn' | 'error'
    /** 输出 <math> 上附带 xmlns 声明 */
    xml?: boolean
    /** 在 <annotation encoding="application/x-tex"> 中携带原文 */
    annotate?: boolean
    [key: string]: unknown
  }

  export interface Temml {
    renderToString(expression: string, options?: TemmlOptions): string
    render(expression: string, baseNode: unknown, options?: TemmlOptions): void
    version: string
  }

  const temml: Temml
  export default temml
}
