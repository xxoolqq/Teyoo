// 分栏模态框 —— 规约F 分栏（cols）的插入与编辑
//
// 工具栏「分栏」按钮 → show()：插入模式，光标处插入新 cols 节点
//   - spec（'2' / '3' / '1:2' / '2:3'）
//   - 自动生成 N 个空子块（每个子块内含一个空段落）
// 点击已存在 cols 节点 → show(attrs, pos)：编辑模式
//   - 编辑 spec，子块数量会自动调整（增删）

import { getEditorView } from './editor'
import { type UiLanguage } from '../ui-language'
import { isValidSpec, columnCount, gridTemplate } from '../../extensions/columns/schema'

export interface ColsAttrs {
  spec: string // '2' | '3' | '1:2' | '2:3' 等
}

const DEFAULT_ATTRS: ColsAttrs = { spec: '2' }

export class ColsModal {
  private container: HTMLDivElement
  private header: HTMLHeadingElement
  private specInput: HTMLInputElement
  private hint: HTMLParagraphElement
  private preview: HTMLDivElement // 预览区：实时渲染分栏示例
  private cancelButton: HTMLButtonElement
  private saveButton: HTMLButtonElement
  private currentTarget: { pos: number } | null = null
  private currentLanguage: UiLanguage = 'en'
  private isInsertMode = false

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'math-modal-overlay cols-modal-overlay'
    this.container.style.display = 'none'

    const modal = document.createElement('div')
    modal.className = 'math-modal cols-modal'

    const header = document.createElement('h3')
    this.header = header
    header.textContent = 'Insert Columns'

    // spec 输入
    const specLabel = document.createElement('label')
    specLabel.className = 'image-modal-label'
    specLabel.textContent = 'Spec'
    this.specInput = document.createElement('input')
    this.specInput.type = 'text'
    this.specInput.className = 'image-modal-input'
    this.specInput.placeholder = 'e.g. 2, 3, 1:2, 2:3'
    this.specInput.addEventListener('input', () => this.updatePreview())

    // 预览区
    this.preview = document.createElement('div')
    this.preview.className = 'cols-modal-preview'

    // 提示文案
    this.hint = document.createElement('p')
    this.hint.className = 'cols-modal-hint'

    const footer = document.createElement('div')
    footer.className = 'math-modal-footer'

    const cancelBtn = document.createElement('button')
    this.cancelButton = cancelBtn
    cancelBtn.textContent = 'Cancel'
    cancelBtn.className = 'math-modal-btn cancel'
    cancelBtn.addEventListener('click', () => this.hide())

    const saveBtn = document.createElement('button')
    this.saveButton = saveBtn
    saveBtn.textContent = 'Insert'
    saveBtn.className = 'math-modal-btn save'
    saveBtn.addEventListener('click', () => this.save())

    footer.append(cancelBtn, saveBtn)
    modal.append(header, specLabel, this.specInput, this.preview, this.hint, footer)
    this.container.appendChild(modal)

