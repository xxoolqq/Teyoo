// Typora 式转义输入（wysiwyg 下的 `\` + 标点 即时消耗）
// ─────────────────────────────────────────────────────────────────────────────
//
// 背景：wysiwyg 是「渲染态」编辑器，敲入的字符按字面进入文档；转义（\*）
// 本是「解析期」概念，因此旧版里 wysiwyg 敲 `\*` 会显示字面 `\*`（反斜杠
// 永不消失），而敲 `**text**` 又会触发 strong 输入规则变真加粗——用户没有
// 途径输入「显示为字面星号的文本」。
//
// Typora 的做法：敲 `\` 后，下一个字符若是可转义标点（CommonMark ASCII
// 标点），立即删除反斜杠、以字面形式插入该标点。
//
// 转义痕迹的持久化：消耗产生的字面字符同时施加 escaped_literal mark
// （escaped-literal.ts）——序列化时还原为 `\x`，保存/切源码/复制全程
// 保真（「最高原则」：不允许私自丢掉转义）。mark 由 PM 随文档自动维护
// （删除字符 mark 自灭），取代早期方案的内存位置表。
//
// 本插件的状态机（pending: number | null —— 刚敲入 `\` 之后的光标位）：
//   1. 敲 `\`：插入 `\` 并记 pending（自己 dispatch 返回 true，阻止
//      inputrules 扫描——单 `\` 本不匹配任何规则，无副作用）。
//   2. pending 有效时敲 c：
//      - c 为 ASCII 标点 → 把 `\` 替换为字面 c + escaped_literal mark，
//        pending 清空，返回 true（阻止 inputrules 扫描本次插入——否则
//        字面 `*` 与前文拼接可能触发 strong/emphasis markRule）。
//      - c 为 `\`（`\\`）→ 折叠为单个字面 `\` + mark。
//      - c 为其他字符（字母/数字/汉字……非 ASCII 标点）→ `\` 定型为字面
//        保留，pending 清空，返回 false 走默认插入。
//   3. pending 失效：光标移走（from !== pending）、Backspace/删除、任何
//      docChanged 使 `\` 不再紧邻光标 —— apply 里映射后校验 nodeBefore。
//
// ─── 与输入规则的协同 ──────────────────────────────────────────────────────
//
// 「消耗转义」只截断**本次**字符的 inputrules 扫描；但链接等语法的完成
// 字符是后来裸敲的（`\[baidu\](url)` 的收尾 `)`），扫描时需判定区间内
// 是否含转义字符——由 escaped_literal mark 承担（hasEscapedInRange，
// escaped-literal.ts）。mark 全来源覆盖（本插件消耗 / 粘贴解析 / 文件
// 导入解析），比内存表更可靠。
//
// 环境排除（不消耗反斜杠，保持字面编辑语义）：
//   - 代码块（parent.type.spec.code）、行内代码 / 行内公式（inlineCode、
//     math_inline 等含 code/math 名的 textblock）——代码内容必须逐字保真
//   - md_source 揭示态（syntax-reveal：揭示态内编辑的就是源码字面量，
//     其 handleTextInput 先注册先返回 true，此处为防御性兜底）
//
// 已知取舍：
//   - 替换选区（from < to）时敲 `\` 不追踪 pending：覆盖选区后紧敲标点
//     将得到字面 `\*`（旧语义）。主流空选区场景不受影响。
//   - 混用输入（如 `\*\*text**` 前转义后裸敲）：裸敲的最后 `*` 仍会触发
//     strong 规则吃掉前面的字面 `**`——与 Typora 一致，转义需逐字符使用。

import { Plugin, PluginKey, type EditorState } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

// CommonMark 可转义字符集合 = ASCII 标点
const ESCAPABLE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''))

interface EscapeInputState {
  /** 转义待定：刚敲入的 `\` 之后的光标位置 */
  pending: number | null
}

/** handleTextInput 的 meta：pending 新值 */
interface EscapeMeta {
  pending: number | null
}

export const escapeInputPluginKey = new PluginKey<EscapeInputState>('escape-input')

