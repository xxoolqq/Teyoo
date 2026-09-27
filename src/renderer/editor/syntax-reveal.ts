// span 级 Markdown 语法揭示（Typora 风格）—— v1：标准行内语法
// ─────────────────────────────────────────────────────────────────────────────
//
// 功能：光标点进一段带行内标记的文字时，把「包裹该文字的最小 span」切换为
// 可编辑的 Markdown 源码形态（如 **加粗** → `**加粗**`，灰色等宽显示），
// 光标离开该 span（点击别处 / 方向键移出 / Esc / Enter）时重新解析回渲染形态。
// 不是整段源码模式——只有离光标最近的一层语法被揭示。
//
// ─── 实现要点 ───────────────────────────────────────────────────────────────
//
// 1. md_source 行内节点（下方 $nodeSchema）：
//    - content 'text*'、marks ''（内部只能是纯文本，揭示态不渲染任何标记）
//    - toMarkdown 输出为 mdast 'html' 节点：remark-stringify 对 html 节点
//      原样输出（mdast-util-to-markdown 的 html handler 直接返回 node.value，
//      不做任何转义）。因此揭示态下保存/导出，文件里是 **bold** 而非
//      \*\*bold\*\*；重新打开时 **bold** 自然解析回 strong，无损往返。
//    - 不匹配任何 markdown（仅程序化创建），parseDOM 只服务内部剪贴板往返。
//
// 2. 最小 span 检测（maybeEnterReveal）：
//    - 光标 $head 所在父节点必须是 textblock（段落/标题/表格单元格…），
//      排除代码块（parent.type.spec.code）。
//    - 定位 parentOffset 所在的 inline 子节点（边界时优先左侧子节点）。
//    - 取该节点的 marks，对每个 mark 向两侧扩展「连续同 mark run」
//      （相邻子节点只要含该 mark 即延续，允许嵌套其他 mark，如着重号跨加粗）。
//    - 候选按 run 宽度取最小；同宽按 PRIORITY 固定顺序（内层语义优先）。
//
// 3. enter 事务：用 serializerCtx 把 run 片段（临时包成 doc>paragraph）序列化，
//    unescapeMarkers 后作为 md_source 节点文本；光标按
//    runFrom + 1 + openLen + 光标在原 run 内偏移 重定位。
//
// 4. commit 事务：node.textContent 经 parserCtx 走完整 remark 管线
//    （含全部自定义扩展与公式误判防护），取首个 textblock 的 inline 片段
//    replaceWith 回原区间；解析失败退化为纯文本插入（内容不丢）。
//
// 5. 防递归 / 副作用控制：
//    - 自有事务（enter/adopt/commit）携带 PluginKey meta；apply 置 suppress，
//      update() 消费后跳过一次，防止「提交→光标仍在 run 内→再揭示」死循环。
//    - enter/adopt/commit 均 addToHistory:false——揭示是视图行为，不产生
//      可撤销步骤；用户在揭示态内的真实编辑照常入栈。
//    - enter/adopt 事务 meta.changed=false、commit 时比较快照：documentChangePlugin
//      据此跳过脏标记（揭示往返的序列化结果不变，不应把文档标记为已修改）。
//
// 6. handleTextInput 拦截：揭示态内的普通输入直接 insertText，绕过
//    customInputRules——否则源码字面量（如光标前的 **）会误触发 markRule
//    改写揭示文本。揭示态内输入本就是「编辑源码字面量」，不触发规则才是正确语义。
//
// ─── v1 已知取舍（故意不做，留待后续版本） ─────────────────────────────────
//   - 块级语法（列表/引用/代码块/表格）不揭示，仅行内。
//   - 数学公式不揭示（双击已有 math-modal 编辑入口，避免交互冲突）。
//   - 揭示文本与源码模式的转义口径一致：仅还原 \* 与 \~（unescapeMarkers）。
//     含其他字面量转义（如 \[）时会原样显示反斜杠；「加粗内含字面 *」这类
//     文本揭示/提交后语义可能漂移——与源码模式往返是同一口径的已知损耗。
//   - 孤立 md_source 节点（粘贴副本/撤销恢复后光标不在其中）保持揭示外观，
//     CSS 恒定对 span[data-md-source] 生效；光标再次进入即被接管（adopt）。
//   - 序列化孤立 run 时 remark-stringify 的转义可能与整段上下文略有出入
//     （before/after 上下文差异），仅影响源码字符呈现，不影响语义。

