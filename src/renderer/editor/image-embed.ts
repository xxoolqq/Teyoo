// 图片内嵌：本地文件 / 剪贴板图片 → base64 data URL（超限时等比压缩）
//
// 只用浏览器 API（FileReader / Image / canvas），所以桌面版渲染进程与 Word
// 任务窗格（WebView2）跑的是同一份代码、同一套阈值。放在 renderer 下而不是
// extensions/image-style 里，是因为那边会被主进程（导出 Word）引入，而这里
// 的 canvas 在主进程里并不存在。
//
// 什么时候才该内嵌：**只在没有文件系统的时候**。
//   桌面版：粘贴/插图一律先落盘（见 editor.ts 的 insertPastedImage 与主进程
//   storeEditorImage），Markdown 里只留本地路径 —— 内嵌一张截图就是几万字符，
//   源码模式、保存、提交全线变重。
//   Word 任务窗格（WebView2）：没有「当前文件」这个概念，路径进了 Markdown
//   回传 Word、另存、换机器都会断，只有内嵌活得下来；纯浏览器同理。
// 所以本模块是**兜底**，不是默认路径（两个调用方都只在落盘不可用时才走到这里）。
//
// 为什么要压缩：一张 4000×3000 的手机照片 base64 之后接近 6MB，塞进
// Markdown 会让编辑、回传、导出全线变重（源码模式里还会摊成几万字符）。
// 目标是「肉眼看不出差别，体积降一个数量级」：
//   - 长边 > 1600px → 等比缩到 1600（A4 满宽 300dpi 约 2480px，1600 已够看清）
//   - 解码后 > 1MB  → 重编码（有 alpha 的先试 PNG，仍超预算才降质成 JPEG）
//   - 都没超 → 原样内嵌，连重编码都不做（PNG/GIF 无损保留）

/** 长边上限（px） */
export const MAX_IMAGE_EDGE = 1600
/** 单张图片的字节预算（解码后字节数，不是 base64 字符串长度） */
export const MAX_EMBED_BYTES = 1024 * 1024

export interface EmbedStats {
  width: number
  height: number
  bytes: number
}

export interface EmbedResult {
  dataUrl: string
  /** true = 动过（缩放或重编码）；false = 原样内嵌，一个字节没改 */
  compressed: boolean
  from: EmbedStats
  to: EmbedStats
}

/** data URL 的解码后字节数（base64 段按 3/4 折算） */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return dataUrl.length
  const body = dataUrl.slice(comma + 1)
  if (dataUrl.slice(0, comma).includes(';base64')) return Math.floor((body.length * 3) / 4)
  return body.length
}

/** File → data URL（原样，不重编码） */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('FileReader 没有返回字符串'))
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

/** 取原始尺寸。SVG 之类拿不到内在尺寸时返回 0 —— 调用方据此不缩放 */
async function imageSizeOf(src: string): Promise<{ width: number; height: number }> {
  try {
    const img = await loadImage(src)
    return { width: img.naturalWidth, height: img.naturalHeight }
  } catch {
    return { width: 0, height: 0 }
  }
}

async function renderToDataUrl(
  source: string,
  scale: number,
  mime: string,
  quality?: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(source)
  // 拿不到内在尺寸时（部分 SVG）给一个兜底画幅，不至于画出 0×0
  const naturalWidth = img.naturalWidth || 800
  const naturalHeight = img.naturalHeight || 600
  const width = Math.max(1, Math.round(naturalWidth * scale))
  const height = Math.max(1, Math.round(naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 canvas 2D 上下文')
  if (mime === 'image/jpeg') {
    // JPEG 没有 alpha 通道：先铺白底，否则透明区会被画成黑块
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, width, height)
  const dataUrl = quality === undefined ? canvas.toDataURL(mime) : canvas.toDataURL(mime, quality)
  return { dataUrl, width, height }
}

/**
 * 网络图片 → data URL。两条路：
 *   1. fetch + FileReader（保留原始编码，服务器给 CORS 头时可用）
 *   2. canvas 兜底（<img> 不受同源策略限制；但跨域图片会污染 canvas，
 *      此时 toDataURL 抛 SecurityError → 返回 null，调用方保留原 URL）
 */
export async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    return await readFileAsDataUrl(new File([blob], 'image', { type: blob.type || 'image/png' }))
  } catch {
    try {
      const { dataUrl } = await renderToDataUrl(url, 1, 'image/png')
      return dataUrl
    } catch {
      return null
    }
  }
}

/** 压缩阶梯：先保格式与透明通道，仍超预算才逐级降质 */
function ladderFor(mime: string): { mime: string; quality?: number }[] {
  const keepsAlpha = /^image\/(png|gif|webp|svg\+xml)/i.test(mime)
  return keepsAlpha
    ? [{ mime: 'image/png' }, { mime: 'image/jpeg', quality: 0.85 }, { mime: 'image/jpeg', quality: 0.7 }]
    : [{ mime: 'image/jpeg', quality: 0.85 }, { mime: 'image/jpeg', quality: 0.72 }, { mime: 'image/jpeg', quality: 0.6 }]
}

/**
 * 本地图片 → 可内嵌的 data URL：没超阈值就原样返回，超了才缩放/重编码。
 * 只在真的需要时才动手，所以一张 200KB 的截图不会被无谓地转成 JPEG。
 */
export async function fileToEmbeddableDataUrl(file: File): Promise<EmbedResult> {
  const original = await readFileAsDataUrl(file)
  const size = await imageSizeOf(original)
  const from: EmbedStats = { width: size.width, height: size.height, bytes: dataUrlBytes(original) }
  const scale =
    size.width > 0 && size.height > 0
      ? Math.min(1, MAX_IMAGE_EDGE / Math.max(size.width, size.height))
      : 1

  if (scale === 1 && from.bytes <= MAX_EMBED_BYTES) {
    return { dataUrl: original, compressed: false, from, to: from }
  }

  const ladder = ladderFor(file.type)
  // 先按长边缩；仍超预算就把长边再压 25% / 45% 重试一轮
  let last = { dataUrl: original, width: size.width, height: size.height }
  for (const extra of [1, 0.75, 0.55]) {
    for (const step of ladder) {
      try {
        last = await renderToDataUrl(original, scale * extra, step.mime, step.quality)
      } catch {
        continue // 某种格式编码不了就试下一档
      }
      if (dataUrlBytes(last.dataUrl) <= MAX_EMBED_BYTES) {
        return { dataUrl: last.dataUrl, compressed: true, from, to: { width: last.width, height: last.height, bytes: dataUrlBytes(last.dataUrl) } }
      }
    }
  }
  return {
    dataUrl: last.dataUrl,
    compressed: true,
    from,
    to: { width: last.width, height: last.height, bytes: dataUrlBytes(last.dataUrl) },
  }
}

/** 给用户的压缩摘要，如「3840×2160 · 5.8MB → 1600×900 · 412KB」 */
export function describeCompression(result: EmbedResult): string {
  const kb = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`
  const before = result.from.width
    ? `${result.from.width}×${result.from.height} · ${kb(result.from.bytes)}`
    : kb(result.from.bytes)
  return `${before} → ${result.to.width}×${result.to.height} · ${kb(result.to.bytes)}`
}
