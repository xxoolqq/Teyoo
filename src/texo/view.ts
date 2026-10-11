// LaTeX公式 视图 —— 按 Texo 参考界面的左右布局：
//   左「上传」卡片：输入方式切换（图片识别 / 手写识别）+ 对应的输入区
//     图片识别：虚线框（点击 / 拖拽 / 粘贴）
//     手写识别：画板（鼠标 / 触屏 / 数位板书写），**边写边识别** ——
//     抬笔停顿 700ms 自动跑一次，不用点「识别」；识别期间新落的笔迹
//     会在这一轮结束后补跑（见 scheduleAutoRecognize / runAutoRecognition）
//   右上「预览」卡片：MathLive 所见即所得公式（识别结果落进来可直接改，改动
//                     实时写回下面的编辑区；两个方向都通）
//   右下「编辑」卡片：LaTeX 文本 + 复制 / 清除 / 复制为 Typst / 复制为 MathML
//                     + 「自动复制」开关与格式下拉（识别完成后按所选格式复制）
//
// 两种输入方式最后都汇到同一个 runRecognition(dataUrl)：手写板只是多了一层
// 「笔迹 → 白底黑线 PNG」的栅格化，识别模型与结果口径与图片模式完全一致。
//
// 与 tool-view 同一骨架：它是窗口里的**一个标签页**，切进来由
// main.ts 调 enterTexoTabChrome 换外壳、切走调 leaveTexoTab 收起。

import { isChinese } from '../renderer/ui-language'
// 卡片标题图标（像素风 logo，均 <4KB，Vite 内联成 data URL）
import uploadIconUrl from './icons/upload.png?inline'
import previewIconUrl from './icons/preview.png?inline'
import editIconUrl from './icons/edit.png?inline'

const zh = (): boolean => isChinese()

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

let busy = false

export function enterTexoTabChrome(): void {
  document.body.classList.add('texo-view')
  const panel = el('texo-panel')
  if (panel) panel.hidden = false
}

export function leaveTexoTab(): void {
  document.body.classList.remove('texo-view')
  const panel = el('texo-panel')
  if (panel) panel.hidden = true
}

function setStatus(text: string): void {
  const status = el('texo-status')
  if (!status) return
  status.textContent = text
  status.hidden = !text
}

function currentLatex(): string {
  return el<HTMLTextAreaElement>('texo-latex')?.value ?? ''
}

// ── 预览：MathLive 所见即所得 ────────────────────────────────────────────
//
// 预览区不是「渲染出来的图片」，而是一个能直接改的公式：<math-field>（MathLive）。
// 识别结果落进去后，可以在上面接着改（改上下标、插矩阵……），改动实时写回下面
// 「编辑」卡里的 LaTeX 文本框 —— 复制按钮读的就是文本框，所以改完直接复制即可。
// MathLive 连字体有 800KB 上下，进这个标签页才加载（loadMathlive 幂等）。

/** 用到的 MathLive 元素接口（项目里没有它的 DOM 类型声明，列够用的部分） */
type MathfieldEl = HTMLElement & {
  value: string
  setValue(value: string, options?: { silenceNotifications?: boolean }): void
  focus(): void
  mathVirtualKeyboardPolicy: 'auto' | 'manual' | 'sandboxed'
}

let mathliveLoading: Promise<void> | null = null

function mathfield(): MathfieldEl | null {
  return el<MathfieldEl>('texo-mathfield')
}

/** 公式空着时给一句提示（它浮在 math-field 上面，不吃点击） */
function setEmptyHint(): void {
  const hint = el('texo-preview-empty')
  if (!hint) return
  const empty = !(mathfield()?.value ?? '').trim()
  hint.hidden = !empty
  hint.textContent = zh() ? '识别结果会显示在这里，也可以直接编辑' : 'The result shows here — edit it directly'
}

