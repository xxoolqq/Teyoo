// 通用上下标（化学式）—— remark-stringify handler
//
// 自定义 mdast 节点 subscript / superscript 默认 remark-stringify 不识别，
// 需注册 handler 让其原样输出 `_{x}` / `^{x}`，实现序列化无损往返。
//
// 内容为纯文本时直接拼接，不走 containerPhrasing：后者会对 `*`、`_` 等
// 做 CommonMark 转义，塞进 `_{...}` 后再解析会变成带反斜杠的原文。
// 含非 text 子节点（用户在上下标内套了加粗等 mark）时回退 containerPhrasing，
// 此时属于用户编辑后的内容，尽力而为（语法本身只承载纯文本）。

/* eslint-disable @typescript-eslint/no-explicit-any */

// children 全为 text 节点时返回拼接文本，否则返回 null
function innerText(node: any): string | null {
  const children: any[] = node.children ?? []
  if (!children.length) return null
  let out = ''
  for (const c of children) {
    if (c.type !== 'text' || typeof c.value !== 'string') return null
    out += c.value
  }
  return out
}

function makeHandler(type: string, open: string, close: string) {
  return function handler(node: any, _parent: any, state: any, info: any): string {
    const exit = state.enter(type)
    const tracker = state.createTracker(info)
    let value = tracker.move(open)
    const text = innerText(node)
    value += tracker.move(
      text !== null
        ? text
        : state.containerPhrasing(node, { before: value, after: close, ...tracker.current() })
    )
    value += tracker.move(close)
    exit()
    return value
  }
}

export const subscriptStringifyHandler = makeHandler('subscript', '_{', '}')
export const superscriptStringifyHandler = makeHandler('superscript', '^{', '}')
