// 规约H：字体大小规约 —— 桶文件
//
// 集中 re-export 本规约的全部模块，方便 editor.ts 统一 import。
// 本期不含 docx 导出（用户明确「暂时不需要」）。
// 若未来需要，再创建 ./docx.ts 并在此追加 export。

export { remarkFontBlock, remarkFontSpan } from './remark'
export { fontBlockStringifyHandler, fontSpanStringifyHandler } from './stringify'
export { fontBlockSchema, fontSpanSchema, fontSpanAttr } from './schema'
export { fontStylePlugin } from './plugin'
export { fontBlockExitKeymap } from './exit-keymap'
export type { FontAttrs } from './lib'
export { parseFontAttrs, serializeAttrs, buildBlockStyle, buildInlineStyle } from './lib'
