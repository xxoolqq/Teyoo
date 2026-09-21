// 规约C：行内填空线 —— remark-stringify handler
//
// 把 mdast 中的 `blankLine` 节点写回原始 Markdown 字面 `--(N)` 或 `--(N,blank)`，
// 使保存/导出/重载往返无损（不输出 HTML）。
//
// remark-stringify 在序列化未知节点类型时会抛错；本 handler 告诉它如何
// 把 blankLine 节点拼成原始 token。参考 highlight.ts 的 highlightStringifyHandler。

/* eslint-disable @typescript-eslint/no-explicit-any */

// 参数：node = blankLine mdast 节点（含 chars/blank）
//       state = remark-stringify 的 SerializeState
//       info  = 当前 phrasing 位置信息（含空格追踪）
export function blankLineStringifyHandler(
  node: any,
  _parent: any,
  state: any,
  info: any
): string {
  // 原子节点没有子节点需要递归；用 tracker 拼字面字符串即可。
  const tracker = state.createTracker(info)
  let value = tracker.move(`--(${node.chars ?? 1}`)
  if (node.blank) value += tracker.move(',blank')
  value += tracker.move(')')
  return value
}
