// 通用上下标（化学式）—— remark 插件
//
// 一个 unified 插件承载两半：
//   1. 下标 `_{x}`：在 attacher 阶段挂 micromark 扩展（tokenize 层抢在
//      emphasis 之前消费，见 micromark-subscript.ts）+ mdast 扩展（token→
//      subscript 节点）。
//   2. 上标 `^{x}`：mdast 后置扫描。`^` 不是 markdown 定界符，不存在被
//      tokenizer 吞掉的问题，与 circled-sup 同模式。
//
// 注册顺序约束（editor.ts 的 remarkPluginsCtx）：
//   remarkCircledSup 必须在本插件**之前**——`字^{12}`（汉字+纯数字）由
//   带圈序号优先消费成 circledSup 节点，本插件的扫描只会见到剩余文本，
//   `字^{2-}`/`x^{2}` 这类带圈规则覆盖不到的形态才落进通用上标。
//   docx 导出（main 进程）复用解析器时同样要保持该顺序。
//
// mdast 节点协议：
//   { type: 'subscript',   children: [text] }  ← micromark 层产出
//   { type: 'superscript', children: [text] }  ← 本文件扫描产出
//   消费端见 schema.ts（subscript/superscript 两个 mark）。
//
// 不解析场景：代码内不解析（code 的 value 不作为 text 遍历）；`\^`/`\_`
// 转义后反斜杠已被 remark-parse 消费，无法与字面量区分，与现有扩展同水位。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'
import { micromarkSubscript, subscriptFromMarkdown } from './micromark-subscript'

// 上标正则（单 text 节点内）：\^\{([^{}\s]+)\}
// 紧贴约束不能只靠 lookbehind 一刀切：micromark 消费完 `_{x}` 后，紧随的
// `^{2-}` 会成为**新 text 节点的开头**（SO_{4}^{2-} 场景），该节点内没有
// 前一字符，lookbehind 必失败。因此按匹配位置分两种情况：
//   - index > 0：前一字符必须存在且非空白/`{`（`}` 允许，覆盖 f(x)^{2}）
//   - index === 0：仅当前方还有兄弟内联节点才算「紧贴」（下标/加粗等节点
//     与 `^{...}` 紧邻时后者会开新 text 节点）；段首/行首不识别。
//     相邻内联节点之间的空白一定留在后一个 text 节点开头，故此规则精确。
//   [^{}\s]+     内容：非空白非花括号（空内容/含空白不识别）
const RE_SUPERSCRIPT = /\^\{([^{}\s]+)\}/g

// 把一个 text 节点的 value 切成 [text?, superscript, text?, ...]
// allowAtStart：本 text 节点前是否还有兄弟内联节点（决定 index 0 处是否识别）
function splitSuperscript(value: string, allowAtStart: boolean): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_SUPERSCRIPT.lastIndex = 0
  while ((m = RE_SUPERSCRIPT.exec(value)) !== null) {
    // 紧贴检查：节点开头看兄弟节点，节点内部看前一字符
    if (m.index === 0 ? !allowAtStart : /[\s{]/.test(value[m.index - 1])) {
      continue
    }
    hit = true
    if (m.index > last) {
      parts.push({ type: 'text', value: value.slice(last, m.index) })
    }
    parts.push({
      type: 'superscript',
      children: [{ type: 'text', value: m[1] }],
    })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < value.length) {
    parts.push({ type: 'text', value: value.slice(last) })
  }
  return parts
}

export function remarkSubSup(this: any): any {
  // attacher 阶段：挂 tokenize 层（下标）与 mdast 层（token→节点）扩展。
  // data key 与 remark-gfm 同名：'micromarkExtensions' / 'fromMarkdownExtensions'。
  // 注意必须以方法调用（this.data(...)）保持 this 绑定，解构后会丢 this。
  this.data('micromarkExtensions', [micromarkSubscript])
  this.data('fromMarkdownExtensions', [subscriptFromMarkdown])

  // transformer 阶段：后置扫描上标 `^{x}`
  return (tree: unknown) => {
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      if (!parent || index === undefined || index === null) return undefined
      const allowAtStart = index > 0
      const parts = splitSuperscript(String(node.value ?? ''), allowAtStart)
      if (!parts) return undefined
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}
