// 智能组卷：卷面数据、卷面 HTML、导出与历史记录。
//
// 数据来源是本地题库（utils/question-bank 的 listQuestions，列表项里 already
// 带全量 content / answerMarkdown，不需要再拉详情）。组卷状态只活在这一页：
// entries = 按加入顺序排好的 [题号 + 分值 + 题目]，总分与难度比都由它算出来。
//
// 三种产物：
//   · markdown —— 「保存试卷」与「Word 导出」（主进程 markdownToDocx 吃这个）
//   · 卷面 HTML —— 「PDF 预览」（主进程隐藏窗口 printToPDF，不打印后台界面）
//   · 答题卡 HTML —— 「答题卡 PDF 预览」

import type { ExerciseListItem } from '../../preload/index'
import { renderBodyHtml } from './paper-render'

export interface PaperEntry {
  /** 题目在题库里的 id（也是「已加入」判据） */
  id: number
  /** 本题分值 */
  score: number
  item: ExerciseListItem
}

export interface PaperSettings {
  title: string
  /** 「题宫」：每题正文之后留出的作答高度（cm） */
  gapCm: number
}

export interface PaperExportRecord {
  id: string
  kind: 'pdf' | 'docx' | 'answer-sheet'
  name: string
  path: string | null
  at: number
  ok: boolean
  error?: string
}

export const DEFAULT_SCORE = 5
export const DEFAULT_GAP_CM = 7
export const MIN_GAP_CM = 1
export const MAX_GAP_CM = 20

/**
 * 难度五档：'1'~'5'。
 *
 * 用 store 的 EASY_LEVELS 口径而不是另起一套枚举 —— 拆题 prompt、入库校验、
 * 组卷统计必须认同一组值，否则会出现「界面选得出、入库被拒」的死角。
 */
export const EASY_META: Record<string, { label: string; color: string }> = {
  '1': { label: '很易', color: '#22c55e' },
  '2': { label: '易', color: '#84cc16' },
  '3': { label: '中', color: '#3b82f6' },
  '4': { label: '难', color: '#f59e0b' },
  '5': { label: '拔高', color: '#8b5cf6' }
}

export function easyLabel(easy: string): string {
  return EASY_META[easy]?.label ?? '中'
}

export function easyColor(easy: string): string {
  return EASY_META[easy]?.color ?? '#3b82f6'
}

export function totalScore(entries: PaperEntry[]): number {
  return entries.reduce((sum, entry) => sum + (Number(entry.score) || 0), 0)
}

export interface DifficultyBucket {
  key: string
  label: string
  color: string
  count: number
  percent: number
}

