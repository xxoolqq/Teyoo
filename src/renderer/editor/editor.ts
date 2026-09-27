import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx, parserCtx, remarkCtx, schemaCtx, remarkPluginsCtx, remarkStringifyOptionsCtx, inputRulesCtx } from '@milkdown/kit/core'
import { SerializerState } from '@milkdown/kit/transformer'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import remarkBreaks from 'remark-breaks'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { replaceAll, $prose } from '@milkdown/kit/utils'
import { wrapInList, liftListItem, splitListItem } from '@milkdown/kit/prose/schema-list'
import { undo as pmUndo, redo as pmRedo } from '@milkdown/kit/prose/history'
import { setBlockType, wrapIn, splitBlock } from '@milkdown/kit/prose/commands'
import { liftTarget, findWrapping } from '@milkdown/kit/prose/transform'
import { Selection, TextSelection } from '@milkdown/kit/prose/state'
import { remarkMathPlugin, katexOptionsCtx, mathInlineSchema, mathBlockSchema } from '@milkdown/plugin-math'
import { mathInlineView, mathBlockView } from '../math-engine'
import { htmlView } from './html-view'
import { mermaidView } from './mermaid-view'
import { codeBlockExitPlugin } from './code-block-exit'
import { tabIndentPlugin } from './tab-indent'
import { fixMilkdownMarkSplits, fixMarkerEscapes } from './serializer-fix'
import { orderedListFixSchema } from './ordered-list-fix'
import { releaseMermaidRenderer as releaseMermaidRendererBridge } from './mermaid-bridge'
import { mathModal } from './math-modal'
import { imageModal } from './image-modal'
import { circledSupModal } from './circled-sup-modal'
import { pinyinModal } from './pinyin-modal'
import { subBlockModal } from './subblock-modal'
import { colsModal } from './cols-modal'
import { tianziModal } from './tianzi-modal'
import { tableModal } from './table-modal'
import { remarkMathFalsePositiveGuard } from './math-guard'
import { remarkResidualEmphasis } from './residual-emphasis'
import { highlight, remarkHighlight, highlightStringifyHandler } from './highlight'
import { syntaxRevealPlugin, syntaxRevealPluginKey, mdSourceSchema } from './syntax-reveal'
import { escapeInputPlugin } from './escape-input'
import { escapedLiteralMark, remarkEscapedLiteral, restoreEscapes } from './escaped-literal'
import { fixStrikeThroughInputRule } from './strike-through-fix'
import { disableFormatInputRules } from './format-input-rules-off'
import { linkFixSchema, linkInputRule } from './link-fix'
import { tableFloatingToolbarPlugin } from './table-floating-toolbar'
import { blankLinePlugin, remarkBlankLine, blankLineStringifyHandler } from '../../extensions/blank-line'
import { emphDotPlugin, remarkEmphDot, emphDotStringifyHandler } from '../../extensions/emph-dot'
import { underlinePlugin, remarkUnderline, underlineStringifyHandler } from '../../extensions/underline'
import { pinyinRubyPlugin, remarkPinyinRuby, pinyinRubyStringifyHandler } from '../../extensions/pinyin-ruby'
import { pinyinInlinePlugin, remarkPinyinInline, pinyinInlineStringifyHandler } from '../../extensions/pinyin-inline'
import { circledSupPlugin, remarkCircledSup, circledSupStringifyHandler } from '../../extensions/circled-sup'
import { subSupPlugin, remarkSubSup, subscriptStringifyHandler, superscriptStringifyHandler } from '../../extensions/sub-sup'
import { columnsPlugin, remarkColumns, subBlockStringifyHandler, colsStringifyHandler } from '../../extensions/columns'
import { fontStylePlugin, remarkFontBlock, remarkFontSpan, fontBlockStringifyHandler, fontSpanStringifyHandler } from '../../extensions/font-style'
import { tianziGridPlugin, remarkTianziGrid, tianziGridStringifyHandler } from '../../extensions/tianzi-grid'
import { imageStylePlugin, imageResizeView, setCurrentImageFilePath } from '../../extensions/image-style'
import { type MarkdownStyle } from './markdown-style'
import { isChinese } from '../ui-language'

import 'katex/dist/katex.min.css'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '../../extensions/blank-line/style.css'
import '../../extensions/emph-dot/style.css'
import '../../extensions/pinyin-ruby/style.css'
import '../../extensions/pinyin-inline/style.css'
import '../../extensions/circled-sup/style.css'
import '../../extensions/columns/style.css'
import '../../extensions/font-style/style.css'
import '../../extensions/tianzi-grid/style.css'
import '../../extensions/image-style/style.css'

export const searchPluginKey = new PluginKey('search-highlight')

// --- Heading anchors for intra-document links (#50) ---

// GitHub-style heading slug: lowercase, strip punctuation (CJK and letters
// survive), spaces become hyphens. Repeated slugs get -1, -2 … suffixes.
function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

function headingAnchorMap(root: HTMLElement): Map<string, Element> {
  const map = new Map<string, Element>()
  const seen = new Map<string, number>()
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    const base = slugifyHeading(heading.textContent || '')
    if (!base) return
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const slug = count === 0 ? base : `${base}-${count}`
    map.set(slug.toLowerCase(), heading)
  })
  return map
}

function findHeadingAnchor(root: HTMLElement, rawTarget: string): Element | null {
  let decoded = rawTarget
  try {
    decoded = decodeURIComponent(rawTarget)
  } catch {
    // Malformed percent-encoding — fall back to the raw text.
  }
  const map = headingAnchorMap(root)
  return (
    map.get(decoded.toLowerCase()) ??
    map.get(slugifyHeading(decoded).toLowerCase()) ??
    null
  )
}

// --- Heading jump feedback (#64) ---

// The landing band is a ProseMirror decoration, not a DOM class: external
// class changes trip ProseMirror's unexpected-mutation redraw, which recreates
// the heading node and destroys the band instantly.
const headingFlashPluginKey = new PluginKey('heading-flash')

const headingFlashPlugin = $prose(() => {
  return new Plugin({
    key: headingFlashPluginKey,
    state: {
      init() {
        return DecorationSet.empty
      },
      apply(tr, old) {
        const meta = tr.getMeta(headingFlashPluginKey)
        if (meta !== undefined) return meta
        return old.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations(state) {
        return headingFlashPluginKey.getState(state)
      }
    }
  })
})

let headingFlashTimer: ReturnType<typeof setTimeout> | null = null

// Navigation jumps started inside the editor (anchor links) emit a phase
// signal so the outline can hold its reading-position highlight for the
// whole jump, exactly like outline-driven jumps (#64, review on #68).
export type EditorJumpPhase = 'start' | 'settle'
let editorJumpPhaseListener: ((phase: EditorJumpPhase) => void) | null = null
export function onEditorJumpPhase(listener: ((phase: EditorJumpPhase) => void) | null): void {
  editorJumpPhaseListener = listener
}

// Jump feedback must be visible where the user is actually looking, so hold
// the flash until the smooth scroll settles (`scrollend`) instead of playing
// it while the target is still off-screen (#64).
export function flashHeadingOnArrival(heading: Element): void {
  const container = document.getElementById('editor')
  if (!container) return
  editorJumpPhaseListener?.('start')
  let startTop = container.scrollTop
  let done = false
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  const finish = () => {
    if (done) return
    done = true
    container.removeEventListener('scrollend', finish)
    if (fallbackTimer) clearTimeout(fallbackTimer)
    editorJumpPhaseListener?.('settle')
    applyHeadingFlash(heading)
  }
  container.addEventListener('scrollend', finish)
  // Fallback for the no-scroll case where `scrollend` never fires. While the
  // position keeps changing (long smooth scroll), re-arm instead of playing
  // the band away from the landing spot (review on #68).
  fallbackTimer = setTimeout(function armFallback() {
    if (done) return
    if (container.scrollTop !== startTop) {
      startTop = container.scrollTop
      fallbackTimer = setTimeout(armFallback, 400)
      return
    }
    finish()
  }, 1500)
}

function applyHeadingFlash(heading: Element): void {
  const view = getEditorView()
  if (!view || !(heading instanceof HTMLElement) || !heading.isConnected) return
  let from: number
  let to: number
  try {
    const $pos = view.state.doc.resolve(view.posAtDOM(heading, 0))
    from = $pos.before($pos.depth)
    to = $pos.after($pos.depth)
  } catch {
    return
  }
  const decorations = DecorationSet.create(view.state.doc, [
    Decoration.node(from, to, { class: 'heading-flash' })
  ])
  view.dispatch(view.state.tr.setMeta(headingFlashPluginKey, decorations))
  if (headingFlashTimer) clearTimeout(headingFlashTimer)
  headingFlashTimer = setTimeout(() => {
    const current = getEditorView()
    if (current) current.dispatch(current.state.tr.setMeta(headingFlashPluginKey, DecorationSet.empty))
  }, 1600)
}

const searchHighlight = $prose(() => {
  return new Plugin({
    key: searchPluginKey,
    state: {
      init() {
        return DecorationSet.empty
      },
      apply(tr, old) {
        const meta = tr.getMeta(searchPluginKey)
        if (meta !== undefined) return meta
        return old.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations(state) {
        return searchPluginKey.getState(state)
      }
    }
  })
})

const mathEditorPlugin = $prose(() => {
  return new Plugin({
    props: {
      handleDoubleClickOn(_view, _pos, node, nodePos) {
        if (node.type.name === 'math_inline' || node.type.name === 'math_block') {
          const isBlock = node.type.name === 'math_block'
          const currentValue = isBlock ? node.attrs.value : node.textContent
          mathModal.show(currentValue, isBlock, nodePos)
          return true
        }
        return false
      }
    }
  })
})

// 点击图片节点弹出参数编辑模态框 —— 仿 mathEditorPlugin。
// 仅拦截 image 节点（image-style schema 注册的节点）；其他节点透传。
const imageEditorPlugin = $prose(() => {
  return new Plugin({
    props: {
      handleDoubleClickOn(_view, _pos, node, nodePos) {
        if (node.type.name === 'image') {
          imageModal.show(
            {
              src: node.attrs.src || '',
              alt: node.attrs.alt || '',
              width: node.attrs.width || '',
              height: node.attrs.height || '',
              align: node.attrs.align || '',
              border: !!node.attrs.border,
              shadow: !!node.attrs.shadow,
              radius: !!node.attrs.radius,
            },
            nodePos
          )
          return true
        }
        return false
      }
    }
  })
})

// 点击拼音节点弹出编辑模态框 —— 同时拦截 pinyin_ruby（规约B）和
// pinyin_inline（规约B2），共用同一个 PinyinModal：mode 字段据节点类型
// 预填 ruby / inline，用户可在保存时切换类型。
const pinyinEditorPlugin = $prose(() => {
  return new Plugin({
    props: {
      handleClickOn(_view, _pos, node, nodePos) {
        if (node.type.name === 'pinyin_ruby' || node.type.name === 'pinyin_inline') {
          pinyinModal.show(
            {
              text: node.attrs.text || '',
              pinyin: node.attrs.pinyin || '',
              mode: node.type.name === 'pinyin_ruby' ? 'ruby' : 'inline',
            },
            nodePos,
            node.type.name as 'pinyin_ruby' | 'pinyin_inline'
          )
          return true
        }
        return false
      }
    }
  })
})

// 双击已存在 sub_block 节点 → 编辑模式
const subBlockEditorPlugin = $prose(() => {
  return new Plugin({
    props: {
      handleDoubleClickOn(_view, _pos, node, nodePos) {
        if (node.type.name === 'sub_block') {
          // 序列化整个 sub_block 内容为 Markdown，保留 marks（**、@..@、<u> 等）
          const text = serializeNodeToMarkdown(node)
          subBlockModal.show(
            {
              boxed: node.attrs.boxed ?? true,
              align: node.attrs.align || 'left',
              text,
            },
            nodePos
          )
          return true
        }
        return false
      }
    }
  })
})

// 双击已存在 cols 节点 → 编辑模式
const colsEditorPlugin = $prose(() => {
  return new Plugin({
    props: {
      handleDoubleClickOn(_view, _pos, node, nodePos) {
        if (node.type.name === 'cols') {
          colsModal.show(
            { spec: node.attrs.spec || '2' },
            nodePos
          )
          return true
        }
        return false
      }
    }
  })
})

// 点击已存在 tianzi_grid 节点 → 编辑模式
const tianziEditorPlugin = $prose(() => {
  return new Plugin({
    props: {
      handleDoubleClickOn(_view, _pos, node, nodePos) {
        if (node.type.name === 'tianzi_grid') {
          tianziModal.show(
            { raw: node.attrs.raw || '' },
            nodePos
          )
          return true
        }
        return false
      }
    }
  })
})

// --- Enter 输入规则守卫 ---------------------------------------------------
//
// 背景（2026-09-20 实测修复）：milkdown 核心的 customInputRules 插件
// （@milkdown/prose/toolkit/input-rules/custom-input-rules.ts）在按 Enter 时，
// 会用「光标前 500 字 + '\n'」依次执行全部 InputRule，且该插件装配在 keymap
// 之前——规则一旦触发，splitBlock 就不再执行。与 prosemirror-inputrules 不同，
// 它不要求正则以 $ 结尾、也不校验匹配是否落在追加的 '\n' 上。
//
// GFM 删除线输入规则没有结尾锚点：
//   /(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/
// 只要段落前方出现过任意配对波浪号（最常见来源：源码里被反斜杠转义的字面量
// \~\~，解析后是普通 ~ 字符），在其后任意位置按 Enter，markRule 都会把
// 旧的 ~...~ 误转成删除线并删掉标记字符——表现为「按回车，前面的字被删」。
//
// 守卫策略（prosePlugins 先于核心 customInputRules 装配，因此本插件先收到
// keydown）：
//   1. 复刻 customInputRules 的扫描，找到首个 handler 返回事务的规则；
//   2. 其匹配终点正好是追加的 '\n'（标题/列表/@box/@@cols/hr 等 \n$ 规则）
//      → 属于设计中的「回车触发型」规则，返回 false 交给原插件原生处理；
//   3. 否则属于误匹配窗口内旧文本 → 拦截本次 Enter，绕过输入规则，
//      直接执行标准分段（列表内 splitListItem，其余 splitBlock）。
type EnterInputRuleLike = {
  match: RegExp
  handler: (state: EditorState, match: RegExpExecArray, from: number, to: number) => Transaction | null
}

function performDefaultEnterSplit(view: EditorView): boolean {
  const { state } = view
  const listItemType = state.schema.nodes.list_item
  if (listItemType) {
    const $from = state.selection.$from
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === listItemType) {
        return splitListItem(listItemType)(state, view.dispatch.bind(view))
      }
    }
  }
  return splitBlock(state, view.dispatch.bind(view))
}

