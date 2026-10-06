// ─── 工具栏里那几个要落到窗口/文件上的动作 ────────────────────────────────
// 打开特殊字符面板是实例上的命令；导入/导出 md、导入 json 则要读文件、开标签页
// —— 后者走主进程通道（preload 的 pickCanvasMarkdown / saveCanvasMarkdown /
// pickCanvasJson）与 host 的钩子。画布 ↔ Markdown 的转换见 markdown/（自己
// 实现的那份）；JSON 是 canvas-editor 原生格式，直接 setValue。

import type { Editor, IEditorData } from '@hufe921/canvas-editor'
import { getCanvasDocHooks, type CanvasDocInit } from '../host'
import { exportMarkdown } from '../markdown/export-markdown'
import { fillImageSizes, markdownToElements } from '../markdown/import-markdown'
import { PAGE_INNER_WIDTH } from '../options'

/** 官方特殊字符插件挂上的命令（它的类型增强里声明） */
export function openSpecialCharacters(editor: Editor): void {
  editor.command.executeOpenSpecialCharactersDialog()
}

/**
 * 选一个 .md → 解析成画布元素 → 开一个新标签页承载（不动当前文档）。
 * 已停用：工具栏里的「导入 Markdown」被撤下（用户要求），本函数保留未删 ——
 * 恢复时放开 menu-html.ts 的 li、menu.ts 的 import 与分支即可。
 */
export async function importMarkdownIntoNewTab(): Promise<void> {
  const picked = await window.electronAPI.pickCanvasMarkdown()
  if (!picked?.content) return
  const elements = markdownToElements(picked.content)
  // 图片没有宽高就画不出来，得先把图加载一遍量尺寸（异步），再落进画布
  await fillImageSizes(elements, PAGE_INNER_WIDTH)
  const init: CanvasDocInit = editor => {
    editor.command.executeAppendElementList(elements)
  }
  await getCanvasDocHooks().newTab(init)
}

/**
 * 选一个「导出 JSON」落盘的 .json → 新标签页整体载入。
 * JSON 是 canvas-editor 自己的 getValue() 产物，元素树原样还原（含表格、控件、
 * 公式、图片尺寸 —— 不像 Markdown 导入要重建），setValue 整体替换即可，与官方
 * demo 的「导入 JSON」同一条路径（CommandAdapt.setValue，门面名 executeSetValue）。
 * 主进程已校验形状，这里只管装载。
 */
export async function importJsonIntoNewTab(): Promise<void> {
  const picked = await window.electronAPI.pickCanvasJson()
  if (!picked?.data) return
  const data = picked.data as IEditorData
  const init: CanvasDocInit = editor => {
    editor.command.executeSetValue(data)
  }
  await getCanvasDocHooks().newTab(init)
}

/** 画布 → md 文本落盘；拿到路径后在窗口里开一个标签页看结果 */
export async function exportMarkdownToDisk(editor: Editor): Promise<void> {
  const markdown = exportMarkdown(editor.command.getValue())
  const saved = await window.electronAPI.saveCanvasMarkdown(markdown, 'canvas-doc')
  if (!saved) return
  await getCanvasDocHooks().openPath(saved)
}
