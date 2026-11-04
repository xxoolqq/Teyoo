<template>
  <!-- 布局照 ctbapp 的 views/Main.vue：左边一列分组导航，右边是子页面。
       阶段 0 右边全是占位页，后续把各页面接进来即可 -->
  <div class="main-contain" :class="{ 'side-collapsed': sideCollapsed }">
    <nav class="nav">
      <div class="nav-top">后台管理系统</div>

      <div v-for="group in groups" :key="group.title" class="wrapper">
        <div class="wrapper-header" @click="toggleGroup(group.title)">
          <img class="group-icon" :src="group.icon" alt="" />
          <span>{{ group.title }}</span>
          <svg
            class="group-caret"
            :class="{ 'is-closed': isCollapsed(group.title) }"
            viewBox="0 0 14 14"
            aria-hidden="true"
          >
            <path d="M3.5 5.5 7 9l3.5-3.5" />
          </svg>
        </div>
        <div v-show="!isCollapsed(group.title)" class="group-items">
          <div
            v-for="item in group.items"
            :key="item.path"
            class="wrapper-title"
            :class="{ 'is-active': route.path === item.path }"
            @click="go(item.path)"
          >
            {{ item.label }}
          </div>
        </div>
      </div>

      <div class="nav-foot">
        <span class="who">{{ who }}</span>
        <button class="logout" type="button" @click="onLogout">退出登录</button>
      </div>
    </nav>

    <div class="nav-content">
      <!-- 顶部标签栏：侧边栏点开过的页面都留在这里，随时点击切换；
           当前活动页高亮，「检索题目」（入口页）固定不可关闭 -->
      <div class="tabbar">
        <button
          class="hamburger"
          type="button"
          :title="sideCollapsed ? '展开侧边栏' : '收起侧边栏'"
          @click="sideCollapsed = !sideCollapsed"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" />
          </svg>
        </button>
        <div class="tabs">
          <div
            v-for="(tab, index) in tabs"
            :key="tab.fullPath"
            class="tab"
            :class="{ 'is-active': route.fullPath === tab.fullPath }"
            @click="go(tab.fullPath)"
          >
            <span>{{ tab.label }}</span>
            <span
              v-if="index > 0"
              class="tab-close"
              title="关闭"
              @click.stop="closeTab(tab)"
            >
              <svg viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
              </svg>
            </span>
          </div>
        </div>
      </div>

      <div class="page-body">
        <!-- KeepAlive 是「录入题目」这类页面必须的：Milkdown 实例是绑在 DOM 上的，
             路由切走时若把这份 DOM 销毁，实例还留在内核的 editorRecords 里（内核没有
             destroy，也没有「重新挂到新容器」的路子），切回来只会看到两个空白面板。
             只缓存路由 meta.keepAlive 标记过的页面（include 按组件名匹配），
             占位页切走即销毁，不占内存。 -->
        <router-view v-slot="{ Component }">
          <KeepAlive :include="cachedNames">
            <component :is="Component" />
          </KeepAlive>
        </router-view>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clearSession, session } from '../stores/session'

interface NavItem {
  label: string
  path: string
}

interface Group {
  title: string
  icon: string
  items: NavItem[]
}

interface Tab {
  /** 打开时的完整路径（含 query）。单例页换题目时会被就地改写 */
  fullPath: string
  /** 路由 path：单例页靠它归并（同 path 只有一个标签） */
  path: string
  label: string
  /** 单例：同路由再打开只换数据、不新开标签（见路由 meta.singleton） */
  singleton: boolean
}

const route = useRoute()
const router = useRouter()

// 菜单从路由表推导（单一数据源，见 router/index.ts 的 meta 注释）：
// 带 meta.group 的子路由才进菜单，分组按路由定义顺序（组首次出现的顺序）排列
const groups = computed<Group[]>(() => {
  const byTitle = new Map<string, Group>()
  for (const r of router.getRoutes()) {
    const { group, label, icon } = r.meta
    if (!group || !label) continue
    let g = byTitle.get(group)
    if (!g) {
      g = { title: group, icon: icon ?? '', items: [] }
      byTitle.set(group, g)
    }
    g.items.push({ label, path: r.path })
  }
  return [...byTitle.values()]
})

