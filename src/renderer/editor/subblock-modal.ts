// 子块模态框 —— 规约F 子块（sub_block）的插入与编辑
//
// 工具栏「子块」按钮 → show()：插入模式，在光标处生成 sub_block 节点
//   - 文本内容（textarea，多行 → 多段落，支持 Markdown marks）
//   - boxed（是否带边框）
//   - align（left / center / right）
// 双击已存在 sub_block 节点 → show(attrs, pos)：编辑模式
//   - 编辑 attrs（boxed / align）+ 文本内容
//   - 文本字段回显完整 Markdown 源码（保留 **、@..@、<u> 等标记）

import { getEditorView, parseMarkdownToNodes, serializeNodeToMarkdown } from './editor'
import { type UiLanguage } from '../ui-language'

export interface SubBlockAttrs {
  boxed: boolean
  align: string // 'left' | 'center' | 'right'
  text: string // 首段文本（插入模式使用，编辑模式从首段读取）
}

const DEFAULT_ATTRS: SubBlockAttrs = { boxed: true, align: 'left', text: '' }

const ALIGN_OPTIONS: { value: string; zh: string; en: string }[] = [
  { value: 'left', zh: '左对齐', en: 'Left' },
  { value: 'center', zh: '居中', en: 'Center' },
  { value: 'right', zh: '右对齐', en: 'Right' },
]

export class SubBlockModal {
  private container: HTMLDivElement
  private header: HTMLHeadingElement
  private textArea: HTMLTextAreaElement
  private boxedCheckbox: HTMLInputElement
  private boxedLabel: HTMLSpanElement
  private alignSelect: HTMLSelectElement
  private cancelButton: HTMLButtonElement
  private saveButton: HTMLButtonElement
  // 编辑模式：原节点位置；null 表示插入模式
  private currentTarget: { pos: number } | null = null
  private currentLanguage: UiLanguage = 'en'
  private isInsertMode = false

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'math-modal-overlay subblock-modal-overlay'
    this.container.style.display = 'none'

    const modal = document.createElement('div')
    modal.className = 'math-modal subblock-modal'

    const header = document.createElement('h3')
    this.header = header
    header.textContent = 'Insert Sub-block'

    // 字段：文本内容（textarea，多行 → 多段落）
    const textLabel = document.createElement('label')
    textLabel.className = 'image-modal-label'
    textLabel.textContent = 'Content'
    this.textArea = document.createElement('textarea')
    this.textArea.className = 'math-modal-input subblock-modal-textarea'
    this.textArea.rows = 4
    this.textArea.placeholder = 'Enter text content...'

    // 字段：boxed + align（同一行）
    const styleRow = document.createElement('div')
    styleRow.className = 'image-modal-cb-row'

    const boxedWrap = document.createElement('label')
    boxedWrap.className = 'image-modal-cb-item'
    this.boxedCheckbox = document.createElement('input')
    this.boxedCheckbox.type = 'checkbox'
    this.boxedCheckbox.checked = true
    this.boxedLabel = document.createElement('span')
    this.boxedLabel.className = 'image-modal-cb-label'
    this.boxedLabel.textContent = 'Border'
    boxedWrap.append(this.boxedCheckbox, this.boxedLabel)

    const alignWrap = document.createElement('div')
    alignWrap.className = 'image-modal-cb-item'
    const alignLabel = document.createElement('span')
    alignLabel.className = 'image-modal-cb-label'
    alignLabel.textContent = 'Align'
    this.alignSelect = document.createElement('select')
    this.alignSelect.className = 'image-modal-select'
    for (const opt of ALIGN_OPTIONS) {
      const o = document.createElement('option')
      o.value = opt.value
      o.textContent = opt.en
      this.alignSelect.appendChild(o)
    }
    alignWrap.append(alignLabel, this.alignSelect)

