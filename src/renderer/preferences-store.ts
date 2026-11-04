// 用户偏好设置 —— 渲染端轻量 store
// ────────────────────────────────────────────────────────────────────────────
//
// 职责：
//   1. 启动时从主进程拉全量偏好 + 迁移 localStorage 旧 key（teyoo-latex-engine
//      → markdown.latexEngine, teyoo-export-formula-engine → export.formulaEngine）
//   2. get(keyPath) / set(keyPath, value) 封装点号路径读写；set 同时写主进程
//   3. 订阅主进程 preferences-changed 多窗口同步
//   4. 提供 markdown.latexEngine 的 localStorage 兼容层（math-engine/registry.ts
//      当前用 localStorage，这里 get/set 都走主进程 JSON，内部同时维护旧 key
//      读写接口，减少跨模块改动）
//
// 与 math-engine/registry.ts 的关系：
//   registry.ts 的 setMathEngine / getActiveMathEngineId 已接到此 store
//   （见 patch-math-engine 分支），调用 set 即同时写主进程 JSON。
//
// 典型用法：
//   import { prefsStore } from './preferences-store'
//   await prefsStore.init()
//   const latexEngine = prefsStore.get<string>('markdown.latexEngine')
//   prefsStore.set('markdown.latexEngine', 'mathjax')

// localStorage 旧 key（迁移用）
const LS_LATEX_ENGINE_KEY = 'teyoo-latex-engine'
const LS_EXPORT_FORMULA_ENGINE_KEY = 'teyoo-export-formula-engine'

// 渲染端快照（从主进程拉取后本地缓存，get 走快照，set 走主进程+快照）
type SettingSnapshot = Record<string, unknown>
let snapshot: SettingSnapshot | null = null
let initPromise: Promise<void> | null = null

// 点号路径读取
export function getPrefsPath<T = unknown>(path: string): T | undefined {
  if (!snapshot) return undefined
  const parts = path.split('.')
  let cur: unknown = snapshot
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur as T
}

// 点号路径写入（改快照 + 经 IPC 写主进程）
export async function setPrefsPath(path: string, value: unknown): Promise<void> {
  // 1. 改本地快照
  if (snapshot) {
    const parts = path.split('.')
    let cur: Record<string, unknown> = snapshot
    for (let i = 0; i < parts.length - 1; i++) {
      const next = cur[parts[i]]
      if (next == null || typeof next !== 'object') return // 路径非法
      cur = next as Record<string, unknown>
    }
    cur[parts[parts.length - 1]] = value
  }
  // 2. 写主进程（best-effort，不 await 失败静默）
  try {
    const api = (window as unknown as { electronAPI?: { setPreference?: (k: string, v: unknown) => Promise<boolean> } })
      .electronAPI
    await api?.setPreference?.(path, value)
  } catch { /* ignore */ }
}

// 批量设置（改快照 + 一次 IPC）
export async function setPrefsBatch(changes: Record<string, unknown>): Promise<void> {
  if (snapshot) {
    for (const [path, value] of Object.entries(changes)) {
      const parts = path.split('.')
      let cur: Record<string, unknown> = snapshot
      for (let i = 0; i < parts.length - 1; i++) {
        const next = cur[parts[i]]
        if (next == null || typeof next !== 'object') continue
        cur = next as Record<string, unknown>
      }
      cur[parts[parts.length - 1]] = value
    }
  }
  try {
    const api = (window as unknown as { electronAPI?: { setPreferencesBatch?: (c: Record<string, unknown>) => Promise<boolean> } })
      .electronAPI
    await api?.setPreferencesBatch?.(changes)
  } catch { /* ignore */ }
}

// 订阅偏好变化（多窗口同步 + 主进程广播）
export function onPrefsChanged(callback: (key: string, value: unknown) => void): () => void {
  const api = (window as unknown as {
    electronAPI?: {
      onPreferencesChanged?: (cb: (payload: { key: string; value: unknown }) => void) => void
    }
  }).electronAPI
  if (!api?.onPreferencesChanged) return () => {}
  const handler = (payload: { key: string; value: unknown }) => {
    // 同步更新快照
    if (snapshot) {
      const parts = payload.key.split('.')
      let cur: Record<string, unknown> = snapshot
      for (let i = 0; i < parts.length - 1; i++) {
        const next = cur[parts[i]]
        if (next == null || typeof next !== 'object') return
        cur = next as Record<string, unknown>
      }
      cur[parts[parts.length - 1]] = payload.value
    }
    callback(payload.key, payload.value)
  }
  api.onPreferencesChanged(handler)
  return () => { /* preload API 无卸载接口，靠主进程重新 buildMenu 自动替换 listener */ }
}

// ─── localStorage 旧 key 迁移 ─────────────────────────────────────────────

function migrateLocalStorageToSnapshot(): void {
  if (!snapshot) return
  // latex 引擎
  const lsLatex = localStorage.getItem(LS_LATEX_ENGINE_KEY)
  if (lsLatex && !getPrefsPath<string>('markdown.latexEngine')) {
    setInSnapshot('markdown.latexEngine', lsLatex as 'katex' | 'mathjax')
    try { localStorage.removeItem(LS_LATEX_ENGINE_KEY) } catch { /* ignore */ }
  }
  // 导出公式引擎
  const lsExport = localStorage.getItem(LS_EXPORT_FORMULA_ENGINE_KEY)
  if (lsExport && !getPrefsPath<string>('export.formulaEngine')) {
    setInSnapshot('export.formulaEngine', lsExport as 'Temml' | 'MathJax')
    try { localStorage.removeItem(LS_EXPORT_FORMULA_ENGINE_KEY) } catch { /* ignore */ }
  }
}

function setInSnapshot(path: string, value: unknown): void {
  if (!snapshot) return
  const parts = path.split('.')
  let cur: Record<string, unknown> = snapshot
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]]
    if (next == null || typeof next !== 'object') return
    cur = next as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

// ─── 启动初始化 ────────────────────────────────────────────────────────────

export async function initPrefsStore(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const api = (window as unknown as {
      electronAPI?: { getPreferences?: () => Promise<Record<string, unknown>> }
    }).electronAPI
    if (api?.getPreferences) {
      try {
        snapshot = await api.getPreferences()
      } catch {
        snapshot = {}
      }
    } else {
      snapshot = {}
    }
    migrateLocalStorageToSnapshot()
    // 迁移后立即把缺失字段写回主进程，保证后续重启不再走迁移
    const changes: Record<string, unknown> = {}
    const latexFromLS = localStorage.getItem(LS_LATEX_ENGINE_KEY)
    if (latexFromLS) {
      changes['markdown.latexEngine'] = latexFromLS
      try { localStorage.removeItem(LS_LATEX_ENGINE_KEY) } catch { /* ignore */ }
    }
    const exportFromLS = localStorage.getItem(LS_EXPORT_FORMULA_ENGINE_KEY)
    if (exportFromLS) {
      changes['export.formulaEngine'] = exportFromLS
      try { localStorage.removeItem(LS_EXPORT_FORMULA_ENGINE_KEY) } catch { /* ignore */ }
    }
    if (Object.keys(changes).length > 0) {
      await setPrefsBatch(changes)
    }
  })()
  return initPromise
}

// ─── 同步便捷访问（启动完成后可用） ─────────────────────────────────────────

export function isPrefsReady(): boolean { return snapshot != null }

/** 同步取值（需先 await initPrefsStore） */
export function getPrefs<T = unknown>(path: string): T | undefined {
  return getPrefsPath<T>(path)
}
