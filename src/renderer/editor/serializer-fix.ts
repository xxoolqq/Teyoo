// milkdown 序列化器 moveSpaces 拆分修复
//
// 背景（上游 bug，milkdown 7.19.2 @milkdown/transformer SerializerState）：
// 序列化 PM 文档时，#runNode 在「每个节点」处理后关闭其全部 mark，
// #closeMark → #closeNodeAndPush(true) → #moveSpaces 会把 mark 边界 text
// 子节点的首尾空格移到 mark 节点外面（CommonMark 强调定界符内侧不能贴
// 空格，这一步本身是必要的）；随后 #maybeMergeChildren 把「直接相邻」的
// 同类型 mark 节点重新合并 —— 但被移出的空格 text 节点恰好插在两个 mark
// 之间，阻断合并。
//
// 后果：PM 中连续的同一段 mark（如粘贴得到的
//   strong{ text("斜体 "), inlineCode("*"), text("、粗体 "), … }）
// 被序列化成多个 mark 节点：
//   strong{t("斜体")}, t(" "), strong{ic("*"), t("、粗体")}, t(" "), …
// 输出 `**斜体** **`*`、粗体**`——多出 `**`，且与原文不一致；
// 在源码/wysiwyg 之间往返后无法还原。
//
// 修复：在 remark.stringify 之前对 mdast 做一次合并：相邻的
// [markA, 纯空格 text, markB]，若 markA/markB 同类型且属性（除 children
// 外）全等，则把空格与 markB 的 children 并入 markA。空格回到 mark 内部
// —— PM 真实结构中它本就在 mark 内（moveSpaces 只是为满足定界符侧翼
// 规则才挪出去），且合并后空格位于两段非空内容之间，不触碰 mark 首尾
// 边界，序列化结果合法（`**a `x` b**`）。
//
// 已知取舍：若用户在 PM 中显式构造「mark(a) + 无标记空格 + mark(b)」
// （如手动取消某处空格的加粗），合并后空格会带上 mark。视觉上无差别、
// 往返稳定，且该形态极罕见；相比之下，粘贴 markdown 后内容被改变是
// 实际发生的 bug。
//
// 值式 mark（inlineCode）无 children，不参与合并 —— 两个独立行内代码
// 之间的空格本就不属于代码，保持分离才正确。

/* eslint-disable @typescript-eslint/no-explicit-any */

const SPACE_ONLY_RE = /^[ \t]+$/

function isMergeableMark(node: any): boolean {
  return (
    node &&
    typeof node === 'object' &&
    node.isMark === true &&
    typeof node.type === 'string' &&
    Array.isArray(node.children) &&
    node.children.length > 0
  )
}

function isSpaceText(node: any): boolean {
  return (
    node &&
    node.type === 'text' &&
    typeof node.value === 'string' &&
    SPACE_ONLY_RE.test(node.value)
  )
}

/** 除 children 外的全部属性（含 type、isMark、url、marker 等）是否全等 */
function sameMarkShape(a: any, b: any): boolean {
  if (a.type !== b.type) return false
  const { children: _a, ...restA } = a
  const { children: _b, ...restB } = b
  return JSON.stringify(restA) === JSON.stringify(restB)
}

/** 把 b 的 children 并入 a，空格 sep 作为普通 text 插在中间 */
function absorb(a: any, sep: any, b: any): void {
  const last = a.children[a.children.length - 1]
  if (last && last.type === 'text' && typeof last.value === 'string') {
    last.value += sep.value
  } else {
    a.children.push({ type: 'text', value: sep.value })
  }
  const first = b.children[0]
  const tail = a.children[a.children.length - 1]
  if (
    first &&
    first.type === 'text' &&
    typeof first.value === 'string' &&
    tail.type === 'text' &&
    typeof tail.value === 'string'
  ) {
    tail.value += first.value
    a.children.push(...b.children.slice(1))
  } else {
    a.children.push(...b.children)
  }
}

function fixChildren(children: any[]): void {
  let i = 0
  while (i + 2 < children.length) {
    const a = children[i]
    const sep = children[i + 1]
    const b = children[i + 2]
    if (
      isMergeableMark(a) &&
      isSpaceText(sep) &&
      isMergeableMark(b) &&
      sameMarkShape(a, b)
    ) {
      absorb(a, sep, b)
      children.splice(i + 1, 2)
      // 不推进 i：继续尝试吸收下一个同型 mark（链式 [A, sp, B, sp, C]）
    } else {
      i++
    }
  }
}

