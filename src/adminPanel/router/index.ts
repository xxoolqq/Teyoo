import {
  createRouter,
  createMemoryHistory,
  createWebHashHistory,
  createWebHistory,
  type RouteRecordRaw,
  type RouterHistory
} from 'vue-router'
import { isLoggedIn } from '../stores/session'

// 路由模式目前只有 memory 一种在用 —— 它在这里是必须的：
//
//   这个应用挂在宿主渲染进程的一个 div 里，与宿主共用同一个 document。用 hash
//   会去改 location.hash、用 history 会去改地址栏，两者都会动到宿主的 URL
//   （file:// 下 pushState 还会因 opaque origin 直接抛 SecurityError）。
//   memory 全程不碰 URL，最干净。
//
// hash / history 留在类型里，是给将来单独拎出去的那个 Web 项目用的接缝：
// 那边的入口只需要 createAdminRouter('hash')，路由表一行都不用改。
export type HistoryMode = 'memory' | 'hash' | 'history'

// 页面全部按需加载：桌面端只有点开这个标签页才会拉这些 chunk
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/home' },
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/LoginView.vue')
  },
  {
    path: '/home',
    component: () => import('../views/MainView.vue'),
    children: [
      { path: '', name: 'Search', component: () => import('../views/SearchView.vue') },
      {
        path: 'put_topic',
        name: 'PutTopic',
        component: () => import('../views/PutTopicView.vue')
      },
      {
        path: 'my_topic',
        name: 'MyTopic',
        component: () => import('../views/MyTopicsView.vue')
      },
      {
        path: 'photo_bed',
        name: 'PhotoBed',
        component: () => import('../views/PlaceholderView.vue')
      },
      {
        path: 'my_photo_bed',
        name: 'MyPhotoBed',
        component: () => import('../views/PlaceholderView.vue')
      },
      {
        path: 'pick_shell',
        name: 'PickShell',
        component: () => import('../views/PlaceholderView.vue')
      },
      {
        path: 'new_class',
        name: 'NewClass',
        component: () => import('../views/PlaceholderView.vue')
      },
      {
        path: 'shenhe_class',
        name: 'Auditing',
        component: () => import('../views/PlaceholderView.vue')
      },
      {
        path: 'put_score',
        name: 'PutScore',
        component: () => import('../views/PlaceholderView.vue')
      },
      {
        path: 'class_tj',
        name: 'ClassTJ',
        component: () => import('../views/PlaceholderView.vue')
      }
    ]
  }
]

function pickHistory(mode: HistoryMode): RouterHistory {
  if (mode === 'hash') return createWebHashHistory()
  if (mode === 'history') return createWebHistory()
  return createMemoryHistory()
}

export function createAdminRouter(mode: HistoryMode = 'memory') {
  const router = createRouter({ history: pickHistory(mode), routes })

  // 登录门禁：与 ctbapp 的 router.beforeEach 同一套判断
  router.beforeEach((to) => {
    if (to.path === '/login') return true
    if (!isLoggedIn.value) return { path: '/login' }
    return true
  })

  return router
}
