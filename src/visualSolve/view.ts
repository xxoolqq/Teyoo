// 可视化解题：整页标签页的视图与会话
// ─────────────────────────────────────────────────────────────────────────────
// 一个标签页做一件事：把一道题（文字 / 截图 / 正文选中）交给大模型，把它的分步
// 解答边流边渲染成卡片（公式走 math-engine，与正文同一套渲染），最后可以整段插入
// 正文或复制走。
//
// 与侧边栏助手的区别（也是单独开一条流的原因）：
//   · 助手是"改正文"，这里是"解题"——产出不自动落在文档上，由用户决定插不插；
//   · 助手只带选区/整篇当上下文；这里的输入是题目本身（还支持截图与追问）；
//   · 两边可以同时跑（IPC 按 channel 分成两条流，见 main/index.ts）。

import { renderMath } from '../renderer/math-engine'
import { isChinese } from '../renderer/ui-language'
import { parseGraphic, specKey, withParams, type GraphicSpec } from './graphics'
import { parseSolution, solutionToMarkdown, solverSystemPrompt } from './protocol'
import { figureTheme, renderGraphic, svgDataUrl } from './sandbox-bridge'
import { SOLVE_TEMPLATES, findTemplate } from './templates'
import type { SolveDocument, SolveGraphics, SolveStep, SolverAttachment } from './types'

/** 本模块用到的那一小块 electronAPI（结构类型：跨工程 import 会让 tsc 报 TS6307，
 *  与 assistant.ts 同一处理）。main.ts 传真实 window.electronAPI 进来。 */
interface SolverApi {
  visualSolveStream: (messages: SolverMessage[]) => Promise<{ ok: boolean; text?: string; error?: string }>
  visualSolveCancel: () => void
  onVisualSolveDelta: (callback: (payload: { text: string }) => void) => void
  ocrAssistantImage: (path: string) => Promise<{ ok: boolean; latex?: string; text?: string; error?: string }>
  pasteAssistantImage: (dataUrl: string) => Promise<{ path: string; name: string } | null>
  readImageAsDataUrl: (path: string) => Promise<{ path: string; dataUrl: string } | null>
  /** 历史（userData/visual-solve-history.json，最近 50 条） */
  visualSolveHistory: () => Promise<HistoryEntry[]>
  visualSolveHistoryAdd: (entry: HistoryEntry) => Promise<boolean>
  visualSolveHistoryClear: () => Promise<boolean>
  /** 存成 .md 文件（弹保存对话框） */
  visualSolveSave: (markdown: string, name?: string) => Promise<{ ok: boolean; path?: string; error?: string }>
}

/** 一条历史（形状与 preload 的 VisualSolveHistoryEntry 一致） */
interface HistoryEntry {
  id: string
  problem: string
  answer: string
  at: number
}

type SolverPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: Uint8Array }

interface SolverMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | SolverPart[]
}

/** 由 main.ts 注入：编辑器相关的动作（避免 visualSolve → main 的循环依赖） */
export interface VisualSolveHooks {
  /**
   * 把 Markdown 插到光标处（选区非空则替换）。
   * 返回 false = 没找到可插入的文档（main.ts 那侧会先切回文档标签页，
   * 实在没有就新建一个），界面据此说实话。
   */
  insertMarkdown?: (markdown: string) => boolean
  /** 读当前文档里选中的内容（"用正文选中内容"按钮） */
  readSelection?: () => string
  /** 写剪贴板 */
  copyText?: (text: string) => void
  /** 当前用哪个模型（偏好里取的展示名） */
  modelLabel?: () => string
}

let apiRef: SolverApi | null = null
let hooks: VisualSolveHooks = {}

// ── 会话状态 ──────────────────────────────────────────────────────────────
/** 对话历史（system + 题目 + 各轮回答），追问时整段带上 */
let conversation: SolverMessage[] = []
/** 本轮流式累积的原文 */
let buffer = ''
/** 解析出来的解题结果（每帧重算） */
let doc: SolveDocument = { intro: '', steps: [], answer: '', extra: [] }
/** 追问的回答累积在这里（与主体步骤分开显示） */
let followBuffer = ''
let followTitle = ''
let streaming = false
let streamKind: 'solve' | 'follow' | 'review' | null = null
/** 复核那次流式的累积（与解题步骤分开显示） */
let reviewBuffer = ''
/** 本次要发出去的消息（默认 = conversation；复核时换成"多带一句复核要求"的那份） */
let outbound: SolverMessage[] | null = null
let attachments: SolverAttachment[] = []
let renderQueued = false
/** 沙箱画好的图：specKey → data URL（插入正文时把指令换成图片；也避免重复画） */
const renderedGraphics = new Map<string, string>()
/** 步骤播放器：null = 显示全部；数字 = 只显示前 N 步 */
let revealed: number | null = null
let playTimer: number | null = null
/** 选中的题型模板（null = 不额外要求） */
let activeTemplateId: string | null = null
/** 历史（最近 50 条）与面板开合 */
let history: HistoryEntry[] = []
let historyOpen = false
/** 这一轮的题目原文（成功解题后连同结果一起存进历史） */
let lastProblem = ''

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  const node = el<HTMLParagraphElement>('solver-status')
  if (!node) return
  node.hidden = !text
  node.textContent = text
  node.classList.toggle('solver-status-error', kind === 'error' && !!text)
}

