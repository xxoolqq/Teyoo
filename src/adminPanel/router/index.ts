import {
  createRouter,
  createMemoryHistory,
  createWebHashHistory,
  createWebHistory,
  type RouteRecordRaw,
  type RouterHistory
} from 'vue-router'
import { isLoggedIn } from '../stores/session'
import iconTimu from '../assets/timu.png'
import iconTuchuang from '../assets/tuchuang.png'
import iconTongji from '../assets/tongji.png'
import iconBanji from '../assets/banji.png'

// 菜单的单一数据源：路由 meta 即菜单/标签页数据，侧边栏（MainView）从这里推导，
// 不再手抄一份分组表——加页面只改路由这一处
declare module 'vue-router' {
  interface RouteMeta {
    /** 侧边栏分组标题（带此字段的子路由才进菜单） */
    group?: string
    /** 菜单 / 标签页显示名 */
    label?: string
    /** 分组图标 */
    icon?: string
    /** 需要保活的组件名（KeepAlive include 按组件名匹配；不标记就不缓存） */
    keepAlive?: string
  }
}

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
      {
        path: '',
        name: 'Search',
        component: () => import('../views/SearchView.vue'),
        meta: { group: '题目', label: '检索题目', icon: iconTimu, keepAlive: 'SearchView' }
      },
      {
        path: 'put_topic',
        name: 'PutTopic',
        component: () => import('../views/PutTopicView.vue'),
        meta: { group: '题目', label: '录入题目', icon: iconTimu, keepAlive: 'PutTopicView' }
      },
      {
        path: 'my_topic',
        name: 'MyTopic',
        component: () => import('../views/MyTopicsView.vue'),
        meta: { group: '题目', label: '我录入的题', icon: iconTimu, keepAlive: 'MyTopicsView' }
      },
      {
        path: 'photo_bed',
        name: 'PhotoBed',
        component: () => import('../views/PlaceholderView.vue'),
        meta: { group: '图床', label: '图床', icon: iconTuchuang }
      },
      {
        path: 'my_photo_bed',
        name: 'MyPhotoBed',
        component: () => import('../views/PlaceholderView.vue'),
        meta: { group: '图床', label: '我的图床', icon: iconTuchuang }
      },
      {
        path: 'pick_shell',
        name: 'PickShell',
        component: () => import('../views/PickShellView.vue'),
        meta: { group: '统计分析', label: '题海拾贝', icon: iconTongji, keepAlive: 'PickShellView' }
      },
      {
        path: 'new_class',
        name: 'NewClass',
        component: () => import('../views/NewClassView.vue'),
        meta: { group: '班级管理', label: '创建班级', icon: iconBanji, keepAlive: 'NewClassView' }
      },
      {
        path: 'shenhe_class',
        name: 'Auditing',
        component: () => import('../views/AuditingView.vue'),
        meta: { group: '班级管理', label: '审核加入', icon: iconBanji, keepAlive: 'AuditingView' }
      },
      {
        path: 'put_score',
        name: 'PutScore',
        component: () => import('../views/PutScoreView.vue'),
        meta: { group: '班级管理', label: '成绩录入', icon: iconBanji, keepAlive: 'PutScoreView' }
      },
      {
        path: 'class_tj',
        name: 'ClassTJ',
        component: () => import('../views/ClassTJView.vue'),
        meta: { group: '班级管理', label: '错题统计', icon: iconBanji, keepAlive: 'ClassTJView' }
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
