// Teyoo 侧的接入层。
//
// adminPanel 自己的代码（组件、路由、API）完全不知道 Electron 的存在，这一层
// 是唯一的接缝：它按宿主那套规矩办事 —— body class 切视图、面板 hidden 显隐，
// 与 texo / solver / tool 三个整页标签页同一套。再往下才是 Vue 的世界。

const VIEW_CLASS = 'admin-panel-view'
const PANEL_ID = 'admin-panel'

/** 「导入中心」在 adminPanel 路由表里的位置（见 router/index.ts 的 dao_ru） */
const IMPORT_CENTER_PATH = '/home/dao_ru'

/** 挂载中的那一次：同一面板只挂一次（见 ensureMounted） */
let mounting: Promise<void> | null = null
/** 挂载失败时贴在面板上的那句提示；下次挂载成功就撤掉 */
let errorBox: HTMLElement | null = null

/**
 * 把 Vue 应用挂到面板上（幂等）。
 *
 * 「批量录入」这条路上 `enterAdminPanelTabChrome` 会被调两次 —— activateTab 铺外壳
 * 一次、enterImportCenterTab 一次 —— 不合并的话两个 app 会同时挂进同一个容器。
 * 合并在 app.ts 也有一份，这里先挡住，顺带把失败原因贴到面板上：生产环境没有
 * 控制台可看，「详见控制台」等于什么都没说。
 */
function ensureMounted(panel: HTMLElement): Promise<void> {
  if (mounting) return mounting
  mounting = (async () => {
    try {
      // 动态 import 是有意的：Vue 那几个 chunk 只在用户真的点开这个标签页时才拉，
      // 不能让它压在启动路径上。面板先铺出来，应用随后就到。
      const { mountAdminPanel } = await import('./app')
      await mountAdminPanel(panel)
      errorBox?.remove()
      errorBox = null
    } catch (error) {
      console.error('[adminPanel] mount failed:', error)
      // 失败不留墓碑：切走再切回来（或再点一次）能重试
      mounting = null
      showError(panel, error)
    }
  })()
  return mounting
}

/** 挂载失败：把真正的错误写在面板上，别只留一句「详见控制台」 */
function showError(panel: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  errorBox?.remove()
  const box = document.createElement('p')
  box.className = 'admin-panel-error'
  box.textContent = `后台管理系统加载失败：${message}（切走再切回来可重试，控制台有完整堆栈）`
  errorBox = box
  panel.append(box)
}

/** 切进「后台管理系统」标签页：铺面板，然后（首次）把 Vue 应用挂上去 */
export function enterAdminPanelTabChrome(): void {
  document.body.classList.add(VIEW_CLASS)
  const panel = document.getElementById(PANEL_ID)
  if (!panel) return
  panel.hidden = false
  void ensureMounted(panel)
}

/**
 * 切进后台管理系统并落在「导入中心」。
 *
 * PDF 转 md 标签页右上角的「批量录入」走这里：那份 Markdown 下一步就是拆题，
 * 别让人再从侧边栏找一遍。应用可能还没挂载（第一次点），落点交给 app.ts 补
 * （见 navigateAdminPanel）。同样动态 import —— 别把 Vue 拽进启动路径。
 */
export async function enterImportCenterTab(): Promise<void> {
  // 幂等：挂载本身已经被 ensureMounted 合并成一次，这里再铺一次外壳不会重复挂
  enterAdminPanelTabChrome()
  try {
    const { navigateAdminPanel } = await import('./app')
    await navigateAdminPanel(IMPORT_CENTER_PATH)
  } catch (error) {
    console.error('[adminPanel] navigate failed:', error)
  }
}

/** 切走：收起面板（Vue 实例留着，切回来直接复用） */
export function leaveAdminPanelTab(): void {
  document.body.classList.remove(VIEW_CLASS)
  const panel = document.getElementById(PANEL_ID)
  if (panel) panel.hidden = true
}