function errorText(code?: string): string {
  const zh = isChinese()
  if (!code) return zh ? '失败' : 'Failed'
  if (code === 'NO_API_KEY') return zh ? '没填 API Key（偏好设置 → 文档助手 → 可视化解题）' : 'No API key configured'
  if (code === 'BAD_BASE_URL') return zh ? 'Base URL 不是合法地址' : 'Invalid base URL'
  if (code === 'NO_MODEL') return zh ? '没填模型名' : 'No model configured'
  if (code === 'CANCELED' || code === 'ABORTED') return zh ? '已停止' : 'Stopped'
  if (code.startsWith('HTTP_401') || code.startsWith('HTTP_403')) return zh ? '鉴权失败：API Key 不对或没有权限' : 'Auth failed'
  if (code === 'TIMEOUT') return zh ? '超时了（题目太长或模型太慢）' : 'Timed out'
  return code
}

// ── 渲染：公式 + 轻量 Markdown ────────────────────────────────────────────
// 不做完整 Markdown（那是编辑器的活）：这里只认段落、列表、粗体、行内代码与公式，
// 够解题步骤用，而且流式过程中每帧重建也不卡。

function appendInline(parent: HTMLElement, text: string): void {
  let rest = text
  while (rest) {
    const math = /^\$([^$\n]+?)\$/.exec(rest)
    if (math) {
      parent.append(renderMath(math[1], false))
      rest = rest.slice(math[0].length)
      continue
    }
    const bold = /^\*\*([^*]+)\*\*/.exec(rest)
    if (bold) {
      const node = document.createElement('strong')
      node.textContent = bold[1]
      parent.append(node)
      rest = rest.slice(bold[0].length)
      continue
    }
    const code = /^`([^`]+)`/.exec(rest)
    if (code) {
      const node = document.createElement('code')
      node.textContent = code[1]
      parent.append(node)
      rest = rest.slice(code[0].length)
      continue
    }
    // 直到下一个特殊标记为止，都是纯文本
    const next = rest.slice(1).search(/[$*`]/)
    const chunk = next === -1 ? rest : rest.slice(0, next + 1)
    parent.append(document.createTextNode(chunk))
    rest = rest.slice(chunk.length)
  }
}

/** 把一段 Markdown 渲进容器：段落 / 列表 / 独立公式（$$…$$） */
export function renderRich(container: HTMLElement, markdown: string): void {
  container.replaceChildren()
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: HTMLUListElement | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const p = document.createElement('p')
    appendInline(p, paragraph.join(' ').trim())
    container.append(p)
    paragraph = []
  }
  const closeList = (): void => {
    list = null
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed.startsWith('$$')) {
      // 独立公式：可能跨行，直到收尾的 $$
      let latex = trimmed.replace(/^\$\$/, '')
      while (!latex.includes('$$') && index + 1 < lines.length) {
        index += 1
        latex += '\n' + lines[index]
      }
      latex = latex.replace(/\$\$\s*$/, '').trim()
      flushParagraph()
      closeList()
      if (latex) {
        const block = document.createElement('div')
        block.className = 'solver-math-block'
        block.append(renderMath(latex, true))
        container.append(block)
      }
      continue
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph()
      if (!list) {
        list = document.createElement('ul')
        container.append(list)
      }
      const item = document.createElement('li')
      appendInline(item, trimmed.replace(/^[-*+]\s+/, ''))
      list.append(item)
      continue
    }
    if (!trimmed) {
      flushParagraph()
      closeList()
      continue
    }
    paragraph.push(trimmed)
  }
  flushParagraph()
}

function imageFor(url: string, kind: 'plot' | 'figure'): HTMLImageElement {
  const img = document.createElement('img')
  img.className = 'solver-graphic-img'
  img.src = url
  img.alt = kind === 'figure' ? '几何图' : '函数图像'
  return img
}