/** 难度比：按题目条数算占比（总分权重在教育场景里意义不大，条数更直观） */
export function easyBuckets(entries: PaperEntry[]): DifficultyBucket[] {
  const total = entries.length || 1
  const order = ['1', '2', '3', '4', '5']
  const buckets = order.map((key) => {
    const count = entries.filter((entry) => entry.item.easy === key).length
    return {
      key,
      label: EASY_META[key].label,
      color: EASY_META[key].color,
      count,
      percent: Math.round((count / total) * 100)
    }
  })
  // 库里可能有历史脏值（迁移前的难度枚举）：并进最后一档，总量才对得上
  const others = entries.filter((entry) => !order.includes(entry.item.easy)).length
  if (others > 0) {
    const last = buckets[buckets.length - 1]
    last.count += others
    last.percent = Math.round((last.count / total) * 100)
  }
  return buckets
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** 卷面 Markdown（「保存试卷」与「Word 导出」共用） */
export function buildPaperMarkdown(entries: PaperEntry[], settings: PaperSettings): string {
  const title = settings.title.trim() || '未命名试卷'
  const lines: string[] = [
    `# ${title}`,
    '',
    `共 ${entries.length} 题　满分 ${formatScore(totalScore(entries))} 分`,
    ''
  ]
  entries.forEach((entry, index) => {
    lines.push('---', '')
    lines.push(`**${index + 1}.（${formatScore(entry.score)} 分）**`)
    lines.push('')
    lines.push(entry.item.content.trim())
    lines.push('')
  })
  return lines.join('\n').trimEnd() + '\n'
}

/** 卷面打印用 CSS：只依赖系统字体，公式走 MathML */
const PAPER_CSS = `
@page { size: A4; margin: 18mm 16mm 16mm; }
* { box-sizing: border-box; }
body {
  margin: 0;
  color: #000;
  font-family: "Times New Roman", "SimSun", "Songti SC", "Noto Serif CJK SC", serif;
  font-size: 11pt;
  line-height: 1.75;
}
.pb-head { text-align: center; border-bottom: 1px solid #000; padding-bottom: 8pt; margin-bottom: 14pt; }
.pb-head h1 { margin: 0 0 6pt; font-size: 17pt; letter-spacing: 1pt; }
.pb-head p { margin: 0; font-size: 10.5pt; color: #333; }
.pb-item { break-inside: avoid; page-break-inside: avoid; margin: 0 0 6pt; }
.pb-item-head { display: flex; align-items: baseline; gap: 6pt; }
.pb-no { font-weight: 700; }
.pb-score { font-size: 10pt; color: #444; }
.pb-item-body p { margin: 0 0 4pt; }
.pb-item-body .pr-options { display: grid; grid-template-columns: 1fr 1fr; gap: 2pt 18pt; margin: 4pt 0 0; }
.pb-item-body .pr-option b { margin-right: 4pt; }
.pb-item-body .pr-img { max-width: 100%; }
.pb-item-body code { font-family: Consolas, "Courier New", monospace; font-size: 10pt; }
.pb-gap { }
.pb-answer-card { margin-top: 18pt; border-top: 1px dashed #999; padding-top: 8pt; font-size: 10pt; color: #444; }
math { font-size: 1.05em; }
`

function wrapHtmlDocument(title: string, body: string, extraCss = ''): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title.replace(/[<>&]/g, '')}</title>
<style>${PAPER_CSS}${extraCss}</style>
</head>
<body>
${body}
</body>
</html>`
}

/** 卷面 HTML（「PDF 预览」用） */
export function buildPaperHtml(entries: PaperEntry[], settings: PaperSettings): string {
  const title = settings.title.trim() || '未命名试卷'
  const gap = Math.min(Math.max(settings.gapCm, MIN_GAP_CM), MAX_GAP_CM)
  const items = entries
    .map((entry, index) => {
      const body = renderBodyHtml(entry.item.content, { mathml: true, images: true })
      return `<section class="pb-item">
  <div class="pb-item-head"><span class="pb-no">${index + 1}.</span><span class="pb-score">（${formatScore(
        entry.score
      )} 分）</span></div>
  <div class="pb-item-body">${body}</div>
  <div class="pb-gap" style="height:${gap}cm"></div>
</section>`
    })
    .join('\n')
  const head = `<header class="pb-head">
  <h1>${title.replace(/[<>&]/g, '')}</h1>
  <p>共 ${entries.length} 题　满分 ${formatScore(totalScore(entries))} 分</p>
</header>`
  return wrapHtmlDocument(title, `${head}\n<main>\n${items}\n</main>`)
}

/** 答题卡 HTML（「答题卡 PDF 预览」用） */
export function buildAnswerSheetHtml(entries: PaperEntry[], settings: PaperSettings): string {
  const title = settings.title.trim() || '未命名试卷'
  const gap = Math.min(Math.max(settings.gapCm, MIN_GAP_CM), MAX_GAP_CM)
  const answerCardCss = `