    styleRow.append(boxedWrap, alignWrap)

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
    modal.append(header, textLabel, this.textArea, styleRow, footer)
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
      // textarea 内 Ctrl+Enter 保存
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        this.save()
      }
    })

    document.body.appendChild(this.container)
  }

  setLanguage(language: UiLanguage): void {
    this.currentLanguage = language
    const zh = language === 'zh'
    this.header.textContent = zh ? '插入子块' : 'Insert Sub-block'
    this.textArea.placeholder = zh ? '输入文本内容…' : 'Enter text content...'
    this.boxedLabel.textContent = zh ? '边框' : 'Border'
    // align 标签在 styleRow 内，通过查找更新
    const alignLabelEl = this.alignSelect.parentElement?.querySelector('.image-modal-cb-label')
    if (alignLabelEl) alignLabelEl.textContent = zh ? '对齐' : 'Align'
    // 更新 align 下拉选项文案
    this.alignSelect.innerHTML = ''
    for (const opt of ALIGN_OPTIONS) {
      const o = document.createElement('option')
      o.value = opt.value
      o.textContent = zh ? opt.zh : opt.en
      this.alignSelect.appendChild(o)
    }
    this.cancelButton.textContent = zh ? '取消' : 'Cancel'
    this.saveButton.textContent = zh ? (this.isInsertMode ? '插入' : '更新') : (this.isInsertMode ? 'Insert' : 'Update')
  }

  /**
   * 插入模式：show() — 在光标处插入新 sub_block
   * 编辑模式：show(attrs, pos) — 更新已存在 sub_block 的 attrs
   */
  show(attrs?: SubBlockAttrs | null, targetPos?: number | null): void {
    this.isInsertMode = targetPos === undefined || targetPos === null
    this.currentTarget = targetPos != null ? { pos: targetPos } : null

    const a = attrs ?? DEFAULT_ATTRS
    this.textArea.value = a.text
    this.boxedCheckbox.checked = a.boxed
    this.alignSelect.value = a.align || 'left'

    const zh = this.currentLanguage === 'zh'
    this.header.textContent = zh ? (this.isInsertMode ? '插入子块' : '编辑子块') : (this.isInsertMode ? 'Insert Sub-block' : 'Edit Sub-block')
    this.saveButton.textContent = zh ? (this.isInsertMode ? '插入' : '更新') : (this.isInsertMode ? 'Insert' : 'Update')

    this.container.style.display = 'flex'
    setTimeout(() => {
      this.textArea.focus()
      this.textArea.select()
    }, 50)
  }

  hide(): void {
    this.container.style.display = 'none'
  }

  private save(): void {
    const view = getEditorView()
    if (!view) {
      this.hide()
      return
    }

    const text = this.textArea.value
    const newAttrs = {
      boxed: this.boxedCheckbox.checked,
      align: this.alignSelect.value,
    }

    if (this.currentTarget !== null) {
      // 编辑模式：更新 attrs + 文本内容（如果用户改了文本）
      const { pos } = this.currentTarget
      const node = view.state.doc.nodeAt(pos)
      if (!node || node.type.name !== 'sub_block') {
        this.hide()
        return
      }
      let tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...newAttrs })

      // 用序列化的 Markdown 与 textarea 内容比较，判断用户是否修改了文本
      const oldText = serializeNodeToMarkdown(node)
      if (oldText !== text) {
        // 重建整个 sub_block 内容：用 remark 管线解析 textarea 内容，保留 marks
        const start = pos + 1 // sub_block 开标签后
        const end = pos + node.nodeSize - 1 // sub_block 闭标签前
        const newNodes = text.trim()
          ? parseMarkdownToNodes(text)
          : [view.state.schema.nodes.paragraph.create()]
        if (newNodes.length > 0) {
          tr = tr.replaceWith(start, end, newNodes)
        }
      }
      view.dispatch(tr)
    } else {
      // 插入模式：在光标处创建 sub_block 节点
      const schema = view.state.schema
      const subBlockType = schema.nodes.sub_block
      if (!subBlockType) {
        console.error('sub_block schema not found. Is the columns plugin loaded?')
        this.hide()
        return
      }
      // 用 remark 管线解析 textarea 内容，保留 marks（bold/italic/emphDot 等）
      const paragraphs = text.trim()
        ? parseMarkdownToNodes(text)
        : [schema.nodes.paragraph.create()]
      const subBlockNode = subBlockType.create(newAttrs, paragraphs)
      const tr = view.state.tr.replaceSelectionWith(subBlockNode)
      view.dispatch(tr)
      view.focus()
    }

    this.hide()
  }
}

export const subBlockModal = new SubBlockModal()