/** 画一张图（带缓存）到指定区域；画不出来就把指令原文摆进去 */
async function paintGraphic(
  area: HTMLElement,
  spec: GraphicSpec,
  kind: 'plot' | 'figure',
  code: string
): Promise<void> {
  const zh = isChinese()
  const key = specKey(spec)
  const cached = renderedGraphics.get(key)
  if (cached) {
    area.replaceChildren(imageFor(cached, kind))
    return
  }
  const hint = document.createElement('div')
  hint.className = 'solver-graphic-head'
  hint.textContent = zh ? '正在画图…' : 'Drawing…'
  area.replaceChildren(hint)
  const result = await renderGraphic(spec, figureTheme())
  if (!result.ok || !result.svg) {
    const pre = document.createElement('pre')
    pre.textContent = code
    hint.textContent = zh ? '这张图没画出来（下面是指令原文）' : 'Could not draw this (directives below)'
    area.replaceChildren(hint, pre)
    return
  }
  const url = svgDataUrl(result.svg)
  renderedGraphics.set(key, url)
  area.replaceChildren(imageFor(url, kind))
}

/**
 * 图形指令 → 图。
 * 解析得出结构就交给沙箱画（function-plot / JSXGraph），回传的 SVG 用
 * `<img src="data:image/svg+xml…">` 显示（独立文档，安全且能原样插入正文）；
 * 解析不出或画失败，就把指令原文摆出来 —— 解题内容不受影响。
 *
 * 带自由参数的 plot 会多出一行滑块：拖动就地重画（"这个参数变大，图像怎么变"
 * 直接看得见）。滑块拖的是**参数值**，表达式本身不动，所以画出来的东西依旧
 * 是"受限指令"的产物。
 */
function renderGraphics(container: HTMLElement, blocks: SolveGraphics[]): void {
  for (const block of blocks) {
    const spec = parseGraphic(block.kind, block.code)
    const wrap = document.createElement('figure')
    wrap.className = 'solver-graphic'
    if (!spec) {
      const code = document.createElement('pre')
      code.textContent = block.code
      wrap.append(code)
      container.append(wrap)
      continue
    }
    const area = document.createElement('div')
    area.className = 'solver-graphic-area'
    wrap.append(area)
    container.append(wrap)

    if (spec.kind === 'plot' && spec.params.length) {
      const baseKey = specKey(spec)
      const values: Record<string, number> = {}
      for (const param of spec.params) values[param.name] = param.value
      const params = document.createElement('div')
      params.className = 'solver-params'
      let queued = false
      const repaint = (): void => {
        // 拖滑块会连发 input：合并到下一帧，别把沙箱打满
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
          queued = false
          const current = withParams(spec, values)
          void paintGraphic(area, current, 'plot', block.code).then(() => {
            // 插入正文用的是"当前这一刻"的图：基准 key 也跟着指过去
            const url = renderedGraphics.get(specKey(current))
            if (url) renderedGraphics.set(baseKey, url)
          })
        })
      }
      for (const param of spec.params) {
        const row = document.createElement('label')
        row.className = 'solver-param'
        const name = document.createElement('span')
        name.className = 'solver-param-name'
        name.textContent = param.name
        const range = document.createElement('input')
        range.type = 'range'
        range.min = String(param.min)
        range.max = String(param.max)
        range.step = String(Math.max((param.max - param.min) / 60, 0.001))
        range.value = String(param.value)
        const value = document.createElement('span')
        value.className = 'solver-param-value'
        const show = (): void => {
          value.textContent = String(Math.round((values[param.name] ?? 0) * 1000) / 1000)
        }
        range.addEventListener('input', () => {
          values[param.name] = Number(range.value)
          show()
          repaint()
        })
        show()
        row.append(name, range, value)
        params.append(row)
      }
      wrap.append(params)
      // 首帧也必须先把参数值代进去再画：直接画 spec 等于让 function-plot 求值一个
      // 未知符号 a（真机上就表现为首屏"这张图没画出来"，拖一下滑块图才出现）。
      repaint()
      continue
    }

    void paintGraphic(area, spec, block.kind, block.code)
  }
}

