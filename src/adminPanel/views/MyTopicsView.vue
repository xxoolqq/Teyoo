<template>
  <div class="topic-page">
    <h2 class="page-title">我录入的题</h2>

    <p v-if="loading" class="state">加载中…</p>
    <p v-else-if="error" class="state is-error">{{ error }}</p>
    <template v-else>
      <p v-if="items.length === 0" class="state">还没有录入过题目</p>
      <template v-else>
        <!-- 题卡与「检索题目」共用，卡片自己的样式在 TopicCard 里 -->
        <TopicCard v-for="item in items" :key="item.exerciseCode" :item="item" />
        <Pagination :total="total" :page-num="pageNum" :page-size="PAGE_SIZE" @change="onPageChange" />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Pagination from '../components/Pagination.vue'
import TopicCard from '../components/TopicCard.vue'
import { fetchMyTopics, type TopicItem } from '../api/topics'
import { describeError, showError } from '../stores/toast'

const PAGE_SIZE = 10

const items = ref<TopicItem[]>([])
const total = ref(0)
const pageNum = ref(1)
const loading = ref(false)
const error = ref('')

async function load(page: number): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await fetchMyTopics(page, PAGE_SIZE)
    items.value = result.list
    total.value = result.total
    pageNum.value = page
  } catch (err) {
    error.value = describeError(err)
    showError(error.value)
  } finally {
    loading.value = false
  }
}

function onPageChange(page: number): void {
  void load(page)
}

onMounted(() => {
  void load(1)
})
</script>

<style scoped>
.topic-page {
  padding: 20px 24px;
}

.page-title {
  margin: 0 0 16px;
  font-size: 17px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.state {
  padding: 8px 0;
  font-size: 14px;
  color: var(--admin-text-weak, #8492a6);
}

.state.is-error {
  color: #e5534b;
  word-break: break-all;
}
</style>
