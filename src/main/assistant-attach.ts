// 文档助手附件：把「图片 / 文件」变成**文本**，必要时顺带把公式识别出来。
//
// 为什么先转文本再喂模型：把图片直接丢给视觉模型，等于要求用户的模型支持 vision ——
// 换个文本模型就失效（"模型无关"就白做了）。所以这里的顺序是：
//   图片 → OCR（① MinerU，解析它的 full.md；② 自建 OCR 的 SimpleTex 契约）→ 都失败
//   才留原图给视觉模型（那一步在渲染端，见 assistant.ts 的 recognizeFormula）
//   pdf  → MinerU（它本来就吃 pdf，返回的 markdown 里公式已经是 LaTeX）
//   docx → 本地 docx 导入那条链（返回 markdown）
//   md/txt/其它文本 → 直接读
// 产出全是纯文本，任何 OpenAI 兼容模型都能用；图片附件另外带上 data URL，供视觉模型直传。

import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { ocrFormulaImageBytes } from './docx-import'
import { parsePdfOnline } from './http/mineru'

/** 图片附件（这几种 MinerU / OCR 都认） */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp'])
/** 纯文本附件直接读 */
const TEXT_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'txt', 'json', 'csv', 'yml', 'yaml', 'html', 'htm'])
/** 附件文本上限：再大也没意义（对话窗口装不下），还费 token */
const MAX_TEXT_CHARS = 200_000
/** 图片 OCR 超时（MinerU 那条链路本身是长任务，这里给宽一点） */
const OCR_TIMEOUT_MS = 180_000

export interface AssistantAttachment {
  path: string
  name: string
  kind: 'image' | 'text' | 'unsupported'
  /** 给模型用的文本（图片=识别结果；文件=转出来的 markdown/文本） */
  text?: string
  /** 图片附件的 data URL（缩略图；视觉模型直传也用它） */
  dataUrl?: string
  /** 图片识别出的 LaTeX（不含 $ 定界符） */
  latex?: string
  /** 这份文本是怎么来的，UI 用它说明白 */
  source?: 'simpletex' | 'mineru' | 'file'
  /** 失败原因（kind === 'unsupported' 或识别失败） */
  error?: string
  bytes?: number
  truncated?: boolean
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jp2: 'image/jp2',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp'
}

function extOf(filePath: string): string {
  return extname(filePath).replace(/^\./, '').toLowerCase()
}

/** 去掉图片引用、HTML 注释、分隔线等噪音（MinerU 的 full.md 里常混着这些） */
function stripMarkdownNoise(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
}

/**
 * 从 MinerU 交出来的 full.md 里**抽公式**（返回不含 $ 定界符的 LaTeX；抽不到返回 null）。
 *
 * 以前是"整段必须恰好是一个 `$…$` / `$$…$$`"，实际根本不够用：full.md 里常带图片
 * 引用、标题、空行，或者公式后面还跟着一句说明 —— 稍带一点别的东西就被判成
 * "不是公式"（NOT_A_FORMULA），整份识别结果白读。这里改成从整篇里找公式块：
 *   $$…$$ / \[…\]（行间）、\(…\) / $…$（行内）。
 *
 * 只有一块就直接用；多块用 `\quad` 连成一行 —— 调用方要把它塞回行内，不能带换行。
 */
export function extractMathFromMarkdown(markdown: string): string | null {
  let rest = stripMarkdownNoise(markdown)
  /** 抽走所有匹配的块（用换行占位，避免左右两段被粘成一句），返回块内容 */
  const pull = (re: RegExp): string[] => {
    const found: string[] = []
    rest = rest.replace(re, (_match, inner: string) => {
      found.push(inner)
      return '\n'
    })
    return found
  }
  // 顺序要紧：先 $$…$$，再 \[…\]，最后才轮到单个 $…$（否则 $ 会两两配错）
  const blocks = [
    ...pull(/\$\$([\s\S]+?)\$\$/g),
    ...pull(/\\\[([\s\S]+?)\\\]/g),
    ...pull(/\\\(([\s\S]+?)\\\)/g),
    ...pull(/\$([^$\n]+?)\$/g)
  ]
  const cleaned = blocks
    .map((block) =>
      block
        // MinerU 有时会把公式包在 equation 环境里：编辑器不认环境，剥掉外壳
        .replace(/\\begin\{(?:equation\*?|displaymath)\}/g, '')
        .replace(/\\end\{(?:equation\*?|displaymath)\}/g, '')
    )
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (cleaned.length === 0) return null
  return cleaned.join(' \\quad ')
}

