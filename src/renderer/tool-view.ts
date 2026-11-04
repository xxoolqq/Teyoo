// 工具视图（菜单「帮助 → PDF拆分」）：整页工具界面，目前只有一个工具 ——
// PDF拆分：每 N 页切一份，结果写进原 PDF 旁边的「<原名>_拆分_<日期>/」文件夹。
//
// 与 pdf-view / image-view 同一套路：它是窗口里的一个标签页（窗口里最多一个），
// 切进来由 main.ts 调 enterToolTabChrome + loadToolTab 换成整页工具界面，切走
// 调 leaveToolTab 收起 —— 所以下面这份状态只在工具标签页活动期间有内容。
//
// 拆分本身在主进程做（pdf-lib 跑在 Node 侧，见 main/pdf-split.ts），这里只管
// 选文件、画第一页缩略图、把结果列出来。

import type { PdfSplitResult } from '../preload/index'
import { isChinese } from './ui-language'

export type ToolId = 'pdf-split'

export interface ToolViewHooks {
  /** 用户在面板里选了/换了源文件：路径要记回标签页（切走再切回来按它重新显示）。 */
  onToolSourceChange?: (path: string | null) => void
}

const TOOL_NAMES: Record<ToolId, { zh: string; en: string }> = {
  'pdf-split': { zh: 'PDF拆分', en: 'Split PDF' }
}

/** 标签条上的标题（main.ts 的 tabLabel 用它）。 */
export function toolTabLabel(tool: ToolId): string {
  return isChinese() ? TOOL_NAMES[tool].zh : TOOL_NAMES[tool].en
}

/** 缩略图位图的渲染宽度：界面里只显示 120px，但点开预览要放大到上千像素 ——
 *  一次渲染到位（页宽 612pt 的 A4 大约放大到 1.5 倍），预览才不糊。 */
const THUMB_RENDER_WIDTH = 900

let hooks: ToolViewHooks = {}
let apiRef: import('../preload/index').ElectronAPI | null = null
/** 当前工具标签页挂着的那份 PDF；没选（或不在工具标签页）就是 null。 */
let openedToolPath: string | null = null
/** 它的总页数（缩略图渲染时顺手拿到，界面上的「共 N 页」用它）。 */
let openedPageCount = 0
let splitting = false

function toolEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function texts(): Record<string, string> {
  const zh = isChinese()
  return {
    subtitle: zh
      ? '把一个 PDF 每 N 页切成一个文件，结果放在原文件旁边的「文件名_拆分_日期」文件夹里。全程在本机做，不上传。'
      : 'Split a PDF into one file per N pages. The result goes into a "<name>_split_<date>" folder next to the original. Everything happens locally.',
    badges: zh ? '免费|离线|无限制|安全' : 'Free|Offline|Unlimited|Safe',
    empty:
      zh
        ? '还没有选文件：选一个 PDF，选好页数就能拆。'
        : 'No file yet: pick a PDF, set the page count, and split.',
    open: zh ? '选择 PDF…' : 'Choose PDF…',
    replace: zh ? '换一个…' : 'Replace…',
    remove: zh ? '移除' : 'Remove',
    split: zh ? '分割' : 'Split',
    splitting: zh ? '正在拆分…' : 'Splitting…',
    mode: zh ? '模式' : 'Mode',
    modeValue: zh ? '每个 PDF 的页数' : 'Pages per PDF',
    pages: zh ? '页面/PDF' : 'Pages/PDF',
    pagesUnit: zh ? '页' : 'pages',
    preview: zh ? '点击放大预览' : 'Click to enlarge',
    thumbFailed: zh ? '这一页画不出来' : 'This page could not be rendered',
    readFailed: zh ? '这个 PDF 读不出来（可能已被移动或删除）。' : 'This PDF could not be read (moved or deleted?).',
    invalidPages: zh ? '「页面/PDF」要填 1 以上的整数。' : '"Pages per PDF" must be an integer of 1 or more.'
  }
}

