// 第二行格式工具栏 —— 接线层
//
// 职责：
//   1. 按钮点击 → 调用 editor.ts 的命令（mousedown preventDefault 保住编辑器选区）
//   2. 订阅编辑器选区状态 → 刷新按钮按下态与标题下拉的当前标签
//   3. 标题/段落下拉弹层的开关、外部点击/Esc 关闭
//   4. 显示/隐藏偏好持久化（视图菜单通过 toggleToolbarVisible 切换）
//
// 源码模式下整条由 CSS（body:has(#source-editor.visible)）隐藏并让出高度，
// 这里不需要处理模式切换。

import {
  runFormatCommand,
  runHistoryCommand,
  setBlockKind,
  toggleBlockquote,
  insertHorizontalRule,
  insertLongUnderscore,
  insertLongBlank,
  insertTextAtCursor,
  toggleTaskList,
  showMathModal,
  showImageModal,
  showCircledSupModal,
  showPinyinModal,
  showSubBlockModal,
  showColsModal,
  showTianziModal,
  showTablePicker,
  showLinkModal,
  applyFont,
  getToolbarState,
  onToolbarStateChange,
  DEFAULT_FONT_SIZE,
  type FormatCommandId,
  type ToolbarBlockKind,
} from './editor/editor'
import { showFontStyleModal } from './editor/font-style-modal'

const STORAGE_KEY = 'colamd-toolbar-visible'

const BLOCK_LABELS: Record<ToolbarBlockKind, string> = {
  paragraph: '标题',
  heading1: '标题 1',
  heading2: '标题 2',
  heading3: '标题 3',
  heading4: '标题 4',
  heading5: '标题 5',
  heading6: '标题 6',
}

// 可直接走 runFormatCommand 的按钮
const FORMAT_CMDS = new Set<string>([
  'bold', 'italic', 'underline', 'strikethrough', 'inlineCode', 'emphDot', 'subscript', 'superscript', 'highlight', 'link',
  'bulletList', 'orderedList',
])

// 插入符号面板：按类别收录常用符号（来源：通用序号标注）。
// 以后扩充时往对应分组加字符即可；多字符条目（如括号对「〔〕」）
// 会在网格中占两列、整体插入。
export const SYMBOL_GROUPS: { label: string; chars: string[] }[] = [
  {
    label: '带圈数字',
    chars: ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'],
  },
  {
    label: '实心圈号',
    chars: ['❶', '❷', '❸', '❹', '❺', '❻', '❼', '❽', '❾', '❿'],
  },
  {
    label: '罗马数字',
    chars: ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ', 'Ⅺ', 'Ⅻ'],
  },
  {
    label: '字母',
    chars: ['π', 'ŋ', 'α', 'β', 'γ', 'δ', 'θ', 'λ', 'μ', 'ρ', 'σ', 'τ', 'φ', 'ω', 'Δ', 'Ω'],
  },
  {
    label: '运算',
    chars: ['×', '÷', '±', '∓', '·', '√', '〔〕', '⊗', '⇒', '⇔'],
  },
  {
    label: '关系',
    chars: ['≠', '≈', '≡', '≌', '∽', '∝', '≤', '≥', '≪', '≫', '∞', '→', '←', '↑', '↓', '⇌'],
  },
  {
    label: '集合逻辑',
    chars: ['∈', '∉', '∋', '⊂', '⊃', '⊆', '⊇', '∪', '⋂', '∅', '∀', '∃', '∄'],
  },
  {
    label: '几何',
    chars: ['∠', '⊥', '∥', '○', '⊙', '⌒', '∵', '∴'],
  },
  {
    label: '温度/角度',
    chars: ['‰', '℃', '℉', '°', '′', '″', '♂', '♀'],
  },
  {
    label: '拼音声调',
    chars: ['ā', 'á', 'ǎ', 'à', 'ē', 'é', 'ě', 'è', 'ī', 'í', 'ǐ', 'ì', 'ō', 'ó', 'ǒ', 'ò', 'ū', 'ú', 'ǔ', 'ù', 'ǖ', 'ǘ', 'ǚ', 'ǜ'],
  },
  {
    label: '其他',
    chars: ['※', '☆', '★', '○', '●', '◎', '◇', '◆', '□', '■', '△', '▲', '▽', '▼', '§', '¶'],
  },
]

