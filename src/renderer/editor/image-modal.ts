// 图片参数编辑/插入模态框 —— 仿 math-modal.ts
//
// 两种用途：
//   1. 编辑已存在图片：点击编辑器中的图片节点时由 imageEditorPlugin 调用
//      show(attrs, nodePos)，保存时用 tr.setNodeMarkup 更新 attrs。
//   2. 插入新图片：工具栏「图片」按钮调用 show()（无参），
//      保存时用 tr.replaceSelectionWith 在光标处插入新 image 节点。
//
// 与 math-modal 的关键差异：
//   - 表单字段而非单个 textarea：图片参数多且类型不一（文本/尺寸/枚举/布尔），
//     用 input + select + checkbox 各自呈现更清晰。
//   - 顶部有缩略图预览，所见即所改。
//   - 头部标题与保存按钮文案随模式切换（编辑/插入）。

import { getEditorView } from './editor'
import { isChinese, type UiLanguage } from '../ui-language'
import { toFileUrl } from '../../extensions/image-style/lib'

// 图片节点的全部 attrs（与 image-style/schema.ts 一致，不含 title）
// title（悬停提示）不在模态框中编辑：编辑模式下保留节点已有 title，
// 插入模式下用 schema 默认值 ''。如需修改 title，可直接编辑 Markdown 源码。
export interface ImageAttrs {
  src: string
  alt: string
  width: string
  height: string
  align: string
  border: boolean
  shadow: boolean
  radius: boolean
}

// 插入模式使用的默认 attrs（全空）
const DEFAULT_IMAGE_ATTRS: ImageAttrs = {
  src: '',
  alt: '',
  width: '',
  height: '',
  align: '',
  border: false,
  shadow: false,
  radius: false,
}

const ALIGN_OPTIONS: { value: string; zh: string; en: string }[] = [
  { value: '', zh: '默认', en: 'Default' },
  { value: 'left', zh: '左对齐', en: 'Left' },
  { value: 'center', zh: '居中', en: 'Center' },
  { value: 'right', zh: '右对齐', en: 'Right' },
  { value: 'float-left', zh: '浮动左', en: 'Float left' },
  { value: 'float-right', zh: '浮动右', en: 'Float right' },
]

export class ImageModal {
  private container: HTMLDivElement
  private header: HTMLHeadingElement
  private preview: HTMLImageElement
  private previewWrap: HTMLDivElement
  private srcInput: HTMLInputElement
  private browseButton: HTMLButtonElement
  private convertButton: HTMLButtonElement
  private altInput: HTMLInputElement
  private widthInput: HTMLInputElement
  private heightInput: HTMLInputElement
  private alignSelect: HTMLSelectElement
  private borderCheckbox: HTMLInputElement
  private shadowCheckbox: HTMLInputElement
  private radiusCheckbox: HTMLInputElement
  private cancelButton: HTMLButtonElement
  private saveButton: HTMLButtonElement
  // 当前编辑目标节点位置；null 表示插入模式
  private currentTarget: { pos: number } | null = null
  // 当前语言（show 切换模式后据此刷新头部与保存按钮文案）
  private currentLanguage: UiLanguage = 'en'
  // 是否为插入模式（影响头部标题与保存按钮文案、首个聚焦字段）
  private isInsertMode = false
  // Base64 转换进行中标记（防止重复点击）
  private converting = false
  // 浏览本地文件对话框打开中标记（防止重复点击）
  private browsing = false

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'math-modal-overlay image-modal-overlay'
    this.container.style.display = 'none'

    const modal = document.createElement('div')
    modal.className = 'math-modal image-modal'

    const header = document.createElement('h3')
    this.header = header
    header.textContent = 'Edit Image'
    modal.appendChild(header)

    // 缩略图预览（src 改变时实时刷新）
    this.previewWrap = document.createElement('div')
    this.previewWrap.className = 'image-modal-preview-wrap'
    this.preview = document.createElement('img')
    this.preview.className = 'image-modal-preview'
    this.preview.alt = ''
    this.previewWrap.appendChild(this.preview)
    modal.appendChild(this.previewWrap)