import { Plugin, PluginKey, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Fragment, Mark, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { parserCtx, serializerCtx } from '@milkdown/kit/core'
import { $nodeSchema, $prose } from '@milkdown/kit/utils'
import type { Ctx } from '@milkdown/kit/ctx'

// ─── md_source 行内节点 schema ──────────────────────────────────────────────
// 揭示态的载体：内容是带语法标记的纯文本，kind 记录揭示的是哪种 mark，
// openLen/closeLen 记录进入时的标记宽度（matchSource 失效时的光标回退值）。

export const mdSourceSchema = $nodeSchema('md_source', () => ({
  group: 'inline',
  inline: true,
  content: 'text*',
  // 揭示态内部不允许任何 mark——它显示的是源码字面量
  marks: '',
  attrs: {
    kind: { default: '' },
    openLen: { default: 0 },
    closeLen: { default: 0 },
  },
  parseDOM: [
    {
      // 仅服务内部 HTML 剪贴板往返；正常复制/粘贴走 markdown 序列化，
      // 粘贴时 **bold** 会被重新解析回 strong，不会产生 md_source。
      tag: 'span[data-md-source]',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { kind: '', openLen: 0, closeLen: 0 }
        return {
          kind: dom.getAttribute('data-kind') ?? '',
          openLen: Number(dom.getAttribute('data-open-len') ?? 0) || 0,
          closeLen: Number(dom.getAttribute('data-close-len') ?? 0) || 0,
        }
      },
    },
  ],
  toDOM: (node) => [
    'span',
    {
      class: 'md-source',
      'data-md-source': 'true',
      'data-kind': String(node.attrs.kind ?? ''),
      'data-open-len': String(node.attrs.openLen ?? 0),
      'data-close-len': String(node.attrs.closeLen ?? 0),
    },
    // content hole 必须是该节点的唯一子节点（ProseMirror toDOM 规约）
    0,
  ],
  parseMarkdown: {
    // 揭示节点仅程序化创建，不匹配任何 markdown 语法
    match: () => false,
    runner: () => {},
  },
  toMarkdown: {
    match: (node) => node.type.name === 'md_source',
    runner: (state, node) => {
      // 关键技巧：输出为 mdast 'html' 节点。remark-stringify 对 html 节点
      // 原样输出（不转义 * ~ 等），揭示态保存的 markdown 是 **bold**，
      // 重新解析自然回到 strong——无损往返。
      state.addNode('html', undefined, node.textContent)
    },
  },
}))

// ─── 标记模式表：kind → 从揭示文本反解 openLen/closeLen ────────────────────
// 揭示文本来自真实序列化器输出，标记形态可能随文档风格变化（如 __bold__），
// 因此运行时用正则反解，而非假定固定标记。

interface MarkerSpan {
  openLen: number
  closeLen: number
}

type SourceMatcher = (text: string) => MarkerSpan | null

// 对称标记：^open middle open$，贪婪前缀兼容嵌套同字符（如 ***x***）
function symmetric(openPattern: string): SourceMatcher {
  const re = new RegExp(`^(${openPattern})([\\s\\S]+)\\1$`)
  return (text) => {
    const m = re.exec(text)
    if (!m) return null
    return { openLen: m[1].length, closeLen: m[1].length }
  }
}