const enterSplitGuardPlugin = $prose((ctx) => {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'Enter' || event.shiftKey) return false
        // Shift+Enter（硬换行）、非折叠选区、代码块均保持原生行为
        const { $cursor } = view.state.selection as TextSelection
        if (!$cursor) return false
        if ($cursor.parent.type.spec.code) return false

        const appended = '\n'
        const textBefore =
          $cursor.parent.textBetween(
            Math.max(0, $cursor.parentOffset - 500),
            $cursor.parentOffset,
            undefined,
            '\uFFFC'
          ) + appended

        const rules = ctx.get(inputRulesCtx) as unknown as EnterInputRuleLike[]
        for (const rule of rules) {
          let match: RegExpExecArray | null
          try {
            match = rule.match.exec(textBefore)
          } catch {
            match = null
          }
          if (!match || !match[0]) continue

          const start = $cursor.pos - (match[0].length - appended.length)
          // handler 在全新 state.tr 上构造事务，不派发即无副作用；
          // 仅用于判断该规则在当前上下文是否真的会生效
          let probe: Transaction | null = null
          try {
            probe = rule.handler(view.state, match, start, $cursor.pos)
          } catch {
            probe = null
          }
          if (!probe) continue

          // 首个生效规则：匹配必须覆盖到追加的 '\n' 才是回车触发型
          if (match.index + match[0].length === textBefore.length) return false

          // 误匹配旧文本：绕过 customInputRules，直接标准分段
          return performDefaultEnterSplit(view)
        }
        // 没有任何规则会生效：交给原链（customInputRules 无匹配后执行 splitBlock）
        return false
      },
    },
  })
})


export function showMathModal(): void {
  mathModal.show()
}

// 工具栏「图片」按钮调用 —— 插入模式，光标处插入新 image 节点
export function showImageModal(): void {
  imageModal.show()
}

// 工具栏「圈号」按钮调用 —— 取光标前汉字，配输入数字插入 circled_sup 节点
export function showCircledSupModal(): void {
  circledSupModal.show()
}

// 工具栏「拼音」按钮调用 —— 插入模式，光标处插入新 pinyin 节点
export function showPinyinModal(): void {
  pinyinModal.show()
}

// 工具栏「子块」按钮调用 —— 插入模式，光标处插入新 sub_block 节点
export function showSubBlockModal(): void {
  subBlockModal.show()
}

// 工具栏「分栏」按钮调用 —— 插入模式，光标处插入新 cols 节点
export function showColsModal(): void {
  colsModal.show()
}

// 工具栏「田字格」按钮调用 —— 插入模式，光标处插入新 tianzi_grid 节点
export function showTianziModal(): void {
  tianziModal.show()
}

// 工具栏「表格」按钮调用 —— 弹出模态框输入行列数
export function showTableModal(): void {
  tableModal.show()
}

// 工具栏「链接」按钮调用 —— 弹出模态框输入链接名称与 URL，
// 插入 markdown 链接语义的文本：[菜鸟教程](https://www.runoob.com)。
// 弹窗结构与拼音弹窗同构（image-modal 行/列/标签/输入），尺寸固定。
//   - 有选区 → 名称预填选中文本；应用时替换为「名称 + link mark」；
//   - 光标已在链接内 → 预填原链接文本与 href，应用即改写；
//   - 剪贴板是合法网址时预填 URL；
//   - 输入无协议时自动补 https://，名称留空时以 URL 为锚文本。
export function showLinkModal(): void {
  const view = getEditorView()
  if (!view || !view.hasFocus()) return
  const linkType = view.state.schema.marks.link
  if (!linkType) return
  const { from, to, empty } = view.state.selection

  // 光标/选区处的现有链接信息（编辑模式预填用）
  const marks = empty
    ? [...(view.state.storedMarks ?? []), ...view.state.doc.resolve(from).marks()]
    : view.state.doc.resolve(Math.min(from + 1, to)).marks()
  const existing = linkType.isInSet(marks)

  const zh = isChinese()
  const t = {
    title: existing ? (zh ? '编辑链接' : 'Edit Link') : (zh ? '插入链接' : 'Insert Link'),
    nameLabel: zh ? '链接名称' : 'Link Text',
    urlLabel: zh ? '链接' : 'URL',
    namePlaceholder: zh ? '链接名称' : 'link name',
    urlPlaceholder: '输入网址',
    hint: zh ? '留空名称时以链接地址作为名称' : 'Falls back to the URL if text is empty',
    cancel: zh ? '取消' : 'Cancel',
    apply: existing ? (zh ? '更新' : 'Update') : (zh ? '插入' : 'Insert'),
  }

  const apply = (rawName: string, rawUrl: string, hintEl: HTMLElement): boolean => {
    const input = rawUrl.trim()
    if (!input) {
      // URL 为空 → 闪红提示
      hintEl.classList.add('circled-sup-modal-hint-error')
      setTimeout(() => hintEl.classList.remove('circled-sup-modal-hint-error'), 1500)
      return false
    }
    const url = /^https?:\/\//i.test(input) ? input : `https://${input}`
    const text = rawName.trim() || url
    const liveView = getEditorView()
    if (!liveView) return true
    const link = liveView.state.schema.marks.link
    if (!link) return true
    const sel = liveView.state.selection
    const tr = liveView.state.tr
    // 用「名称」替换选区（空选区即原位插入），加 link mark，光标落在其后
    tr.insertText(text, sel.from, sel.to)
    const markFrom = sel.from
    const markTo = markFrom + text.length
    tr.addMark(markFrom, markTo, link.create({ href: url }))
    tr.setSelection(TextSelection.create(tr.doc, markTo))
    liveView.dispatch(tr.scrollIntoView())
    liveView.focus()
    return true
  }

  const overlay = document.createElement('div')
  overlay.className = 'math-modal-overlay'

  const modal = document.createElement('div')
  modal.className = 'math-modal link-modal'

  const header = document.createElement('h3')
  header.textContent = t.title

  // 链接名称
  const nameRow = document.createElement('div')
  nameRow.className = 'image-modal-row'
  const nameCol = document.createElement('div')
  nameCol.className = 'image-modal-col'
  const nameLabel = document.createElement('label')
  nameLabel.textContent = t.nameLabel
  nameLabel.className = 'image-modal-label'
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'image-modal-input'
  nameInput.placeholder = t.namePlaceholder
  nameInput.autocomplete = 'off'
  nameCol.append(nameLabel, nameInput)
  nameRow.appendChild(nameCol)

  // 链接地址
  const urlRow = document.createElement('div')
  urlRow.className = 'image-modal-row'
  const urlCol = document.createElement('div')
  urlCol.className = 'image-modal-col'
  const urlLabel = document.createElement('label')
  urlLabel.textContent = t.urlLabel
  urlLabel.className = 'image-modal-label'
  const urlInput = document.createElement('input')
  urlInput.type = 'text'
  urlInput.className = 'image-modal-input'
  urlInput.placeholder = t.urlPlaceholder
  urlInput.autocomplete = 'off'
  urlInput.spellcheck = false
  urlCol.append(urlLabel, urlInput)
  urlRow.appendChild(urlCol)

  // 提示
  const hint = document.createElement('p')
  hint.className = 'circled-sup-modal-hint'
  hint.textContent = t.hint

  // 预填：选中文本 / 已有链接
  if (!empty) {
    nameInput.value = view.state.doc.textBetween(from, to, ' ')
  }
  if (existing) {
    const href = (existing.attrs as { href?: string }).href ?? ''
    urlInput.value = href
  } else {
    // 剪贴板是合法网址时预填 URL（Electron IPC；web 环境跳过）
    void window.electronAPI?.readClipboardText?.().then((clip) => {
      const clipUrl = (clip ?? '').trim()
      if (/^https?:\/\/\S+$/i.test(clipUrl) && !urlInput.value) urlInput.value = clipUrl
    })
  }

  const footer = document.createElement('div')
  footer.className = 'math-modal-footer'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = t.cancel
  cancelBtn.className = 'math-modal-btn cancel'
  cancelBtn.addEventListener('click', () => overlay.remove())

  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.textContent = t.apply
  applyBtn.className = 'math-modal-btn save'
  applyBtn.addEventListener('click', () => {
    if (apply(nameInput.value, urlInput.value, hint)) overlay.remove()
  })

  // 两个输入框内回车即应用，Esc 取消
  for (const field of [nameInput, urlInput]) {
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (apply(nameInput.value, urlInput.value, hint)) overlay.remove()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        overlay.remove()
      }
    })
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) overlay.remove()
  })

  footer.append(cancelBtn, applyBtn)
  modal.append(header, nameRow, urlRow, hint, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  // 名称已预填（有选区）时聚焦 URL，否则聚焦名称
  const focusEl = nameInput.value ? urlInput : nameInput
  focusEl.focus()
  focusEl.select()
}

