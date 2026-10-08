// 图片转md 视图：左侧图片预览，右侧本项目的编辑器放转换出来的 Markdown。
//
// 与 pdf-view.ts 同一骨架：它是窗口里的**一个标签页**（「文件 → 图片转md」开的），
// 切进来由 main.ts 调 enterImageTabChrome + loadImageTab 把外壳换成左右分栏，
// 切走调 leaveImageTab 收起面板 —— 所以这里那份状态虽然还是模块级的，但只在
// 图片标签页活动期间有内容。
//
// 转换用的是「PDF转md」那条 MinerU 在线解析链路（主进程 http/mineru.ts）：服务端
// 认 PDF 也认图片，结果同样解压到 <图片名>.mineru/，Markdown 读里面的 full.md。
// 少数情况下包里只有 layout.json（没有 full.md），退一步用 layout2md 现转一次。
//
// 图片怎么显示：主进程读盘后给回 data URL。渲染端自己取不到 —— 生产环境是
// file:// 页面且开着 webSecurity，file:// 的图也进不来。

import type { MineruProgressPayload } from '../preload/index'
import { isChinese } from './ui-language'
import { layoutToMarkdown } from './layout2md'

export interface ImageViewHooks {
  /** 解析结果里的 full.md 到位 → 填进编辑器。由 main.ts 注册（编辑器 API 在它那里）。 */
  onMarkdownFile?: (path: string) => void | Promise<void>
  /** 只有 layout.json 时的退路：把现转出来的 Markdown 直接交给编辑器。 */
  onMarkdownText?: (markdown: string) => void | Promise<void>
  /** 用户在面板里选了图片：路径要记回标签页（切走再切回来按它重新显示）。 */
  onImageSourceChange?: (path: string) => void
}

let hooks: ImageViewHooks = {}
let apiRef: import('../preload/index').ElectronAPI | null = null
/** 当前标签页挂着的那张图片；不在图片标签页就是 null。 */
let openedImagePath: string | null = null
let converting = false

// 缩放：与 PDF 栏同一套语义 —— 100% = 适应窗口，每档 1.25 倍，小图不放大。
const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
const ZOOM_STEP = 1.25
let zoom = 1
let previewImage: HTMLImageElement | null = null
let naturalSize = { width: 0, height: 0 }

function imageEl<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function initImageView(api: import('../preload/index').ElectronAPI, viewHooks: ImageViewHooks = {}): void {
  hooks = viewHooks
  apiRef = api
  bindEmpty()
  bindConvert()
  bindZoom()
  api.onMineruProgress((payload) => showProgress(payload))
}

// ── 标签页的进出 ────────────────────────────────────────────────────────
// 与 PDF 对照同一手法：body class 管住 chrome（文件面板收起、编辑器让出左半边），
// 面板自己再显隐一次。同步执行 —— 切标签页的第一帧就得对。

export function enterImageTabChrome(): void {
  document.body.classList.add('image-view')
  const panel = imageEl('image-panel')
  if (panel) panel.hidden = false
}

export function leaveImageTab(): void {
  document.body.classList.remove('image-view')
  const panel = imageEl('image-panel')
  if (panel) panel.hidden = true
  openedImagePath = null
  setConvertBusy(false)
  showConvertButton(false)
  setStatus('')
  setSourceName('')
  previewImage = null
  naturalSize = { width: 0, height: 0 }
  resetZoom()
  showEmpty(emptyMessage())
}

/** 显示标签页里那张图片。null = 还没选，把空态摆出来。 */
export async function loadImageTab(imagePath: string | null): Promise<void> {
  if (!imagePath) {
    showEmpty(emptyMessage())
    showConvertButton(false)
    return
  }
  await showImage(imagePath)
}

async function showImage(imagePath: string): Promise<void> {
  const api = apiRef
  if (!api) return
  const result = await api.readImageAsDataUrl(imagePath)
  if (!result) {
    showEmpty(isChinese() ? '这张图片读不出来（可能已被移动或删除）。' : 'This image could not be read (moved or deleted?).')
    showConvertButton(false)
    return
  }
  const preview = imageEl('image-preview')
  if (preview) {
    const img = document.createElement('img')
    img.src = result.dataUrl
    img.alt = fileNameOf(result.path)
    preview.replaceChildren(img)
    preview.hidden = false
    previewImage = img
    naturalSize = { width: 0, height: 0 }
    // 换图回到适应窗口；真实尺寸要等解码完才知道（data URL，几乎立刻）。
    resetZoom()
    img.addEventListener('load', () => {
      naturalSize = { width: img.naturalWidth, height: img.naturalHeight }
      applyZoom()
    })
  }
  const empty = imageEl('image-empty')
  if (empty) empty.hidden = true
  openedImagePath = result.path
  setSourceName(fileNameOf(result.path))
  showConvertButton(true)
  setStatus('')
  hooks.onImageSourceChange?.(result.path)
}

