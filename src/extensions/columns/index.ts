// 规约F：子块与分栏 —— 桶文件

export { remarkColumns } from './remark'
export { subBlockStringifyHandler, colsStringifyHandler } from './stringify'
export { subBlockSchema, colsSchema, gridTemplate, isValidSpec, columnCount } from './schema'
export { subBlockInputRule, colsInputRule } from './input-rule'
export { columnsExitKeymap } from './exit-keymap'
export { columnsPlugin } from './plugin'
export { scanRegions } from './lexer'
export type { Region, SubRegion, ColsSub, Align } from './lexer'
