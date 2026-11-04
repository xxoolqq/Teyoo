// 按页码抽取 PDF 页面（导入中心的「页码范围」）。
//
// 用 @cantoo/pdf-lib —— 与「帮助 → PDF拆分」(pdf-split.ts) 同一个库。
// 那边按「每 N 页」切，这里按「指定页」抽，两者都需要 pdf-lib 的 copyPages；
// 项目里另外那个 pdfjs-dist 只读不写，生成不了新 PDF。
//
// 为什么要抽成一页页而不是把页码范围透传给 MinerU：MinerU 的接口没有页码参数
// （http/mineru.ts 的 applyUploadUrl 只有 model_version / is_ocr / enable_formula /
// enable_table / language），所以「只解析这几页」只能由本地先裁一份 PDF 再上传。
// 顺带的好处是上传体积小、识别更快、额度消耗也更少。

import { readFile, writeFile } from 'node:fs/promises'
import { PDFDocument } from '@cantoo/pdf-lib'

export interface PageRange {
  /** 起页，1 起、含 */
  start: number
  /** 止页，1 起、含 */
  end: number
}

export type PageRangeParse = { ok: true; ranges: PageRange[] } | { ok: false; error: string }

/**
 * 解析界面上那句「如: 1-6, 8, 10-12」。
 *
 * 规则与 MathBank 一致：留空 = 全部页面；逗号/中文逗号/空白都能当分隔符；
 * 单页写 `8`，连续页写 `1-6`。重复页会自动去重，顺序不敏感。
 * 这里不校验上界 —— 总页数得先打开 PDF 才知道，交给 extractPdfPages。
 */
export function parsePageRanges(text: string): PageRangeParse {
  const cleaned = (text ?? '').trim()
  // 留空是「全部页面」，不是错误
  if (!cleaned) return { ok: true, ranges: [] }

  const ranges: PageRange[] = []
  for (const token of cleaned.split(/[,，、\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:\s*[-~～—]\s*(\d+))?$/.exec(token)
    if (!match) return { ok: false, error: `PAGE_RANGE_FORMAT: ${token}` }
    const start = Number.parseInt(match[1], 10)
    const end = match[2] === undefined ? start : Number.parseInt(match[2], 10)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
      return { ok: false, error: `PAGE_RANGE_FORMAT: ${token}` }
    }
    ranges.push({ start, end })
  }
  if (ranges.length === 0) return { ok: false, error: 'PAGE_RANGE_FORMAT' }
  return { ok: true, ranges }
}

/** 「1-6」「8」拼回段标签，用于结果目录命名：1-6,8 → 1-6_8 */
export function pageRangeLabel(ranges: readonly PageRange[]): string {
  return ranges.map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`)).join('_')
}

/** 段 → 展开后的 0 起页下标（去重、升序）。 */
export function expandRanges(ranges: readonly PageRange[]): number[] {
  const pages = new Set<number>()
  for (const range of ranges) {
    for (let page = range.start; page <= range.end; page += 1) pages.add(page - 1)
  }
  return [...pages].sort((a, b) => a - b)
}

export interface ExtractResult {
  ok: boolean
  /** 源 PDF 的总页数（拿不到时不填） */
  pageCount?: number
  /** 实际抽出的页数 */
  extracted?: number
  error?: string
}

/**
 * 把 sourcePath 里指定的页抽成一份新 PDF 写到 outPath。
 *
 * 越界直接报错而不是静默截断：「我填了 1-12，结果只出了 10 页」比报错更难查，
 * 用户会以为后面两页是识别丢了。
 */
export async function extractPdfPages(
  sourcePath: string,
  ranges: readonly PageRange[],
  outPath: string
): Promise<ExtractResult> {
  let source: Buffer
  try {
    source = await readFile(sourcePath)
  } catch (error) {
    return { ok: false, error: `READ_FAILED: ${error instanceof Error ? error.message : String(error)}` }
  }

  let doc: PDFDocument
  try {
    // ignoreEncryption：只读密码的 PDF 也能解出内容（与 pdf-split 同一取舍）
    doc = await PDFDocument.load(source, { ignoreEncryption: true })
  } catch (error) {
    return { ok: false, error: `PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}` }
  }

  const pageCount = doc.getPageCount()
  if (pageCount === 0) return { ok: false, error: 'EMPTY_PDF', pageCount }

  for (const range of ranges) {
    if (range.end > pageCount) {
      return { ok: false, error: `PAGE_OUT_OF_RANGE: ${range.end} > ${pageCount}`, pageCount }
    }
  }

  const indices = expandRanges(ranges)
  if (indices.length === 0) return { ok: false, error: 'PAGE_RANGE_EMPTY', pageCount }

  try {
    const target = await PDFDocument.create()
    const copied = await target.copyPages(doc, indices)
    for (const page of copied) target.addPage(page)
    await writeFile(outPath, await target.save())
  } catch (error) {
    return {
      ok: false,
      error: `WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      pageCount
    }
  }

  return { ok: true, pageCount, extracted: indices.length }
}
