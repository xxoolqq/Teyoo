// 文字下划线 —— 桶文件
//
// 集中 re-export 本扩展的全部模块，方便调用方统一 import：
//   renderer 侧：import { underlinePlugin, remarkUnderline, underlineStringifyHandler }
//                from '../../extensions/underline'
//
// docx 导出：docx-export.ts 已有 <u>/</u> 遗留兼容（识别 html 节点对），
// 序列化产物即 <u>…</u> 文本，无需扩展侧再适配。

export { remarkUnderline } from './remark'
export { underlineStringifyHandler } from './stringify'
export { underlineAttr, underlineSchema } from './schema'
export { underlinePlugin } from './plugin'
