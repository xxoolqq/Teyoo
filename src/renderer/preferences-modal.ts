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

type TabKey = 'general' | 'appearance' | 'image' | 'markdown' | 'export' | 'assistant' | 'docx' | 'mineru'

/**
 * 读取导出公式引擎偏好（'Temml' / 'MathJax'），供渲染端发起导出时
 * 经 IPC 传给主进程，主进程映射成注册表 id 选取转换器。
 *
 * 偏好缺失时的兜底与 userSetting 默认值（src/main/user-setting.ts 的
 * export.formulaEngine）保持一致：MathJax（宏包最全）。
 */
export function getExportFormulaEnginePreference(): string {
  return getPrefs<string>('export.formulaEngine') ?? 'MathJax'
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'appearance', label: '外观' },
  { key: 'image', label: '图像' },
  { key: 'markdown', label: 'Markdown' },
  { key: 'export', label: '导出' },
  { key: 'assistant', label: '文档助手' },
  { key: 'docx', label: 'docx转md' },
  { key: 'mineru', label: '图片/PDF转md' },
]

// 从 store 读取偏好值；store 未就绪时返回 undefined（控件工厂做默认处理）
function readPref<T>(path: string): T | undefined {
  return getPrefs<T>(path)
}

/** 工作目录（原「备份图片」）的默认路径；与 main 进程 user-setting 的默认值同一份。 */
export const DEFAULT_WORK_DIR = 'D:/TeyooData'

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
    general: null, appearance: null, image: null, markdown: null, export: null, assistant: null, docx: null,
    mineru: null,
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
    this.tabNodes.assistant = this.buildAssistantPanel()
    this.tabNodes.docx = this.buildDocxPanel()
    this.tabNodes.mineru = this.buildMineruPanel()

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

    root.append(this.group('启动', [
      this.radioRow('打开上次的文件', 'general.launchOnOpen', 'last'),
      this.radioRow('打开新建文件', 'general.launchOnOpen', 'new'),
    ]))

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

    // MinerU 的配置整组搬去了「文档助手」面板：用它的是助手这条线
    // （图片 → 公式、PDF/图片附件转 Markdown）。
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

    // 文档助手侧边栏的显隐（连接信息在「文档助手」面板里填）。写偏好 → 主进程广播
    // → 所有窗口即时同步；侧边栏自己的「收起」按钮写的是同一个字段。
    root.append(this.group('文档助手', [
      this.checkRow('显示文档助手侧边栏', { key: 'assistant.sidebarOpen' }),
    ]))

    // 「阅读速度」分组已移除。

    root.append(this.group('侧边栏', [
      this.checkRow('允许折叠和展开侧边栏的大纲视图', { key: 'appearance.allowCollapseOutline' }),
    ]))

    // 「主题」分组已移除：主题改由菜单栏「主题」切换，偏好设置不再提供入口。

    return root
  }

  // 文档助手 ──────────────────────────────────────────────────────────────

  /**
   * 文档助手（LLM）的连接信息：OpenAI 兼容的 Base URL + API Key + 模型名。
   *
   * 密钥的处理与同面板的「MinerU Token」完全一致：明文存 userSetting.json
   * （桌面端没有更安全的凭据仓），不进日志、只在主进程发请求时作 Authorization
   * 头，环境变量 ASSISTANT_API_KEY 的优先级高于这里。
   */
  private buildAssistantPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    // Base URL
    const urlRow = document.createElement('div')
    urlRow.className = 'prefs-subrow'
    const urlLine = this.inline(this.label('Base URL：'))
    const urlInput = this.input('text', {
      placeholder: 'https://api.deepseek.com/v1',
      style: 'flex:0 1 auto; width:62%; min-width:0',
      value: readPref<string>('assistant.baseUrl') ?? '',
    })
    const commitUrl = (): void => {
      void writePref('assistant.baseUrl', urlInput.value.trim())
    }
    urlInput.addEventListener('change', commitUrl)
    urlInput.addEventListener('blur', commitUrl)
    urlLine.append(urlInput)
    urlRow.append(urlLine, this.hint('OpenAI 兼容端点，填到 /v1 为止（默认 DeepSeek：https://api.deepseek.com/v1）；也可以直接填到 …/chat/completions。'))

    // API Key
    const keyRow = document.createElement('div')
    keyRow.className = 'prefs-subrow'
    const keyLine = this.inline(this.label('API Key：'))
    const keyInput = this.input('password', {
      placeholder: 'sk-…',
      style: 'flex:0 1 auto; width:62%; min-width:0',
      value: readPref<string>('assistant.apiKey') ?? '',
    })
    const commitKey = (): void => {
      void writePref('assistant.apiKey', keyInput.value.trim())
    }
    keyInput.addEventListener('change', commitKey)
    keyInput.addEventListener('blur', commitKey)
    const keyToggle = this.btn('显示', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password'
      keyToggle.textContent = keyInput.type === 'password' ? '显示' : '隐藏'
    })
    keyLine.append(keyInput, keyToggle)
    keyRow.append(keyLine, this.hint('只存在本机的 userSetting.json 里，随请求发给上面那个地址；设置环境变量 ASSISTANT_API_KEY 时以它为准。'))

    // 模型名
    const modelRow = document.createElement('div')
    modelRow.className = 'prefs-subrow'
    const modelLine = this.inline(this.label('模型：'))
    const modelInput = this.input('text', {
      placeholder: 'deepseek-chat',
      style: 'flex:0 1 auto; width:40%; min-width:0',
      value: readPref<string>('assistant.model') ?? '',
    })
    const commitModel = (): void => {
      void writePref('assistant.model', modelInput.value.trim())
    }
    modelInput.addEventListener('change', commitModel)
    modelInput.addEventListener('blur', commitModel)
    modelLine.append(modelInput)
    modelRow.append(modelLine, this.hint('填服务商的模型 id，例如 deepseek-chat、gpt-4o-mini、qwen-plus。'))

    // 测试连接：把当前填的值先落盘，再真发一次极短的请求 —— 密钥/地址写错时
    // 不用切到侧边栏去试。返回的是主进程那套错误码，这里翻成人话。
    const testStatus = document.createElement('span')
    testStatus.className = 'prefs-hint'
    const testRow = document.createElement('div')
    testRow.className = 'prefs-row prefs-btn-row'
    const testBtn = this.btn('测试连接', () => {
      void (async () => {
        commitUrl(); commitKey(); commitModel()
        testBtn.disabled = true
        testStatus.textContent = '测试中…'
        try {
          const result = await window.electronAPI?.assistantComplete?.([{ role: 'user', content: 'ping' }])
          if (!result) {
            testStatus.textContent = '当前环境没有助手接口'
          } else if (result.ok) {
            testStatus.textContent = '连接正常'
          } else {
            const code = result.error ?? ''
            if (code === 'NO_API_KEY') testStatus.textContent = '还没填 API Key'
            else if (code === 'BAD_BASE_URL') testStatus.textContent = 'Base URL 不是合法地址'
            else if (code === 'NO_MODEL') testStatus.textContent = '还没填模型名'
            else if (code.startsWith('HTTP_401') || code.startsWith('HTTP_403')) testStatus.textContent = '鉴权失败：API Key 不对或没有权限'
            else if (code.startsWith('HTTP_404')) testStatus.textContent = '端点不存在（404）：检查 Base URL 要不要带 /v1'
            else testStatus.textContent = `失败：${code}`
          }
        } finally {
          testBtn.disabled = false
        }
      })()
    })
    testRow.append(testBtn, testStatus)

    root.append(this.group('连接', [urlRow, keyRow, modelRow, testRow]))

    root.append(this.group('使用说明', [
      this.hint('侧边栏的开关在「外观 → 文档助手」里。助手只会在你点「应用到文档」时才改正文，产出先显示为建议卡片。'),
      this.hint('选中一段文字后提指令最有效；没有选中时光标所在的那一段会作为上下文。'),
      this.hint('选中一张图再问「把图片识别成公式」，识别顺序是 MinerU → 本地 OCR → 你填的模型；都没认出来就把原图直接交给模型，并要它别凭记忆猜。'),
    ]))
    return root
  }

  // 在线解析（MinerU） ───────────────────────────────────────────────────────
  //
  // 「图片 → 公式」的识别链、以及 PDF/图片附件转 Markdown 的在线识别都用它。
  // Token 明文存在主进程的 userSetting.json（桌面端没有更安全的凭据仓），
  // 环境变量 MINERU_TOKEN 优先于这里填的值。
  private buildMineruPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    const tokenRow = document.createElement('div')
    tokenRow.className = 'prefs-row prefs-field'
    const tokenInput = this.input('password', {
      placeholder: 'sk-…',
      style: 'flex:0 1 auto; width:62%; min-width:0',
      value: readPref<string>('mineru.token') ?? '',
    })
    const commitToken = (): void => {
      void writePref('mineru.token', tokenInput.value.trim())
    }
    // 光标离开就写回（change 在失焦/回车才触发，blur 也挂上，避免"改完直接关面板"丢值）。
    tokenInput.addEventListener('change', commitToken)
    tokenInput.addEventListener('blur', commitToken)
    const tokenToggle = this.btn('显示', () => {
      tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password'
      tokenToggle.textContent = tokenInput.type === 'password' ? '显示' : '隐藏'
    })
    tokenRow.append(this.label('MinerU Token：'), tokenInput, tokenToggle)

    // 逃生开关：默认关。MinerU 的结果 CDN（cdn-mineru.openxlab.org.cn）证书一过期，
    // 不勾这一项就一定 ERR_CERT_DATE_INVALID 下载不下来。勾选的范围很窄 —— 只有
    // 结果包下载那一次请求、只有 MinerU 的结果域名（见 http/mineru.ts）。
    const insecureRow = this.checkRow('忽略结果 CDN 的证书错误', { key: 'mineru.insecureDownload' })

    root.append(this.group('图片/PDF转md（MinerU）', [
      tokenRow,
      insecureRow,
      this.hint('「图片 → 公式」与 PDF/图片 转 Markdown 的在线识别都用它。留空则这些在线识别不可用（会退到本地 OCR / 你填的模型）；设置环境变量 MINERU_TOKEN 时以它为准。'),
      this.hint('MinerU 的结果 CDN 证书过期时（表现为「结果下载失败 … CERT_…」）才需要勾：它会跳过那一次下载的证书校验，网络请求仅限 MinerU 结果域名，不影响其它任何连接。对方证书续期后建议再关掉。'),
    ]))

    return root
  }

  // 「编辑器」面板已整体移除（Tab 设置不再提供界面；tab-indent 插件读的
  // editor.tabSize / tabBehavior 字段保留在 userSetting.json 里，缺省值生效）。

  // 图像 ────────────────────────────────────────────────────────────────────

  private buildImagePanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    // 工作目录（原「备份图片」）：与「启动 → 打开指定文件夹」同一手法——只读
    // 路径框 + 浏览…。这里指定的目录同时也是解析 PDF 时找图片的基准目录之一。
    const workDirRow = document.createElement('div')
    workDirRow.className = 'prefs-subrow'
    const workDirLine = this.inline(this.label('工作目录：'))
    const workDirInput = this.input('text', {
      placeholder: DEFAULT_WORK_DIR,
      readonly: 'readonly',
      style: 'flex:0 1 auto; width:40%; min-width:0; cursor:default',
      value: readPref<string>('image.workDir') ?? DEFAULT_WORK_DIR,
    })
    const workDirBtn = this.btn('浏览…', () => {
      void (async () => {
        const picked = await window.electronAPI?.pickDirectory?.(workDirInput.value || undefined)
        if (!picked) return
        workDirInput.value = picked
        await writePref('image.workDir', picked)
      })()
    })
    const workDirClear = this.btn('清除', () => {
      workDirInput.value = ''
      void writePref('image.workDir', '')
    })
    workDirLine.append(workDirInput, workDirBtn, workDirClear)
    workDirRow.append(workDirLine, this.hint('插入或导入的图片会备份到这里；解析 PDF 时也从这里找图片'))
    root.append(this.group('工作目录', [workDirRow]))

    // 解析 PDF 时的图片落地方式：内嵌 base64 还是只记路径。默认内嵌 —— Markdown
    // 自包含，拷到哪儿都能显示；代价是文件随图片体积涨。
    root.append(this.group('解析 PDF 时的图片', [
      this.checkRow('图片内嵌为 base64', { key: 'image.embedImages' }),
      this.hint('不勾选则 Markdown 里只写图片的绝对路径：文件小得多，但离开本机就显示不出来'),
    ]))

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
      this.checkRow('下标（例：H_{2}）', { key: 'markdown.subscript', checked: readPref<boolean>('markdown.subscript') ?? true, disabled: true }),
      this.checkRow('上标（例：SO_{4}^{2-}）', { key: 'markdown.superscript', checked: readPref<boolean>('markdown.superscript') ?? true, disabled: true }),
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

  // docx转md ──────────────────────────────────────────────────────────────

  private buildDocxPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    root.append(this.group('docx转md', [
      this.checkRow('图片公式自动转 LaTeX（使用内置大模型）', { key: 'docx.imageFormulaOcr' }),
      this.docxOcrUrlRow(),
      this.hint('开启后，导入 Word 时由内置大模型识别行内公式图片并替换为 LaTeX 公式（$latex$）；勾选「公式 OCR 地址」则改走自定义识别服务。'),
    ]))

    return root
  }

  // docx转md：公式 OCR 地址（SimpleTex 契约：POST multipart file，返回 {code,data:{latex}}）
  // 这是可选项：默认不勾选（= 用内置大模型识别），此时地址栏灰化不可编辑；
  // 勾选后才开放填写自定义端点。
  private docxOcrUrlRow(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'prefs-row prefs-field'

    const toggle = document.createElement('label')
    toggle.className = 'prefs-check-inline'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = readPref<boolean>('docx.useCustomOcrUrl') ?? false
    const text = document.createElement('span')
    text.textContent = '公式 OCR 地址'
    toggle.append(cb, text)

    const input = this.input('text', {
      placeholder: 'http://127.0.0.1:8787/api/latex_ocr',
      style: 'flex:0 1 auto; width:62%; min-width:0',
      value: readPref<string>('docx.formulaOcrUrl') ?? '',
    })
    const syncEnabled = (): void => {
      input.disabled = !cb.checked
    }
    const commit = (): void => {
      void writePref('docx.formulaOcrUrl', input.value.trim())
    }
    cb.addEventListener('change', () => {
      void writePref('docx.useCustomOcrUrl', cb.checked)
      syncEnabled()
    })
    input.addEventListener('change', commit)
    input.addEventListener('blur', commit)
    syncEnabled()

    row.append(toggle, input)
    return row
  }

  // 导出 ────────────────────────────────────────────────────────────────────

  private buildExportPanel(): HTMLElement {
    const root = document.createElement('section')
    root.className = 'prefs-panel'

    root.append(this.group('LaTeX 引擎', [
      // 下拉显示 KaTeX / MathJax；存储值仍是 'Temml' / 'MathJax'（Temml 是
      // KaTeX 的 MathML 输出分支，只是显示名换成用户更熟的 KaTeX）。
      this.selectRow('公式渲染引擎', ['KaTeX', 'MathJax'], {
        key: 'export.formulaEngine',
        // 存储值 → 显示名（缺省即默认的 MathJax）
        value: readPref<string>('export.formulaEngine') === 'Temml' ? 'KaTeX' : 'MathJax',
        // 显示名 → 存储值
        map: (v) => (v === 'KaTeX' ? 'Temml' : v),
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

// 惰性创建，别在模块加载时 new：面板控件是"构建时读一次 store 快照"的，而
// import 求值一定早于 main.ts 里的 initPrefsStore()（它在 init() 里被 await）。
// 构造即读只会拿到 undefined，于是每个控件都停在兜底默认值上 —— 表现就是
// 工作目录显示 D:/TeyooData 而实际存储是别的目录，看起来"设置没生效"。
// 改成首次打开面板时才构造，那时快照必然已就绪。
let instance: PreferencesModal | null = null

/** 打开偏好设置面板（第一次调用时才构建 DOM 并读取偏好值） */
export function showPreferencesModal(): void {
  if (!instance) instance = new PreferencesModal()
  instance.show()
}
