// 文档助手侧边栏（大语言模型）。
//
// 闭环始终是「先预览再应用」：
//   上下文（选区 / 当前段落 / 整篇）+ 一句指令
//   → 主进程流式调 OpenAI 兼容端点（分片经 assistant-delta 回推，边收边显示）
//   → 产出一律先落进「建议卡片」（默认显示**差异**：- 原文 / + 建议）
//   → 用户点「应用」才写进正文。
//   模型输出永远不会未经确认地改到用户的文档。
//
// 应用路径按上下文范围分流（都要经过编辑器自己的 remark 管线）：
//   选区   → insertMarkdownAtCursor（替换选区）
//   段落   → replaceCurrentBlockMarkdown（替换光标所在的那个顶层块）
//   整篇   → hooks.applyDocument（main.ts 那边走 setMarkdown，可撤销）
//
// 「能不能用」（非文档标签页 / 源码模式）与「应用之后做什么」（标脏、刷大纲）由
// main.ts 经 hooks 注入 —— 与 pdf-view / image-view 同一个套路，避免反向依赖。

import {
  clearAssistantProposal,
  clearSelectionOrBlock,
  getEditorView,
  getMarkdown,
  getSelectionMarkdown,
  insertMarkdownAtCursor,
  parseMarkdownToNodes,
  replaceCurrentBlockMarkdown,
  showAssistantContextMark,
  showAssistantProposal
} from './editor/editor'
import { analyzeAnswer, capabilitySpec, describeStructure, normalizeAnswer, scanContext } from './assistant-syntax'
import { fromFileUrl } from '../extensions/image-style/lib'
import { isChinese } from './ui-language'

/**
 * 一轮对话消息。形状与 preload 的 AssistantMessage 一致 —— 跨工程不 import，
 * 靠结构类型兼容地传给 IPC。
 */
/**
 * OpenAI 兼容的多模态分片。
 * `image_url` 是最终线上格式（主进程用）；渲染端发图统一用二进制分片 `image`
 * —— 几万字符的 base64 在提示词和 IPC 里来回搬没有意义，解成字节更小，
 * 也让"base64 → data URL"的转换只发生在主进程一处（见 llm.ts 的 toWireMessages）。
 */
type AssistantContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'image'; mime: string; data: Uint8Array }

interface AssistantMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | AssistantContentPart[]
}

/**
 * 助手用到的那一小块 electronAPI（结构类型）。
 * 不 import preload 工程里的 ElectronAPI：renderer 工程不含 src/preload，
 * 引入会报 TS6307；main.ts 传真实 ElectronAPI 进来，结构上是满足的。
 */
interface AssistantApi {
  assistantStream: (messages: AssistantMessage[]) => Promise<{ ok: boolean; text?: string; error?: string }>
  /** 非流式（"图片转公式"用这个：一次要一个短结果，不需要边收边看） */
  assistantComplete?: (messages: AssistantMessage[]) => Promise<{ ok: boolean; text?: string; error?: string }>
  assistantCancel: () => void
  onAssistantDelta: (callback: (payload: { text: string }) => void) => void
  /** 读一张本地图片为 data URL（正文里选中的图片要交给识别链时用） */
  readImageAsDataUrl: (path: string) => Promise<{ path: string; dataUrl: string } | null>
  /** 附件：主进程把文件转成文本（图片 OCR / pdf MinerU / docx 本地转换 / md 直读） */
  pickAssistantAttachment: () => Promise<AssistantAttachment[]>
  ocrAssistantImage: (path: string) => Promise<AssistantOcrResult>
  pasteAssistantImage: (dataUrl: string) => Promise<AssistantAttachment | null>
}

/** 与 preload 的 AssistantAttachment 结构一致（同上面一个理由：不跨工程 import） */
interface AssistantAttachment {
  path: string
  name: string
  kind: 'image' | 'text' | 'unsupported'
  text?: string
  dataUrl?: string
  latex?: string
  source?: string
  error?: string
  bytes?: number
  truncated?: boolean
}

interface AssistantOcrResult {
  ok: boolean
  latex?: string
  text?: string
  source?: string
  error?: string
}

export interface AssistantHooks {
  /** 当前标签页能不能用助手；缺省视为可用 */
  isAvailable?: () => boolean
  /** 不可用时给用户看的理由（显示在上下文那一行） */
  unavailableReason?: () => string
  /** 整篇应用：main.ts 用编辑器自己的 setMarkdown（单步可撤销） */
  applyDocument?: (markdown: string) => void
  /** 内容真的写进文档之后（main.ts 用它标脏 / 刷大纲 / 更新字数） */
  onApplied?: () => void
  /** 点了侧边栏的收起按钮：main.ts 把 assistant.sidebarOpen 写回 false */
  onRequestClose?: () => void
}

/** 只保留最近这么多条消息（user+assistant 各算一条，8 轮 = 16 条） */
const MAX_HISTORY_MESSAGES = 16
/** 整篇上下文的字符上限：再长就该用选区了（成本与上下文窗口都吃不消） */
const MAX_DOCUMENT_CHARS = 40_000
/** 差异表超过这么多行就不算了（大文档纯展示，别卡界面） */
const MAX_DIFF_LINES = 400

type Scope = 'auto' | 'document'
type ContextKind = 'selection' | 'block' | 'document'

let hooks: AssistantHooks = {}
let apiRef: AssistantApi | null = null
/** 已经成功的对话轮次（失败的不进上下文，免得把报错喂回去） */
let conversation: AssistantMessage[] = []
let busy = false
let scope: Scope = 'auto'
let contextTimer: ReturnType<typeof setTimeout> | null = null
/** 正在流式接收时，分片往哪个气泡里追加 */
let streamTarget: HTMLElement | null = null
let streamText = ''

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function texts(): Record<string, string> {
  const zh = isChinese()
  return {
    placeholder: zh ? '例如：把选中的内容改写成简洁的学术表达' : 'e.g. rewrite the selection in a concise academic tone',
    send: zh ? '发送' : 'Send',
    stop: zh ? '停止' : 'Stop',
    sending: zh ? '生成中…' : 'Generating…',
    stopped: zh ? '已停止生成' : 'Stopped',
    emptyState: zh
      ? '选中一段文字（或把光标放进某一段），写下要它怎么改，点「发送」。\n建议会先显示在这里，你确认后才写进文档。'
      : 'Select some text (or put the cursor in a paragraph), describe the change, and hit Send.\nThe suggestion appears here first — nothing touches your document until you apply it.',
    scopeAuto: zh ? '自动' : 'Auto',
    scopeDocument: zh ? '整篇' : 'Whole doc',
    contextSelection: zh ? '选区' : 'selection',
    contextBlock: zh ? '当前段落' : 'paragraph',
    contextDocument: zh ? '整篇文档' : 'whole document',
    contextNone: zh ? '无内容（把光标放进文档里）' : 'nothing (put the cursor in the document)',
    proposalLabelEditing: zh ? '建议内容' : 'Suggestion',
    applySelection: zh ? '替换选中内容' : 'Replace selection',
    applyBlock: zh ? '替换当前段落' : 'Replace paragraph',
    applyDocument: zh ? '替换整篇文档' : 'Replace document',
    discard: zh ? '丢弃' : 'Discard',
    applied: zh ? '已应用到文档' : 'Applied to the document',
    discarded: zh ? '已丢弃' : 'Discarded',
    appliedStopped: zh ? '已应用（生成被中断，内容是截断的）' : 'Applied (generation was cut short)',
    rawLabel: zh ? '原文' : 'Raw',
    diffLabel: zh ? '差异' : 'Diff',
    diffTooLong: zh ? '（内容较长，直接看原文）' : ' (too long for a diff — showing raw)',
    noInstruction: zh ? '先写一句要它做什么' : 'Describe what you want first',
    documentTooLong: zh ? '整篇太长了，请改用选区/段落，或先把文档拆小' : 'The document is too long — use a selection or a paragraph instead',
    chars: zh ? '字' : 'chars',
    close: zh ? '收起侧边栏' : 'Hide sidebar'
  }
}

