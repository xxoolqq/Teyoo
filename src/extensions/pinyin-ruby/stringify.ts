// 规约B：ruby 上方汉字拼音 —— remark-stringify handler
//
// 自定义 mdast 节点 pinyinRuby 默认 remark-stringify 不识别，
// 需注册 handler 让其原样输出 `汉字(拼音)`，实现序列化无损往返。
//
// atom 节点模式下，text 直接是属性，不再走 children；handler 直接输出
// `text(pinyin)` 即可，无需调用 containerPhrasing。

/* eslint-disable @typescript-eslint/no-explicit-any */
export function pinyinRubyStringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('pinyinRuby')
  const tracker = state.createTracker(info)
  // 输出 `汉字(拼音)`
  let value = tracker.move(`${node.text ?? ''}(${node.pinyin ?? ''})`)
  exit()
  return value
}
