// 可视化解题：绘图沙箱的宿主（跑在主界面这一侧）
// ─────────────────────────────────────────────────────────────────────────────
// 与 editor/mermaid-bridge.ts 同一套骨架：隐藏 iframe + postMessage + 超时重建。
// 单独写一份而不复用 Mermaid 那个，是因为协议与产物不同（那边只要 mermaid 的
// code，这里要传结构化的 spec、并且把 SVG 字符串带回来）。
//
// 产物一律以 **`<img src="data:image/svg+xml;base64,…">`** 的形式进界面与正文：
// SVG 在 <img> 里是独立文档 —— 脚本、外链、外部字体都进不来，等于把"模型给的图"
// 又关了一道。

import { specKey, type GraphicSpec } from './graphics'

export interface GraphicRender {
  ok: boolean
  /** 自包含的 SVG 字符串（ok 为 true 时） */
  svg?: string
  width?: number
  height?: number
  error?: string
}

const TIMEOUT_MS = 12_000
/** 同一份指令只画一次：流式解题时每帧都会重绘，没有缓存会把沙箱打爆 */
const CACHE_MAX = 60

let frame: HTMLIFrameElement | null = null
let loaded: Promise<void> | null = null
const pending = new Map<string, { resolve: (value: GraphicRender) => void; timer: number }>()
const cache = new Map<string, GraphicRender>()
let seq = 0

function destroyFrame(): void {
  frame?.remove()
  frame = null
  loaded = null
  for (const [id, entry] of pending) {
    window.clearTimeout(entry.timer)
    entry.resolve({ ok: false, error: 'SANDBOX_RESET' })
    pending.delete(id)
  }
}

function ensureFrame(): Promise<void> {
  if (frame && loaded) return loaded
  const created = document.createElement('iframe')
  created.setAttribute('aria-hidden', 'true')
  // 视口外 + 隐藏：不参与主界面布局，但仍在文档里（第三方库量尺寸需要）
  created.style.cssText = 'position:fixed;left:-10000px;top:0;width:560px;height:360px;border:0;visibility:hidden'
  created.src = './vision-sandbox.html'
  loaded = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('SANDBOX_LOAD_TIMEOUT'))
      destroyFrame()
    }, TIMEOUT_MS)
    created.addEventListener(
      'load',
      () => {
        window.clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
  frame = created
  document.body.appendChild(created)
  return loaded
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as {
    type?: string
    id?: string
    ok?: boolean
    svg?: string
    width?: number
    height?: number
    error?: string
  }
  if (data?.type !== 'result' || !data.id) return
  const entry = pending.get(data.id)
  if (!entry) return
  pending.delete(data.id)
  window.clearTimeout(entry.timer)
  entry.resolve({
    ok: data.ok === true,
    svg: data.svg,
    width: data.width,
    height: data.height,
    error: data.error
  })
})

/** 画一张图。失败/超时返回 ok:false —— 调用方退回显示指令原文，不挡解题。 */
export async function renderGraphic(spec: GraphicSpec, theme: { text: string }): Promise<GraphicRender> {
  const key = `${theme.text}|${specKey(spec)}`
  const hit = cache.get(key)
  if (hit) return hit
  try {
    await ensureFrame()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const id = `g${(seq += 1)}`
  const result = await new Promise<GraphicRender>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(id)
      // 第三方库挂死时不能拖垮解题页：整页重建
      destroyFrame()
      resolve({ ok: false, error: 'SANDBOX_TIMEOUT' })
    }, TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    frame?.contentWindow?.postMessage({ type: 'render', id, spec, theme }, '*')
  })
  if (result.ok) {
    cache.set(key, result)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  }
  return result
}

/** SVG → data URL。UTF-8 安全（图里可能有中文标注）。 */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

/** 当前主题的文字色（图里的线与标注跟它走；SVG 自带颜色，继承不到主题） */
export function figureTheme(): { text: string } {
  const value = getComputedStyle(document.body).getPropertyValue('--text-color').trim()
  return { text: value || '#333' }
}