// ── 上下文 ──────────────────────────────────────────────────────────────

/** 识别来源的展示名（识别完在状态条上说明白这次是谁干的） */
const SOURCE_LABEL: Record<string, string> = {
  mineru: 'MinerU',
  simpletex: '本地 OCR',
  model: '大模型'
}

/**
 * 指令是不是在问"这张图"（"把图片 ocr 识别转化成 latex 公式"这种）。
 * 命中时：这一轮带的如果只有图片，就走附件那套识别（MinerU 优先），而不是让
 * 视觉小模型去"看一眼然后猜"。
 */
function asksAboutImage(instruction: string): boolean {
  return /图|公式|latex|识别|ocr/i.test(instruction)
}

/** markdown 去掉图片引用与标记符号后什么都不剩 = 这一轮带的"只有图片" */
function isOnlyImages(markdown: string): boolean {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[\s>*#~`_|-]/g, '') === ''
}

/**
 * 发给模型的**文本**里，把内嵌图片的 data URL 缩成占位。
 *
 * 图片本体改走图片分片（二进制）递过去，所以这里只剩一句话的占位 —— 否则上下文里
 * 会挂着一串几万字符的 base64：白烧 token，卡片"原文"栏也会变成满屏 base64。
 * `recognized` 用来把话说明白（识别成功 → 已识别；没识别出来 → 见附图）。
 */
function shrinkInlineImages(markdown: string, recognized: boolean): string {
  const hint = recognized ? '已识别' : '见附图'
  return markdown.replace(/!\[([^\]]*)\]\(data:image\/[^)]*\)/g, (_match, alt: string) => `![${alt || '图片'}](${hint})`)
}

/** data URL → 二进制图片分片（转不动就返回 null，那一张就不带了） */
function toImagePart(dataUrl: string): AssistantContentPart | null {
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

interface ContextInfo {
  markdown: string
  kind: ContextKind
  /** 正文里的区间，用于"就地预览"（整篇范围没有可标的区间，给 0/0） */
  from: number
  to: number
  /**
   * 选区（或光标所在块）里那些图片。
   *
   * 为什么要有：模型拿到的是 Markdown 文本，图片在里面只是 `![…](D:\…\x.png)`
   * 或一大坨 base64 —— 它看不到像素，所以"把选中的图片识别成公式"必须由我们先识别
   * 成 LaTeX 再带过去（识别不出来时把原图作为 image_url 直传，见 send()）。
   */
  images: SelectedImage[]
}

/**
 * 选区里的一张图。两种形态都要认：
 *   · 文件图（从磁盘选的）→ 有路径，OCR 链能直接读
 *   · **内嵌图**（粘贴的截图、从 docx/图片转md 来的图都是 `data:` 开头）→ 没有路径，
 *     但 data URL 本身就是图，可以直接递给视觉模型
 * 早先只认路径、把内嵌图跳过了 —— 真机上就出过事：模型只看到一坨 base64，
 * 于是"凭记忆"编了个最有名的公式（用户要 b³ 那条，它给了求根公式）。
 */
interface SelectedImage {
  path?: string
  dataUrl?: string
}

/** 把选区里的图片节点收集起来（最多几张，别把几十张图一次全送去识别） */
function collectSelectedImages(from: number, to: number, limit = 3): SelectedImage[] {
  const view = getEditorView()
  if (!view) return []
  const found: SelectedImage[] = []
  view.state.doc.nodesBetween(from, to, (node) => {
    if (node.type.name !== 'image') return
    const src = String(node.attrs?.src ?? '')
    if (src.startsWith('data:image/')) {
      if (!found.some((item) => item.dataUrl === src)) found.push({ dataUrl: src })
      return
    }
    const path = fromFileUrl(src)
    if (path && !found.some((item) => item.path === path)) found.push({ path })
  })
  return found.slice(0, limit)
}

/** 这一轮要带上什么：整篇（若选了）或选区/光标所在块 */
function currentContext(): ContextInfo {
  if (scope === 'document') {
    // 整篇范围也带上图（最多 3 张）：用户常常是"整篇 + 指一张图"，不给图模型同样看不到
    const view = getEditorView()
    const images = view ? collectSelectedImages(0, view.state.doc.content.size) : []
    return { markdown: getMarkdown(), kind: 'document', from: 0, to: 0, images }
  }
  const view = getEditorView()
  if (!view) return { markdown: '', kind: 'block', from: 0, to: 0, images: [] }
  const { selection } = view.state
  if (!selection.empty) {
    return {
      markdown: getSelectionMarkdown(),
      kind: 'selection',
      from: selection.from,
      to: selection.to,
      images: collectSelectedImages(selection.from, selection.to)
    }
  }
  // 空选区：区间取光标所在的那个顶层块（与 getSelectionMarkdown 的降级一致）
  const $from = selection.$from
  const hasBlock = $from.depth > 0
  const from = hasBlock ? $from.before(1) : 0
  const to = hasBlock ? $from.after(1) : 0
  return {
    markdown: getSelectionMarkdown(),
    kind: 'block',
    from,
    to,
    images: hasBlock ? collectSelectedImages(from, to) : []
  }
}

// ── 「这一轮会带上的选区」在正文里一直亮着 ─────────────────────────────
// 点进输入框写指令时，编辑器的原生选区高亮会消失（焦点进了 textarea，DOM 选区被
// 清，加上 PM 的 ProseMirror-hideselection），用户就看不见自己选的是哪一段。这里
// 用装饰器接手：焦点在侧边栏就亮、回到编辑器就撤（那时原生高亮自己就回来了）。
// 只在**非空选区**时亮 —— 光标停在一段里那种（整段作为上下文）满段变色太吵。

/** 当前亮着的区间（null = 没亮）：用来跳过重复的 dispatch */
let contextMarkRange: { from: number; to: number } | null = null

/** 按当前状态重算一次（幂等：状态没变就什么都不派） */
function applyContextMark(): void {
  const selection = getEditorView()?.state.selection
  const available = !hooks.isAvailable || hooks.isAvailable()
  const next =
    available && selection && !selection.empty ? { from: selection.from, to: selection.to } : null
  if (next && contextMarkRange && next.from === contextMarkRange.from && next.to === contextMarkRange.to) return
  if (!next && !contextMarkRange) return
  contextMarkRange = next
  showAssistantContextMark(next)
}

/** 焦点回到编辑器 / 收起侧边栏：撤掉 */
function hideContextMark(): void {
  if (!contextMarkRange) return
  contextMarkRange = null
  showAssistantContextMark(null)
}

function updateContextLabel(): void {
  const label = el('assistant-context')
  if (!label) return
  const text = texts()
  if (hooks.isAvailable && !hooks.isAvailable()) {
    label.textContent = hooks.unavailableReason?.() ?? ''
    label.title = label.textContent
    return
  }
  // 这个标签只是提示，但要算它就得序列化文档 —— 绝不能让它把调用方带崩。
  // 真机上就发生过：这里抛出的异常顺着 setAssistantOpen ← updatePanelVisibility
  // 一路抛穿「文件 → 打开」的 IPC 回调，导致选了文件也打不开。
  let context: ContextInfo
  try {
    context = currentContext()
  } catch {
    label.textContent = text.contextNone
    label.title = ''
    return
  }
  const { markdown, kind } = context
  const trimmed = markdown.trim()
  if (!trimmed) {
    label.textContent = text.contextNone
  } else {
    const kindLabel =
      kind === 'selection' ? text.contextSelection : kind === 'document' ? text.contextDocument : text.contextBlock
    label.textContent = `${kindLabel} · ${trimmed.length} ${text.chars}`
  }
  label.title = label.textContent
}

// ── 行级差异（LCS） ─────────────────────────────────────────────────────

interface DiffLine {
  type: 'same' | 'add' | 'remove'
  text: string
}

function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.replace(/\s+$/, '').split('\n')
  const b = after.replace(/\s+$/, '').split('\n')
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'remove', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ type: 'remove', text: a[i++] })
  while (j < b.length) out.push({ type: 'add', text: b[j++] })
  return out
}

