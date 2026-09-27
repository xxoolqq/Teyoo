// 用户偏好设置持久化 —— 主进程单例
// ────────────────────────────────────────────────────────────────────────────
//
// 设计原则：
//   1. 主进程读写，渲染端经 IPC 访问（避免 localStorage 的 origin 隔离与清缓存丢失）
//   2. 与现有 window-state.json / language.json 同级放 app.getPath('userData')
//   3. 同步加载（模块 import 时即完成），异步保存（writeFile best-effort）
//   4. 新增偏好 key 时旧 JSON 缺字段用默认值补齐（向后兼容）
//   5. 不合并现有独立文件（language.json 启动早期就要读，window-state.json
//      生命周期独立），v1 保持不动
//
// 文件结构按偏好面板分组（general / appearance / editor / image / markdown / export），
// 对应 src/renderer/preferences-modal.ts 中的 6 个一级 tab。

import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface UserSetting {
  general: {
    launchOnOpen: 'last' | 'new' | 'folder'
    /** 「打开指定文件夹」选中的目标文件夹绝对路径；'' 表示未指定 */
    launchFolder: string
    autoSaveOnBlur: boolean
    autoSaveIntervalMinutes: number
    defaultEncoding: 'UTF-8' | 'GBK'
    autoCheckUpdate: boolean
    debugMode: boolean
  }
  appearance: {
    windowStyle: 'classic' | 'unified'
    fontSizeMode: 'auto' | 'custom'
    /** 「字体大小 → 自定义」的编辑器正文字号（px）；auto 时忽略 */
    fontSizePx: number
    showStatusBar: boolean
    allowCollapseOutline: boolean
    theme: string
    darkThemeIndependent: boolean
  }
  editor: {
    tabSize: 2 | 4 | 8
    tabBehavior: 'indent' | 'toggle'
  }
  image: {
    /** 备份图片的目标文件夹绝对路径；'' 表示未指定 */
    backupFolder: string
    applyLocal: boolean
    applyRemote: boolean
    escapeUrl: boolean
  }
  markdown: {
    inlineMath: boolean
    subscript: boolean
    superscript: boolean
    highlight: boolean
    diagrams: boolean
    firstLineIndent: boolean
    /** 字下着重号（@.文字.@） */
    emphDot: boolean
    /** 上方汉字拼音（ruby） */
    pinyinRuby: boolean
    /** 同行平级拼音 */
    pinyinInline: boolean
    /** 汉字右上角带圈序号 */
    circledSup: boolean
    /** 汉字田字格 */
    tianziGrid: boolean
    /** 字体大小（{= 12pt : 文字}） */
    fontSpan: boolean
    /** 图片语法扩展（尺寸 / 对齐 / 边框） */
    imageSyntax: boolean
    /** 子块与分栏（@box / @@cols） */
    columns: boolean
    latexEngine: 'katex' | 'mathjax'
    // 行内公式图片处理：ocr=请求 OCR 接口转为 LaTeX；keep=保留原图片
    imageFormula: 'ocr' | 'keep'
  }
  export: {
    formulaEngine: 'Temml' | 'MathJax'
  }
}

const DEFAULT_SETTING: UserSetting = {
  general: {
    launchOnOpen: 'last',
    launchFolder: '',
    autoSaveOnBlur: true,
    // 0 = 不自动保存；1–5 为分钟数
    autoSaveIntervalMinutes: 0,
    defaultEncoding: 'UTF-8',
    autoCheckUpdate: true,
    debugMode: false,
  },
  appearance: {
    windowStyle: 'classic',
    fontSizeMode: 'auto',
    fontSizePx: 16,
    showStatusBar: true,
    // 默认禁止：未勾选时「显示 / 隐藏文件列表」按钮与 ⌘\ 不可用
    allowCollapseOutline: false,
    theme: 'Github',
    darkThemeIndependent: false,
  },
  editor: {
    tabSize: 4,
    tabBehavior: 'indent',
  },
  image: {
    backupFolder: '',
    applyLocal: true,
    applyRemote: true,
    escapeUrl: true,
  },
  markdown: {
    inlineMath: true,
    subscript: true,
    superscript: true,
    highlight: true,
    diagrams: true,
    firstLineIndent: true,
    emphDot: true,
    pinyinRuby: true,
    pinyinInline: true,
    circledSup: true,
    tianziGrid: true,
    fontSpan: true,
    imageSyntax: true,
    columns: true,
    latexEngine: 'mathjax',
    imageFormula: 'keep'
  },
  export: {
    formulaEngine: 'MathJax'
  },
}

