// 导入 .docx 时的图片落盘：把 mammoth 抽出的图片字节写进「工作目录/images」。
// ────────────────────────────────────────────────────────────────────────────
//
// 这是 **Node-only** 模块：docx-import.ts 直接 import 它，图片落盘是该模块的内置
// 行为，调用方不需要传任何钩子。偏好在内部读（image.docxImageMode / image.workDir），
// 所以「内嵌 base64 还是落盘」这个开关对 docx-import 是透明的。
//
// WebView2 任务窗格页没有 fs：vite.webview2.config.ts 把 './docx-image-store'
// 别名到 src/webview2/docx-image-store-shim.ts（同签名、永远返回 null），
// 于是浏览器侧自动退回 mammoth 的 data URI 内嵌——与 canvas-shim 同一套手法，
// docx-import.ts 的源码一行都不用为浏览器妥协。
//
// 返回 null 的语义统一为「这条路走不通，请退回内嵌」，绝不丢图。

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getUserSettingByPath } from './user-setting'

/** 图片子目录：工作目录下的 images（默认 D:/TeyooData/images） */
export function resolveImagesDir(workDir: string): string {
  return path.join(workDir, 'images')
}

/** 按 mime 猜扩展名；认不出就用 bin（文件名只影响预览与引用，不影响内容） */
function extensionOf(mime: string): string {
  const normalized = (mime || '').toLowerCase().trim()
  const table: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/tiff': 'tif',
    'image/x-emf': 'emf',
    'image/x-wmf': 'wmf',
    'image/emf': 'emf',
    'image/wmf': 'wmf'
  }
  return table[normalized] ?? 'bin'
}

/**
 * 落盘模式？读偏好：image.docxImageMode === 'directory' 才写盘。
 * 读不到偏好（宿主没注入设置）时按 directory 处理，与主进程默认一致。
 */
function shouldStore(): boolean {
  const mode = getUserSettingByPath<string>('image.docxImageMode')
  return mode !== 'datauri'
}

/**
 * 按字节头认图片格式。**不信 mime 与文件名**：网络图常把 PNG 标成
 * image/jpeg，data URL 里的 mime 也可能是抄错的，按声明写扩展名会让
 * 「名字是 .jpg、内容是 PNG」的文件进目录（Word/预览都能看，但工具链会误判）。
 * 认不出返回 null，由调用方退回声明的 mime。
 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 2) return null
  const head = Buffer.from(bytes.subarray(0, 16))
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
  if (head.length >= 6 && head.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (head.length >= 12 && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp'
  // SVG 是文本：只看开头一段里有没有 <svg（<?xml 开头的也算）
  const text = Buffer.from(bytes.subarray(0, 512)).toString('utf8').toLowerCase()
  if (text.includes('<svg')) return 'image/svg+xml'
  return null
}

/**
 * 写出一张图片到指定目录，返回它在 Markdown 里的 src（正斜杠绝对路径）；
 * 目录不可写、字节为空返回 null —— 由调用方退回 data URI。
 *
 * 文件名取内容 sha256 的前 12 位：同一张图在文档里出现多次只落一份，
 * 重复导入同一份试卷也不会把目录塞满。
 */
async function writeImage(
  imagesDir: string,
  mime: string,
  bytes: Uint8Array
): Promise<string | null> {
  if (!bytes || bytes.length === 0) return null
  try {
    await mkdir(imagesDir, { recursive: true })
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
    // 扩展名以字节头为准（见 sniffMime），认不出才用调用方给的 mime
    const target = path.join(imagesDir, `${digest}.${extensionOf(sniffMime(bytes) ?? mime)}`)
    await writeFile(target, bytes)
    // 写进 Markdown 的 src 统一用正斜杠：Windows 路径里的反斜杠在 Markdown 里
    // 会被当成转义符看待（渲染侧 toFileUrl 两种都认，但正斜杠不会有歧义）
    return target.replace(/\\/g, '/')
  } catch {
    return null
  }
}

/**
 * 写出一张图片，返回它在 Markdown 里的 src（正斜杠绝对路径）；
 * 内嵌模式、目录不可写、字节为空都返回 null —— 由调用方退回 data URI。
 */
export async function storeDocxImage(
  mime: string,
  bytes: Uint8Array,
  overrideDir?: string
): Promise<string | null> {
  if (!bytes || bytes.length === 0) return null
  // 显式给了目录就照办（调用方自己知道该放哪）；没给才读偏好
  if (!overrideDir && !shouldStore()) return null
  const workDir = getUserSettingByPath<string>('image.workDir') || 'D:/TeyooData'
  return writeImage(overrideDir || resolveImagesDir(workDir), mime, bytes)
}

/**
 * 编辑器粘贴 / 插图：**始终写盘**，不受 image.docxImageMode 影响（那是给 docx
 * 导入用的开关）。编辑器里默认内嵌 base64 会把 Markdown 撑大几十倍（一张截图
 * 就是几万字符），而本项目保存/导出/预览都已支持本地路径（main 的
 * resolveImagePaths、image-style 的 toFileUrl、docx-export 的 imagePath）。
 *
 * 返回正斜杠绝对路径；写不进去返回 null，由调用方决定是否退回内嵌。
 */
export async function storeEditorImage(mime: string, bytes: Uint8Array): Promise<string | null> {
  const workDir = getUserSettingByPath<string>('image.workDir') || 'D:/TeyooData'
  return writeImage(resolveImagesDir(workDir), mime, bytes)
}
