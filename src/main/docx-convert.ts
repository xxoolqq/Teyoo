// docx → PDF（预览用）。
//
// 「docx转md」标签页左侧要显示文档版式，浏览器里没有 docx 渲染器，所以借
// doc2pdf.exe：它用 COM 晚绑定调本机 Word（不依赖 TypeLib，Office 2007+ 都行），
// 把 .docx 另存为 PDF，渲染端再用 pdf.js 画出来。
//
// 为什么不做成「docx → png」：pdf2png.exe 走 mupdf 静态链接（约 40MB），而
// pdf.js 本就在项目里（PDF 对照标签页在用），直接读 PDF 字节画 canvas 更省。
//
// PDF 存哪：userData 下的缓存目录，按「文档内容哈希」分桶。
//   · 不用 %TEMP%：系统清理临时目录不可控，跨会话就复用不上了
//   · 不用 docx 同目录：预览是随时可删可重建的派生数据，不该混进用户的文件里，
//     更不该去覆盖同名的 <name>.pdf（那是用户自己的东西）
//   要落到同目录时走「导出 PDF」那条显式命令（见 main 的 docx-export-pdf）。
//
// 命中的代价：读一遍文件算 sha256（几十 KB 到几 MB，毫秒级），省掉 Word 冷启动
// 的 2–5 秒。内容变没变由哈希说了算 —— mtime 会被复制、同步盘、解压工具改掉。
//
// exe 的位置：
//   · 打包后   process.resourcesPath/bin      （electron-builder 的 extraResources）
//   · 开发期   仓库根的 resources/bin
// 两者同名，逻辑与 word2pdf2image/electron/converter-service.js 一致（那份原件
// 放在 resources/word2pdf2image/electron/ 随包留档，运行时不加载）。

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

/** Word 启动 + 另存 PDF 通常 2–5 秒，给足两分钟；卡住就杀掉，别让界面一直转。 */
const CONVERT_TIMEOUT_MS = 120_000

/** 缓存格式版本：doc2pdf 换实现、Word 渲染行为变化时 +1，旧目录启动时整体丢弃。 */
const CACHE_SCHEMA = 1
/** 缓存上限（启动时按最近使用时间回收）：总容量 / 条目数 / 保留天数。 */
const CACHE_MAX_BYTES = 500 * 1024 * 1024
const CACHE_MAX_ENTRIES = 200
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** 超过这个体积的 docx 不写缓存（读一遍 + 复制都太贵），每次现转。 */
const CACHE_SKIP_BYTES = 200 * 1024 * 1024

export interface DocxPdfResult {
  ok: boolean
  /** 生成的 PDF 绝对路径（ok 时有） */
  pdfPath?: string
  /** CONVERTER_MISSING / TIMEOUT / EXIT_<code> / 具体错误文本 */
  error?: string
  /** doc2pdf 的原始输出（排查用，最多留 20 行） */
  log?: string[]
  /** 直接复用了磁盘缓存里的 PDF —— 没有重新调 Word */
  fromCache?: boolean
}

/** 缓存条目元数据：命中时要对 schema 与 PDF 体积做校验，防半截文件。 */
interface CacheMeta {
  schema: number
  /** 最近一次用它的源文件路径（同名文档改名后仍能追到出处） */
  source: string
  name: string
  docxBytes: number
  pdfBytes: number
  createdAt: number
  lastUsedAt: number
}

function binDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'bin')
  const devDir = join(app.getAppPath(), 'resources', 'bin')
  return existsSync(devDir) ? devDir : join(process.cwd(), 'resources', 'bin')
}

function exePath(name: string): string {
  return join(binDir(), name)
}

/** 预览 PDF 的缓存根目录。main 里的「在文件夹中显示」也拿它做路径白名单。 */
export function docxCacheRoot(): string {
  return join(app.getPath('userData'), 'docx-preview-cache', `v${CACHE_SCHEMA}`)
}

/** 同一份文档的并发请求合并成一个：多窗口同时选同一份 docx 时不会互相踩目录。 */
const inFlight = new Map<string, Promise<DocxPdfResult>>()

function cacheKeyOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/**
 * 查缓存。命中返回 PDF 路径，未命中返回 null。
 *
 * 三样都得对：meta 的 schema、PDF 存在、PDF 体积与 meta 记的一致 —— 后者能挡掉
 * 「转换写到一半进程被杀」留下的半截文件。
 */
