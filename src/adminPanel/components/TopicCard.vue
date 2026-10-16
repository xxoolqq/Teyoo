<template>
  <!-- 题卡。「我录入的题」和「检索题目」显示的是同一种东西，所以抽出来共用。

       题干是后端渲染好的 HTML，直接显示。安全上有一层兜底：主窗口 CSP 的
       script-src 是 'self'，注入内容里的脚本执行不了。
       TODO：公式（KaTeX 类名）和 Tea 扩展语法（着重号 / 拼音 / 田字格）的样式
       还没对过，等拿到一条真实返回再补这里的 CSS。 -->
  <article class="topic-card">
    <div class="topic-body" v-html="item.subjectHtml ?? ''"></div>
    <footer class="topic-meta">
      <span class="code">题目编号：{{ item.exerciseCode }}</span>
      <!-- 各页自己要加的操作按钮（解析 / 纠错 / 收藏…）放这个插槽 -->
      <span class="ops"><slot name="actions"></slot></span>
    </footer>
  </article>
</template>

<script setup lang="ts">
import type { TopicItem } from '../api/topics'

defineProps<{ item: TopicItem }>()
</script>

<style scoped>
.topic-card {
  margin-bottom: 14px;
  padding: 14px 16px;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 8px;
  background: var(--admin-surface, #fff);
}

.topic-body {
  font-size: 14px;
  line-height: 1.7;
  color: var(--admin-text, #1f2d3d);
  overflow-x: auto;
}

/* 图片是题目里的常客（图床上传的那些），别让它撑破卡片。
   v-html 的内容拿不到 scoped 的 data 属性，这几条要用 :deep 才能生效 */
.topic-body :deep(img) {
  max-width: 100%;
  height: auto;
  vertical-align: middle;
}

.topic-body :deep(table) {
  border-collapse: collapse;
}

.topic-body :deep(p) {
  margin: 0 0 8px;
}

.topic-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--admin-border, #d8dee6);
}

.code {
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.ops {
  display: flex;
  gap: 8px;
}
</style>