    // 字段：src（本地路径或 URL）+ 转 Base64 按钮
    const srcRow = this.makeRow('src', 'Path / URL', '路径 / URL')
    const srcFlex = document.createElement('div')
    srcFlex.className = 'image-modal-src-flex'
    this.srcInput = document.createElement('input')
    this.srcInput.type = 'text'
    this.srcInput.className = 'image-modal-input'
    this.srcInput.addEventListener('input', () => this.updatePreview())
    // 「浏览」：打开系统文件对话框选本地图片，选中后填入 src（插入模式随即插入）
    this.browseButton = document.createElement('button')
    this.browseButton.type = 'button'
    this.browseButton.className = 'image-modal-convert-btn image-modal-browse-btn'
    this.browseButton.textContent = 'Browse'
    this.browseButton.addEventListener('click', () => void this.browseLocalFile())
    this.convertButton = document.createElement('button')
    this.convertButton.type = 'button'
    this.convertButton.className = 'image-modal-convert-btn'
    this.convertButton.textContent = 'To Base64'
    this.convertButton.addEventListener('click', () => this.convertToBase64())
    srcFlex.append(this.srcInput, this.browseButton, this.convertButton)
    srcRow.col.appendChild(srcFlex)
    modal.appendChild(srcRow.row)

    // 字段：alt（描述文本，不含 cherry 参数；cherry 参数由 width/height/align 等字段表达）
    const altRow = this.makeRow('alt', 'Alt text', '描述文本')
    this.altInput = document.createElement('input')
    this.altInput.type = 'text'
    this.altInput.className = 'image-modal-input'
    altRow.col.appendChild(this.altInput)
    modal.appendChild(altRow.row)

    // 字段：width + height（同一行两列，尺寸单位：px / % / auto）
    const sizeRow = document.createElement('div')
    sizeRow.className = 'image-modal-row'
    const widthCol = document.createElement('div')
    widthCol.className = 'image-modal-col'
    const widthLabel = this.makeLabel('image-width', 'Width', '宽度')
    this.widthInput = document.createElement('input')
    this.widthInput.type = 'text'
    this.widthInput.id = 'image-width'
    this.widthInput.className = 'image-modal-input'
    this.widthInput.placeholder = 'auto / 100px / 50%'
    widthCol.append(widthLabel, this.widthInput)
    const heightCol = document.createElement('div')
    heightCol.className = 'image-modal-col'
    const heightLabel = this.makeLabel('image-height', 'Height', '高度')
    this.heightInput = document.createElement('input')
    this.heightInput.type = 'text'
    this.heightInput.id = 'image-height'
    this.heightInput.className = 'image-modal-input'
    this.heightInput.placeholder = 'auto / 100px / 50%'
    heightCol.append(heightLabel, this.heightInput)
    sizeRow.append(widthCol, heightCol)
    modal.appendChild(sizeRow)

    // 字段：align（下拉选择）
    const alignRow = document.createElement('div')
    alignRow.className = 'image-modal-row'
    const alignCol = document.createElement('div')
    alignCol.className = 'image-modal-col'
    const alignLabel = this.makeLabel('image-align', 'Alignment', '对齐方式')
    this.alignSelect = document.createElement('select')
    this.alignSelect.id = 'image-align'
    this.alignSelect.className = 'image-modal-input image-modal-select'
    for (const opt of ALIGN_OPTIONS) {
      const o = document.createElement('option')
      o.value = opt.value
      o.textContent = opt.en
      this.alignSelect.appendChild(o)
    }
    alignCol.append(alignLabel, this.alignSelect)
    alignRow.appendChild(alignCol)
    modal.appendChild(alignRow)

    // 字段：border / shadow / radius 复选框
    const styleRow = document.createElement('div')
    styleRow.className = 'image-modal-options'
    this.borderCheckbox = this.makeCheckbox('image-border', 'Border', '边框', styleRow)
    this.shadowCheckbox = this.makeCheckbox('image-shadow', 'Shadow', '阴影', styleRow)
    this.radiusCheckbox = this.makeCheckbox('image-radius', 'Radius', '圆角', styleRow)
    modal.appendChild(styleRow)

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
    saveBtn.textContent = 'Update'
    saveBtn.className = 'math-modal-btn save'
    saveBtn.addEventListener('click', () => this.save())

