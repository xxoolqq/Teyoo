// 把一份 PDF 的字节画成一组 <canvas> —— docx 预览专用。
//
// 与 pdf-view.ts 的区别：那个是整页的「PDF 对照」视图（分栏、页码、缩放、与正文
// 双向定位），这里只要「画出来能看」：按容器宽度逐页渲染，容器变宽变窄时重画。
// 之所以单独一份而不是抽公共层：pdf-view 那套状态机（worker、懒加载、块锚点）
// 与这里的需求差太多，硬抽会把两边都变复杂。
//
// 字节从哪来：主进程 readPdfFile（file:// 页面且开着 webSecurity，fetch 读不了
// 本地文件，只能走 IPC 拿字节喂给 pdf.js）。
//
// 为什么要懒渲染：docx 转出来的试卷动辄十几页，一次性把每页都画成 dpr×2 的位图
// 要几秒（面板打开时用户只能盯着空白）。现在先按页摆好等高的占位槽，滚到视口
// 附近才真正渲染该页 —— 首屏只画第一两页，滚动条长度却是完整的，不跳。
//
// worker：同 pdf-view，用 Vite 的 ?url 资产形式，随构建产物落到 dist/renderer。

import type { PDFDocumentLoadingTask, PDFDocumentProxy, PageViewport } from 'pdfjs-dist'

let task: PDFDocumentLoadingTask | null = null
let doc: PDFDocumentProxy | null = null
let lastContainer: HTMLElement | null = null
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null
/** 懒渲染的观察器：切文档 / 重画时先断开，别让旧页的回调继续跑。 */
let lazyObserver: IntersectionObserver | null = null
/** 渲染序号：尺寸快速变化时丢弃过期结果，避免新旧页面叠在一起。 */
let renderSeq = 0

/**
 * 放掉文档与 worker。
 *
 * pdf.js 的 PDFDocumentProxy 上没有 destroy（只有 loadingTask 有），所以销毁
 * worker 的唯一把手是当初那个 task —— 与 pdf-view.ts 里的注释同一个理由。
 */
function releaseDocument(): void {
  doc = null
  try {
    void task?.destroy()
  } catch {
    /* 已经坏掉的任务，忽略 */
  }
  task = null
}

/** 放掉文档与 worker（切走标签页、换文档时调）。 */
export function clearPdfView(): void {
  renderSeq += 1
  lastContainer = null
  if (resizeTimer) {
    clearTimeout(resizeTimer)
    resizeTimer = null
  }
  lazyObserver?.disconnect()
  lazyObserver = null
  resizeObserver?.disconnect()
  resizeObserver = null
  releaseDocument()
}

/** 画进容器，返回页数。失败时抛异常，由调用方显示。 */
export async function renderPdfInto(container: HTMLElement, bytes: Uint8Array): Promise<number> {
  clearPdfView()
  const seq = renderSeq
  lastContainer = container

  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  // pdf.js 会接管并 detach 传进去的缓冲区，给它一份自己的副本
  const loading = pdfjs.getDocument({ data: bytes.slice() })
  task = loading
  const document_ = await loading.promise
  if (seq !== renderSeq) {
    void loading.destroy()
    return 0
  }
  doc = document_

  await paint(container, document_, seq)

  // 容器宽度变了（窗口缩放、分栏拖动）就重画：按当前宽度重算 scale。
  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      if (!doc || !lastContainer || seq !== renderSeq) return
      void paint(lastContainer, doc, seq)
    }, 250)
  })
  resizeObserver.observe(container)

  return document_.numPages
}

/**
 * 摆好每页的占位槽，命中的页才真渲染。
 *
 * 占位槽先按最终显示尺寸定高：滚动条长度一上来就是对的，不会随渲染逐页变长；
 * 也就没有「滚到一半突然被推下去」的跳动。
 */
async function paint(container: HTMLElement, document_: PDFDocumentProxy, seq: number): Promise<void> {
  const style = getComputedStyle(container)
  const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
  // 1 倍时的显示宽度：铺满栏宽（比这更窄就没法看了，给个下限）
  const width = Math.max(200, container.clientWidth - padding)
  // 2 倍位图在十几页的试卷上光是分配内存就要几百 MB，1.5 倍肉眼几乎无差别
  const ratio = Math.min(1.5, window.devicePixelRatio || 1)

  lazyObserver?.disconnect()
  lazyObserver = null
  container.replaceChildren()

  const slots: { el: HTMLDivElement; index: number; base: PageViewport }[] = []
  for (let index = 1; index <= document_.numPages; index += 1) {
    if (seq !== renderSeq) return
    const page = await document_.getPage(index)
    if (seq !== renderSeq) return
    const base = page.getViewport({ scale: 1 })
    const slot = document.createElement('div')
    slot.className = 'pdf-slot'
    slot.dataset.page = String(index)
    slot.style.width = `${Math.floor(width)}px`
    slot.style.height = `${Math.floor((width * base.height) / base.width)}px`
    container.append(slot)
    slots.push({ el: slot, index, base })
  }

  // 提前 600px 开始渲染：滚动时基本看不到白页，又不会把没看过的页也画掉
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const el = entry.target as HTMLDivElement
        observer.unobserve(el)
        const slot = slots.find((item) => item.el === el)
        if (!slot) continue
        void renderSlot(slot, document_, width, ratio, seq)
      }
    },
    { root: container, rootMargin: '600px 0px' }
  )
  lazyObserver = observer
  for (const slot of slots) observer.observe(slot.el)
}

/** 真正把某一页画进位图。单页失败只留白，不能让整叠预览崩掉。 */
async function renderSlot(
  slot: { el: HTMLDivElement; index: number; base: PageViewport },
  document_: PDFDocumentProxy,
  width: number,
  ratio: number,
  seq: number
): Promise<void> {
  if (seq !== renderSeq) return
  try {
    const page = await document_.getPage(slot.index)
    if (seq !== renderSeq) return
    const viewport = page.getViewport({ scale: (width * ratio) / slot.base.width })

    const canvas = document.createElement('canvas')
    canvas.className = 'pdf-canvas'
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    canvas.style.width = `${Math.floor(width)}px`
    canvas.style.height = `${Math.floor((width * slot.base.height) / slot.base.width)}px`

    await page.render({ canvas, viewport }).promise
    if (seq !== renderSeq) return
    slot.el.replaceChildren(canvas)
  } catch {
    /* 单页渲染失败（字体缺失之类）不影响其它页 */
  }
}
