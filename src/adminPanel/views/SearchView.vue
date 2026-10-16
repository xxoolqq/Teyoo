<template>
  <div class="topic-page">
    <h2 class="page-title">检索题目</h2>

    <form class="search-bar" @submit.prevent="onSearch">
      <input
        v-model="phrase"
        class="search-input"
        type="text"
        maxlength="100"
        autocomplete="off"
        placeholder="输入关键词，回车检索"
      />
      <button class="search-btn" type="submit" :disabled="loading">检索</button>
    </form>

    <p v-if="loading" class="state">检索中…</p>
    <p v-else-if="error" class="state is-error">{{ error }}</p>
    <template v-else>
      <p v-if="!searched" class="state">输入关键词后开始检索</p>
      <template v-else>
        <p class="state">共 {{ items.length }} 条</p>
        <p v-if="items.length === 0" class="state">没有匹配的题目</p>
        <TopicCard v-for="item in items" :key="item.exerciseCode" :item="item" />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import TopicCard from '../components/TopicCard.vue'
import { searchTopics, type TopicItem } from '../api/topics'
import { describeError, showError, showInfo } from '../stores/toast'

const phrase = ref('')
const items = ref<TopicItem[]>([])
const loading = ref(false)
/** 至少搜过一次才显示「共 N 条 / 没有匹配」，否则一进页面就是「没有匹配的题目」 */
const searched = ref(false)
const error = ref('')

async function onSearch(): Promise<void> {
  const keyphrase = phrase.value.trim()
  if (!keyphrase) {
    showInfo('先输入要检索的关键词')
    return
  }
  loading.value = true
  error.value = ''
  try {
    // 这个接口返回的是完整结果集，不分页（后端没给 total），所以没接分页组件
    items.value = await searchTopics(keyphrase)
    searched.value = true
  } catch (err) {
    error.value = describeError(err)
    showError(error.value)
  } finally {
    loading.value = false
  }
}
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

.search-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.search-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-input-bg, #fff);
}

.search-input:focus {
  border-color: var(--admin-primary, #2d8cf0);
  outline: none;
}

.search-btn {
  flex: none;
  height: 34px;
  padding: 0 20px;
  font-size: 14px;
  color: #fff;
  border: 1px solid var(--admin-primary, #2d8cf0);
  border-radius: 6px;
  background: var(--admin-primary, #2d8cf0);
  cursor: pointer;
}

.search-btn:disabled {
  opacity: 0.6;
  cursor: default;
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
