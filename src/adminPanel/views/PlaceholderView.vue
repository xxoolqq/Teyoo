<template>
  <div class="placeholder">
    <p class="title">{{ title }}</p>
    <p class="desc">阶段 0 只搭骨架，这一页还没有接后端数据。</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

// 标题优先取路由 meta.label（中文显示名，与菜单一致）；没配再退回 name。
// 早先只取 name，占位页标题显示的是 CodeMapping 这种英文标识，对不上菜单。
const title = computed(
  () => (route.meta.label as string | undefined) ?? (route.name as string | undefined) ?? '未命名页面'
)
</script>

<style scoped>
.placeholder {
  padding: 40px;
}

.title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.desc {
  margin: 0;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}
</style>
