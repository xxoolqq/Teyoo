// 数学公式渲染引擎 —— 公共类型定义
// ────────────────────────────────────────────────────────────────────────────
//
// 编辑器内的公式（math_inline / math_block）通过 MathEngine 接口渲染，
// 具体引擎（KaTeX / MathJax）注册进 registry，由偏好设置运行时切换。
//
// 预留扩展点：
// - MathOutputFormat：MathJax 的输出形态（svg 已实现且为默认；chtml 后续接入。
//   MathML 序列化需求由导出链路 src/main/formula 独立承担，预览端不走）
// - 导出链路（Word/PDF）的公式转换器独立于本模块，
//   集成点在 src/main/formula/registry.ts 的 registerFormulaConverter。

export type MathEngineId = 'katex' | 'mathjax'

/** MathJax 输出形态：svg 已实现且为默认（自绘排版，质量与浏览器无关）；chtml 预留 */
export type MathOutputFormat = 'svg' | 'chtml'

export interface MathEngine {
  id: MathEngineId
  /** 偏好设置下拉框显示名 */
  label: string
  /**
   * 把 LaTeX 源码渲染为可插入 DOM 的元素。
   * - 行内公式（displayMode=false）返回 span 容器
   * - 块级公式（displayMode=true）返回 div 容器
   * - 渲染失败不抛异常，返回带 .math-render-error 的错误展示元素
   */
  render(latex: string, displayMode: boolean, format?: MathOutputFormat): HTMLElement
}
