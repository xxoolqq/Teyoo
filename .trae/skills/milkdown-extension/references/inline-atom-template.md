# 行内 atom 扩展七件套模板

占位符（复制后全局替换）：
- `<dir>`：目录名 kebab-case，如 `tianzi-grid`
- `<NODE>`：ProseMirror 节点名 snake_case，如 `tianzi_grid`
- `<Mdast>`：mdast 节点 type camelCase，如 `tianziGrid`
- `<Attr>`：主属性名，如 `raw` / `chars` / `pinyin`

## remark.ts

```ts
// 规约X：<名称> —— remark 插件
// 语法：<语法说明>；非法形态不识别，原样保留；代码块内天然不解析。

/* eslint-disable @typescript-eslint/no-explicit-any */
import { visit, SKIP } from 'unist-util-visit'

const RE_FOO = /<正则>/g

function splitFoo(value: string): any[] | null {
  const parts: any[] = []
  let last = 0
  let hit = false
  let m: RegExpExecArray | null
  RE_FOO.lastIndex = 0
  while ((m = RE_FOO.exec(value)) !== null) {
    // 合法性校验：非法 token continue 跳过
    hit = true
    if (m.index > last) parts.push({ type: 'text', value: value.slice(last, m.index) })
    parts.push({ type: '<Mdast>', <Attr>: m[1] })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
  return parts
}

export function remark<Name>(): (tree: unknown) => void {
  return (tree) => {
    visit(tree as any, 'text', (node: any, index: any, parent: any) => {
      if (!parent || index === undefined || index === null) return undefined
      const parts = splitFoo(String(node.value ?? ''))
      if (!parts) return undefined
      parent.children.splice(index, 1, ...parts)
      return [SKIP, index + parts.length]
    })
  }
}
```

## schema.ts

```ts
// 规约X：<名称> —— inline atom 节点
// 节点名：<NODE>；数据全部放 attrs，content:''。
// 为什么 atom：<占位节点无内部文本 / 避免输入落入节点内部>

import { $nodeSchema } from '@milkdown/kit/utils'

export const <Name>Schema = $nodeSchema('<NODE>', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  content: '',
  attrs: {
    <Attr>: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span.<class>[data-<attr>]',
      getAttrs: (dom: HTMLElement | string) => {
        if (typeof dom === 'string') return { <Attr>: '' }
        return { <Attr>: dom.getAttribute('data-<attr>') ?? '' }
      },
    },
  ],
  toDOM: (node) => [
    'span',
    { class: '<class>', 'data-<attr>': node.attrs.<Attr> },
    /* 子元素或文本 */
  ],
  parseMarkdown: {
    match: (node) => (node as { type: string }).type === '<Mdast>',
    runner: (state, node, type) => {
      state.addNode(type, {
        <Attr>: (node as { <Attr>?: string }).<Attr> ?? '',
      })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === '<NODE>',
    runner: (state, node) => {
      // 第 4 参 props 才会展开到 mdast 节点上
      state.addNode('<Mdast>', undefined, undefined, {
        <Attr>: node.attrs.<Attr>,
      })
    },
  },
}))
```

多格子/复合渲染：一个 token = **一个** atom 节点（attrs 存原始 token），toDOM 里展开多个子 span。否则序列化会把 `++你好++` 散成 `++你++++好++`。

## input-rule.ts

```ts
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { TextSelection } from '@milkdown/kit/prose/state'
import { $inputRule } from '@milkdown/kit/utils'
import { <Name>Schema } from './schema'

const RE_INPUT = /<正则>$/

export const <Name>InputRule = $inputRule((ctx) => {
  return new InputRule(RE_INPUT, (state, match, start, end) => {
    // 非法输入 return null（保留普通文本）
    const type = <Name>Schema.type(ctx)
    const node = type.create({ <Attr>: match[1] })
    const tr = state.tr
    tr.delete(start, end)                       // 1. 删匹配区间
    tr.insert(start, node)                      // 2. 插 atom 节点
    tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize)) // 3. 光标移后
    return tr
  })
})
```

## stringify.ts

```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
export function <name>StringifyHandler(node: any, _parent: any, state: any, info: any): string {
  const exit = state.enter('<Mdast>')
  const tracker = state.createTracker(info)
  const value = tracker.move(`<原样语法拼回>`)
  exit()
  return value
}
```

## plugin.ts / index.ts

```ts
// plugin.ts
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { <Name>Schema } from './schema'
import { <Name>InputRule } from './input-rule'
export const <name>Plugin = [<Name>Schema, <Name>InputRule] as unknown as MilkdownPlugin[]
```

```ts
// index.ts
export { remark<Name> } from './remark'
export { <name>StringifyHandler } from './stringify'
export { <Name>Schema } from './schema'
export { <Name>InputRule } from './input-rule'
export { <name>Plugin } from './plugin'
```

style.css 按视觉需要写；内联组件用 inline-flex 列布局时给拼音/标注行固定高度，保证多格底部对齐。

## editor.ts 接入片段

```ts
// 顶部 import 区
import { <name>Plugin, remark<Name>, <name>StringifyHandler } from '../../extensions/<dir>'
// CSS import 区
import '../../extensions/<dir>/style.css'
// remarkPluginsCtx 数组内
{ plugin: remark<Name>, options: {} },
// handlers 对象内
<Mdast>: <name>StringifyHandler,
// .use 链
.use(<name>Plugin)
```