    footer.append(cancelBtn, saveBtn)
    modal.appendChild(footer)

    this.container.appendChild(modal)

    // 点遮罩外区域关闭
    this.container.addEventListener('mousedown', (e) => {
      if (e.target === this.container) this.hide()
    })

    // 键盘：Escape 关闭，Ctrl+Enter 保存
    this.container.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.hide()
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        this.save()
      }
    })

    document.body.appendChild(this.container)
    this.currentLanguage = isChinese() ? 'zh' : 'en'
    this.setLanguage(this.currentLanguage)
  }

  /** 构造一行：label + 容器列（input 由调用方填充） */
  private makeRow(id: string, enLabel: string, zhLabel: string): { row: HTMLDivElement; col: HTMLDivElement } {
    const row = document.createElement('div')
    row.className = 'image-modal-row'
    const col = document.createElement('div')
    col.className = 'image-modal-col'
    const label = this.makeLabel(id, enLabel, zhLabel)
    col.appendChild(label)
    row.appendChild(col)
    return { row, col }
  }

  /** 构造一个带 data-zh / data-en 的 label，setLanguage 据此切换文案 */
  private makeLabel(htmlFor: string, en: string, zh: string): HTMLLabelElement {
    const label = document.createElement('label')
    label.htmlFor = htmlFor
    label.textContent = en
    label.className = 'image-modal-label'
    label.dataset.zh = zh
    label.dataset.en = en
    return label
  }

  /** 构造一个复选框 + 文案，挂到 parent */
  private makeCheckbox(id: string, enLabel: string, zhLabel: string, parent: HTMLElement): HTMLInputElement {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.id = id
    const label = document.createElement('label')
    label.htmlFor = id
    label.className = 'image-modal-cb-label'
    label.textContent = ' ' + enLabel
    label.dataset.en = ' ' + enLabel
    label.dataset.zh = ' ' + zhLabel
    parent.append(cb, label)
    return cb
  }

  setLanguage(language: UiLanguage): void {
    this.currentLanguage = language
    const zh = language === 'zh'
    this.header.textContent = this.isInsertMode
      ? (zh ? '插入图片' : 'Insert Image')
      : (zh ? '编辑图片' : 'Edit Image')
    this.srcInput.placeholder = zh ? '本地路径或 URL' : 'Local path or URL'
    // 按钮文案：转换中/浏览中时不覆盖（各自的管理逻辑自行恢复）
    if (!this.browsing) {
      this.browseButton.textContent = zh ? '浏览' : 'Browse'
    }
    if (!this.converting) {
      this.convertButton.textContent = zh ? '转 Base64' : 'To Base64'
    }
    this.altInput.placeholder = zh ? '图片描述（用于无障碍/粘贴纯文本）' : 'Description (alt text)'
    this.widthInput.placeholder = zh ? 'auto / 100px / 50%' : 'auto / 100px / 50%'
    this.heightInput.placeholder = zh ? 'auto / 100px / 50%' : 'auto / 100px / 50%'
    this.cancelButton.textContent = zh ? '取消' : 'Cancel'
    this.saveButton.textContent = this.isInsertMode
      ? (zh ? '插入' : 'Insert')
      : (zh ? '更新' : 'Update')
    // 更新所有带 data-zh/en 的 label
    this.container.querySelectorAll<HTMLElement>('[data-zh]').forEach((el) => {
      const v = el.dataset[zh ? 'zh' : 'en']
      if (v !== undefined && v !== null) el.textContent = v
    })
    // align 下拉项
    Array.from(this.alignSelect.options).forEach((o, i) => {
      const opt = ALIGN_OPTIONS[i]
      o.textContent = zh ? opt.zh : opt.en
    })
  }

  /**
   * 显示模态框。
   * - 编辑模式：传入 attrs + targetPos（图片节点位置）。
   * - 插入模式：无参或 attrs=null，光标处插入新节点。
   */
  show(attrs: ImageAttrs | null = null, targetPos: number | null = null): void {
    this.currentTarget = targetPos !== null ? { pos: targetPos } : null
    this.isInsertMode = this.currentTarget === null
    // 刷新头部/保存按钮文案以反映模式
    this.setLanguage(this.currentLanguage)

    const a = attrs ?? DEFAULT_IMAGE_ATTRS
    this.srcInput.value = a.src
    this.altInput.value = a.alt
    this.widthInput.value = a.width
    this.heightInput.value = a.height
    this.alignSelect.value = a.align || ''
    this.borderCheckbox.checked = a.border
    this.shadowCheckbox.checked = a.shadow
    this.radiusCheckbox.checked = a.radius
    this.updatePreview()

    this.container.style.display = 'flex'

    setTimeout(() => {
      // 插入模式首聚焦 src（必填且通常最先填）；编辑模式聚焦 alt 便于改描述
      const focusEl = this.isInsertMode ? this.srcInput : this.altInput
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

  private updatePreview(): void {
    const src = this.srcInput.value.trim()
    if (!src) {
      this.preview.style.display = 'none'
      return
    }
    this.preview.style.display = ''
    // 本地绝对路径（C:\… 或相对路径）在 <img> 里加载不了，统一转成 file:// URL
    this.preview.src = toFileUrl(src)
  }

  /**
   * 「浏览」按钮：弹系统文件对话框选一张本地图片。
   * - 填入 src（绝对路径）；alt 为空时用文件名兜底；
   * - 插入模式：选中即插入并关闭（工具栏入口的预期行为）；
   * - 编辑模式：只更新 src，等其他参数改完再点「更新」。
   */
  private async browseLocalFile(): Promise<void> {
    if (this.browsing) return
    const zh = this.currentLanguage === 'zh'
    this.browsing = true
    this.browseButton.disabled = true
    this.browseButton.textContent = zh ? '选择中...' : 'Choosing...'
    try {
      const path = await window.electronAPI?.pickImageFile?.()
      if (!path) {
        // 用户取消
        this.flashButton(zh ? '已取消' : 'Cancelled', 1200, this.browseButton)
        return
      }
      this.srcInput.value = path
      if (!this.altInput.value.trim()) {
        const base = path.split(/[\\/]/).pop() ?? ''
        this.altInput.value = base.replace(/\.[^.]+$/, '')
      }
      this.updatePreview()
      if (this.isInsertMode) {
        this.save()
        return
      }
      this.flashButton(zh ? '已选择' : 'Picked', 1200, this.browseButton)
    } finally {
      this.browsing = false
      this.browseButton.disabled = false
    }
  }

  /**
   * 将当前 src（网络 URL 或本地路径）转为 Base64 data URL。
   *
   * 策略：
   *  1. 先尝试 fetch + FileReader（保留原始格式，对 CORS 允许的服务器有效）
   *  2. fetch 失败时（file:// 被拦 / 跨域）走 canvas 兜底：
   *     用 <img> 加载 URL（<img> 不受 fetch 同源策略限制），
   *     画到 canvas 后 toDataURL 取 base64。
   *     缺点：canvas 会将图重编码为 PNG（JPEG 体积可能膨胀）。
   */
  private async convertToBase64(): Promise<void> {
    if (this.converting) return
    const src = this.srcInput.value.trim()
    if (!src) return
    // 已是 data: URL，无需转换
    if (/^data:/i.test(src)) {
      this.flashButton(this.currentLanguage === 'zh' ? '已是 Base64' : 'Already Base64')
      return
    }

    // 确定可加载的 URL
    let url: string
    if (/^(https?:|file:|blob:)/i.test(src)) {
      url = src
    } else if (/^[a-zA-Z]:[\\/]/.test(src)) {
      // Windows 绝对路径 → file:// URL
      url = 'file:///' + src.replace(/\\/g, '/')
    } else {
      url = src
    }

    const zh = this.currentLanguage === 'zh'
    this.converting = true
    this.convertButton.disabled = true
    this.convertButton.textContent = zh ? '转换中...' : 'Converting...'

    try {
      let dataUrl: string
      // 方法 1：fetch + FileReader（保留原始编码格式）
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const blob = await response.blob()
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => reject(new Error('FileReader error'))
          reader.readAsDataURL(blob)
        })
      } catch {
        // 方法 2：canvas 兜底（file:// 被 fetch 拦截时的退路）
        dataUrl = await this.convertViaCanvas(url)
      }
      this.srcInput.value = dataUrl
      this.updatePreview()
      this.flashButton(zh ? '已转换' : 'Done')
    } catch (err) {
      console.error('Base64 conversion failed:', err)
      const msg = err instanceof Error ? err.message : String(err)
      this.flashButton(zh ? `失败: ${msg}` : `Failed: ${msg}`, 3000)
    } finally {
      this.converting = false
      this.convertButton.disabled = false
    }
  }

  /**
   * canvas 兜底转换：用 <img> 加载 URL（不受 fetch 同源策略限制），
   * 画到 canvas 后 toDataURL 取 base64 PNG。
   * webSecurity 关闭时 file:// 图片不会污染 canvas；跨域网络图片若
   * 服务器未返回 CORS 头则 toDataURL 会抛 SecurityError。
   */
  private convertViaCanvas(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            reject(new Error('Canvas 2D context unavailable'))
            return
          }
          ctx.drawImage(img, 0, 0)
          resolve(canvas.toDataURL('image/png'))
        } catch (e) {
          // SecurityError: canvas 被跨域图片污染
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
      img.onerror = () => reject(new Error('Image load failed (CORS or not found)'))
      img.src = url
    })
  }

  /** 短暂更改按钮文案，超时后恢复为当前语言对应文案（默认作用于转 Base64 按钮）。 */
  private flashButton(text: string, duration = 1500, btn: HTMLButtonElement = this.convertButton): void {
    btn.textContent = text
    setTimeout(() => {
      const zh = this.currentLanguage === 'zh'
      btn.textContent = btn === this.convertButton
        ? (zh ? '转 Base64' : 'To Base64')
        : (zh ? '浏览' : 'Browse')
    }, duration)
  }

  private save(): void {
    const view = getEditorView()
    if (!view) {
      this.hide()
      return
    }

    // 校验尺寸值：空字符串、auto、Npx、N%
    const sizeRe = /^(|auto|\d+(?:\.\d+)?px|\d+(?:\.\d+)?%)$/
    const width = this.widthInput.value.trim()
    const height = this.heightInput.value.trim()

    const newAttrs: ImageAttrs = {
      src: this.srcInput.value.trim(),
      alt: this.altInput.value,
      width: sizeRe.test(width) ? width : '',
      height: sizeRe.test(height) ? height : '',
      align: this.alignSelect.value,
      border: this.borderCheckbox.checked,
      shadow: this.shadowCheckbox.checked,
      radius: this.radiusCheckbox.checked,
    }

    if (this.currentTarget !== null) {
      // 编辑模式：更新现有图片节点 attrs。title 不在 newAttrs 中，
      // 通过 {...node.attrs, ...newAttrs} 保留节点原有 title。
      const { pos } = this.currentTarget
      const node = view.state.doc.nodeAt(pos)
      if (!node || node.type.name !== 'image') {
        this.hide()
        return
      }
      const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...newAttrs })
      view.dispatch(tr)
    } else if (newAttrs.src) {
      // 插入模式：仅当 src 非空时在光标处插入新 image 节点。
      // title 未传，imageType.create 用 schema 默认值 ''。
      const imageType = view.state.schema.nodes.image
      if (!imageType) {
        console.error('Image schema node not found. Is the image-style plugin loaded?')
        this.hide()
        return
      }
      const insertNode = imageType.create(newAttrs)
      const tr = view.state.tr.replaceSelectionWith(insertNode)
      view.dispatch(tr)
      view.focus()
    }

    this.hide()
  }
}

export const imageModal = new ImageModal()