export function setMathModalLanguage(language: 'zh' | 'en'): void {
  mathModal.setLanguage(language)
  imageModal.setLanguage(language)
  circledSupModal.setLanguage(language)
  pinyinModal.setLanguage(language)
  subBlockModal.setLanguage(language)
  colsModal.setLanguage(language)
  tianziModal.setLanguage(language)
  tableModal.setLanguage(language)
}

export function releaseMermaidRenderer(): void {
  releaseMermaidRendererBridge()
}

let editorInstance: Editor | null = null

// Serialiser options as configured at creation (handlers included). The
// per-document Markdown style is layered on top of these, never replacing them.
let baseStringifyOptions: Record<string, unknown> = {}
let markdownStyleOptions: MarkdownStyle = {}

const inlineStyles: Record<string, string> = {
  'h1': 'font-size:1.8em;margin:1em 0 .5em;padding-bottom:.3em;border-bottom:1px solid #eee;',
  'h2': 'font-size:1.4em;margin:1em 0 .5em;padding-bottom:.25em;border-bottom:1px solid #eee;',
  'h3': 'font-size:1.2em;margin:.8em 0 .4em;',
  'h4': 'margin:.8em 0 .4em;',
  'h5': 'margin:.8em 0 .4em;',
  'h6': 'margin:.8em 0 .4em;',
  'p': 'margin:0;line-height:1.75;',
  'strong': 'font-weight:600;',
  'a': 'color:#0969da;text-decoration:none;',
  'code': 'background:rgba(175,184,193,0.2);padding:2px 6px;border-radius:3px;font-size:.875em;font-family:Menlo,Monaco,monospace;',
  'pre': 'background:#f6f8fa;padding:16px;border-radius:6px;overflow-x:auto;margin:1em 0;',
  'blockquote': 'border-left:4px solid #ddd;padding-left:16px;margin:1em 0;color:#666;',
  'ul': 'padding-left:24px;margin:.5em 0;',
  'ol': 'padding-left:24px;margin:.5em 0;',
  'li': 'margin:.25em 0;',
  'table': 'border-collapse:collapse;width:100%;margin:1em 0;',
  'th': 'border:1px solid #ddd;padding:8px 12px;text-align:left;background:#f6f8fa;',
  'td': 'border:1px solid #ddd;padding:8px 12px;text-align:left;',
  'hr': 'border:none;border-top:2px solid #ddd;margin:2em 0;',
  'img': 'max-width:100%;',
}

function enhanceClipboard(e: ClipboardEvent): void {
  const html = e.clipboardData?.getData('text/html')
  if (!html) return

  const doc = new DOMParser().parseFromString(html, 'text/html')

  for (const [tag, style] of Object.entries(inlineStyles)) {
    doc.querySelectorAll(tag).forEach((el) => {
      ;(el as HTMLElement).setAttribute('style', style)
    })
  }

  // pre > code: override code style inside code blocks
  doc.querySelectorAll('pre code').forEach((el) => {
    ;(el as HTMLElement).setAttribute('style', 'background:none;padding:0;font-size:.875em;line-height:1.6;font-family:Menlo,Monaco,monospace;')
  })

  // Paragraphs carry no margins, so consecutive lines stay tight in chat apps
  // that turn block spacing into visible blank lines. A paragraph the user left
  // empty on purpose still needs one line, which an empty block would lose.
  doc.querySelectorAll('p').forEach((el) => {
    if (!el.textContent?.trim() && !el.querySelector('img,br')) el.appendChild(doc.createElement('br'))
  })

  e.clipboardData?.setData('text/html', doc.body.innerHTML)

  // Preserve the markdown plain-text flavour set by milkdown's clipboardTextSerializer,
  // which retains markdown marks (**bold**, @..@着重号, etc.) so
  // pasting into plain-text targets (Notepad, etc.) keeps the formatting syntax.
  // 空行不再折叠为单行：空行是 markdown 块级语法（段落、分栏定界符、
  // 围栏容器）的结构组成部分，折叠会让粘贴到 markdown 感知目标
  // （本应用提交页、Typora、VS Code）的相邻 :::font / @ 定界符互相粘连，
  // 解析失败退化为字面文本。聊天工具中的段间空行属 markdown 正常形态。
  // text/plain 原样保留（含 \* 等转义）：序列化器对字面 * / ~ 的转义是
  // 语义保真的正确形态，外部目标再粘贴回来不变形。
}

// ─── 粘贴图片 → base64 内嵌 ──────────────────────────────────────────────────
// 用户从剪贴板粘贴截图/复制的图片时，浏览器 ClipboardEvent 的 clipboardData.items
// 里会有一条 type: "image/xxx" 的条目。将其读为 FileReader Data URL（base64），
// 直接作为 image 节点的 src 插入编辑器——Markdown 文本里以
// ![image](data:image/png;base64,...) 形式存在，保存/导出/源码模式折叠均已支持。
//
// 如果剪贴板同时带文本（如从网页复制的图文混排），优先让 milkdown 的内置 paste
// 处理文本/HTML；仅当没有文本 flavour 时才走图片分支。
function handlePasteImage(e: ClipboardEvent): void {
  const items = e.clipboardData?.items
  if (!items) return

  let imageItem: DataTransferItem | null = null
  let hasText = false
  for (const item of items) {
    if (item.kind === 'string') { hasText = true; continue }
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      imageItem = item
    }
  }
  // 剪贴板有文本时让内置粘贴处理文本/HTML，图片由 <img> 标签携带
  if (hasText || !imageItem) return

  const file = imageItem.getAsFile()
  if (!file) return

  // 阻止默认粘贴（否则可能插入无意义的文件名文本）
  e.preventDefault()
  e.stopPropagation()

  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result
    if (typeof dataUrl !== 'string') return
    // 从 MIME 推导 alt 文本，如 "image" + 扩展名
    const ext = file.type.split('/')[1] || 'png'
    const alt = `image-${ext}`
    insertImageAtCursor(dataUrl, alt)
  }
  reader.readAsDataURL(file)
}

// 在当前光标处插入一个 image 节点（base64 data URL 作为 src）。
// 若选区非空则替换选区内容；插入后将光标移到图片之后。
function insertImageAtCursor(src: string, alt: string): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const imageType = view.state.schema.nodes.image
    if (!imageType) return
    const { from, to, empty } = view.state.selection
    if (!empty) {
      view.dispatch(view.state.tr.replaceWith(from, to, imageType.create({ src, alt })))
    } else {
      view.dispatch(view.state.tr.insert(from, imageType.create({ src, alt })))
    }
    // 光标移到图片之后
    const newPos = empty ? from + 1 : to
    const sel = TextSelection.create(view.state.doc, newPos)
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
    view.focus()
  })
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

// Code-block copy button: ONE overlay button rendered OUTSIDE the
// ProseMirror-managed DOM. ProseMirror re-syncs the DOM it owns from its
// document state, so inserting UI nodes inside <pre> gets wiped (or previously
// triggered an infinite rebuild loop — observed as 100% CPU with any fenced
// code block). No MutationObserver is used to avoid self-triggering loops;
// instead the button follows the hovered block and repositions on scroll.
let copyButton: HTMLButtonElement | null = null
let copyButtonPre: HTMLPreElement | null = null
let copyButtonResetTimer: ReturnType<typeof setTimeout> | null = null

function editorRect(): DOMRect {
  return (document.getElementById('editor') as HTMLElement).getBoundingClientRect()
}

function positionCopyButton(pre: HTMLPreElement): void {
  if (!copyButton) return
  const editor = document.getElementById('editor') as HTMLElement
  const rect = pre.getBoundingClientRect()
  const base = editorRect()
  // The button is absolutely positioned inside the scroll container #editor, so
  // its top/left are measured from the scroll-content origin, not from the
  // editor's border box. Add the scroll offsets so it tracks the block.
  copyButton.style.left = `${rect.left - base.left + editor.scrollLeft + rect.width - 8}px`
  copyButton.style.top = `${rect.top - base.top + editor.scrollTop + 8}px`
}

function createCopyButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'code-copy-btn'
  button.textContent = isChinese() ? '复制' : 'Copy'
  button.title = isChinese() ? '复制代码' : 'Copy code'
  button.setAttribute('aria-label', button.title)
  button.style.position = 'absolute'
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!copyButtonPre) return
    const code = copyButtonPre.querySelector('code')?.textContent ?? ''
    try {
      await copyText(code)
      button.textContent = isChinese() ? '已复制 ✓' : 'Copied ✓'
      button.classList.add('copied')
      if (copyButtonResetTimer) clearTimeout(copyButtonResetTimer)
      copyButtonResetTimer = setTimeout(() => {
        button.textContent = isChinese() ? '复制' : 'Copy'
        button.classList.remove('copied')
      }, 1500)
    } catch {
      button.textContent = isChinese() ? '复制失败' : 'Copy failed'
      if (copyButtonResetTimer) clearTimeout(copyButtonResetTimer)
      copyButtonResetTimer = setTimeout(() => { button.textContent = isChinese() ? '复制' : 'Copy' }, 1500)
    }
  })
  document.getElementById('editor')?.appendChild(button)
  return button
}

