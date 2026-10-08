// 可视化解题：给模型的输出协议 + 把输出解析回来的解析器
// ─────────────────────────────────────────────────────────────────────────────
// 为什么不用 JSON（豆包方案里的做法）：
//   ① 流式下 JSON 半截没法解析，而解题恰恰要"边想边看"；
//   ② 解题结果要能直接**插入正文**，Markdown 天然就是正文格式；
//   ③ 不依赖 function calling / JSON mode —— 换任何 OpenAI 兼容模型都能用。
//   （与本仓库 assistant-syntax.ts 同一取舍：纯文本协议 + 宽容解析。）
//
// 约定（同时写进 SOLVER_SYSTEM，模型照着来）：
//   ## 第 N 步：<这一步做什么>
//   一两句说明为什么这么做，然后写公式：行内 $…$、独立 $$…$$
//   \hl{…} 标出这一步变化的那一项（宏见 math-engine/physics-macros.ts）
//   ```plot / ```figure 代码块给出图形指令（受限指令，不是 SVG）
//   ## 答案
//   结论

import type { SolveDocument, SolveGraphics, SolveStep } from './types'

/** 分步标题：`## 第 1 步：移项` / `### Step 2: ...` */
const STEP_HEADING = /^#{2,4}\s*(?:第\s*(\d+)\s*步|step\s*(\d+))\s*[:：、.]?\s*(.*)$/i
/** 答案标题：`## 答案` / `## 结论` / `## Answer` */
const ANSWER_HEADING = /^#{2,4}\s*(?:答案|结论|最终答案|answer)\s*[:：]?\s*$/i
/** 其它小节标题（追问的回答、补充说明都会落进 extra） */
const ANY_HEADING = /^#{2,4}\s+(.+)$/

/** 把 ```plot / ```figure 代码块摘出来（正文里只留说明与公式） */
function extractGraphics(body: string): { text: string; graphics: SolveGraphics[] } {
  const graphics: SolveGraphics[] = []
  const text = body.replace(
    /```(plot|figure)[ \t]*\r?\n([\s\S]*?)```/g,
    (_match, kind: string, code: string) => {
      graphics.push({ kind: kind === 'figure' ? 'figure' : 'plot', code: code.trim() })
      return ''
    }
  )
  return { text, graphics }
}

/**
 * 把模型的 Markdown 拆成「前言 / 步骤 / 答案 / 其它小节」。
 * 流式过程中可以反复调用（未写完的最后一段照样能显示，只是还没收尾）。
 */
export function parseSolution(markdown: string): SolveDocument {
  const doc: SolveDocument = { intro: '', steps: [], answer: '', extra: [] }
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let mode: 'intro' | 'step' | 'answer' | 'extra' = 'intro'
  let buffer: string[] = []
  let currentStep: SolveStep | null = null
  let currentExtra: { title: string; body: string } | null = null
  let stepCounter = 0

  const flush = (): void => {
    const raw = buffer.join('\n').trim()
    buffer = []
    if (mode === 'intro') {
      doc.intro = raw
      return
    }
    if (mode === 'step' && currentStep) {
      const { text, graphics } = extractGraphics(raw)
      currentStep.body = text.trim()
      currentStep.graphics = graphics
      return
    }
    if (mode === 'answer') {
      doc.answer = raw
      return
    }
    if (mode === 'extra' && currentExtra) currentExtra.body = raw
  }

  for (const line of lines) {
    const step = STEP_HEADING.exec(line)
    const answer = ANSWER_HEADING.exec(line)
    const heading = ANY_HEADING.exec(line)
    if (step || answer || heading) {
      flush()
      if (step) {
        stepCounter += 1
        const parsed = Number(step[1] ?? step[2] ?? '')
        currentStep = {
          index: Number.isFinite(parsed) && parsed > 0 ? parsed : stepCounter,
          title: (step[3] ?? '').trim(),
          body: '',
          graphics: []
        }
        doc.steps.push(currentStep)
        mode = 'step'
      } else if (answer) {
        mode = 'answer'
      } else {
        currentExtra = { title: (heading?.[1] ?? '').trim(), body: '' }
        doc.extra.push(currentExtra)
        mode = 'extra'
      }
      continue
    }
    buffer.push(line)
  }
  flush()
  return doc
}

/**
 * 解析结果 → 可插入正文的 Markdown。
 *
 * `imageFor` 给得出图片时，图形指令换成 `![](data:image/svg+xml;base64,…)` —— 正文里
 * 直接就能看到图（编辑器对 data URL 图片是支持的）；给不出（沙箱没画出来）就退回
 * 原始的 ```plot / ```figure 代码块，指令不丢，以后还能再画。
 */
