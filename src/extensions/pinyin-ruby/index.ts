// 规约B：ruby 上方汉字拼音 —— 桶文件
//
// 集中 re-export 本规约的全部模块。
// 注：本规约暂未实现 docx 导出（与规约A 一致）。

export { remarkPinyinRuby } from './remark'
export { pinyinRubyStringifyHandler } from './stringify'
export { pinyinRubySchema } from './schema'
export { pinyinRubyInputRule } from './input-rule'
export { pinyinRubyPlugin } from './plugin'
export { convertPinyin } from './pinyin'
