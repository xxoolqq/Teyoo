// 拼音模态框 —— 合并规约B（上方拼音 ruby）与规约B2（同行平级拼音 inline）
//
// 工具栏「拼音」按钮 → show()：插入模式，光标处插入新节点
// 点击已存在 pinyin_ruby / pinyin_inline 节点 → show(attrs, pos, currentType)：编辑模式
//
// 模式切换：用户可选「上方拼音」（ruby，拼音在汉字上方）或「同行拼音」
// （inline，拼音在汉字右侧同一行）。两种节点 attrs 一致：{ text, pinyin }。
// 编辑模式下若用户切换了模式，用 tr.setNodeMarkup(pos, newType, attrs) 把节点
// 类型从 pinyin_ruby ↔ pinyin_inline 互转（PM 支持同位置改 type）。

import { getEditorView } from './editor'
import { isChinese, type UiLanguage } from '../ui-language'

// 两种节点类型名
type PinyinNodeType = 'pinyin_ruby' | 'pinyin_inline'

// 模式（与节点类型对应）
type PinyinMode = 'ruby' | 'inline'

// 编辑模式传入的完整数据
export interface PinyinAttrs {
  text: string
  pinyin: string
  mode: PinyinMode
}

const DEFAULT_ATTRS: PinyinAttrs = { text: '', pinyin: '', mode: 'ruby' }

const MODE_OPTIONS: { value: PinyinMode; zh: string; en: string }[] = [
  { value: 'ruby', zh: '上方拼音（ruby）', en: 'Above (ruby)' },
  { value: 'inline', zh: '同行拼音', en: 'Inline' },
]

export class PinyinModal {
  private container: HTMLDivElement
  private header: HTMLHeadingElement
  private textInput: HTMLInputElement
  private pinyinInput: HTMLInputElement
  private modeSelect: HTMLSelectElement
  private hint: HTMLParagraphElement
  private cancelButton: HTMLButtonElement
  private saveButton: HTMLButtonElement
  // 编辑模式：原节点位置 + 原节点类型；null 表示插入模式
  private currentTarget: { pos: number; type: PinyinNodeType } | null = null
  private currentLanguage: UiLanguage = 'en'
  private isInsertMode = false

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'math-modal-overlay pinyin-modal-overlay'
    this.container.style.display = 'none'

    const modal = document.createElement('div')
    modal.className = 'math-modal pinyin-modal'

    const header = document.createElement('h3')
    this.header = header
    header.textContent = 'Insert Pinyin'

    // 字段：text（汉字，可多字）
    const textRow = document.createElement('div')
    textRow.className = 'image-modal-row'
    const textCol = document.createElement('div')
    textCol.className = 'image-modal-col'
    const textLabel = this.makeLabel('pinyin-text', 'Chinese', '汉字')
    this.textInput = document.createElement('input')
    this.textInput.type = 'text'
    this.textInput.id = 'pinyin-text'
    this.textInput.className = 'image-modal-input'
    this.textInput.placeholder = '明'
    textCol.append(textLabel, this.textInput)
    textRow.appendChild(textCol)

    // 字段：pinyin（拼音，字母+数字声调，如 ming2）
    const pinyinRow = document.createElement('div')
    pinyinRow.className = 'image-modal-row'
    const pinyinCol = document.createElement('div')
    pinyinCol.className = 'image-modal-col'
    const pinyinLabel = this.makeLabel('pinyin-input', 'Pinyin', '拼音')
    this.pinyinInput = document.createElement('input')
    this.pinyinInput.type = 'text'
    this.pinyinInput.id = 'pinyin-input'
    this.pinyinInput.className = 'image-modal-input'
    this.pinyinInput.placeholder = 'ming2'
    pinyinCol.append(pinyinLabel, this.pinyinInput)
    pinyinRow.appendChild(pinyinCol)

    // 字段：mode（上方 / 同行）
    const modeRow = document.createElement('div')
    modeRow.className = 'image-modal-row'
    const modeCol = document.createElement('div')
    modeCol.className = 'image-modal-col'
    const modeLabel = this.makeLabel('pinyin-mode', 'Mode', '模式')
    this.modeSelect = document.createElement('select')
    this.modeSelect.id = 'pinyin-mode'
    this.modeSelect.className = 'image-modal-input image-modal-select'
    for (const opt of MODE_OPTIONS) {
      const o = document.createElement('option')
      o.value = opt.value
      o.textContent = opt.en
      this.modeSelect.appendChild(o)
    }
    modeCol.append(modeLabel, this.modeSelect)
    modeRow.appendChild(modeCol)

    // 提示
    this.hint = document.createElement('p')
    this.hint.className = 'circled-sup-modal-hint'

