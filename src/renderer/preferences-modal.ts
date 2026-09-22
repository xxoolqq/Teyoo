// 偏好设置弹窗 —— Typora 风格 UI 骨架
// ────────────────────────────────────────────────────────────────────────────
//
// v1 仅实现 UI 外观：6 个一级面板（通用/外观/编辑器/图像/Markdown/导出），
// 全部控件为静态占位（onChange 空转），后续功能逐步接入 localStorage
// 与已有模块（theme-manager、editor-font 等）。
//
// 已接线：Markdown 页的 LaTeX 引擎切换（math-engine/registry，立即生效）、
// 导出页的公式引擎偏好持久化（主进程转换器后续接入）。
//
// 搜索框在 v1 也做出来但不实现过滤——留作后续扩展入口。
//
// 样式写在 themes/base.css 的 ".preferences-*" 规则里，与现有 math-modal
// 同层级，避免 inline style。

import { getActiveMathEngineId, listMathEngines, setMathEngine } from './math-engine'

type TabKey = 'general' | 'appearance' | 'editor' | 'image' | 'markdown' | 'export'

// 导出链路的公式转换引擎偏好（temml / mathjax）。
// 主进程接入点：src/main/formula/registry.ts 的 registerFormulaConverter。
const EXPORT_FORMULA_ENGINE_STORAGE_KEY = 'colamd-export-formula-engine'

function loadExportFormulaEngine(): string {
  try {
    const v = localStorage.getItem(EXPORT_FORMULA_ENGINE_STORAGE_KEY)
    return v === 'MathJax' ? 'MathJax' : 'Temml'
  } catch {
    return 'Temml'
  }
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'appearance', label: '外观' },
  { key: 'editor', label: '编辑器' },
  { key: 'image', label: '图像' },
  { key: 'markdown', label: 'Markdown' },
  { key: 'export', label: '导出' },
]

class PreferencesModal {
  private container: HTMLDivElement
  private modal: HTMLDivElement
  private sidebar: HTMLElement
  private content: HTMLDivElement
  private searchInput: HTMLInputElement
  private closeBtn: HTMLButtonElement
  private activeTab: TabKey = 'general'
  private tabNodes: Record<TabKey, HTMLElement | null> = {
    general: null, appearance: null, editor: null, image: null, markdown: null, export: null,
  }

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'prefs-overlay'
    this.container.style.display = 'none'

    this.modal = document.createElement('div')
    this.modal.className = 'prefs-modal'

    // ── 顶部标题栏 ──────────────────────────────────────────────────────────
    const header = document.createElement('div')
    header.className = 'prefs-header'
    const title = document.createElement('h2')
    title.textContent = '偏好设置'
    this.closeBtn = document.createElement('button')
    this.closeBtn.className = 'prefs-close'
    this.closeBtn.textContent = '✕'
    this.closeBtn.title = '关闭 (Esc)'
    this.closeBtn.addEventListener('click', () => this.hide())
    header.append(title, this.closeBtn)

    // ── 搜索框 ──────────────────────────────────────────────────────────────
    this.searchInput = document.createElement('input')
    this.searchInput.type = 'text'
    this.searchInput.className = 'prefs-search'
    this.searchInput.placeholder = '查找...'
    // v1 不实现过滤，仅占位

    // ── 左侧 Tab 侧边栏 ────────────────────────────────────────────────────
    this.sidebar = document.createElement('nav')
    this.sidebar.className = 'prefs-sidebar'
    // 搜索框与 6 个 tab 同处左侧栏（Typora 布局：搜索在上、tab 在下）
    this.sidebar.appendChild(this.searchInput)
    for (const tab of TABS) {
      const btn = document.createElement('button')
      btn.className = 'prefs-tab'
      btn.dataset.tab = tab.key
      btn.textContent = tab.label
      btn.addEventListener('click', () => this.switchTab(tab.key))
      this.sidebar.appendChild(btn)
    }

    // ── 右侧内容区 ──────────────────────────────────────────────────────────
    this.content = document.createElement('div')
    this.content.className = 'prefs-content'

