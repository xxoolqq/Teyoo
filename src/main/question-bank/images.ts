// 题目配图（插图）的落盘。
//
// 为什么不把图片塞进 markdown 当 data URL：题干是要反复编辑的文本，一坨 base64
// 会让人没法看；而且同一张图在列表摘要、详情、导出里会被读很多次，内联等于把它
// 复制很多遍。
//
// 为什么用 file:// 而不是自定义协议：渲染端 webSecurity 只在开发态关掉（见
// main/index.ts 的说明），生产是 loadFile 的 file:// 页面 —— 同源加载本地图片没
// 问题，开发态跨源也放行。注册新协议要动 scheme 白名单与打包配置，这一版的收益
// 抵不上风险；真要做「图床化」再统一换。
//
// 位置：工作目录下的 images（默认 D:/TeyooData/images，偏好 image.workDir 可改）。
// 与「编辑器插图」「导入 docx 的图片」同一个目录：题库里的图和文档里的图能互相
// 复用，用户也只需要记住一个地方。源图本来就在这个目录里时不再复制一份。

import { copyFile, mkdir, open, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_WORK_DIR, getUserSettingByPath } from '../user-setting'
import { resolveImagesDir } from '../docx-image-store'

export interface SaveQuestionImageInput {
  /** 原始文件名，只在没有 sourcePath 时用来取扩展名 */
  name?: string
  /** 图片字节（IPC 结构化克隆过来的 Uint8Array） */
  data?: Uint8Array
  /**
   * 源文件的磁盘绝对路径（拖拽 / 选择本地文件时能拿到，粘贴剪贴板截图没有）。
   *
   * 只用来判断「是不是已经在工作目录的 images 里」：在里面就直接引用，不重复
   * 落一份；不在里面照常把字节写进 images（等于拷贝一份）。
   */
  sourcePath?: string
}

export interface SaveQuestionImageResult {
  ok: boolean
  /** 可直接写进 markdown 的 file:// URL（空格等已编码） */
  url?: string
  /** 磁盘绝对路径，排查用 */
  path?: string
  error?: string
}

const MAX_BYTES = 8 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

/**
 * 按魔数认格式。
 *
 * 不能只信文件名：拖进来的截图常常叫「image.png」却是 JPEG，扩展名和内容对不上时
 * 浏览器仍能渲染，但压缩/导出环节会按错误格式处理。认不出来再退回原扩展名。
 */
function sniffExtension(data: Uint8Array): string {
  const bytes = Buffer.from(data.subarray(0, 12))
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg'
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('ascii') === 'GIF') return '.gif'
  if (bytes.length >= 12 && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return '.bmp'
  return ''
}

/**
 * 读文件头认扩展名 —— 拷贝已有文件时用，别为了嗅探把整个图片读进内存。
 * 认不出来返回空串，由调用方退回文件名里的扩展名。
 */
async function sniffExtensionOfFile(filePath: string): Promise<string> {
  try {
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(512)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return sniffExtension(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

/**
 * 落盘文件名：时间戳（36 进制，8 位且可读排序）+ 6 位随机 + 扩展名，
 * 整体不超过 26 个字符 —— 这个名字会出现在题库详情、图注和导出的 Markdown 里，
 * 再长就把说明挤成一片。随机段负责同一毫秒里连传多张图的去重。
 */
function newImageFileName(extension: string): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}${extension}`
}

/** 图片落盘目录：工作目录 / images（与编辑器插图、docx 导入同一处） */
function imagesDirectory(): string {
  const workDir = getUserSettingByPath<string>('image.workDir') || DEFAULT_WORK_DIR
  return resolveImagesDir(workDir)
}

/**
 * 文件是不是已经在目录里。
 *
 * Windows 路径大小写不敏感，两侧都先归一化再比 —— 否则 D:/TeyooData 与 d:/teyoodata
 * 会被当成两个目录，同一张图白复制一份。
 */
function isInDirectory(directory: string, filePath: string): boolean {
  const rel = relative(resolve(directory).toLowerCase(), resolve(filePath).toLowerCase())
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export async function saveQuestionImage(
  input: SaveQuestionImageInput
): Promise<SaveQuestionImageResult> {
  const directory = imagesDirectory()
  const sourcePath = typeof input?.sourcePath === 'string' ? input.sourcePath.trim() : ''

  // 1) 源图已经在工作目录的 images 里 —— 直接引用原文件，别在同一层再堆一份副本
  if (sourcePath && isInDirectory(directory, sourcePath)) {
    try {
      const info = await stat(sourcePath)
      if (info.isFile()) {
        return { ok: true, url: pathToFileURL(sourcePath).href, path: sourcePath }
      }
    } catch {
      // 文件读不到就按普通上传处理，继续往下走
    }
  }

  const data = input?.data
  const named = extname(sourcePath || String(input?.name ?? '')).toLowerCase()

  // 2) 源图在别的目录：拷贝一份进来（渲染端已经拿到磁盘路径时不用再过一遍字节）
  if (sourcePath && !(data instanceof Uint8Array)) {
    try {
      const info = await stat(sourcePath)
      if (!info.isFile()) return { ok: false, error: 'SOURCE_NOT_FILE' }
      if (info.size > MAX_BYTES) return { ok: false, error: 'IMAGE_TOO_LARGE' }
      const sniffed = await sniffExtensionOfFile(sourcePath)
      const extension = sniffed || (ALLOWED_EXTENSIONS.has(named) ? named : '.png')
      await mkdir(directory, { recursive: true })
      const target = join(directory, newImageFileName(extension))
      await copyFile(sourcePath, target)
      return { ok: true, url: pathToFileURL(target).href, path: target }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // 3) 没有磁盘路径（粘贴的剪贴板截图）：把字节写进 images
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    return { ok: false, error: 'EMPTY_IMAGE' }
  }
  if (data.byteLength > MAX_BYTES) {
    return { ok: false, error: 'IMAGE_TOO_LARGE' }
  }

  const extension = sniffExtension(data) || (ALLOWED_EXTENSIONS.has(named) ? named : '.png')

  try {
    await mkdir(directory, { recursive: true })
    const filePath = join(directory, newImageFileName(extension))
    await writeFile(filePath, Buffer.from(data))
    return { ok: true, url: pathToFileURL(filePath).href, path: filePath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