function loadMathlive(): Promise<void> {
  if (mathliveLoading) return mathliveLoading
  mathliveLoading = (async () => {
    // 字体随包走：CSS 里的 woff2 会被 Vite 打成同目录 asset，不去 CDN ——
    // 渲染端 CSP 只放行 'self'，远程字体一律拦掉。
    await import('mathlive/fonts.css')
    const { MathfieldElement } = await import('mathlive')
    // 音效目录置空：不放按键音，也不去远程取音频文件
    MathfieldElement.soundsDirectory = null
    const mf = mathfield()
    if (mf) {
      // 虚拟键盘只由预览卡右上角那个按钮开合。默认的 'auto' 会在触屏（以及
      // 某些桌面环境）聚焦时自己弹出来，这里用不上。
      mf.mathVirtualKeyboardPolicy = 'manual'
    }
    bindMathfieldInput()
    setEmptyHint()
  })()
  return mathliveLoading
}

/** 在 MathLive 里改了 → 回写 LaTeX 文本框（复制那几个按钮读的是文本框） */
function bindMathfieldInput(): void {
  const mf = mathfield()
  if (!mf) return
  mf.addEventListener('input', () => {
    const output = el<HTMLTextAreaElement>('texo-latex')
    if (output) output.value = mf.value
    setEmptyHint()
  })
}

function setPreview(latex: string): void {
  void loadMathlive().then(() => {
    const mf = mathfield()
    if (!mf) return
    // silenceNotifications：程序写入不该反过来触发 input 回写文本框
    if (mf.value !== latex) mf.setValue(latex, { silenceNotifications: true })
    setEmptyHint()
  })
}

/** 按格式把当前 LaTeX 拷到剪贴板（latex 原样；typst / mathml 走转换） */
async function copyAs(format: string, latex: string): Promise<boolean> {
  if (!latex.trim()) return false
  try {
    if (format === 'typst') {
      const { tex2typst } = await import('tex2typst')
      await navigator.clipboard.writeText(tex2typst(latex))
    } else if (format === 'mathml') {
      const { default: katex } = await import('katex')
      await navigator.clipboard.writeText(katex.renderToString(latex, { output: 'mathml', throwOnError: false }))
    } else {
      await navigator.clipboard.writeText(latex)
    }
    return true
  } catch (error) {
    setStatus(`${zh() ? '复制失败' : 'Copy failed'}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

async function runRecognition(dataUrl: string): Promise<void> {
  if (busy) return
  busy = true
  setStatus(zh() ? '模型加载中…' : 'Loading model…')
  try {
    setStatus(zh() ? '识别中…' : 'Recognizing…')
    const result = await window.electronAPI.recognizeTexoFormula(dataUrl, texoMode === 'hand' ? 'hand' : 'image')
    if (typeof result === 'object' && result !== null && 'error' in result) {
      setStatus(`${zh() ? '识别失败' : 'Recognition failed'}: ${(result as { error: string }).error}`)
      return
    }
    if (!result) {
      setStatus(zh() ? '识别失败' : 'Recognition failed')
      return
    }
    const output = el<HTMLTextAreaElement>('texo-latex')
    if (output) output.value = result
    setPreview(result)
    setStatus('')
    // 「自动复制」开着就按所选格式直接拷
    const auto = el<HTMLInputElement>('texo-autocopy')
    if (auto?.checked) {
      const format = el<HTMLSelectElement>('texo-copy-format')?.value ?? 'latex'
      if (await copyAs(format, result)) setStatus(zh() ? `已自动复制为 ${format}` : `Auto-copied as ${format}`)
    }
  } catch (error) {
    setStatus(`${zh() ? '识别失败' : 'Recognition failed'}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    busy = false
  }
}

/** 收一张图（data URL）：文件选择 / 拖拽 / 粘贴 / 示例图 四条入口共用 */
async function acceptImage(dataUrl: string): Promise<void> {
  // 上传框里预览原图；空态提示让位
  const thumb = el<HTMLImageElement>('texo-thumb')
  const empty = el('texo-drop-empty')
  if (thumb) {
    thumb.src = dataUrl
    thumb.hidden = false
  }
  if (empty) empty.hidden = true
  await runRecognition(dataUrl)
}

function resetDropzone(): void {
  const thumb = el<HTMLImageElement>('texo-thumb')
  const empty = el('texo-drop-empty')
  if (thumb) {
    thumb.hidden = true
    thumb.src = ''
  }
  if (empty) empty.hidden = false
}

function fileToDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(typeof reader.result === 'string' ? reader.result : null))
    reader.addEventListener('error', () => resolve(null))
    reader.readAsDataURL(file)
  })
}