function renderSteps(): void {
  const host = el<HTMLDivElement>('solver-steps')
  if (!host) return
  const zh = isChinese()

  if (!doc.steps.length && !doc.answer && !doc.intro && !streaming) {
    host.replaceChildren()
    const empty = document.createElement('p')
    empty.className = 'solver-empty'
    empty.textContent = zh
      ? '把题目贴到上面的框里（也可以直接截图后 Ctrl+V），点「开始解题」。'
      : 'Paste a problem above (or Ctrl+V a screenshot), then press Solve.'
    host.append(empty)
    return
  }

  const frag = document.createDocumentFragment()

  if (doc.intro) {
    const intro = document.createElement('div')
    intro.className = 'solver-intro'
    renderRich(intro, doc.intro)
    frag.append(intro)
  }

  for (const step of visibleSteps()) {
    const card = document.createElement('section')
    card.className = 'solver-step'
    const head = document.createElement('div')
    head.className = 'solver-step-head'
    const badge = document.createElement('span')
    badge.className = 'solver-step-index'
    badge.textContent = String(step.index)
    const title = document.createElement('span')
    title.className = 'solver-step-title'
    title.textContent = step.title || (zh ? '（这一步）' : '(step)')
    head.append(badge, title)
    card.append(head)
    const body = document.createElement('div')
    body.className = 'solver-step-body'
    renderRich(body, step.body)
    card.append(body)
    if (step.graphics.length) renderGraphics(card, step.graphics)
    frag.append(card)
  }

  if (doc.answer && answerVisible()) {
    const answer = document.createElement('section')
    answer.className = 'solver-answer'
    const label = document.createElement('div')
    label.className = 'solver-answer-label'
    label.textContent = zh ? '答案' : 'Answer'
    const body = document.createElement('div')
    body.className = 'solver-answer-body'
    renderRich(body, doc.answer)
    answer.append(label, body)
    frag.append(answer)
  }

  for (const item of doc.extra) {
    const extra = document.createElement('section')
    extra.className = 'solver-extra'
    const label = document.createElement('div')
    label.className = 'solver-extra-label'
    label.textContent = item.title
    const body = document.createElement('div')
    renderRich(body, item.body)
    extra.append(label, body)
    frag.append(extra)
  }

  if (streaming) {
    const hint = document.createElement('div')
    hint.className = 'solver-streaming'
    hint.textContent = zh ? '正在解题…' : 'Solving…'
    frag.append(hint)
  }

  host.replaceChildren(frag)
  updatePlayer()
}

function scheduleRender(): void {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    if (streamKind === 'follow') {
      // 追问的回答直接合成一节 extra（连同用户那句问题一起显示）
      doc = { ...doc, extra: [...doc.extra.filter((item) => item.title !== followTitle), { title: followTitle, body: followBuffer }] }
    } else if (streamKind === 'review') {
      // 复核只更新它自己那张卡片，不动解题步骤
      renderReview(reviewBuffer)
      return
    } else {
      doc = parseSolution(buffer)
    }
    renderSteps()
  })
}

// ── 输入：题目（含截图）────────────────────────────────────────────────────
function renderAttachments(): void {
  const host = el<HTMLDivElement>('solver-attachments')
  if (!host) return
  host.replaceChildren()
  host.hidden = attachments.length === 0
  for (const item of attachments) {
    const chip = document.createElement('span')
    chip.className = 'solver-chip'
    chip.textContent = item.name
    chip.title = item.text ? item.text.slice(0, 200) : item.name
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'solver-chip-remove'
    remove.textContent = '✕'
    remove.addEventListener('click', () => {
      attachments = attachments.filter((each) => each !== item)
      renderAttachments()
    })
    chip.append(remove)
    host.append(chip)
  }
}

function dataUrlToPart(dataUrl: string): SolverPart | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(dataUrl.trim())
  if (!match) return null
  try {
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return { type: 'image', mime: match[1], data: bytes }
  } catch {
    return null
  }
}

/** 收一张题目截图：先识别（MinerU→本地 OCR），识别不出来就把原图带上让视觉模型看 */
async function acceptImageDataUrl(dataUrl: string): Promise<void> {
  const api = apiRef
  if (!api) return
  const zh = isChinese()
  setStatus(zh ? '识别题目图片…' : 'Reading the problem image…')
  const saved = await api.pasteAssistantImage(dataUrl)
  if (!saved?.path) {
    setStatus(zh ? '这张图片存不下来' : 'Could not save the image', 'error')
    return
  }
  let text = ''
  try {
    const recognized = await api.ocrAssistantImage(saved.path)
    text = recognized?.latex ? `$${recognized.latex}$` : (recognized?.text ?? '')
  } catch {
    /* 识别失败就只带原图 */
  }
  attachments = [...attachments, { path: saved.path, name: saved.name, text, dataUrl }]
  renderAttachments()
  setStatus('')
}