function setupCodeBlockCopy(root: HTMLElement): void {
  copyButton = createCopyButton()
  const btn = copyButton

  const inButton = (node: Node | null): boolean =>
    !!node && (node === btn || btn.contains(node))

  const showFor = (pre: HTMLPreElement): void => {
    copyButtonPre = pre
    btn.classList.add('hovering')
    positionCopyButton(pre)
  }

  const hide = (): void => {
    copyButtonPre = null
    btn.classList.remove('hovering')
  }

  const positionActive = (): void => {
    if (copyButtonPre) positionCopyButton(copyButtonPre)
  }

  // Show the copy button when the pointer enters a fenced code block.
  root.addEventListener('mouseover', (event) => {
    if (inButton(event.target as Node)) return
    const pre = (event.target as Element | null)?.closest?.('pre') as HTMLPreElement | null
    if (pre && pre.querySelector('code')) showFor(pre)
  })

  // Keep the button visible until the pointer leaves BOTH the block and the
  // button. The button is a sibling overlay sitting on top of the <pre>, so
  // hovering it makes `pre:hover` false — we must not gate visibility on
  // `:hover` or the button disappears mid-interaction (original bug).
  root.addEventListener('mouseout', (event) => {
    const from = (event.target as Element | null)?.closest?.('pre') as HTMLPreElement | null
    if (!from || from !== copyButtonPre) return
    const to = event.relatedTarget as Node | null
    if (inButton(to)) return
    if (to && from.contains(to)) return
    hide()
  })

  btn.addEventListener('mouseout', (event) => {
    const to = event.relatedTarget as Node | null
    if (copyButtonPre && to && copyButtonPre.contains(to)) return
    hide()
  })

  // #editor is the scroll container; reposition when the block moves.
  root.addEventListener('scroll', positionActive, { passive: true })
  window.addEventListener('scroll', positionActive, { passive: true })
  const resizeObserver = new ResizeObserver(positionActive)
  resizeObserver.observe(root)
}

// --- Footnote hover preview (#25) ---
// Hovering a footnote reference shows its definition in a floating card.
// Data comes from the same ProseMirror document (no re-parsing, no IPC);
// clicking a reference keeps its existing jump behavior.

const FOOTNOTE_PREVIEW_DELAY = 300
// Grace for the pointer to cross the gap between the reference and the card,
// and for moving between the two halves of the hover zone.
const FOOTNOTE_HIDE_GRACE = 120

function setupFootnotePreview(root: HTMLElement): void {
  const card = document.createElement('div')
  card.className = 'footnote-preview'
  card.hidden = true
  root.appendChild(card)

  let showTimer: ReturnType<typeof setTimeout> | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let currentRef: HTMLElement | null = null

  const cancelHide = (): void => {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  const hide = (): void => {
    cancelHide()
    if (showTimer) {
      clearTimeout(showTimer)
      showTimer = null
    }
    currentRef = null
    card.hidden = true
  }

  // Leaving the zone does not hide immediately: the grace timer lets the
  // pointer cross the gap between the reference and the card (review on #89).
  const scheduleHide = (): void => {
    cancelHide()
    hideTimer = setTimeout(hide, FOOTNOTE_HIDE_GRACE)
  }

  // The hover zone is the reference plus the card itself, so the definition
  // can be reached and scrolled.
  const inZone = (el: EventTarget | null): boolean => {
    return el instanceof HTMLElement && (card.contains(el) || (currentRef !== null && currentRef.contains(el)))
  }

  // Multi-block definitions must not run together: textContent alone would
  // join paragraphs into one line. Labels match case-insensitively ([^Note]
  // pairs with [^note]); footnote_definition only carries `label`.
  const definitionText = (def: ProseMirrorNode): string => {
    return Array.from({ length: def.childCount }, (_v, i) => def.child(i).textContent).join('\n\n')
  }

  const findDefinitionText = (label: string): string | null => {
    const view = getEditorView()
    if (!view) return null
    const key = label.toLowerCase()
    let text: string | null = null
    view.state.doc.descendants((node) => {
      if (text !== null) return false
      if (node.type.name === 'footnote_definition' && String(node.attrs.label ?? '').toLowerCase() === key) {
        text = definitionText(node)
        return false
      }
      return true
    })
    return text
  }

  const show = (ref: HTMLElement): void => {
    // The content may have been re-set while the timer ran; a detached
    // reference must never surface a stale card.
    if (!ref.isConnected) {
      hide()
      return
    }
    const label = ref.getAttribute('data-label') ?? ''
    const text = label ? findDefinitionText(label) : null
    if (text === null || !text.trim()) {
      hide()
      return
    }
    card.textContent = text
    card.hidden = false
    const refRect = ref.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const left = Math.max(8, Math.min(refRect.left, window.innerWidth - cardRect.width - 8))
    let top = refRect.bottom + 6
    if (top + cardRect.height > window.innerHeight - 8) {
      top = Math.max(8, refRect.top - cardRect.height - 6)
    }
    card.style.left = `${left}px`
    card.style.top = `${top}px`
  }

  root.addEventListener('mouseover', (e) => {
    const target = e.target as HTMLElement
    // Hovering the card itself keeps it up so the definition can be scrolled.
    if (card.contains(target)) {
      cancelHide()
      return
    }
    const ref = target.closest<HTMLElement>('sup[data-type="footnote_reference"]')
    if (!ref) return
    cancelHide()
    if (ref === currentRef) return
    if (showTimer) clearTimeout(showTimer)
    currentRef = ref
    showTimer = setTimeout(() => {
      if (currentRef === ref) show(ref)
    }, FOOTNOTE_PREVIEW_DELAY)
  })
  root.addEventListener('mouseout', (e) => {
    if (!inZone(e.target)) return
    if (inZone(e.relatedTarget)) {
      // Moved within the zone (ref → card, card → ref, or inside either).
      cancelHide()
      return
    }
    scheduleHide()
  })
  // Fixed positioning goes stale the moment the document moves. Only the
  // editor's own scroll hides the card: scrolling inside the card's overflow
  // must not (bubbles through here otherwise).
  root.addEventListener('scroll', (e) => {
    if (e.target === root) hide()
  }, { passive: true })
  window.addEventListener('resize', hide)
  // Clicking a reference jumps to the definition; the card must not linger.
  root.addEventListener('click', hide)
}

// --- Format commands (#58): one pipeline for every format shortcut ---
// Marks toggle on the selection; lists wrap the current block. Empty
// selections are a no-op for marks, matching the previous cmd+B behavior.

export type FormatCommandId = 'bold' | 'italic' | 'inlineCode' | 'strikethrough' | 'emphDot' | 'underline' | 'subscript' | 'superscript' | 'highlight' | 'link' | 'bulletList' | 'orderedList'

export function runFormatCommand(id: FormatCommandId): void {
  if (!editorInstance) return
  editorInstance.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    // Menu accelerators are window-global. Without focus in the editor they
    // would write marks into the hidden ProseMirror document (source mode
    // textarea, search panel, file panel); gate them like the old keydown
    // handler, which only lived on the editor root.
    if (!view.hasFocus()) return
    const { from, to, empty } = view.state.selection
    if (id === 'bulletList' || id === 'orderedList') {
      const nodeType = view.state.schema.nodes[id === 'bulletList' ? 'bullet_list' : 'ordered_list']
      const itemType = view.state.schema.nodes.list_item
      if (!nodeType || !itemType) return
      // Toggle: pressing the shortcut inside that list type lifts the block
      // out instead of nesting another layer (review on #87).
      let inside = false
      for (let depth = view.state.selection.$from.depth; depth > 0; depth -= 1) {
        if (view.state.selection.$from.node(depth).type === nodeType) {
          inside = true
          break
        }
      }
      if (inside) liftListItem(itemType)(view.state, view.dispatch)
      else wrapInList(nodeType)(view.state, view.dispatch)
      return
    }
    if (id === 'link') {
      const link = view.state.schema.marks.link
      if (!link || empty) return
      // Toggle like every other mark: ⌘K on a linked selection removes it
      // instead of overwriting the href (review on #87).
      if (view.state.doc.rangeHasMark(from, to, link)) {
        view.dispatch(view.state.tr.removeMark(from, to, link))
        return
      }
      // The URL comes from the main-process clipboard via IPC: menu
      // accelerators carry no transient user activation, so a renderer-side
      // clipboard read is not guaranteed to be allowed on every platform.
      void window.electronAPI.readClipboardText().then((text) => {
        const url = text.trim()
        const liveView = getEditorView()
        if (!liveView || !/^https?:\/\/\S+$/i.test(url)) return
        const selection = liveView.state.selection
        liveView.dispatch(liveView.state.tr.addMark(selection.from, selection.to, link.create({ href: url })))
      })
      return
    }
    const candidates = id === 'bold'
      ? ['strong']
      : id === 'italic'
        ? ['em', 'emphasis']
        : id === 'inlineCode'
          ? ['inlineCode', 'code']
          : id === 'emphDot'
            // 规约A：字下着重号 mark（src/extensions/emph-dot）
            ? ['emphDot']
            : id === 'underline'
              // 文字下划线 mark（src/extensions/underline，<u>…</u>）
              ? ['underline']
              // 上下标 mark（src/extensions/sub-sup，_{x} / ^{x}）
              : id === 'subscript'
                ? ['subscript']
                : id === 'superscript'
                  ? ['superscript']
                  // ==高亮== mark（src/renderer/editor/highlight.ts，==text==）
                  : id === 'highlight'
                    ? ['highlight']
                    // Milkdown's gfm preset registers the mark as `strike_through`
                  // even though the export is named strikethroughSchema (review on #87).
                  : ['strike_through', 'strikethrough']
    const mark = candidates.map((name) => view.state.schema.marks[name]).find(Boolean)
    if (!mark || empty) return
    const has = view.state.doc.rangeHasMark(from, to, mark)
    view.dispatch(has ? view.state.tr.removeMark(from, to, mark) : view.state.tr.addMark(from, to, mark.create()))
  })
}

// ─── 工具栏专用命令与状态查询 ────────────────────────────────────────────────
// 工具栏（#toolbar）所有按钮都走这里：历史、段落类型、引用、分割线、任务列表，
// 以及光标所在标记/块的实时状态（用于按钮按下态高亮）。

