// 表格插入模态框
//
// 工具栏「表格」按钮调用 show()：
//   1. 弹模态框，行数/列数横向并排（「行数 × 列数」），下方实时预览表格形态
//   2. 预览随输入实时刷新（首行为表头样式，模拟实际插入效果）
//   3. 点击「插入」或按 Enter 后调用 insertTable(rows, cols)
//   4. 行列数限制 1-20，非法值回退为 3；模态框尺寸与田字格/分栏模态框一致
//      （480 × 360-560，固定大小）

import { insertTable, getEditorView } from './editor'
import { isChinese, type UiLanguage } from '../ui-language'

// 行列数上下限（与 save 时一致）
const MIN = 1
const MAX = 20
const DEFAULT = 3

/** 解析输入并夹到 [MIN, MAX]，非法回退 DEFAULT */
function clamp(value: string): number {
  const n = parseInt(value, 10)
  return Math.max(MIN, Math.min(MAX, Number.isNaN(n) ? DEFAULT : n))
}

export class TableModal {
  private container: HTMLDivElement
  private header: HTMLHeadingElement
  private rowsInput: HTMLInputElement
  private colsInput: HTMLInputElement
  private rowsText: HTMLSpanElement
  private colsText: HTMLSpanElement
  private previewGrid: HTMLDivElement
  private cancelButton: HTMLButtonElement
  private saveButton: HTMLButtonElement
  private currentLanguage: UiLanguage = 'en'

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'math-modal-overlay table-modal-overlay'
    this.container.style.display = 'none'

    const modal = document.createElement('div')
    modal.className = 'math-modal table-modal'

    const header = document.createElement('h3')
    this.header = header
    header.textContent = '插入表格'

    // 行数 × 列数：横向并排一行
    const fields = document.createElement('div')
    fields.className = 'table-modal-fields'

    const rowsLabel = document.createElement('label')
    rowsLabel.className = 'table-modal-label'
    this.rowsText = document.createElement('span')
    this.rowsText.textContent = '行数'
    this.rowsInput = document.createElement('input')
    this.rowsInput.type = 'number'
    this.rowsInput.className = 'math-modal-input table-modal-input'
    this.rowsInput.value = String(DEFAULT)
    this.rowsInput.min = String(MIN)
    this.rowsInput.max = String(MAX)
    rowsLabel.append(this.rowsText, this.rowsInput)

    const times = document.createElement('span')
    times.className = 'table-modal-times'
    times.textContent = '×'

    const colsLabel = document.createElement('label')
    colsLabel.className = 'table-modal-label'
    this.colsText = document.createElement('span')
    this.colsText.textContent = '列数'
    this.colsInput = document.createElement('input')
    this.colsInput.type = 'number'
    this.colsInput.className = 'math-modal-input table-modal-input'
    this.colsInput.value = String(DEFAULT)
    this.colsInput.min = String(MIN)
    this.colsInput.max = String(MAX)
    colsLabel.append(this.colsText, this.colsInput)

    fields.append(rowsLabel, times, colsLabel)

    // 预览区：实时渲染 rows × cols 网格（首行表头样式）
    const preview = document.createElement('div')
    preview.className = 'table-modal-preview'
    this.previewGrid = document.createElement('div')
    this.previewGrid.className = 'table-preview-grid'
    preview.append(this.previewGrid)

    const footer = document.createElement('div')
    footer.className = 'math-modal-footer'

    const cancelBtn = document.createElement('button')
    this.cancelButton = cancelBtn
    cancelBtn.textContent = '取消'
    cancelBtn.className = 'math-modal-btn cancel'
    cancelBtn.addEventListener('click', () => this.hide())

    const saveBtn = document.createElement('button')
    this.saveButton = saveBtn
    saveBtn.textContent = '插入'
    saveBtn.className = 'math-modal-btn save'
    saveBtn.addEventListener('click', () => this.save())

    footer.append(cancelBtn, saveBtn)
    modal.append(header, fields, preview, footer)
    this.container.appendChild(modal)

    // 输入实时刷新预览
    this.rowsInput.addEventListener('input', () => this.updatePreview())
    this.colsInput.addEventListener('input', () => this.updatePreview())

    // 点击遮罩关闭
    this.container.addEventListener('mousedown', (e) => {
      if (e.target === this.container) this.hide()
    })

    // Esc 关闭，Enter 保存
    this.container.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.hide()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        this.save()
      }
    })

    document.body.appendChild(this.container)
    this.currentLanguage = isChinese() ? 'zh' : 'en'
    this.setLanguage(this.currentLanguage)
    this.updatePreview()
  }

  setLanguage(language: UiLanguage): void {
    this.currentLanguage = language
    const zh = language === 'zh'
    this.header.textContent = zh ? '插入表格' : 'Insert Table'
    this.rowsText.textContent = zh ? '行数' : 'Rows'
    this.colsText.textContent = zh ? '列数' : 'Columns'
    this.cancelButton.textContent = zh ? '取消' : 'Cancel'
    this.saveButton.textContent = zh ? '插入' : 'Insert'
  }

  show(): void {
    this.rowsInput.value = String(DEFAULT)
    this.colsInput.value = String(DEFAULT)
    this.updatePreview()
    this.container.style.display = 'flex'
    setTimeout(() => {
      this.rowsInput.focus()
      this.rowsInput.select()
    }, 50)
  }

  hide(): void {
    this.container.style.display = 'none'
    const view = getEditorView()
    if (view) view.focus()
  }

  private save(): void {
    const rows = clamp(this.rowsInput.value)
    const cols = clamp(this.colsInput.value)
    this.hide()
    insertTable(rows, cols)
  }

  /** 按当前行列数重建预览网格（首行表头底色模拟 GFM 表头） */
  private updatePreview(): void {
    const rows = clamp(this.rowsInput.value)
    const cols = clamp(this.colsInput.value)
    this.previewGrid.style.gridTemplateColumns = `repeat(${cols}, 56px)`
    this.previewGrid.replaceChildren()
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('div')
        cell.className = 'table-preview-cell' + (r === 0 ? ' header' : '')
        this.previewGrid.appendChild(cell)
      }
    }
  }
}

export const tableModal = new TableModal()
