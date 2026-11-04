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
import iconTongji from '../assets/tongji.png'
import iconBanji from '../assets/banji.png'
import iconWode from '../assets/wode.svg'

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
    // 注册页与登录页同级：都不在 /home 布局里（没有侧边栏和标签栏）
    path: '/register',
    name: 'Register',
    component: () => import('../views/RegisterView.vue')
  },
  {
    path: '/home',
    component: () => import('../views/MainView.vue'),
    children: [
      // 「检索题目」= 走 7088 后端的那份题库，一页两视图：检索全库 / 线上习题（我录的题）。
      // 线上习题原先是一个独立菜单页，现在收进这里当第二个视图（见 SearchView 顶部注释），
      // 所以菜单只剩这一项。
      //
      // singleton：视图状态记在 query.view 上（/home?view=mine），标记单例后切换视图
      // 只改写入口标签的地址，不会在标签栏里多开一个「检索题目」。
      {
        path: '',
        name: 'Search',
        component: () => import('../views/SearchView.vue'),
        meta: {
          group: '题目',
          label: '检索题目',
          icon: iconTimu,
          keepAlive: 'SearchView',
          singleton: true
        }
      },
      {
        path: 'put_topic',
        name: 'PutTopic',
        component: () => import('../views/PutTopicView.vue'),
        meta: { group: '题目', label: '录入题目', icon: iconTimu, keepAlive: 'PutTopicView' }
      },
      // 旧的「线上习题」地址重定向到检索页的线上习题视图：外部若还点着这条路径
      // （或历史标签），落到空白页就难看了。不给 meta，免得它再进菜单。
      {
        path: 'my_topic',
        redirect: { path: '/home', query: { view: 'mine' } }
      },
      {
        path: 'my_favorites',
        name: 'MyFavorites',
        component: () => import('../views/MyFavoritesView.vue'),
        meta: { group: '题目', label: '我的收藏', icon: iconTimu, keepAlive: 'MyFavoritesView' }
      },
      // 纠错审核归在「题目」分组下：审的就是题目的纠错工单
      {
        path: 'correction_review',
        name: 'CorrectionReview',
        component: () => import('../views/CorrectionReviewView.vue'),
        meta: {
          group: '题目',
          label: '纠错审核',
          icon: iconTimu,
          keepAlive: 'CorrectionReviewView'
        }
      },
      // ── 本地题目（与上面的「题目」同级） ──────────────────────────────────
      // 三个页面共用 userData/question-bank.db（离线、不经过 7088），与「线上习题」
      // 是两个不同的库，所以单独成组、排在同一层级；组内顺序即工作流：
      // 拆卷入库（导入中心）→ 到库里核对（本地题库）→ 挑题组卷（智能组卷）。
      // 菜单顺序 = 这里的定义顺序，调整请挪路由块。
      //
      // 导入中心：UI 照 MathBank 的导入工作区还原，样式自成一套（见
      // styles/daoru-center.css），不受本站主题影响；保活是为了拖进来的文件、
      // 填了一半的标题在切标签页后还在。
      {
        path: 'dao_ru',
        name: 'DaoRu',
        component: () => import('../views/DaoRuCenter.vue'),
        meta: { group: '本地题目', label: '导入中心', icon: iconTimu, keepAlive: 'DaoRuCenter' }
      },
      // 「本地题库」= userData/question-bank.db，导入中心「导入此题」写进去的那些题。
      // 与「线上习题」是两个不同的库：前者离线可用、不经过 7088，后者要登录后端账号。
      {
        path: 'local_bank',
        name: 'LocalBank',
        component: () => import('../views/LocalBankView.vue'),
        meta: { group: '本地题目', label: '本地题库', icon: iconTimu, keepAlive: 'LocalBankView' }
      },
      // 智能组卷：左边从本地题库挑题、右边实时成卷，出三种文件（Markdown 卷面 /
      // Word / PDF），见 views/PaperView.vue 顶部注释。保活是为了挑了一半的卷面
      // 在切标签页后还在。
      {
        path: 'paper',
        name: 'Paper',
        component: () => import('../views/PaperView.vue'),
        meta: { group: '本地题目', label: '智能组卷', icon: iconTimu, keepAlive: 'PaperView' }
      },
      // 「线上习题」卡片上的「解析 / 纠错」：各开一个新标签页（带 query.id=题号）。
      // 故意不给 group —— 它们是详情页，不该出现在左侧菜单里，只在顶部标签栏出现。
      //
      // singleton：同一路由只保留一个标签页 —— 点不同题目的「解析」，复用的是
      // 同一个「题目详情」标签，只把 query.id 和页面数据换掉（见 MainView 的 tabs）。
      {
        path: 'detail',
        name: 'TopicDetail',
        component: () => import('../views/TopicDetailView.vue'),
        meta: { label: '题目详情', singleton: true }
      },
      // singleton 同理：点不同题目的「纠错」复用同一个「纠错」标签，只换题号与数据
      {
        path: 'fix_error',
        name: 'FixError',
        component: () => import('../views/FixErrorView.vue'),
        meta: { label: '纠错', singleton: true }
      },
      {
        path: 'pick_shell',
        name: 'PickShell',
        component: () => import('../views/PickShellView.vue'),
        meta: { group: '统计分析', label: '题海拾贝', icon: iconTongji, keepAlive: 'PickShellView' }
      },
      // 错题统计归在「统计分析」下
      {
        path: 'class_tj',
        name: 'ClassTJ',
        component: () => import('../views/ClassTJView.vue'),
        meta: { group: '统计分析', label: '错题统计', icon: iconTongji, keepAlive: 'ClassTJView' }
      },
      // 编码映射归在「班级管理」下：映射按班级建
      {
        path: 'code_mapping',
        name: 'CodeMapping',
        component: () => import('../views/CodeMappingView.vue'),
        meta: { group: '班级管理', label: '编码映射', icon: iconBanji }
      },
      // 班级映射：某个班收到的全部编码映射（谁创建 / 谁加入都算），只读，只有查看 + 统计。
      // 与上面「编码映射」（我创建的、能新建修改发布）是两种视角，别混。
      // 入口已并进「创建班级」右栏（点卡片上的「查看编码映射」，右栏内左右分栏）：
      // 不带 meta.group 就不进侧边栏菜单，路由本身留着，路径直连仍能打开整页版。
      {
        path: 'class_mapping',
        name: 'ClassMapping',
        component: () => import('../views/ClassMappingView.vue'),
        meta: {
          label: '班级映射',
          icon: iconBanji,
          keepAlive: 'ClassMappingView'
        }
      },
      {
        path: 'new_class',
        name: 'NewClass',
        component: () => import('../views/NewClassView.vue'),
        meta: { group: '班级管理', label: '创建班级', icon: iconBanji, keepAlive: 'NewClassView' }
      },
      // 成绩录入同理：入口在「创建班级」右栏（卡片上的「成绩管理」），不进侧边栏
      {
        path: 'put_score',
        name: 'PutScore',
        component: () => import('../views/PutScoreView.vue'),
        meta: { label: '成绩录入', icon: iconBanji, keepAlive: 'PutScoreView' }
      },
      // 分组「我的」：家长账号下管理自己的孩子。加子项只在这里加一条，
      // 侧边栏与标签页都从 meta 推导（见 MainView 的 groups）
      {
        path: 'my_child',
        name: 'MyChild',
        component: () => import('../views/MyChildView.vue'),
        meta: { group: '我的', label: '关联孩子', icon: iconWode }
      },
      // 提交错题：家长账号替名下的孩子批量提交（后端 /background/submit/subjects/sq.do），
      // 排在「关联孩子」后面 —— 得先有关联好的孩子才能提交
      {
        path: 'submit_error',
        name: 'SubmitError',
        component: () => import('../views/SubmitErrorView.vue'),
        meta: { group: '我的', label: '提交错题', icon: iconWode }
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

  // 登录门禁：与 ctbapp 的 router.beforeEach 同一套判断。
  // /register 与 /login 一样是公开页 —— 没登录的人才需要注册，这里要是也拦，
  // 注册入口就会被送回登录页，永远点不进来。
  const PUBLIC_PATHS = new Set(['/login', '/register'])
  router.beforeEach((to) => {
    if (PUBLIC_PATHS.has(to.path)) return true
    if (!isLoggedIn.value) return { path: '/login' }
    return true
  })

  return router
}
