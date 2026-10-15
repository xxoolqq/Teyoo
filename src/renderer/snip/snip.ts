// 截屏浮层的选区：把主进程抓来的整屏快照铺满窗口，用户拖出一个矩形，松手出现
// 「识别 / 取消」，确认后按这个矩形从原图裁一块交回去。
//
// 坐标有两套：快照是物理像素，鼠标事件给的是逻辑像素（窗口按显示器的逻辑尺寸
// 开），中间隔着 HiDPI 的 scaleFactor。做法是 canvas 按物理像素开、用 CSS 缩到
// 窗口大小，选区一律换算成物理像素再裁 —— 这样 2x 屏上裁出来的是 2x 的图，
// 不会因为先缩放再放大而糊掉。

// 契约只有一份，在 preload 那边；tsconfig.renderer.json 的 include 为此把
// src/preload 一起圈了进来（composite 工程引用列表外的文件会报 TS6307）。
import type { SnipAPI } from '../../preload/snip'

declare global {
  interface Window {
    snipAPI: SnipAPI
  }
}

/** 小于这个尺寸的选区当成误点（手抖点一下就松手），不当成有效框选 */
const MIN_SIZE = 8
/** 未选中区域的压暗程度 */
const MASK = 'rgba(0, 0, 0, 0.42)'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const canvas = document.getElementById('snip-canvas') as HTMLCanvasElement
const hintEl = document.getElementById('snip-hint') as HTMLDivElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
const toolsEl = document.getElementById('snip-tools') as HTMLDivElement
const sizeEl = document.getElementById('snip-size') as HTMLSpanElement
const confirmBtn = document.getElementById('snip-confirm') as HTMLButtonElement
const cancelBtn = document.getElementById('snip-cancel') as HTMLButtonElement

let image: HTMLImageElement | null = null
let startX = 0
let startY = 0
let dragging = false
let selection: Rect | null = null

/** 把矩形的两个角整理成正数宽高 */
function normalize(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay)
  }
}

/** 鼠标是逻辑像素，快照是物理像素：选区最终要落在后者上 */
function toImageCoord(clientX: number, clientY: number): { x: number; y: number } {
  if (!image) return { x: 0, y: 0 }
  return {
    x: Math.round((clientX / window.innerWidth) * image.naturalWidth),
    y: Math.round((clientY / window.innerHeight) * image.naturalHeight)
  }
}

function draw(): void {
  if (!image) return
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0)
  // 整体压暗，再把选区那一块原样重画回去 —— 比用 even-odd 路径抠洞省事，
  // 也不会在边界上留下反锯齿的亮边
  ctx.fillStyle = MASK
  ctx.fillRect(0, 0, width, height)
  if (selection && selection.width > 0 && selection.height > 0) {
    ctx.drawImage(
      image,
      selection.x,
      selection.y,
      selection.width,
      selection.height,
      selection.x,
      selection.y,
      selection.width,
      selection.height
    )
    ctx.strokeStyle = '#2f7ae5'
    ctx.lineWidth = 2
    ctx.strokeRect(selection.x + 1, selection.y + 1, selection.width - 2, selection.height - 2)
  }
}

function showTools(rect: Rect): void {
  // 工具条跟着选区走：贴在右下角外侧，贴到屏幕边上时翻到内侧
  const ratioX = rect.x / image!.naturalWidth
  const ratioY = rect.y / image!.naturalHeight
  const left = ratioX * window.innerWidth
  const top = ratioY * window.innerHeight
  const boxWidth = (rect.width / image!.naturalWidth) * window.innerWidth
  const boxHeight = (rect.height / image!.naturalHeight) * window.innerHeight
  const toolsWidth = toolsEl.offsetWidth || 160
  const toolsHeight = toolsEl.offsetHeight || 44
  const x = left + boxWidth + toolsWidth + 12 > window.innerWidth ? Math.max(0, left - toolsWidth - 8) : left + boxWidth + 8
  const y = top + boxHeight + toolsHeight + 12 > window.innerHeight ? Math.max(0, top - toolsHeight - 8) : top + boxHeight + 8
  toolsEl.style.left = `${Math.round(x)}px`
  toolsEl.style.top = `${Math.round(y)}px`
  toolsEl.hidden = false
}

function showSize(rect: Rect, clientX: number, clientY: number): void {
  sizeEl.textContent = `${rect.width} × ${rect.height}`
  sizeEl.style.left = `${clientX + 12}px`
  sizeEl.style.top = `${Math.max(0, clientY - 24)}px`
  sizeEl.hidden = false
}

function submit(): void {
  if (!image || !selection || selection.width < MIN_SIZE || selection.height < MIN_SIZE) return
  const out = document.createElement('canvas')
  out.width = selection.width
  out.height = selection.height
  const outCtx = out.getContext('2d')
  if (!outCtx) return
  // 白底垫一层：万一快照里有透明像素（某些窗口边缘），PNG 出来的空洞会被
  // preprocessImage 按 dark 处理，公式的墨迹边界会跑偏
  outCtx.fillStyle = '#ffffff'
  outCtx.fillRect(0, 0, out.width, out.height)
  outCtx.drawImage(image, selection.x, selection.y, selection.width, selection.height, 0, 0, selection.width, selection.height)
  window.snipAPI.submit(out.toDataURL('image/png'))
}

window.snipAPI.onSnapshot((dataUrl, source) => {
  const img = new Image()
  img.addEventListener('load', () => {
    image = img
    // canvas 按物理像素开，再由 CSS 缩到窗口那么大
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    // 退回「只截 Teyoo 窗口」那一路时必须说清楚，否则用户以为自己框的是整屏
    if (source === 'window') {
      hintEl.textContent = '整屏捕获没成功，这一张是 Teyoo 自己的窗口 · 拖动框选 · Esc 取消'
    }
    draw()
  })
  img.addEventListener('error', () => {
    hintEl.textContent = '快照没能解出来 · Esc 关闭后重试'
  })
  img.src = dataUrl
})

// 快照压根没送到时，页面上只剩一层底色：不明说的话用户只会以为程序卡住了。
// 这行是诊断用的，正常路径下永远等不到（快照是 did-finish-load 之后立刻发的）
setTimeout(() => {
  if (!image) hintEl.textContent = '没收到屏幕快照 · Esc 关闭后重试'
}, 4000)

canvas.addEventListener('mousedown', (event) => {
  const point = toImageCoord(event.clientX, event.clientY)
  dragging = true
  startX = point.x
  startY = point.y
  selection = { x: point.x, y: point.y, width: 0, height: 0 }
  toolsEl.hidden = true
  draw()
})

canvas.addEventListener('mousemove', (event) => {
  if (!dragging || !image) return
  const point = toImageCoord(event.clientX, event.clientY)
  selection = normalize(startX, startY, point.x, point.y)
  showSize(selection, event.clientX, event.clientY)
  draw()
})

canvas.addEventListener('mouseup', (event) => {
  if (!dragging || !image) return
  dragging = false
  const point = toImageCoord(event.clientX, event.clientY)
  selection = normalize(startX, startY, point.x, point.y)
  sizeEl.hidden = true
  if (selection.width < MIN_SIZE || selection.height < MIN_SIZE) {
    selection = null
    draw()
    return
  }
  draw()
  showTools(selection)
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.snipAPI.cancel()
    return
  }
  if (event.key === 'Enter') submit()
})

confirmBtn.addEventListener('click', submit)
cancelBtn.addEventListener('click', () => window.snipAPI.cancel())
window.addEventListener('resize', draw)
