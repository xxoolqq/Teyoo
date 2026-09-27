// 圈号模态框 —— 仿 math-modal.ts，单数字输入
//
// 工具栏「圈号」按钮调用 show()：
//   1. 用户在编辑器中先键入汉字，光标停在汉字之后
//   2. 点击工具栏按钮，弹模态框输入数字
//   3. 保存时取光标前一个字符（须为单个汉字 [\u4e00-\u9fa5]），
//      delete(pos-1, pos) 把它从文本中删掉，
//      在 pos-1 处插入 circled_sup 原子节点（char=该汉字, num=输入数字），
//      把选区移到节点之后。
//
// 与 math-modal 的关键差异：
//   - 单行 input 而非 textarea（输入为纯数字串）
//   - 没有编辑模式分支：本模态框仅用于插入新节点；
//     点击已存在的 circled_sup 节点无特殊处理（PM 选中节点后用户可删除重插）
//   - save 依赖光标上下文（前一个汉字），而非把整段文本封装成节点

import { getEditorView } from './editor'
import { isChinese, type UiLanguage } from '../ui-language'
import { TextSelection } from '@milkdown/kit/prose/state'

export class CircledSupModal {
  private container: HTMLDivElement
  private header: HTMLHeadingElement
  private input: HTMLInputElement
  private hint: HTMLParagraphElement
  private preview: HTMLDivElement // 预览区：实时渲染汉字+带圈序号示例
  private cancelButton: HTMLButtonElement
  private saveButton: HTMLButtonElement
  private currentLanguage: UiLanguage = 'en'

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'math-modal-overlay circled-sup-modal-overlay'
    this.container.style.display = 'none'

    const modal = document.createElement('div')
    modal.className = 'math-modal circled-sup-modal'

    const header = document.createElement('h3')
    this.header = header
    header.textContent = 'Insert Circled Number'

    this.input = document.createElement('input')
    this.input.type = 'text'
    this.input.className = 'math-modal-input circled-sup-modal-input'
    this.input.inputMode = 'numeric'
    this.input.pattern = '\\d+'
    this.input.placeholder = 'e.g. 12'
    this.input.addEventListener('input', () => this.updatePreview())

    // 预览区：复用 circled-sup 扩展的 DOM 结构（span.circled-sup > char + sup.circled-num）
    this.preview = document.createElement('div')
    this.preview.className = 'circled-sup-modal-preview'

    // 提示文字：解释依赖光标前汉字
    this.hint = document.createElement('p')
    this.hint.className = 'circled-sup-modal-hint'

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
    modal.append(header, this.input, this.preview, this.hint, footer)
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
      // 单行 input：Enter 直接保存（无需 Ctrl 修饰）
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
    this.header.textContent = zh ? '插入圈号' : 'Insert Circled Number'
    this.input.placeholder = zh ? '例如 12' : 'e.g. 12'
    this.hint.textContent = zh
      ? '将光标置于汉字之后，输入数字后在汉字右上角生成带圈序号'
      : 'Place cursor right after a Chinese character, then enter the number'
    this.cancelButton.textContent = zh ? '取消' : 'Cancel'
    this.saveButton.textContent = zh ? '插入' : 'Insert'
    this.updatePreview()
  }

  /** 实时渲染预览：示例汉字 + 输入数字的带圈上标（空输入用示例 12） */
  private updatePreview(): void {
    const num = this.input.value.trim()
    const displayNum = /^\d+$/.test(num) ? num : '12'

    this.preview.innerHTML = ''
    const wrap = document.createElement('span')
    wrap.className = 'circled-sup'
    const charSpan = document.createElement('span')
    charSpan.className = 'circled-sup-char'
    charSpan.textContent = '字'
    const sup = document.createElement('sup')
    sup.className = 'circled-num'
    sup.textContent = displayNum
    wrap.append(charSpan, sup)
    this.preview.appendChild(wrap)
  }

  show(): void {
    this.input.value = ''
    this.updatePreview()
    this.container.style.display = 'flex'
    setTimeout(() => {
      this.input.focus()
      this.input.select()
    }, 50)
  }

  hide(): void {
    this.container.style.display = 'none'
    const view = getEditorView()
    if (view) view.focus()
  }

  private save(): void {
    const num = this.input.value.trim()
    // 必须是纯数字串（schema 限定 \d+）
    if (!/^\d+$/.test(num)) {
      this.input.focus()
      this.input.select()
      return
    }

    const view = getEditorView()
    if (!view) {
      this.hide()
      return
    }

    // 光标位置（empty selection 时 from === to；range selection 时取 from 之前）
    const pos = view.state.selection.from
    if (pos < 1) {
      // 文档开头前没有字符可消费
      this.hide()
      return
    }

    // 取 pos-1 处字符；只接受单个汉字
    const char = view.state.doc.textBetween(pos - 1, pos, '')
    if (!char || !/[\u4e00-\u9fa5]/.test(char)) {
      // 光标前不是汉字 → 提示并退出
      this.hint.classList.add('circled-sup-modal-hint-error')
      setTimeout(() => this.hint.classList.remove('circled-sup-modal-hint-error'), 1500)
      this.hide()
      return
    }

    const type = view.state.schema.nodes.circled_sup
    if (!type) {
      console.error('circled_sup schema node not found. Is the circled-sup plugin loaded?')
      this.hide()
      return
    }

    const node = type.create({ char, num })
    // 先删 pos-1..pos 的字符，再在 pos-1 插入节点（删后位置不变）
    const tr = view.state.tr
    tr.delete(pos - 1, pos)
    tr.insert(pos - 1, node)
    // 选区移到节点之后，便于继续输入
    tr.setSelection(TextSelection.create(tr.doc, pos - 1 + node.nodeSize))
    view.dispatch(tr)
    this.hide()
  }
}

export const circledSupModal = new CircledSupModal()