export type ToolbarBlockKind =
  | 'paragraph'
  | 'heading1' | 'heading2' | 'heading3'
  | 'heading4' | 'heading5' | 'heading6'

export interface ToolbarState {
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  emphDot: boolean
  underline: boolean
  subscript: boolean
  superscript: boolean
  link: boolean
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  quote: boolean
  /** 选区/光标命中 font_span 行内标记或 font_block 块容器（供「清除字体」高亮） */
  font: boolean
  /** 光标/选区处的字体族（行内 font_span 优先，font_block 祖先链补齐），无则为 null */
  fontFamily: string | null
  /** 光标/选区处的字号（同上），无则为 null */
  fontSize: string | null
  block: ToolbarBlockKind
}

function emptyToolbarState(): ToolbarState {
  return {
    bold: false, italic: false, strike: false, code: false, emphDot: false, underline: false, subscript: false, superscript: false, link: false,
    bulletList: false, orderedList: false, taskList: false, quote: false, font: false,
    fontFamily: null, fontSize: null,
    block: 'paragraph',
  }
}

// 撤销/重做。工具栏按钮 mousedown 已 preventDefault，焦点仍在编辑器里。
export function runHistoryCommand(id: 'undo' | 'redo'): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const cmd = id === 'undo' ? pmUndo : pmRedo
    cmd(view.state, view.dispatch)
    view.focus()
  })
}

// 段落/标题切换。milkdown commonmark 的 heading 是单一节点类型 + level 属性。
export function setBlockKind(kind: ToolbarBlockKind): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const schema = view.state.schema
    const cmd = kind === 'paragraph'
      ? setBlockType(schema.nodes.paragraph)
      : setBlockType(schema.nodes.heading, { level: Number(kind.slice(-1)) })
    cmd(view.state, view.dispatch)
  })
}

// 引用块 toggle：在引用内则提升出去，否则用 blockquote 包裹当前块。
export function toggleBlockquote(): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const blockquote = view.state.schema.nodes.blockquote
    const { $from, $to } = view.state.selection
    // blockRange 第二参是目标容器谓词：有引用祖先时，range 精确取引用层，
    // liftTarget 给出提升目标；无引用时返回 null，走 wrapIn。
    const quoteRange = $from.blockRange($to, (node) => node.type === blockquote)
    if (quoteRange) {
      const target = liftTarget(quoteRange)
      if (target == null) return
      view.dispatch(view.state.tr.lift(quoteRange, target).scrollIntoView())
    } else {
      wrapIn(blockquote)(view.state, view.dispatch)
    }
  })
}

// 分割线：复刻 commonmark insertHrCommand —— 插入 hr 并在其前补一个空段落
// 承接光标（hr 是 atom 块，直接替换选区后光标无处可放）。
export function insertHorizontalRule(): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const schema = view.state.schema
    const hrNode = schema.nodes.hr
    const paragraphNode = schema.nodes.paragraph
    if (!hrNode || !paragraphNode) return
    const { state } = view
    const { from } = state.selection
    const tr = state.tr.replaceSelectionWith(hrNode.create()).insert(from, paragraphNode.create())
    const sel = Selection.findFrom(tr.doc.resolve(from), 1, true)
    if (!sel) return
    view.dispatch(tr.setSelection(sel).scrollIntoView())
  })
}

// 长下划线（填空线）长度：10 个全角下划线 ≈ 10 个汉字宽。
// 用全角 ＿（U+FF3F）而非半角 _：半角下划线会被 remark-stringify 保守转义
// 成 \_（源码不可读），全角下划线不参与 Markdown 强调语法，源码原样保存、
// 中文字体下渲染为连续横线、docx 导出也是普通字符，全链路无损。
const LONG_UNDERSCORE = '＿'.repeat(10)

// 在光标处插入长下划线（填空线）。选区非空时替换选区；insertText 后选区
// 自动折叠到插入文本末尾，用户可直接继续输入。
export function insertLongUnderscore(): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const { from, to } = view.state.selection
    // 同一事务内插入文本并把光标放到线末尾（insertText 本身也会映射选区，
    // 显式设置保证光标位置确定）
    const tr = view.state.tr.insertText(LONG_UNDERSCORE, from, to)
    tr.setSelection(TextSelection.create(tr.doc, from + LONG_UNDERSCORE.length))
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })
}

// 长空白宽度：10 个全角空格（U+3000）≈ 10 个汉字宽。
// 必须用全角空格而非半角空格（U+0020）：连续半角空格会被 HTML 渲染折叠、
// 且可能被 Markdown 序列化规整；全角空格是普通 CJK 字符，不参与 Markdown
// 语法（不会被 trim/转义）、浏览器不折叠、源码原样保存、docx 也是普通字符，
// 与长下划线同一套无损策略。
const LONG_BLANK = '　'.repeat(10)

// 在光标处插入长空白（留空）。选区非空时替换选区，语义同 insertLongUnderscore。
export function insertLongBlank(): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const { from, to } = view.state.selection
    const tr = view.state.tr.insertText(LONG_BLANK, from, to)
    tr.setSelection(TextSelection.create(tr.doc, from + LONG_BLANK.length))
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })
}

// 在光标处插入任意文本（插入符号面板等入口）。选区非空时替换选区，
// 光标折叠到插入文本末尾，语义同 insertLongUnderscore。
export function insertTextAtCursor(text: string): void {
  if (!text) return
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const { from, to } = view.state.selection
    const tr = view.state.tr.insertText(text, from, to)
    tr.setSelection(TextSelection.create(tr.doc, from + text.length))
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })
}

// 任务列表 toggle：gfm 的任务列表 = bullet_list 内嵌带 checked 属性的
// list_item（checked=null 为普通列表项，false/true=任务项）。
// 不在列表内 → 包裹为任务列表；在列表内 → 在「普通列表项」与「任务项」间切换。
export function toggleTaskList(): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const schema = view.state.schema
    const itemType = schema.nodes.list_item
    const bulletListType = schema.nodes.bullet_list
    const orderedListType = schema.nodes.ordered_list
    if (!itemType || !bulletListType) return
    const { state } = view
    const { $from, $to } = state.selection

    // 找到包裹选区的列表层（有则就地切换 checked，无则新包一层）
    const listRange = $from.blockRange($to, (node) =>
      node.type === bulletListType || node.type === orderedListType)
    if (!listRange) {
      // 当前 prosemirror-schema-list 的 wrapInList 只接受列表属性（2 参），
      // 无法直接给自动生成的 list_item 传 checked。改为手动包裹：
      // findWrapping 算出 bullet_list 包裹层，tr.wrap 后新生成的 item
      // 默认 checked=null（普通项），再把直接挂在新 bullet_list 下的 item
      // 批量改成 checked=false（任务项）。
      const wrapRange = $from.blockRange($to)
      if (!wrapRange) return
      const wrapping = findWrapping(wrapRange, bulletListType, null)
      if (!wrapping) return
      const tr = state.tr.wrap(wrapRange, wrapping)
      // bias +1/-1 让映射点落在新列表内部（包裹层插入点之后/之前）
      const newStart = tr.mapping.map(wrapRange.start, 1)
      const newEnd = tr.mapping.map(wrapRange.end, -1)
      const itemPos: number[] = []
      tr.doc.nodesBetween(newStart, newEnd, (node, pos) => {
        if (node.type === itemType && tr.doc.resolve(pos).parent.type === bulletListType) {
          itemPos.push(pos)
        }
      })
      for (const pos of itemPos) {
        const node = tr.doc.nodeAt(pos)
        if (node) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false })
      }
      view.dispatch(tr.scrollIntoView())
      return
    }
    const itemPositions: { pos: number; checked: unknown }[] = []
    state.doc.nodesBetween(listRange.start, listRange.end, (node, pos) => {
      if (node.type === itemType) {
        itemPositions.push({ pos, checked: node.attrs.checked })
        return false
      }
      return true
    })
    if (itemPositions.length === 0) return
    // 全部已是任务项 → 转回普通项；任一不是 → 全部变任务项
    const turnOff = itemPositions.every((item) => item.checked !== null && item.checked !== undefined)
    const tr = state.tr
    for (const { pos, checked } of itemPositions) {
      const node = state.doc.nodeAt(pos)
      if (!node) continue
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: turnOff ? null : false })
    }
    view.dispatch(tr)
  })
}

// 插入表格：用 GFM schema 创建 rows×cols 空表格并替换当前选区。
// 默认 3 行 3 列（首行为表头行）。
export function insertTable(rows = 3, cols = 3): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const schema = view.state.schema
    const tableType = schema.nodes.table
    const tableHeaderRowType = schema.nodes.table_header_row
    const tableRowType = schema.nodes.table_row
    const tableHeaderType = schema.nodes.table_header
    const tableCellType = schema.nodes.table_cell
    const paragraphType = schema.nodes.paragraph
    if (!tableType || !tableRowType || !tableCellType || !paragraphType) return

    // 创建空单元格（含一个空段落占位，否则 ProseMirror 不允许光标进入）
    const makeCell = (cellType: typeof tableCellType) =>
      cellType.createAndFill()!
    const headerCells = Array.from({ length: cols }, () => makeCell(tableHeaderType!))
    const bodyCells = Array.from({ length: cols }, () => makeCell(tableCellType))
    const rows_ = Array.from({ length: rows }, (_, i) =>
      (i === 0 && tableHeaderRowType
        ? tableHeaderRowType.create(null, headerCells)
        : tableRowType.create(null, bodyCells)))
    const table = tableType.create(null, rows_)

    const { state } = view
    const { from } = state.selection
    // 替换选区，在表格后补一个空段落供光标落脚
    const tr = state.tr.replaceSelectionWith(table).insert(from + table.nodeSize, paragraphType.create())
    const sel = Selection.findFrom(tr.doc.resolve(from + 1), 1, true)
    if (sel) tr.setSelection(sel)
    view.dispatch(tr.scrollIntoView())
  })
}