async function pickAndAccept(api: import('../preload/index').ElectronAPI): Promise<void> {
  const picked = await api.pickImageFile()
  if (!picked) return
  const result = await api.readImageAsDataUrl(picked)
  if (result?.dataUrl) await acceptImage(result.dataUrl)
}

/** 给卡片标题前插 logo 图标（幂等：重复 init 不会插第二份） */
function addHeadIcon(headId: string, url: string): void {
  const head = el(headId)
  if (!head || head.querySelector('img')) return
  const img = document.createElement('img')
  img.className = 'texo-card-icon'
  img.src = url
  img.alt = ''
  head.prepend(img)
}

// ── 手写板 ─────────────────────────────────────────────────────────────────
//
// 只做「收集笔迹 → 栅格化成白底黑线 PNG」，识别照样走主进程那套 Texo 模型，
// 所以两种输入方式的耗时与结果口径完全一致。
// 笔迹坐标一律存 CSS 像素（相对画布左上角），绘制/导出时再按 dpr 与目标
// 尺寸换算 —— 这样窗口缩放、切模式都不会让笔迹错位。

interface PadStroke {
  points: Array<{ x: number; y: number }>
}

const padStrokes: PadStroke[] = []
let padDrawing = false
/** 上一次送去识别的画板导出图（用来拦掉「笔迹没变」的重复推理） */
let lastPadExport: string | null = null

type TexoMode = 'image' | 'hand'
let texoMode: TexoMode = 'image'

function padCanvas(): HTMLCanvasElement | null {
  return el<HTMLCanvasElement>('texo-canvas')
}

function padDpr(): number {
  return window.devicePixelRatio || 1
}

/** 让画布位图尺寸跟上显示尺寸；返回 true 表示尺寸变了（需要重绘） */
function ensurePadSize(): boolean {
  const canvas = padCanvas()
  if (!canvas) return false
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  // 还藏在 hidden 里（或布局未落定）时量到 0：保持原位图，别把画布写成 1×1
  if (width < 2 || height < 2) return false
  const dpr = padDpr()
  const pixelWidth = Math.round(width * dpr)
  const pixelHeight = Math.round(height * dpr)
  if (canvas.width === pixelWidth && canvas.height === pixelHeight) return false
  canvas.width = pixelWidth
  canvas.height = pixelHeight
  return true
}

/** 把笔迹描到给定上下文（坐标用 CSS 像素，调用方负责设好变换与线宽） */
function paintStrokes(ctx: CanvasRenderingContext2D, strokes: readonly PadStroke[]): void {
  ctx.strokeStyle = '#000000'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    const first = stroke.points[0]
    if (!first) continue
    ctx.beginPath()
    ctx.moveTo(first.x, first.y)
    if (stroke.points.length === 1) {
      // 单点（轻点一下）：画个极短线段，否则什么都不显示
      ctx.lineTo(first.x + 0.01, first.y)
    } else {
      for (const point of stroke.points) ctx.lineTo(point.x, point.y)
    }
    ctx.stroke()
  }
}

function redrawPad(): void {
  const canvas = padCanvas()
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const dpr = padDpr()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr)
  ctx.lineWidth = 3
  paintStrokes(ctx, padStrokes)
}

/**
 * 笔迹 → PNG data URL。
 *
 * 按内容外框裁剪并留白：整块画板直接导出会有大片空白，长宽比也失真 ——
 * 模型对这种输入最容易出幻觉（图片模式的提示里同一条注意事项）。
 * 高度对齐到 384（模型侧的预处理基准），过长的式子压到 900 以内。
 */