export function solutionToMarkdown(
  doc: SolveDocument,
  imageFor?: (graphic: SolveGraphics) => string | null
): string {
  const parts: string[] = []
  if (doc.intro) parts.push(doc.intro)
  for (const step of doc.steps) {
    const title = step.title ? `第 ${step.index} 步：${step.title}` : `第 ${step.index} 步`
    const blocks = [step.body.trim()]
    for (const graphic of step.graphics) {
      const image = imageFor?.(graphic)
      if (image) {
        const alt = graphic.kind === 'figure' ? '几何图' : '函数图像'
        blocks.push(`![${alt}](${image})`)
      } else {
        blocks.push('```' + graphic.kind + '\n' + graphic.code + '\n```')
      }
    }
    parts.push(`## ${title}\n\n${blocks.filter(Boolean).join('\n\n')}`)
  }
  if (doc.answer.trim()) parts.push(`## 答案\n\n${doc.answer.trim()}`)
  for (const item of doc.extra) {
    if (item.body.trim()) parts.push(`## ${item.title}\n\n${item.body.trim()}`)
  }
  return parts.join('\n\n').trim()
}

/** 系统提示词。`zh` 跟随界面语言（与侧边栏助手同一套约定）。 */
export function solverSystemPrompt(zh: boolean): string {
  if (zh) {
    return [
      '你是严谨的数学解题助手。用户给你一道题（文字，或识别出来的题目图片；也可能同时附上原图）。',
      '',
      '输出格式必须严格遵守下面这套约定 —— 本编辑器的解析器按它渲染，写偏了会显示成乱码：',
      '',
      '1. 分步：每个步骤一个二级标题，写成 `## 第 1 步：这一步在做什么`（序号连续，最多 8 步）。',
      '2. 步骤正文：先用一到两句中文说明**为什么**这么做，再写这一步的式子。',
      '   行内公式用 $...$，独立公式用 $$...$$。不要用代码块包裹公式。',
      '3. 高亮：把这一步**发生变化的那一项**用 \\hl{...} 包起来，例如 $\\hl{2x} = 6$。',
      '   每步最多标一处，别的项保持原样。',
      '4. 图形（只在真的需要时给，宁缺勿滥）：',
      '   · 函数图像用 ```plot 代码块：',
      '     f: a*x + 1',
      '     domain: -5..5',
      '     params: a = 1 (-5..5)',
      '     points: (2,5)',
      '     （f 可以给多行；domain 是作图区间；points 可选）',
      '   · 题目里"参数变化时图像怎么变"这类问题，请用上面那行 params 给出自由参数：',
      '     界面会给一条滑块，用户拖动就能看到图像实时跟着变（表达式里直接用这个字母）。',
      '   · 平面几何用 ```figure 代码块：',
      '     A=(0,0)  B=(4,0)  C=(0,3)',
      '     segment A B',
      '     circle A 2',
      '     polygon A B C',
      '     angle A B C',
      '     （点先用 `名字=(x,y)` 给出，再写 segment / circle 圆心半径 / polygon 顶点 / angle 顶点在中间）',
      '   注意：这两个代码块里只放上面这种指令，**不要**写 SVG、HTML 或 JavaScript。',
      '5. 最后用 `## 答案` 收尾，只写结论（可以只有公式）。',
      '',
      '不要输出 JSON、不要用代码块包裹整个回答、不要写与解题无关的寒暄。',
      '如果题目信息不完整或图片看不清，直接说明缺什么，不要编造条件。'
    ].join('\n')
  }
  return [
    'You are a rigorous math tutor. The user gives you a problem (text, or a recognized photo; the raw image may be attached too).',
    '',
    'Follow this output format exactly — the editor parses it:',
    '',
    '1. Steps: one level-2 heading per step, `## Step 1: what this step does` (consecutive numbers, at most 8 steps).',
    '2. Body: one or two sentences explaining WHY, then the math of this step.',
    '   Use $...$ for inline math and $$...$$ for display math. Never wrap math in code fences.',
    '3. Highlight: wrap the term that CHANGES in this step in \\hl{...}, e.g. $\\hl{2x} = 6$. At most one per step.',
    '4. Graphics only when they really help:',
    '   · ```plot block for function graphs: f: a*x + 1 / domain: -5..5 / params: a = 1 (-5..5) / points: (2,5)',
    '   · ```figure block for plane geometry: A=(0,0)  B=(4,0) / segment A B / circle A 2 / polygon A B C / angle A B C',
    '   Inside these blocks use ONLY those directives — no SVG, HTML or JavaScript.',
    '5. Finish with `## Answer` and the conclusion (a formula is enough).',
    '',
    'No JSON, no wrapping the whole reply in a code fence, no small talk.',
    'If the problem statement is incomplete or the image is unreadable, say what is missing instead of inventing conditions.'
  ].join('\n')
}
