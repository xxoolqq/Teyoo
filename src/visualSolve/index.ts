// 可视化解题模块的统一出口 —— main.ts 只 import 这里。
//
// 目录结构：
//   types.ts     纯数据类型（步骤 / 图形指令 / 会话附件）
//   protocol.ts  给模型的输出协议（系统提示词）+ 解析器 + 结果转 Markdown
//   view.ts      整页视图与会话（输入 / 流式 / 渲染 / 追问 / 插入正文）
//   index.ts     本文件
//
// 它复用（不重复实现）：
//   · 对话与多模态：main/llm.ts（含二进制图片分片）→ IPC 走 channel: 'solver'
//   · 图片识别：main/assistant-attach.ts（MinerU → 本地 OCR）
//   · 公式渲染：renderer/math-engine（KaTeX / MathJax，CJK 自动切 KaTeX）
//   · 插入正文：main.ts 注入的 hooks.insertMarkdown（→ editor.ts）
export {
  initVisualSolve,
  enterSolverTabChrome,
  leaveSolverTab,
  isSolverStreaming
} from './view'
export type { VisualSolveHooks } from './view'
