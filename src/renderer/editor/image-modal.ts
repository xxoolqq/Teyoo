// 图片参数编辑/插入模态框 —— 仿 math-modal.ts
//
// 两种用途：
//   1. 编辑已存在图片：点击编辑器中的图片节点时由 imageEditorPlugin 调用
//      show(attrs, nodePos)，保存时用 tr.setNodeMarkup 更新 attrs。
//   2. 插入新图片：工具栏「图片」按钮调用 show()（无参），
//      保存时用 tr.replaceSelectionWith 在光标处插入新 image 节点。
//
// 有 Electron 通道时「浏览」走 pickImageFile（拿到本地绝对路径）；没有时
// （Word 任务窗格 / 纯浏览器）退化为原生 <input type="file">，读成 base64
// data URL 内嵌 —— 本地路径进了 Word 文档就失效了，只有内嵌活得下来。
//
// 与 math-modal 的关键差异：
//   - 表单字段而非单个 textarea：图片参数多且类型不一（文本/尺寸/枚举/布尔），
//     用 input + select + checkbox 各自呈现更清晰。
//   - 顶部有缩略图预览，所见即所改。
//   - 头部标题与保存按钮文案随模式切换（编辑/插入）。

import { getEditorView } from './editor'
import { isChinese, type UiLanguage } from '../ui-language'
import { ALIGN_OPTIONS, toFileUrl } from '../../extensions/image-style/lib'
// 内嵌与压缩：本地文件 → base64（超限时等比压缩），阈值与桌面版共用一份
import { fileToEmbeddableDataUrl, urlToDataUrl, describeCompression } from './image-embed'

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

/** 路径 → 「文件名（去扩展名）」，用作 alt 兜底 */
function altFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.[^.]+$/, '')
}

/**
 * 是否有 Electron 的本地文件通道：桌面版 true（pickImageFile 返回磁盘路径），
 * WebView2 / 纯浏览器 false（只能内嵌 base64）。
 */
function hasElectronChannel(): boolean {
  const api = window.electronAPI
  return !!api && typeof api.pickImageFile === 'function'
}

/**
 * 「转本地」是否有磁盘通道：桌面版有 storeImageToLocal（主进程下载 + 落盘）；
 * WebView2 任务窗格 / 纯浏览器没有文件系统，这条通道不存在。
 */
function hasStoreChannel(): boolean {
  const api = window.electronAPI
  return !!api && typeof api.storeImageToLocal === 'function'
}

/** 主进程的错误码 → 按钮上的一行提示 */
function localizeErrorText(code: string | undefined, zh: boolean): string {
  switch (code) {
    case 'EMPTY':
    case 'BAD_SRC':
      return zh ? '没有可转换的地址' : 'Nothing to convert'
    case 'NOT_IMAGE':
      return zh ? '内容不是图片' : 'Not an image'
    case 'TOO_LARGE':
      return zh ? '图片超过 20MB' : 'Image over 20MB'
    case 'TIMEOUT':
      return zh ? '下载超时' : 'Download timed out'
    case 'UNSUPPORTED':
      return zh ? '不支持这种图片地址' : 'Unsupported image source'
    case 'WRITE_FAILED':
      return zh ? '工作目录不可写' : 'Work dir not writable'
    default:
      return code ? code : zh ? '未知错误' : 'Unknown error'
  }
}

// 插入模式使用的默认 attrs：
//   · 尺寸留空 = 按原图显示；
//   · 对齐默认右对齐（项目里的插图习惯贴在右侧，插入后想改再在面板里选）；
//   · 边框/阴影/圆角一律不带（面板里已没有这三个开关）。
const DEFAULT_IMAGE_ATTRS: ImageAttrs = {
  src: '',
  alt: '',
  width: '',
  height: '',
  align: 'right',
  border: false,
  shadow: false,
  radius: false,
}

