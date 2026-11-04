import type { MathEngine, MathEngineId } from './types'
import { katexEngine } from './katex-engine'
import { mathjaxEngine } from './mathjax-engine'
import { getPrefs, setPrefsPath } from '../preferences-store'

// 数学引擎注册表 —— 引擎切换的中枢
// ────────────────────────────────────────────────────────────────────────────
// - 引擎在模块加载时注册（katex / mathjax），后续新引擎在此追加
// - 当前引擎 id 持久化：主进程 userSetting.json（markdown.latexEngine）；
//   兼容期仍写 localStorage 'teyoo-latex-engine'，prefs-store 启动时会
//   自动迁移到主进程 JSON 并清掉旧 key，之后不再写。
// - 切换时同步通知所有监听者（nodeView 据此立即重渲染）

// 兼容期旧 localStorage key（preferences-store 启动时迁移）
const LEGACY_LS_KEY = 'teyoo-latex-engine'
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

/**
 * 中日韩字符与全角标点。**TeX 字体里没有这些字形**，MathJax 的 SVG 输出会把它们
 * 当"未知字形"处理：宽度要靠 `CommonOutputJax.getMetrics()` 在**真实文档里**量出来，
 * 而我们是 `doc.convert()` 脱离文档渲染的 —— 量不到宽度就算 0，相邻汉字全部落在
 * 同一个 x 上。真机实测 `V_{锥体}=\frac{1}{3}Sh`：`<text>锥` 与 `<text>体` 的
 * x 都是 0（两个汉字完全叠在一起），而同一个元素放进 DOM 量出来是有宽度的。
 * 注意写成 `V_{\text{锥体}}` **一样坏**（同样走未知字形那条路），别指望能绕开。
 *
 * 所以：MathJax 引擎下遇到 CJK 就改用 KaTeX —— 它用 HTML/CSS 盒子排版，宽度就是
 * 浏览器真实字形宽度，中文天然正确；两个引擎的字体本来都是 Computer Modern 系，
 * 同一篇文档里混用看不出差别。
 */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 用当前引擎渲染公式（nodeView 调用入口） */
export function renderMath(latex: string, displayMode: boolean): HTMLElement {
  const engine = engines.get(activeEngineId) ?? engines.get('mathjax')!
  if (engine.id === 'mathjax' && CJK_RE.test(latex)) {
    const katex = engines.get('katex')
    if (katex) return katex.render(latex, displayMode)
  }
  return engine.render(latex, displayMode)
}