async function handlePaste(event: ClipboardEvent): Promise<void> {
  const items = event.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (!file) continue
    event.preventDefault()
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
    if (dataUrl) await acceptImageDataUrl(dataUrl)
    return
  }
}

// ── 解题 / 追问 ───────────────────────────────────────────────────────────
function buildProblemMessage(): SolverMessage | null {
  const input = el<HTMLTextAreaElement>('solver-input')
  const problem = input?.value.trim() ?? ''
  const parts: SolverPart[] = []
  const textSections: string[] = []
  if (problem) textSections.push(problem)
  for (const [index, item] of attachments.entries()) {
    const label = isChinese() ? `【题目图片 ${index + 1}】` : `[Problem image ${index + 1}]`
    textSections.push(item.text ? `${label}\n${item.text}` : label)
  }
  // 题型模板：把"按什么套路讲"补进这一轮的要求里（写进用户消息，不动系统提示词）
  const requirement = findTemplate(activeTemplateId)?.requirement
  if (requirement) textSections.push(isChinese() ? `【要求】${requirement}` : `[Requirement] ${requirement}`)
  const text = textSections.join('\n\n').trim()
  if (!text) return null
  lastProblem = text
  parts.push({ type: 'text', text })
  for (const item of attachments) {
    if (!item.dataUrl) continue
    const part = dataUrlToPart(item.dataUrl)
    if (part) parts.push(part)
  }
  return { role: 'user', content: parts.length > 1 ? parts : text }
}

async function startSolve(): Promise<void> {
  if (!apiRef || streaming) return
  const zh = isChinese()
  const message = buildProblemMessage()
  if (!message) {
    setStatus(zh ? '先写题目（或粘一张截图）' : 'Write the problem first', 'error')
    return
  }
  conversation = [{ role: 'system', content: solverSystemPrompt(zh) }, message]
  buffer = ''
  doc = { intro: '', steps: [], answer: '', extra: [] }
  // 新一轮解题：播放器归位（默认显示全部）
  stopPlay()
  revealed = null
  streamKind = 'solve'
  startStream()
}

async function askFollowUp(): Promise<void> {
  if (!apiRef || streaming) return
  const zh = isChinese()
  const input = el<HTMLInputElement>('solver-ask-input')
  const question = input?.value.trim() ?? ''
  if (!question) return
  if (!conversation.length) {
    setStatus(zh ? '还没有解题过程可以追问' : 'Nothing to ask about yet', 'error')
    return
  }
  if (input) input.value = ''
  conversation.push({ role: 'user', content: question })
  followTitle = question
  followBuffer = ''
  streamKind = 'follow'
  startStream()
}

/**
 * 「复核」：拿同一段对话再问一次，只让它查对错 —— 结果单独一张卡片，
 * 不改解题步骤。这是"正确性"这道保险里最实用的一环：模型自己找自己的错，
 * 比我们本地做符号验算（要引 CAS、还只覆盖很窄的题型）划算得多。
 */
const REVIEW_PROMPT_ZH = [
  '只看对错，不要重写解答。逐步检查上面的解题过程：',
  '· 哪一步错了：指出是第几步、错在哪、正确写法是什么；',
  '· 如果都对：一句话说明每步依据成立，并把最终答案复算一次。',
  '不要输出 JSON，也不要用代码块包裹。'
].join('\n')
const REVIEW_PROMPT_EN = [
  'Check, do not rewrite. Go through the solution above step by step:',
  '- If a step is wrong, say which step, what is wrong, and what the correct line is;',
  '- If everything is fine, say so in one sentence and re-check the final answer.',
  'No JSON, no code fences.'
].join('\n')

function renderReview(text: string): void {
  const host = el<HTMLDivElement>('solver-review')
  if (!host) return
  const zh = isChinese()
  host.hidden = !text.trim()
  if (!text.trim()) {
    host.replaceChildren()
    return
  }
  const label = document.createElement('div')
  label.className = 'solver-review-label'
  label.textContent = zh ? '复核' : 'Review'
  const body = document.createElement('div')
  body.className = 'solver-review-body'
  renderRich(body, text)
  host.replaceChildren(label, body)
}

async function reviewSolution(): Promise<void> {
  if (!apiRef || streaming) return
  const zh = isChinese()
  if (!conversation.length) {
    setStatus(zh ? '还没有解题过程可以复核' : 'Nothing to review yet', 'error')
    return
  }
  reviewBuffer = ''
  renderReview('')
  outbound = [...conversation, { role: 'user', content: zh ? REVIEW_PROMPT_ZH : REVIEW_PROMPT_EN }]
  streamKind = 'review'
  startStream()
}

