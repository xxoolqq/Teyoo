// 通用上下标（化学式）—— 下标 `_{x}` 的 micromark tokenize 层扩展
//
// 为什么下标必须做在 micromark（tokenizer）层而不是 mdast 扫描层：
//   `_` 是 CommonMark 的强调（emphasis）定界符。remark-parse 用 micromark
//   完成 token 化，`Ba_{3}(PO_{4})_{2} 与 SO_{4}^{2-}` 这类一句多个下标的
//   场景里，micromark 的 emphasis 会在 token 阶段把可配对的 `_` 吞成 em
//   节点（`_` 前为 `)`/`}` 等标点、后为 `{` 时可开，后面再遇字母后的 `_`
//   即可闭），mdast 层根本看不到完整的 `_{x}` 字面量，任何后置扫描都救不回。
//   解法：注册一个同样以 `_` 为触发字符的 text construct——micromark 会把
//   扩展的 construct 排在默认 emphasis 之前尝试；`_` 后紧跟 `{` 时整体消费
//   `_{...}`，emphasis 不再参与；不满足（如 `_abc`）时 nok 回退，`_` 仍按
//   原生强调/字面处理，行为完全向后兼容。
//
// 上标 `^{x}` 不需要这层：`^` 不是任何 markdown 定界符，mdast 后置扫描
// 即可（见 remark.ts，与 circled-sup 同模式）。
//
// token 结构：
//   colamdSubscript        容器 token（enter/exit 之间夹一个 data）
//     └ data               内容文本 token —— mdast-util-from-markdown 对
//                          'data' 有内置 handler，自动成为 text 子节点
//
// 语法边界（非法一律不识别，回退为普通文本/原生强调）：
//   - `_` 后必须紧跟 `{`；内容非空、不含空白/`{`/`}`、不含换行
//   - `_{}`、`_{a b}`、`_{a`、跨行 `_{a\nb}` → 不识别
//   - 代码内不触发（micromark 的 code construct 优先级更高，天然隔离）

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Extension } from 'micromark-util-types'

// charCode：95 = `_`，123 = `{`，125 = `}`
function tokenizeSubscript(this: any, effects: any, ok: any, nok: any): any {
  let seenText = false
  return start

  // 此时代码指针在 `_` 上
  function start(code: number): any {
    effects.enter('colamdSubscript')
    effects.consume(code)
    return openBrace
  }

  // `_` 的下一个字符必须是 `{`
  function openBrace(code: number): any {
    if (code !== 123) return nok(code)
    effects.consume(code)
    return content
  }

  // 内容：非空白且非花括号的连续字符
  function content(code: number): any {
    // EOF / 换行 / 空白 / 嵌套 `{` → 整体回退
    if (code === null || code === 10 || code === 13 || code === 32 || code === 9 || code === 123) {
      return nok(code)
    }
    if (code === 125) {
      // `}`：空内容 `_{}` 不识别
      if (!seenText) return nok(code)
      // 两条硬约束：
      //   1. data 必须在 `}` 前 exit（marker 的 mdast 文本范围不含 `}`，
      //      否则序列化时 `}` 进入内容 → 往返 `_{x}}`）
      //   2. consume 时最后一个 event 必须是 enter（micromark dev 版断言
      //      「expected last token to be open」，production 版无断言）——
      //      所以 `}` 由专用 marker token 覆盖消费；fromMarkdown 主循环
      //      对无 handler 的 token 直接跳过，marker 无副作用
      effects.exit('data')
      effects.enter('colamdSubscriptMarker')
      effects.consume(code)
      effects.exit('colamdSubscriptMarker')
      effects.exit('colamdSubscript')
      // 闭合符已消费，必须返回 ok 函数本体，由框架以「下一个字符」续跑；
      // 若写 ok(code) 会把已消费的 `}` 再喂给外层解析器（`}` 重复输出）
      return ok
    }
    // 首个内容字符：开一个 data token（mdast 内置处理 → text 子节点）
    if (!seenText) {
      effects.enter('data')
      seenText = true
    }
    effects.consume(code)
    return content
  }
}

/** micromark 扩展：text 层、触发字符 `_`（95），抢在默认 emphasis 之前 */
export const micromarkSubscript: Extension = {
  text: {
    95: [
      {
        name: 'colamdSubscript',
        tokenize: tokenizeSubscript,
      },
    ],
  },
}

/** mdast-util 扩展：colamdSubscript token → { type: 'subscript', children } */
export const subscriptFromMarkdown = {
  enter: {
    colamdSubscript(this: any, token: any): void {
      this.enter({ type: 'subscript', children: [] }, token)
    },
  },
  exit: {
    colamdSubscript(this: any, token: any): void {
      this.exit(token)
    },
  },
}