/**
 * 绑定面板上的控件与 IPC。与「当前是不是工具标签页」无关 —— 面板 DOM 一直都在
 * （默认隐藏），显隐由 enterToolTabChrome / leaveToolTab 管，所以绑定一次就够。
 */
export function initToolView(
  api: import('../preload/index').ElectronAPI,
  viewHooks: ToolViewHooks = {}
): void {
  apiRef = api
  hooks = viewHooks
  const text = texts()
  const title = toolEl('tool-title')
  if (title) title.textContent = toolTabLabel('pdf-split')
  const subtitle = toolEl('tool-subtitle')
  if (subtitle) subtitle.textContent = text.subtitle
  const badges = toolEl('tool-badges')
  if (badges) {
    text.badges.split('|').forEach((label, index) => {
      const item = badges.children[index]
      if (item) item.textContent = label
    })
  }
  const openBtn = toolEl<HTMLButtonElement>('tool-open-btn')
  if (openBtn) {
    openBtn.textContent = text.open
    openBtn.addEventListener('click', () => { void pickPdf() })
  }
  const replaceBtn = toolEl<HTMLButtonElement>('tool-replace-btn')
  if (replaceBtn) {
    replaceBtn.textContent = text.replace
    replaceBtn.addEventListener('click', () => { void pickPdf() })
  }
  const removeBtn = toolEl<HTMLButtonElement>('tool-remove-btn')
  if (removeBtn) {
    removeBtn.textContent = text.remove
    removeBtn.addEventListener('click', () => clearFile())
  }
  const modeLabel = toolEl('tool-mode-label')
  if (modeLabel) modeLabel.textContent = text.mode
  const modeSelect = toolEl<HTMLSelectElement>('tool-mode')
  if (modeSelect) {
    const option = modeSelect.options[0]
    if (option) option.textContent = text.modeValue
  }
  const pagesLabel = toolEl('tool-pages-label')
  if (pagesLabel) pagesLabel.textContent = text.pages
  const splitBtn = toolEl<HTMLButtonElement>('tool-split-btn')
  if (splitBtn) {
    splitBtn.textContent = text.split
    splitBtn.addEventListener('click', () => { void splitCurrent() })
  }
  const thumbBtn = toolEl<HTMLButtonElement>('tool-thumb-btn')
  if (thumbBtn) {
    thumbBtn.title = text.preview
    thumbBtn.setAttribute('aria-label', text.preview)
    thumbBtn.addEventListener('click', () => openPreview())
  }
  const preview = toolEl('tool-preview')
  if (preview) preview.addEventListener('click', () => closePreview())
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePreview()
  })
  showEmpty(text.empty)
  updateSplitButton()
}

// ── 标签页的进出 ────────────────────────────────────────────────────────
// 与其它工具页同一手法：body class 管住 chrome（工具栏与编辑面收起），面板再
// 自己显隐一次。同步执行 —— 切标签页的第一帧就得对。

export function enterToolTabChrome(): void {
  document.body.classList.add('tool-view')
  const panel = toolEl('tool-panel')
  if (panel) panel.hidden = false
}

export function leaveToolTab(): void {
  document.body.classList.remove('tool-view')
  const panel = toolEl('tool-panel')
  if (panel) panel.hidden = true
  closePreview()
  clearFile()
}

/** 显示标签页里那份待拆分的 PDF。null = 还没选，把空态摆出来。 */
export async function loadToolTab(toolPath: string | null): Promise<void> {
  if (!toolPath) {
    showEmpty(texts().empty)
    return
  }
  // 同一份还在手上（切走又立刻切回）：缩略图与页数都画过了，不必再读一次盘。
  if (openedToolPath === toolPath) return
  const picked = apiRef ? await apiRef.readPdfFile(toolPath) : null
  if (!picked) {
    showEmpty(texts().readFailed)
    return
  }
  await showFile(picked.path, picked.data)
}

// ── 选文件 / 画缩略图 ──────────────────────────────────────────────────

async function pickPdf(): Promise<void> {
  const api = apiRef
  if (!api) return
  const picked = await api.pickPdfFile()
  if (!picked) return
  await showFile(picked.path, picked.data)
}