// ── 消息渲染 ────────────────────────────────────────────────────────────

function setStatus(text: string): void {
  const node = el('assistant-status')
  if (node) node.textContent = text
}

function setBusy(next: boolean): void {
  busy = next
  const button = el<HTMLButtonElement>('assistant-send-btn')
  if (button) {
    button.textContent = next ? texts().stop : texts().send
    button.classList.toggle('is-stopping', next)
    // 流式期间按钮是「停止」而不是禁用 —— 点它就是中断
    button.disabled = false
  }
  if (!next) streamTarget = null
  if (next) scrollToBottom()
}

function scrollToBottom(): void {
  const list = el('assistant-messages')
  if (list) list.scrollTop = list.scrollHeight
}

function clearEmptyState(): void {
  el('assistant-messages')?.querySelector('.assistant-empty')?.remove()
}

function appendBubble(text: string, className: string): HTMLElement | null {
  const list = el('assistant-messages')
  if (!list) return null
  clearEmptyState()
  const node = document.createElement('div')
  node.className = `assistant-msg ${className}`
  node.textContent = text
  list.append(node)
  scrollToBottom()
  return node
}

function removeBubble(node: HTMLElement | null): void {
  node?.remove()
}

interface AnswerNotes {
  /** 解析后的结构摘要（分栏(2 栏) / 图片·浮动右…）——从节点生成，不靠模型自述 */
  structure: string[]
  /** 我们自动处理掉的（例如把模型改坏的图片路径还原） */
  repairs: string[]
  /** 需要用户自己注意的 */
  warnings: string[]
  /** 空内容（"把这段删掉"的正确答案就是空）：应用后会清空这段 */
  cleared: boolean
}

/**
 * 把模型输出整理成"可以直接应用"的正文，并算好卡片要提示什么。
 *
 * 三步都在模型之外（所以换任何模型行为一致）：
 *   规范化（宽容：剥代码块、去开场白）→ 校验/回填（严格：挡臆造语法、还原图片路径）
 *   → 用**解析后的节点**生成结构摘要。
 */
function prepareAnswer(raw: string, contextMarkdown: string): { markdown: string; notes: AnswerNotes } {
  const zh = isChinese()
  const analyzed = analyzeAnswer(normalizeAnswer(raw), scanContext(contextMarkdown), zh)
  return {
    markdown: analyzed.markdown,
    notes: {
      structure: describeStructure(parseMarkdownToNodes(analyzed.markdown), zh),
      repairs: analyzed.repairs,
      warnings: analyzed.warnings,
      // 模型回空 = 要求清空这段（不是失败，见 assistant-syntax.ts 的 EMPTY_SENTINEL）
      cleared: analyzed.markdown.trim() === ''
    }
  }
}

/**
 * 建议卡片：差异 / 原文两个视图 + 应用 / 丢弃。
 * `context` 是这次请求带的上下文 —— markdown 用来算差异，kind 决定应用路径与按钮
 * 文案，from/to 用来在正文里就地标出"这段会被替换"（P3）。
 * `notes` 是校验/回填的结果（模型无关的那一层的产出）。
 */