function exportPad(): string | null {
  if (!padStrokes.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const stroke of padStrokes) {
    for (const point of stroke.points) {
      if (point.x < minX) minX = point.x
      if (point.y < minY) minY = point.y
      if (point.x > maxX) maxX = point.x
      if (point.y > maxY) maxY = point.y
    }
  }
  const boxW = Math.max(1, maxX - minX)
  const boxH = Math.max(1, maxY - minY)

  let scale = 384 / boxH
  if (boxW * scale > 900) scale = 900 / boxW
  // 线宽随 scale 一起放大，限个上限免得笔画糊成一片
  scale = Math.min(scale, 8)
  const margin = Math.round(384 * 0.08)

  const out = document.createElement('canvas')
  out.width = Math.round(boxW * scale) + margin * 2
  out.height = Math.round(boxH * scale) + margin * 2
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.setTransform(scale, 0, 0, scale, margin - minX * scale, margin - minY * scale)
  ctx.lineWidth = 3
  paintStrokes(ctx, padStrokes)
  return out.toDataURL('image/png')
}

function clearPad(redraw = true): void {
  padStrokes.length = 0
  lastPadExport = null
  if (redraw) redrawPad()
}

/** 结果区归零（编辑区 + 预览 + 状态） */
function clearOutput(): void {
  const output = el<HTMLTextAreaElement>('texo-latex')
  if (output) output.value = ''
  setPreview('')
  setStatus('')
}

// ── 连续识别：一边写一边出结果 ──────────────────────────────────────────────
//
// 写完停一下（默认 700ms 没有新笔迹）就自动跑一次识别，不必点「识别」。
// 几个必须处理的时序：
//   · 识别要 1~2 秒，这期间用户还在写 → 记 autoPending，这轮结束再补一次，
//     否则最后几笔会被吞掉；
//   · 光标在编辑区（正在手改 LaTeX）→ 先不覆盖，等失焦（见 blur 绑定）再补；
//   · 笔迹没变（例如只是点进编辑区又点回来）→ 用 lastPadExport 拦掉，
//     不做无谓的推理。

const AUTO_DELAY = 700
let autoTimer: number | null = null
let autoPending = false

function padAutoOn(): boolean {
  return el<HTMLInputElement>('texo-pad-auto')?.checked ?? false
}

function cancelAutoRecognize(): void {
  if (autoTimer === null) return
  clearTimeout(autoTimer)
  autoTimer = null
  autoPending = false
}

function scheduleAutoRecognize(delay = AUTO_DELAY): void {
  if (texoMode !== 'hand') return
  cancelAutoRecognize()
  if (!padAutoOn()) return
  autoTimer = window.setTimeout(() => {
    autoTimer = null
    void runAutoRecognition()
  }, delay)
}

async function runAutoRecognition(): Promise<void> {
  if (busy) {
    autoPending = true
    return
  }
  if (document.activeElement === el('texo-latex')) return
  const dataUrl = exportPad()
  if (!dataUrl || dataUrl === lastPadExport) return
  lastPadExport = dataUrl
  await runRecognition(dataUrl)
  if (autoPending) {
    autoPending = false
    scheduleAutoRecognize(150)
  }
}

