// 智能组卷：卷面 PDF 导出 + 导出历史。
//
// 为什么不复用 export-pdf：那条通道打的是「当前 webContents」，后台管理页打出来
// 就是后台界面本身。卷面必须单独渲染 —— 把渲染端拼好的 HTML 写进临时文件，塞进
// 一个 show:false 的窗口打印，打完即销毁，临时文件也删掉。
//
// 卷面 HTML 里不放任何外部资源（公式由 KaTeX 出 MathML、字体用系统字体），所以
// 隐藏窗口不需要联网、也不需要放开 webSecurity：临时文件是 file://，题干里的
// file:// 插图在 file:// 页面里本来就允许加载。
import { app, BrowserWindow, dialog, shell } from 'electron'
import { writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'

/** 与「导出 PDF」同一套纸面参数：A4、零边距（边距交给卷面自己的 @page） */
const PRINT_OPTIONS = {
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
  printBackground: true,
  pageSize: 'A4'
} as const

export type PaperExportKind = 'pdf' | 'docx' | 'answer-sheet'

/** 「最近导出预览」里的一行。name 是写出去的文件名（不含目录） */
export interface PaperExportRecord {
  id: string
  kind: PaperExportKind
  name: string
  path: string | null
  at: number
  ok: boolean
  error?: string
}

/** 截图上的「保留最近 5 次」 */
const HISTORY_MAX = 5

function historyPath(): string {
  return join(app.getPath('userData'), 'paper-export-history.json')
}

/** 历史是附赠品：读坏了当空、写不进也不该打断导出 */
export function readPaperExportHistory(): PaperExportRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(), 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is PaperExportRecord => {
      return !!item && typeof item === 'object' && typeof (item as PaperExportRecord).name === 'string'
    })
  } catch {
    return []
  }
}

export function pushPaperExport(record: PaperExportRecord): PaperExportRecord[] {
  const next = [record, ...readPaperExportHistory().filter((item) => item.id !== record.id)]
    .slice(0, HISTORY_MAX)
  try {
    writeFileSync(historyPath(), JSON.stringify(next), 'utf-8')
  } catch {
    /* 写不进去就算了 */
  }
  return next
}

/** 把一次导出结果记进历史（成功/失败都记：截图里的 xxx-passed 就是成功那类） */
export function recordPaperExport(
  kind: PaperExportKind,
  result: { ok: boolean; path?: string; name?: string; error?: string }
): PaperExportRecord[] {
  return pushPaperExport({
    id: randomUUID(),
    kind,
    name: result.name ?? '（未保存）',
    path: result.path ?? null,
    at: Date.now(),
    ok: result.ok,
    error: result.error
  })
}

export function clearPaperExportHistory(): boolean {
  try {
    writeFileSync(historyPath(), '[]', 'utf-8')
    return true
  } catch {
    return false
  }
}

function defaultNameWithExt(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`
}

/**
 * 卷面 HTML → PDF。
 *
 * 返回写成功的路径与文件名，供「最近导出预览」记一行；用户取消返回 CANCELED，
 * 调用方据此不要弹失败提示。
 */
export async function exportPaperPdf(
  input: { html: string; defaultName: string; title: string; openAfter?: boolean },
  parent: BrowserWindow | null
): Promise<{ ok: boolean; path?: string; name?: string; error?: string }> {
  const suggested = defaultNameWithExt(input.defaultName || '试卷', 'pdf')
  const options: Electron.SaveDialogOptions = {
    title: input.title,
    buttonLabel: '导出',
    nameFieldLabel: '文件名：',
    defaultPath: join(app.getPath('documents'), suggested),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  }
  const picked = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return { ok: false, error: 'CANCELED' }

  const tempHtml = join(app.getPath('temp'), `teyoo-paper-${randomUUID()}.html`)
  let printer: BrowserWindow | null = null
  try {
    await writeFile(tempHtml, input.html, 'utf-8')
    printer = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        // 卷面是纯静态 HTML（公式已由 KaTeX 输出 MathML），不需要脚本
        javascript: false
      }
    })
    await printer.loadFile(tempHtml)
    const data = await printer.webContents.printToPDF(PRINT_OPTIONS)
    await writeFile(picked.filePath, data)
    // 「PDF 预览」用这一条路：生成完直接交给系统 PDF 阅读器打开
    if (input.openAfter) await shell.openPath(picked.filePath).catch(() => undefined)
    return { ok: true, path: picked.filePath, name: picked.filePath.split(/[\\/]/).pop() ?? suggested }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (printer && !printer.isDestroyed()) printer.destroy()
    await rm(tempHtml, { force: true }).catch(() => undefined)
  }
}
