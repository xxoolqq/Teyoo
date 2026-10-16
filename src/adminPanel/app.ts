// ColaMD 挂载入口。
//
// Web 站走 main.ts（hash 路由 + #app）；桌面端走这里：由渲染端在切到
// adminPanel 标签页时把容器 el 交进来，用 memory 路由挂上去（原因见
// router/index.ts 的注释 —— 在宿主的 document 里不能碰 URL）。

import { createApp, type App as VueApp } from 'vue'
import App from './App.vue'
import { createAdminRouter } from './router'
import './styles/admin.css'

let mountedApp: VueApp<Element> | null = null

/** 首次切到该标签页时才真正挂载；之后再切回来直接复用，不重复建 */
export async function mountAdminPanel(el: HTMLElement): Promise<void> {
  if (mountedApp) return
  const app = createApp(App)
  app.use(createAdminRouter('memory'))
  app.mount(el)
  mountedApp = app
}

/** 切走标签页时收起（目前 ColaMD 是隐藏 panel 而不是卸载，这里留着给后续用） */
export function unmountAdminPanel(): void {
  if (!mountedApp) return
  mountedApp.unmount()
  mountedApp = null
}
