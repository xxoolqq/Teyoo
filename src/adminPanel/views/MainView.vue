<template>
  <!-- 布局照 ctbapp 的 views/Main.vue：左边一列分组导航，右边是子页面。
       阶段 0 右边全是占位页，后续把各页面接进来即可 -->
  <div class="main-contain">
    <nav class="nav">
      <div class="nav-top">后台管理系统</div>

      <div v-for="group in groups" :key="group.title" class="wrapper">
        <div class="wrapper-header">{{ group.title }}</div>
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

      <div class="nav-foot">
        <span class="who">{{ who }}</span>
        <button class="logout" type="button" @click="onLogout">退出登录</button>
      </div>
    </nav>

    <div class="nav-content">
      <!-- KeepAlive 是「录入题目」这类页面必须的：Milkdown 实例是绑在 DOM 上的，
           路由切走时若把这份 DOM 销毁，实例还留在内核的 editorRecords 里（内核没有
           destroy，也没有「重新挂到新容器」的路子），切回来只会看到两个空白面板。
           KeepAlive 把这段 DOM 原样留着，题目/答案和检索结果切页都不丢。 -->
      <router-view v-slot="{ Component }">
        <KeepAlive>
          <component :is="Component" />
        </KeepAlive>
      </router-view>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clearSession, session } from '../stores/session'

interface NavItem {
  label: string
  path: string
}

const route = useRoute()
const router = useRouter()

// 分组与 ctbapp 的导航一致（连 path 都没改），后续接页面时直接替换组件即可
const groups: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '题目',
    items: [
      { label: '检索题目', path: '/home' },
      { label: '录入题目', path: '/home/put_topic' },
      { label: '我录入的题', path: '/home/my_topic' }
    ]
  },
  {
    title: '图床',
    items: [
      { label: '图床', path: '/home/photo_bed' },
      { label: '我的图床', path: '/home/my_photo_bed' }
    ]
  },
  {
    title: '统计分析',
    items: [{ label: '题海拾贝', path: '/home/pick_shell' }]
  },
  {
    title: '班级管理',
    items: [
      { label: '创建班级', path: '/home/new_class' },
      { label: '审核加入', path: '/home/shenhe_class' },
      { label: '成绩录入', path: '/home/put_score' },
      { label: '错题统计', path: '/home/class_tj' }
    ]
  }
]

const who = computed(() => session.phone || session.userCode || '已登录')

function go(path: string): void {
  void router.push(path)
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
  padding: 8px 0;
}

.wrapper-header {
  padding: 6px 16px;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.wrapper-title {
  padding: 9px 16px 9px 28px;
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
  overflow: auto;
  background: var(--admin-bg, #f4f6f9);
}
</style>