// 设置光标所在列的对齐属性。
//
// GFM 表格有一个 keepTableAlignPlugin（@milkdown/preset-gfm），它的 appendTransaction
// 会遍历所有 table_cell（body cell），强制每列的 body cell alignment 与同列的
// header cell（table_header）保持一致。因此直接修改 body cell 会被插件立刻还原，
// 表现为「点了没反应」。
//
// 正确做法：修改该列的 header cell 的 alignment，插件会自动把同列所有 body cell
// 同步为相同的值。这也与 GFM Markdown 序列表头对齐语义一致（| :---: | 决定整列）。
export function setTableAlignment(alignment: 'left' | 'center' | 'right'): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const { state } = view
    const $head = state.selection.$head

    // 向上查找 table 节点和当前 cell 节点的深度
    let tableDepth = -1
    let cellDepth = -1
    for (let d = $head.depth; d > 0; d--) {
      const n = $head.node(d)
      if (cellDepth === -1 && (n.type.name === 'table_cell' || n.type.name === 'table_header')) {
        cellDepth = d
      }
      if (n.type.name === 'table') {
        tableDepth = d
        break
      }
    }
    if (tableDepth === -1 || cellDepth === -1) return

    const table = $head.node(tableDepth)
    const tablePos = $head.before(tableDepth)
    const cellNode = $head.node(cellDepth)
    // 深度结构：table(d) → row(d+1) → cell(d+2) → paragraph(d+3)
    // 因此包含当前 cell 的行节点在 cellDepth - 1，不是 +1（+1 是 cell 内的段落，
    // 在段落子节点里找 cell 永远匹配不到，colIndex 会错误地保持 0）。
    const cellRow = $head.node(cellDepth - 1)

    // 计算当前单元格在行中的列索引
    let colIndex = 0
    cellRow.forEach((child, _offset, i) => {
      if (child === cellNode) colIndex = i
    })

    // 表头行 = table 的第一个子节点（schema: table_header_row table_row+）
    const headerRow = table.firstChild
    if (!headerRow || headerRow.type.name !== 'table_header_row') return

    // 定位表头单元格的绝对位置：
    //   tablePos      → <table> 开标签
    //   tablePos + 1  → <table_header_row> 开标签（第一个子节点）
    //   tablePos + 2  → headerRow 内容起点 = 第一个 header cell 开标签
    // 后续 cell 位置累加前驱 cell 的 nodeSize（含开闭标签）
    let headerCellPos = tablePos + 2
    for (let i = 0; i < colIndex; i++) {
      headerCellPos += headerRow.child(i).nodeSize
    }
    const headerCell = headerRow.child(colIndex)
    if (!headerCell) return

    const tr = state.tr.setNodeMarkup(headerCellPos, undefined, {
      ...headerCell.attrs,
      alignment,
    })
    view.dispatch(tr)
    view.focus()
  })
}

// 应用字体样式（规约H 双轨体系）：
// - 同一段落内的局部选区 → 行内 font_span mark（{= :} 标记）；
// - 跨越块边界（多个段落/列表项等）的选区 → 块级容器 font_block（:::font 指令），
//   对应 Word「段落样式」；若选区恰好覆盖某个已有容器的全部内容，则直接更新
//   该容器的属性（合并），避免产生冗余嵌套。
// 可分别设置 family 和 size（合并已有 attrs），也可用 clear: true 清除。
// 空选区时操作 storedMarks（影响后续输入）。
export function applyFont(attrs: { family?: string; size?: string; clear?: boolean }): void {
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    // 原生菜单点击后编辑器会短暂失焦，但不能因此跳过操作——
    // 选区仍在 state 中，mark 操作不依赖 DOM 焦点。
    const state = view.state
    const { from, to, empty } = state.selection
    const markType = state.schema.marks['font_span']
    const blockType = state.schema.nodes['font_block']
    if (!markType) return

    // ── 判定选区是否跨越块边界 ──
    // blockRange 返回最近公共块祖先内被覆盖的块区间：同段内局部选区的 parent
    // 是段落本身（endIndex - startIndex === 1，不跨块）；跨段选区的 parent 是
    // doc/引用/列表等公共祖先，覆盖 ≥2 个块 → 跨块。
    const selRange = empty ? null : state.selection.$from.blockRange(state.selection.$to)
    const crossesBlocks = !!selRange && selRange.endIndex - selRange.startIndex > 1

    if (attrs.clear) {
      if (empty) {
        view.dispatch(state.tr.removeStoredMark(markType))
        return
      }
      const tr = state.tr
      // 跨块选区：先移除与选区相交的 font_block 容器（仅删容器，内容原样提升）。
      // 块级样式作用于整块（规约 2.3），因此按 Word 段落样式惯例：选区触及的
      // 容器整体移除。逐个提升并在每轮重新映射选区位置，直至无相交容器。
      if (crossesBlocks && blockType) {
        for (let guard = 0; guard < 50; guard += 1) {
          const selFrom = tr.mapping.map(from)
          const selTo = tr.mapping.map(to, -1)
          // 用数组而非可空变量承接回调内结果，规避 TS 闭包收窄为 never 的问题
          const hits: { from: number; to: number }[] = []
          tr.doc.nodesBetween(selFrom, selTo, (node, pos) => {
            if (hits.length) return false
            if (node.type !== blockType) return true
            const innerFrom = pos + 1
            const innerTo = pos + node.nodeSize - 1
            // 内容区间与选区相交才算命中（避免仅擦边的情况）
            if (innerTo > selFrom && innerFrom < selTo) hits.push({ from: innerFrom, to: innerTo })
            return hits.length === 0
          })
          if (!hits.length) break
          const inner = tr.doc.resolve(hits[0].from).blockRange(tr.doc.resolve(hits[0].to))
          const target = inner ? liftTarget(inner) : null
          if (!inner || target == null) break
          tr.lift(inner, target)
        }
      }
      // 再清除选区内残余的行内 font_span（位置按容器提升后的映射换算）
      const mappedFrom = tr.mapping.map(from)
      const mappedTo = tr.mapping.map(to, -1)
      if (mappedTo > mappedFrom) tr.removeMark(mappedFrom, mappedTo, markType)
      view.dispatch(tr.scrollIntoView())
      return
    }

    if (empty) {
      // 空选区：更新 storedMarks
      const stored = state.storedMarks ?? []
      const current = stored.find((m) => m.type === markType)
      const newAttrs = {
        family: attrs.family ?? current?.attrs.family ?? '',
        size: attrs.size ?? current?.attrs.size ?? '',
      }
      view.dispatch(
        state.tr.removeStoredMark(markType).addStoredMark(markType.create(newAttrs))
      )
      return
    }

    // ── 跨块选区：应用块级容器（:::font 指令）──
    if (crossesBlocks && blockType && selRange) {
      // 选区恰好覆盖某个 font_block 的全部内容 → 更新该容器属性（合并，未指定的
      // 属性保留原值），不再嵌套新容器。
      if (
        selRange.parent.type === blockType &&
        selRange.startIndex === 0 &&
        selRange.endIndex === selRange.parent.childCount
      ) {
        const pos = selRange.$from.before(selRange.depth)
        const node = state.doc.nodeAt(pos)
        if (node) {
          view.dispatch(
            state.tr
              .setNodeMarkup(pos, undefined, {
                ...node.attrs,
                family: attrs.family ?? node.attrs.family,
                size: attrs.size ?? node.attrs.size,
              })
              .scrollIntoView()
          )
          return
        }
      }
      // 其余情况用新的 font_block 包裹被覆盖的整块内容（规约允许嵌套容器，
      // 内层样式覆盖外层）。schema 不允许插入时（如选区在列表内部）findWrapping
      // 返回 null → 退回行内 mark。
      const wrapping = findWrapping(selRange, blockType, {
        family: attrs.family ?? '',
        size: attrs.size ?? '',
        align: '',
      })
      if (wrapping) {
        view.dispatch(state.tr.wrap(selRange, wrapping).scrollIntoView())
        return
      }
    }

    // 有选区：读取选区内部已有的 font_span mark attrs，合并后重新设置
    // 注意：不能用 from 位置（选区边界），若 from 在段落开头，ResolvedPos.marks()
    // 返回空数组，不包含选区内文字上的 mark。用 from+1（选区内部）读取。
    const $inside = state.doc.resolve(Math.min(from + 1, to))
    const existing = $inside.marks().find((m) => m.type === markType)
    const newAttrs = {
      family: attrs.family ?? existing?.attrs.family ?? '',
      size: attrs.size ?? existing?.attrs.size ?? '',
    }
    view.dispatch(
      state.tr
        .removeMark(from, to, markType)
        .addMark(from, to, markType.create(newAttrs))
    )
  })
}

// 查询光标/选区当前命中的标记与块，供工具栏按钮按下态高亮。
export function getToolbarState(): ToolbarState {
  const result = emptyToolbarState()
  editorInstance?.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) return
    const state = view.state
    const { from, to, empty, $from } = state.selection

    const checkMark = (names: string[]): boolean => {
      const mark = names.map((name) => state.schema.marks[name]).find(Boolean)
      if (!mark) return false
      if (!empty) return state.doc.rangeHasMark(from, to, mark)
      // 光标在标记内：storedMarks（刚输入完仍有效）或解析位置处已有的 marks
      return [...(state.storedMarks ?? []), ...$from.marks()].some((m) => m.type === mark)
    }
    result.bold = checkMark(['strong'])
    result.italic = checkMark(['em', 'emphasis'])
    result.strike = checkMark(['strike_through', 'strikethrough'])
    result.code = checkMark(['inlineCode', 'code'])
    result.emphDot = checkMark(['emphDot'])
    result.underline = checkMark(['underline'])
    result.subscript = checkMark(['subscript'])
    result.superscript = checkMark(['superscript'])
    result.link = checkMark(['link'])

    // 字体样式命中：行内 font_span mark，或 font_block 块容器。
    // - 行内：选区含 mark（光标在 mark 内也算）；
    // - 块级：空选区看光标祖先链；非空选区看区间内是否相交 font_block
    //   （nodesBetween 会遍历覆盖区间的祖先容器）。
    let inFontBlock = false
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === 'font_block') {
        inFontBlock = true
        break
      }
    }
    if (!empty && !inFontBlock) {
      state.doc.nodesBetween(from, to, (node) => {
        if (node.type.name === 'font_block') {
          inFontBlock = true
          return false
        }
        return true
      })
    }
    result.font = checkMark(['font_span']) || inFontBlock

    // 字体/字号同步：行内 font_span attrs 优先（选区内部位置读取，与
    // applyFont 合并语义一致），缺失字段由 font_block 祖先链从内向外补齐。
    const fontMarkType = state.schema.marks['font_span']
    if (fontMarkType) {
      let markAttrs: { family?: string; size?: string } | null = null
      if (empty) {
        const m = [...(state.storedMarks ?? []), ...$from.marks()].find((x) => x.type === fontMarkType)
        if (m) markAttrs = m.attrs as { family?: string; size?: string }
      } else {
        const $inside = state.doc.resolve(Math.min(from + 1, to))
        const m = $inside.marks().find((x) => x.type === fontMarkType)
        if (m) markAttrs = m.attrs as { family?: string; size?: string }
      }
      if (markAttrs?.family) result.fontFamily = markAttrs.family
      if (markAttrs?.size) result.fontSize = markAttrs.size
    }
    if (!result.fontFamily || !result.fontSize) {
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const node = $from.node(depth)
        if (node.type.name === 'font_block') {
          if (!result.fontFamily && node.attrs.family) result.fontFamily = node.attrs.family
          if (!result.fontSize && node.attrs.size) result.fontSize = node.attrs.size
          if (result.fontFamily && result.fontSize) break
        }
      }
    }

    // 当前块类型（段落/标题）
    const parent = $from.parent
    if (parent.type.name === 'heading') {
      const level = Number(parent.attrs.level)
      if (level >= 1 && level <= 6) result.block = `heading${level}` as ToolbarBlockKind
    }

    // 向上遍历祖先判断列表/引用
    let inTask = false
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth)
      if (node.type.name === 'bullet_list') result.bulletList = true
      if (node.type.name === 'ordered_list') result.orderedList = true
      if (node.type.name === 'blockquote') result.quote = true
      if (node.type.name === 'list_item' && node.attrs.checked !== null && node.attrs.checked !== undefined) {
        inTask = true
      }
    }
    result.taskList = inTask
  })
  return result
}