.as-head { text-align: center; margin-bottom: 12pt; }
.as-head h1 { margin: 0 0 4pt; font-size: 15pt; }
.as-head p { margin: 0; font-size: 10pt; color: #333; }
.as-fields { display: flex; gap: 14pt; justify-content: center; margin: 10pt 0 14pt; font-size: 10.5pt; }
.as-field { display: flex; align-items: baseline; gap: 4pt; }
.as-line { display: inline-block; min-width: 70pt; border-bottom: 1px solid #000; height: 14pt; }
.as-grid { display: flex; flex-wrap: wrap; gap: 4pt; margin-bottom: 14pt; }
.as-cell { width: 44pt; border: 1px solid #666; text-align: center; font-size: 10pt; line-height: 20pt; }
.as-item { display: flex; gap: 6pt; break-inside: avoid; page-break-inside: avoid; margin-bottom: 6pt; }
.as-no { font-weight: 700; min-width: 18pt; }
.as-box { flex: 1; border: 1px solid #999; border-radius: 2px; }
`
  const cells = entries
    .map((_entry, index) => `<span class="as-cell">${index + 1}</span>`)
    .join('')
  const boxes = entries
    .map(
      (_entry, index) =>
        `<div class="as-item"><span class="as-no">${index + 1}.</span><div class="as-box" style="height:${gap}cm"></div></div>`
    )
    .join('\n')
  const body = `<header class="as-head">
  <h1>${title.replace(/[<>&]/g, '')} · 答题卡</h1>
  <p>共 ${entries.length} 题　满分 ${formatScore(totalScore(entries))} 分</p>
</header>
<div class="as-fields">
  <span class="as-field">姓名<span class="as-line"></span></span>
  <span class="as-field">班级<span class="as-line"></span></span>
  <span class="as-field">学号<span class="as-line"></span></span>
</div>
<div class="as-grid">${cells}</div>
${boxes}`
  return wrapHtmlDocument(`${title}-答题卡`, body, answerCardCss)
}

// ── 与主进程的接缝 ──────────────────────────────────────────────────────────

interface PaperBridge {
  exportPaperPdf?: (payload: {
    html: string
    defaultName: string
    title?: string
    kind?: 'pdf' | 'answer-sheet'
    openAfter?: boolean
  }) => Promise<{ ok: boolean; path?: string; name?: string; error?: string }>
  paperSave?: (payload: {
    markdown: string
    defaultName: string
  }) => Promise<{ ok: boolean; path?: string; name?: string; error?: string }>
  paperExportHistory?: () => Promise<PaperExportRecord[]>
  paperExportHistoryAdd?: (record: {
    kind: 'pdf' | 'docx' | 'answer-sheet'
    name: string
    path?: string
    ok?: boolean
  }) => Promise<PaperExportRecord[]>
  paperExportHistoryClear?: () => Promise<boolean>
  exportDOCX?: (content: string) => Promise<boolean>
}

function bridge(): PaperBridge {
  return (window as unknown as { electronAPI?: PaperBridge }).electronAPI ?? {}
}

const NO_BRIDGE = '当前环境不支持导出（需要桌面版）'

export async function exportPaperPdfFile(input: {
  html: string
  defaultName: string
  kind: 'pdf' | 'answer-sheet'
  openAfter?: boolean
}): Promise<{ ok: boolean; path?: string; name?: string; error?: string }> {
  const api = bridge()
  if (typeof api.exportPaperPdf !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    return await api.exportPaperPdf({
      html: input.html,
      defaultName: input.defaultName,
      kind: input.kind,
      openAfter: input.openAfter,
      title: input.kind === 'answer-sheet' ? '导出答题卡 PDF' : '导出卷面 PDF'
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function savePaperMarkdown(
  markdown: string,
  defaultName: string
): Promise<{ ok: boolean; path?: string; name?: string; error?: string }> {
  const api = bridge()
  if (typeof api.paperSave !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    return await api.paperSave({ markdown, defaultName })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Word 导出走已有的 export-docx（它自己弹保存框），成功后补一条历史 */
export async function exportPaperDocx(markdown: string, defaultName: string): Promise<boolean> {
  const api = bridge()
  if (typeof api.exportDOCX !== 'function') return false
  const ok = await api.exportDOCX(markdown).catch(() => false)
  if (ok) {
    await api.paperExportHistoryAdd?.({ kind: 'docx', name: `${defaultName}.docx`, ok: true }).catch(
      () => undefined
    )
  }
  return ok
}

export async function loadPaperHistory(): Promise<PaperExportRecord[]> {
  const api = bridge()
  if (typeof api.paperExportHistory !== 'function') return []
  try {
    const list = await api.paperExportHistory()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export async function clearPaperHistory(): Promise<boolean> {
  const api = bridge()
  if (typeof api.paperExportHistoryClear !== 'function') return false
  return api.paperExportHistoryClear().catch(() => false)
}

/** 导出结果的错误码 → 人话（CANCELED 由调用方静默） */
export function describePaperError(error?: string): string {
  if (error === 'NO_BRIDGE') return NO_BRIDGE
  if (error === 'EMPTY_PAPER') return '试卷里还没有题目'
  return `导出失败：${error ?? '未知错误'}`
}
