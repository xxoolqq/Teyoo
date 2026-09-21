// 规约G：汉字田字格 —— 桶文件

export { remarkTianziGrid } from './remark'
export { tianziGridStringifyHandler } from './stringify'
export { tianziGridSchema } from './schema'
export { tianziGridInputRule } from './input-rule'
export { tianziGridPlugin } from './plugin'
export { parseCells, RE_TIANZI, RE_TIANZI_INPUT } from './lib'
export type { TianziCell, TianziModel, TianziKind } from './lib'