// path → label：Tab 标题直接从路由 meta 取（菜单页与详情页都在里面）。
// 详情页（题目详情 / 纠错）没有 group，不会进菜单，但要有标签页，所以这里
// 扫的是全部带 meta.label 的路由，不是只扫菜单项。
const pathLabel = computed(() => {
  const m = new Map<string, string>()
  for (const r of router.getRoutes()) {
    if (r.meta.label) m.set(r.path, r.meta.label)
  }
  return m
})

// 只缓存 meta.keepAlive 标记的页面（KeepAlive include 按组件名匹配；
// 未标记的页面切走即销毁，不占内存）
const cachedNames = computed<string[]>(() =>
  router
    .getRoutes()
    .map((r) => r.meta.keepAlive)
    .filter((n): n is string => Boolean(n))
)

const who = computed(() => session.phone || session.userCode || '已登录')

// 侧边栏折叠（汉堡按钮）
const sideCollapsed = ref(false)

// 分组展开状态：默认全部展开（收起集合为空），点击分组头独立收起/展开
const collapsedGroups = ref<Set<string>>(new Set())

function isCollapsed(title: string): boolean {
  return collapsedGroups.value.has(title)
}

function toggleGroup(title: string): void {
  const next = new Set(collapsedGroups.value)
  if (next.has(title)) next.delete(title)
  else next.add(title)
  collapsedGroups.value = next
}

// 路由到哪个分组，就确保该分组展开（用户手动收起的组，路由进去了也重新展开）
watch(
  () => route.path,
  (path) => {
    const owner = groups.value.find((g) => g.items.some((i) => i.path === path))
    if (owner && isCollapsed(owner.title)) toggleGroup(owner.title)
  },
  { immediate: true }
)

// Tab 列表：点侧边栏菜单时打开（已开则只切换）；第 0 个是入口页，不可关闭
const tabs = ref<Tab[]>([])

watch(
  () => route.fullPath,
  (fullPath) => {
    const label = pathLabel.value.get(route.path)
    if (!label) return
    const singleton = route.meta.singleton === true
    if (singleton) {
      // 单例页（题目详情）：已有同 path 的标签就地换地址，只换数据不新开
      const existing = tabs.value.find((t) => t.singleton && t.path === route.path)
      if (existing) {
        existing.fullPath = fullPath
        return
      }
    } else if (tabs.value.some((t) => t.fullPath === fullPath)) {
      return
    }
    tabs.value.push({ fullPath, path: route.path, label, singleton })
  },
  { immediate: true }
)

function go(fullPath: string): void {
  if (route.fullPath !== fullPath) void router.push(fullPath)
}

function closeTab(tab: Tab): void {
  const index = tabs.value.findIndex((t) => t.fullPath === tab.fullPath)
  // 入口页（第 0 个）固定不关；找不到（-1）不处理
  if (index <= 0) return
  tabs.value.splice(index, 1)
  // 关的是当前活动页：激活右邻（没了就左邻）
  if (route.fullPath === tab.fullPath) {
    const next = tabs.value[index] ?? tabs.value[index - 1]
    if (next) void router.push(next.fullPath)
  }
}

function onLogout(): void {
  clearSession()
  void router.push('/login')
}
</script>

<style scoped>
.main-contain {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  /* 折叠时侧边栏用负 margin 滑出左侧，裁在这里别撑出滚动条 */
  overflow: hidden;
}

/* 侧栏是「面」：纯白 + 一条极淡的分隔线，内容区才是灰底。
   导航项做成内缩的圆角块（左右各留 8px），鼠标扫过时是"块亮起来"，
   而不是整行横贯的色带 —— 这是这一版观感差异最大的一处。 */
