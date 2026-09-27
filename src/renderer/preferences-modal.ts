// 偏好设置弹窗 —— Typora 风格 UI
// ────────────────────────────────────────────────────────────────────────────
//
// v2 全控件持久化：所有 checkbox / radio / select 均经 preferences-store
// 读写主进程 userSetting.json（不再有 localStorage 直写）。
// math-engine 的 latex 引擎切换仍走 setMathEngine，后者内部已接 store。
//
// 搜索框 v2 仍占位（留作后续扩展入口）。
// 样式在 themes/base.css 的 ".preferences-*" 规则里。

import { getPrefs, setPrefsPath } from './preferences-store'
import { getActiveMathEngineId, listMathEngines, setMathEngine } from './math-engine'

type TabKey = 'general' | 'appearance' | 'image' | 'markdown' | 'export' | 'account'

/**
 * 读取导出公式引擎偏好（'Temml' / 'MathJax'），供渲染端发起导出时
 * 经 IPC 传给主进程，主进程映射成注册表 id 选取转换器。
 */
export function getExportFormulaEnginePreference(): string {
  return getPrefs<string>('export.formulaEngine') ?? 'Temml'
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'appearance', label: '外观' },
  { key: 'image', label: '图像' },
  { key: 'markdown', label: 'Markdown' },
  { key: 'export', label: '导出' },
  { key: 'account', label: '登录' },
]

// 从 store 读取偏好值；store 未就绪时返回 undefined（控件工厂做默认处理）
function readPref<T>(path: string): T | undefined {
  return getPrefs<T>(path)
}

// 写偏好到 store（自动异步持久化 + 多窗口广播）
async function writePref(path: string, value: unknown): Promise<void> {
  await setPrefsPath(path, value)
}

class PreferencesModal {
  private container: HTMLDivElement
  private modal: HTMLDivElement
  private sidebar: HTMLElement
  private content: HTMLDivElement
  private searchInput: HTMLInputElement
  private closeBtn: HTMLButtonElement
  private activeTab: TabKey = 'general'
  private tabNodes: Record<TabKey, HTMLElement | null> = {
    general: null, appearance: null, image: null, markdown: null, export: null, account: null,
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

    // ── 左侧 Tab 侧边栏 ────────────────────────────────────────────────────
    this.sidebar = document.createElement('nav')
    this.sidebar.className = 'prefs-sidebar'
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

    const body = document.createElement('div')
    body.className = 'prefs-body'
    body.append(this.sidebar, this.content)

    this.modal.append(header, body)
    this.container.appendChild(this.modal)

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
    this.modal.addEventListener('keydown', (e) => e.stopPropagation())

    document.body.appendChild(this.container)

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
    for (const node of this.sidebar.querySelectorAll('.prefs-tab')) {
      node.classList.toggle('active', node === this.sidebar.querySelector(`[data-tab="${tab}"]`))
    }
    for (const [key, node] of Object.entries(this.tabNodes) as [TabKey, HTMLElement | null][]) {
      if (node) node.style.display = key === tab ? '' : 'none'
    }
  }

  // ──────────────────── 面板构建 ────────────────────

  private buildAllPanels(): void {
    this.tabNodes.general = this.buildGeneralPanel()
    this.tabNodes.appearance = this.buildAppearancePanel()
    this.tabNodes.image = this.buildImagePanel()
    this.tabNodes.markdown = this.buildMarkdownPanel()
    this.tabNodes.export = this.buildExportPanel()
    this.tabNodes.account = this.buildAccountPanel()

    for (const node of Object.values(this.tabNodes)) {
      if (node) {
        node.style.display = 'none'
        this.content.appendChild(node)
      }
    }
  }

  // 通用 ────────────────────────────────────────────────────────────────────

  /**
   * 「启动 → 打开指定文件夹」的目标文件夹：只读路径框 + 「浏览…」。
   * 选中该启动项后，菜单「文件 → 打开」的对话框默认定位到此目录。
   */
  private buildLaunchFolderRow(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'prefs-subrow'

    const line = this.inline(this.label('指定文件夹：'))
    const pathInput = this.input('text', {
      placeholder: '未指定',
      readonly: 'readonly',
      // 占整行的 40%（原来是可伸缩的剩余宽度），输入框只作展示用
      style: 'flex:0 1 auto; width:40%; min-width:0; cursor:default',
      value: readPref<string>('general.launchFolder') ?? '',
    })
    const browseBtn = this.btn('浏览…', () => {
      void (async () => {
        const picked = await window.electronAPI?.pickDirectory?.(pathInput.value || undefined)
        if (!picked) return
        pathInput.value = picked
        await writePref('general.launchFolder', picked)
      })()
    })
    line.append(pathInput, browseBtn)
    wrap.append(line, this.hint('菜单「文件 → 打开」默认定位到该文件夹'))
    return wrap
  }