    // 组装 layout
    const body = document.createElement('div')
    body.className = 'prefs-body'
    body.append(this.sidebar, this.content)

    this.modal.append(header, body)
    this.container.appendChild(this.modal)

    // 遮罩点击关闭；Esc 关闭
    this.container.addEventListener('mousedown', (e) => {
      if (e.target === this.container) this.hide()
    })
    this.container.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.hide()
      }
    })

    // 阻止 modal 内 keydown 冒泡到编辑器（防止 Enter 触发格式化等）
    this.modal.addEventListener('keydown', (e) => e.stopPropagation())

    document.body.appendChild(this.container)

    // 构建所有面板内容（首次 show 前懒加载也行，但 DOM 规模可接受，直接一次构建）
    this.buildAllPanels()
    this.switchTab('general')
  }

  show(): void {
    this.container.style.display = 'flex'
    this.switchTab(this.activeTab)
    this.searchInput.focus()
  }

  hide(): void {
    this.container.style.display = 'none'
    this.activeTab = 'general'
  }

  // ──────────────────── 面板切换 ────────────────────

  private switchTab(tab: TabKey): void {
    this.activeTab = tab
    // 侧边栏选中态
    for (const node of this.sidebar.querySelectorAll('.prefs-tab')) {
      node.classList.toggle('active', node === this.sidebar.querySelector(`[data-tab="${tab}"]`))
    }
    // 内容切换
    for (const [key, node] of Object.entries(this.tabNodes) as [TabKey, HTMLElement | null][]) {
      if (node) node.style.display = key === tab ? '' : 'none'
    }
  }

  // ──────────────────── 面板构建 ────────────────────

  private buildAllPanels(): void {
    this.tabNodes.general = this.buildGeneralPanel()
    this.tabNodes.appearance = this.buildAppearancePanel()
    this.tabNodes.editor = this.buildEditorPanel()
    this.tabNodes.image = this.buildImagePanel()
    this.tabNodes.markdown = this.buildMarkdownPanel()
    this.tabNodes.export = this.buildExportPanel()

    for (const node of Object.values(this.tabNodes)) {
      if (node) {
        node.style.display = 'none'
        this.content.appendChild(node)
      }
    }
  }

  // 通用 ────────────────────────────────────────────────────────────────────

  private buildGeneralPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    // 启动
    root.append(this.group('启动', [
      this.radioRow('打开上次的文件', 'launch-on-open', 'last'),
      this.radioRow('打开新建文件', 'launch-on-open', 'new'),
      this.radioRow('打开指定文件夹', 'launch-on-open', 'folder'),
    ]))

    // 自动保存
    root.append(this.group('自动保存', [
      this.checkRow('离开时自动保存'),
      this.inline('自动保存间隔：', this.input('number', { value: '3', min: '1', max: '60', style: 'width:70px' }), '分钟'),
    ]))

    // 文件编码
    root.append(this.group('文件编码', [
      this.selectRow('默认文件编码', ['UTF-8', 'GBK']),
    ]))

    // 语言
    root.append(this.group('界面语言', [
      this.selectRow('界面语言', ['简体中文', 'English']),
    ]))

    // 检查更新
    root.append(this.group('检查更新', [
      this.checkRow('自动检查更新'),
      this.btnRow('立即检查更新', () => {}),
    ]))

    // 高级设置
    root.append(this.group('高级设置', [
      this.btnRow('打开高级设置（conf.user.json）', () => {}),
      this.checkRow('开启调试模式'),
    ]))

    return root
  }

  // 外观 ────────────────────────────────────────────────────────────────────

  private buildAppearancePanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    root.append(this.group('窗口样式（重启后生效）', [
      this.radioRow('经典', 'window-style', 'classic'),
      this.radioRow('一体化', 'window-style', 'unified'),
    ]))

    root.append(this.group('字体大小', [
      this.radioRow('自动（推荐）', 'font-size-mode', 'auto'),
      this.radioRow('自定义', 'font-size-mode', 'custom'),
    ]))

    root.append(this.group('状态栏', [
      this.checkRow('显示状态栏'),
    ]))

    root.append(this.group('阅读速度', [
      this.inline('阅读速度：', this.input('number', { value: '382', min: '50', max: '2000', style: 'width:80px' }), '词每分钟'),
    ]))

    root.append(this.group('侧边栏', [
      this.checkRow('允许折叠和展开侧边栏的大纲视图'),
    ]))

    root.append(this.group('主题', [
      this.selectRow('主题', ['Github', 'Light', 'Dark', 'Elegant', 'Notion', 'Bear', 'Writer', 'Dracula', 'Midnight']),
      this.checkRow('在深色模式下使用独立的主题'),
      this.btnRow('打开主题文件夹', () => {}),
      this.btnRow('获取主题', () => {}),
    ]))

    return root
  }

  // 编辑器 ──────────────────────────────────────────────────────────────────

  private buildEditorPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    root.append(this.group('Tab 设置', [
      this.selectRow('Tab 大小', ['2', '4', '8']),
      this.selectRow('Tab 键行为', ['缩进', '切换']),
    ]))

    root.append(this.group('显示', [
      this.checkRow('显示行号'),
      this.checkRow('代码块显示代码行数'),
    ]))

    root.append(this.group('智能输入', [
      this.checkRow('智能补全'),
      this.checkRow('允许自动转换中文标点'),
      this.checkRow('自动匹配 HTML 标签'),
    ]))

    root.append(this.group('编辑体验', [
      this.checkRow('打字机模式（光标固定在页面中间）'),
      this.checkRow('显示当前块元素的源代码'),
    ]))

    return root
  }

  // 图像 ────────────────────────────────────────────────────────────────────

  private buildImagePanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    // 插入图片时
    const insertPath = document.createElement('div')
    insertPath.className = 'prefs-row prefs-insert-path'
    insertPath.append(
      this.label('插入图片时…'),
      this.select(['复制到指定路径', '复制到当前文件夹', '复制到上级文件夹']),
      this.input('text', { placeholder: '请输入路径...', style: 'flex:1' }),
      this.btn('浏览…', () => {}),
      this.btn('清除', () => {}),
    )
    const insertHint = document.createElement('p')
    insertHint.className = 'prefs-hint'
    insertHint.textContent = '请输入相对路径（以 "./" 或 "../" 开头）或绝对路径。（其中 ${filename} 表示当前文件名）'
    root.append(this.groupRow(insertPath, insertHint))

    root.append(this.group('图片位置处理', [
      this.checkRow('对本地位置的图片应用上述规则'),
      this.checkRow('对网络位置的图片应用上述规则'),
      this.checkRow('优先使用相对路径'),
      this.checkRow('插入时自动转义图片 URL'),
    ]))

    root.append(this.group('上传服务设定', [
      this.selectRow('上传服务', ['无', 'PicGo-Core', 'GitHub', '七牛云', '阿里云 OSS', '腾讯云 COS']),
      this.btnRow('打开配置文件', () => {}),
    ]))

    return root
  }

  // Markdown ────────────────────────────────────────────────────────────────

  private buildMarkdownPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    // Markdown 扩展语法
    root.append(this.group('Markdown 扩展语法', [
      this.checkRow('内联公式（例：$LaTeX$）'),
      this.checkRow('下标（例：H~2~O）'),
      this.checkRow('上标（例：X^2^）'),
      this.checkRow('高亮（例：==key==）'),
      this.checkRow('图表（序列图、流程图和 Mermaid 图）'),
      this.checkRow('首行缩进'),
    ]))

    // LaTeX 引擎选择 —— 切换后编辑器内公式立即用新引擎重渲染
    root.append(this.group('LaTeX 引擎', [
      this.selectRow(
        '公式渲染引擎',
        listMathEngines().map((engine) => engine.label),
        {
          value: getActiveMathEngineId(),
          onChange: (value) => {
            const engine = listMathEngines().find((e) => e.label === value)
            if (engine) setMathEngine(engine.id)
          },
        },
      ),
    ]))

    return root
  }

  // 导出 ────────────────────────────────────────────────────────────────────

  private buildExportPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    // LaTeX 引擎选择（导出链路独立于编辑器预览引擎）
    // 仅持久化偏好；主进程导出转换器的接入点是 src/main/formula/registry.ts
    // （registerFormulaConverter / getFormulaConverter），后续按此偏好选取转换器。
    root.append(this.group('LaTeX 引擎', [
      this.selectRow('公式渲染引擎', ['Temml', 'MathJax'], {
        value: loadExportFormulaEngine(),
        onChange: (value) => {
          try {
            localStorage.setItem(EXPORT_FORMULA_ENGINE_STORAGE_KEY, value)
          } catch { /* ignore */ }
        },
      }),
    ]))

    return root
  }

  // ──────────────────── 表单控件工厂 ────────────────────

  private group(title: string, rows: HTMLElement[]): HTMLElement {
    const g = document.createElement('div')
    g.className = 'prefs-group'
    const h = document.createElement('h3')
    h.textContent = title
    g.appendChild(h)
    for (const row of rows) g.appendChild(row)
    return g
  }

  private groupRow(...children: HTMLElement[]): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'prefs-group'
    for (const c of children) wrapper.appendChild(c)
    return wrapper
  }

  private label(text: string): HTMLLabelElement {
    const l = document.createElement('label')
    l.className = 'prefs-label'
    l.textContent = text
    return l
  }

  private hint(text: string): HTMLElement {
    const p = document.createElement('p')
    p.className = 'prefs-hint'
    p.textContent = text
    return p
  }

  private input(type: string, attrs: Record<string, string> = {}): HTMLInputElement {
    const el = document.createElement('input')
    el.type = type
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') el.setAttribute('style', v)
      else el.setAttribute(k, v)
    }
    return el
  }

  private select(options: string[]): HTMLSelectElement {
    const sel = document.createElement('select')
    for (const opt of options) {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = opt
      sel.appendChild(o)
    }
    return sel
  }

  private btn(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'prefs-btn'
    b.textContent = text
    b.addEventListener('click', onClick)
    return b
  }

  private checkRow(text: string, opts?: { disabled?: boolean }): HTMLElement {
    const row = document.createElement('label')
    row.className = 'prefs-row prefs-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = true
    if (opts?.disabled) {
      cb.disabled = true
      cb.checked = false
    }
    const span = document.createElement('span')
    span.textContent = text
    row.append(cb, span)
    return row
  }

  private radioRow(text: string, name: string, value: string): HTMLElement {
    const row = document.createElement('label')
    row.className = 'prefs-row prefs-radio'
    const r = document.createElement('input')
    r.type = 'radio'
    r.name = `prefs-${name}`
    r.value = value
    if (value === 'classic' || value === 'auto' || value === 'last') r.checked = true
    const span = document.createElement('span')
    span.textContent = text
    row.append(r, span)
    return row
  }

  private selectRow(
    label: string,
    options: string[],
    opts?: { value?: string; onChange?: (value: string) => void }
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'prefs-row prefs-field'
    const sel = this.select(options)
    if (opts?.value != null) sel.value = opts.value
    if (opts?.onChange) {
      sel.addEventListener('change', () => opts.onChange!(sel.value))
    }
    row.append(this.label(label), sel)
    return row
  }

  private inline(...children: (HTMLElement | string)[]): HTMLElement {
    const row = document.createElement('div')
    row.className = 'prefs-row prefs-inline'
    for (const c of children) {
      if (typeof c === 'string') row.append(document.createTextNode(c))
      else row.append(c)
    }
    return row
  }

  private btnRow(text: string, onClick: () => void): HTMLElement {
    const row = document.createElement('div')
    row.className = 'prefs-row prefs-btn-row'
    row.append(this.btn(text, onClick))
    return row
  }
}

export const preferencesModal = new PreferencesModal()
