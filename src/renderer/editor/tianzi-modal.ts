// 田字格模态框 —— 规约G 田字格（tianzi_grid）的插入与编辑
//
// 工具栏「田字格」按钮 → show()：插入模式，光标处插入新 tianzi_grid 节点
// 点击已存在 tianzi_grid 节点 → show(attrs, pos)：编辑模式
//
// 三种形态（互斥）：
//   1. 纯汉字：++你好++ → 每字一格
//   2. N 个空白格：++(3)++ → 3 个空白格
//   3. 带拼音格：++(tian1qi4)++ → 按音节拆格，每格上方带调拼音
//
// 模态框根据形态切换字段，保存时自动组装 raw 字符串。

import { getEditorView } from './editor'
import { type UiLanguage } from '../ui-language'
import { parseCells, type TianziKind } from '../../extensions/tianzi-grid/lib'

export interface TianziAttrs {
  raw: string
}

// 三种形态的互斥输入模式
type TianziMode = 'chars' | 'blank' | 'pinyin'

export class TianziModal {
  private container: HTMLDivElement
  private header: HTMLHeadingElement
  private modeWrap: HTMLDivElement
  private fieldsWrap: HTMLDivElement
  // 三种形态对应的输入控件（根据选中的 radio 切换显示）
  private charsInput: HTMLInputElement // 纯汉字
  private blankInput: HTMLInputElement // N 个空白格（数字）
  private pinyinInput: HTMLInputElement // 拼音（tian1qi4）
  private hint: HTMLParagraphElement
  private preview: HTMLDivElement // 预览区：显示田字格示例
  private cancelButton: HTMLButtonElement
  private saveButton: HTMLButtonElement
  private currentTarget: { pos: number } | null = null
  private currentLanguage: UiLanguage = 'en'
  private isInsertMode = false

  // 当前形态
  private currentMode: TianziMode = 'chars'

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'math-modal-overlay tianzi-modal-overlay'
    this.container.style.display = 'none'

    const modal = document.createElement('div')
    modal.className = 'math-modal tianzi-modal'

    const header = document.createElement('h3')
    this.header = header
    header.textContent = 'Insert Tianzi Grid'

    // 形态选择（radio 互斥单选组）
    this.modeWrap = document.createElement('div')
    this.modeWrap.className = 'tianzi-modal-modes'
    const modes: { value: TianziMode; zh: string; en: string }[] = [
      { value: 'chars', zh: '纯汉字', en: 'Hanzi' },
      { value: 'blank', zh: '空白格', en: 'Blank cells' },
      { value: 'pinyin', zh: '带拼音格', en: 'With pinyin' },
    ]
    for (const m of modes) {
      const label = document.createElement('label')
      label.className = 'tianzi-modal-radio'
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'tianzi-mode'
      radio.value = m.value
      if (m.value === 'chars') radio.checked = true
      radio.addEventListener('change', () => {
        if (radio.checked) this.switchMode(m.value)
      })
      const span = document.createElement('span')
      span.className = 'tianzi-mode-label'
      span.textContent = m.en
      label.append(radio, span)
      this.modeWrap.appendChild(label)
    }

    // 纯汉字输入
    this.charsInput = document.createElement('input')
    this.charsInput.type = 'text'
    this.charsInput.className = 'image-modal-input tianzi-modal-field tianzi-modal-field-chars'
    this.charsInput.placeholder = 'e.g. 你好'
    this.charsInput.addEventListener('input', () => this.updatePreview())

    // 空白格数字输入
    this.blankInput = document.createElement('input')
    this.blankInput.type = 'text'
    this.blankInput.inputMode = 'numeric'
    this.blankInput.pattern = '\\d+'
    this.blankInput.className = 'image-modal-input tianzi-modal-field tianzi-modal-field-blank'
    this.blankInput.placeholder = 'e.g. 3'
    this.blankInput.style.display = 'none'
    this.blankInput.addEventListener('input', () => this.updatePreview())