  private buildGeneralPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    // 「打开指定文件夹」选中后，菜单「文件 → 打开」的对话框默认定位到这里。
    // 该行只在选中该启动项时出现（radioRow 的 change 事件驱动显隐）。
    const folderRow = this.buildLaunchFolderRow()
    root.append(this.group('启动', [
      this.radioRow('打开上次的文件', 'general.launchOnOpen', 'last', () => syncFolderRow()),
      this.radioRow('打开新建文件', 'general.launchOnOpen', 'new', () => syncFolderRow()),
      this.radioRow('打开指定文件夹', 'general.launchOnOpen', 'folder', () => syncFolderRow()),
      folderRow,
    ]))
    const syncFolderRow = (): void => {
      const useFolder = readPref<string>('general.launchOnOpen') === 'folder'
      folderRow.style.display = useFolder ? '' : 'none'
    }
    syncFolderRow()

    // 自动保存间隔：0 = 不自动保存，1–5 分钟、每次步进 1 分钟（越界值夹取后回写）
    const intervalInput = this.input('number', {
      value: String(readPref<number>('general.autoSaveIntervalMinutes') ?? 0),
      min: '0', max: '5', step: '1', style: 'width:70px',
    })
    const commitInterval = (): void => {
      const raw = Number(intervalInput.value)
      const minutes = Number.isFinite(raw) ? Math.max(0, Math.min(5, Math.round(raw))) : 0
      intervalInput.value = String(minutes)
      void writePref('general.autoSaveIntervalMinutes', minutes)
    }
    intervalInput.addEventListener('change', commitInterval)
    intervalInput.addEventListener('blur', commitInterval)

    root.append(this.group('自动保存', [
      this.checkRow('离开时自动保存', { key: 'general.autoSaveOnBlur' }),
      this.inline('自动保存间隔：', intervalInput, '分钟'),
      this.hint('0 表示不自动保存；可设 1–5 分钟，每档递增 1 分钟。仅对已保存到磁盘的文档生效。'),
    ]))

    // 文件编码固定为 UTF-8：不用下拉框（带箭头会显得还能选），直接显示静态文本。
    // 旧配置里存过 GBK 的在这里统一回写成 UTF-8。
    const encodingValue = document.createElement('span')
    encodingValue.className = 'prefs-fixed-value'
    encodingValue.textContent = 'UTF-8'
    if (readPref<string>('general.defaultEncoding') !== 'UTF-8') {
      void writePref('general.defaultEncoding', 'UTF-8')
    }
    root.append(this.group('文件编码', [
      this.inline(this.label('默认文件编码'), encodingValue),
      this.hint('文件编码固定为 UTF-8。'),
    ]))

    root.append(this.group('检查更新', [
      this.checkRow('自动检查更新', { key: 'general.autoCheckUpdate' }),
      this.btnRow('立即检查更新', () => {}),
    ]))

    root.append(this.group('高级设置', [
      this.btnRow('打开高级设置（conf.user.json）', () => {}),
      this.checkRow('开启调试模式', { key: 'general.debugMode' }),
    ]))

