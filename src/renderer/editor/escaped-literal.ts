// 转义字符保真：escaped_literal mark + remark 解析侧拆分 + 序列化侧还原
// ─────────────────────────────────────────────────────────────────────────────
//
// 最高原则（用户规约）：wysiwyg 输入的任何字符忠实原样记录——不允许私自
// 丢掉转义，不允许私自增加转义。具体到「转义痕迹」：
//
//   - 用户转义过的字符（wysiwyg 敲 `\x`，或源码写 `\x`）：即使 x 无语法
//     地位（如 `]` `|` `:`），转义也必须保留——`\[你好\]` 往返后还是
//     `\[你好\]`，不允许被「规范化」成 `\[你好]`。
//   - 用户没转义过的字符：不加任何无必要转义（`hello_world` 不许变
//     `hello\_world`）。有语法风险的必要转义除外（字面 `*` 必须编码为
//     `\*`，否则重解析变斜体、语义漂移）。
//
// 难点：CommonMark 解析（micromark）在生成 mdast 时就把 `\x` 的反斜杠
// 消耗掉，text 节点值 = 字面 x，mdast 层无任何「该字符来自转义」的痕迹
// ——序列化时无从恢复，这就是 `\]` 被丢的根因。
//
// 方案（本文件）：
//
// 1. 解析侧 remarkEscapedLiteral：利用 text 节点的 position 对照 vfile
//    原文，双指针对齐找出被消耗的 `\标点`，把 text 拆为
//    [text, escape(value), text, ...]。escape 是自定义 mdast 节点。
//    （isEscapedLiteral 同款「position 查原文」手法，已在
//    residual-emphasis 验证过可靠性。）
// 2. escaped_literal mark（$markSchema）：parseMarkdown 接管 escape
//    节点 → openMark + addText(字面字符) + closeMark。mark 落在 PM
//    文档上，随文档持久化——保存文件（编码为 `\x`）再打开、切源码再切
//    回、复制粘贴，转义痕迹全程不丢。
// 3. 序列化侧 toMarkdown：mark 的 runner 用 withMark 产生 html 节点
//    （value = SENTINEL + 字符）并返回 true 全权接管（inlineCode 同款
//    手法）。remark-stringify 对 html 节点原样输出 value；SENTINEL 是
//    私有区占位符，让后处理（fixMarkerEscapes 按侧翼规则还原无必要
//    转义）无法误伤用户转义，最后统一替换为 `\`。
// 4. escape-input（wysiwyg 敲 `\x` 即时消耗）改为施加本 mark——取代
//    此前的内存位置表：mark 随文档持久化且由 PM 自动维护（删除字符
//    mark 自灭），linkInputRule 的「转义阻断链接」判定（hasEscapedInRange）
//    同步改为查 mark，覆盖粘贴/文件导入等全部来源。
//
// mark spec 细节：
//   - inclusive: false —— 转义字符后继续敲字不延续 mark（同 link 修复）
//   - excludes: ''   —— 与任何 mark 共存（粗体内的转义星号）
//   - priority: 1000 —— 序列化时最后 openMark（最内层）。mark runner
//     返回 true 会短路 #runNode 的 every、阻止后续 mark 的 runner，必须
//     排在最后确保 strong/link 等 mark 先行开启；closeMark 按栈顶弹出，
//     与 forEach 顺序无关，嵌套结构由 open 顺序唯一决定。
//
// 对齐算法的安全性：v（text 值）与 s（原文区间）双指针逐字符对齐，只有
// `s[j]=='\\' && s[j+1] 是 ASCII 标点 && v[i]==s[j+1]` 才判转义。任何
// 对不齐（character reference `&amp;` 等导致 v≠s 的长度差）→ 整个节点
// 放弃拆分（保守降级：该节点转义不保真，但绝不误标）。
//
// 已知边界：
//   - 代码块 / 行内代码不 visit（text 节点才处理），代码内容天然逐字保真。
//   - emphasis 的 `_x_` → `*x*`、列表 `-` → `*` 等记号选择规范化不属于
//     转义丢失（渲染语义等价，mdast 无原始记号信息），见已知残余记录。

import { $markSchema } from '@milkdown/kit/utils'
import { visit } from 'unist-util-visit'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { Transformer } from 'unified'

// CommonMark 可转义字符 = ASCII 标点
const ESCAPABLE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''))

// 序列化占位符（Unicode 私有区，正常文本不可能出现）：
// mark → html 节点 value = SENTINEL + 字符，最终出口统一替换为反斜杠。
export const ESCAPE_SENTINEL = ''

/** 序列化出口：占位符 → 反斜杠（用户转义最终还原） */
export function restoreEscapes(markdown: string): string {
  return markdown.includes(ESCAPE_SENTINEL)
    ? markdown.split(ESCAPE_SENTINEL).join('\\')
    : markdown
}