const MATCHERS: Record<string, SourceMatcher> = {
  // @milkdown/kit preset-commonmark / preset-gfm 的 PM mark 类型名
  // （$markSchema 注册 id 即 schema key，见 @milkdown/core 的 Schema 构建）
  strong: symmetric('\\*{2,}|_{2,}'),
  emphasis: symmetric('\\*{1,}|_{1,}'),
  inlineCode: symmetric('`{1,}'),
  strike_through: symmetric('~{1,}'),
  // 项目自定义（src/renderer/editor/highlight.ts）：==text==
  highlight: symmetric('={2,}'),
  // 规约A 着重号：@.text.@
  emphDot: (text) => {
    const m = /^@\.([\s\S]+)\.@$/.exec(text)
    return m ? { openLen: 2, closeLen: 2 } : null
  },
  // 规约H 行内字体：{= attrs : text}，属性段不含冒号
  font_span: (text) => {
    const m = /^(\{=\s*[^:]+?\s*:\s*)([\s\S]+)\}$/.exec(text)
    return m ? { openLen: m[1].length, closeLen: 1 } : null
  },
  // 行内链接：[text](url) / [text](url "title")；url 含转义括号时反解失败，
  // 仅影响装饰与光标定位精度，不影响提交解析
  link: (text) => {
    const m = /^\[([\s\S]+)\]\([^()]*?(?:\s+"[^"]*")?\)$/.exec(text)
    if (!m) return null
    return { openLen: 1, closeLen: text.length - 1 - m[1].length }
  },
}

// run 宽度并列时的揭示优先级：内层核心语法优先，链接/字体最外层语义殿后
const PRIORITY = ['inlineCode', 'strong', 'emphasis', 'emphDot', 'highlight', 'strike_through', 'font_span', 'link']

// 与 editor.ts 的源码模式同口径：仅还原 \* 与 \~ 的转义
function unescapeMarkers(markdown: string): string {
  return markdown.replace(/\\([*~])/g, '$1')
}

// 源码模式激活时（#source-editor 可见）不进入揭示
function isSourceMode(): boolean {
  return document.getElementById('source-editor')?.classList.contains('visible') ?? false
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

// ─── 插件状态 ────────────────────────────────────────────────────────────────

interface ActiveReveal {
  from: number
  to: number
  // 进入揭示时的文本快照：commit 时对比判断内容是否真的被用户改过
  snapshot: string
}

interface RevealMeta {
  enter?: ActiveReveal
  adopt?: ActiveReveal
  commit?: boolean
  // false：该事务不改变序列化结果（揭示往返），documentChangePlugin 据此豁免脏标记
  changed?: boolean
}

interface RevealState {
  active: ActiveReveal | null
  deco: DecorationSet
  // 上一事务是本插件自有事务时为 true；update() 消费后由后续 apply 复位
  suppress: boolean
}

export const syntaxRevealPluginKey = new PluginKey<RevealState>('syntax-reveal')

// 依据揭示文本反解标记宽度，为 open/close 标记字符生成灰色装饰
function buildMarkerDecorations(doc: ProseMirrorNode, active: ActiveReveal | null): DecorationSet {
  if (!active) return DecorationSet.empty
  const node = doc.nodeAt(active.from)
  if (!node || node.type.name !== 'md_source') return DecorationSet.empty
  const text = node.textContent
  const m = MATCHERS[String(node.attrs.kind ?? '')]?.(text)
  if (!m) return DecorationSet.empty
  const openLen = clamp(m.openLen, 0, text.length)
  const closeLen = clamp(m.closeLen, 0, text.length - openLen)
  return DecorationSet.create(doc, [
    Decoration.inline(active.from + 1, active.from + 1 + openLen, { class: 'md-reveal-marker' }),
    Decoration.inline(active.to - 1 - closeLen, active.to - 1, { class: 'md-reveal-marker' }),
  ])
}

// ─── 进入揭示 ────────────────────────────────────────────────────────────────

interface RunChild {
  node: ProseMirrorNode
  start: number
  end: number
}

interface RunCandidate {
  kind: string
  mark: Mark
  i0: number
  i1: number
  len: number
  priority: number
}

function maybeEnterReveal(view: EditorView, ctx: Ctx): void {
  const { state } = view
  const sel = state.selection
  const $head = sel.$head

  // 接管：光标已落在某个 md_source 节点内（撤销恢复 / 异常残留），
  // 不改文档，仅重新纳入插件管理并显示标记装饰。
  for (let d = $head.depth; d >= 1; d--) {
    const n = $head.node(d)
    if (n.type.name === 'md_source') {
      const tr = state.tr.setMeta(syntaxRevealPluginKey, {
        adopt: { from: $head.before(d), to: $head.after(d), snapshot: n.textContent },
        changed: false,
      } satisfies RevealMeta)
      tr.setMeta('addToHistory', false)
      view.dispatch(tr)
      return
    }
  }

  if (!sel.empty) return
  const parent = $head.parent
  // 仅 textblock（段落/标题/单元格…）内揭示；代码块排除
  if (!parent.isTextblock || parent.type.spec.code) return

  const children: RunChild[] = []
  parent.content.forEach((child, offset) => {
    children.push({ node: child, start: offset, end: offset + child.nodeSize })
  })
  if (children.length === 0) return

  const parentOffset = $head.parentOffset
  let idx = children.findIndex((c) => parentOffset < c.end)
  if (idx === -1) idx = children.length - 1
  // 光标恰在两个子节点边界时优先左侧子节点（与既定交互设计一致）
  if (idx > 0 && children[idx].start === parentOffset) idx -= 1

  const child = children[idx].node
  // v1 仅对文本节点揭示（行内原子节点如图片/公式不处理）
  if (!child.isText || !child.text) return

  // 对光标节点的每个 mark 计算「连续同 mark run」，宽度最小者胜出
  const candidates: RunCandidate[] = []
  for (const mark of child.marks) {
    const kind = mark.type.name
    if (!(kind in MATCHERS)) continue
    let i0 = idx
    let i1 = idx
    while (i0 > 0 && children[i0 - 1].node.marks.some((m) => m.eq(mark))) i0 -= 1
    while (i1 < children.length - 1 && children[i1 + 1].node.marks.some((m) => m.eq(mark))) i1 += 1
    let len = 0
    for (let i = i0; i <= i1; i++) {
      len += children[i].node.isText ? (children[i].node.text?.length ?? 0) : children[i].node.nodeSize
    }
    candidates.push({ kind, mark, i0, i1, len, priority: PRIORITY.indexOf(kind) })
  }
  if (candidates.length === 0) return
  candidates.sort((a, b) => a.len - b.len || a.priority - b.priority)
  enterReveal(view, ctx, $head, children, candidates[0])
}

function enterReveal(view: EditorView, ctx: Ctx, $head: { start: () => number; parentOffset: number }, children: RunChild[], best: RunCandidate): void {
  const schema = view.state.schema
  if (!schema.nodes.md_source) return

  const nodes: ProseMirrorNode[] = []
  for (let i = best.i0; i <= best.i1; i++) nodes.push(children[i].node)

  // run 片段 → 临时 doc>paragraph → 序列化为 markdown 源码
  let revealText = ''
  try {
    const para = schema.nodes.paragraph.create(null, Fragment.fromArray(nodes))
    const doc = schema.topNodeType.create(null, [para])
    revealText = ctx.get(serializerCtx)(doc).replace(/\n+$/, '')
  } catch {
    return
  }
  revealText = unescapeMarkers(revealText)
  if (!revealText) return

  const m = MATCHERS[best.kind]?.(revealText)
  const openLen = m?.openLen ?? 0
  const closeLen = m?.closeLen ?? 0
  const node = schema.nodes.md_source.create({ kind: best.kind, openLen, closeLen }, schema.text(revealText))

  const contentStart = $head.start()
  const runFrom = contentStart + children[best.i0].start
  const runTo = contentStart + children[best.i1].end
  // 光标在原 run 纯文本内的偏移，映射为揭示节点内偏移（近似：嵌套标记处有 ±标记宽 误差）
  const cursorInRun = clamp($head.parentOffset - children[best.i0].start, 0, Math.max(0, revealText.length - openLen - closeLen))

  const tr = view.state.tr
  tr.replaceWith(runFrom, runTo, node)
  const cursorPos = clamp(runFrom + 1 + openLen + cursorInRun, runFrom + 1, runFrom + node.nodeSize - 1)
  tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos), 1))
  tr.setMeta(syntaxRevealPluginKey, {
    enter: { from: runFrom, to: runFrom + node.nodeSize, snapshot: revealText },
    changed: false,
  } satisfies RevealMeta)
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
}