/** 用 MinerU 识别一张图片（先拷进临时目录再跑：别在用户的图片旁边留 `<图片>.mineru/`） */
async function mineruImageToMarkdown(
  filePath: string,
  token: string,
  insecureDownload: boolean
): Promise<{ text?: string; timeup?: boolean; error?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'teyoo-ocr-'))
  const copy = join(dir, basename(filePath))
  try {
    await copyFile(filePath, copy)
    const result = await parsePdfOnline({ filePath: copy, token, insecureDownload })
    if (!result.ok || !result.markdownPath) return { error: result.error ?? 'MINERU_FAILED' }
    const markdown = await readFile(result.markdownPath, 'utf-8')
    const trimmed = markdown.trim()
    if (!trimmed) return { error: 'EMPTY_RESULT' }
    return { text: trimmed }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface OcrResult {
  ok: boolean
  /** 识别出的 LaTeX（不含 $） */
  latex?: string
  /** 没能当成公式时，退回来的整段识别文本 */
  text?: string
  source?: 'simpletex' | 'mineru'
  error?: string
}

/**
 * 图片 → 公式。顺序：**① MinerU → ② 本地 SimpleTex 契约**。
 *
 * 为什么 MinerU 在前：真机上验过（手画公式 → `\mathrm{E} = \mathrm{mc} ^ {2}`），
 * 公式图它是真的读得对；而那个 SimpleTex 端点（`COLAMD_OCR_URL`，默认
 * 127.0.0.1:8787）是给"以后自建 OCR"留的口子，没搭起来时只会白等一次连接失败。
 * ③ 大模型（视觉直传）不在这里 —— 它在渲染端，作为前两步都失败后的最后一步。
 */
export async function ocrImageToLatex(
  filePath: string,
  options: { mineruToken?: string; insecureDownload?: boolean } = {}
): Promise<OcrResult> {
  const ext = extOf(filePath)
  if (!IMAGE_EXTS.has(ext)) return { ok: false, error: 'NOT_AN_IMAGE' }

  // ① MinerU：解析它交出来的 full.md（见 extractMathFromMarkdown）
  const token = (options.mineruToken ?? '').trim()
  let mineruText: string | undefined
  let mineruError: string | undefined
  if (token) {
    const mineru = await mineruImageToMarkdown(filePath, token, options.insecureDownload === true)
    if (mineru.text) {
      const math = extractMathFromMarkdown(mineru.text)
      if (math) return { ok: true, latex: math, text: mineru.text, source: 'mineru' }
      mineruText = mineru.text
    } else {
      mineruError = mineru.error ?? 'MINERU_FAILED'
    }
  } else {
    mineruError = 'NO_MINERU_TOKEN'
  }

  // ② 本地 OCR 契约（没自建服务时很快失败）
  const bytes = await readFile(filePath)
  const simpletex = await ocrFormulaImageBytes(bytes, ext === 'jpeg' ? 'jpg' : ext)
  if (simpletex) return { ok: true, latex: simpletex, text: mineruText, source: 'simpletex' }

  // 两步都没拿到公式：整段识别文本交出去（调用方当普通文本，或退给大模型）
  if (mineruText) return { ok: false, text: mineruText, source: 'mineru', error: 'NOT_A_FORMULA' }
  return { ok: false, error: mineruError ?? 'OCR_FAILED' }
}

/** 把任意附件读成"模型能吃的文本"；图片另外给出 data URL 与（尽力而为的）公式 */
export async function readAttachment(
  filePath: string,
  options: { mineruToken?: string; insecureDownload?: boolean } = {}
): Promise<AssistantAttachment> {
  const name = basename(filePath)
  const ext = extOf(filePath)
  let bytes = 0
  try {
    bytes = (await readFile(filePath)).byteLength
  } catch {
    return { path: filePath, name, kind: 'unsupported', error: 'READ_FAILED' }
  }

  if (IMAGE_EXTS.has(ext)) {
    const raw = await readFile(filePath)
    return {
      path: filePath,
      name,
      kind: 'image',
      bytes,
      dataUrl: `data:${MIME_BY_EXT[ext] ?? 'image/png'};base64,${raw.toString('base64')}`
      // 不在这里做 OCR：粘贴/选图要快，识别是用户点「识别公式」时才做的事
    }
  }

  if (TEXT_EXTS.has(ext)) {
    const content = await readFile(filePath, 'utf-8')
    const truncated = content.length > MAX_TEXT_CHARS
    return {
      path: filePath,
      name,
      kind: 'text',
      bytes,
      source: 'file',
      text: truncated ? content.slice(0, MAX_TEXT_CHARS) : content,
      truncated
    }
  }

  if (ext === 'docx') {
    try {
      const { docxToMarkdown } = await import('./docx-import')
      const { markdown } = await docxToMarkdown(await readFile(filePath), { imageFormulaOcr: false })
      const truncated = markdown.length > MAX_TEXT_CHARS
      return {
        path: filePath,
        name,
        kind: 'text',
        bytes,
        source: 'file',
        text: truncated ? markdown.slice(0, MAX_TEXT_CHARS) : markdown,
        truncated
      }
    } catch (error) {
      return { path: filePath, name, kind: 'unsupported', error: error instanceof Error ? error.message : String(error) }
    }
  }

  if (ext === 'pdf') {
    const token = (options.mineruToken ?? '').trim()
    if (!token) return { path: filePath, name, kind: 'unsupported', bytes, error: 'NO_MINERU_TOKEN' }
    const result = await mineruImageToMarkdown(filePath, token, options.insecureDownload === true)
    if (!result.text) return { path: filePath, name, kind: 'unsupported', bytes, error: result.error ?? 'MINERU_FAILED' }
    const truncated = result.text.length > MAX_TEXT_CHARS
    return {
      path: filePath,
      name,
      kind: 'text',
      bytes,
      source: 'mineru',
      text: truncated ? result.text.slice(0, MAX_TEXT_CHARS) : result.text,
      truncated
    }
  }

  // 其它扩展名：当文本试一次（编码不对就算了）
  try {
    const content = await readFile(filePath, 'utf-8')
    if (/\u0000/.test(content.slice(0, 4000))) {
      return { path: filePath, name, kind: 'unsupported', bytes, error: 'BINARY_FILE' }
    }
    const truncated = content.length > MAX_TEXT_CHARS
    return {
      path: filePath,
      name,
      kind: 'text',
      bytes,
      source: 'file',
      text: truncated ? content.slice(0, MAX_TEXT_CHARS) : content,
      truncated
    }
  } catch {
    return { path: filePath, name, kind: 'unsupported', bytes, error: 'UNSUPPORTED_FILE' }
  }
}

/** 剪切板里粘进来的图片：落成临时文件，再按普通图片附件处理 */
export async function savePastedImage(dataUrl: string): Promise<AssistantAttachment> {
  const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl.trim())
  if (!match) return { path: '', name: '', kind: 'unsupported', error: 'NOT_AN_IMAGE' }
  const rawExt = match[1] === 'jpeg' ? 'jpg' : match[1].replace('svg+xml', 'svg')
  const dir = await mkdtemp(join(tmpdir(), 'teyoo-paste-'))
  const filePath = join(dir, `粘贴的图片.${rawExt}`)
  await writeFile(filePath, Buffer.from(match[2], 'base64'))
  return readAttachment(filePath)
}
