import type { MathEngine, MathEngineId } from './types'
import { katexEngine } from './katex-engine'
import { mathjaxEngine } from './mathjax-engine'
import { getPrefs, setPrefsPath } from '../preferences-store'

// 数学引擎注册表 —— 引擎切换的中枢
// ────────────────────────────────────────────────────────────────────────────
// - 引擎在模块加载时注册（katex / mathjax），后续新引擎在此追加
// - 当前引擎 id 持久化：主进程 userSetting.json（markdown.latexEngine）；
//   兼容期仍写 localStorage 'colamd-latex-engine'，prefs-store 启动时会
//   自动迁移到主进程 JSON 并清掉旧 key，之后不再写。
// - 切换时同步通知所有监听者（nodeView 据此立即重渲染）

// 兼容期旧 localStorage key（preferences-store 启动时迁移）
const LEGACY_LS_KEY = 'colamd-latex-engine'
const PREFS_PATH = 'markdown.latexEngine'

const engines = new Map<MathEngineId, MathEngine>()
const listeners = new Set<(id: MathEngineId) => void>()

export function registerMathEngine(engine: MathEngine): void {
  engines.set(engine.id, engine)
}

registerMathEngine(katexEngine)
registerMathEngine(mathjaxEngine)

function normalizeEngineId(raw: string | null | undefined): MathEngineId | null {
  return raw === 'katex' || raw === 'mathjax' ? raw : null
}

function loadInitialEngineId(): MathEngineId {
  // 优先从 prefs-store（主进程 JSON）读；store 未就绪时回退 localStorage
  const fromStore = normalizeEngineId(getPrefs<string>(PREFS_PATH))
  if (fromStore) return fromStore
  try {
    return normalizeEngineId(localStorage.getItem(LEGACY_LS_KEY)) ?? 'mathjax'
  } catch {
    return 'mathjax'
  }
}

let activeEngineId: MathEngineId = loadInitialEngineId()

export function getMathEngine(id: MathEngineId): MathEngine | undefined {
  return engines.get(id)
}

export function listMathEngines(): MathEngine[] {
  return [...engines.values()]
}

export function getActiveMathEngineId(): MathEngineId {
  return activeEngineId
}

/** 切换引擎：持久化到主进程 JSON + 立即通知所有监听者（nodeView 重渲染） */
export function setMathEngine(id: MathEngineId): void {
  if (!engines.has(id) || id === activeEngineId) return
  activeEngineId = id
  // 写主进程偏好（异步，不阻塞）；写失败静默
  void setPrefsPath(PREFS_PATH, id)
  for (const notify of listeners) notify(id)
}

/** 订阅引擎切换；返回取消订阅函数 */
export function onMathEngineChange(listener: (id: MathEngineId) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 用当前引擎渲染公式（nodeView 调用入口） */
export function renderMath(latex: string, displayMode: boolean): HTMLElement {
  const engine = engines.get(activeEngineId) ?? engines.get('mathjax')!
  return engine.render(latex, displayMode)
}