// ── 缩放 ──────────────────────────────────────────────────────────────
// 语义与 PDF 栏一致：100% = 适应窗口（小图不放大到超过原始尺寸），每档 ×/÷1.25。
// 适应窗口交给 CSS 的 max-width/max-height；只有非 100% 时才写死内联尺寸，
// 因为放大要能超出容器（由 .image-preview 滚动）。

/** 适应窗口时的显示比例（不超过 1 —— 小图保持原尺寸，不做无意义的放大） */
function fitScale(): number {
  const box = imageEl('image-preview')
  if (!box || !naturalSize.width || !naturalSize.height) return 1
  const style = getComputedStyle(box)
  const width = box.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
  const height = box.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
  if (width <= 0 || height <= 0) return 1
  return Math.min(1, width / naturalSize.width, height / naturalSize.height)
}

function applyZoom(): void {
  const img = previewImage
  if (!img) return
  if (zoom === 1 || !naturalSize.width) {
    // 回到适应窗口：清掉内联尺寸，让 CSS 的 max-width/max-height 接手
    img.style.width = ''
    img.style.height = ''
    img.style.maxWidth = ''
    img.style.maxHeight = ''
    return
  }
  // 放大/缩小时必须同时解除那两个 max-*：只写 width 会被 max-width:100%
  // 夹回容器宽度，看上去就是「点了放大但图没变」。
  img.style.maxWidth = 'none'
  img.style.maxHeight = 'none'
  const scale = fitScale() * zoom
  img.style.width = `${Math.round(naturalSize.width * scale)}px`
  img.style.height = `${Math.round(naturalSize.height * scale)}px`
}

function updateZoomUi(): void {
  const level = imageEl('image-zoom-level')
  if (level) level.textContent = `${Math.round(zoom * 100)}%`
  const out = imageEl<HTMLButtonElement>('image-zoom-out')
  const zoomIn = imageEl<HTMLButtonElement>('image-zoom-in')
  if (out) out.disabled = zoom <= ZOOM_MIN + 1e-3
  if (zoomIn) zoomIn.disabled = zoom >= ZOOM_MAX - 1e-3
}

function setZoom(next: number): void {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
  if (Math.abs(clamped - zoom) < 1e-3) return
  zoom = clamped
  updateZoomUi()
  applyZoom()
}

function resetZoom(): void {
  zoom = 1
  updateZoomUi()
  applyZoom()
}

function bindZoom(): void {
  imageEl<HTMLButtonElement>('image-zoom-out')?.addEventListener('click', () => setZoom(zoom / ZOOM_STEP))
  imageEl<HTMLButtonElement>('image-zoom-in')?.addEventListener('click', () => setZoom(zoom * ZOOM_STEP))
  // 窗口尺寸变了，「适应窗口」的基准跟着变：放大状态下按新基准重算一次。
  window.addEventListener('resize', () => {
    if (zoom !== 1) applyZoom()
  })
  updateZoomUi()
}

// ── 转换为 Markdown ────────────────────────────────────────────────────

function convertButtonText(busy: boolean): string {
  const zh = isChinese()
  if (busy) return zh ? '转换中' : 'Converting'
  return zh ? '转为 Markdown' : 'Convert to Markdown'
}

function bindConvert(): void {
  const btn = imageEl<HTMLButtonElement>('image-convert-btn')
  if (!btn) return
  const zh = isChinese()
  btn.textContent = convertButtonText(false)
  btn.title = zh
    ? '上传给 MinerU 解析，结果解压到图片旁边的「<图片名>.mineru」目录'
    : 'Upload to MinerU; the result is extracted into the "<image name>.mineru" folder next to the image'
  btn.addEventListener('click', () => { void convertOnline() })
}

function showConvertButton(show: boolean): void {
  const btn = imageEl<HTMLButtonElement>('image-convert-btn')
  if (!btn) return
  btn.hidden = !show
  if (!show) btn.disabled = false
}

function setConvertBusy(busy: boolean): void {
  converting = busy
  const btn = imageEl<HTMLButtonElement>('image-convert-btn')
  if (!btn) return
  btn.disabled = busy
  btn.textContent = convertButtonText(busy)
}