async function showFile(path: string, bytes: Uint8Array): Promise<void> {
  const text = texts()
  openedToolPath = path
  openedPageCount = 0
  setStatus('')
  setResult(null)
  showEmptyText('')
  const empty = toolEl('tool-empty')
  if (empty) empty.hidden = true
  const card = toolEl('tool-file')
  if (card) card.hidden = false
  const nameEl = toolEl('tool-file-name')
  if (nameEl) nameEl.textContent = fileNameOf(path)
  const metaEl = toolEl('tool-file-meta')
  if (metaEl) metaEl.textContent = ''
  const thumb = toolEl<HTMLImageElement>('tool-thumb')
  if (thumb) thumb.removeAttribute('src')
  hooks.onToolSourceChange?.(path)
  updateSplitButton()

  try {
    const rendered = await renderFirstPage(bytes)
    openedPageCount = rendered.pageCount
    if (thumb) thumb.src = rendered.dataUrl
    if (metaEl) metaEl.textContent = `${rendered.pageCount} ${text.pagesUnit}`
  } catch (error) {
    // 画不出缩略图也让它拆：拆的是文件本身，跟能不能预览没关系。
    if (metaEl) metaEl.textContent = `${text.thumbFailed} — ${errorText(error)}`
  }
}

function clearFile(): void {
  openedToolPath = null
  openedPageCount = 0
  splitting = false
  const thumb = toolEl<HTMLImageElement>('tool-thumb')
  if (thumb) thumb.removeAttribute('src')
  const card = toolEl('tool-file')
  if (card) card.hidden = true
  setStatus('')
  setResult(null)
  setSplitting(false)
  showEmpty(texts().empty)
  updateSplitButton()
  hooks.onToolSourceChange?.(null)
}

/** 渲染第一页 → data URL，顺带取总页数。用完立刻放掉 pdf.js 的文档与 worker。 */
async function renderFirstPage(bytes: Uint8Array): Promise<{ pageCount: number; dataUrl: string }> {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  // pdf.js 会接管并 detach 传进去的缓冲区，给它一份自己的副本（同 pdf-view）。
  const task = pdfjs.getDocument({ data: bytes.slice() })
  const doc = await task.promise
  try {
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    // 只放大不缩小：页窄的时候别为了凑宽度把位图拉虚。
    const scale = Math.min(3, Math.max(1, THUMB_RENDER_WIDTH / base.width))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    await page.render({ canvas, viewport }).promise
    return { pageCount: doc.numPages, dataUrl: canvas.toDataURL('image/png') }
  } finally {
    // PDFDocumentProxy 只有 cleanup()（destroy 是 loading task 上的）—— 与 pdf-view 一致。
    void doc.cleanup().catch(() => { /* 放不掉也无所谓 */ })
    void task.destroy().catch(() => { /* worker 已经没了就算了 */ })
  }
}

// ── 拆分 ────────────────────────────────────────────────────────────────

async function splitCurrent(): Promise<void> {
  const api = apiRef
  const path = openedToolPath
  if (!api || !path || splitting) return
  const pagesInput = toolEl<HTMLInputElement>('tool-pages')
  const pages = Number.parseInt(pagesInput?.value ?? '', 10)
  if (!Number.isFinite(pages) || pages < 1) {
    setStatus(texts().invalidPages, true)
    return
  }
  setSplitting(true)
  setStatus(texts().splitting)
  setResult(null)
  try {
    const result = await api.splitPdf(path, pages)
    if (!result.ok) {
      setStatus(splitErrorText(result), true)
      return
    }
    showResult(result)
  } catch (error) {
    setStatus(errorText(error), true)
  } finally {
    setSplitting(false)
  }
}