// ─── 提交揭示 ────────────────────────────────────────────────────────────────

// 计算 inline 片段的纯文本长度（原子节点不计入）
function fragmentTextLength(fragment: Fragment): number {
  let len = 0
  fragment.forEach((child) => {
    if (child.isText) len += child.text?.length ?? 0
  })
  return len
}

// 在 inline 片段内按纯文本偏移找位置（返回片段相对位置）
function fragmentPosForTextOffset(fragment: Fragment, offset: number): number {
  let consumed = 0
  let pos = 0
  let result = -1
  fragment.forEach((child) => {
    if (result >= 0) return
    if (child.isText) {
      const len = child.text?.length ?? 0
      if (offset <= consumed + len) {
        result = pos + (offset - consumed)
        return
      }
      consumed += len
    }
    pos += child.nodeSize
  })
  return result >= 0 ? result : pos
}

// allowReenter：因光标移出而提交时，提交完允许立即对新光标位置再次揭示；
// Esc/Enter 主动提交时不重进（光标仍在原 run 内容里，否则会立刻反转回揭示态）。
function commitReveal(view: EditorView, ctx: Ctx, allowReenter: boolean, active: ActiveReveal): void {
  const node = view.state.doc.nodeAt(active.from)
  if (!node || node.type.name !== 'md_source') return
  const text = node.textContent
  const kind = String(node.attrs.kind ?? '')

  // 走完整 remark 管线重解析（含自定义扩展与公式误判防护）
  let fragment: Fragment | null = null
  try {
    const parsed = ctx.get(parserCtx)(text)
    if (parsed.childCount > 0) {
      const first = parsed.child(0)
      // 揭示区间是行内位置：只接受 textblock 的 inline 内容；
      // 用户在揭示态输入了块级语法（如 # 标题）时同样能安全回填行内内容
      if (first.isTextblock) fragment = first.content
    }
  } catch {
    fragment = null
  }

  const tr = view.state.tr
  if (fragment && fragment.size > 0) {
    tr.replaceWith(active.from, active.to, fragment)
  } else if (text) {
    // 解析失败（罕见）：退化为纯文本插入，内容不丢、标记失效
    tr.replaceWith(active.from, active.to, view.state.schema.text(text))
  } else {
    tr.delete(active.from, active.to)
  }

  // 光标启发式：仅当光标仍在原揭示节点内时按 offset-openLen 重定位；
  // 移出触发的提交让 PM 自动映射（用户已把光标放到目标位置）
  const sel = view.state.selection
  if (sel.empty && sel.head > active.from && sel.head < active.to) {
    const m = MATCHERS[kind]?.(text)
    const openLen = m ? m.openLen : Number(node.attrs.openLen) || 0
    const textLen = fragment ? fragmentTextLength(fragment) : text.length
    const target = clamp(sel.head - active.from - 1 - openLen, 0, textLen)
    const rel = fragment ? fragmentPosForTextOffset(fragment, target) : target
    tr.setSelection(TextSelection.near(tr.doc.resolve(clamp(active.from + rel, 0, tr.doc.content.size)), 1))
  }

  tr.setMeta(syntaxRevealPluginKey, { commit: true, changed: active.snapshot !== text } satisfies RevealMeta)
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
  if (allowReenter) maybeEnterReveal(view, ctx)
}

