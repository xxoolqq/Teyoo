// 公式锁定协议 —— 把试卷里的 $…$ / $$…$$ 换成可寻址的占位标签，模型只许原位引用。
// ────────────────────────────────────────────────────────────────────────────
//
// 为什么必须锁：
//   不锁的时候，模型会在「顺手整理公式」这件事上做无穷无尽的破坏 ——
//   `\geqslant` 被改成 `>=`、`\dfrac` 被拍平成 `a/b`、`\left(\right)` 被删、
//   矩阵环境被重排、甚至整段公式被「化简」。而这些都发生在**转录**阶段，
//   任何一个字符漂移都会让题目变成另一道题，且无从校对。
//
// 协议：
//   发出去   `$\dfrac{x^2}{a^2}=1$`
//      →     `<mathbank-math id="MBM_4123cc6aa6e0494a_0001">\dfrac{x^2}{a^2}=1</mathbank-math>`
//   模型回来 `$[[MBM_4123cc6aa6e0494a_0001]]$`（或裸引用）
//      →     还原成 `$\dfrac{x^2}{a^2}=1$`（原样，逐字未改）
//
// 还原要容忍模型多包一层定界符：协议里明确禁止 `$[[id]]$`，但实测模型多半照写，
// 所以把引用**连同紧邻的定界符**一起吃掉再放回原文 —— 否则会出现 `$$…$$` 套娃。
//
// 这里的 ID 由内容哈希派生，同一份试卷每次解析得到同一串 ID：便于比对两次解析的
// 差异（哪些公式被引用、哪些被漏掉），也让「同一公式在两道题里各引用一次」这种
// 情况在日志里一眼能看出来。

export type FormulaKind = 'inline' | 'block'

export interface LockedFormula {
  id: string
  /** 原始片段，含定界符（`$…$` / `$$…$$`）—— 还原时原样放回 */
  raw: string
  /** 定界符内的纯 LaTeX */
  latex: string
  kind: FormulaKind
  /** 在原文中的字符偏移（排查「公式跑到了别处」时用） */
  offset: number
}

export interface LockResult {
  text: string
  formulas: LockedFormula[]
}

export interface RestoreResult {
  text: string
  /** 本次文本里实际引用到的 ID（按出现顺序，可重复） */
  referenced: string[]
  /** 引用了但不在锁定表里的 ID（模型自己编的 / 拼错的） */
  unknown: string[]
  /**
   * 模型没写 `[[ID]]`、而是照抄了整段标签、且改写了标签内公式的 ID。
   * 本地已强制换回原文（逐字），这里只用于计数与日志。
   */
  overwritten: string[]
}

/** 占位标签名与 MathBank 保持一致，方便拿两边的输出直接对比 */
const TAG_NAME = 'mathbank-math'
const ID_PREFIX = 'MBM'

interface Span {
  start: number
  end: number
  inner: string
  kind: FormulaKind
}

/** FNV-1a 32 位 ×2，拼成 16 位十六进制：够当文档指纹，且不引入 crypto 依赖 */
function documentSeed(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + c) >>> 0
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
    h2 ^= h2 >>> 13
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16)
}

/**
 * 扫出所有数学片段。
 *
 * 手写扫描而不是 regex：`$` 的配对规则依赖上下文（`\$` 是字面量、`$$` 是块级、
 * 行内公式不跨行），一条正则表达不出来；写成状态机反而短。
 */
function findSpans(text: string): Span[] {
  const spans: Span[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    // 反斜杠转义：`\$` 是美元符号本身，不能当成定界符
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch !== '$') {
      i++
      continue
    }
    const block = text[i + 1] === '$'
    const openLen = block ? 2 : 1
    const from = i + openLen
    let j = from
    let closeAt = -1
    while (j < text.length) {
      const c = text[j]
      if (c === '\\') {
        j += 2
        continue
      }
      if (!block && c === '\n') break // 行内公式不跨行：跨行说明是孤立的 $
      if (block) {
        if (text.startsWith('$$', j)) {
          closeAt = j
          break
        }
      } else if (c === '$') {
        closeAt = j
        break
      }
      j++
    }
    // 没闭合：这个 $ 只是普通字符（价格、占位符），跳过它继续扫
    if (closeAt < 0) {
      i++
      continue
    }
    const inner = text.slice(from, closeAt)
    const end = closeAt + openLen
    if (inner.trim()) {
      spans.push({ start: i, end, inner, kind: block ? 'block' : 'inline' })
    }
    i = end
  }
  return spans
}

