// 规约G：汉字田字格 —— remark-stringify handler
//
// tianziGrid 节点的 raw 保存了 ++ 之间的完整 inner（含括号），
// 直接拼回 ++raw++ 即可，序列化无损、与数字/拼音参数原样一致。

/* eslint-disable @typescript-eslint/no-explicit-any */
export function tianziGridStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('tianziGrid')
  const tracker = state.createTracker(info)
  const value = tracker.move(`++${node.raw ?? ''}++`)
  exit()
  return value
}