/** 光标是否处于不应消耗转义的环境（代码 / 公式 / 揭示态） */
function inLiteralContext(state: EditorState, from: number): boolean {
  const $from = state.doc.resolve(from)
  // 块级代码块与各种行内代码/公式容器：内容逐字保真
  if ($from.parent.type.spec.code) return true
  if (/(code|math)/i.test($from.parent.type.name)) return true
  // md_source 揭示态（防御性：syntax-reveal 的 handleTextInput 先拦截）
  for (let d = $from.depth; d >= 1; d--) {
    if ($from.node(d).type.name === 'md_source') return true
  }
  return false
}

/** 插入转义产生的字面字符：替换 pending 处的 `\` 为 char + escaped mark */
function replaceBackslashWith(
  state: EditorState,
  view: { dispatch: (tr: import('@milkdown/kit/prose/state').Transaction) => void },
  from: number,
  char: string
): void {
  const escapedType = state.schema.marks.escaped_literal
  const tr = state.tr.insertText(char, from - 1, from)
  if (escapedType) tr.addMark(from - 1, from, escapedType.create())
  tr.setMeta(escapeInputPluginKey, { pending: null })
  view.dispatch(tr)
}

/** 插件本体（独立导出便于测试直接构造） */
export function createEscapeInputPlugin(): Plugin<EscapeInputState> {
  return new Plugin<EscapeInputState>({
    key: escapeInputPluginKey,
    state: {
      init: () => ({ pending: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(escapeInputPluginKey) as EscapeMeta | undefined
        if (meta) return { pending: meta.pending }
        if (!tr.docChanged) return value
        // 外部事务：pending 随映射；还需校验 `\` 仍紧邻光标
        // （被删 / 前面插入则失效）
        let pending = value.pending
        if (pending != null) {
          const mapped = tr.mapping.map(pending, 1)
          const clamped = Math.min(Math.max(mapped, 0), tr.doc.content.size)
          const $pos = tr.doc.resolve(clamped)
          const before = $pos.nodeBefore
          if (!before || !before.isText || !(before.text ?? '').endsWith('\\')) {
            pending = null
          } else {
            pending = mapped
          }
        }
        return { pending }
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        // 仅处理单字符直接输入（IME 组合串 / 空串交给默认）
        if (text.length !== 1) return false
        const { state } = view
        if (inLiteralContext(state, from)) return false

        const st = escapeInputPluginKey.getState(state)
        const pending = st?.pending ?? null
        const $from = state.doc.resolve(from)
        const nodeBefore = $from.nodeBefore
        const afterBackslash =
          pending != null &&
          from === pending &&
          nodeBefore?.isText === true &&
          (nodeBefore.text ?? '').endsWith('\\')

        // 敲 `\`
        if (text === '\\') {
          if (afterBackslash) {
            // `\\` → 折叠为单个字面 `\`（用新输入替换旧 `\`）+ escaped mark
            replaceBackslashWith(state, view, from, '\\')
            return true
          }
          // 普通插入 `\`，进入「转义待定」
          const tr = state.tr.insertText('\\', from, to)
          tr.setMeta(escapeInputPluginKey, { pending: from + 1 })
          view.dispatch(tr)
          return true
        }

        // pending 有效时敲其他字符
        if (afterBackslash) {
          if (ESCAPABLE.has(text)) {
            // 消耗反斜杠：`\` 的位置替换为字面标点 + escaped mark。
            // 返回 true 同时阻止 inputrules 扫描本次插入——否则字面 `*`
            // 与前文拼接可能触发 strong/emphasis markRule（如 `\*\*x\*\*`
            // 敲最后一颗转义 `*` 时窗口文本恰为 `**x**`）。
            replaceBackslashWith(state, view, from, text)
            return true
          }
          // 非标点：`\` 定型为字面（如 `\n`、`\中`），清除待定，走默认插入
          const tr = state.tr.setMeta(escapeInputPluginKey, { pending: null })
          view.dispatch(tr)
          return false
        }

        return false
      },
    },
  })
}

export const escapeInputPlugin = $prose(() => createEscapeInputPlugin())
