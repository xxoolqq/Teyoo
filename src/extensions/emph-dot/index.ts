// 规约A：字下着重号（点）—— 桶文件
//
// 集中 re-export 本规约的全部模块，方便调用方统一 import：
//   renderer 侧：import { emphDotPlugin, remarkEmphDot, emphDotStringifyHandler }
//                from '../../extensions/emph-dot'
//
// 注：本规约暂未实现 docx 导出（用户明确「暂时不需要」）。
// 若未来需要，再创建 ./docx.ts 并在此追加 export。

export { remarkEmphDot } from './remark'
export { emphDotStringifyHandler } from './stringify'
export { emphDotAttr, emphDotSchema } from './schema'
export { emphDotPlugin } from './plugin'
