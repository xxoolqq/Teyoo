import type { MathEngine, MathEngineId } from './types'
import { katexEngine } from './katex-engine'
import { mathjaxEngine } from './mathjax-engine'

// 数学引擎注册表 —— 引擎切换的中枢
// ────────────────────────────────────────────────────────────────────────────
// - 引擎在模块加载时注册（katex / mathjax），后续新引擎在此追加
// - 当前引擎 id 持久化在 localStorage（colamd-latex-engine）
// - 切换时同步通知所有监听者（nodeView 据此立即重渲染）

export const MATH_ENGINE_STORAGE_KEY = 'colamd-latex-engine'

const engines = new Map<MathEngineId, MathEngine>()
const listeners = new Set<(id: MathEngineId) => void>()

export function registerMathEngine(engine: MathEngine): void {
  engines.set(engine.id, engine)
}

registerMathEngine(katexEngine)
registerMathEngine(mathjaxEngine)

function normalizeEngineId(raw: string | null): MathEngineId | null {
  return raw === 'katex' || raw === 'mathjax' ? raw : null
}

function loadInitialEngineId(): MathEngineId {
  try {
    return normalizeEngineId(localStorage.getItem(MATH_ENGINE_STORAGE_KEY)) ?? 'katex'
  } catch {
    return 'katex'
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

/** 切换引擎：持久化 + 立即通知所有监听者（nodeView 重渲染） */
export function setMathEngine(id: MathEngineId): void {
  if (!engines.has(id) || id === activeEngineId) return
  activeEngineId = id
  try {
    localStorage.setItem(MATH_ENGINE_STORAGE_KEY, id)
  } catch { /* localStorage 不可用时仅内存态生效 */ }
  for (const notify of listeners) notify(id)
}

/** 订阅引擎切换；返回取消订阅函数 */
export function onMathEngineChange(listener: (id: MathEngineId) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 用当前引擎渲染公式（nodeView 调用入口） */
export function renderMath(latex: string, displayMode: boolean): HTMLElement {
  const engine = engines.get(activeEngineId) ?? engines.get('katex')!
  return engine.render(latex, displayMode)
}
