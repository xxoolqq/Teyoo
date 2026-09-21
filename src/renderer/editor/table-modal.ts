// 表格插入模态框
//
// 工具栏「表格」按钮调用 show()：
//   1. 弹模态框，用户输入行数和列数
//   2. 点击「插入」或按 Enter 后调用 insertTable(rows, cols)
//   3. 行列数限制 1-20，非法值回退为 3

import { insertTable, getEditorView } from './editor'
import { isChinese, type UiLanguage } from '../ui-language'

export class TableModal {
  private container: HTMLDivElement
  private header: HTMLHeadingElement
  private rowsInput: HTMLInputElement
  private colsInput: HTMLInputElement
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

    // 行数
    const rowsLabel = document.createElement('label')
    rowsLabel.className = 'table-modal-label'
    const rowsText = document.createElement('span')
    rowsText.textContent = '行数'
    this.rowsInput = document.createElement('input')
    this.rowsInput.type = 'number'
    this.rowsInput.className = 'math-modal-input table-modal-input'
    this.rowsInput.value = '3'
    this.rowsInput.min = '1'
    this.rowsInput.max = '20'
    rowsLabel.append(rowsText, this.rowsInput)

    // 列数
    const colsLabel = document.createElement('label')
    colsLabel.className = 'table-modal-label'
    const colsText = document.createElement('span')
    colsText.textContent = '列数'
    this.colsInput = document.createElement('input')
    this.colsInput.type = 'number'
    this.colsInput.className = 'math-modal-input table-modal-input'
    this.colsInput.value = '3'
    this.colsInput.min = '1'
    this.colsInput.max = '20'
    colsLabel.append(colsText, this.colsInput)

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
    modal.append(header, rowsLabel, colsLabel, footer)
    this.container.appendChild(modal)

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
  }

  setLanguage(language: UiLanguage): void {
    this.currentLanguage = language
    const zh = language === 'zh'
    this.header.textContent = zh ? '插入表格' : 'Insert Table'
    this.rowsInput.previousElementSibling!.textContent = zh ? '行数' : 'Rows'
    this.colsInput.previousElementSibling!.textContent = zh ? '列数' : 'Columns'
    this.cancelButton.textContent = zh ? '取消' : 'Cancel'
    this.saveButton.textContent = zh ? '插入' : 'Insert'
  }

  show(): void {
    this.rowsInput.value = '3'
    this.colsInput.value = '3'
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
    const rows = Math.max(1, Math.min(20, parseInt(this.rowsInput.value, 10) || 3))
    const cols = Math.max(1, Math.min(20, parseInt(this.colsInput.value, 10) || 3))
    this.hide()
    insertTable(rows, cols)
  }
}

export const tableModal = new TableModal()
