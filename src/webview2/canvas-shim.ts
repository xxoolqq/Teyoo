// WebView2 页面里没有 @napi-rs/canvas（Node 原生 Skia 绑定）。
//
// vite.webview2.config.ts 把这个包名别名到本文件，于是 docx-import.ts 一份源码
// 能同时跑在两个地方：
//   - 桌面版主进程：真的 Skia canvas（toBuffer 同步出 PNG）
//   - Word 任务窗格：这里的 OffscreenCanvas（toPngBytes 异步出 PNG）
//
// 只实现了 docx-import.ts 用到的那部分 API：createCanvas / getContext('2d') /
// width / height，外加 GlobalFonts 的 has()。

/** wmf-emf-renderer 只要求 Canvas 2D 的标准接口，这里按需收窄 */
export type Canvas2DContext = {
  font: string
  canvas: unknown
  [key: string]: unknown
}

export interface CompatCanvas {
  readonly width: number
  readonly height: number
  getContext(id: '2d'): Canvas2DContext
  /** 画布内容导出为 PNG 字节。Node 侧走 toBuffer()，这里是唯一的一处差异 */
  toPngBytes(): Promise<Uint8Array>
}

function newSurface(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height)
  const el = document.createElement('canvas')
  el.width = width
  el.height = height
  return el
}

async function surfaceToPng(surface: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  const blob =
    'convertToBlob' in surface
      ? await surface.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((resolve, reject) => {
          surface.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 返回空'))), 'image/png')
        })
  return new Uint8Array(await blob.arrayBuffer())
}

export function createCanvas(width: number, height: number): CompatCanvas {
  const surface = newSurface(width, height)
  return {
    get width(): number {
      return surface.width
    },
    get height(): number {
      return surface.height
    },
    // 上下文随要随建：renderToContext 会自己重设宽高，拿到的一直是同一实例
    getContext: (id: '2d') =>
      surface.getContext(id as '2d') as unknown as Canvas2DContext,
    toPngBytes: () => surfaceToPng(surface),
  }
}

/**
 * Node 侧是「全局字体注册表」；浏览器里换成「本机装了没有」的探测——
 * WMF 公式图要靠本地 Cambria Math 才有正确字形，Word 机器上一定有。
 */
export const GlobalFonts = {
  has(family: string): boolean {
    try {
      return document.fonts.check(`12px "${family}"`)
    } catch {
      return false
    }
  },
  /** 浏览器不允许注册本地字体文件（沙箱），也没有 TTC 扫描能力 → 空实现 */
  registerFromPath(): void {
    /* 无操作 */
  },
}