// 选区/文档变化时通知工具栏刷新按下态。用独立 ProseMirror plugin 的
// view.update 钩子，不修改任何事务，只做读侧通知。
const toolbarStateListeners = new Set<() => void>()

export function onToolbarStateChange(listener: () => void): () => void {
  toolbarStateListeners.add(listener)
  return () => { toolbarStateListeners.delete(listener) }
}

const toolbarStatePlugin = $prose(() => new Plugin({
  view: () => ({
    update: () => {
      for (const listener of toolbarStateListeners) listener()
    },
  }),
}))

function defaultContent(): string {
  // 空文档：启动页不预置任何文字
  return ''
}

export async function createEditor(
  rootId: string,
  onChange?: (markdown: string) => void,
  onDocumentChange?: () => void
): Promise<Editor> {
  const root = document.getElementById(rootId)
  if (!root) throw new Error(`Element #${rootId} not found`)

  const documentChangePlugin = onDocumentChange
    ? $prose(() => new Plugin({
      state: {
        init: () => null,
        apply(tr, value) {
          if (tr.docChanged) {
            // 语法揭示的进入/接管事务、以及内容未被编辑的提交事务，序列化
            // 结果不变（md_source 原样输出 markdown），不应把文档标记为已修改；
            // changed=true 表示用户在揭示态真的改了内容，照常计脏。
            const revealMeta = tr.getMeta(syntaxRevealPluginKey) as { changed?: boolean } | undefined
            if (revealMeta?.changed === false) return value
            onDocumentChange()
          }
          return value
        }
      }
    }))
    : null

  setupCodeBlockCopy(root)
  setupFootnotePreview(root)

  let editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, defaultContent())
      ctx.set(remarkPluginsCtx, [
        // 转义字符保真（最前）：按原文 position 把 text 中被消耗的 `\标点`
        // 拆为 escape 节点 → escaped_literal mark。必须在任何 raw-text
        // transformer（columns 的 normalizeFontMarkerLines 会改写 vfile）之前，
        // 此时 position 与原文严格一致。
        { plugin: remarkEscapedLiteral, options: {} },
        // 块级容器插件放最前：在原始文本上识别 @box / @@cols 区域，
        // 内部内容递归走完整解析管线，不受 remark-breaks 拆行影响。
        { plugin: remarkColumns, options: {} },
        // 规约H 块级容器：遍历 mdast 树找 ::: {attrs} ... ::: 区域。
        // 放在 columns 之后（columns 已把 @box 区域切为 subBlock 节点，
        // fontBlock 仅在剩余段落级子节点中识别标记，天然不冲突），
        // 在 remarkBreaks / 行内扩展之前运行。
        { plugin: remarkFontBlock, options: {} },
        // 残余强调重解析：CommonMark 的侧翼规则会把 **@.内容.@** / **<u>内容</u>**
        // 等「标点紧邻 ** / * / ~~」的情形判为不可开/关，导致标记留在 text 节点里。
        // 此插件在 remarkGfm 解析之后、remarkEmphDot 之前运行，
        // 把残余的 **..** / *..* / ~~..~~ 拆为 strong / emphasis / delete 节点，
        // 内部 text 交由后续插件继续处理（@..@ → emphDot）。
        { plugin: remarkResidualEmphasis, options: {} },
        // remarkEmphDot 必须在 remarkBreaks 之前：规约A「支持段落内换行」，
        // 重音符：把 @.内容.@ 拆为 emphDot mark。在 residual-emphasis 之后运行，
        // 这样 **@.内容.@** 先被拆成 strong{text("@.内容.@")}，再由 emphDot 处理内部。
        { plugin: remarkEmphDot, options: {} },
        // 文字下划线：在 mdast 子节点序列中配对 html <u>/</u>。
        // 与 emphDot 同为跨行 mark，须在 remarkBreaks 之前；放
        // residual-emphasis 之后（html 节点不受其展开影响）。
        { plugin: remarkUnderline, options: {} },
        // 规约H 行内标记：在 text 节点扫描 {= attrs : text}。
        // 与 emphDot 同模式，需在 remarkBreaks 之前以支持跨软换行匹配。
        { plugin: remarkFontSpan, options: {} },
        { plugin: remarkBreaks, options: {} },
        { plugin: remarkHighlight, options: {} },
        { plugin: remarkBlankLine, options: {} },
        { plugin: remarkPinyinRuby, options: {} },
        { plugin: remarkPinyinInline, options: {} },
        { plugin: remarkCircledSup, options: {} },
        // 通用上下标（化学式）：_{x} 走 micromark tokenize 层（抢在 emphasis
        // 之前消费，见 sub-sup/micromark-subscript.ts），^{x} 走 mdast 后置扫描。
        // 必须在 remarkCircledSup 之后：`字^{12}`（汉字+纯数字）由带圈序号
        // 优先消费，本插件只处理剩余形态（`字^{2-}` / `x^{2}`）。
        { plugin: remarkSubSup, options: {} },
        { plugin: remarkTianziGrid, options: {} },
        { plugin: remarkMathFalsePositiveGuard, options: {} },
      ])
      ctx.set(katexOptionsCtx.key, { throwOnError: false })
      // Teach remark-stringify how to emit our custom ==highlight== node
      const stringifyOptions = ctx.get(remarkStringifyOptionsCtx)
      baseStringifyOptions = {
        ...stringifyOptions,
        // Keep the editor's smart line breaks as plain Markdown newlines.
        // remark-breaks restores them on parse, so source mode never leaks `\`.
        handlers: {
          ...stringifyOptions.handlers,
          mark: highlightStringifyHandler,
          underline: underlineStringifyHandler,
          blankLine: blankLineStringifyHandler,
          emphDot: emphDotStringifyHandler,
          pinyinRuby: pinyinRubyStringifyHandler,
          pinyinInline: pinyinInlineStringifyHandler,
          circledSup: circledSupStringifyHandler,
          subscript: subscriptStringifyHandler,
          superscript: superscriptStringifyHandler,
          subBlock: subBlockStringifyHandler,
          cols: colsStringifyHandler,
          fontBlock: fontBlockStringifyHandler,
          fontSpan: fontSpanStringifyHandler,
          tianziGrid: tianziGridStringifyHandler,
          break: () => '\n'
        } as typeof stringifyOptions.handlers
      }
      ctx.set(remarkStringifyOptionsCtx, { ...baseStringifyOptions, ...markdownStyleOptions })
      if (onChange) {
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChange(markdown)
        })
      }
    })
    .use(commonmark)
    // 有序列表序号保真：同名 schema 覆盖官方 ordered_list（parseMarkdown 丢
    // start / toMarkdown 硬编码 start:1 / toDOM start 属性无效，三处缺陷
    // 导致粘贴连续序号列表被重置为 1）。必须在 commonmark 之后注册。
    .use(orderedListFixSchema)
    // 转义字符保真：escaped_literal mark 记录「来自转义的字面字符」，
    // 序列化还原 `\x`（\[你好\] 不再被规范化成 \[你好]）。新 mark 不
    // 覆盖任何官方 schema，但需在 commonmark 之后注册以保证 mark 顺序
    // （序列化时 escaped 最后 open、最内层）。
    .use(escapedLiteralMark)
    // 链接 mark inclusive: false：GFM autolink 产生的链接末尾敲字不再被吸进
    // 超链接（光标困住问题），链接内部敲字仍保持链接。见 link-fix.ts。
    .use(linkFixSchema)
    // 链接输入规则：commonmark 有图片的输入规则却没有链接的——wysiwyg
    // 敲 [text](url) 永远是字面文本，切源码就变成 \[text\]\(url\...)。
    // 补 Typora 式规则：敲完收尾 ) 即转为真链接。见 link-fix.ts。
    .use(linkInputRule)
    .use(gfm)
    .use(highlight)
    .use(blankLinePlugin)
    .use(emphDotPlugin)
    // 文字下划线 mark：<u>内容</u> 语法 + 工具栏/Ctrl+U 切换（无输入规则）
    .use(underlinePlugin)
    .use(pinyinRubyPlugin)
    .use(pinyinInlinePlugin)
    .use(circledSupPlugin)
    .use(subSupPlugin)
    .use(columnsPlugin)
    .use(fontStylePlugin)
    .use(tianziGridPlugin)
    .use(imageStylePlugin)
    // 语法揭示的 md_source 行内节点 schema（toMarkdown 原样输出，见 syntax-reveal.ts）
    .use(mdSourceSchema)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(htmlView)
    .use(mermaidView)
    .use([remarkMathPlugin, katexOptionsCtx, mathInlineSchema, mathBlockSchema].flat())
    // 公式 nodeView：渲染改道 math-engine（KaTeX/MathJax 可切换），立即生效
    .use(mathInlineView)
    .use(mathBlockView)
    .use(mathEditorPlugin)
    .use(imageEditorPlugin)
    // 图片 nodeView：单击选中出现定位框，拖拽手柄调整尺寸（提交 attrs 后
    // toMarkdown 自动把新尺寸写回 alt 参数串，见 image-style/node-view.ts）
    .use(imageResizeView)
    .use(pinyinEditorPlugin)
    .use(subBlockEditorPlugin)
    .use(colsEditorPlugin)
    .use(tianziEditorPlugin)
    .use(tableFloatingToolbarPlugin)
    .use(searchHighlight)
    .use(headingFlashPlugin)
    .use(toolbarStatePlugin)
    // 语法揭示插件：Enter 键处理（揭示态内提交并吞掉换行）必须先于
    // enterSplitGuardPlugin 的规则扫描，避免揭示文本的字面量标记被误匹配
    .use(syntaxRevealPlugin)
    // Typora 式转义输入：wysiwyg 敲 `\`+标点 → 即时消耗反斜杠、插入字面
    // 标点（如 `\*` 显示 `*`）。排在 syntaxReveal 之后（揭示态优先），
    // 且先于核心 customInputRules 收到 handleTextInput 才能阻止字面 `**`
    // 触发 markRule。见 escape-input.ts。
    .use(escapeInputPlugin)
    // 代码块文档末尾哨兵段落：``` 位于文档末尾时块后补空段落，光标才能跳出
    .use(codeBlockExitPlugin)
    // Tab / Shift+Tab 缩进（列表内升降级，其余位置插入全角空格缩进）
    .use(tabIndentPlugin)
    // 必须最后注册：handleKeyDown 按插件顺序处理，本守卫要在容器退出键位等
    // 自定义逻辑之后、核心 customInputRules（始终在 prosePlugins 之后）之前
    .use(enterSplitGuardPlugin)

  if (documentChangePlugin) editor = editor.use(documentChangePlugin)
  editorInstance = await editor.create()

  // 序列化器修复：接管 remark.stringify 前的 mdast，合并 milkdown 序列化器
  // moveSpaces 机制拆分的相邻同型 mark（粘贴 **…`*`…** 后切换源码会多出
  // `**` 的根因，详见 serializer-fix.ts）。getMarkdown / getNodeMarkdown /
  // listener（自动保存）/ clipboard（复制）都在调用时读取 serializerCtx，
  // 替换后全部走修复路径。
  editorInstance.action((ctx) => {
    const remark = ctx.get(remarkCtx)
    type StringifyInput = Parameters<typeof remark.stringify>[0]
    ctx.set(
      serializerCtx,
      SerializerState.create(ctx.get(schemaCtx), {
        stringify: (tree: StringifyInput) => {
          fixMilkdownMarkSplits(tree)
          // 标记转义还原：mdast-util-to-markdown / remark-gfm 对 phrasing 中的
          // * ~ _ 无条件转义，侧翼规则下永不构成定界符的场景按 CommonMark
          // 规则还原，保证源码往返原样（见 serializer-fix.ts）。
          // 用户转义痕迹（escaped_literal mark）序列化为占位符 + 字符，
          // 不会被上面的还原误伤，最后统一替换回反斜杠（escaped-literal.ts）。
          return restoreEscapes(fixMarkerEscapes(remark.stringify(tree)))
        },
      } as unknown as typeof remark)
    )
  })

  // GFM 删除线输入规则错配修复：`你~~hao~` 的 `~~` 被拆散错误配对成
  // strike(~hao) 的根因。详见 strike-through-fix.ts。
  editorInstance.action((ctx) => fixStrikeThroughInputRule(ctx))

  // 格式类输入规则禁用（case1 修复）：strong/emphasis/inlineCode/strikethrough
  // 等格式 mark 不再随手动输入触发，格式操作只能通过工具栏、快捷键或源码
  // 模式。两个根因（markRule 吞 escaped_literal 转义、击键时刻无法预知
  // intraword 上下文）详见 format-input-rules-off.ts。须在
  // fixStrikeThroughInputRule 之后执行（删除线正则已被替换）。
  editorInstance.action((ctx) => disableFormatInputRules(ctx))

  // Enhance clipboard with inline styles for rich text paste (e.g. WeChat)
  root.addEventListener('copy', enhanceClipboard)
  root.addEventListener('cut', enhanceClipboard)
  // 粘贴剪贴板图片 → base64 内嵌
  root.addEventListener('paste', handlePasteImage)

  // Intra-document anchor links are pure navigation: handle them in the
  // capture phase and keep ProseMirror out, so placing the caret (and its
  // async scroll-to-selection) can't override the heading jump (#50).
  root.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    const href = link.getAttribute('href')
    if (!href || !href.startsWith('#')) return
    e.preventDefault()
    e.stopPropagation()
    const heading = findHeadingAnchor(root, href.slice(1))
    if (heading) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
      flashHeadingOnArrival(heading)
    }
  }, true)

  // Cmd/Ctrl+click (Mac/Win/Linux) opens other links in the browser.
  root.addEventListener('click', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    const href = link.getAttribute('href')
    if (href && !href.startsWith('#')) {
      e.preventDefault()
      window.electronAPI.openExternal(href)
    }
  })

  // Click the checkbox of a task list item to toggle its checked state
  root.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLElement)) return
    const li = e.target.closest('li[data-item-type="task"]') as HTMLElement | null
    if (!li) return
    // Only the checkbox area toggles — clicks on the text still place the cursor
    const rect = li.getBoundingClientRect()
    if (e.clientX - rect.left > 24) return
    e.preventDefault()
    toggleTaskListItem(e)
  })

  // Cmd/Ctrl+Enter toggles the task list item under the cursor
  root.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return
    e.preventDefault()
    if (!editorInstance) return
    editorInstance.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const $pos = view.state.doc.resolve(view.state.selection.from)
      for (let d = $pos.depth; d >= 0; d--) {
        const node = $pos.node(d)
        if (node.type.name === 'list_item' && node.attrs.checked != null) {
          const tr = view.state.tr.setNodeMarkup($pos.before(d), undefined, {
            ...node.attrs,
            checked: !node.attrs.checked,
          })
          view.dispatch(tr)
          return
        }
      }
    })
  })

  // 初次启动即捕获光标：wysiwyg 界面就绪即可直接输入，无需先点击页面
  // （新建标签页的 plus 按钮已有同样逻辑，见 main.ts 的 focusEditor）。
  // 延迟一拍等初始渲染 settle；启动期若排队的文件打开改写文档
  // （replaceAll 只派发事务），焦点不会被夺走。
  setTimeout(() => {
    getEditorView()?.focus()
  }, 50)

  return editorInstance
}