// 字体/字号值的显示名（与 index.html 下拉条目一致）；未收录的值原样显示。
const FONT_FAMILY_LABELS: Record<string, string> = {
  'SimSun': '宋体',
  'SimHei': '黑体',
  'KaiTi': '楷体',
  'FangSong': '仿宋',
  'Microsoft YaHei': '微软雅黑',
  'Noto Serif SC': '思源宋体',
  'Noto Sans SC': '思源黑体',
  'LXGW WenKai': '霞鹜文楷',
  'STIX Two Math': 'STIX',
}

const FONT_SIZE_LABELS: Record<string, string> = {
  '36pt': '小初',
  '26pt': '一号',
  '24pt': '小一',
  '22pt': '二号',
  '18pt': '小二',
  '16pt': '三号',
  '15pt': '小三',
  '14pt': '四号',
  '12pt': '小四',
  '10.5pt': '五号',
  '9pt': '小五',
}

// 「清除样式 / 修改样式」：只在光标/选区命中字体样式（行内 font_span 或
// :::font 块容器）时才关联——可用且高亮，否则禁用。
const FONT_STYLE_CMDS = ['clearFontStyle', 'editFontStyle']

export function isToolbarVisible(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== '0'
}

export function setToolbarVisible(visible: boolean): void {
  const bar = document.getElementById('toolbar')
  if (!bar) return
  document.body.classList.toggle('toolbar-hidden', !visible)
  if (visible) bar.removeAttribute('hidden')
  else bar.setAttribute('hidden', '')
  localStorage.setItem(STORAGE_KEY, visible ? '1' : '0')
}

export function toggleToolbarVisible(): void {
  setToolbarVisible(!isToolbarVisible())
}

