// ColaMD 侧的接入层。
//
// adminPanel 自己的代码（组件、路由、API）完全不知道 Electron 的存在，这一层
// 是唯一的接缝：它按宿主那套规矩办事 —— body class 切视图、面板 hidden 显隐，
// 与 texo / solver / tool 三个整页标签页同一套。再往下才是 Vue 的世界。

const VIEW_CLASS = 'admin-panel-view'
const PANEL_ID = 'admin-panel'

/** 切进「后台管理系统」标签页：铺面板，然后（首次）把 Vue 应用挂上去 */
export function enterAdminPanelTabChrome(): void {
  document.body.classList.add(VIEW_CLASS)
  const panel = document.getElementById(PANEL_ID)
  if (!panel) return
  panel.hidden = false
  // 动态 import 是有意的：Vue 那几个 chunk 只在用户真的点开这个标签页时才拉，
  // 不能让它压在启动路径上。不 await —— 面板先铺出来，应用随后就到。
  void (async () => {
    try {
      const { mountAdminPanel } = await import('./app')
      await mountAdminPanel(panel)
    } catch (error) {
      console.error('[adminPanel] mount failed:', error)
      panel.textContent = '后台管理系统加载失败，详见控制台'
    }
  })()
}

/** 切走：收起面板（Vue 实例留着，切回来直接复用） */
export function leaveAdminPanelTab(): void {
  document.body.classList.remove(VIEW_CLASS)
  const panel = document.getElementById(PANEL_ID)
  if (panel) panel.hidden = true
}