    return root
  }

  // 外观 ────────────────────────────────────────────────────────────────────

  private buildAppearancePanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    // 「窗口样式」已移除：窗口样式固定（不再提供经典/一体化切换）。

    // 字体大小（Typora 式）：自动 = 沿用主题自带字号；自定义 = 指定正文字号（px）。
    // 自定义输入框只在选中「自定义」时出现。
    const sizeRow = document.createElement('div')
    sizeRow.className = 'prefs-subrow'
    const sizeLine = this.inline(this.label('自定义大小：'))
    const sizeInput = this.input('number', {
      value: String(readPref<number>('appearance.fontSizePx') ?? 16),
      min: '10', max: '40', step: '1', style: 'width:70px',
    })
    const commitSize = (): void => {
      const raw = Number(sizeInput.value)
      const px = Number.isFinite(raw) ? Math.min(40, Math.max(10, Math.round(raw))) : 16
      sizeInput.value = String(px)
      void writePref('appearance.fontSizePx', px)
    }
    sizeInput.addEventListener('change', commitSize)
    sizeInput.addEventListener('blur', commitSize)
    sizeLine.append(sizeInput, document.createTextNode('px'))
    sizeRow.append(sizeLine, this.hint('仅作用于编辑器正文；10–40 px。'))

    root.append(this.group('字体大小', [
      this.radioRow('自动（推荐）', 'appearance.fontSizeMode', 'auto', () => syncSizeRow()),
      this.radioRow('自定义', 'appearance.fontSizeMode', 'custom', () => syncSizeRow()),
      sizeRow,
    ]))
    const syncSizeRow = (): void => {
      sizeRow.style.display = readPref<string>('appearance.fontSizeMode') === 'custom' ? '' : 'none'
    }
    syncSizeRow()

    root.append(this.group('状态栏', [
      this.checkRow('显示状态栏', { key: 'appearance.showStatusBar' }),
    ]))

    // 「阅读速度」分组已移除。

    root.append(this.group('侧边栏', [
      this.checkRow('允许折叠和展开侧边栏的大纲视图', { key: 'appearance.allowCollapseOutline' }),
    ]))

    // 「主题」分组已移除：主题改由菜单栏「主题」切换，偏好设置不再提供入口。

    return root
  }

  // 「编辑器」面板已整体移除（Tab 设置不再提供界面；tab-indent 插件读的
  // editor.tabSize / tabBehavior 字段保留在 userSetting.json 里，缺省值生效）。

  // 图像 ────────────────────────────────────────────────────────────────────

  private buildImagePanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    // 备份图片：与「启动 → 打开指定文件夹」同一手法——只读路径框 + 浏览…
    const backupRow = document.createElement('div')
    backupRow.className = 'prefs-subrow'
    const backupLine = this.inline(this.label('备份文件夹：'))
    const backupInput = this.input('text', {
      placeholder: '未指定',
      readonly: 'readonly',
      style: 'flex:0 1 auto; width:40%; min-width:0; cursor:default',
      value: readPref<string>('image.backupFolder') ?? '',
    })
    const backupBtn = this.btn('浏览…', () => {
      void (async () => {
        const picked = await window.electronAPI?.pickDirectory?.(backupInput.value || undefined)
        if (!picked) return
        backupInput.value = picked
        await writePref('image.backupFolder', picked)
      })()
    })
    const backupClear = this.btn('清除', () => {
      backupInput.value = ''
      void writePref('image.backupFolder', '')
    })
    backupLine.append(backupInput, backupBtn, backupClear)
    backupRow.append(backupLine, this.hint('插入或导入的图片会同时复制一份到该文件夹'))
    root.append(this.group('备份图片', [backupRow]))

    // 「插入图片时…」「上传服务设定」分组与「优先使用相对路径」勾选项已移除。

    root.append(this.group('图片位置处理', [
      this.checkRow('对本地位置的图片应用上述规则', { key: 'image.applyLocal' }),
      this.checkRow('对网络位置的图片应用上述规则', { key: 'image.applyRemote' }),
      this.checkRow('插入时自动转义图片 URL', { key: 'image.escapeUrl' }),
    ]))

    return root
  }

  // Markdown ────────────────────────────────────────────────────────────────

  private buildMarkdownPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    root.append(this.group('Markdown 扩展语法', [
      // 原有条目同样固定（插件常驻启用），保留 store 里的勾选值但不可改
      this.checkRow('LaTeX 公式（例：$LaTeX$ / $$LaTeX$$）', { key: 'markdown.inlineMath', checked: readPref<boolean>('markdown.inlineMath') ?? true, disabled: true }),
      this.checkRow('下标（例：H~2~O）', { key: 'markdown.subscript', checked: readPref<boolean>('markdown.subscript') ?? true, disabled: true }),
      this.checkRow('上标（例：X^2^）', { key: 'markdown.superscript', checked: readPref<boolean>('markdown.superscript') ?? true, disabled: true }),
      this.checkRow('高亮（例：==key==）', { key: 'markdown.highlight', checked: readPref<boolean>('markdown.highlight') ?? true, disabled: true }),
      this.checkRow('图表（序列图、流程图和 Mermaid 图）', { key: 'markdown.diagrams', checked: readPref<boolean>('markdown.diagrams') ?? true, disabled: true }),
      this.checkRow('首行缩进', { key: 'markdown.firstLineIndent', checked: readPref<boolean>('markdown.firstLineIndent') ?? true, disabled: true }),
      // 这些扩展语法常驻启用：固定勾选且不可改（编辑器插件始终注册）
      this.checkRow('字下着重号（例：@.文字.@）', { key: 'markdown.emphDot', checked: true, disabled: true }),
      this.checkRow('上方汉字拼音（拼音在汉字上方）', { key: 'markdown.pinyinRuby', checked: true, disabled: true }),
      this.checkRow('同行平级拼音（拼音在汉字右侧同行）', { key: 'markdown.pinyinInline', checked: true, disabled: true }),
      this.checkRow('汉字右上角带圈序号（例：字^{12}）', { key: 'markdown.circledSup', checked: true, disabled: true }),
      this.checkRow('汉字田字格（例：++明++）', { key: 'markdown.tianziGrid', checked: true, disabled: true }),
      this.checkRow('字体大小（例：{= 三号 : 文字}）', { key: 'markdown.fontSpan', checked: true, disabled: true }),
      this.checkRow('图片语法扩展（尺寸 / 对齐 / 边框）', { key: 'markdown.imageSyntax', checked: true, disabled: true }),
      this.checkRow('子块与分栏（@box / @@cols）', { key: 'markdown.columns', checked: true, disabled: true }),
    ]))

    root.append(this.group('图片公式', [
      this.imageFormulaRow(),
      this.hint('OCR 解析：导入 Word 时将行内公式图片提交识别接口，替换为 LaTeX 公式；保留图片：原样保留图片'),
    ]))

    root.append(this.group('LaTeX 引擎', [
      this.selectRow(
        '公式渲染引擎',
        listMathEngines().map((engine) => engine.label),
        {
          value: listMathEngines().find((e) => e.id === getActiveMathEngineId())?.label,
          onChange: (value) => {
            const engine = listMathEngines().find((e) => e.label === value)
            if (engine) setMathEngine(engine.id)
          },
        },
      ),
    ]))

    return root
  }

  // 图片公式：保留图片（默认）/ OCR 解析；store 存 'keep' / 'ocr'
  private imageFormulaRow(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'prefs-row prefs-field'
    const sel = this.select(['保留图片', 'OCR 解析'])
    sel.value = readPref<string>('markdown.imageFormula') === 'ocr' ? 'OCR 解析' : '保留图片'
    sel.addEventListener('change', () => {
      writePref('markdown.imageFormula', sel.value === 'OCR 解析' ? 'ocr' : 'keep')
    })
    row.append(this.label('图片公式'), sel)
    return row
  }

  // 导出 ────────────────────────────────────────────────────────────────────

  private buildExportPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    root.append(this.group('LaTeX 引擎', [
      this.selectRow('公式渲染引擎', ['Temml', 'MathJax'], { key: 'export.formulaEngine' }),
    ]))

    return root
  }

  // 登录 ────────────────────────────────────────────────────────────────────
  // 邮箱 + 密码，仿参考图卡片式布局（居中 / 圆角输入框 / 蓝色主按钮 / 注册链接）。
  // 后端账户服务尚未接入：登录按钮仅做前端校验并提示，
  // 凭据不持久化（不写 userSetting.json），接入真实服务时替换 onLogin。

  private buildAccountPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel prefs-login'

    const title = document.createElement('h3')
    title.className = 'prefs-login-title'
    title.textContent = '登录'

    const emailInput = this.input('email', { placeholder: '邮箱' })
    emailInput.className = 'prefs-login-input'
    emailInput.autocomplete = 'email'

    const pwdInput = this.input('password', { placeholder: '密码' })
    pwdInput.className = 'prefs-login-input'
    pwdInput.autocomplete = 'current-password'

    // 状态提示行：校验错误（红）/ 中性提示（灰）
    const status = document.createElement('p')
    status.className = 'prefs-login-status'
    status.textContent = ''

    const onLogin = () => {
      const email = emailInput.value.trim()
      const pwd = pwdInput.value
      const error = (msg: string, focus?: HTMLInputElement) => {
        status.className = 'prefs-login-status prefs-login-status-error'
        status.textContent = msg
        focus?.focus()
      }
      if (!email) return error('请输入邮箱', emailInput)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error('邮箱格式不正确', emailInput)
      if (!pwd) return error('请输入密码', pwdInput)
      // TODO: 账户服务接入后改为真实登录请求
      status.className = 'prefs-login-status'
      status.textContent = '登录服务暂未接入，敬请期待'
    }

    const loginBtn = document.createElement('button')
    loginBtn.className = 'prefs-login-btn'
    loginBtn.textContent = '登录'
    loginBtn.addEventListener('click', onLogin)

    // 面板内任意输入框 Enter 即提交
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onLogin()
    })

    // 底部「没有账号？去注册」——注册暂为占位
    const foot = document.createElement('p')
    foot.className = 'prefs-login-foot'
    foot.append('没有账号？')
    const regLink = document.createElement('a')
    regLink.textContent = '去注册'
    regLink.addEventListener('click', () => {
      status.className = 'prefs-login-status'
      status.textContent = '注册服务暂未接入，敬请期待'
    })
    foot.appendChild(regLink)

    const box = document.createElement('div')
    box.className = 'prefs-login-box'
    box.append(title, emailInput, pwdInput, status, loginBtn, foot)
    root.appendChild(box)
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

  private input(
    type: string,
    rawAttrs: Record<string, string | number | ((v: string) => void)> = {},
  ): HTMLInputElement {
    const el = document.createElement('input')
    el.type = type
    const { onInput, ...attrs } = rawAttrs
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') el.setAttribute('style', String(v))
      else el.setAttribute(k, String(v))
    }
    if (typeof onInput === 'function') {
      el.addEventListener('input', () => onInput(el.value))
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

  // checkbox：key 自动从 store 读初值 + 自动 onChange 写 store
  private checkRow(
    text: string,
    opts?: { key?: string; disabled?: boolean; checked?: boolean; onChange?: (checked: boolean) => void },
  ): HTMLElement {
    const row = document.createElement('label')
    row.className = 'prefs-row prefs-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    // checked 显式指定时优先（用于「固定开启且不可改」的条目）
    if (opts?.checked !== undefined) {
      cb.checked = opts.checked
    } else if (opts?.key) {
      // 从 store 读初值；缺省按 true（DEFAULT_SETTING 里大多默认 true）
      const v = readPref<boolean>(opts.key)
      cb.checked = v !== undefined ? v : true
    } else {
      cb.checked = true
    }
    if (opts?.disabled) {
      cb.disabled = true
      // 未显式指定 checked 的禁用项沿用旧行为：置为未勾选
      if (opts.checked === undefined) cb.checked = false
    }
    cb.addEventListener('change', () => {
      if (opts?.key) writePref(opts.key, cb.checked)
      opts?.onChange?.(cb.checked)
    })
    const span = document.createElement('span')
    span.textContent = text
    row.append(cb, span)
    return row
  }

  // radio：name 作为 prefs key，value 作为选中值；自动从 store 读选中项
  private radioRow(text: string, key: string, value: string, onChange?: () => void): HTMLElement {
    const row = document.createElement('label')
    row.className = 'prefs-row prefs-radio'
    const r = document.createElement('input')
    r.type = 'radio'
    r.name = `prefs-${key}`
    r.value = value
    const cur = readPref<string>(key)
    r.checked = cur !== undefined ? cur === value :
      // fallback：兼容旧版默认行为（classic/auto/last 为选中态）
      (value === 'classic' || value === 'auto' || value === 'last')
    r.addEventListener('change', () => {
      if (r.checked) writePref(key, value)
      onChange?.()
    })
    const span = document.createElement('span')
    span.textContent = text
    row.append(r, span)
    return row
  }

  // select：key 自动从 store 读初值 + 自动 onChange 写 store
  // map 用于 select 值是字符串但 store 需要 number 的场景（如 editor.tabSize）
  private selectRow(
    label: string,
    options: string[],
    opts?: { key?: string; value?: string; onChange?: (value: string) => void; map?: (v: string) => unknown },
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'prefs-row prefs-field'
    const sel = this.select(options)
    if (opts?.value != null) {
      sel.value = opts.value
    } else if (opts?.key) {
      const v = readPref<string>(opts.key)
      if (v !== undefined) sel.value = v
    }
    sel.addEventListener('change', () => {
      if (opts?.key) {
        const val = opts.map ? opts.map(sel.value) : sel.value
        writePref(opts.key, val)
      }
      opts?.onChange?.(sel.value)
    })
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
