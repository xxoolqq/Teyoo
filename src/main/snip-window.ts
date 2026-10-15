// 菜单「帮助 → 截屏识别公式…」的那一张屏。
//
// 为什么不藏 Teyoo 自己的窗口：菜单是本应用的，点它时它必然在最前面，而用这个
// 功能最常见的场景恰恰是「公式就显示在 Teyoo 里」（PDF对照 / 图片转md 标签页、
// 预览里的公式图）。藏起来反而让用户盯着桌面找不到自己要看的东西。代价是另一
// 种场景得用户自己动手：想截别的窗口里的公式，先把那个窗口切到前面来。
//
// 为什么 Windows 上要绕开 desktopCapturer：它走 Chromium 自己的屏幕捕获后端，
// 抓不到本进程窗口的渲染内容 —— 快照里 Teyoo 自己是一整块空白，别人的窗口却好
// 好的（用户拿着截图来问「这层蒙版怎么是灰的」，其实就是那片空白被压暗了）。
// 系统 GDI 是从屏幕 DC 直接拷最终合成画面，本窗口、别人的窗口、桌面一视同仁。
//
// 为什么范围是「工作区」而不是整块屏：任务栏不属于要识别的内容 —— 把整屏拍进去
// 只会让用户框选时多绕开一条边。（macOS 上 workArea 同样排掉 Dock 与菜单栏。）
//
// 为什么最后要浮一层窗，而不是在主窗口里盖一层 DOM：后者只能截到应用自己的窗
// 口，桌面上的其它内容根本进不来。

import { execFile } from 'child_process'
import { readFile, rm } from 'fs/promises'
import { join } from 'path'
import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } from 'electron'

// 点完菜单到真正抓屏之间的空档：菜单收起来是带动画的，抓早了会把菜单本身拍进快照
const SETTLE_MS = 200
/** 4K 屏整张快照有好几 MB，压到这个最长边：够清晰，也不必把一大坨像素过一遍 IPC */
const MAX_EDGE = 2560
/** 浮层窗口的底色：深色，免得快照还没送来时白闪一下（与 snip.html 的 body 同色） */
const BACKDROP = '#101014'
// 整屏 PNG 转 base64 少说几十万字符，纯色/空帧只有几千：拿它判断 Chromium 那条
// 路是不是给回了一张空图（Windows 上它本来就不适合干这个，只当兜底用）
const MIN_SNAPSHOT_CHARS = 20000

/** 同一时刻只允许一层浮层：连点两次菜单不能叠出两个互相遮挡的选区窗口 */
let activeWindow: BrowserWindow | null = null

/** 要拍的范围：光标所在那块屏的「工作区」（不含任务栏 / Dock / 菜单栏） */
interface SnipTarget {
  display: Electron.Display
  rect: Electron.Rectangle
}

interface ScreenSnapshot {
  dataUrl: string
  display: Electron.Display
  /** 快照覆盖的范围（DIP）：浮层窗口的位置与大小就照它开 */
  rect: Electron.Rectangle
  /** 兜底那一路只截到 Teyoo 自己的窗口，浮层要把这事说清楚 */
  source: 'screen' | 'window'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 抓光标所在的那块屏（多显示器时只拍这一块，不做让用户选屏那一层） */
function resolveTarget(): SnipTarget {
  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayMatching({ x: point.x, y: point.y, width: 1, height: 1 })
  return { display, rect: display.workArea }
}

function loadSnipPage(win: BrowserWindow): Promise<void> {
  const ready = new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => resolve())
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(`${devUrl}/snip.html`)
  else void win.loadFile(join(__dirname, '../renderer/snip.html'))
  return ready
}

function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`${error.message}${stderr ? ` | ${String(stderr).trim()}` : ''}`))
        else resolve()
      }
    )
  })
}

/**
 * Windows 主路：起一段 PowerShell 用 System.Drawing 从屏幕 DC 拷一块出来。
 *
 * 为什么要 SetProcessDPIAware：非 100% 缩放下系统会把不声明 DPI 感知的进程骗进
 * 「逻辑坐标」世界，截出来的只有屏幕左上角一块。声明之后坐标与像素都是物理的，
 * 所以传进去的矩形要先按 scaleFactor 折算成物理像素。
 */