// ─── 插件本体 ────────────────────────────────────────────────────────────────

export const syntaxRevealPlugin = $prose((ctx: Ctx) => new Plugin<RevealState>({
  key: syntaxRevealPluginKey,
  state: {
    init: () => ({ active: null, deco: DecorationSet.empty, suppress: false }),
    apply(tr: Transaction, value: RevealState): RevealState {
      const meta = tr.getMeta(syntaxRevealPluginKey) as RevealMeta | undefined
      if (meta) {
        const active = meta.enter ?? meta.adopt ?? null
        return { active, deco: buildMarkerDecorations(tr.doc, active), suppress: true }
      }
      if (!tr.docChanged) return { ...value, suppress: false }
      if (!value.active) return { active: null, deco: DecorationSet.empty, suppress: false }
      // 外部事务：映射揭示区间；节点被删则静默解除
      const from = tr.mapping.map(value.active.from)
      const to = tr.mapping.map(value.active.to)
      const node = tr.doc.nodeAt(from)
      if (!node || node.type.name !== 'md_source') {
        return { active: null, deco: DecorationSet.empty, suppress: false }
      }
      const active = { from, to, snapshot: value.active.snapshot }
      return { active, deco: buildMarkerDecorations(tr.doc, active), suppress: false }
    },
  },
  props: {
    decorations(state) {
      return syntaxRevealPluginKey.getState(state)?.deco ?? DecorationSet.empty
    },
    // 揭示态内的普通输入绕过 customInputRules：源码字面量（光标前的 **、~~ 等）
    // 不应触发 markRule 改写揭示文本；输入直接落为节点内纯文本
    handleTextInput(view, from, to, text) {
      const st = syntaxRevealPluginKey.getState(view.state)
      if (!st?.active) return false
      if (from < st.active.from || to > st.active.to) return false
      const tr = view.state.tr
      tr.insertText(text, from, to)
      view.dispatch(tr)
      return true
    },
    handleKeyDown(view, event) {
      const st = syntaxRevealPluginKey.getState(view.state)
      if (!st?.active) return false
      if (event.key === 'Escape') {
        event.preventDefault()
        commitReveal(view, ctx, false, st.active)
        return true
      }
      if (event.key === 'Enter') {
        const sel = view.state.selection
        const inside = sel.empty
          ? sel.head > st.active.from && sel.head < st.active.to
          : sel.from >= st.active.from && sel.to <= st.active.to
        if (inside) {
          // Enter 在揭示态内 = 确认编辑：提交并吞掉换行（防止段落切分
          // 把揭示节点劈成两半；也先于 enterSplitGuardPlugin 的规则扫描）
          event.preventDefault()
          commitReveal(view, ctx, false, st.active)
          return true
        }
      }
      return false
    },
  },
  view: () => ({
    update(view, prevState) {
      const st = syntaxRevealPluginKey.getState(view.state)
      const prevSt = syntaxRevealPluginKey.getState(prevState)
      // 自有事务刚应用：跳过一轮，防止「提交→光标仍在 run 内→再揭示」循环
      if (!st || st.suppress) return
      if (
        view.state.doc === prevState.doc &&
        view.state.selection === prevState.selection &&
        st.active === prevSt?.active
      ) {
        return
      }

      // 源码模式 / 只读视图：直接收尾，不做任何揭示（view.editable 是布尔属性）
      if (isSourceMode() || !view.editable) {
        if (st.active) commitReveal(view, ctx, false, st.active)
        return
      }
      if (view.composing) return

      if (st.active) {
        const sel = view.state.selection
        const { from, to } = st.active
        // 空选区看 head；非空选区整体离开揭示区间才提交（区间内拖选允许编辑）
        const outside = sel.empty
          ? sel.head <= from || sel.head >= to
          : sel.to <= from || sel.from >= to
        if (outside) commitReveal(view, ctx, true, st.active)
        return
      }

      // 文档发生变化（输入规则生成 mark / 打字 / 粘贴 / 撤销重做）时不自动
      // 揭示：markRule 刚生成的 mark 会被立即序列化回灰色源码（如敲完
      // ~~hao~~ 的瞬间变回 ~~hao~~ 源码态），光标被困在揭示节点里。
      // 只在纯选区移动（点击 / 方向键移入标记文字）时进入揭示——这正是
      // 「光标点进带标记文字」的设计语义。
      if (view.state.doc === prevState.doc) maybeEnterReveal(view, ctx)
    },
  }),
}))
