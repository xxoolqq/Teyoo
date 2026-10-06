import { EditorMode, PageMode } from '@hufe921/canvas-editor'
import type { IEditorOption } from '@hufe921/canvas-editor'

/** 画布面板的容器 id：既是滚动容器，也是宿主（纸张）居中的参照。 */
export const PANEL_ID = 'canvas-editor-panel'

/** A4 @96dpi：794 × 1123 */
export const PAGE_WIDTH = 794
export const PAGE_HEIGHT = 1123

/** 四周页边距（≈2.54cm） */
const PAGE_MARGIN = 96

/** 正文可用宽度：图片按百分比指定宽度时以它为基准 */
export const PAGE_INNER_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2

/**
 * 类 docx 文档的编辑器选项：A4 纸 + 连续分页（PAGING）+ Word 默认页边距，
 * 让画布呈现「一页一页」的文档观感，而不是 Markdown 那种无限长卷。
 *
 * @param scrollSelector 该标签页自己的滚动容器（每个标签页一份，selector 必须唯一）。
 */
export function createCanvasEditorOptions(scrollSelector: string): IEditorOption {
  return {
    mode: EditorMode.EDIT,
    pageMode: PageMode.PAGING,
    // 纸张尺寸固定写死：canvas-editor 会把宿主宽度设成这个值（见 _formatContainer），
    // 让它随容器伸缩的话「纸」就会跟着窗口变宽，也就没有居中可言了。
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    // 与 Word 中文默认字体一致；列表里没有该字体时浏览器回落，不影响排版。
    defaultFont: 'Microsoft YaHei',
    defaultSize: 14,
    // 行距倍数（Word 的「1.15 倍行距」观感）
    defaultRowMargin: 1.2,
    // 四周留 ~96px（≈2.54cm）页边距
    margins: [PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN, PAGE_MARGIN],
    pageGap: 20,
    // 滚动容器 = 该标签页自己的滚动区。不指定时 canvas-editor 把 document 当
    // 滚动容器，而本窗口的文档区是固定视口（body 不滚动），结果就是第二页
    // 既看不见也滚不过去 —— 看起来「只能写一页」。
    scrollContainerSelector: scrollSelector
  }
}