export class ImageModal {
  private container: HTMLDivElement
  private header: HTMLHeadingElement
  private preview: HTMLImageElement
  private previewWrap: HTMLDivElement
  private srcInput: HTMLInputElement
  private browseButton: HTMLButtonElement
  // 没有 Electron 通道时（WebView2 / 纯浏览器）用来弹系统文件对话框的隐藏 input
  private fileInput: HTMLInputElement
  // 把 base64 / 网络图片存到工作目录并改用本地路径（桌面版才有）
  private localizeButton: HTMLButtonElement
  private convertButton: HTMLButtonElement
  private altInput: HTMLInputElement
  private widthInput: HTMLInputElement
  private heightInput: HTMLInputElement
  private alignSelect: HTMLSelectElement
  // 编辑模式下的节点原 attrs：边框/阴影/圆角已从面板移除，保存时按原值保留，
  // 不能因为界面上没有这两个开关就把用户已有的样式悄悄清掉
  private baseAttrs: ImageAttrs | null = null
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
  // 「转本地」（下载 + 落盘）进行中标记（防止重复点击）
  private localizing = false
  // 浏览本地文件对话框打开中标记（防止重复点击）
  private browsing = false
  // 关闭回调：宿主用它把「活跃实例」还回去（只读预览借这个面板改图片尺寸）
  private onClose: (() => void) | null = null
  // 预览图的加载序号：换 src 时 ++，回调里对不上号就丢弃（连续输入时的旧图）
  private previewToken = 0
  // 当前预览图的原图尺寸（加载出来才有），用于宽/高输入框的提示
  private naturalSize: { width: number; height: number } | null = null
  // 宽/高下方那行「原图实际尺寸」提示
  private sizeHint: HTMLDivElement

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
    // 无 Electron 通道时的文件选择框。必须挂在 DOM 上（display:none 不影响
    // click() 弹窗），也不放进 modal 内部，免得被模态框的键盘/点击处理吃掉。
    this.fileInput = document.createElement('input')
    this.fileInput.type = 'file'
    this.fileInput.accept = 'image/*'
    this.fileInput.style.display = 'none'
    this.fileInput.addEventListener('change', () => void this.onFilePicked())
    document.body.appendChild(this.fileInput)
    // 「转本地」：把当前 base64 / 网络图片存进工作目录，src 换成绝对路径。
    // 下载与落盘都在主进程（渲染端 CSP 不放行跨域请求），没有文件系统时禁用。
    this.localizeButton = document.createElement('button')
    this.localizeButton.type = 'button'
    this.localizeButton.className = 'image-modal-convert-btn'
    this.localizeButton.textContent = 'To Local'
    this.localizeButton.addEventListener('click', () => void this.localizeCurrent())
    this.convertButton = document.createElement('button')
    this.convertButton.type = 'button'
    this.convertButton.className = 'image-modal-convert-btn'
    this.convertButton.textContent = 'To Base64'
    this.convertButton.addEventListener('click', () => this.convertToBase64())
    srcFlex.append(this.srcInput, this.browseButton, this.localizeButton, this.convertButton)
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
    // 原图实际尺寸提示（图片加载出来才有值；空着就占一行高度，避免弹框跳动）
    this.sizeHint = document.createElement('div')
    this.sizeHint.className = 'image-modal-hint'
    modal.appendChild(this.sizeHint)

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

    // 边框 / 阴影 / 圆角：已按要求从面板移除（插入的图片一律不带这三种样式）

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
    saveBtn.addEventListener('click', () => void this.save())

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
        void this.save()
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
    if (!this.localizing) {
      this.localizeButton.textContent = zh ? '转本地' : 'To Local'
      // 没有磁盘通道时这条能力不存在：直接禁用并说明原因，而不是点了才报错
      this.localizeButton.disabled = !hasStoreChannel()
      this.localizeButton.title = hasStoreChannel()
        ? (zh
            ? '把 base64 / 网络图片存到工作目录，并把 src 换成绝对路径'
            : 'Save the base64 / remote image into the work directory and use its path')
        : (zh
            ? '当前环境没有文件系统（Word 任务窗格 / 浏览器），无法存本地'
            : 'No file system here (Word task pane / browser)')
    }
    this.altInput.placeholder = zh ? '图片描述（用于无障碍/粘贴纯文本）' : 'Description (alt text)'
    // 宽/高提示由 refreshSizeHints 统一给：原图尺寸已经量到就带上（见 updatePreview）
    this.refreshSizeHints()
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
   * - onClose：保存/取消后回调，宿主用它恢复被临时改掉的「活跃实例」。
   */
  show(
    attrs: ImageAttrs | null = null,
    targetPos: number | null = null,
    onClose?: () => void
  ): void {
    this.onClose = onClose ?? null
    this.currentTarget = targetPos !== null ? { pos: targetPos } : null
    this.isInsertMode = this.currentTarget === null
    // 刷新头部/保存按钮文案以反映模式
    this.setLanguage(this.currentLanguage)

    const a = attrs ?? DEFAULT_IMAGE_ATTRS
    this.baseAttrs = attrs
    this.srcInput.value = a.src
    this.altInput.value = a.alt
    this.widthInput.value = a.width
    this.heightInput.value = a.height
    this.alignSelect.value = a.align || ''
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
    const done = this.onClose
    this.onClose = null
    done?.()
  }

