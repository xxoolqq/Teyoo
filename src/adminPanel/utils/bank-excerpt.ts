// 题目卡片摘要的轻量渲染：转义 + 行内公式，仅此两件事。
//
// 为什么不复用 mountReadonlyPreview（Milkdown 只读实例）：
//   本地题库一页 20 张卡，而只读预览的创建是**全局串行**的（readonly-preview 的
//   队列注释里写着原因）。20 个实例排队建出来，进页面会看到卡片一张张往下跳；
//   而卡片摘要只要两行，用不到拼音 / 田字格 / 分栏这些扩展语法。
//   详情面板那边仍然走完整 Milkdown 管线（见 LocalBankView 的挂载点）。
//
// 公式用 KaTeX 的 renderToString —— 与编辑器 math-engine 同一个渲染器、同样的
// throwOnError:false，所以 `$` 没闭合或命令写错时只会退化成原文，不会把卡片炸掉。
// 定界符与 MathBank 卡片一致：$$ 也按行内渲染（display: false），避免整块居中把
// 两行摘要撑开。

import katex from 'katex'
import 'katex/dist/katex.min.css'

/** $$…$$ 优先，其次 $…$；跨行公式不算（摘要里也不需要） */
const MATH_TOKEN = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch)
}

/**
 * 非公式片段：压成一行 + 只保留最影响观感的几种 markdown 记号。
 *
 * 摘要只有两行高，标题符号、列表符号、强调星号留着就是噪音；加粗保留下来，
 * 是因为题干里「不正确的是」这类地方常靠它强调。
 */
function textToHtml(raw: string): string {
  return escapeHtml(raw)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/`+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
}

function mathToHtml(token: string): string {
  const body = token.startsWith('$$') ? token.slice(2, -2) : token.slice(1, -1)
  try {
    return katex.renderToString(body, { displayMode: false, throwOnError: false })
  } catch {
    return escapeHtml(token)
  }
}

/** markdown（含 LaTeX 公式）→ 可直接 v-html 的摘要 HTML */
export function renderExcerptHtml(markdown: string): string {
  const source = (markdown ?? '').trim()
  if (!source) return ''

  let html = ''
  let cursor = 0
  MATH_TOKEN.lastIndex = 0
  for (let match = MATH_TOKEN.exec(source); match; match = MATH_TOKEN.exec(source)) {
    html += textToHtml(source.slice(cursor, match.index))
    html += mathToHtml(match[1])
    cursor = match.index + match[1].length
  }
  html += textToHtml(source.slice(cursor))
  return html.trim()
}