export function setupToolbar(): void {
  const bar = document.getElementById('toolbar')
  if (!bar) return
  setToolbarVisible(isToolbarVisible())

  // ── 按钮命令 ──────────────────────────────────────────────────────────────
  bar.addEventListener('mousedown', (e) => {
    // 点击任何控件都不让编辑器失焦：既保住选区，命令里的 hasFocus 闸门也能通过。
    // 下拉菜单条目同理（它们是 #toolbar 的后代）。
    if ((e.target as HTMLElement).closest('.toolbar-btn, .heading-menu-item, .font-menu-item, .fontsize-menu-item, .symbol-item')) {
      e.preventDefault()
    }
  })

  bar.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const menuItem = target.closest<HTMLElement>('.heading-menu-item')
    if (menuItem) {
      const kind = menuItem.dataset.block as ToolbarBlockKind | undefined
      if (kind) {
        setBlockKind(kind)
        closeHeadingMenu()
      }
      return
    }
    // 插入符号面板条目：插入字符并关闭面板
    const symItem = target.closest<HTMLElement>('.symbol-item')
    if (symItem) {
      const ch = symItem.dataset.symbol
      if (ch) insertTextAtCursor(ch)
      closeSymbolMenu()
      return
    }
    // 字体菜单条目：应用字体并关闭弹层
    const fontItem = target.closest<HTMLElement>('.font-menu-item')
    if (fontItem) {
      const family = fontItem.dataset.family
      if (family) applyFont({ family })
      closeFontMenu()
      return
    }
    // 字号菜单条目：应用字号并关闭弹层
    const sizeItem = target.closest<HTMLElement>('.fontsize-menu-item')
    if (sizeItem) {
      const size = sizeItem.dataset.size
      if (size) applyFont({ size })
      closeFontSizeMenu()
      return
    }
    const btn = target.closest<HTMLElement>('.toolbar-btn')
    if (!btn) return

    if (btn.id === 'heading-select-btn') {
      toggleHeadingMenu()
      return
    }
    if (btn.id === 'font-select-btn') {
      toggleFontMenu()
      return
    }
    if (btn.id === 'fontsize-select-btn') {
      toggleFontSizeMenu()
      return
    }
    if (btn.dataset.tbCmd === 'symbol') {
      toggleSymbolMenu()
      return
    }
    const cmd = btn.dataset.tbCmd
    if (!cmd) return
    // 把按钮本身作为锚点传给命令管线：表格选择器等弹层要贴在按钮下方
    runToolbarCommand(cmd, btn)
  })

  // ── 标题下拉弹层 ──────────────────────────────────────────────────────────
  const selectBtn = document.getElementById('heading-select-btn')
  const headingMenu = document.getElementById('heading-menu')

  function openHeadingMenu(): void {
    if (!headingMenu || !selectBtn) return
    headingMenu.removeAttribute('hidden')
    selectBtn.setAttribute('aria-expanded', 'true')
    // 高亮当前块类型
    const current = document.getElementById('heading-select-label')?.textContent
    for (const item of headingMenu.querySelectorAll<HTMLElement>('.heading-menu-item')) {
      item.classList.toggle('is-active', item.textContent === current)
    }
  }

  function closeHeadingMenu(): void {
    headingMenu?.setAttribute('hidden', '')
    selectBtn?.setAttribute('aria-expanded', 'false')
  }

  function toggleHeadingMenu(): void {
    if (!headingMenu) return
    if (headingMenu.hasAttribute('hidden')) openHeadingMenu()
    else closeHeadingMenu()
  }

  // 点击工具栏外部或按 Esc 关闭下拉 → 统一处理见下方「下拉关闭」一节

  // ── 字体 / 字号下拉弹层（与标题下拉同构） ──────────────────────────────────
  const fontSelectBtn = document.getElementById('font-select-btn')
  const fontMenu = document.getElementById('font-menu')
  const fontSizeSelectBtn = document.getElementById('fontsize-select-btn')
  const fontSizeMenu = document.getElementById('fontsize-menu')

  function openFontMenu(): void {
    if (!fontMenu || !fontSelectBtn) return
    fontMenu.removeAttribute('hidden')
    fontSelectBtn.setAttribute('aria-expanded', 'true')
    // 高亮光标处的字体
    const current = getToolbarState().fontFamily
    for (const item of fontMenu.querySelectorAll<HTMLElement>('.font-menu-item')) {
      item.classList.toggle('is-active', item.dataset.family === current)
    }
  }

  function closeFontMenu(): void {
    fontMenu?.setAttribute('hidden', '')
    fontSelectBtn?.setAttribute('aria-expanded', 'false')
  }

  function toggleFontMenu(): void {
    if (!fontMenu) return
    if (fontMenu.hasAttribute('hidden')) openFontMenu()
    else closeFontMenu()
  }

  function openFontSizeMenu(): void {
    if (!fontSizeMenu || !fontSizeSelectBtn) return
    fontSizeMenu.removeAttribute('hidden')
    fontSizeSelectBtn.setAttribute('aria-expanded', 'true')
    // 高亮光标处的字号；普通文本回落到默认字号（小四）
    const current = getToolbarState().fontSize ?? DEFAULT_FONT_SIZE
    for (const item of fontSizeMenu.querySelectorAll<HTMLElement>('.fontsize-menu-item')) {
      item.classList.toggle('is-active', item.dataset.size === current)
    }
  }

  function closeFontSizeMenu(): void {
    fontSizeMenu?.setAttribute('hidden', '')
    fontSizeSelectBtn?.setAttribute('aria-expanded', 'false')
  }

  function toggleFontSizeMenu(): void {
    if (!fontSizeMenu) return
    if (fontSizeMenu.hasAttribute('hidden')) openFontSizeMenu()
    else closeFontSizeMenu()
  }

  // ── 插入符号面板 ──────────────────────────────────────────────────────────
  const symbolBtn = bar.querySelector<HTMLElement>('.tb-omega')
  const symbolMenu = document.getElementById('symbol-menu')

  function openSymbolMenu(): void {
    if (!symbolMenu || !symbolBtn) return
    // 惰性生成分组网格；面板内容静态，只建一次
    if (symbolMenu.childElementCount === 0) {
      for (const group of SYMBOL_GROUPS) {
        const label = document.createElement('div')
        label.className = 'symbol-group-label'
        label.textContent = group.label
        symbolMenu.appendChild(label)
        const grid = document.createElement('div')
        grid.className = 'symbol-grid'
        for (const ch of group.chars) {
          const item = document.createElement('button')
          item.type = 'button'
          item.className = 'symbol-item'
          // 多字符条目（括号对）占两列，点击整体插入
          if (ch.length > 1) item.classList.add('is-wide')
          item.dataset.symbol = ch
          item.textContent = ch
          item.title = `插入 ${ch}`
          grid.appendChild(item)
        }
        symbolMenu.appendChild(grid)
      }
    }
    symbolMenu.removeAttribute('hidden')
    symbolBtn.setAttribute('aria-expanded', 'true')
  }

  function closeSymbolMenu(): void {
    symbolMenu?.setAttribute('hidden', '')
    symbolBtn?.setAttribute('aria-expanded', 'false')
  }

  function toggleSymbolMenu(): void {
    if (!symbolMenu) return
    if (symbolMenu.hasAttribute('hidden')) openSymbolMenu()
    else closeSymbolMenu()
  }

  // ── 下拉关闭（统一） ──────────────────────────────────────────────────────
  // 点击各下拉 wrapper 之外或按 Esc 关闭对应弹层（标题 / 字体 / 字号 / 符号）。
  // 每个下拉只认自己的 wrapper：切换到另一个下拉时，当前弹层随外部点击收起。
  const dropdownScopes: { wrapper: HTMLElement | null; menu: HTMLElement | null; close: () => void }[] = [
    { wrapper: document.getElementById('heading-dropdown'), menu: headingMenu, close: closeHeadingMenu },
    { wrapper: document.getElementById('font-dropdown'), menu: fontMenu, close: closeFontMenu },
    { wrapper: document.getElementById('fontsize-dropdown'), menu: fontSizeMenu, close: closeFontSizeMenu },
    { wrapper: document.querySelector('.symbol-dropdown'), menu: symbolMenu, close: closeSymbolMenu },
  ]
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement
    for (const { wrapper, menu, close } of dropdownScopes) {
      if (menu && !menu.hasAttribute('hidden') && !(wrapper && wrapper.contains(t))) close()
    }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    for (const { menu, close } of dropdownScopes) {
      if (menu && !menu.hasAttribute('hidden')) close()
    }
  })

  // ── 按下态 / 当前块标签同步 ───────────────────────────────────────────────
  const cmdButtons = new Map<string, HTMLElement>()
  for (const btn of bar.querySelectorAll<HTMLElement>('.toolbar-btn[data-tb-cmd]')) {
    const cmd = btn.dataset.tbCmd
    if (cmd) cmdButtons.set(cmd, btn)
  }
  const labelEl = document.getElementById('heading-select-label')
  const fontLabelEl = document.getElementById('font-select-label')
  const fontSizeLabelEl = document.getElementById('fontsize-select-label')

  const setFontStyleEnabled = (on: boolean): void => {
    for (const cmd of FONT_STYLE_CMDS) {
      const btn = cmdButtons.get(cmd)
      if (btn instanceof HTMLButtonElement) btn.disabled = !on
    }
  }

  const syncState = (): void => {
    // 源码模式下编辑器无焦点，getToolbarState 会返回全 false；无需同步
    if (document.getElementById('source-editor')?.classList.contains('visible')) {
      setFontStyleEnabled(false)
      return
    }
    const state = getToolbarState()
    const setActive = (cmd: string, on: boolean): void => {
      cmdButtons.get(cmd)?.classList.toggle('is-active', on)
    }
    setActive('bold', state.bold)
    setActive('italic', state.italic)
    setActive('strikethrough', state.strike)
    setActive('inlineCode', state.code)
    setActive('emphDot', state.emphDot)
    setActive('underline', state.underline)
    setActive('subscript', state.subscript)
    setActive('superscript', state.superscript)
    setActive('link', state.link)
    setActive('bulletList', state.bulletList)
    setActive('orderedList', state.orderedList)
    setActive('taskList', state.taskList)
    setActive('quote', state.quote)
    // 命中字体样式 → 「清除样式」「修改样式」可用并高亮；未命中 → 禁用
    setActive('clearFontStyle', state.font)
    setActive('editFontStyle', state.font)
    setFontStyleEnabled(state.font)
    if (labelEl) labelEl.textContent = BLOCK_LABELS[state.block]
    // 字体/字号下拉同步光标处的值；无字体信息时回落到占位文字
    if (fontLabelEl) {
      fontLabelEl.textContent = state.fontFamily
        ? (FONT_FAMILY_LABELS[state.fontFamily] ?? state.fontFamily)
        : '字体'
    }
    if (fontSizeLabelEl) {
      const size = state.fontSize ?? DEFAULT_FONT_SIZE
      fontSizeLabelEl.textContent = FONT_SIZE_LABELS[size] ?? size
    }
  }

  onToolbarStateChange(syncState)
  syncState()
}

