// 可视化解题：数据类型
// ─────────────────────────────────────────────────────────────────────────────
// 与视图（view.ts）和协议（protocol.ts）共享的最小集合。刻意保持"纯数据"：
// 解析出来的解题结果要能直接被插入正文、复制、导出，所以这里的形状就以
// Markdown 段落为单位，而不是模型/UI 的内部状态。

/** 一条图形指令（模型给的是受限指令，不是 SVG/JS —— 见 protocol.ts 的说明） */
export interface SolveGraphics {
  kind: 'plot' | 'figure'
  /** 指令原文（例如 `f: 2*x+1` / `A=(0,0)  B=(4,0)`），P1 交给沙箱渲染 */
  code: string
}

/** 一步 */
export interface SolveStep {
  /** 第几步（标题里写了就用它，没写按出现顺序） */
  index: number
  title: string
  /** 说明文字 + 公式（Markdown 原文，图形块已摘出去） */
  body: string
  graphics: SolveGraphics[]
}

/** 一次解题的完整结果（流式过程中可以反复解析，越往后越完整） */
export interface SolveDocument {
  /** 第一个标题之前的总述（模型有时会写一句） */
  intro: string
  steps: SolveStep[]
  /** 「## 答案」之后的内容 */
  answer: string
  /** 不是"第 N 步"的小节（追问的回答会落在这里） */
  extra: { title: string; body: string }[]
}

/** 粘进来/选进来的一道题（图片题会带上识别结果） */
export interface SolverAttachment {
  path: string
  name: string
  /** 识别出来的文本/LaTeX（没识别出来就是空串） */
  text: string
  /** 原图 data URL（视觉模型直传用） */
  dataUrl?: string
}
