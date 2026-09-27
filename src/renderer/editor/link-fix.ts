// 链接 mark 两项缺陷修复（milkdown preset-commonmark 的 link 缺陷）
// ─────────────────────────────────────────────────────────────────────────────
//
// 缺陷 1 —— linkSchema 未设 inclusive（光标被困）：
//   ProseMirror MarkSpec 默认 inclusive: true。裸 URL（如
//   https://www.runoob.com）经 GFM autolink literal（粘贴、或源码↔wysiwyg
//   切换重新解析）产生 link mark 后，光标停在链接末尾时 $from.marks()
//   仍含 link——继续敲字每个字符都被吸进超链接，即「光标被链接困住」。
//   修复：extendSchema 加 inclusive: false：
//     - 链接末尾/紧邻右侧敲字 → 普通文本（Notion / Google Docs 同款行为）
//     - 链接内部敲字 → 仍保持链接
//   commonmark 内部 toggleLink / updateLink 等命令经 schemaCtx.marks['link']
//   取 MarkType（全局唯一），不受覆盖影响。
//
// 缺陷 2 —— preset-commonmark 没有链接输入规则（敲语法不生效）：
//   commonmark 为 emphasis/strong/inlineCode/heading/blockquote/图片
//   （![alt](url)）/hr/列表都注册了输入规则，唯独没有 [text](url) 的。
//   在 wysiwyg 挨个敲 `[百度](http://www.baidu.com)` 永远不会变成链接，
//   只能作为字面文本存在；切到源码后序列化器为保持字面性输出
//   `\[百度]\(http\://www\.baidu.com)`（`\[` 防链接语法、`http\://`
//   `www\.` 防 GFM autolink literal——这些转义是必要的，否则切回
//   wysiwyg 重新解析会把字面文本变成链接，语义漂移）。
//   修复：补一个 Typora 式链接输入规则——敲完收尾 `)` 的瞬间把
//   `[text](url)` 替换为带 link mark 的 text。
//
// 输入规则细节：
//   - 正则锚定行尾 `$`（只在光标处完整敲出时触发）；`(?<!!)` 否定
//     前瞻防止吞掉图片语法 `![alt](url)` 的 `[alt](url)` 部分（commonmark
//     的图片输入规则先注册先处理，此处是兜底防御）。
//   - href 允许一层平衡括号（Wikipedia 风格 URL），支持可选 title
//     `[text](url "标题")` 与尖括号形式 `[text](<url>)`。
//   - handler 采用 markRule 同款「删定界符 + addMark」手法，保留 label
//     上已有的 marks（如粗体链接文字）。
//   - setStoredMarks(初始值) 保证转换后继续敲字不意外延续 link。
//   - 转义协同（关键）：收尾 `)` 是裸敲的，escape-input 截断不到它；
//     若用户此前用 `\[`/`\]` 转义过任一结构字符，匹配区间内必有
//     「转义消耗位置」（escape-input 的 escaped 表），此时放弃转换——
//     敲 `\[baidu\](url)` 得到字面 `[baidu](url)`，敲裸 `[baidu](url)`
//     得到链接，两种意图各得其所（CommonMark：\[ 字面即阻断链接）。

import { InputRule } from '@milkdown/kit/prose/inputrules'
import type { MarkType } from '@milkdown/kit/prose/model'
import type { EditorState } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'
import { linkSchema } from '@milkdown/kit/preset/commonmark'
import { hasEscapedInRange } from './escaped-literal'

export const linkFixSchema = linkSchema.extendSchema(
  (schema) => (ctx) => ({
    ...schema(ctx),
    inclusive: false,
  })
)

// [label](href) / [label](href "title") / [label](<href>) —— 锚定光标行尾
const RE_LINK = /(?<!!)\[([^[\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\)$/

/**
 * 输入规则的 handler（独立导出便于测试直接构造）。
 * 匹配区间内存在「转义消耗产生的字面字符」时放弃转换保持字面——
 * 用户敲 `\[baidu\](url)` 的意图是字面（escape-input 已吃掉反斜杠，
 * 文档里只剩裸 `[baidu](url)`，若不判定会被本规则误转成链接）。
 * 与 CommonMark 语义一致：\[ 或 \] 任一字面即阻断链接语法。
 */
export function createLinkInputRuleHandler(linkType: MarkType) {
  return (state: EditorState, match: RegExpMatchArray, start: number, end: number) => {
    if (hasEscapedInRange(state, start, end)) return null
    const label = match[1]
    let href = match[2]
    const title = match[3] ?? null
    if (!label || !href) return null
    // 尖括号形式 [text](<url>)：剥掉包裹的 <>
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1)

    const { tr } = state
    // label 在完整匹配中的位置（`[` 之后，恒为 1，用 indexOf 更自明）
    const textStart = start + match[0].indexOf(label)
    const textEnd = textStart + label.length
    const initialStoredMarks = tr.storedMarks ?? []
    // 先删高位区间（closing `](url)` 部分），再删低位（opening `[`）
    if (textEnd < end) tr.delete(textEnd, end)
    if (textStart > start) tr.delete(start, textStart)
    tr.addMark(start, start + label.length, linkType.create({ href, title }))
    tr.setStoredMarks(initialStoredMarks)
    return tr
  }
}

export const linkInputRule = $inputRule((ctx) => {
  const linkType = linkSchema.type(ctx)
  return new InputRule(RE_LINK, createLinkInputRuleHandler(linkType))
})