/** 切换输入方式：图片识别（虚线框）/ 手写识别（画板） */
function applyTexoMode(next: TexoMode): void {
  texoMode = next
  const imageBtn = el<HTMLButtonElement>('texo-mode-image')
  const handBtn = el<HTMLButtonElement>('texo-mode-hand')
  imageBtn?.classList.toggle('is-active', next === 'image')
  handBtn?.classList.toggle('is-active', next === 'hand')
  imageBtn?.setAttribute('aria-selected', String(next === 'image'))
  handBtn?.setAttribute('aria-selected', String(next === 'hand'))

  cancelAutoRecognize()
  lastPadExport = null
  const drop = el('texo-drop')
  const pad = el('texo-pad')
  if (drop) drop.hidden = next !== 'image'
  if (pad) pad.hidden = next !== 'hand'
  for (const id of ['texo-pad-undo', 'texo-pad-clear', 'texo-pad-auto-wrap']) {
    const btn = el(id)
    if (btn) btn.hidden = next !== 'hand'
  }
  const action = el<HTMLButtonElement>('texo-mode-action')
  if (action) action.textContent = next === 'image' ? (zh() ? '选择图片' : 'Choose image') : (zh() ? '识别' : 'Recognize')

  setStatus('')
  if (next === 'hand') {
    // 画板刚从 hidden 里出来，尺寸这时才是有效值
    ensurePadSize()
    redrawPad()
    // 布局若还没落定（量到 0），下一帧再补一次
    requestAnimationFrame(() => {
      if (texoMode !== 'hand') return
      ensurePadSize()
      redrawPad()
    })
  }
}

function bindPad(): void {
  const canvas = padCanvas()
  if (!canvas) return

  const pos = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  canvas.addEventListener('pointerdown', (e) => {
    // 识别中照样能写：连续识别本就是边写边跑，不能让 busy 挡住笔
    if (texoMode !== 'hand') return
    e.preventDefault()
    if (e.pointerType === 'pen' || e.pointerType === 'mouse') {
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        /* 触屏/合成事件下可能不支持，忽略 */
      }
    }
    padDrawing = true
    padStrokes.push({ points: [pos(e)] })
    redrawPad()
  })

  canvas.addEventListener('pointermove', (e) => {
    if (!padDrawing) return
    const stroke = padStrokes[padStrokes.length - 1]
    if (!stroke) return
    const point = pos(e)
    const last = stroke.points[stroke.points.length - 1]
    // 抽稀：不足 1px 的移动丢掉，笔迹不至于存上万个点
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1) return
    stroke.points.push(point)
    redrawPad()
  })

  const endStroke = (e: PointerEvent): void => {
    if (!padDrawing) return
    padDrawing = false
    try {
      canvas.releasePointerCapture(e.pointerId)
    } catch {
      /* 没捕获成功过，忽略 */
    }
    // 抬笔 → 开始倒计时，连续写的话每次抬笔都会把它推后
    scheduleAutoRecognize()
  }
  canvas.addEventListener('pointerup', endStroke)
  canvas.addEventListener('pointercancel', endStroke)
}

