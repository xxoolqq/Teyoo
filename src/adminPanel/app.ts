// Teyoo 挂载入口。
//
// Web 站走 main.ts（hash 路由 + #app）；桌面端走这里：由渲染端在切到
// adminPanel 标签页时把容器 el 交进来，用 memory 路由挂上去（原因见
// router/index.ts 的注释 —— 在宿主的 document 里不能碰 URL）。

import { createApp, type App as VueApp } from 'vue'
import type { Router } from 'vue-router'
import App from './App.vue'
import { createAdminRouter } from './router'
import { initSession } from './stores/session'
import './styles/admin.css'

let mountedApp: VueApp<Element> | null = null
let mountedRouter: Router | null = null
/** 挂载中的那一次（见 mountAdminPanel 的并发说明） */
let mounting: Promise<void> | null = null
/** 应用还没挂载就要跳页时的落点（见 navigateAdminPanel） */
let pendingPath: string | null = null

/**
 * 首次切到该标签页时才真正挂载；之后再切回来直接复用，不重复建。
 *
 * 用 Promise 而不是 `if (mountedApp) return` 做闸门：`initSession()` 里有 IPC，
 * 两个调用方（切标签页 + 「批量录入」）会在它 await 的窗口里同时通过判空，
 * 结果两个 app 挂进同一个容器 —— 后挂的会把先挂的 vnode 当成自己的旧树去
 * patch，界面直接乱掉。合并成同一个 Promise，谁先来谁挂。
 */
export function mountAdminPanel(el: HTMLElement): Promise<void> {
  if (!mounting) {
    mounting = doMount(el).catch((error: unknown) => {
      // 失败不放墓碑：切走再切回来应当能重试
      mounting = null
      throw error
    })
  }
  return mounting
}

async function doMount(el: HTMLElement): Promise<void> {
  // 登录态要先于路由准备好：桌面端 token 在主进程 safeStorage 里，读它是一次
  // 异步 IPC —— 不等它，beforeEach 会把已登录用户踢去 /login。
  await initSession()
  const app = createApp(App)
  const router = createAdminRouter('memory')
  // 懒加载页面拉不下来（构建产物被替换、chunk 404）时，vue-router 只会把它当
  // 一次失败的导航静默记在控制台里。挂个 onError 至少把 URL 打出来 —— 这种
  // 「点了没反应」最容易被当成界面 bug 去查。
  router.onError((error) => {
    console.error('[adminPanel] route error:', error)
  })
  app.use(router)
  app.mount(el)
  mountedApp = app
  mountedRouter = router
  if (!pendingPath) return
  // 挂载期间就点了「批量录入」的（应用还在拉 chunk）：这里把落点补上。
  // 先等首次导航落定，否则两次导航会互相打断（守卫里的 /login 跳转也会被顶掉）。
  const target = pendingPath
  pendingPath = null
  try {
    await router.isReady()
    await router.replace(target)
  } catch (error) {
    // 应用本身是挂上了的，只是这一跳没成（懒加载 chunk 失败 / 导航被打断）。
    // 别让它冒到宿主那层被当成「加载失败」—— 停在路由本来会落的那一页即可。
    console.error('[adminPanel] pending route failed:', error)
  }
}

/**
 * 跳到某个页面（「导入中心」= /home/dao_ru）。
 *
 * 应用还没挂载时只记下落点：首次点「批量录入」走的正是这条路径 —— 面板先铺出来，
 * Vue 那几个 chunk 随后才到，这时路由实例还不存在（见 host.ts）。
 * 未登录时由路由守卫接管，照常落在 /login，这里不重复判断。
 */
export async function navigateAdminPanel(path: string): Promise<void> {
  if (!mountedRouter) {
    pendingPath = path
    return
  }
  await mountedRouter.replace(path)
}

/** 切走标签页时收起（目前 Teyoo 是隐藏 panel 而不是卸载，这里留着给后续用） */
export function unmountAdminPanel(): void {
  if (!mountedApp) return
  mountedApp.unmount()
  mountedApp = null
  mountedRouter = null
  mounting = null
}
