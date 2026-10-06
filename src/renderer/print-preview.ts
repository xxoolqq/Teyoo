// ─── 打印预览 ──────────────────────────────────────────────────────────────
//
// Electron 的打印对话框（Chromium 那套打印 UI）自带预览区，但预览渲染器在
// Electron 里没实现 —— 那块永远显示「此应用不支持打印预览」。这不是文档的问题，
// 也没法从应用侧喂给它，所以预览只能自己画：主进程按打印样式 printToPDF 出字节
// （见 main 的 printPreviewBytes），这里用 pdf.js 铺成页面。渲染栈与 PDF 对照
// 标签页同一套（pdf-view.ts），区别只在：没有缩放、没有块定位，只求「所见即
// 最终打印结果」。
//
// 打印仍走系统对话框（electronAPI.print）：@media print 已经把标题栏、工具栏、
// 面板收干净，纸张上只剩正文 —— 预览看到的就是它要打印的东西。

import type { PDFDocumentLoadingTask, PDFDocumentProxy, PageViewport } from 'pdfjs-dist'
import type { ElectronAPI } from '../preload/index'
import { isChinese } from './ui-language'

/** A4 @96dpi：一页纸在屏幕上的宽度（与 canvas-editor 的纸张宽度同一个数） */
const PAGE_WIDTH = 794
/** 页面栏左右留白：纸不能贴着窗口边 */
const PAGES_PADDING = 48
/** 位图倍率上限：2 倍够清晰，再高只是白占内存（同 pdf-view 的取舍） */
const MAX_PIXEL_RATIO = 2

let api: ElectronAPI | null = null
let loadingTask: PDFDocumentLoadingTask | null = null
let pdfDoc: PDFDocumentProxy | null = null
let observer: IntersectionObserver | null = null
let building = false

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

/** 主进程没给出字节（窗口没了 / printToPDF 抛错）时的统一文案 */
function failureText(): string {
  return isChinese() ? '生成预览失败。' : 'Could not build the preview.'
}

function setStatus(text: string): void {
  const container = el('print-preview-pages')
  if (!container) return
  container.innerHTML = ''
  const status = document.createElement('div')
  status.className = 'print-preview-status'
  status.textContent = text
  container.append(status)
}

function release(): void {
  observer?.disconnect()
  observer = null
  el('print-preview-pages')?.replaceChildren()
  const meta = el('print-preview-meta')
  if (meta) meta.textContent = ''
  // 与 pdf-view 同：PDFDocumentProxy 只有 cleanup()，loading task 才有 destroy()，
  // 只收前者 worker 会一直活着。
  if (pdfDoc) {
    const previous = pdfDoc
    pdfDoc = null
    void previous.cleanup().catch(() => { /* 层都关了，清理失败无所谓 */ })
  }
  if (loadingTask) {
    const previous = loadingTask
    loadingTask = null
    void previous.destroy().catch(() => { /* worker 已经没了就算了 */ })
  }
}

export function hidePrintPreview(): void {
  const root = el('print-preview')
  if (root) root.hidden = true
  release()
}

/**
 * 先按宽度给每页占好位，滚到附近才真画 —— 长文档一次性全渲染会把窗口卡住
 * （pdf-view 的 layoutPages 同一手法）。
 */
async function layoutPages(bytes: Uint8Array, cssWidth: number): Promise<void> {
  const container = el('print-preview-pages')
  if (!container) return
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  // pdf.js 会接管并 detach 传进去的缓冲区，给它一份自己的副本。
  const task = pdfjs.getDocument({ data: bytes.slice() })
  loadingTask = task
  pdfDoc = await task.promise

  container.innerHTML = ''
  const ratio = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1)
  const pending = new Map<HTMLElement, () => Promise<void>>()
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const render = pending.get(entry.target as HTMLElement)
      if (!render) continue
      pending.delete(entry.target as HTMLElement)
      void render()
    }
  }, { root: container, rootMargin: '400px 0px' })

  for (let index = 1; index <= pdfDoc.numPages; index++) {
    const page = await pdfDoc.getPage(index)
    const base = page.getViewport({ scale: 1 })
    const viewport: PageViewport = page.getViewport({ scale: (cssWidth * ratio) / base.width })
    const holder = document.createElement('div')
    holder.className = 'print-preview-page'
    holder.style.width = `${cssWidth}px`
    // 占位用 aspect-ratio：先按纸张比例撑开高度，画完了也不会跳一下。
    holder.style.aspectRatio = `${base.width} / ${base.height}`
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    holder.append(canvas)
    container.append(holder)
    pending.set(holder, async () => {
      try {
        await page.render({ canvas, viewport }).promise
      } catch (error) {
        // 关闭预览会取消渲染，这一条不算错。
        if (!pdfDoc) return
        console.error('print preview page render failed:', error)
      }
    })
    observer.observe(holder)
  }

  const meta = el('print-preview-meta')
  if (meta) {
    meta.textContent = isChinese() ? `${pdfDoc.numPages} 页` : `${pdfDoc.numPages} page(s)`
  }
}

/** 菜单「打印 → 打印预览」：生成 PDF 并铺开预览层 */
export async function showPrintPreview(): Promise<void> {
  const root = el('print-preview')
  if (!api || !root || building) return
  building = true
  root.hidden = false
  const printBtn = el<HTMLButtonElement>('print-preview-do')
  if (printBtn) printBtn.disabled = true
  setStatus(isChinese() ? '正在生成预览…' : 'Building preview…')
  try {
    const bytes = await api.printPreview()
    if (!bytes || bytes.length === 0) {
      setStatus(failureText())
      return
    }
    const container = el('print-preview-pages')
    if (!container) return
    const available = container.clientWidth - PAGES_PADDING
    const cssWidth = Math.max(1, Math.floor(Math.min(PAGE_WIDTH, available)))
    await layoutPages(bytes, cssWidth)
    if (printBtn) printBtn.disabled = false
  } catch (error) {
    console.error('print preview failed:', error)
    setStatus(failureText())
  } finally {
    building = false
  }
}

export function initPrintPreview(electronAPI: ElectronAPI): void {
  api = electronAPI
  el('print-preview-close')?.addEventListener('click', () => hidePrintPreview())
  el('print-preview-do')?.addEventListener('click', () => {
    void api?.print()
  })
  // Esc 关层：只在层可见时响应，免得抢走编辑器里的 Esc。
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    const root = el('print-preview')
    if (root && !root.hidden) hidePrintPreview()
  })
}