/**
 * 锁公式。
 *
 * @param markdown 已清洗的试卷 Markdown（docx 提取或粘贴的 tex/md）
 * @param seed     可选，指定 ID 前缀；默认按内容哈希
 */
export function lockVisibleMath(markdown: string, seed?: string): LockResult {
  const spans = findSpans(markdown)
  if (spans.length === 0) return { text: markdown, formulas: [] }

  const prefix = `${ID_PREFIX}_${seed ?? documentSeed(markdown)}_`
  const formulas: LockedFormula[] = []
  const parts: string[] = []
  let cursor = 0
  let seq = 0

  for (const span of spans) {
    seq += 1
    const id = `${prefix}${String(seq).padStart(4, '0')}`
    const raw = markdown.slice(span.start, span.end)
    formulas.push({ id, raw, latex: span.inner.trim(), kind: span.kind, offset: span.start })
    parts.push(markdown.slice(cursor, span.start))
    // 标签内保留纯 LaTeX：模型需要看懂公式才能分类，所以不能换成无意义的编号
    parts.push(`<${TAG_NAME} id="${id}">${span.inner.trim()}</${TAG_NAME}>`)
    cursor = span.end
  }
  parts.push(markdown.slice(cursor))
  return { text: parts.join(''), formulas }
}

interface RefTally {
  referenced: string[]
  unknown: string[]
  overwritten: string[]
}

/**
 * 还原引用。照 MathBank 的 `_restore_lock_in_text` 认三类写法：
 *
 *   ① `$[[ID]]$` / `$$[[ID]]$$` —— 连同外层定界符一起换掉，否则会 `$$…$$` 套娃；
 *   ② `<mathbank-math id="ID">…</mathbank-math>` —— 模型照抄标签。早期只认
 *      `[[ID]]`，这种输出会把整段标签原样带进题库；标签内被改写也强制换回原文；
 *   ③ 裸 `[[ID]]` 与裸 `MBM_…` —— 模型漏写括号时兜住。
 *
 * 引用了不存在的 ID 时**原样保留**：那是模型编的编号，抹掉会让题干缺一块，
 * 留着才能让校对者看见「这里模型给了个野 ID」。
 */
