<template>
  <!-- 后端是 Spring PageHelper：认 pageNum / pageSize，返回 total。这里按这个来，
       不发明自己的分页参数 -->
  <div v-if="pageCount > 1" class="pager">
    <span class="pager-total">共 {{ total }} 条</span>
    <button class="pager-btn" type="button" :disabled="pageNum <= 1" @click="go(pageNum - 1)">
      上一页
    </button>
    <button
      v-for="page in windowPages"
      :key="page"
      class="pager-btn"
      type="button"
      :class="{ 'is-current': page === pageNum }"
      @click="go(page)"
    >
      {{ page }}
    </button>
    <button class="pager-btn" type="button" :disabled="pageNum >= pageCount" @click="go(pageNum + 1)">
      下一页
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  total: number
  pageNum: number
  pageSize: number
}>()

const emit = defineEmits<{ change: [pageNum: number] }>()

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / Math.max(1, props.pageSize))))

// 只显示当前页附近这几页，几百页时不会铺满一屏
const windowPages = computed<number[]>(() => {
  const span = 5
  const end = Math.min(pageCount.value, props.pageNum + 2)
  const start = Math.max(1, end - span + 1)
  const pages: number[] = []
  for (let page = start; page <= end; page += 1) pages.push(page)
  return pages
})

function go(page: number): void {
  if (page < 1 || page > pageCount.value || page === props.pageNum) return
  emit('change', page)
}
</script>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 16px 0 4px;
}

.pager-total {
  margin-right: 6px;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.pager-btn {
  min-width: 30px;
  height: 30px;
  padding: 0 8px;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
}

.pager-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.pager-btn.is-current {
  color: #fff;
  border-color: var(--admin-primary, #2d8cf0);
  background: var(--admin-primary, #2d8cf0);
}
</style>