function startStream(): void {
  const api = apiRef
  if (!api) return
  const zh = isChinese()
  streaming = true
  updateButtons()
  setStatus(zh ? '解题中…可以点「停止」' : 'Solving… you can stop it')
  scheduleRender()
  void api
    .visualSolveStream(outbound ?? conversation)
    .then((result) => {
      const stopped = result.error === 'CANCELED' || result.error === 'ABORTED'
      if (!result.ok && !stopped) {
        setStatus(errorText(result.error), 'error')
      } else if (stopped) {
        setStatus(zh ? '已停止' : 'Stopped')
      } else {
        setStatus('')
        // 记进历史：下一轮追问（或重新解题）才带着上下文
        conversation.push({
          role: 'assistant',
          content: result.text ?? (streamKind === 'follow' ? followBuffer : buffer)
        })
        // 一轮完整的解题才进历史（追问的回答不单独存）
        if (streamKind === 'solve') recordHistory()
      }
    })
    .catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    })
    .finally(() => {
      streaming = false
      streamKind = null
      outbound = null
      updateButtons()
      if (reviewBuffer) renderReview(reviewBuffer)
      scheduleRender()
    })
}

function stopStream(): void {
  apiRef?.visualSolveCancel()
}

function updateButtons(): void {
  const start = el<HTMLButtonElement>('solver-start-btn')
  const stop = el<HTMLButtonElement>('solver-stop-btn')
  if (start) {
    start.disabled = streaming
    start.textContent = streaming ? (isChinese() ? '解题中…' : 'Solving…') : (isChinese() ? '开始解题' : 'Solve')
  }
  if (stop) stop.hidden = !streaming
}

// ── 结果去向：插入正文 / 复制 / 清空 ──────────────────────────────────────
function currentMarkdown(): string {
  return solutionToMarkdown(doc, (graphic) => {
    const spec = parseGraphic(graphic.kind, graphic.code)
    return spec ? (renderedGraphics.get(specKey(spec)) ?? null) : null
  })
}

// ── 步骤播放器：逐步看（做题顺序）或一次看全（复习）─────────────────────────
function visibleSteps(): SolveStep[] {
  if (revealed === null) return doc.steps
  return doc.steps.slice(0, Math.max(revealed, 1))
}

function answerVisible(): boolean {
  return revealed === null || revealed >= doc.steps.length
}

function updatePlayer(): void {
  const total = doc.steps.length
  const bar = el<HTMLDivElement>('solver-player')
  if (bar) bar.hidden = total < 2
  const at = revealed === null ? total : Math.min(revealed, total)
  const progress = el<HTMLSpanElement>('solver-progress')
  if (progress) {
    progress.textContent = total
      ? isChinese()
        ? `第 ${Math.max(at, 1)} / ${total} 步`
        : `Step ${Math.max(at, 1)} / ${total}`
      : ''
  }
  const prev = el<HTMLButtonElement>('solver-prev-btn')
  if (prev) prev.disabled = total < 2 || (revealed !== null && revealed <= 1)
  const next = el<HTMLButtonElement>('solver-next-btn')
  if (next) next.disabled = total < 2 || revealed === null || revealed >= total
  const play = el<HTMLButtonElement>('solver-play-btn')
  if (play) {
    play.textContent =
      playTimer !== null ? (isChinese() ? '⏸ 暂停' : '⏸ Pause') : isChinese() ? '▶ 播放' : '▶ Play'
  }
}

function stopPlay(): void {
  if (playTimer !== null) {
    window.clearInterval(playTimer)
    playTimer = null
  }
}

function stepPlayer(step: 1 | -1 | 'all'): void {
  stopPlay()
  const total = doc.steps.length
  if (step === 'all') revealed = null
  else if (step === 1) revealed = revealed === null ? total : Math.min(revealed + 1, total)
  else revealed = revealed === null ? Math.max(total - 1, 1) : Math.max(revealed - 1, 1)
  // 走到最后一步就等于"看全"
  if (revealed !== null && revealed >= total) revealed = null
  renderSteps()
}

function togglePlay(): void {
  if (playTimer !== null) {
    stopPlay()
    updatePlayer()
    return
  }
  if (doc.steps.length < 2) return
  revealed = 1
  renderSteps()
  playTimer = window.setInterval(() => {
    const total = doc.steps.length
    const at = revealed ?? total
    if (at >= total) {
      stopPlay()
      revealed = null
      renderSteps()
      return
    }
    revealed = at + 1
    renderSteps()
  }, 1200)
  updatePlayer()
}

