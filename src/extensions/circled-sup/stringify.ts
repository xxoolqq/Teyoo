// 规约E：汉字右上角带圈序号 —— remark-stringify handler
// 原样输出 `汉字^{数字}`，实现序列化无损往返。

/* eslint-disable @typescript-eslint/no-explicit-any */
export function circledSupStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('circledSup')
  const tracker = state.createTracker(info)
  let value = tracker.move(`${node.char ?? ''}^{${node.num ?? ''}}`)
  exit()
  return value
}
