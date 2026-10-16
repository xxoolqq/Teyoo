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

// 路由表里给每个子页面都起了 name，占位页直接拿它当标题，点哪个都看得出是谁
const title = computed(() => (route.name as string | undefined) ?? '未命名页面')
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