// ─── escaped_literal mark ───────────────────────────────────────────────────

export const escapedLiteralMark = $markSchema('escaped_literal', () => ({
  // 无 attrs：mark 存在即「该字符来自转义」
  inclusive: false,
  excludes: '',
  // 序列化优先级（milkdown #runNode 按 spec.priority 排序，默认 50）：
  // 1000 保证最后 open（最内层）+ runner 返回 true 时不阻断其他 mark
  priority: 1000,
  parseDOM: [
    // 仅服务内部 HTML 剪贴板往返（wysiwyg 复制的 text/html 含此 span）
    { tag: 'span[data-escaped]' },
  ],
  toDOM: () => ['span', { 'data-escaped': 'true' }, 0],
  parseMarkdown: {
    match: (node: any) => node.type === 'escape',
    runner: (state: any, node: any, markType: any) => {
      state.openMark(markType)
      state.addText(String(node.value))
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark: any) => mark.type.name === 'escaped_literal',
    runner: (state: any, mark: any, node: any) => {
      // html 节点 value 原样输出（remark-stringify 不转义 html 值）；
      // SENTINEL 防 fixMarkerEscapes 等后处理误伤，出口统一还原。
      // 返回 true：全权接管该 text 节点（inlineCode 同款），内容不再
      // 作为 text 子节点序列化。
      //
      // 每个字符独立加 SENTINEL：ParserState.addText 会把相同 marks 的
      // 相邻 text 合并（如 `\]\(` 的 ] 和 ( 合成一个 text "]("），
      // 若只加一个前缀会输出 `\](` 丢一个转义；per-char 才能还原 `\]\(`。
      const text = String(node.text ?? '')
      state.withMark(mark, 'html', text.split('').map((c) => ESCAPE_SENTINEL + c).join(''))
      return true
    },
  },
}))

// ─── 解析侧：text 节点按原文拆出 escape 节点 ──────────────────────────────

function makePos(start: number, end: number): any {
  return {
    start: { line: 1, column: 1, offset: start },
    end: { line: 1, column: 1, offset: end },
  }
}

/**
 * 解析侧插件：把 text 节点中被消耗的 `\标点` 转义拆为 escape 节点。
 * 必须放在插件链最前（vfile.value 尚未被任何 raw-text transformer
 * 改写、position 与原文一致）。
 */
export function remarkEscapedLiteral(): Transformer {
  return (tree, file) => {
    const src = typeof file?.value === 'string' ? file.value : ''
    if (!src || !src.includes('\\')) return

    visit(tree, 'text', (node: any, index, parent: any) => {
      if (index == null || !parent || !Array.isArray(parent.children)) return
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (typeof start !== 'number' || typeof end !== 'number') return
      const s = src.slice(start, end)
      const v = String(node.value ?? '')
      if (!s.includes('\\')) return

      // 双指针对齐：i → v，j → s
      const children: any[] = []
      let buf = ''
      let bufStart = start
      let i = 0
      let j = 0
      const flush = (upTo: number) => {
        if (buf) children.push({ type: 'text', value: buf, position: makePos(bufStart, upTo) })
        buf = ''
      }

      while (i < v.length && j < s.length) {
        const next = s[j + 1] ?? ''
        if (s[j] === '\\' && ESCAPABLE.has(next) && v[i] === next) {
          // 被消耗的转义：原文两字符 `\x` 对应 text 值一个字符 `x`
          flush(start + j)
          children.push({ type: 'escape', value: next, position: makePos(start + j, start + j + 2) })
          bufStart = start + j + 2
          i += 1
          j += 2
        } else if (v[i] === s[j]) {
          buf += v[i]
          i += 1
          j += 1
        } else {
          // 对不齐（character reference 等）：保守放弃整个节点
          return
        }
      }
      if (i !== v.length || j !== s.length) return
      flush(end)

      // 只有真的拆出了 escape 才替换（纯 text 原样保留，不动 position 结构）
      if (children.some((c) => c.type === 'escape')) {
        parent.children.splice(index, 1, ...children)
      }
    })
  }
}

// ─── 通用判定（供输入规则等消费）───────────────────────────────────────────

/**
 * [from, to) 区间内是否存在「转义产生的字面字符」（escaped_literal mark）。
 * 输入规则（linkInputRule 等）匹配后调用：命中则放弃转换保持字面——
 * 用户明确转义过区间内字符（CommonMark：\[ 或 \] 任一字面即阻断链接）。
 * 相比旧内存位置表：mark 随文档持久化，粘贴 / 文件导入来源的转义同样覆盖。
 */
export function hasEscapedInRange(state: EditorState, from: number, to: number): boolean {
  let found = false
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false
    if (node.marks.some((m) => m.type.name === 'escaped_literal')) {
      found = true
      return false
    }
    return true
  })
  return found
}