    // 拼音输入
    this.pinyinInput = document.createElement('input')
    this.pinyinInput.type = 'text'
    this.pinyinInput.className = 'image-modal-input tianzi-modal-field tianzi-modal-field-pinyin'
    this.pinyinInput.placeholder = 'e.g. tian1qi4'
    this.pinyinInput.style.display = 'none'
    this.pinyinInput.addEventListener('input', () => this.updatePreview())

    this.fieldsWrap = document.createElement('div')
    this.fieldsWrap.className = 'tianzi-modal-fields'
    this.fieldsWrap.append(this.charsInput, this.blankInput, this.pinyinInput)

    // 预览区：实时渲染田字格示例（flex-grow 占剩余空间，overflow auto）
    this.preview = document.createElement('div')
    this.preview.className = 'tianzi-modal-preview'

    // 提示（raw 格式说明 + 错误信息）
    this.hint = document.createElement('p')
    this.hint.className = 'tianzi-modal-hint'

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
    modal.append(header, this.modeWrap, this.fieldsWrap, this.preview, this.hint, footer)
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
    this.header.textContent = zh ? (this.isInsertMode ? '插入田字格' : '编辑田字格') : (this.isInsertMode ? 'Insert Tianzi Grid' : 'Edit Tianzi Grid')
    this.cancelButton.textContent = zh ? '取消' : 'Cancel'
    this.saveButton.textContent = zh ? (this.isInsertMode ? '插入' : '更新') : (this.isInsertMode ? 'Insert' : 'Update')

    // 形态选项标签文本（radio 的 value 不变，只更新显示文字）
    const labels: Record<TianziMode, { zh: string; en: string }> = {
      chars: { zh: '纯汉字', en: 'Hanzi' },
      blank: { zh: '空白格', en: 'Blank cells' },
      pinyin: { zh: '带拼音格', en: 'With pinyin' },
    }
    const radioLabels = this.modeWrap.querySelectorAll<HTMLSpanElement>('.tianzi-mode-label')
    radioLabels.forEach((span) => {
      const radio = span.previousElementSibling as HTMLInputElement
      const key = radio.value as TianziMode
      span.textContent = zh ? labels[key].zh : labels[key].en
    })

    // 占位符
    this.charsInput.placeholder = zh ? '如：你好' : 'e.g. 你好'
    this.blankInput.placeholder = zh ? '格数，如：3' : 'Count, e.g. 3'
    this.pinyinInput.placeholder = zh ? '如：tian1qi4（1阴平2阳平3上声4去声）' : 'e.g. tian1qi4 (1-4 tone)'