function progressText(payload: MineruProgressPayload): string {
  const zh = isChinese()
  switch (payload.stage) {
    case 'applying':
      return zh ? '准备上传' : 'Preparing upload'
    case 'uploading':
      return zh ? '上传中' : 'Uploading'
    case 'waiting':
      return zh ? '排队中' : 'Queued'
    case 'running':
      return zh ? '识别中' : 'Recognizing'
    case 'converting':
      return zh ? '转换格式' : 'Converting'
    case 'downloading':
      return zh ? '下载结果' : 'Downloading'
    default:
      return ''
  }
}

function showProgress(payload: MineruProgressPayload): void {
  if (!converting) return
  setStatus(progressText(payload))
}

function showConvertError(error?: string): void {
  const zh = isChinese()
  let text: string
  if (error === 'NO_TOKEN') {
    text = zh ? '还没填 MinerU Token（偏好设置 → 文档助手）' : 'Set the MinerU Token in Preferences'
  } else if (error === 'CANCELED') {
    text = zh ? '已取消' : 'Canceled'
  } else if (error === 'TIMEOUT') {
    text = zh ? '等待超时，服务端可能仍在解析，稍后重试' : 'Timed out; the server may still be parsing'
  } else {
    text = error || (zh ? '转换失败' : 'Conversion failed')
  }
  setStatus(text)
}

async function convertOnline(): Promise<void> {
  const api = apiRef
  const path = openedImagePath
  if (!api || !path || converting) return
  setConvertBusy(true)
  try {
    const result = await api.parseImageOnline(path)
    if (!result.ok) {
      showConvertError(result.error)
      return
    }
    if (result.markdownPath) {
      await hooks.onMarkdownFile?.(result.markdownPath)
      setStatus(isChinese() ? '完成：Markdown 已填到右边编辑器' : 'Done — the Markdown is in the editor on the right')
      return
    }
    // 包里没有 full.md：用中间结果 json 现转一次（不带图片 —— 图片输入本身就
    // 不会再抽出子图）。
    if (!result.jsonPath) {
      showConvertError(isChinese() ? '结果里没有 Markdown' : 'No Markdown in the result')
      return
    }
    const file = await api.readTextFile(result.jsonPath)
    if (!file) {
      showConvertError(isChinese() ? '结果读不出来' : 'The result could not be read')
      return
    }
    const { markdown } = await layoutToMarkdown(JSON.parse(file.content) as unknown)
    if (markdown.trim()) await hooks.onMarkdownText?.(markdown)
    setStatus(isChinese() ? '完成：Markdown 已填到右边编辑器' : 'Done — the Markdown is in the editor on the right')
  } catch (error) {
    showConvertError(errorText(error))
  } finally {
    setConvertBusy(false)
  }
}

// ── 空态 / 状态行 ──────────────────────────────────────────────────────

function emptyMessage(): string {
  return isChinese()
    ? '还没有图片：选一张，右边编辑器会填上转换出来的 Markdown。'
    : 'No image yet: pick one and the Markdown lands in the editor on the right.'
}

function bindEmpty(): void {
  const zh = isChinese()
  const openBtn = imageEl<HTMLButtonElement>('image-open-btn')
  if (openBtn) {
    openBtn.textContent = zh ? '选择图片…' : 'Choose Image…'
    openBtn.addEventListener('click', () => { void pickImage() })
  }
  showEmpty(emptyMessage())
}

async function pickImage(): Promise<void> {
  const api = apiRef
  if (!api) return
  // 专用选择器：只列 MinerU 认的图片格式（编辑器插图那个共用的还支持 svg 等）
  const picked = await api.pickMineruImageFile()
  if (!picked) return
  await showImage(picked)
}

function showEmpty(message: string): void {
  const text = imageEl('image-empty-text')
  if (text) text.textContent = message
  const empty = imageEl('image-empty')
  if (empty) empty.hidden = false
  const preview = imageEl('image-preview')
  if (preview) {
    preview.hidden = true
    preview.replaceChildren()
  }
}

function setSourceName(name: string): void {
  const el = imageEl('image-source-name')
  if (el) el.textContent = name
}

function setStatus(text: string): void {
  const el = imageEl('image-status')
  if (!el) return
  el.textContent = text
  el.hidden = !text
}

/** 当前图片标签页挂着的图片路径（切走再切回来要按它重新显示）。 */
export function getOpenedImagePath(): string | null {
  return openedImagePath
}
