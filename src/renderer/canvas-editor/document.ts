import { ElementType } from '@hufe921/canvas-editor'
import type { IEditorData } from '@hufe921/canvas-editor'
import { isChinese } from '../ui-language'

/** 标签页标题：菜单项叫「新建类docx文档」（在「文件」菜单下），标签就用同样的说法。 */
export function canvasDocTabLabel(): string {
  return isChinese() ? '类docx文档' : 'DOCX-like'
}

/** 窗口标题（document.title）：与标签页标题同一套口径。 */
export function canvasDocWindowTitle(): string {
  return isChinese() ? '类docx文档' : 'DOCX-like Document'
}

/**
 * 新建文档的初始内容：一张空白纸。
 * canvas-editor 至少要有一个元素才会渲染出可落光标的行，所以给一个空文本元素
 * —— 打开就是干净的一页，光标在第一行，不预置任何示例文案。
 */
export function createCanvasDocData(): IEditorData {
  return {
    main: [{ type: ElementType.TEXT, value: '' }]
  }
}
