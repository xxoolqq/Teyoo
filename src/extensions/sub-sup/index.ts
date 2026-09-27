// 通用上下标（化学式）—— 桶文件
//
// 集中 re-export 本扩展的全部模块，方便调用方统一 import：
//   renderer 侧：import { subSupPlugin, remarkSubSup,
//                 subscriptStringifyHandler, superscriptStringifyHandler }
//               from '../../extensions/sub-sup'
//   main 侧（docx 导入，阶段2）：复用 remark.ts 的解析器，保持
//   circled-sup → sub-sup 的消费顺序。
//
// 渲染用原生 <sub>/<sup> 元素（浏览器默认样式），故无 style.css。

export { remarkSubSup } from './remark'
export { subscriptSchema, superscriptSchema } from './schema'
export { subscriptStringifyHandler, superscriptStringifyHandler } from './stringify'
export { subSupPlugin } from './plugin'