export function initTexoView(api: import('../preload/index').ElectronAPI): void {
  const drop = el('texo-drop')
  const panel = el('texo-panel')

  // 卡片标题的 logo：上传 / 预览 / 编辑
  addHeadIcon('texo-head-upload', uploadIconUrl)
  addHeadIcon('texo-head-preview', previewIconUrl)
  addHeadIcon('texo-head-edit', editIconUrl)

  // 进标签页就把 MathLive 拉起来：等第一次出结果再加载的话，那 800KB 的 chunk
  // 会让结果迟到一两秒
  void loadMathlive()

  // 点击虚线框 → 文件对话框（图片模式）
  drop?.addEventListener('click', () => void pickAndAccept(api))

  // 输入方式切换：图片识别（虚线框）/ 手写识别（画板）
  el<HTMLButtonElement>('texo-mode-image')?.addEventListener('click', () => applyTexoMode('image'))
  el<HTMLButtonElement>('texo-mode-hand')?.addEventListener('click', () => applyTexoMode('hand'))

  // 主操作按钮：图片模式 = 选择图片，手写模式 = 把手写笔迹栅格化后送识别
  el<HTMLButtonElement>('texo-mode-action')?.addEventListener('click', () => {
    if (texoMode === 'image') {
      void pickAndAccept(api)
      return
    }
    const dataUrl = exportPad()
    if (!dataUrl) {
      setStatus(zh() ? '先在框里写下公式' : 'Draw a formula first')
      return
    }
    lastPadExport = dataUrl
    void runRecognition(dataUrl)
  })

  // 手写板：撤销一笔 / 清空 —— 都当作「笔迹变了」，重新起算自动识别
  el<HTMLButtonElement>('texo-pad-undo')?.addEventListener('click', () => {
    padStrokes.pop()
    redrawPad()
    scheduleAutoRecognize()
  })
  el<HTMLButtonElement>('texo-pad-clear')?.addEventListener('click', () => {
    clearPad()
    // 自动识别开着：板空了结果也该归零，屏幕上留个旧公式反而误导
    if (padAutoOn()) clearOutput()
  })

  // 「自动识别」开关：开 → 立刻补一次；关 → 撤掉排队中的倒计时
  el<HTMLInputElement>('texo-pad-auto')?.addEventListener('change', () => {
    if (padAutoOn()) scheduleAutoRecognize(150)
    else cancelAutoRecognize()
  })

  // 手改完 LaTeX 离开编辑区 → 若板上的笔迹又新了，再认一次
  el<HTMLTextAreaElement>('texo-latex')?.addEventListener('blur', () => scheduleAutoRecognize(300))

  bindPad()
  // 画板位图尺寸跟着容器走：切模式、拖窗口大小都靠这个回调纠正
  const pad = el('texo-pad')
  if (pad && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (pad.hidden) return
      ensurePadSize()
      redrawPad()
    }).observe(pad)
  }
  applyTexoMode('image')

  // 拖拽：挂在整块面板上（拖到面板任意处都算），高亮只给虚线框
  if (panel) {
    let depth = 0
    panel.addEventListener('dragenter', (e) => {
      e.preventDefault()
      depth += 1
      drop?.classList.add('texo-drop-over')
    })
    panel.addEventListener('dragover', (e) => e.preventDefault())
    panel.addEventListener('dragleave', () => {
      depth -= 1
      if (depth <= 0) {
        depth = 0
        drop?.classList.remove('texo-drop-over')
      }
    })
    panel.addEventListener('drop', (e) => {
      e.preventDefault()
      // 别让全局的 drop（拖文件打开文档）把这张图当成要打开的文件
      e.stopPropagation()
      depth = 0
      drop?.classList.remove('texo-drop-over')
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      if (!file.type.startsWith('image/')) {
        setStatus(zh() ? '这不是图片' : 'Not an image')
        return
      }
      void fileToDataUrl(file).then((url) => {
        if (url) return acceptImage(url)
      })
    })
  }

  // 粘贴（标签页活动时接管；编辑器正文里的粘贴留给编辑器自己）
  document.addEventListener('paste', (e) => {
    if (!document.body.classList.contains('texo-view')) return
    const target = e.target
    if (target instanceof Element && target.closest('.ProseMirror')) return
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          e.preventDefault()
          void fileToDataUrl(file).then((url) => {
            if (url) return acceptImage(url)
          })
          return
        }
      }
    }
  })

  // 编辑区实时刷新预览
  el<HTMLTextAreaElement>('texo-latex')?.addEventListener('input', () => {
    setPreview(currentLatex())
  })

  // 复制 / 清除 / 复制为 Typst / 复制为 MathML
  el<HTMLButtonElement>('texo-copy')?.addEventListener('click', async () => {
    const latex = currentLatex()
    if (!latex.trim()) return
    if (await copyAs('latex', latex)) setStatus(zh() ? '已复制' : 'Copied')
  })
  el<HTMLButtonElement>('texo-copy-typst')?.addEventListener('click', async () => {
    const latex = currentLatex()
    if (!latex.trim()) return
    if (await copyAs('typst', latex)) setStatus(zh() ? '已复制为 Typst' : 'Copied as Typst')
  })
  el<HTMLButtonElement>('texo-copy-mathml')?.addEventListener('click', async () => {
    const latex = currentLatex()
    if (!latex.trim()) return
    if (await copyAs('mathml', latex)) setStatus(zh() ? '已复制为 MathML' : 'Copied as MathML')
  })

  // 清除：编辑区、预览、上传框、手写板一起归位
  el<HTMLButtonElement>('texo-clear')?.addEventListener('click', () => {
    clearOutput()
    resetDropzone()
    clearPad()
  })
}