  private updatePreview(): void {
    const src = this.srcInput.value.trim()
    // 每次换 src 都作废上一次的 load 回调：连续输入时旧图可能后到，
    // 拿它的尺寸会显示成另一张图的宽高
    const token = ++this.previewToken
    if (!src) {
      this.preview.style.display = 'none'
      this.naturalSize = null
      this.refreshSizeHints()
      return
    }
    this.preview.style.display = ''
    this.naturalSize = null
    this.refreshSizeHints()
    this.preview.onload = () => {
      if (token !== this.previewToken) return
      const width = this.preview.naturalWidth
      const height = this.preview.naturalHeight
      if (!width || !height) return
      this.naturalSize = { width, height }
      this.refreshSizeHints()
    }
    this.preview.onerror = () => {
      if (token !== this.previewToken) return
      this.naturalSize = null
      this.refreshSizeHints()
    }
    // 本地绝对路径（C:\… 或相对路径）在 <img> 里加载不了，统一转成 file:// URL
    this.preview.src = toFileUrl(src)
  }

  /**
   * 宽/高的提示里带上原图尺寸。
   *
   * width/height 为空 = 按原图显示（尺寸由 alt 里的规约 D 参数表达，没写参数就是
   * 浏览器按原尺寸渲染），所以真实宽高**只做提示、不自动填值** —— 一填就变成
   * 显式的 px，等于把这张图锁死在当前尺寸，换图后不会自适应。
   *
   * 图片加载不出来（文件被挪走、跨域、路径写错）时自然拿不到尺寸，退回默认提示。
   */
  private refreshSizeHints(): void {
    const zh = this.currentLanguage === 'zh'
    const size = this.naturalSize
    const fallback = 'auto / 100px / 50%'
    this.widthInput.placeholder = size ? `auto（原图 ${size.width}px）` : fallback
    this.heightInput.placeholder = size ? `auto（原图 ${size.height}px）` : fallback
    this.widthInput.title = size ? (zh ? `原图实际宽度：${size.width}px` : `Natural width: ${size.width}px`) : ''
    this.heightInput.title = size ? (zh ? `原图实际高度：${size.height}px` : `Natural height: ${size.height}px`) : ''
    // 可见的那行提示：留空不填值也能一眼看到真实尺寸；加载失败则留空（占位高度不变）
    this.sizeHint.textContent = size
      ? (zh
          ? `原图实际尺寸：${size.width} × ${size.height} px（留空即按原图显示）`
          : `Natural size: ${size.width} × ${size.height} px (leave blank to use it)`)
      : ''
  }