async function readCache(key: string, source: string): Promise<string | null> {
  const dir = join(docxCacheRoot(), key)
  const pdfPath = join(dir, 'preview.pdf')
  try {
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8')) as CacheMeta
    if (meta.schema !== CACHE_SCHEMA || !meta.pdfBytes) return null
    const info = await stat(pdfPath)
    if (info.size !== meta.pdfBytes) return null
    // 刷新最近使用时间，回收时按它排序；写失败只影响回收顺序，不该让命中失效
    meta.lastUsedAt = Date.now()
    meta.source = source
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta)).catch(() => {})
    return pdfPath
  } catch {
    return null
  }
}

/** 把 staging 目录整体提升为正式缓存条目。失败也不要紧：PDF 还在 staging 里能用。 */
async function storeCache(
  key: string,
  source: string,
  docxBytes: number,
  converted: DocxPdfResult & { pdfPath: string },
  stagingDir: string
): Promise<DocxPdfResult> {
  const finalDir = join(docxCacheRoot(), key)
  try {
    const info = await stat(converted.pdfPath)
    // 缓存内统一叫 preview.pdf：读的时候只有一个固定路径可找，不必依赖源文件名
    // （doc2pdf 是按源 docx 名输出的，改名/换目录后 key 不变、文件名会变）。
    const stagedPdf = join(stagingDir, 'preview.pdf')
    if (converted.pdfPath !== stagedPdf) await rename(converted.pdfPath, stagedPdf)
    await rm(finalDir, { recursive: true, force: true })
    await rename(stagingDir, finalDir)
    const now = Date.now()
    const meta: CacheMeta = {
      schema: CACHE_SCHEMA,
      source,
      name: basename(source),
      docxBytes,
      pdfBytes: info.size,
      createdAt: now,
      lastUsedAt: now
    }
    await writeFile(join(finalDir, 'meta.json'), JSON.stringify(meta))
    return { ...converted, pdfPath: join(finalDir, 'preview.pdf') }
  } catch {
    return { ...converted, log: [...(converted.log ?? []), '缓存写入失败，本次仍可预览'] }
  }
}

/**
 * 调 doc2pdf.exe 把一份 docx 转成 PDF。
 *
 * doc2pdf 的 stdout / stderr 是 **UTF-16LE**（源码里用的 wprintf），逐行形如
 * 「a.docx -> a.pdf」或「转换失败 xxx: 原因」，所以这里按 utf16le 解码后再挑
 * 以 .pdf 结尾的目标路径。
 */
function runDoc2Pdf(exe: string, input: string, outDir: string): Promise<DocxPdfResult> {
  return new Promise<DocxPdfResult>((resolve) => {
    const log: string[] = []
    const pdfPaths: string[] = []
    let stderrText = ''
    let settled = false

    const child = spawn(exe, [input, outDir], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    const settle = (result: DocxPdfResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // Word 被弹窗卡住（比如「文档已损坏」）时进程不会退出，超时兜底
    const timer = setTimeout(() => {
      child.kill()
      settle({ ok: false, error: 'TIMEOUT', log: log.slice(-20) })
    }, CONVERT_TIMEOUT_MS)

    const attach = (stream: NodeJS.ReadableStream, isErr: boolean): void => {
      let buffer = ''
      stream.setEncoding('utf16le' as BufferEncoding)
      stream.on('data', (chunk: string) => {
        buffer += chunk.replace(/\u0000/g, '')
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '').trim()
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf('\n')
          if (!line) continue
          if (log.length < 40) log.push(line)
          if (isErr) stderrText += `${line}\n`
          // 成功行：`[1/1] OK  a.docx -> a.pdf`
          const dest = /->\s*(.+\.pdf)\s*$/i.exec(line)
          if (dest) pdfPaths.push(dest[1].trim())
        }
      })
    }
    attach(child.stdout, false)
    attach(child.stderr, true)

    child.on('error', (error) => {
      settle({ ok: false, error: error.message, log: log.slice(-20) })
    })

    child.on('close', (code) => {
      const pdfPath = pdfPaths.find((path) => existsSync(path)) ?? pdfPaths[0]
      if (code === 0 && pdfPath && existsSync(pdfPath)) {
        settle({ ok: true, pdfPath, log: log.slice(-20) })
        return
      }
      // stderr 里通常是「转换失败 xxx.docx: Word 未安装 / 文件被占用…」
      const reason = stderrText.trim().split('\n').filter(Boolean).pop()
      settle({
        ok: false,
        error: reason || `EXIT_${code ?? 'NULL'}`,
        log: log.slice(-20)
      })
    })
  })
}

