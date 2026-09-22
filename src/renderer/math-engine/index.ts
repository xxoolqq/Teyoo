// 数学公式渲染引擎模块 —— 对外统一出口
// ────────────────────────────────────────────────────────────────────────────
// 使用方（editor.ts / preferences-modal.ts 等）只 import 本文件：
//   import { mathInlineView, mathBlockView, setMathEngine, getActiveMathEngineId } from '../math-engine'
//
// 目录结构：
//   types.ts         引擎接口与 id / 输出格式类型
//   registry.ts      引擎注册表 + 当前引擎 + localStorage 持久化 + 切换通知
//   katex-engine.ts  KaTeX 实现
//   mathjax-engine.ts MathJax 实现（mathml 输出，svg/chtml 预留）
//   node-views.ts    math_inline / math_block 的 ProseMirror nodeView

export * from './types'
export * from './registry'
export { mathInlineView, mathBlockView } from './node-views'
