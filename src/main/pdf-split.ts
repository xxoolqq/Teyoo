// PDF 按页数拆分（帮助 → PDF拆分）。
//
// 用 @cantoo/pdf-lib（pdf-lib 的社区维护分支，Node 里直接可用）：项目里已有的
// pdfjs-dist 只读不写，生成不了新 PDF。
//
// 输出规则（用户定的）：
//   - 结果放在与原 PDF 同级的「<原名>_拆分_<YYYYMMDD>」文件夹里，带上日期戳，
//     反复拆分不会互相覆盖。
//   - 分片命名「<原名>_<起页>-<止页>.pdf」，单页分片也写成 n-n（命名一致，
//     按名字排序就是页码顺序）。
//
// 目录安全：本文件会 rmSync 掉自己的输出目录。目录名恒带「_拆分_日期」后缀，
// 不可能等于源文件路径，也不可能等于源文件所在目录 —— 这两条各写一个断言，
// 因为之前 MinerU 那边就吃过「输出目录 == 源文件」的亏（会把用户文件删掉）。

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { PDFDocument } from '@cantoo/pdf-lib'

export interface SplitShard {
  /** 文件名（不含目录） */
  name: string
  /** 起页（1 起、含） */
  startPage: number
  /** 止页（1 起、含） */
  endPage: number
  /** 字节数，给界面显示用 */
  bytes: number
}

export interface SplitResult {
  ok: boolean
  /** 输出文件夹绝对路径；失败时也可能有值（目录建好了、写某个分片时才失败） */
  dir?: string
  /** 已写出的分片（成功时按页码范围升序） */
  shards?: SplitShard[]
  /** 源 PDF 的总页数 */
  pageCount?: number
  /** 失败原因：INVALID_PAGES / READ_FAILED / PARSE_FAILED / EMPTY_PDF / BAD_OUTPUT_DIR / WRITE_FAILED */
  error?: string
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 输出文件夹：<原文目录>/<原名>_拆分_<YYYYMMDD> */
export function splitDirFor(sourcePath: string, now = new Date()): string {
  const base = basename(sourcePath, extname(sourcePath))
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return join(dirname(sourcePath), `${base}_拆分_${stamp}`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把 sourcePath 按每 pagesPerFile 页切一份。
 * 纯 Node 实现（不碰 Electron API），所以能脱离 Electron 单测。
 */
export async function splitPdfByPageCount(
  sourcePath: string,
  pagesPerFile: number
): Promise<SplitResult> {
  const per = Math.floor(pagesPerFile)
  if (!Number.isFinite(per) || per < 1) return { ok: false, error: 'INVALID_PAGES' }

  let source: Buffer
  try {
    source = await readFile(sourcePath)
  } catch {
    return { ok: false, error: 'READ_FAILED' }
  }

  let doc: PDFDocument
  try {
    // ignoreEncryption：只读密码的 PDF 也能解出内容，省得用户先去解密。
    doc = await PDFDocument.load(source, { ignoreEncryption: true })
  } catch (error) {
    return { ok: false, error: `PARSE_FAILED: ${messageOf(error)}` }
  }

  const pageCount = doc.getPageCount()
  if (pageCount === 0) return { ok: false, error: 'EMPTY_PDF', pageCount }

  const dir = splitDirFor(sourcePath)
  // 见文件头：写之前先把这两条排除掉，宁可报错也不 rm 用户的东西。
  if (dir === sourcePath || dir === dirname(sourcePath)) {
    return { ok: false, error: 'BAD_OUTPUT_DIR', pageCount }
  }

  try {
    // 每次拆分都当新的一次：同一文件夹里残留着上一次不同页数的分片，
    // 会让人分不清哪个是这次的结果。
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
  } catch (error) {
    return { ok: false, error: `WRITE_FAILED: ${messageOf(error)}`, pageCount }
  }

  const base = basename(sourcePath, extname(sourcePath))
  const shards: SplitShard[] = []
  try {
    for (let start = 1; start <= pageCount; start += per) {
      const end = Math.min(pageCount, start + per - 1)
      const indices: number[] = []
      for (let page = start; page <= end; page++) indices.push(page - 1)
      const shard = await PDFDocument.create()
      const copied = await shard.copyPages(doc, indices)
      for (const page of copied) shard.addPage(page)
      const bytes = await shard.save()
      const name = `${base}_${start}-${end}.pdf`
      await writeFile(join(dir, name), bytes)
      shards.push({ name, startPage: start, endPage: end, bytes: bytes.byteLength })
    }
  } catch (error) {
    return { ok: false, dir, shards, pageCount, error: `WRITE_FAILED: ${messageOf(error)}` }
  }

  return { ok: true, dir, shards, pageCount }
}