  /**
   * 「浏览」按钮：弹系统文件对话框选一张本地图片。
   *
   * 两条通道，结果都是「src 填好 + alt 用文件名兜底」：
   *   1. 桌面版：Electron 的 pickImageFile 返回**本地绝对路径**
   *      （渲染时 toFileUrl 转成 file://，存盘时主进程可再处理）。
   *   2. WebView2 / 纯浏览器：没有 Electron，走下面那个隐藏 input，
   *      读成 base64 data URL —— 本地路径进了 Word 文档就失效了，
   *      只有内嵌才活得下来（与粘贴图片的处理一致，见 editor.ts）。
   *
   * - 插入模式：选中即插入并关闭（工具栏入口的预期行为）；
   * - 编辑模式：只更新 src，等其他参数改完再点「更新」。
   */
  private async browseLocalFile(): Promise<void> {
    if (this.browsing) return
    // typeof 判断而不是直接取真值：属性一存在 TS 就认为条件恒真（TS2774），而这里
    // 要探的是运行时有没有 Electron（纯浏览器下 window.electronAPI 是 undefined）。
    const api = typeof window.electronAPI?.pickImageFile === 'function' ? window.electronAPI : null
    if (!api) {
      // 无 Electron：交给隐藏 input，选完在 change 里接着走 applyPicked。
      // 这里不等结果 —— 原生对话框没有可靠的「已取消」事件，等下去按钮会
      // 一直卡在「选择中」；取消对话框时什么都不发生，模态框照旧开着。
      this.fileInput.value = '' // 允许连选同一个文件
      this.fileInput.click()
      return
    }
    const zh = this.currentLanguage === 'zh'
    this.browsing = true
    this.browseButton.disabled = true
    this.browseButton.textContent = zh ? '选择中...' : 'Choosing...'
    try {
      const path = await api.pickImageFile()
      if (!path) {
        // 用户取消
        this.flashButton(zh ? '已取消' : 'Cancelled', 1200, this.browseButton)
        return
      }
      this.applyPicked(path, altFromPath(path))
    } finally {
      this.browsing = false
      this.browseButton.disabled = false
    }
  }

  /** 隐藏 input 的 change：读成 base64（超限时压缩）后填回表单 */
  private async onFilePicked(): Promise<void> {
    const file = this.fileInput.files?.[0]
    this.fileInput.value = '' // 立刻清空，否则下次选同一个文件不会再触发 change
    if (!file) return
    const zh = this.currentLanguage === 'zh'
    this.browsing = true
    this.browseButton.disabled = true
    this.browseButton.textContent = zh ? '读取中...' : 'Reading...'
    try {
      const result = await fileToEmbeddableDataUrl(file)
      // 压缩摘要：编辑模式下闪在「浏览」按钮上；插入模式弹框会立刻关掉，
      // 所以同时打一条 console，方便事后核（Word 里没有 F12，看宿主日志）
      if (result.compressed) {
        console.info('[image] 已压缩内嵌：', describeCompression(result))
        this.flashButton(`${zh ? '已压缩' : 'Compressed'} ${describeCompression(result)}`, 3000, this.browseButton)
      }
      this.applyPicked(result.dataUrl, altFromPath(file.name))
    } catch (err) {
      console.error('读取本地图片失败:', err)
      this.flashButton(zh ? '读取失败' : 'Read failed', 3000, this.browseButton)
    } finally {
      this.browsing = false
      this.browseButton.disabled = false
    }
  }

  /** 填 src（alt 为空时用名字兜底）；插入模式随即插入，编辑模式停在表单上 */
  private applyPicked(src: string, alt: string): void {
    this.srcInput.value = src
    if (!this.altInput.value.trim()) this.altInput.value = alt
    this.updatePreview()
    if (this.isInsertMode) {
      void this.save()
      return
    }
    this.flashButton(this.currentLanguage === 'zh' ? '已选择' : 'Picked', 1200, this.browseButton)
  }

