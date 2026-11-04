// 全量映射：applyTheme 认识的主题都在这里。
//
// 桌面端只有 THEME_OPTIONS 里的三个对外可选（菜单栏的「主题」已撤，入口在
// 偏好设置「外观 → 主题」），但映射本身不能跟着裁 —— vite.web 那个主题演示页
// （src/web/main.ts）复用同一个 applyTheme，裁掉会让它那十二个主题点不动。
const themes: Record<string, string> = {
  light: 'theme-light',
  dark: 'theme-dark',
  elegant: 'theme-elegant',
  sepia: 'theme-sepia',
  notion: 'theme-notion',
  bear: 'theme-bear',
  writer: 'theme-writer',
  'solarized-dark': 'theme-solarized-dark',
  nord: 'theme-nord',
  gruvbox: 'theme-gruvbox',
  dracula: 'theme-dracula',
  midnight: 'theme-midnight'
}

/**
 * 偏好设置「外观 → 主题」里的可选项 = 桌面端允许切换的全部主题。
 * 顺序即展示顺序，第一条是默认值。菜单栏那份列表已经撤掉，这里是唯一入口，
 * loadSavedTheme() 也按它校验（换过已下线主题的老用户兜底回「雅致」）。
 */
export const THEME_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'elegant', label: '雅致' },
  { id: 'notion', label: '简白' },
  { id: 'dark', label: '深色' }
]

/**
 * 深色系主题的 body class。需要「跟着主题切深色配色」的地方按它判断：Mermaid 图
 * （见 editor/mermaid-bridge.ts），以及 MathLive 的虚拟键盘（见 applyTheme 末段）。
 * 桌面端只会用到 theme-dark，其余几个留给网页演示页。
 */
export const DARK_THEME_CLASSES = new Set([
  'theme-dark',
  'theme-solarized-dark',
  'theme-nord',
  'theme-gruvbox',
  'theme-dracula',
  'theme-midnight',
])

let customStyleEl: HTMLStyleElement | null = null

export function applyTheme(name: string, customCSS?: string): void {
  const body = document.body

  // Remove all theme classes
  Object.values(themes).forEach(cls => body.classList.remove(cls))
  body.classList.remove('theme-custom')

  // Remove custom theme style
  if (customStyleEl) {
    customStyleEl.remove()
    customStyleEl = null
  }

  if (customCSS || name.startsWith('custom:')) {
    if (customCSS) {
      customStyleEl = document.createElement('style')
      customStyleEl.textContent = customCSS
      document.head.appendChild(customStyleEl)
    }
    body.classList.add('theme-custom')
  } else if (themes[name]) {
    body.classList.add(themes[name])
  }

  // MathLive 的虚拟键盘（LaTeX公式 标签页）只认 prefers-color-scheme 和
  // [theme='dark'] 祖先这两条规则，都不认识项目挂在 body 上的 class。把明暗
  // 同步到这个属性上，否则深色主题里会弹出一整块亮白键盘。自定义主题一律按
  // 浅色处理（判断不了它的配色）。
  body.setAttribute('theme', DARK_THEME_CLASSES.has(themes[name] ?? '') ? 'dark' : 'light')

  // Persist theme choice
  localStorage.setItem('teyoo-theme', name)

  // Tell the main process so the theme menu can show the selected state
  window.electronAPI?.reportTheme?.(name)

  // …and hand it the resolved shell colours. Windows paints the window controls
  // inside our own row (titleBarOverlay), and that overlay has to be told a real
  // colour: the chrome surface and the row icons' grey, read off the live computed
  // style so a custom theme works the same as a built-in one.
  const bar = document.getElementById('titlebar')
  if (bar) {
    const surface = getComputedStyle(bar).backgroundColor
    // The OS draws its three glyphs, and they have to sit at the same weight as
    // our four: the platform wants one SOLID colour, while the row's icons are a
    // translucent mix over the chrome, so composite it the way the browser would
    // before handing it over.
    //
    // Both values go over as plain #rrggbb, because the platform parses no CSS
    // Color 4: Chromium hands us `color(srgb 0.1 0.1 0.1)`, Windows rejected the
    // whole overlay call, and the buttons kept the colours from window creation on
    // every theme — including a light strip on a black row (real Windows test,
    // 2026-09-15). Painting each colour onto a canvas and reading the pixel back
    // gives the platform the one string it understands.
    const iconEl = document.getElementById('file-toggle-btn') ?? document.body
    const icon = getComputedStyle(iconEl).color
    const surfaceHex = painted(surface, '#ffffff')
    window.electronAPI?.reportTitlebarColors?.({ background: surfaceHex, symbol: painted(icon, surfaceHex) })
  }
}

// Resolve a colour to #rrggbb, as painted over an opaque one: a translucent value
// is composited exactly the way the browser would, and any CSS colour syntax the
// canvas understands (the platform understands fewer) comes back as hex.
function painted(color: string, background: string): string {
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return color
    ctx.fillStyle = background
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${hex(r)}${hex(g)}${hex(b)}`
  } catch {
    // An unparseable colour keeps the caller's value rather than turning the
    // window controls invisible.
    return color
  }
}

export function loadSavedTheme(): string {
  const saved = localStorage.getItem('teyoo-theme')
  if (!saved) return 'elegant'
  // Custom themes are stored as "custom:<file>.css". Preserve the name so a
  // newly opened window can reload its stylesheet instead of falling back.
  if (saved.startsWith('custom:')) return saved
  // 按 THEME_OPTIONS 校验而不是 themes：映射里还留着网页演示页用的主题，
  // 但桌面端已经不让选了，老用户存过的 sepia / midnight 之类要落到「雅致」。
  if (THEME_OPTIONS.some((option) => option.id === saved)) return saved
  return 'elegant'
}