function insertToDocument(): void {
  const zh = isChinese()
  const markdown = currentMarkdown()
  if (!markdown) {
    setStatus(zh ? '还没有解题结果' : 'Nothing to insert', 'error')
    return
  }
  const inserted = hooks.insertMarkdown?.(markdown)
  setStatus(inserted === false ? (zh ? '没能插入：没有可编辑的文档标签页' : 'Nothing to insert into') : (zh ? '已插入到光标处' : 'Inserted at the cursor'))
}

function copyResult(): void {
  const zh = isChinese()
  const markdown = currentMarkdown()
  if (!markdown) {
    setStatus(zh ? '还没有解题结果' : 'Nothing to copy', 'error')
    return
  }
  hooks.copyText?.(markdown)
  setStatus(zh ? '已复制' : 'Copied')
}

function clearAll(): void {
  stopPlay()
  revealed = null
  historyOpen = false
  reviewBuffer = ''
  renderReview('')
  renderHistory()
  buffer = ''
  followBuffer = ''
  followTitle = ''
  attachments = []
  conversation = []
  doc = { intro: '', steps: [], answer: '', extra: [] }
  const input = el<HTMLTextAreaElement>('solver-input')
  if (input) input.value = ''
  renderAttachments()
  updateButtons()
  setStatus('')
  renderSteps()
}

function fromSelection(): void {
  const zh = isChinese()
  const text = hooks.readSelection?.() ?? ''
  const input = el<HTMLTextAreaElement>('solver-input')
  if (!input) return
  if (!text.trim()) {
    setStatus(zh ? '当前文档里没有选中内容' : 'Nothing selected in the document', 'error')
    return
  }
  input.value = text.trim()
  setStatus('')
}

// ── 题型模板 ─────────────────────────────────────────────────────────────
function renderTemplates(): void {
  const host = el<HTMLDivElement>('solver-templates')
  if (!host) return
  host.replaceChildren()
  for (const template of SOLVE_TEMPLATES) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'solver-template'
    chip.textContent = template.label
    chip.title = template.requirement
    chip.classList.toggle('active', activeTemplateId === template.id)
    chip.addEventListener('click', () => {
      activeTemplateId = activeTemplateId === template.id ? null : template.id
      renderTemplates()
    })
    host.append(chip)
  }
}

// ── 历史 ─────────────────────────────────────────────────────────────────
async function refreshHistory(): Promise<void> {
  const api = apiRef
  if (!api) return
  try {
    history = await api.visualSolveHistory()
  } catch {
    history = []
  }
  renderHistory()
}

function renderHistory(): void {
  const host = el<HTMLDivElement>('solver-history')
  if (!host) return
  host.hidden = !historyOpen
  if (!historyOpen) return
  host.replaceChildren()
  const zh = isChinese()
  const head = document.createElement('div')
  head.className = 'solver-history-head'
  const title = document.createElement('span')
  title.textContent = zh ? `解题历史（${history.length}）` : `History (${history.length})`
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'solver-btn'
  clear.textContent = zh ? '清空历史' : 'Clear'
  clear.addEventListener('click', () => {
    void apiRef?.visualSolveHistoryClear().then(() => refreshHistory())
  })
  head.append(title, clear)
  host.append(head)

  if (!history.length) {
    const empty = document.createElement('p')
    empty.className = 'solver-empty'
    empty.textContent = zh ? '还没有历史。解出的题会自动存最近 50 条。' : 'No history yet.'
    host.append(empty)
    return
  }
  for (const entry of history) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'solver-history-row'
    const label = document.createElement('span')
    label.className = 'solver-history-title'
    const firstLine = entry.problem.split('\n').find((line) => line.trim()) ?? entry.problem
    label.textContent = firstLine.slice(0, 80)
    const time = document.createElement('span')
    time.className = 'solver-history-time'
    time.textContent = new Date(entry.at).toLocaleString()
    row.append(label, time)
    row.addEventListener('click', () => restoreHistory(entry))
    host.append(row)
  }
}

/** 把一条历史载回面板：题目、结果、对话上下文都恢复，接着追问也成立 */
function restoreHistory(entry: HistoryEntry): void {
  stopPlay()
  revealed = null
  buffer = entry.answer
  doc = parseSolution(buffer)
  lastProblem = entry.problem
  conversation = [
    { role: 'system', content: solverSystemPrompt(isChinese()) },
    { role: 'user', content: entry.problem },
    { role: 'assistant', content: entry.answer }
  ]
  const input = el<HTMLTextAreaElement>('solver-input')
  if (input) input.value = entry.problem
  historyOpen = false
  renderHistory()
  renderSteps()
  setStatus(isChinese() ? '已载入历史记录' : 'Loaded from history')
}

