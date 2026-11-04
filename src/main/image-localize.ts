// 把「base64 data URL / 网络图片」落成工作目录里的本地图片。
// ────────────────────────────────────────────────────────────────────────────
//
// 图片模态框的「转本地」按钮走这里：Markdown 里最终只留本地路径（渲染时
// image-style 的 toFileUrl 转 file://，保存时 main 的 restoreImagePaths 转回路径），
// 文档不再被几万字符的 base64 撑大。
//
// 为什么下载放在主进程：
//   1. 渲染端是 file:// 页面，index.html 的 CSP 只放行 'self'，跨域图片 fetch
//      直接被拦（与 MinerU 那条同样的理由，见 http/mineru.ts 的注释）；
//   2. net.fetch 走 Chromium 网络栈，系统代理 / DNS 与窗口一致；
//   3. 下载的字节不必再经 IPC 搬回渲染端一次（省一次几十 MB 的结构化克隆）。
//
// 落盘复用 docx-image-store：目录（工作目录/images）、命名（内容 sha256 前 12 位）、
// 扩展名（字节头嗅探）与编辑器粘贴 / docx 导入完全一致 —— 同一张图只存一份。

import { net } from 'electron'
import { sniffMime, storeEditorImage } from './docx-image-store'

export type LocalizeImageError =
  | 'EMPTY'
  | 'BAD_SRC'
  | 'NOT_IMAGE'
  | 'TOO_LARGE'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'WRITE_FAILED'
  /** 透传的 HTTP 状态，如 HTTP_404 */
  | string

export interface LocalizeImageResult {
  ok: boolean
  /** 成功时的本地绝对路径（正斜杠，可直接写进 Markdown） */
  path?: string
  error?: LocalizeImageError
  /** 本来就是本地引用（绝对路径 / file:// / 相对路径），无需转换 */
  alreadyLocal?: boolean
}

/** 单张图片的字节上限：手机原图几张就够用了，再大就不是「插图」场景 */
const MAX_BYTES = 20 * 1024 * 1024
/** 下载超时。net.fetch 没有浏览器那套默认超时，不设就是无限等 */
const TIMEOUT_MS = 20_000

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * data URL → 字节。
 *
 * 两种都认：`;base64,` 的解码，其余（如 `data:image/svg+xml,<svg…>`）按
 * percent-encoding 解。mime 只作为兜底 —— 真实格式由 storeEditorImage 里的
 * 字节头嗅探决定。
 */
function decodeDataUrl(src: string): { mime: string; bytes: Uint8Array } | null {
  const comma = src.indexOf(',')
  if (comma < 0) return null
  const header = src.slice('data:'.length, comma)
  const payload = src.slice(comma + 1)
  const mime = header.split(';')[0]?.trim() || 'image/png'
  try {
    if (/;base64/i.test(header)) {
      const bytes = new Uint8Array(Buffer.from(payload, 'base64'))
      return bytes.length > 0 ? { mime, bytes } : null
    }
    const bytes = new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8'))
    return bytes.length > 0 ? { mime, bytes } : null
  } catch {
    return null
  }
}

async function download(
  url: string
): Promise<{ mime: string; bytes: Uint8Array } | { error: LocalizeImageError }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    // 重定向交给 Chromium 默认策略（follow）；只放行 http/https 已在上游判过
    const response = await net.fetch(url, {
      method: 'GET',
      signal: controller.signal
    } as RequestInit)
    if (!response.ok) return { error: `HTTP_${response.status}` }
    // 先看 Content-Length：几十 MB 的图没必要先下完再拒
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_BYTES) return { error: 'TOO_LARGE' }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > MAX_BYTES) return { error: 'TOO_LARGE' }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim()
    return { mime, bytes }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: /abort|timeout/i.test(message) ? 'TIMEOUT' : message }
  } finally {
    clearTimeout(timer)
  }
}

/** 校验 + 落盘。嗅不出字节头、又没声明 image/* 的一律当「不是图片」拒掉 */
async function save(mime: string, bytes: Uint8Array): Promise<LocalizeImageResult> {
  if (bytes.length > MAX_BYTES) return { ok: false, error: 'TOO_LARGE' }
  const declaredImage = /^image\//i.test(mime)
  if (!sniffMime(bytes) && !declaredImage) return { ok: false, error: 'NOT_IMAGE' }
  const path = await storeEditorImage(mime, bytes)
  return path ? { ok: true, path } : { ok: false, error: 'WRITE_FAILED' }
}

/**
 * 把 src 变成本地文件。
 *
 *   data: URL        → 解码后落盘
 *   http(s): URL     → 主进程下载后落盘
 *   blob: / 其它协议 → UNSUPPORTED（blob 生命周期绑在页面上，主进程取不到）
 *   本地路径 / file: → alreadyLocal（不改写既有引用）
 */
export async function localizeImage(src: string): Promise<LocalizeImageResult> {
  const value = String(src ?? '').trim()
  if (!value) return { ok: false, error: 'EMPTY' }

  if (/^data:/i.test(value)) {
    const decoded = decodeDataUrl(value)
    if (!decoded) return { ok: false, error: 'NOT_IMAGE' }
    return save(decoded.mime, decoded.bytes)
  }
  if (isHttpUrl(value)) {
    const fetched = await download(value)
    if ('error' in fetched) return { ok: false, error: fetched.error }
    return save(fetched.mime, fetched.bytes)
  }
  if (/^blob:/i.test(value)) return { ok: false, error: 'UNSUPPORTED' }
  // 绝对路径 / file:// / 相对路径：已经是本地引用，保存时自会转成路径
  return { ok: true, alreadyLocal: true }
}
