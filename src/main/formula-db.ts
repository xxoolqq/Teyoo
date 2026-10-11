// ─── 公式识别历史（SQLite）────────────────────────────────────────────────
//
// 为什么是 SQLite 而不是 JSON 文件：手写板是「边写边识别」，结果每 700ms 就来
// 一次，JSON 得整份读改写，SQLite 是增量写；顺手还能做「与上一条相同就别再
// 插」的去重，以及按时间倒序翻历史 —— 这些正是它天然会做的事。
//
// 为什么放在主进程：better-sqlite3 是原生模块（prebuilds/win32-x64.node），
// 只能在 Node 环境里 require。识别本身也在主进程跑（见 texo-ocr.ts），所以
// 落库就在 texo-recognize 那个 handler 里顺手完成，不必再传一次 IPC。
//
// 库文件在 userData 下（各平台的用户数据目录），与 userSetting.json 同级。

import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

type DB = Database.Database

/** 最多留多少条：超了删最老的，免得库跟着使用时长无限涨 */
const MAX_ROWS = 500
/** 图片超过这个体积就只存 LaTeX 不存图：一张图不该把库撑爆 */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024

let db: DB | null = null
let openFailed = false

function open(): DB | null {
  if (db) return db
  // 打不开过一次就不再反复试（每次识别都试会拖慢识别）
  if (openFailed) return null
  try {
    const handle = new Database(join(app.getPath('userData'), 'formula-history.db'))
    handle.pragma('journal_mode = WAL')
    handle.exec(`
      CREATE TABLE IF NOT EXISTS formula_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        latex TEXT NOT NULL,
        source TEXT,
        image BLOB,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_formula_history_created_at
        ON formula_history (created_at DESC);
    `)
    db = handle
    return db
  } catch {
    openFailed = true
    return null
  }
}

/** data URL → 图片字节；不是 base64 图片或体积超限就返回 null（只存 LaTeX） */
function imageBytes(dataUrl: string | null): Buffer | null {
  if (!dataUrl) return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) return null
  try {
    const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64')
    return buffer.byteLength > IMAGE_MAX_BYTES ? null : buffer
  } catch {
    return null
  }
}

/**
 * 识别成功后落一条。
 *
 * 连着认出同一个公式（自动识别会反复触发）只刷新时间、不重复插 —— 否则
 * 写一会儿公式就能攒出上百条一模一样的记录，历史没法看。
 *
 * 任何失败都吞掉：历史是附赠品，不该让识别失败或打断用户。
 */
export function saveFormulaRecord(latex: string, source: string | null, dataUrl: string | null = null): void {
  const text = latex.trim()
  if (!text) return
  const handle = open()
  if (!handle) return
  try {
    const now = Date.now()
    const last = handle
      .prepare('SELECT id, latex FROM formula_history ORDER BY id DESC LIMIT 1')
      .get() as { id: number; latex: string } | undefined
    if (last && last.latex === text) {
      handle.prepare('UPDATE formula_history SET created_at = ?, source = ? WHERE id = ?').run(now, source, last.id)
      return
    }
    handle
      .prepare('INSERT INTO formula_history (latex, source, image, created_at) VALUES (?, ?, ?, ?)')
      .run(text, source, imageBytes(dataUrl), now)
    // 超上限就留最近的那批
    handle
      .prepare(
        'DELETE FROM formula_history WHERE id NOT IN (SELECT id FROM formula_history ORDER BY id DESC LIMIT ?)'
      )
      .run(MAX_ROWS)
  } catch {
    /* 落库失败不影响识别结果 */
  }
}