function appendProposal(markdown: string, context: ContextInfo, notes: AnswerNotes): void {
  const { markdown: original, kind } = context
  // 建议自己有正文高亮（原文划掉 + 建议），跟"上下文高亮"叠在同一段上会很糊：
  // 建议一到就让位。
  hideContextMark()
  const list = el('assistant-messages')
  if (!list) return
  clearEmptyState()
  const text = texts()

  const card = document.createElement('div')
  card.className = 'assistant-proposal'

  const label = document.createElement('div')
  label.className = 'assistant-proposal-label'
  const labelText = document.createElement('span')
  labelText.textContent = text.proposalLabelEditing
  const tabs = document.createElement('span')
  tabs.className = 'assistant-proposal-tabs'
  const diffBtn = document.createElement('button')
  diffBtn.type = 'button'
  diffBtn.textContent = text.diffLabel
  const rawBtn = document.createElement('button')
  rawBtn.type = 'button'
  rawBtn.textContent = text.rawLabel
  tabs.append(diffBtn, rawBtn)
  label.append(labelText, tabs)

  const body = document.createElement('div')
  body.className = 'assistant-proposal-body'

  const lines = diffLines(original, markdown)
  const showDiff = (): void => {
    body.replaceChildren()
    body.className = 'assistant-diff'
    if (!lines) {
      const pre = document.createElement('pre')
      pre.className = 'assistant-diff-line'
      pre.textContent = markdown
      body.append(pre)
      labelText.textContent = text.proposalLabelEditing + text.diffTooLong
    } else {
      for (const line of lines) {
        const row = document.createElement('div')
        row.className = `assistant-diff-line assistant-diff-${line.type}`
        row.textContent = `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '} ${line.text}`
        body.append(row)
      }
    }
    diffBtn.classList.add('is-active')
    rawBtn.classList.remove('is-active')
  }
  const showRaw = (): void => {
    body.replaceChildren()
    body.className = 'assistant-proposal-body'
    const pre = document.createElement('pre')
    pre.className = 'assistant-proposal-body'
    pre.textContent = markdown
    body.append(pre)
    rawBtn.classList.add('is-active')
    diffBtn.classList.remove('is-active')
  }
  diffBtn.addEventListener('click', showDiff)
  rawBtn.addEventListener('click', showRaw)
  showDiff()

  // 校验/回填的结果：写什么结构、我替你改了什么、有什么要你留意。
  // 这几行是"不靠模型自述"的 —— 结构摘要由解析出的节点生成。
  const notesBox = document.createElement('div')
  notesBox.className = 'assistant-proposal-notes'
  const addNote = (kindName: string, content: string): void => {
    const row = document.createElement('div')
    row.className = `assistant-note is-${kindName}`
    row.textContent = content
    notesBox.append(row)
  }
  if (notes.cleared) {
    addNote(
      'structure',
      isChinese()
        ? '模型返回了空内容 → 应用后会清空这段（不是出错，"删掉这段"的正确答案就是空）'
        : 'Empty answer → applying clears this range (not an error: "delete this" yields nothing)'
    )
  } else if (notes.structure.length > 0) {
    addNote('structure', (isChinese() ? '将写入：' : 'Will write: ') + notes.structure.join(' / '))
  }
  for (const item of notes.repairs) addNote('fix', `✓ ${item}`)
  for (const item of notes.warnings) addNote('warn', `⚠ ${item}`)

  const actions = document.createElement('div')
  actions.className = 'assistant-proposal-actions'
  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.className = 'assistant-apply'
  // 按钮标签统一成「接受 / 丢弃」两枚（用户明确要求）；具体会做什么放 tooltip。
  applyBtn.textContent = isChinese() ? '接受' : 'Accept'
  applyBtn.title = kind === 'document' ? text.applyDocument : kind === 'selection' ? text.applySelection : text.applyBlock
  const discardBtn = document.createElement('button')
  discardBtn.type = 'button'
  discardBtn.textContent = text.discard

  const finish = (message: string): void => {
    actions.remove()
    const done = document.createElement('div')
    done.className = 'assistant-proposal-done'
    done.textContent = message
    card.append(done)
  }

  applyBtn.addEventListener('click', () => {
    if (hooks.isAvailable && !hooks.isAvailable()) {
      setStatus(hooks.unavailableReason?.() ?? '')
      return
    }
    let written = true
    try {
      if (!markdown.trim()) {
        // 空内容 = 删掉这段/整篇（"把这段删掉"的正确答案本来就是空）
        if (kind === 'document') hooks.applyDocument?.('')
        else clearSelectionOrBlock()
      } else if (kind === 'document') hooks.applyDocument?.(markdown)
      else if (kind === 'block') written = replaceCurrentBlockMarkdown(markdown)
      else written = insertMarkdownAtCursor(markdown)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
      return
    }
    // 编辑器那边一节点都没解析出来时别谎报成功（实测模型给的 $$…aligned…$$ 会解析失败）
    if (!written) {
      setStatus(
        isChinese()
          ? '没能写进正文：这段内容解析不出来（公式建议改成简单的 $…$ / $$…$$，别用 aligned 环境）'
          : 'Could not write into the document: the content did not parse'
      )
      return
    }
    hooks.onApplied?.()
    // 正文里那处预览跟着消失：同一次操作的两半，别让它留在文档上
    clearAssistantProposal()
    setStatus('')
    updateContextLabel()
    finish(text.applied)
  })
  discardBtn.addEventListener('click', () => {
    clearAssistantProposal()
    finish(text.discarded)
  })

  actions.append(applyBtn, discardBtn)
  card.append(label, body)
  if (notesBox.childElementCount > 0) card.append(notesBox)
  card.append(actions)
  list.append(card)
  // P3：正文里也标出来 —— 原文划掉、建议就地显示（带「接受」按钮）。整篇范围没有
  // 可标的区间，那就只在侧边栏看差异。
  if (kind !== 'document' && context.from < context.to) {
    showAssistantProposal({
      from: context.from,
      to: context.to,
      markdown,
      onAccepted: () => {
        // 走的是正文里那个「接受」：文档已经由插件在同一个事务里替换好了，
        // 这里只收尾卡片与外部状态（标脏/刷大纲）。
        hooks.onApplied?.()
        setStatus('')
        finish(text.applied)
      },
      onRejected: () => {
        // 正文里点「丢弃」= 丢掉这处建议（与侧边栏「丢弃」同义，正文不动）
        finish(text.discarded)
      }
    })
  }
  scrollToBottom()
}

function errorText(error?: string): string {
  const zh = isChinese()
  const value = error ?? ''
  if (value === 'NO_API_KEY') return zh ? '还没填 API Key（偏好设置 → 文档助手）' : 'No API key (Preferences → Assistant)'
  if (value === 'BAD_BASE_URL') return zh ? 'Base URL 填得不对（偏好设置 → 文档助手）' : 'Invalid Base URL (Preferences → Assistant)'
  if (value === 'NO_MODEL') return zh ? '还没填模型名（偏好设置 → 文档助手）' : 'No model configured (Preferences → Assistant)'
  if (value === 'TIMEOUT') return zh ? '请求超时：模型没在时限内继续返回' : 'Timed out waiting for the model'
  if (value.startsWith('HTTP_401') || value.startsWith('HTTP_403')) {
    return zh ? `鉴权失败（${value.slice(0, 8)}）：API Key 不对或没有权限` : `Auth failed (${value.slice(0, 8)}): bad key or no permission`
  }
  if (value.startsWith('HTTP_404')) {
    return zh ? '端点不存在（HTTP 404）：检查 Base URL 要不要带 /v1' : 'Endpoint not found (HTTP 404): check whether the Base URL needs /v1'
  }
  if (value.startsWith('HTTP_429')) return zh ? '被限流了（HTTP 429），稍后再试' : 'Rate limited (HTTP 429), try again later'
  if (value === 'EMPTY_RESPONSE') return zh ? '模型返回了空内容' : 'The model returned nothing'
  return value || (zh ? '调用失败' : 'Request failed')
}

// ── 发送（流式） ────────────────────────────────────────────────────────

// ─── 附件（图片 / 文件 → 文本）─────────────────────────────────────────
// 附件一律先转成**文本**再进对话：图片走 OCR、pdf 走 MinerU、docx 本地转换、md/txt 直读
// （主进程 assistant-attach.ts）。这样换任何文本模型都能用 —— 不要求模型支持 vision。

let attachments: AssistantAttachment[] = []