    // 底部按钮
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
    modal.append(header, textRow, pinyinRow, modeRow, this.hint, footer)
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
    this.currentLanguage = isChinese() ? 'zh' : 'en'
    this.setLanguage(this.currentLanguage)
  }

  private makeLabel(htmlFor: string, en: string, zh: string): HTMLLabelElement {
    const label = document.createElement('label')
    label.htmlFor = htmlFor
    label.textContent = en
    label.className = 'image-modal-label'
    label.dataset.zh = zh
    label.dataset.en = en
    return label
  }

  setLanguage(language: UiLanguage): void {
    this.currentLanguage = language
    const zh = language === 'zh'
    this.header.textContent = this.isInsertMode
      ? (zh ? '插入拼音' : 'Insert Pinyin')
      : (zh ? '编辑拼音' : 'Edit Pinyin')
    this.textInput.placeholder = zh ? '明' : '明'
    this.pinyinInput.placeholder = zh ? 'ming2（数字表声调）' : 'ming2 (tone as digit)'
    this.cancelButton.textContent = zh ? '取消' : 'Cancel'
    this.saveButton.textContent = this.isInsertMode
      ? (zh ? '插入' : 'Insert')
      : (zh ? '更新' : 'Update')
    this.hint.textContent = zh
      ? '拼音用数字表声调：1 阴平、2 阳平、3 上声、4 去声、5 轻声；如 ming2'
      : 'Tones as digits: 1=flat, 2=rising, 3=falling-rising, 4=falling, 5=neutral. e.g. ming2'
    this.container.querySelectorAll<HTMLElement>('[data-zh]').forEach((el) => {
      const v = el.dataset[zh ? 'zh' : 'en']
      if (v !== undefined && v !== null) el.textContent = v
    })
    Array.from(this.modeSelect.options).forEach((o, i) => {
      const opt = MODE_OPTIONS[i]
      o.textContent = zh ? opt.zh : opt.en
    })
  }

  /**
   * 显示模态框。
   * - 插入模式：show()（无参），mode 默认 ruby
   * - 编辑模式：show(attrs, pos, currentType)，其中 currentType 是原节点类型名
   */
  show(attrs: PinyinAttrs | null = null, targetPos: number | null = null, currentType: PinyinNodeType | null = null): void {
    this.currentTarget = (targetPos !== null && currentType !== null)
      ? { pos: targetPos, type: currentType }
      : null
    this.isInsertMode = this.currentTarget === null
    this.setLanguage(this.currentLanguage)

    const a = attrs ?? DEFAULT_ATTRS
    this.textInput.value = a.text
    this.pinyinInput.value = a.pinyin
    this.modeSelect.value = a.mode

    this.container.style.display = 'flex'

    setTimeout(() => {
      // 插入模式首聚焦汉字输入；编辑模式聚焦拼音便于改
      const focusEl = this.isInsertMode ? this.textInput : this.pinyinInput
      focusEl.focus()
      focusEl.select()
    }, 50)
  }

  hide(): void {
    this.container.style.display = 'none'
    this.currentTarget = null
    this.isInsertMode = false
    const view = getEditorView()
    if (view) view.focus()
  }

  private save(): void {
    const text = this.textInput.value.trim()
    const pinyin = this.pinyinInput.value.trim()
    const mode = this.modeSelect.value as PinyinMode

    // 同行平级（inline）允许汉字为空：只插拼音，之后可再补汉字（或纯拼音标注）。
    // 上方（ruby）的语义是"汉字上方注音"，没有汉字不成立，仍必填。
    if (!pinyin || (mode === 'ruby' && !text)) {
      // 拼音为空（或 ruby 模式汉字为空）→ 闪红提示
      this.hint.classList.add('circled-sup-modal-hint-error')
      setTimeout(() => this.hint.classList.remove('circled-sup-modal-hint-error'), 1500)
      return
    }

    const view = getEditorView()
    if (!view) {
      this.hide()
      return
    }

    const targetType: PinyinNodeType = mode === 'ruby' ? 'pinyin_ruby' : 'pinyin_inline'

    if (this.currentTarget !== null) {
      // 编辑模式：setNodeMarkup 可同时改 attrs 和 type
      const { pos, type: origType } = this.currentTarget
      const node = view.state.doc.nodeAt(pos)
      if (!node || (node.type.name !== 'pinyin_ruby' && node.type.name !== 'pinyin_inline')) {
        this.hide()
        return
      }
      const newTypeSchema = view.state.schema.nodes[targetType]
      if (!newTypeSchema) {
        console.error(`${targetType} schema node not found.`)
        this.hide()
        return
      }
      // 若类型未变，传 undefined 让 PM 复用原类型；若变了，传新类型 schema
      const typeArg = origType === targetType ? undefined : newTypeSchema
      const tr = view.state.tr.setNodeMarkup(pos, typeArg, { text, pinyin })
      view.dispatch(tr)
    } else {
      // 插入模式：在光标处插入新节点
      const typeSchema = view.state.schema.nodes[targetType]
      if (!typeSchema) {
        console.error(`${targetType} schema node not found.`)
        this.hide()
        return
      }
      const node = typeSchema.create({ text, pinyin })
      const tr = view.state.tr.replaceSelectionWith(node)
      view.dispatch(tr)
      view.focus()
    }

    this.hide()
  }
}

export const pinyinModal = new PinyinModal()
