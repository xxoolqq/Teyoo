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
  toggleTaskList,
  showMathModal,
  showImageModal,
  showCircledSupModal,
  showPinyinModal,
  showSubBlockModal,
  showColsModal,
  showTianziModal,
  showTableModal,
  applyFont,
  getToolbarState,
  onToolbarStateChange,
  type FormatCommandId,
  type ToolbarBlockKind,
} from './editor/editor'

const STORAGE_KEY = 'colamd-toolbar-visible'

const BLOCK_LABELS: Record<ToolbarBlockKind, string> = {
  paragraph: '正文',
  heading1: '标题 1',
  heading2: '标题 2',
  heading3: '标题 3',
  heading4: '标题 4',
  heading5: '标题 5',
  heading6: '标题 6',
}

// 可直接走 runFormatCommand 的按钮
const FORMAT_CMDS = new Set<string>([
  'bold', 'italic', 'strikethrough', 'inlineCode', 'emphDot', 'link',
  'bulletList', 'orderedList',
])

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
    if ((e.target as HTMLElement).closest('.toolbar-btn, .heading-menu-item')) {
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
    const btn = target.closest<HTMLElement>('.toolbar-btn')
    if (!btn) return

    if (btn.id === 'heading-select-btn') {
      toggleHeadingMenu()
      return
    }
    const cmd = btn.dataset.tbCmd
    if (!cmd) return
    dispatchCommand(cmd)
  })

  function dispatchCommand(cmd: string): void {
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
      showTableModal()
    } else if (cmd === 'clearFont') {
      // 行内选区清除 {=:} mark，跨段选区提升删除 :::font 容器（逻辑在 applyFont 内自适应）
      applyFont({ clear: true })
    }
  }

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

  // 点击工具栏外部或按 Esc 关闭下拉
  document.addEventListener('mousedown', (e) => {
    if (!headingMenu || headingMenu.hasAttribute('hidden')) return
    if (!(e.target as HTMLElement).closest('.heading-dropdown')) closeHeadingMenu()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHeadingMenu()
  })

  // ── 按下态 / 当前块标签同步 ───────────────────────────────────────────────
  const cmdButtons = new Map<string, HTMLElement>()
  for (const btn of bar.querySelectorAll<HTMLElement>('.toolbar-btn[data-tb-cmd]')) {
    const cmd = btn.dataset.tbCmd
    if (cmd) cmdButtons.set(cmd, btn)
  }
  const labelEl = document.getElementById('heading-select-label')

  const syncState = (): void => {
    // 源码模式下编辑器无焦点，getToolbarState 会返回全 false；无需同步
    if (document.getElementById('source-editor')?.classList.contains('visible')) return
    const state = getToolbarState()
    const setActive = (cmd: string, on: boolean): void => {
      cmdButtons.get(cmd)?.classList.toggle('is-active', on)
    }
    setActive('bold', state.bold)
    setActive('italic', state.italic)
    setActive('strikethrough', state.strike)
    setActive('inlineCode', state.code)
    setActive('emphDot', state.emphDot)
    setActive('link', state.link)
    setActive('bulletList', state.bulletList)
    setActive('orderedList', state.orderedList)
    setActive('taskList', state.taskList)
    setActive('quote', state.quote)
    setActive('clearFont', state.font)
    if (labelEl) labelEl.textContent = BLOCK_LABELS[state.block]
  }

  onToolbarStateChange(syncState)
  syncState()
}
