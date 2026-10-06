// 右侧栏顶部条：Markdown / JSON 切换 + 复制当前文档。
//
// 目前只有 PDF 对照窗口看得到它（普通窗口那一行是标签条 + 格式工具栏），可见性
// 完全由 CSS 的 body.pdf-view 决定，这里不做判断。
//
// 两侧各读各的文件，切换只换视图：Markdown 是解析结果里的 full.md，JSON 是
// 中间结果 layout.json —— 不做 JSON → Markdown 的转换。
import { isChinese } from './ui-language'

export type DocFormat = 'markdown' | 'json'

let format: DocFormat = 'markdown'
let copiedTimer: ReturnType<typeof setTimeout> | null = null
let savedTimer: ReturnType<typeof setTimeout> | null = null

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

// 与编辑器的代码块复制同一手法：剪贴板 API 不可用时退回 textarea + execCommand。
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
    document.body.append(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

function flashCopied(button: HTMLButtonElement): void {
  button.classList.add('copied')
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedTimer = null
    button.classList.remove('copied')
  }, 1200)
}

// 保存成功：图标换成勾，1.2s 后还原（与复制同一手法）。
function flashSaved(button: HTMLButtonElement): void {
  button.classList.add('saved')
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    savedTimer = null
    button.classList.remove('saved')
  }, 1200)
}

export interface DocBarOptions {
  // 复制按钮取内容：Markdown 模式取文档源文，JSON 模式取 JSON。
  getText: (format: DocFormat) => string
  // 切换后交给 main.ts 换编辑面（#editor ↔ #doc-json）。
  onFormatChange: (format: DocFormat) => void
  // 保存按钮：和 ⌘S 同一条路径 —— 有落点静默覆盖，未命名才弹框（落工作目录）。
  // 返回是否写成功，决定要不要闪一下勾。
  onSave: () => Promise<boolean> | boolean
}

export function initDocBar(options: DocBarOptions): void {
  const zh = isChinese()
  const buttons: Array<[DocFormat, HTMLButtonElement | null]> = [
    ['markdown', byId<HTMLButtonElement>('doc-mode-markdown')],
    ['json', byId<HTMLButtonElement>('doc-mode-json')]
  ]

  const applyFormat = (): void => {
    for (const [value, button] of buttons) {
      if (!button) continue
      const active = value === format
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', String(active))
    }
  }
  for (const [value, button] of buttons) {
    button?.addEventListener('click', () => {
      format = value
      applyFormat()
      options.onFormatChange(value)
    })
  }
  applyFormat()

  const save = byId<HTMLButtonElement>('doc-save-btn')
  if (save) {
    save.title = zh ? '保存（Ctrl+S）' : 'Save (Ctrl+S)'
    save.setAttribute('aria-label', save.title)
    save.addEventListener('click', () => {
      void Promise.resolve(options.onSave()).then((ok) => { if (ok) flashSaved(save) })
    })
  }

  const copy = byId<HTMLButtonElement>('doc-copy-btn')
  if (!copy) return
  copy.title = zh ? '复制当前文档' : 'Copy document'
  copy.setAttribute('aria-label', copy.title)
  copy.addEventListener('click', () => {
    void copyText(options.getText(format)).then(() => flashCopied(copy))
  })
}