export function restoreLockedMath(
  text: string,
  formulas: readonly LockedFormula[]
): RestoreResult {
  const tally: RefTally = { referenced: [], unknown: [], overwritten: [] }
  if (!text) return { text: '', ...tally }

  if (formulas.length === 0) {
    // 没锁过也要扫一遍，好让调用方知道模型是不是凭空造了 ID
    const probe = /\[\[\s*([A-Za-z0-9_:-]+)\s*\]\]/g
    let m: RegExpExecArray | null
    while ((m = probe.exec(text)) !== null) {
      tally.referenced.push(m[1])
      tally.unknown.push(m[1])
    }
    return { text, ...tally }
  }

  const byId = new Map(formulas.map((f) => [f.id, f]))

  /** 命中返回原始片段（含定界符）；未命中返回 null，调用方保留模型原文 */
  const take = (id: string, tagInner?: string): string | null => {
    tally.referenced.push(id)
    const hit = byId.get(id)
    if (!hit) {
      tally.unknown.push(id)
      return null
    }
    // 标签内是纯 LaTeX（锁定前 trim 过）；与 latex 不一致 = 模型改写过公式
    if (tagInner !== undefined && tagInner.trim() !== hit.latex) tally.overwritten.push(id)
    return hit.raw
  }

  let out = text

  // ① 被 $…$ 包住的标签：整体替换，别把外层定界符留在原地。
  //   前后的 `(?<!\$)` / `(?!\$)` 是必须的：`$$…$` 这类混写只许换 token，
  //   不许把外层拆走一个 $ ——拆了就得到 `$$$…` 这种不成对的定界符。
  out = out.replace(
    /(?<!\$)(\${1,2})[ \t]*(<mathbank-math\b[^>]*\bid\s*=\s*(["'])([^"']+)\3[^>]*>([\s\S]*?)<\/mathbank-math\s*>)[ \t]*\1(?!\$)/gi,
    (whole: string, _d: string, _tag: string, _q: string, id: string, inner: string) =>
      take(id, inner) ?? whole
  )

  // ② 裸标签（模型照抄了送进去的那一段）
  out = out.replace(
    /<mathbank-math\b[^>]*\bid\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/mathbank-math\s*>/gi,
    (whole: string, _q: string, id: string, inner: string) => take(id, inner) ?? whole
  )

  // ③ $[[ID]]$ / $$[[ID]]$$：前后定界符必须等长且不与其他 $ 相邻，
  //   混写（`$$[[ID]]$`）时退化成 ④ 的裸 token 替换，外壳一个都不动
  out = out.replace(
    /(?<!\$)(\${1,2})[ \t]*\[\[\s*([A-Za-z0-9_:-]+)\s*\]\][ \t]*\1(?!\$)/g,
    (whole: string, _d: string, id: string) => take(id) ?? whole
  )

  // ④ 裸 [[ID]]
  out = out.replace(/\[\[\s*([A-Za-z0-9_:-]+)\s*\]\]/g, (whole: string, id: string) =>
    take(id) ?? whole
  )

  // ⑤ 裸 ID：只换锁定表里存在的，正文里偶然出现的同类字符串一律不碰
  out = out.replace(/\bMBM_[A-Za-z0-9_:-]+/g, (whole: string) =>
    byId.has(whole) ? take(whole) ?? whole : whole
  )

  return { text: out, ...tally }
}

/**
 * 锁定结果的自检：给调用方判断「输入是不是根本没公式」。
 * 纯文字卷（无公式）不锁也不算失败，但日志里要能看出来。
 */
export function summarizeLock(result: LockResult): string {
  const inline = result.formulas.filter((f) => f.kind === 'inline').length
  const block = result.formulas.length - inline
  return `锁定公式 ${result.formulas.length} 处（行内 ${inline} / 块级 ${block}）`
}

export interface LockIntegrityIssue {
  /** 一次都没用、正文里也没逐字保留的公式 —— 静默丢公式 */
  missing: string[]
  /** 用了两次以上的公式 —— 被复制到别的题，串题 */
  duplicated: string[]
}

/**
 * 公式比较不能容忍任何空白差异：`$a$` 与 `$ a $`、`$2a + yb$` 与 `$2a+yb$`
 * 是同一处公式。压成单空格还不够（`$ a $` 仍不匹配 `$a$`），必须全删空白。
 * 对中文正文无副作用——中文本来就没有词间空格。
 */
function compact(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * 完整性判定 —— 对齐 MathBank 的 `restore_visible_math`：每个锁定 ID 必须
 * 「恰好用一次」。
 *
 * `normalizedBody` 是模型输出的全部正文（题干 + 原版答案）。协议允许另一种
 * 合规写法：不用 ID，而是把标签内的公式逐字保留（实测 deepseek-chat 偏好这种），
 * 所以「0 次 ID 引用但有原文」不算 missing —— 是否把 missing 当致命，由调用方
 * 按「模型有没有动用 ID」决定（见 parse.ts）。
 */
export function inspectLockIntegrity(
  formulas: readonly LockedFormula[],
  counts: ReadonlyMap<string, number>,
  normalizedBody: string
): LockIntegrityIssue {
  const body = compact(normalizedBody)
  const missing: string[] = []
  const duplicated: string[] = []
  for (const formula of formulas) {
    const used = counts.get(formula.id) ?? 0
    if (used > 1) {
      duplicated.push(formula.id)
      continue
    }
    if (used === 1) continue
    const verbatim =
      (formula.raw !== '' && body.includes(compact(formula.raw))) ||
      (formula.latex !== '' && body.includes(compact(formula.latex)))
    if (!verbatim) missing.push(formula.id)
  }
  return { missing, duplicated }
}