    this.container.addEventListener('mousedown', (e) => {
      if (e.target === this.container) this.hide()
    })

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
  }

  setLanguage(language: UiLanguage): void {
    this.currentLanguage = language
    const zh = language === 'zh'
    this.header.textContent = zh ? (this.isInsertMode ? '插入分栏' : '编辑分栏') : (this.isInsertMode ? 'Insert Columns' : 'Edit Columns')
    this.specInput.placeholder = zh ? '如 2、3、1:2、2:3' : 'e.g. 2, 3, 1:2, 2:3'
    this.hint.textContent = zh
      ? 'N 列等宽（如 2）或 A:B 两列比例（如 1:2）'
      : 'Equal N columns (e.g. 2) or A:B ratio (e.g. 1:2)'
    this.cancelButton.textContent = zh ? '取消' : 'Cancel'
    this.saveButton.textContent = zh ? (this.isInsertMode ? '插入' : '更新') : (this.isInsertMode ? 'Insert' : 'Update')
    this.updatePreview()
  }

  show(attrs?: ColsAttrs | null, targetPos?: number | null): void {
    this.isInsertMode = targetPos === undefined || targetPos === null
    this.currentTarget = targetPos != null ? { pos: targetPos } : null

    const a = attrs ?? DEFAULT_ATTRS
    this.specInput.value = a.spec

    const zh = this.currentLanguage === 'zh'
    this.header.textContent = zh ? (this.isInsertMode ? '插入分栏' : '编辑分栏') : (this.isInsertMode ? 'Insert Columns' : 'Edit Columns')
    this.saveButton.textContent = zh ? (this.isInsertMode ? '插入' : '更新') : (this.isInsertMode ? 'Insert' : 'Update')

    this.updatePreview()
    this.container.style.display = 'flex'
    setTimeout(() => {
      this.specInput.focus()
      this.specInput.select()
    }, 50)
  }

  hide(): void {
    this.container.style.display = 'none'
  }

  /** 实时渲染预览分栏 + 更新 hint 文本 */
  private updatePreview(): void {
    const zh = this.currentLanguage === 'zh'
    const v = this.specInput.value.trim()
    this.preview.innerHTML = ''

    const valid = isValidSpec(v)
    if (valid) {
      // 合法 spec：渲染 grid，每格一个子块示例
      const count = columnCount(v)
      const grid = document.createElement('div')
      grid.className = 'cols-preview-grid'
      grid.style.gridTemplateColumns = gridTemplate(v)
      for (let i = 0; i < count; i++) {
        const cell = document.createElement('div')
        cell.className = 'cols-preview-cell'
        cell.textContent = zh ? `子块${i + 1}内容` : `Column ${i + 1} content`
        grid.appendChild(cell)
      }
      this.preview.appendChild(grid)
      this.hint.style.color = ''
      this.hint.textContent = v.includes(':')
        ? (zh ? `比例分栏：${v}（左:右）` : `Ratio columns: ${v} (left:right)`)
        : (zh ? `等宽分栏：${count} 列` : `Equal columns: ${count} columns`)
    } else {
      // 非法或空：显示默认 2 列示例 + 错误/提示
      const grid = document.createElement('div')
      grid.className = 'cols-preview-grid'
      grid.style.gridTemplateColumns = gridTemplate('2')
      for (let i = 0; i < 2; i++) {
        const cell = document.createElement('div')
        cell.className = 'cols-preview-cell'
        cell.textContent = zh ? `子块${i + 1}内容` : `Column ${i + 1} content`
        grid.appendChild(cell)
      }
      this.preview.appendChild(grid)
      this.hint.style.color = v ? '#d33' : ''
      if (v) {
        this.hint.textContent = zh
          ? '格式无效：请输入数字（如 2）或 数字:数字（如 1:2）'
          : 'Invalid spec: use number (e.g. 2) or N:N ratio (e.g. 1:2)'
      } else {
        this.hint.textContent = zh
          ? '示例：2 列等宽（输入数字 N 或 数字:数字 比例）'
          : 'Example: 2 equal columns (enter N or N:N ratio)'
      }
    }
  }

  private save(): void {
    const view = getEditorView()
    if (!view) {
      this.hide()
      return
    }

    const spec = this.specInput.value.trim()
    if (!isValidSpec(spec)) {
      const zh = this.currentLanguage === 'zh'
      this.hint.style.color = '#d33'
      this.hint.textContent = zh ? '格式无效：请输入数字（如 2）或 数字:数字（如 1:2）' : 'Invalid spec: use number (e.g. 2) or N:N ratio (e.g. 1:2)'
      return
    }

    const schema = view.state.schema
    const colsType = schema.nodes.cols
    const subBlockType = schema.nodes.sub_block
    if (!colsType || !subBlockType) {
      console.error('cols / sub_block schema not found. Is the columns plugin loaded?')
      this.hide()
      return
    }

    if (this.currentTarget !== null) {
      // 编辑模式：更新 spec，子块数量自动调整
      const { pos } = this.currentTarget
      const node = view.state.doc.nodeAt(pos)
      if (!node || node.type.name !== 'cols') {
        this.hide()
        return
      }

      const oldCount = node.childCount
      const newCount = columnCount(spec)
      const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, spec })

      if (newCount > oldCount) {
        // 新增子块：追加到末尾
        for (let i = oldCount; i < newCount; i++) {
          const newSub = subBlockType.create({ boxed: true, align: 'left' }, [schema.nodes.paragraph.create()])
          // 插入位置：cols 开标签后 + 旧子块总长度
          const insertPos = pos + 1 + node.content.size
          tr.insert(insertPos, newSub)
        }
      } else if (newCount < oldCount) {
        // 删除多余子块
        for (let i = oldCount - 1; i >= newCount; i--) {
          const subNode = node.child(i)
          const from = pos + 1 + node.content.cut(0, i).size
          const to = from + subNode.nodeSize
          tr.replaceWith(from, to, [])
        }
      }
      view.dispatch(tr)
    } else {
      // 插入模式：创建 cols + N 个空子块
      const count = columnCount(spec)
      const subs = Array.from({ length: count }, () =>
        subBlockType.create({ boxed: true, align: 'left' }, [schema.nodes.paragraph.create()])
      )
      const colsNode = colsType.create({ spec }, subs)
      const tr = view.state.tr.replaceSelectionWith(colsNode)
      view.dispatch(tr)
      view.focus()
    }

    this.hide()
  }
}

export const colsModal = new ColsModal()