/** 一个附件最终交给模型的文本：优先识别出的公式，其次转换出来的整段文本 */
function attachmentText(item: AssistantAttachment): string {
  if (item.latex) return `$${item.latex}$`
  return (item.text ?? '').trim()
}

/** 拼在用户指令后面的附件块（让模型知道这是附加材料，不是要改的文档） */
function attachmentBlock(zh: boolean): string {
  const usable = attachments.filter((item) => attachmentText(item))
  if (usable.length === 0) return ''
  const parts = usable.map((item, index) => {
    const label = zh ? `【附件 ${index + 1}：${item.name}】` : `[Attachment ${index + 1}: ${item.name}]`
    return `${label}\n${attachmentText(item)}`
  })
  return `${zh ? '（用户附加的材料，供参考）：' : '(Material attached by the user):'}\n\n${parts.join('\n\n')}`
}

function attachmentStatus(item: AssistantAttachment, zh: boolean): string {
  if (item.kind === 'unsupported') return zh ? '不支持' : 'unsupported'
  if (item.latex) return zh ? `公式（${sourceLabel(item.source, zh)}）` : `formula (${sourceLabel(item.source, zh)})`
  if (item.text) return zh ? `已转文本（${sourceLabel(item.source, zh)}）` : `text (${sourceLabel(item.source, zh)})`
  return item.kind === 'image' ? (zh ? '待识别' : 'pending') : ''
}

/** 附件条：缩略图 / 文件名 + 状态 + 「识别公式」（图片）+ 删除；识别出公式后给出插入按钮 */
function renderAttachments(): void {
  const box = el('assistant-attachments')
  if (!box) return
  box.replaceChildren()
  box.hidden = attachments.length === 0
  const zh = isChinese()
  const makeButton = (className: string, label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = className
    node.textContent = label
    node.title = title
    node.addEventListener('click', onClick)
    return node
  }

  attachments.forEach((item, index) => {
    const chip = document.createElement('div')
    chip.className = 'assistant-attachment'
    if (item.kind === 'image' && item.dataUrl) {
      const thumb = document.createElement('img')
      thumb.src = item.dataUrl
      thumb.alt = item.name
      chip.append(thumb)
    }
    const name = document.createElement('span')
    name.className = 'assistant-attachment-name'
    name.textContent = item.name
    name.title = item.path || item.error || ''
    chip.append(name)
    const meta = document.createElement('span')
    meta.className = 'assistant-attachment-meta'
    meta.textContent = attachmentStatus(item, zh)
    chip.append(meta)
    if (item.kind === 'image') {
      chip.append(
        makeButton(
          'assistant-attachment-btn',
          zh ? '识别公式' : 'Formula',
          zh ? '把这张图里的公式识别成 LaTeX' : 'Recognize a formula in this image',
          () => {
            void recognizeAttachment(item)
          }
        )
      )
    }
    chip.append(
      makeButton('assistant-attachment-remove', '✕', zh ? '移除' : 'Remove', () => {
        attachments.splice(index, 1)
        renderAttachments()
      })
    )
    box.append(chip)

    if (item.latex) {
      const row = document.createElement('div')
      row.className = 'assistant-attachment-formula'
      const code = document.createElement('code')
      code.textContent = `$${item.latex}$`
      row.append(code)
      row.append(
        makeButton('assistant-attachment-btn', zh ? '插入行内' : 'Inline', '', () =>
          insertMarkdownAtCursor(`$${item.latex}$`)
        )
      )
      row.append(
        makeButton('assistant-attachment-btn', zh ? '插入块级' : 'Block', '', () =>
          insertMarkdownAtCursor(`\n\n$$\n${item.latex}\n$$\n\n`)
        )
      )
      box.append(row)
    }
  })
}

/** 识别来源的显示名 */
function sourceLabel(source: string | undefined, zh: boolean): string {
  if (source === 'model') return zh ? '模型' : 'model'
  if (source === 'simpletex') return 'SimpleTex'
  if (source === 'mineru') return 'MinerU'
  return zh ? '文件' : 'file'
}

/** 把模型回包整理成 LaTeX：容忍代码块 / 定界符 / 开场白；明显不是公式就返回 null */
function parseLatexAnswer(raw: string): string | null {
  let text = normalizeAnswer(raw).trim()
  const fenced = /^\$\$([\s\S]+)\$\$$/.exec(text)
  if (fenced) text = fenced[1].trim()
  if (text.startsWith('$$') && text.endsWith('$$')) text = text.slice(2, -2).trim()
  else if (text.startsWith('$') && text.endsWith('$')) text = text.slice(1, -1).trim()
  text = text.replace(/^\\\[/, '').replace(/\\\]$/, '').replace(/^\\\(/, '').replace(/\\\)$/, '').trim()
  if (!text) return null
  if (/no[_\s-]?formula/i.test(text)) return null
  // 长文多半是在解释 / 道歉，不是公式
  if (text.length > 600) return null
  if (/^(抱歉|对不起|无法|我不能|sorry|cannot|i can)/i.test(text)) return null
  return text
}

/** 递图给模型前先缩到合理尺寸：省 token，也避开端点对请求体大小的限制 */
async function shrinkDataUrl(dataUrl: string, maxSide = 1400): Promise<string> {
  try {
    const image = new Image()
    const loaded = new Promise<boolean>((resolve) => {
      image.addEventListener('load', () => resolve(true), { once: true })
      image.addEventListener('error', () => resolve(false), { once: true })
    })
    image.src = dataUrl
    if (!(await loaded)) return dataUrl
    const longest = Math.max(image.naturalWidth, image.naturalHeight)
    if (longest <= maxSide) return dataUrl
    const scale = maxSide / longest
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(image.naturalWidth * scale)
    canvas.height = Math.round(image.naturalHeight * scale)
    const context = canvas.getContext('2d')
    if (!context) return dataUrl
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.92)
  } catch {
    return dataUrl
  }
}

/**
 * 走模型的那一次：把图缩一下，按"只输出 LaTeX"的约定递过去。
 * 文本模型会直接拒掉图片内容（HTTP 4xx）—— 返回 null 让调用方降级。
 */
async function formulaViaModel(api: AssistantApi, dataUrl: string): Promise<AssistantOcrResult | null> {
  if (!api.assistantComplete) return null
  const zh = isChinese()
  const image = await shrinkDataUrl(dataUrl)
  const messages: AssistantMessage[] = [
    {
      role: 'system',
      content: zh
        ? '你是公式识别助手。**逐字转写**图片里的数学公式，只输出图中表达式本身。\n严禁：推导、给等价变形或恒等式、解方程、补充结论、任何解释。\n不要 $ 或 $$ 定界符、不要代码块。图片里没有公式时只回复 NO_FORMULA。\n⚠️ 不要用 \\begin{aligned} / \\begin{cases} 之类的环境、也不要用 & 对齐符（本编辑器的公式解析不支持）。'
        : 'You are a formula reader. **Transcribe verbatim** the math in the image; output exactly the expression shown.\nNever: derive, simplify, give identities, solve, add conclusions, or explain.\nNo $ delimiters, no code fences. If there is no formula, reply exactly NO_FORMULA.\nNever use \\begin{aligned}/\\begin{cases} or the & alignment character (this editor cannot parse them).'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: zh ? '识别这张图片里的公式' : 'Read the formula in this image' },
        { type: 'image_url', image_url: { url: image } }
      ]
    }
  ]
  try {
    const result = await api.assistantComplete(messages)
    if (!result.ok) return null
    const latex = parseLatexAnswer(result.text ?? '')
    return latex ? { ok: true, latex, source: 'model' } : null
  } catch {
    return null
  }
}

