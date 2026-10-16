// 规约F：子块与分栏 —— remark-stringify handlers（mdast → Markdown）
//
// 输出固定协议（开始/结束标记均独占一行，合法且最简）：
//
//   @box[#align]
//   <内部 flow markdown>
//   @
//
//   @@cols <spec>
//   <各子块依次序列化>
//   @@
//
// 防御性转义：内部内容是用户自由 Markdown，理论上可能出现恰好长得像
// 开始 / 结束标记的行（例如一首以「@box」开头的诗、以 @ 结尾的行）。
// 序列化时对这些行做 \@ 转义（CommonMark 中 \@ 解析为字面 @），保证
// 再次解析时区域边界不会被内部内容破坏（无损往返）。

/* eslint-disable @typescript-eslint/no-explicit-any */

const RE_LINE_SUB_START = /^[ ]{0,3}@(box)?(#(left|center|right))?[ ]*$/
const RE_LINE_COLS = /^[ ]{0,3}@@(?:cols(?:[ ]+(?:\d+|\d+:\d+))?)?[ ]*$/
const RE_LINE_TRAILING_AT = /^(.*?)([ ]{0,3})@([ ]*)$/

/**
 * 转义内部内容里「长得像开始/结束标记」的行（见文件头）。
 * 导出给后台面板的「插入子块」弹窗用：那边同样是用户自由输入的内容，转义规则
 * 必须与这里一致，否则同一个子块在两边序列化出的源码不同。
 */
export function escapeInnerMarkers(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      // 行首标记：子块开始 / 分栏开始 / 分栏结束 / 孤立 @ → 在首个 @ 前加反斜杠
      if (RE_LINE_COLS.test(line) || RE_LINE_SUB_START.test(line)) {
        const at = line.indexOf('@')
        if (at >= 0 && line[at - 1] !== '\\') {
          return line.slice(0, at) + '\\' + line.slice(at)
        }
        return line
      }
      // 行尾结束标记：把最后一个未转义的 @ 转义
      const m = RE_LINE_TRAILING_AT.exec(line)
      if (m) {
        const content = m[1]
        if (content[content.length - 1] !== '\\') {
          return `${m[1]}${m[2]}\\@${m[3]}`
        }
      }
      return line
    })
    .join('\n')
}

export function subBlockStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('subBlock')
  const tracker = state.createTracker(info)
  const innerRaw = state.containerFlow(node, tracker.current())
  const head =
    '@' +
    (node.boxed ? 'box' : '') +
    (node.align && node.align !== 'left' ? `#${node.align}` : '')
  const inner = innerRaw.trim()
  const body = inner ? escapeInnerMarkers(inner) : ''
  const value = body ? `${head}\n${body}\n@` : `${head}\n@`
  exit()
  return value
}

export function colsStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('cols')
  const tracker = state.createTracker(info)
  // 子块由 subBlockStringifyHandler 逐个产出（之间允许空行，解析端容忍）
  const inner = state.containerFlow(node, tracker.current()).trim()
  const value = inner ? `@@cols ${node.spec}\n${inner}\n@@` : `@@cols ${node.spec}\n@@`
  exit()
  return value
}