const userSettingPath = join(app.getPath('userData'), 'userSetting.json')

// 只保留 DEFAULT_SETTING 里存在的字段：缺失的补默认值，已移除的设置项
// （如 appearance.readingSpeed、editor.typewriterMode）在读取时被丢弃，
// userSetting.json 下一次写盘即随之自净。
function pruneToDefaults<T>(target: T, source: unknown): T {
  if (source == null || typeof source !== 'object' || Array.isArray(source)) {
    return structuredClone(target)
  }
  const src = source as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, targetVal] of Object.entries(target as Record<string, unknown>)) {
    if (!(k in src)) {
      out[k] = targetVal
      continue
    }
    out[k] = (typeof targetVal === 'object' && targetVal !== null && !Array.isArray(targetVal))
      ? pruneToDefaults(targetVal, src[k])
      : src[k]
  }
  return out as T
}

function loadUserSetting(): UserSetting {
  try {
    const raw = readFileSync(userSettingPath, 'utf-8')
    const parsed = JSON.parse(raw)
    const merged = pruneToDefaults(DEFAULT_SETTING, parsed)
    // 旧文件含已废弃字段 → 排一次写盘把清理结果落定
    if (JSON.stringify(merged) !== JSON.stringify(parsed)) scheduleSave()
    return merged
  } catch {
    // 首次启动 / 文件损坏 / 权限不足 → 用默认值
    return structuredClone(DEFAULT_SETTING)
  }
}

let _setting: UserSetting | null = null
function getSetting(): UserSetting {
  if (!_setting) _setting = loadUserSetting()
  return _setting
}

// 延迟保存：同一 tick 内多次 set 合并成一次 writeFile
let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    if (!_setting) return
    try {
      await mkdir(dirname(userSettingPath), { recursive: true })
      await writeFile(userSettingPath, JSON.stringify(_setting, null, 2), 'utf-8')
    } catch { /* best-effort，写不进去静默 */ }
  }, 50)
}

// ─── 对外 API ───────────────────────────────────────────────────────────────

/** 启动时调用一次，触发同步加载（模块 import 会惰性调用，这里强制一下） */
export function initUserSetting(): void {
  getSetting()
}

/** 取全量偏好快照（值拷贝，调用方不得直接改） */
export function getUserSetting(): UserSetting {
  return structuredClone(getSetting())
}

/** 按点号路径取值（如 'markdown.latexEngine'）；缺值则返回 undefined */
export function getUserSettingByPath<T = unknown>(path: string): T | undefined {
  const parts = path.split('.')
  let cur: unknown = getSetting()
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur as T
}

/**
 * 设值并异步持久化，同时广播给所有渲染窗口（多窗口同步）。
 * path 格式：'markdown.latexEngine' 这类点号路径，至少一段。
 * 返回是否成功（路径非法等情况返回 false 但不抛）。
 */
export function setUserSetting(path: string, value: unknown): boolean {
  const parts = path.split('.')
  if (parts.length < 1) return false
  const root = getSetting() as unknown as Record<string, unknown>
  let cur: Record<string, unknown> = root
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]]
    if (next == null || typeof next !== 'object') return false
    cur = next as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
  scheduleSave()

  // 广播给所有渲染窗口
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents) {
      win.webContents.send('preferences-changed', { key: path, value })
    }
  }
  return true
}

/**
 * 批量设值（渲染端一次改多个控件时减少 IPC 次数）。
 * changes 的 key 是点号路径。
 */
export function setUserSettingBatch(changes: Record<string, unknown>): void {
  const root = getSetting() as unknown as Record<string, unknown>
  for (const [path, value] of Object.entries(changes)) {
    const parts = path.split('.')
    if (parts.length < 1) continue
    let cur: Record<string, unknown> = root
    for (let i = 0; i < parts.length - 1; i++) {
      const next = cur[parts[i]]
      if (next == null || typeof next !== 'object') continue
      cur = next as Record<string, unknown>
    }
    cur[parts[parts.length - 1]] = value
  }
  scheduleSave()

  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents) {
      win.webContents.send('preferences-batch-changed', { changes })
    }
  }
}