/**
 * 转换一份 docx，能复用缓存就直接复用。
 *
 * 流程：读文件 → 算内容哈希 → 查缓存 → 未命中才调 Word（转换先落到 `<root>/.tmp-*`，
 * 成功后整目录 rename 成 `<root>/<key>`，所以外面永远看不到半截缓存）。
 */
export async function docxToPdf(input: string): Promise<DocxPdfResult> {
  const exe = exePath('doc2pdf.exe')
  if (!existsSync(exe)) return { ok: false, error: 'CONVERTER_MISSING' }

  let bytes: Buffer
  try {
    bytes = await readFile(input)
  } catch {
    return { ok: false, error: `没有找到可转换的 .docx/.doc 文件: ${input}` }
  }

  const key = cacheKeyOf(bytes)
  const hit = await readCache(key, input)
  if (hit) return { ok: true, pdfPath: hit, fromCache: true, log: [`缓存命中 ${key}`] }

  const running = inFlight.get(key)
  if (running) return await running

  const task = (async (): Promise<DocxPdfResult> => {
    const cacheable = bytes.length <= CACHE_SKIP_BYTES
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const stagingDir = cacheable
      ? join(docxCacheRoot(), `.tmp-${key}-${stamp}`)
      : join(tmpdir(), 'teyoo-docx-preview', `tmp-${key}-${stamp}`)
    try {
      await mkdir(stagingDir, { recursive: true })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    const converted = await runDoc2Pdf(exe, input, stagingDir)
    if (!converted.ok || !converted.pdfPath) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
      return converted
    }
    // 超大文档不进缓存：staging 本身就在临时目录里，直接用
    if (!cacheable) return converted
    return await storeCache(key, input, bytes.length, { ...converted, pdfPath: converted.pdfPath }, stagingDir)
  })()

  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

/**
 * 启动时的缓存维护：删过期的、删超量的、删上次转换中途退出留下的 .tmp-*，
 * 顺手把旧版本留在 %TEMP% 里的预览目录整棵清掉。
 *
 * 全流程 try/catch —— 缓存维护失败绝不能影响主流程。
 */
export async function pruneDocxPdfCache(): Promise<void> {
  const root = docxCacheRoot()
  const now = Date.now()
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const items: { dir: string; lastUsedAt: number; bytes: number }[] = []
    for (const entry of entries) {
      const full = join(root, entry.name)
      // 上次转换中途退出的残渣
      if (entry.name.startsWith('.tmp-')) {
        await rm(full, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (!entry.isDirectory()) continue
      try {
        const meta = JSON.parse(await readFile(join(full, 'meta.json'), 'utf-8')) as CacheMeta
        // 版本不对或太旧：直接丢
        if (meta.schema !== CACHE_SCHEMA || now - meta.lastUsedAt > CACHE_MAX_AGE_MS) {
          await rm(full, { recursive: true, force: true }).catch(() => {})
          continue
        }
        items.push({ dir: full, lastUsedAt: meta.lastUsedAt, bytes: meta.pdfBytes || 0 })
      } catch {
        // 没有 meta 或元数据坏了：当成残渣
        await rm(full, { recursive: true, force: true }).catch(() => {})
      }
    }

    // 旧的先走：按最近使用时间升序删到条目数、总容量都回到线内
    items.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    let total = items.reduce((sum, item) => sum + item.bytes, 0)
    let count = items.length
    for (const item of items) {
      if (count <= CACHE_MAX_ENTRIES && total <= CACHE_MAX_BYTES) break
      await rm(item.dir, { recursive: true, force: true }).catch(() => {})
      total -= item.bytes
      count -= 1
    }
  } catch {
    /* 目录还不存在 / 读不了：没什么可维护的 */
  }

  // 旧版本的临时预览目录（现在只用于超大文档的临时落点），整棵删掉不让它累积
  await rm(join(tmpdir(), 'teyoo-docx-preview'), { recursive: true, force: true }).catch(() => {})
}
