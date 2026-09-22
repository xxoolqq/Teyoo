import { $view } from '@milkdown/kit/utils'
import { mathInlineSchema, mathBlockSchema } from '@milkdown/plugin-math'
import type { NodeViewConstructor } from '@milkdown/kit/prose/view'
import type { MilkdownPlugin } from '@milkdown/ctx'
import { onMathEngineChange, renderMath } from './registry'

// 公式节点 nodeView —— 接管 @milkdown/plugin-math 的默认 toDOM
// ────────────────────────────────────────────────────────────────────────────
// 默认 toDOM 硬编码 katex.render，没有引擎切换的接缝；这里用自定义 nodeView
// 把渲染改道到 math-engine/registry（当前引擎），并在引擎切换时立即重渲染。
//
// 与 mermaid-view 同样的约定：渲染产物（引擎生成的 DOM 变更）通过
// ignoreMutation 挡在 ProseMirror 之外，避免重绘循环。

interface MathLikeNode {
  type: { name: string }
  textContent: string
  attrs: { value?: string }
}

function createMathNodeView(node: MathLikeNode, displayMode: boolean) {
  const dom = document.createElement(displayMode ? 'div' : 'span')
  // class 沿用 base.css 现有的 .math-inline / .math-block 悬停与居中样式
  dom.className = displayMode ? 'math-block' : 'math-inline'
  dom.dataset.type = displayMode ? 'math_block' : 'math_inline'

  let currentNode = node
  let lastLatex = ''

  // math_inline 的 LaTeX 存在文本内容里；math_block 存在 attrs.value 里
  // （见 math-modal.ts 的写入方式，与 @milkdown/plugin-math 的 toDOM 一致）
  const latexOf = (n: MathLikeNode): string =>
    displayMode ? String(n.attrs.value ?? '') : n.textContent

  const render = (n: MathLikeNode): void => {
    lastLatex = latexOf(n)
    dom.dataset.value = lastLatex
    dom.replaceChildren(renderMath(lastLatex, displayMode))
  }

  render(node)
  // 引擎切换 → 立即用新引擎重渲染（偏好的"立即生效"）
  const unsubscribe = onMathEngineChange(() => render(currentNode))

  return {
    dom,
    update(nextNode: MathLikeNode): boolean {
      if (nextNode.type !== currentNode.type) return false
      currentNode = nextNode
      if (latexOf(nextNode) !== lastLatex) render(nextNode)
      return true
    },
    ignoreMutation: () => true,
    destroy: unsubscribe,
  }
}

// 显式标注为 MilkdownPlugin：$view 的推断类型引用了 plugin-math 内嵌的
// @milkdown/utils 实例（TS2742 不可移植类型），.use() 只需要插件本体的结构。
export const mathInlineView: MilkdownPlugin = $view(
  mathInlineSchema.node,
  (): NodeViewConstructor => (node) => createMathNodeView(node as unknown as MathLikeNode, false)
)

export const mathBlockView: MilkdownPlugin = $view(
  mathBlockSchema.node,
  (): NodeViewConstructor => (node) => createMathNodeView(node as unknown as MathLikeNode, true)
)
