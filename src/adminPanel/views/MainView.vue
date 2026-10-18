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
            :key="tab.path"
            class="tab"
            :class="{ 'is-active': route.path === tab.path }"
            @click="go(tab.path)"
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
  path: string
  label: string
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

// path → label：Tab 标题直接从菜单推导，不另抄一份
const pathLabel = computed(() => {
  const m = new Map<string, string>()
  for (const g of groups.value) {
    for (const item of g.items) m.set(item.path, item.label)
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
  () => route.path,
  (path) => {
    const label = pathLabel.value.get(path)
    if (!label) return
    if (!tabs.value.some((t) => t.path === path)) tabs.value.push({ path, label })
  },
  { immediate: true }
)

function go(path: string): void {
  if (route.path !== path) void router.push(path)
}

function closeTab(tab: Tab): void {
  const index = tabs.value.findIndex((t) => t.path === tab.path)
  // 入口页（第 0 个）固定不关；找不到（-1）不处理
  if (index <= 0) return
  tabs.value.splice(index, 1)
  // 关的是当前活动页：激活右邻（没了就左邻）
  if (route.path === tab.path) {
    const next = tabs.value[index] ?? tabs.value[index - 1]
    if (next) void router.push(next.path)
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

.nav {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 230px;
  height: 100%;
  overflow-y: auto;
  background: var(--admin-nav-bg, #eef1f6);
  border-right: 1px solid var(--admin-border, #d8dee6);
  transition: margin-left 0.2s ease;
}

.side-collapsed .nav {
  margin-left: -230px;
}

.nav-top {
  flex: none;
  height: 50px;
  line-height: 50px;
  padding: 0 16px;
  font-size: 17px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.wrapper {
  flex: none;
  padding: 4px 0;
}

.wrapper-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 8px 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  cursor: pointer;
  user-select: none;
}

.wrapper-header:hover {
  color: var(--admin-primary, #2d8cf0);
  background: var(--admin-nav-hover, #e0e6ee);
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

.wrapper-title {
  /* 左侧 42px：缩进到分组标题文字（图标 16px + 18px + 间距 8px）之下 */
  padding: 9px 16px 9px 42px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  cursor: pointer;
}

.wrapper-title:hover {
  background: var(--admin-nav-hover, #e0e6ee);
}

.wrapper-title.is-active {
  color: var(--admin-primary, #2d8cf0);
  background: var(--admin-nav-active, #dce8f7);
  font-weight: 600;
}

.nav-foot {
  margin-top: auto;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
  border-top: 1px solid var(--admin-border, #d8dee6);
}

.who {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout {
  flex: none;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}

.nav-content {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--admin-bg, #f4f6f9);
}

/* ── 顶部标签栏：汉堡按钮 + 页签；活动页白底蓝字高亮，其余灰字 ──── */
.tabbar {
  flex: none;
  display: flex;
  align-items: center;
  padding: 6px 12px;
  background: var(--admin-bg, #f4f6f9);
  border-bottom: 1px solid var(--admin-border, #d8dee6);
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
  background: var(--admin-nav-hover, #e0e6ee);
  color: var(--admin-primary, #2d8cf0);
}

.tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.tab:hover {
  color: var(--admin-primary, #2d8cf0);
}

.tab.is-active {
  color: var(--admin-primary, #2d8cf0);
  border-color: var(--admin-primary-weak, #e4eefa);
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