.nav {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 230px;
  height: 100%;
  padding-bottom: 6px;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--admin-nav-bg, #ffffff);
  border-right: 1px solid var(--admin-border, #e3e8ef);
  transition: margin-left 0.2s ease;
}

.side-collapsed .nav {
  margin-left: -230px;
}

.nav-top {
  flex: none;
  height: 52px;
  line-height: 52px;
  padding: 0 18px;
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--admin-text, #1e293b);
}

.wrapper {
  flex: none;
  padding: 2px 0;
}

/* 分组标题降成小标签：字重与色阶都让位给下面的菜单项，一眼能分出层级 */
.wrapper-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 8px;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--admin-text-weak, #7c8aa0);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s ease, color 0.12s ease;
}

.wrapper-header:hover {
  color: var(--admin-text, #1e293b);
  background: var(--admin-nav-hover, #f1f4f9);
}

.group-icon {
  flex: none;
  width: 18px;
  height: 18px;
  display: block;
}

/* 箭头：展开尖朝上，收起转回尖朝下（180° 旋转动效） */
.group-caret {
  flex: none;
  width: 14px;
  height: 14px;
  margin-left: auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(180deg);
  transition: transform 0.2s ease;
}

.group-caret.is-closed {
  transform: rotate(0deg);
}

/* 缩进对齐分组标题的文字起点：8(margin) + 10(padding) + 18(图标) + 8(gap) = 44 */
.wrapper-title {
  margin: 1px 8px;
  padding: 8px 12px 8px 36px;
  border-radius: 8px;
  font-size: 13.5px;
  color: var(--admin-text, #1e293b);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.wrapper-title:hover {
  background: var(--admin-nav-hover, #f1f4f9);
}

.wrapper-title.is-active {
  color: var(--admin-primary, #2f6fed);
  background: var(--admin-nav-active, #e8f0fe);
  font-weight: 600;
}

.nav-foot {
  margin-top: auto;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--admin-text-weak, #7c8aa0);
  border-top: 1px solid var(--admin-border, #e3e8ef);
}

.who {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout {
  flex: none;
  padding: 4px 9px;
  font-size: 12px;
  color: var(--admin-text-weak, #7c8aa0);
  border: 1px solid var(--admin-border, #e3e8ef);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
}

.logout:hover {
  color: #e5534b;
  border-color: rgba(229, 83, 75, 0.45);
}

.nav-content {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--admin-bg, #f1f4f9);
}

/* ── 顶部标签栏：与侧栏同属「面」，白色通栏；页签是透明胶囊，
      活动页才浮起一层浅主色底 ── */
.tabbar {
  flex: none;
  display: flex;
  align-items: center;
  padding: 8px 14px;
  background: var(--admin-surface, #ffffff);
  border-bottom: 1px solid var(--admin-border, #e3e8ef);
}

.hamburger {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: 8px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--admin-text, #1f2d3d);
  cursor: pointer;
}

.hamburger svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}

.hamburger:hover {
  background: var(--admin-nav-hover, #f1f4f9);
  color: var(--admin-primary, #2f6fed);
}

.tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
}

.tabs::-webkit-scrollbar {
  display: none;
}

/* 页签不再画边框：一整排描边方块太重，透明底 + 圆角已经是可点区域 */
.tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  font-size: 13px;
  color: var(--admin-text-weak, #7c8aa0);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background 0.12s ease, color 0.12s ease;
}

.tab:hover {
  color: var(--admin-text, #1e293b);
  background: var(--admin-nav-hover, #f1f4f9);
}

.tab.is-active {
  color: var(--admin-primary, #2f6fed);
  background: var(--admin-primary-weak, #e8f0fe);
  font-weight: 600;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  color: var(--admin-text-weak, #8492a6);
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;
}

.tab-close svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

.tab-close:hover {
  color: #e5534b;
  background: rgba(229, 83, 75, 0.12);
}

/* 页面主体：滚动收在这一层，标签栏固定在顶部不跟滚 */
.page-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
