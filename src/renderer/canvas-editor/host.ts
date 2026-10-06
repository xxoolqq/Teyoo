// ─── 工具栏 ↔ main.ts 的钩子 ──────────────────────────────────────────────
// 工具栏上的「导入 md / 导出 md」要开新标签页、按路径打开文件，这些动作连同
// 状态都在 main.ts 里。直接 import 会成环：
//   main.ts → canvas-editor/index.ts → toolbar/menu.ts → io.ts → main.ts
// 所以由 main.ts 启动时把动作注册进来，工具栏用到时再取。

import type { Editor } from '@hufe921/canvas-editor'

/** 画布实例建好后立刻执行的动作（导入内容就落在这份新实例上） */
export type CanvasDocInit = (editor: Editor) => void | Promise<void>

export interface CanvasDocHooks {
  /** 开一个新的类 docx 标签页；init 在实例建好后执行 */
  newTab: (init?: CanvasDocInit) => void | Promise<void>
  /** 按路径在当前窗口打开文件（导出 md 后拿它开个标签页对照） */
  openPath: (path: string) => void | Promise<void>
}

let hooks: CanvasDocHooks | null = null

export function setCanvasDocHooks(next: CanvasDocHooks): void {
  hooks = next
}

export function getCanvasDocHooks(): CanvasDocHooks {
  if (!hooks) {
    throw new Error('canvas doc hooks 还没注册（main.ts 启动时应调用 setCanvasDocHooks）')
  }
  return hooks
}