function splitErrorText(result: PdfSplitResult): string {
  const zh = isChinese()
  const error = result.error ?? ''
  if (error.startsWith('PARSE_FAILED')) {
    return zh
      ? `这个 PDF 打不开（可能损坏，或需要密码）：${error.replace('PARSE_FAILED: ', '')}`
      : `This PDF could not be opened (damaged or password-protected): ${error.replace('PARSE_FAILED: ', '')}`
  }
  if (error.startsWith('WRITE_FAILED')) {
    return zh
      ? `写文件失败（目标目录可能没有写权限）：${error.replace('WRITE_FAILED: ', '')}`
      : `Could not write the files (no permission?): ${error.replace('WRITE_FAILED: ', '')}`
  }
  switch (error) {
    case 'READ_FAILED':
      return texts().readFailed
    case 'INVALID_PAGES':
      return texts().invalidPages
    case 'EMPTY_PDF':
      return zh ? '这个 PDF 一页都没有。' : 'This PDF has no pages.'
    case 'BAD_OUTPUT_DIR':
      return zh ? '输出目录不合法，已中止（没有动你的文件）。' : 'Refusing to write into an unsafe output folder.'
    default:
      return zh ? `拆分失败：${error || '未知原因'}` : `Split failed: ${error || 'unknown error'}`
  }
}

function showResult(result: PdfSplitResult): void {
  const zh = isChinese()
  const shards = result.shards ?? []
  setStatus(
    zh
      ? `完成：拆成 ${shards.length} 个文件，已在文件管理器里打开。\n${result.dir ?? ''}`
      : `Done — ${shards.length} file(s), revealed in your file manager.\n${result.dir ?? ''}`
  )
  const list = toolEl('tool-result')
  if (!list) return
  list.replaceChildren()
  for (const shard of shards) {
    const item = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = shard.name
    const range = document.createElement('span')
    const size = Math.max(1, Math.round(shard.bytes / 1024))
    range.textContent = zh
      ? `第 ${shard.startPage}-${shard.endPage} 页 · ${size} KB`
      : `p${shard.startPage}-${shard.endPage} · ${size} KB`
    item.append(name, range)
    list.append(item)
  }
  list.hidden = shards.length === 0
}

// ── 空态 / 状态行 / 预览 ────────────────────────────────────────────────

function showEmpty(message: string): void {
  showEmptyText(message)
  const empty = toolEl('tool-empty')
  if (empty) empty.hidden = false
  const card = toolEl('tool-file')
  if (card) card.hidden = true
  const splitBtn = toolEl<HTMLButtonElement>('tool-split-btn')
  if (splitBtn) splitBtn.disabled = true
}

function showEmptyText(message: string): void {
  const el = toolEl('tool-empty-text')
  if (el) el.textContent = message
}

function updateSplitButton(): void {
  const btn = toolEl<HTMLButtonElement>('tool-split-btn')
  if (btn) btn.disabled = !openedToolPath || splitting
}

function setSplitting(busy: boolean): void {
  splitting = busy
  const btn = toolEl<HTMLButtonElement>('tool-split-btn')
  if (btn) {
    btn.textContent = busy ? texts().splitting : texts().split
    btn.disabled = busy || !openedToolPath
  }
  const pages = toolEl<HTMLInputElement>('tool-pages')
  if (pages) pages.disabled = busy
}

function setStatus(text: string, isError = false): void {
  const el = toolEl('tool-status')
  if (!el) return
  el.textContent = text
  el.hidden = !text
  el.classList.toggle('is-error', isError)
}

function setResult(_result: PdfSplitResult | null): void {
  const list = toolEl('tool-result')
  if (!list) return
  list.replaceChildren()
  list.hidden = true
}

function openPreview(): void {
  const thumb = toolEl<HTMLImageElement>('tool-thumb')
  const img = toolEl<HTMLImageElement>('tool-preview-img')
  const preview = toolEl('tool-preview')
  const src = thumb?.getAttribute('src')
  if (!img || !preview || !src) return
  img.src = src
  preview.hidden = false
}

function closePreview(): void {
  const preview = toolEl('tool-preview')
  if (preview) preview.hidden = true
}

/** 当前工具标签页挂着的源文件（切走再切回来要按它重新显示）。 */
export function getOpenedToolPath(): string | null {
  return openedToolPath
}

/** 总页数（画完缩略图才知道；界面上的「共 N 页」用） */
export function getOpenedPageCount(): number {
  return openedPageCount
}