function recordHistory(): void {
  const api = apiRef
  if (!api || !buffer.trim()) return
  const entry: HistoryEntry = {
    id: `s${Date.now()}`,
    problem: lastProblem || (el<HTMLTextAreaElement>('solver-input')?.value ?? ''),
    answer: buffer,
    at: Date.now()
  }
  void api.visualSolveHistoryAdd(entry).then(() => refreshHistory())
}

// ── 保存为 .md ───────────────────────────────────────────────────────────
async function saveToFile(): Promise<void> {
  const api = apiRef
  const zh = isChinese()
  if (!api) return
  const markdown = currentMarkdown()
  if (!markdown) {
    setStatus(zh ? '还没有解题结果' : 'Nothing to save', 'error')
    return
  }
  const firstLine = (lastProblem.split('\n').find((line) => line.trim()) ?? '可视化解题').slice(0, 40)
  const result = await api.visualSolveSave(markdown, `${firstLine}.md`)
  if (result.ok) setStatus(zh ? `已保存：${result.path ?? ''}` : `Saved: ${result.path ?? ''}`)
  else if (result.error !== 'CANCELED') setStatus(result.error ?? 'SAVE_FAILED', 'error')
}

// ── 初始化与标签页进出 ───────────────────────────────────────────────────
export function initVisualSolve(api: SolverApi, viewHooks: VisualSolveHooks = {}): void {
  apiRef = api
  hooks = viewHooks
  el<HTMLTextAreaElement>('solver-input')?.addEventListener('paste', (event) => {
    void handlePaste(event)
  })
  el<HTMLButtonElement>('solver-start-btn')?.addEventListener('click', () => void startSolve())
  el<HTMLButtonElement>('solver-stop-btn')?.addEventListener('click', () => stopStream())
  el<HTMLButtonElement>('solver-from-doc-btn')?.addEventListener('click', () => fromSelection())
  el<HTMLButtonElement>('solver-ask-btn')?.addEventListener('click', () => void askFollowUp())
  el<HTMLInputElement>('solver-ask-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void askFollowUp()
  })
  el<HTMLButtonElement>('solver-insert-btn')?.addEventListener('click', () => insertToDocument())
  el<HTMLButtonElement>('solver-copy-btn')?.addEventListener('click', () => copyResult())
  el<HTMLButtonElement>('solver-clear-btn')?.addEventListener('click', () => clearAll())
  el<HTMLButtonElement>('solver-play-btn')?.addEventListener('click', () => togglePlay())
  el<HTMLButtonElement>('solver-prev-btn')?.addEventListener('click', () => stepPlayer(-1))
  el<HTMLButtonElement>('solver-next-btn')?.addEventListener('click', () => stepPlayer(1))
  el<HTMLButtonElement>('solver-all-btn')?.addEventListener('click', () => stepPlayer('all'))
  el<HTMLButtonElement>('solver-save-btn')?.addEventListener('click', () => void saveToFile())
  el<HTMLButtonElement>('solver-review-btn')?.addEventListener('click', () => void reviewSolution())
  el<HTMLButtonElement>('solver-history-btn')?.addEventListener('click', () => {
    historyOpen = !historyOpen
    renderHistory()
  })
  api.onVisualSolveDelta((payload) => {
    if (streamKind === 'follow') followBuffer += payload.text
    else if (streamKind === 'review') reviewBuffer += payload.text
    else buffer += payload.text
    scheduleRender()
  })
  renderAttachments()
  renderTemplates()
  void refreshHistory()
  updateButtons()
  renderSteps()
}

/** 切进可视化解题标签页：外壳换成整页解题界面 */
export function enterSolverTabChrome(): void {
  document.body.classList.add('solver-view')
  const panel = el('solver-panel')
  if (panel) panel.hidden = false
  const model = el<HTMLSpanElement>('solver-model')
  if (model) model.textContent = hooks.modelLabel?.() ?? ''
  updateButtons()
  renderSteps()
}

/** 切走：收起面板并停掉正在跑的那条流（不然它会在后台继续烧 token） */
export function leaveSolverTab(): void {
  if (streaming) stopStream()
  stopPlay()
  document.body.classList.remove('solver-view')
  const panel = el('solver-panel')
  if (panel) panel.hidden = true
}

export function isSolverStreaming(): boolean {
  return streaming
}
