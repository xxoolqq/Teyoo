// 规约B2：同行平级拼音 —— remark-stringify handler
//
// 自定义 mdast 节点 pinyinInline 默认 remark-stringify 不识别，
// 需注册 handler 让其原样输出 `汉字[拼音]`，实现序列化无损往返。

/* eslint-disable @typescript-eslint/no-explicit-any */
export function pinyinInlineStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('pinyinInline')
  const tracker = state.createTracker(info)
  const value = tracker.move(`${node.text ?? ''}[${node.pinyin ?? ''}]`)
  exit()
  return value
}