/**
 * 给「空文档」交出来的 root 补上 children 数组（就地修改）。
 *
 * milkdown 的 SerializerState 在没有**任何块**时，build() 交出的 root 只有
 * `{ type: 'root' }`，没有 children；而 mdast-util-to-markdown 的 root 处理器
 * 第一句就是 `node.children.some(...)`，于是抛
 *   TypeError: Cannot read properties of undefined (reading 'some')
 *
 * 触发场景（真机上踩到的）：光标停在空段落里（或整篇空文档）时序列化选区 /
 * 整篇 Markdown。**空文档本来就该序列化成空串**，补个空数组即可。
 *
 * 注意这不只是"助手取上下文"的事：这个异常会顺着调用方一路抛出去，把
 * 「文件 → 打开」这类流程一起打断（见 main.ts 里 onFileOpened），所以修在
 * 序列化这一层（唯一入口），而不是在每个调用点加 try/catch。
 */
export function ensureRootChildren(tree: unknown): void {
  const node = tree as { children?: unknown } | null
  if (!node || typeof node !== 'object') return
  if (!Array.isArray(node.children)) node.children = []
}

/** 递归修复整棵 mdast 树（就地修改） */
export function fixMilkdownMarkSplits(tree: unknown): void {
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.children)) {
      fixChildren(node.children)
      for (const child of node.children) walk(child)
    }
  }
  walk(tree as any)
}

// ─── 强调标记转义还原（\* \~ \_）─────────────────────────────────────────
//
// mdast-util-to-markdown 的 unsafe 表对 phrasing 中的 `_` 无条件转义，
// remark-gfm 对 `*` / `~` 同样无条件转义——即使该标记按 CommonMark 侧翼
// 规则根本不可能构成强调定界符（如「斜体 * 单独测试」中两侧都是空格的
// `*`，intraword 的 `hello_world`）。渲染语义无差别，但源码不再原样。
//
// 此处在序列化输出上把「绝不可能是定界符」的转义标记还原：
// 按 CommonMark 的 left/right-flanking 规则逐 run 判定（run = 连续的
// 同字符转义序列，如 \*\*、\_\_）：
// - `*` / `~`：can_open = left-flanking，can_close = right-flanking
//   （无 intraword 限制，`a*b*c` 可构成强调）
// - `_`：另有 intraword 排除（两侧均为字母数字时不能开/闭）
// 两者均为 false 时无需转义。行内代码 span 与围栏代码块内容不处理。
// 真转义场景（\*普通星号\*）恰好判定为需要转义 → 原样保留。

const RE_PUNCT = /[\p{P}\p{S}]/u
const isWs = (c: string): boolean => /\s/.test(c)

function flanks(prev: string, next: string): { left: boolean; right: boolean } {
  const pWs = isWs(prev)
  const nWs = isWs(next)
  const pP = RE_PUNCT.test(prev)
  const nP = RE_PUNCT.test(next)
  return {
    left: !nWs && (!nP || pWs || pP),
    right: !pWs && (!pP || nWs || nP),
  }
}

/** 该标记 run 是否可能作为定界符（需保留转义） */
function runNeedsEscape(prev: string, next: string, char: string): boolean {
  const { left, right } = flanks(prev, next)
  if (char === '_') {
    const pP = RE_PUNCT.test(prev)
    const nP = RE_PUNCT.test(next)
    const canOpen = left && !(right && (left || pP))
    const canClose = right && !(left && (right || nP))
    return canOpen || canClose
  }
  // `*` / `~`：无 intraword 排除
  return left || right
}

/** 把一行文本中无需转义的标记转义还原（跳过行内代码 span `…`） */
function fixMarkerEscapesInLine(line: string): string {
  if (!/\\[~*_-]/.test(line)) return line
  // 按行内代码 span 切段，只处理代码外的部分
  const parts = line.split(/(`+[^`]*`+)/g)
  return parts
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(/(?:\\([~*_]))+/g, (run, _c: string, off: number, s: string) => {
            // run 内字符一致（正则按同字符连续匹配），取首字符判定
            const char = run[1]
            const prev = off > 0 ? s[off - 1] : '\n'
            const next = off + run.length < s.length ? s[off + run.length] : '\n'
            return runNeedsEscape(prev, next, char) ? run : run.replace(/\\/g, '')
          })
    )
    .join('')
}

/** 序列化输出后处理：还原「绝不构成强调定界符」的 \* \~ \_ 转义。
 *  跳过围栏代码块（``` / ~~~）与行内代码 span。 */
export function fixMarkerEscapes(markdown: string): string {
  if (!/\\[~*_]/.test(markdown)) return markdown
  const lines = markdown.split('\n')
  let inFence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (inFence === null) inFence = fence[1][0]
      else if (fence[1][0] === inFence) inFence = null
      continue
    }
    if (inFence === null) lines[i] = fixMarkerEscapesInLine(line)
  }
  return lines.join('\n')
}
