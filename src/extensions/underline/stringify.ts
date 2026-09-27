// 文字下划线 —— remark-stringify handler
//
// 自定义 mdast 节点 underline 默认 remark-stringify 不识别，
// 需注册 handler 让其原样输出 `<u>内容</u>`，实现序列化无损往返。
//
// 参考 emph-dot/stringify.ts：state.enter 进入节点上下文 → tracker
// 推进输出 `<u>` → containerPhrasing 递归序列化子节点 → `</u>` → exit。

/* eslint-disable @typescript-eslint/no-explicit-any */
export function underlineStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('underline')
  const tracker = state.createTracker(info)
  let value = tracker.move('<u>')
  value += tracker.move(
    state.containerPhrasing(node, { before: value, after: '</u>', ...tracker.current() })
  )
  value += tracker.move('</u>')
  exit()
  return value
}