async function grabViaSystemGdi(target: SnipTarget): Promise<string> {
  const { display, rect } = target
  const scale = display.scaleFactor
  const x = Math.round(rect.x * scale)
  const y = Math.round(rect.y * scale)
  const width = Math.round(rect.width * scale)
  const height = Math.round(rect.height * scale)
  const file = join(app.getPath('temp'), `teyoo-snip-${Date.now()}.png`)
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name Dpi -Namespace TeyooSnip -PassThru | Out-Null
[TeyooSnip.Dpi]::SetProcessDPIAware() | Out-Null
$bmp = [System.Drawing.Bitmap]::new(${width}, ${height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, [System.Drawing.Size]::new(${width}, ${height}))
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`
  try {
    await runPowerShell(script)
    const buffer = await readFile(file)
    let image = nativeImage.createFromBuffer(buffer)
    const size = image.getSize()
    // 200% 缩放的屏上，光工作区就有 3072×1824：转成 base64 是十几 MB，过 IPC 太沉。
    // 按比例缩到 MAX_EDGE，坐标换算走的是比例，不受影响
    const longest = Math.max(size.width, size.height)
    if (longest > MAX_EDGE) {
      const ratio = MAX_EDGE / longest
      image = image.resize({
        width: Math.round(size.width * ratio),
        height: Math.round(size.height * ratio),
        quality: 'best'
      })
    }
    const finalSize = image.getSize()
    console.log('[snip] 系统截屏', `${size.width}x${size.height}`, '->', `${finalSize.width}x${finalSize.height}`)
    return image.toDataURL()
  } finally {
    await rm(file, { force: true })
  }
}

/**
 * Chromium 的屏幕捕获：非 Windows 平台的主路，Windows 上只当兜底（它抓不到本
 * 进程窗口的内容）。它只能整屏抓，所以抓到之后再自己裁出工作区那部分。
 */
async function grabViaDesktopCapturer(target: SnipTarget): Promise<string> {
  const { display, rect } = target
  const scale = display.scaleFactor
  const bounds = display.bounds
  let width = Math.round(bounds.width * scale)
  let height = Math.round(bounds.height * scale)
  const longest = Math.max(width, height)
  if (longest > MAX_EDGE) {
    const ratio = MAX_EDGE / longest
    width = Math.round(width * ratio)
    height = Math.round(height * ratio)
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
  console.log(
    '[snip] sources:',
    sources
      .map(
        (item) =>
          `"${item.name}" id=${item.id} display_id=${item.display_id} ${item.thumbnail.getSize().width}x${item.thumbnail.getSize().height}`
      )
      .join(' | ') || '(none)'
  )
  // display_id 是字符串而 display.id 是数字：直接 === 永远匹配不上，这句比较必须过 String()
  const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0]
  if (!source) throw new Error('no screen source available')
  const size = source.thumbnail.getSize()
  // 缩略图的实际尺寸未必等于请求尺寸（Chromium 要照顾宽高比），裁剪坐标得按实际
  // 尺寸与请求尺寸的比例折算
  const fx = width > 0 ? size.width / width : 1
  const fy = height > 0 ? size.height / height : 1
  const cropX = clamp(Math.round((rect.x - bounds.x) * scale * fx), 0, Math.max(0, size.width - 1))
  const cropY = clamp(Math.round((rect.y - bounds.y) * scale * fy), 0, Math.max(0, size.height - 1))
  const cropped = source.thumbnail.crop({
    x: cropX,
    y: cropY,
    width: clamp(Math.round(rect.width * scale * fx), 1, size.width - cropX),
    height: clamp(Math.round(rect.height * scale * fy), 1, size.height - cropY)
  })
  const dataUrl = cropped.toDataURL()
  console.log('[snip] desktopCapturer 截屏', `${cropped.getSize().width}x${cropped.getSize().height}`, '->', dataUrl.length, 'chars')
  if (dataUrl.length < MIN_SNAPSHOT_CHARS) {
    throw new Error(`desktopCapturer 给回的是空帧：这一块截图不该只有 ${dataUrl.length} 字符`)
  }
  return dataUrl
}

async function grabScreen(target: SnipTarget): Promise<ScreenSnapshot> {
  if (process.platform === 'win32') {
    try {
      return { dataUrl: await grabViaSystemGdi(target), display: target.display, rect: target.rect, source: 'screen' }
    } catch (error) {
      // PowerShell 被策略挡住、超时之类：退回 Chromium 那条路。它会缺掉 Teyoo 自己
      // 窗口的内容，但至少还能截到别的窗口
      console.error('[snip] 系统截屏失败，退回 desktopCapturer:', error instanceof Error ? error.message : String(error))
    }
  }
  return { dataUrl: await grabViaDesktopCapturer(target), display: target.display, rect: target.rect, source: 'screen' }
}

/**
 * 最后一道退路：整张屏都拿不到时，至少把 Teyoo 自己的窗口截下来。
 *
 * 走的是 CDP 的 Page.captureScreenshot（导出长图用的就是它，这条在项目里是通的）。
 */
async function grabOriginWindow(origin: BrowserWindow): Promise<ScreenSnapshot> {
  const image = await origin.capturePage()
  const bounds = origin.getBounds()
  console.log('[snip] 退回窗口截图:', JSON.stringify(bounds), '->', `${image.getSize().width}x${image.getSize().height}`)
  return {
    dataUrl: image.toDataURL(),
    display: screen.getDisplayMatching(bounds),
    rect: bounds,
    source: 'window'
  }
}

function openSelectionWindow(snapshot: ScreenSnapshot): Promise<string | null> {
  return new Promise((resolve) => {
    // 浮层就开在快照覆盖的那块范围上：快照和工作区一样大，框选坐标才对得上
    const { rect } = snapshot
    const win = new BrowserWindow({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      // 无框 + 钉在最上层：窗口铺满这一块，里面画的就是那张快照 + 我们自己压的暗
      transparent: false,
      backgroundColor: BACKDROP,
      frame: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      // 先藏着：快照送进去画好了才露面，否则用户先看到一个空窗口闪一下
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/snip.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    })
    // 层级要到 screen-saver：Windows 上普通的 alwaysOnTop 压不住任务栏，
    // 窗口底边和任务栏挨着的时候容易被盖住一条
    win.setAlwaysOnTop(true, 'screen-saver')
    // macOS 的全屏空间是独立的：不声明的话浮层会跑到前一个空间去，用户眼前什么都没有
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    activeWindow = win
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      if (activeWindow === win) activeWindow = null
      if (!win.isDestroyed()) win.destroy()
      resolve(value)
    }

    // 这两个通道只有这个窗口会发，一次截图也只收一次
    ipcMain.once('snip-submit', (_event, dataUrl: unknown) => finish(typeof dataUrl === 'string' ? dataUrl : null))
    ipcMain.once('snip-cancel', () => finish(null))
    // 窗口被人强关（Alt+F4 / 崩了）：等同于取消，不能让调用方一直等
    win.once('closed', () => finish(null))

    void loadSnipPage(win).then(() => {
      if (win.isDestroyed()) return
      // 第二个参数是快照来源：'window' 时浮层要把话说清楚，不然用户以为自己框的是整屏
      win.webContents.send('snip-snapshot', snapshot.dataUrl, snapshot.source)
      win.show()
      win.focus()
    })
  })
}

/** 一次完整的「抓屏 → 框选」：返回用户框出那一块的 data URL，取消则 null */
export async function startSnipCapture(origin?: BrowserWindow | null): Promise<string | null> {
  // 上一次还在框选：把它唤到最前就好，再开一个只会让两个浮层互相盖住
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.focus()
    return null
  }
  try {
    await sleep(SETTLE_MS)
    let snapshot: ScreenSnapshot
    try {
      snapshot = await grabScreen(resolveTarget())
    } catch (error) {
      console.error('[snip] 抓屏失败:', error instanceof Error ? error.message : String(error))
      if (!origin || origin.isDestroyed()) throw error
      snapshot = await grabOriginWindow(origin)
    }
    return await openSelectionWindow(snapshot)
  } finally {
    // 浮层关掉之后把发起窗口接回来：Windows 上它不一定自动回到前台，用户会以为
    // 程序把自己关掉了（窗口还在，只是焦点没跟着回来）
    if (origin && !origin.isDestroyed()) origin.focus()
  }
}
