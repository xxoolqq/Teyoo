// 规约H：字体大小规约 —— remark-stringify handlers（mdast → Markdown）
//
// fontBlock handler：
//   ::: {family=SimSun size=14pt align=justify}
//   <内部 flow markdown>
//   :::
//
// fontSpan handler：
//   {= family=KaiTi size=12pt : 目标文本}
//
// 防御性转义：fontBlock 内部内容是用户自由 Markdown，若某行恰好长得像
// ::: {attrs} 或 ::: 会被再次解析为标记。对这类行在首个 : 前加反斜杠
// （\: 在 CommonMark 中解析为字面 :），保证无损往返。嵌套的 fontBlock
// 节点通过本 handler 产出的标记不会被转义（它们经过 containerFlow 时
// 已由子 handler 正确生成，不会被当作"普通文本行"扫描）。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { serializeAttrs, type FontAttrs } from './lib'

const RE_LINE_BLOCK_START = /^[ ]{0,3}:{3,}font\s*\{[^}]*\}\s*$/
const RE_LINE_BLOCK_END = /^[ ]{0,3}:{3,}\s*$/

function escapeInnerMarkers(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (RE_LINE_BLOCK_START.test(line) || RE_LINE_BLOCK_END.test(line)) {
        const idx = line.indexOf(':')
        if (idx >= 0 && line[idx - 1] !== '\\') {
          return line.slice(0, idx) + '\\' + line.slice(idx)
        }
      }
      return line
    })
    .join('\n')
}

// 从 mdast 节点的散布属性构建 FontAttrs
function attrsFromNode(node: any): FontAttrs {
  const attrs: FontAttrs = {}
  if (node.family) attrs.family = node.family
  if (node.size) attrs.size = node.size
  if (node.align) attrs.align = node.align as FontAttrs['align']
  return attrs
}

export function fontBlockStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('fontBlock')
  const tracker = state.createTracker(info)
  const attrs = attrsFromNode(node)
  const head = `:::font {${serializeAttrs(attrs)}}`
  const innerRaw = state.containerFlow(node, tracker.current())
  const inner = innerRaw.trim()
  const body = inner ? escapeInnerMarkers(inner) : ''
  const value = body ? `${head}\n${body}\n:::` : `${head}\n:::`
  exit()
  return value
}

export function fontSpanStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('fontSpan')
  const tracker = state.createTracker(info)
  const attrs = attrsFromNode(node)
  const head = `{= ${serializeAttrs(attrs)} : `
  let value = tracker.move(head)
  value += tracker.move(
    state.containerPhrasing(node, { before: head, after: '}', ...tracker.current() })
  )
  value += tracker.move('}')
  exit()
  return value
}