/**
 * 「图片转公式」的识别链，顺序：**① 附件那套（MinerU → 本地 OCR 契约）→ ② 大模型**。
 *
 * `attachmentFirst` 决定要不要把附件那套放前面：
 *   · 用户明说了"图片/公式"、且这一轮带的就是那张图 → 附件优先（MinerU 读公式最准，
 *     真机上那个视觉小模型会把 `≥` 读成 `=`、把 √ 项整段丢掉）；
 *   · 只是顺手带张图问别的事 → 大模型先试（快、不上传、不花钱），不行再退附件。
 *
 * 两步都拿不到公式时返回带 text/error 的结果，调用方拿它决定"原图直传 + 别猜"。
 */
async function recognizeFormula(
  item: { path?: string; dataUrl?: string },
  attachmentFirst: boolean
): Promise<AssistantOcrResult | null> {
  const api = apiRef
  const viaAttachment = async (): Promise<AssistantOcrResult | null> => {
    if (!api || !item.path) return null
    try {
      return await api.ocrAssistantImage(item.path)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const viaModel = async (): Promise<AssistantOcrResult | null> =>
    api?.assistantComplete && item.dataUrl ? formulaViaModel(api, item.dataUrl) : null

  const chain = attachmentFirst ? [viaAttachment, viaModel] : [viaModel, viaAttachment]
  let last: AssistantOcrResult | null = null
  for (const step of chain) {
    const result = await step()
    if (result?.latex) return result
    if (result && (result.text || result.error)) last = result
  }
  return last
}

/**
 * 选区里的图片 → 已识别的文本/LaTeX 列表 + 原图 data URL 列表。
 *
 * 识别不出来时**不能就这么发**：模型只看到路径/base64 时会凭记忆编内容（真机上
 * 用户要 `b³` 那条公式，它给了求根公式）。所以把原图一并交出去直传，并在材料里
 * 写明"看不到就说看不到，别猜"。
 */
async function recognizeSelectedImages(
  images: SelectedImage[],
  zh: boolean,
  attachmentFirst: boolean
): Promise<{ figures: string[]; parts: string[] }> {
  const api = apiRef
  if (!api || images.length === 0) return { figures: [], parts: [] }
  setStatus(zh ? '识别选区里的图片…' : 'Reading the selected image…')
  const figures: string[] = []
  const parts: string[] = []
  const sources = new Set<string>()
  for (const image of images) {
    let dataUrl = image.dataUrl
    let filePath = image.path
    if (!dataUrl && filePath) {
      try {
        dataUrl = (await api.readImageAsDataUrl(filePath))?.dataUrl
      } catch {
        /* 读不出来就只走本地/服务识别那条路 */
      }
    }
    // 内嵌图（data URL）没有文件路径，而附件那套（MinerU / 本地 OCR）都要文件：
    // 先落成临时文件 —— 与"粘贴的图片"走的是同一个入口。
    if (!filePath && dataUrl && api.pasteAssistantImage) {
      try {
        filePath = (await api.pasteAssistantImage(dataUrl))?.path ?? undefined
      } catch {
        /* 落盘失败就只剩大模型那条路 */
      }
    }
    if (dataUrl) parts.push(dataUrl)
    const result = await recognizeFormula({ path: filePath, dataUrl }, attachmentFirst)
    if (result?.latex) figures.push(`$${result.latex}$`)
    else if (result?.text) figures.push(result.text)
    if (result?.source && (result.latex || result.text)) sources.add(result.source)
  }
  if (figures.length === 0) {
    setStatus(zh ? '图片没能识别出内容，改成把原图直接交给模型' : 'Sending the raw image to the model')
  } else {
    // 让用户一眼知道这次是谁识别的（MinerU / 本地 OCR / 大模型）
    const names = [...sources].map((source) => SOURCE_LABEL[source] ?? source)
    setStatus(names.length ? `图片识别：${names.join(' + ')}` : '')
  }
  return { figures, parts }
}

/** 选区里图片的识别结果（拼在指令后面，模型才看得见像素之外的内容） */
function figureBlock(figures: string[], zh: boolean): string {
  if (figures.length === 0) return ''
  // 实测模型会"顺手改写"识别结果（要不等式，它给恒等式）——这里明确禁止
  return zh
    ? `【选区里的图片（已识别）】下面是**逐字读出来的**内容，请直接使用：不要改写、不要推导、不要给等价形式。\n${figures.join('\n')}`
    : `[Image(s) in the selection (read verbatim)] Use them as-is: do not rewrite, derive or replace them.\n${figures.join('\n')}`
}

/** 「识别公式」按钮：图片 → LaTeX；不是纯公式就退回整段识别文本（明确要公式 → MinerU 优先） */
async function recognizeAttachment(item: AssistantAttachment): Promise<void> {
  const api = apiRef
  if (!api) return
  const zh = isChinese()
  setStatus(zh ? '识别中…' : 'Recognizing…')
  try {
    const result = await recognizeFormula(item, true)
    if (!result) {
      item.error = 'OCR_FAILED'
      setStatus(zh ? '没能识别出内容' : 'Nothing recognized')
      renderAttachments()
      return
    }
    if (result.latex) {
      item.latex = result.latex
      item.source = result.source
      item.text = undefined
      setStatus(zh ? '已识别公式，可插入正文或作为上下文发送' : 'Formula recognized')
    } else if (result.text) {
      item.text = result.text
      item.source = result.source
      setStatus(zh ? '这张图不是纯公式，已转成文本' : 'Not a bare formula — converted to text')
    } else {
      item.error = result.error ?? 'OCR_FAILED'
      setStatus(zh ? '没能识别出内容（检查 OCR 服务 / MinerU token）' : 'Nothing recognized')
    }
  } catch (error) {
    item.error = error instanceof Error ? error.message : String(error)
    setStatus(item.error)
  }
  renderAttachments()
}

/**
 * 发之前把图片附件变成文本：文本模型只认文本。
 * 没识别出内容的图片会挡住发送（否则模型收到一个空附件，纯属浪费一轮）。
 *
 * 指令里明说了"图片/公式"时 MinerU 优先（读公式最准）；否则大模型先试，失败再退
 * 附件那套 —— 随手贴张图问别的事，没必要先上传一次。
 */
async function prepareImageAttachments(instruction = ''): Promise<boolean> {
  const api = apiRef
  if (!api) return false
  const pending = attachments.filter((item) => item.kind === 'image' && !attachmentText(item))
  if (pending.length === 0) return true
  const zh = isChinese()
  const attachmentFirst = asksAboutImage(instruction)
  setStatus(zh ? '识别图片中…' : 'Recognizing image…')
  for (const item of pending) {
    try {
      const result = await recognizeFormula(item, attachmentFirst)
      if (result?.latex) {
        item.latex = result.latex
        item.source = result.source
      } else if (result?.text) {
        item.text = result.text
        item.source = result.source
      }
    } catch {
      /* 下面是统一判定 */
    }
  }
  renderAttachments()
  const failed = attachments.filter((item) => item.kind === 'image' && !attachmentText(item))
  if (failed.length > 0) {
    setStatus(
      zh
        ? `有 ${failed.length} 张图片没能识别出内容，无法作为文本发送`
        : `${failed.length} image(s) could not be recognized`
    )
    return false
  }
  return true
}

function buildMessages(
  instruction: string,
  context: string,
  material = '',
  imageParts: AssistantContentPart[] = []
): AssistantMessage[] {
  const zh = isChinese()
  // 能力说明按需注入：上下文里没有图片就不讲图片参数（省 token，也少干扰）。
  // 这份说明是"模型无关"的关键 —— 换任何模型都靠它认识自定义语法（见 assistant-syntax.ts）。
  const spec = capabilitySpec(scanContext(context), zh)
  // 附件（图片 OCR 文本 / PDF·Word 转换文本）作为"补充材料"附在指令之后：
  // 这样任何文本模型都能用，不必要求模型支持 vision。
  const attachNote = material
    ? zh
      ? '\n用户还可能附了材料（附在指令之后，用【附件 N】标出），请一并参考。'
      : '\nThe user may attach material after the instruction (marked [Attachment N]) — use it as reference.'
    : ''
  const system: AssistantMessage = {
    role: 'system',
    content: zh
      ? `你是 Teyoo 的文档助手。下面是用户当前正在编辑的文档${scope === 'document' ? '全文' : '片段'}（Markdown）：\n\n<<<\n${context}\n>>>\n\n${spec}\n\n请按用户的指令改写这段内容。只输出改写后的 Markdown 本身，不要任何解释、不要用代码块包裹。${attachNote}`
      : `You are the document assistant inside Teyoo. Below is the ${scope === 'document' ? 'full document' : 'fragment'} the user is editing (Markdown):\n\n<<<\n${context}\n>>>\n\n${spec}\n\nRewrite it as instructed. Output only the rewritten Markdown — no explanations, no code fences.${attachNote}`
  }
  const userText = material ? `${instruction}\n\n${material}` : instruction
  const user: AssistantMessage = {
    role: 'user',
    // 图片走二进制分片（主进程发出去前才转成 image_url data URL）
    content: imageParts.length ? [{ type: 'text', text: userText }, ...imageParts] : userText
  }

  const recent = conversation.slice(-MAX_HISTORY_MESSAGES)
  return [system, ...recent, user]
}

async function send(): Promise<void> {
  const api = apiRef
  const input = el<HTMLTextAreaElement>('assistant-input')
  const instruction = input?.value.trim() ?? ''
  if (!api || busy) return
  if (!instruction) {
    setStatus(texts().noInstruction)
    input?.focus()
    return
  }
  if (hooks.isAvailable && !hooks.isAvailable()) {
    setStatus(hooks.unavailableReason?.() ?? '')
    return
  }
  const context = currentContext()
  if (!context.markdown.trim()) {
    setStatus(texts().contextNone)
    return
  }
  if (context.kind === 'document' && context.markdown.length > MAX_DOCUMENT_CHARS) {
    setStatus(texts().documentTooLong)
    return
  }

  // 图片附件先变成文本（文本模型只认文本）；识别不出来就别发，省得白跑一轮
  if (!(await prepareImageAttachments(instruction))) return
  // 选区里如果是图片（用户在文档里点选了一张图）：模型只看得到 `![…](路径)` 或一坨
  // base64 —— 先识别成 LaTeX 再带过去；识别不出来就把**原图直传**，并写明"看不到就
  // 说看不到"，免得它凭记忆编一个最有名的公式（真机上发生过）。
  const zhMode = isChinese()
  // 用户明说了"图片/公式"、且这一轮带的就是那张图 → 走附件那套（MinerU 优先）；
  // 否则大模型先试（快、不上传），失败再退附件那套。
  const attachmentFirst = asksAboutImage(instruction) && isOnlyImages(context.markdown)
  const selected = await recognizeSelectedImages(context.images, zhMode, attachmentFirst)
  const unreadable = selected.figures.length === 0 && selected.parts.length > 0
  const imageNote = unreadable
    ? zhMode
      ? '【选区里的图片没能识别出内容】原图就在这条消息里。如果你看不到图片，请直说"看不到这张图"，绝对不要凭记忆猜公式或内容。'
      : '[The selected image could not be read] The raw image is attached. If you cannot see images, say so — never guess the content from memory.'
    : ''
  const material = [figureBlock(selected.figures, zhMode), imageNote, attachmentBlock(zhMode)]
    .filter(Boolean)
    .join('\n\n')
  // ① 给模型的**文本**里，内嵌图的 base64 缩成占位（几万字符塞提示词里纯烧 token）
  // ② 图片本体解成二进制，走图片分片递过去（见 buildMessages / llm.ts）
  const contextForModel = shrinkInlineImages(context.markdown, selected.figures.length > 0)
  const imageParts = selected.parts
    .map(toImagePart)
    .filter((part): part is AssistantContentPart => part !== null)

  // 同一时刻只留一处正文预览：上一处先撤掉（新一轮的会在拿到建议后再挂上）
  clearAssistantProposal()
  if (input) input.value = ''
  appendBubble(instruction, 'assistant-msg-user')
  const streamBubble = appendBubble('', 'assistant-msg assistant-msg-bot assistant-msg-streaming')
  streamTarget = streamBubble
  streamText = ''
  setBusy(true)
  setStatus(texts().sending)

  const messages = buildMessages(instruction, contextForModel, material, imageParts)
  try {
    let result = await api.assistantStream(messages)
    // 带图那一次被服务端拒了（用户配的是文本模型，不认图片分片）：退回纯文本重试一次。
    // 材料里已经有识别出来的内容；万一是"没识别出来"，那条提示会写明"看不到就直说、别猜"。
    if (!result.ok && imageParts.length > 0 && /HTTP_4/.test(result.error ?? '')) {
      streamText = ''
      if (streamTarget) streamTarget.textContent = ''
      result = await api.assistantStream(buildMessages(instruction, contextForModel, material))
    }
    removeBubble(streamTarget)
    streamTarget = null
    if (!result.ok) {
      const stopped = result.error === 'CANCELED' || result.error === 'ABORTED'
      // 被中断但已经收到一部分：那部分往往是有用的，照样给卡片（标明是截断的）
      if (stopped && streamText.trim()) {
        const partial = prepareAnswer(streamText, context.markdown)
        appendProposal(partial.markdown, context, partial.notes)
        setStatus(texts().stopped)
      } else if (stopped) {
        setStatus(texts().stopped)
      } else {
        appendBubble(errorText(result.error), 'assistant-msg-error')
        setStatus('')
      }
      return
    }
    const answer = result.text ?? streamText
    // 附件已经随这一轮带出去了：清空附件条，免得下一轮又重复带一遍（白费 token）
    if (attachments.length > 0) {
      attachments = []
      renderAttachments()
    }
    const prepared = prepareAnswer(answer, context.markdown)
    appendProposal(prepared.markdown, context, prepared.notes)
    const userTurn: AssistantMessage = { role: 'user', content: instruction }
    // 对话历史里也放"整理后"的那份：下一轮模型看到的才是真正写进文档的内容
    const assistantTurn: AssistantMessage = { role: 'assistant', content: prepared.markdown }
    conversation = [...conversation, userTurn, assistantTurn].slice(-MAX_HISTORY_MESSAGES)
    setStatus('')
  } catch (error) {
    removeBubble(streamTarget)
    streamTarget = null
    appendBubble(error instanceof Error ? error.message : String(error), 'assistant-msg-error')
    setStatus('')
  } finally {
    setBusy(false)
    updateContextLabel()
  }
}

function stopStreaming(): void {
  if (!busy) return
  setStatus(texts().stopped)
  apiRef?.assistantCancel()
}

// ── 初始化与显隐 ────────────────────────────────────────────────────────

export function initAssistant(api: AssistantApi, assistantHooks: AssistantHooks = {}): void {
  apiRef = api
  hooks = assistantHooks
  const text = texts()

  const input = el<HTMLTextAreaElement>('assistant-input')
  if (input) {
    input.placeholder = text.placeholder
    // 附件：选文件（图片 / PDF / Word / 文本），以及**直接粘贴截图**
    // （截图→粘贴→「识别公式」是最常用的一条路）
    el<HTMLButtonElement>('assistant-attach-btn')?.addEventListener('click', () => {
      void (async () => {
        const picked = await apiRef?.pickAssistantAttachment()
        if (!picked || picked.length === 0) return
        attachments = [...attachments, ...picked]
        renderAttachments()
      })()
    })
    input.addEventListener('paste', (event) => {
      const items = event.clipboardData?.items
      if (!items) return
      let file: File | null = null
      for (let index = 0; index < items.length; index++) {
        const entry = items[index]
        if (entry.type.startsWith('image/')) {
          file = entry.getAsFile()
          break
        }
      }
      if (!file) return
      // 图片被我们接管：别让浏览器把文件名当文字塞进输入框
      event.preventDefault()
      const reader = new FileReader()
      reader.addEventListener('load', () => {
        void (async () => {
          if (typeof reader.result !== 'string') return
          const saved = await apiRef?.pasteAssistantImage(reader.result)
          if (!saved) return
          attachments = [...attachments, saved]
          renderAttachments()
          setStatus(isChinese() ? '已添加粘贴的图片（可点「识别公式」）' : 'Pasted image added')
        })()
      })
      reader.readAsDataURL(file)
    })
    input.addEventListener('keydown', (event) => {
      // Enter 发送、Shift+Enter 换行（对话面板的常规手感）
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void send()
      }
    })
  }
  const sendBtn = el<HTMLButtonElement>('assistant-send-btn')
  if (sendBtn) {
    sendBtn.textContent = text.send
    sendBtn.setAttribute('aria-label', text.send)
    sendBtn.addEventListener('click', () => {
      if (busy) stopStreaming()
      else void send()
    })
  }
  const closeBtn = el<HTMLButtonElement>('assistant-close-btn')
  if (closeBtn) {
    closeBtn.title = text.close
    closeBtn.setAttribute('aria-label', text.close)
    closeBtn.addEventListener('click', () => hooks.onRequestClose?.())
  }

  // 上下文范围下拉
  const scopeSelect = el<HTMLSelectElement>('assistant-scope')
  if (scopeSelect) {
    scopeSelect.replaceChildren()
    for (const [value, label] of [
      ['auto', text.scopeAuto],
      ['document', text.scopeDocument]
    ] as const) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      scopeSelect.append(option)
    }
    scopeSelect.value = scope
    scopeSelect.title = text.scopeAuto
    scopeSelect.addEventListener('change', () => {
      scope = scopeSelect.value === 'document' ? 'document' : 'auto'
      updateContextLabel()
      input?.focus()
    })
  }

  // 空态
  const list = el('assistant-messages')
  if (list && !list.children.length) {
    const empty = document.createElement('div')
    empty.className = 'assistant-empty'
    empty.textContent = text.emptyState
    list.append(empty)
  }

  // 流式分片：只订阅一次，转发给当前那个气泡（每次发送都订阅会堆监听器）
  api.onAssistantDelta(({ text: chunk }) => {
    if (!streamTarget) return
    streamText += chunk
    streamTarget.textContent = streamText
    scrollToBottom()
  })

  // 选区变了就更新"这一轮会带上什么"。ProseMirror 的选区变化会带动 DOM 选区，
  // selectionchange 能收到；防抖一下，避免拖动选择时狂刷。
  document.addEventListener('selectionchange', () => {
    if (contextTimer) clearTimeout(contextTimer)
    contextTimer = setTimeout(() => {
      contextTimer = null
      updateContextLabel()
    }, 200)
  })
  // 焦点进侧边栏（输入框、按钮、下拉）就一直亮着那段；回到编辑器就撤。
  // pointerdown 是为了盖上"点在面板非焦点区域"这一下（比如点消息列表空白）。
  el('assistant-panel')?.addEventListener('focusin', () => applyContextMark())
  el('assistant-panel')?.addEventListener('pointerdown', () => applyContextMark())
  el('editor')?.addEventListener('focusin', () => hideContextMark())

  updateContextLabel()
}

/** 侧边栏显隐（由 main.ts 按偏好调用） */
export function setAssistantOpen(open: boolean): void {
  document.body.classList.toggle('assistant-open', open)
  const panel = el('assistant-panel')
  if (panel) panel.hidden = !open
  if (!open) hideContextMark()
  if (open) {
    updateContextLabel()
    el<HTMLTextAreaElement>('assistant-input')?.focus()
  }
}

export function isAssistantOpen(): boolean {
  return document.body.classList.contains('assistant-open')
}

/** 切标签页 / 切源码模式之后刷新"这一轮会带上什么"（由 main.ts 调用） */
export function refreshAssistantContext(): void {
  updateContextLabel()
  // 换了一份文档、选区也就换了：焦点还在侧边栏就按新选区重算，否则撤掉
  const panel = el('assistant-panel')
  if (panel && panel.contains(document.activeElement)) applyContextMark()
  else hideContextMark()
}