// 工具栏命令的唯一入口：按钮点击与菜单栏「格式」菜单共用同一条管线，
// 保证菜单项与工具栏按钮行为完全一致（弹窗类命令也照常弹窗）。
export function runToolbarCommand(cmd: string, anchor?: HTMLElement): void {
  // 链接走弹窗（Ctrl+K 的静默剪贴板逻辑保留给快捷键，按钮需要可见反馈）
  if (cmd === 'link') {
    showLinkModal()
    return
  }
  if (FORMAT_CMDS.has(cmd)) {
    runFormatCommand(cmd as FormatCommandId)
  } else if (cmd === 'undo' || cmd === 'redo') {
    runHistoryCommand(cmd)
  } else if (cmd === 'quote') {
    toggleBlockquote()
  } else if (cmd === 'hr') {
    insertHorizontalRule()
  } else if (cmd === 'longUnderscore') {
    insertLongUnderscore()
  } else if (cmd === 'longBlank') {
    insertLongBlank()
  } else if (cmd === 'taskList') {
    toggleTaskList()
  } else if (cmd === 'math') {
    showMathModal()
  } else if (cmd === 'image') {
    showImageModal()
  } else if (cmd === 'circledSup') {
    showCircledSupModal()
  } else if (cmd === 'pinyin') {
    showPinyinModal()
  } else if (cmd === 'subblock') {
    showSubBlockModal()
  } else if (cmd === 'cols') {
    showColsModal()
  } else if (cmd === 'tianzi') {
    showTianziModal()
  } else if (cmd === 'table') {
    showTablePicker(anchor)
  } else if (cmd === 'clearFont' || cmd === 'clearFontStyle') {
    // 行内选区清除 {=:} mark，跨段选区提升删除 :::font 容器（逻辑在 applyFont 内自适应）。
    // clearFont 是原图标按钮的命令名，工具栏现在只留「清除样式」文字按钮
    // （仅在检测到字体样式时可点），两者同一实现。
    applyFont({ clear: true })
  } else if (cmd === 'editFontStyle') {
    showFontStyleModal()
  }
}