function toggleTaskListItem(e: MouseEvent): void {
  if (!editorInstance) return
  editorInstance.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    // posAtDOM(li, 0) lands inside the li (on its first child), not on the
    // list_item node itself — locate by click coordinates instead and walk up
    // the tree, same as the ⌘+Enter path.
    const coords = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (!coords) return
    const $pos = view.state.doc.resolve(coords.pos)
    for (let d = $pos.depth; d >= 0; d--) {
      const node = $pos.node(d)
      if (node.type.name === 'list_item' && node.attrs.checked != null) {
        const tr = view.state.tr.setNodeMarkup($pos.before(d), undefined, {
          ...node.attrs,
          checked: !node.attrs.checked,
        })
        view.dispatch(tr)
        return
      }
    }
  })
}

// 去掉 * 和 ~ 前的反斜杠转义：仅供「源码揭示」显示口径（syntax-reveal.ts
// 有独立副本）。序列化输出（getMarkdown / clipboard）与解析输入
// （setMarkdown）一律不做还原——\* / \~ 转义是语义保真的正确形态，
// 历史上「ColaMD 残留格式标记被错误转义」的场景已由 remarkResidualEmphasis
// 在解析层修复（residual-emphasis.ts），全局还原反而会把用户书写的
// 真转义（\*普通星号\*）吃掉，字面 * 重新解析变成斜体。

export function getMarkdown(): string {
  if (!editorInstance) return ''
  let markdown = ''
  editorInstance.action((ctx) => {
    const serializer = ctx.get(serializerCtx)
    const view = ctx.get(editorViewCtx)
    markdown = serializer(view.state.doc)
  })
  return markdown
}

export function setMarkdown(content: string, flushHistory = false): void {
  if (!editorInstance) return
  // flush=true rebuilds the editor state, which also empties the undo stack.
  // Used when the document identity changes (file switch, new file, external
  // reload), so undo can never reach into a different document's content.
  // content 原样解析：外部文件中的 \* 等转义是用户的字面字符语义，
  // 不做任何还原（入口还原会把真转义变成格式标记，语义损坏）。
  editorInstance.action(replaceAll(content, flushHistory))
}

export function getEditorView(): EditorView | null {
  if (!editorInstance) return null
  let view: EditorView | null = null
  editorInstance.action((ctx) => {
    view = ctx.get(editorViewCtx)
  })
  return view
}

// Parse a markdown string into ProseMirror block nodes (paragraphs, etc.)
// using the editor's full remark pipeline — marks (bold, italic, emphDot, …)
// are preserved. Used by modals (sub-block, cols) that previously created
// plain text nodes with schema.text(line), losing all inline marks.
export function parseMarkdownToNodes(content: string): ProseMirrorNode[] {
  if (!editorInstance) return []
  const nodes: ProseMirrorNode[] = []
  editorInstance.action((ctx) => {
    const parser = ctx.get(parserCtx)
    const doc = parser(content)
    doc.content.forEach((child) => { nodes.push(child) })
  })
  return nodes
}

// Serialize a ProseMirror node's content to a markdown string, preserving
// marks (bold, italic, emphDot, …). The inverse of
// parseMarkdownToNodes — used to populate modal textareas with the existing
// markdown instead of node.textContent which strips all marks.
export function serializeNodeToMarkdown(node: ProseMirrorNode): string {
  if (!editorInstance) return ''
  let markdown = ''
  editorInstance.action((ctx) => {
    const serializer = ctx.get(serializerCtx)
    const view = ctx.get(editorViewCtx)
    // Wrap the node's content in a doc so the serializer can process it
    const doc = view.state.schema.topNodeType.create(null, node.content)
    markdown = serializer(doc)
  })
  return markdown.replace(/\n$/, '')
}

// Put the caret in the document without touching its content. A brand-new tab
// arrives empty and has to be ready to type in: the plus button (or ⌘T) is a
// request to write, and having to click the page first was one keystroke of
// friction on every new document (2026-09-15).
export function focusEditor(): void {
  getEditorView()?.focus()
}

// Per-tab documents share one editor instance. The ProseMirror state carries the
// document, the selection and the undo stack, so capturing it per tab is what
// keeps each tab's own undo history instead of one shared stack.
export function getEditorState(): EditorState | null {
  const view = getEditorView()
  return view ? view.state : null
}

// Restore a captured state. Used when switching back to a tab, which must not
// go through Markdown, or the undo stack and the selection would be lost.
export function restoreEditorState(state: EditorState): void {
  const view = getEditorView()
  if (!view) return
  view.updateState(state)
  // updateState replaces the view's DOM, which drops the focus: bring the caret
  // back so the switched-to tab is ready to type in.
  view.focus()
}

// Follow the style of the document being opened. Called on load, on external
// reload and when switching back to a tab, so each document keeps its own
// markers instead of being normalised to the serialiser's defaults.
export function applyMarkdownStyle(style: MarkdownStyle): void {
  markdownStyleOptions = style
  if (!editorInstance) return
  editorInstance.action((ctx) => {
    const options = ctx.get(remarkStringifyOptionsCtx) as Record<string, unknown>
    // Milkdown builds its remark processor once at init and keeps this object,
    // so the style is applied by mutating it in place.
    Object.assign(options, { bullet: undefined, rule: undefined, emphasis: undefined, strong: undefined, fence: undefined }, style)
  })
}