    this.updatePreview()
  }

  /** 切换形态：显示对应输入框，隐藏其它 */
  private switchMode(mode: TianziMode): void {
    this.currentMode = mode
    this.charsInput.style.display = mode === 'chars' ? '' : 'none'
    this.blankInput.style.display = mode === 'blank' ? '' : 'none'
    this.pinyinInput.style.display = mode === 'pinyin' ? '' : 'none'
    // 同步 radio 选中状态（parseRawToFields 直接调 switchMode 时需要）
    const radio = this.modeWrap.querySelector<HTMLInputElement>(`input[name="tianzi-mode"][value="${mode}"]`)
    if (radio) radio.checked = true
    this.updatePreview()
  }

  /** 实时渲染预览田字格 + 更新 hint 文本 */
  private updatePreview(): void {
    const zh = this.currentLanguage === 'zh'

    // 1) 确定当前输入（空时用该形态的示例，让切换形态总能看到对应示例）
    let raw = ''
    let useExample = false
    const getInput = (): string => {
      if (this.currentMode === 'chars') return this.charsInput.value.trim()
      if (this.currentMode === 'blank') return this.blankInput.value.trim()
      return this.pinyinInput.value.trim()
    }
    const v = getInput()
    if (!v) {
      // 空 → 显示示例
      useExample = true
      if (this.currentMode === 'chars') raw = '你好'
      else if (this.currentMode === 'blank') raw = '(3)'
      else raw = '(tian1qi4)'
    } else if (this.currentMode === 'chars') {
      raw = v
    } else {
      raw = `(${v})`
    }

    // 2) 解析 + 渲染 DOM
    const model = parseCells(raw)
    this.preview.innerHTML = ''
    if (model) {
      const grid = document.createElement('span')
      grid.className = 'tianzi-grid'
      for (const cell of model.cells) {
        grid.appendChild(this.renderCell(cell))
      }
      this.preview.appendChild(grid)
    } else {
      // 非法输入 → 显示示例的田字格（用户能看到期望形态）
      const fallback = this.currentMode === 'chars' ? parseCells('你好')
        : this.currentMode === 'blank' ? parseCells('(3)')
        : parseCells('(tian1qi4)')
      if (fallback) {
        const grid = document.createElement('span')
        grid.className = 'tianzi-grid'
        for (const cell of fallback.cells) {
          grid.appendChild(this.renderCell(cell))
        }
        this.preview.appendChild(grid)
      }
    }

    // 3) hint 文本（raw 格式说明 + 非法时提示）
    if (useExample) {
      // 空输入 → 显示该形态示例说明
      const exampleRaw = this.currentMode === 'chars' ? '++你好++'
        : this.currentMode === 'blank' ? '++(3)++'
        : '++(tian1qi4)++'
      const exLabel = this.currentMode === 'chars'
        ? (zh ? '示例（纯汉字，每字一格）' : 'Example: hanzi, each char → one cell')
        : this.currentMode === 'blank'
          ? (zh ? '示例（3 个空白格）' : 'Example: 3 blank cells')
          : (zh ? '示例（拼音每音节一格，上方带调）' : 'Example: one cell per syllable, tone above')
      this.hint.textContent = `${exLabel}　${exampleRaw}`
      this.hint.style.color = ''
    } else if (!model) {
      // 非法输入
      this.hint.style.color = '#d33'
      if (this.currentMode === 'chars') {
        this.hint.textContent = zh ? '请输入纯汉字' : 'Enter hanzi only'
      } else if (this.currentMode === 'blank') {
        this.hint.textContent = zh ? '请输入正整数' : 'Enter positive integer'
      } else {
        this.hint.textContent = zh ? '拼音格式无效：小写字母 + 可选 1-4 声调' : 'Invalid pinyin: lowercase letters + optional 1-4 tone'
      }
    } else {
      // 合法输入
      this.hint.style.color = ''
      const cellsLabel = `${model.cells.length} ${zh ? '格' : 'cells'}`
      const rawDisplay = this.currentMode === 'chars' ? v : raw
      this.hint.textContent = `${rawDisplay} → ${cellsLabel}`
    }
  }

  /** 渲染单个田字格 DOM（复用 style.css 的 tz-cell / tz-box / tz-char / tz-py） */
  private renderCell(cell: { char?: string; pinyin?: string }): HTMLSpanElement {
    const c = document.createElement('span')
    c.className = 'tz-cell'
    if (cell.pinyin) {
      const py = document.createElement('span')
      py.className = 'tz-py'
      py.textContent = cell.pinyin
      c.appendChild(py)
    }
    const box = document.createElement('span')
    box.className = 'tz-box'
    if (cell.char) {
      const ch = document.createElement('span')
      ch.className = 'tz-char'
      ch.textContent = cell.char
      box.appendChild(ch)
    }
    c.appendChild(box)
    return c
  }

  /** 从 raw 字符串反推 mode 和字段值（编辑模式初始化用） */
  private parseRawToFields(raw: string): void {
    if (!raw) {
      this.currentMode = 'chars'
      this.charsInput.value = ''
      this.blankInput.value = ''
      this.pinyinInput.value = ''
      this.switchMode('chars')
      return
    }

    const model = parseCells(raw)
    if (!model) {
      // 非法 raw，降级为纯汉字模式，直接塞 raw
      this.currentMode = 'chars'
      this.charsInput.value = raw
      this.blankInput.value = ''
      this.pinyinInput.value = ''
      this.switchMode('chars')
      return
    }

    if (model.kind === 'chars') {
      this.currentMode = 'chars'
      this.charsInput.value = raw
      this.blankInput.value = ''
      this.pinyinInput.value = ''
    } else if (model.kind === 'blank') {
      this.currentMode = 'blank'
      const count = model.cells.length
      this.charsInput.value = ''
      this.blankInput.value = String(count)
      this.pinyinInput.value = ''
    } else {
      // pinyin：raw 形如 (tian1qi4)，去括号得 tian1qi4
      this.currentMode = 'pinyin'
      this.charsInput.value = ''
      this.blankInput.value = ''
      this.pinyinInput.value = raw.replace(/^\(|\)$/g, '')
    }
    this.switchMode(this.currentMode)
  }

  show(attrs?: TianziAttrs | null, targetPos?: number | null): void {
    this.isInsertMode = targetPos === undefined || targetPos === null
    this.currentTarget = targetPos != null ? { pos: targetPos } : null

    const a = attrs ?? { raw: '' }
    this.parseRawToFields(a.raw)

    const zh = this.currentLanguage === 'zh'
    this.header.textContent = zh ? (this.isInsertMode ? '插入田字格' : '编辑田字格') : (this.isInsertMode ? 'Insert Tianzi Grid' : 'Edit Tianzi Grid')
    this.saveButton.textContent = zh ? (this.isInsertMode ? '插入' : '更新') : (this.isInsertMode ? 'Insert' : 'Update')

    this.container.style.display = 'flex'
    setTimeout(() => {
      const focusEl = this.currentMode === 'chars' ? this.charsInput
        : this.currentMode === 'blank' ? this.blankInput
        : this.pinyinInput
      focusEl.focus()
      focusEl.select()
    }, 50)
  }

  hide(): void {
    this.container.style.display = 'none'
  }

  /** 根据当前 mode 和输入值组装 raw；返回 null 表示输入非法 */
  private buildRaw(): string | null {
    if (this.currentMode === 'chars') {
      const v = this.charsInput.value.trim()
      if (!v) return null
      if (!/^[\u4e00-\u9fa5]+$/.test(v)) return null
      return v
    }
    if (this.currentMode === 'blank') {
      const v = this.blankInput.value.trim()
      if (!/^\d+$/.test(v) || Number(v) <= 0) return null
      return `(${v})`
    }
    // pinyin
    const v = this.pinyinInput.value.trim()
    if (!v) return null
    const raw = `(${v})`
    if (!parseCells(raw)) return null
    return raw
  }

  private save(): void {
    const view = getEditorView()
    if (!view) {
      this.hide()
      return
    }

    const raw = this.buildRaw()
    if (raw === null) {
      const zh = this.currentLanguage === 'zh'
      this.hint.style.color = '#d33'
      if (this.currentMode === 'chars') {
        this.hint.textContent = zh ? '请输入纯汉字' : 'Enter hanzi only'
      } else if (this.currentMode === 'blank') {
        this.hint.textContent = zh ? '请输入正整数' : 'Enter positive integer'
      } else {
        this.hint.textContent = zh ? '拼音格式无效：小写字母 + 可选 1-4 声调' : 'Invalid pinyin: lowercase letters + optional 1-4 tone'
      }
      return
    }

    const schema = view.state.schema
    const tianziType = schema.nodes.tianzi_grid
    if (!tianziType) {
      console.error('tianzi_grid schema not found. Is the tianzi-grid plugin loaded?')
      this.hide()
      return
    }

    if (this.currentTarget !== null) {
      const { pos } = this.currentTarget
      const node = view.state.doc.nodeAt(pos)
      if (!node || node.type.name !== 'tianzi_grid') {
        this.hide()
        return
      }
      const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, raw })
      view.dispatch(tr)
    } else {
      const node = tianziType.create({ raw })
      const tr = view.state.tr.replaceSelectionWith(node)
      view.dispatch(tr)
      view.focus()
    }

    this.hide()
  }
}

export const tianziModal = new TianziModal()