  /**
   * 将当前 src（网络 URL 或本地路径）转为 Base64 data URL。
   *
   * 两条路（见 image-embed.ts 的 urlToDataUrl）：
   *  1. fetch + FileReader（保留原始格式，服务器给 CORS 头时可用）
   *  2. canvas 兜底（<img> 不受 fetch 同源策略限制；跨域会污染 canvas，
   *     此时失败 —— 桌面版还可以退回本地路径，任务窗格里只能保留原 URL）
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
      const dataUrl = await urlToDataUrl(url)
      if (!dataUrl) throw new Error(zh ? '跨域被拦或图片加载失败' : 'CORS blocked or load failed')
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
   * 「转本地」：把当前 src 里的 base64 或网络图片落到工作目录，src 换成绝对路径。
   *
   * 只改表单，不直接写文档 —— 与「浏览」「转 Base64」一致，仍要点「更新/插入」
   * 才落进编辑器，随时可以取消。已是本地路径时提示一句就返回，不改写既有引用。
   * 下载与落盘都在主进程（渲染端 CSP 不放行跨域请求，见 main/image-localize.ts）。
   */
  private async localizeCurrent(): Promise<void> {
    if (this.localizing) return
    const src = this.srcInput.value.trim()
    if (!src) return
    const zh = this.currentLanguage === 'zh'
    const api = window.electronAPI
    if (typeof api?.storeImageToLocal !== 'function') {
      this.flashButton(zh ? '没有文件系统' : 'No file system', 2000, this.localizeButton)
      return
    }
    // 本地路径 / file:// / 相对路径：不需要（也不应该）复制一份新文件
    if (!/^(https?:|data:)/i.test(src)) {
      this.flashButton(zh ? '已是本地图片' : 'Already local', 1500, this.localizeButton)
      return
    }

    this.localizing = true
    this.localizeButton.disabled = true
    this.localizeButton.textContent = zh ? '下载中…' : 'Saving…'
    try {
      const result = await api.storeImageToLocal({ src })
      if (result?.ok && result.path) {
        this.srcInput.value = result.path
        this.updatePreview()
        this.flashButton(zh ? '已存为本地' : 'Saved locally', 1800, this.localizeButton)
      } else {
        const reason = localizeErrorText(result?.error, zh)
        console.warn('[image] 转本地失败：', result?.error)
        this.flashButton(
          zh ? `失败: ${reason}` : `Failed: ${reason}`,
          3000,
          this.localizeButton
        )
      }
    } catch (error) {
      console.error('[image] 转本地异常：', error)
      this.flashButton(zh ? '转本地失败' : 'Failed', 3000, this.localizeButton)
    } finally {
      this.localizing = false
      this.localizeButton.disabled = !hasStoreChannel()
    }
  }

  /** 短暂更改按钮文案，超时后恢复为当前语言对应文案（默认作用于转 Base64 按钮）。 */
  private flashButton(text: string, duration = 1500, btn: HTMLButtonElement = this.convertButton): void {
    btn.textContent = text
    setTimeout(() => {
      const zh = this.currentLanguage === 'zh'
      if (btn === this.convertButton) {
        btn.textContent = zh ? '转 Base64' : 'To Base64'
      } else if (btn === this.localizeButton) {
        if (this.localizing) return // 仍在下载，别把「下载中…」盖掉
        btn.textContent = zh ? '转本地' : 'To Local'
      } else {
        btn.textContent = zh ? '浏览' : 'Browse'
      }
    }, duration)
  }

  private async save(): Promise<void> {
    const view = getEditorView()
    if (!view) {
      this.hide()
      return
    }

    // 校验尺寸值：空字符串、auto、Npx、N%
    const sizeRe = /^(|auto|\d+(?:\.\d+)?px|\d+(?:\.\d+)?%)$/
    const width = this.widthInput.value.trim()
    const height = this.heightInput.value.trim()

    let src = this.srcInput.value.trim()
    // 没有 Electron 通道时（Word 任务窗格 / 纯浏览器），网络图片也尽量内嵌：
    // 外链一旦离开当前会话就断（离线、换机器、图床挂了），内嵌才稳。
    // 转成不成功（跨域/CORS）就保留原 URL，总比插不进去强。
    if (src && /^https?:/i.test(src) && !hasElectronChannel()) {
      const dataUrl = await urlToDataUrl(src).catch(() => null)
      if (dataUrl) src = dataUrl
    }

    const newAttrs: ImageAttrs = {
      src,
      alt: this.altInput.value,
      width: sizeRe.test(width) ? width : '',
      height: sizeRe.test(height) ? height : '',
      align: this.alignSelect.value,
      // 边框/阴影/圆角已从面板移除：插入一律不写这三种样式；
      // 编辑时沿用节点原值（界面上看不到，但也不能因为面板没有开关就清掉）
      border: this.baseAttrs?.border ?? false,
      shadow: this.baseAttrs?.shadow ?? false,
      radius: this.baseAttrs?.radius ?? false,
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
