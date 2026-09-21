// 规约A：字下着重号（点）—— remark-stringify handler
//
// 自定义 mdast 节点 emphDot 默认 remark-stringify 不识别，
// 需注册 handler 让其原样输出 `@.内容.@`，实现序列化无损往返。
//
// 参考 highlight.ts 的 highlightStringifyHandler：
//   state.enter('mark') 进入节点上下文 → 用 tracker 推进输出 `==`
//   → containerPhrasing 递归序列化子节点 → 推进输出 `==` → exit

/* eslint-disable @typescript-eslint/no-explicit-any */
export function emphDotStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('emphDot')
  const tracker = state.createTracker(info)
  let value = tracker.move('@.')
  value += tracker.move(
    state.containerPhrasing(node, { before: value, after: '.@', ...tracker.current() })
  )
  value += tracker.move('.@')
  exit()
  return value
}
