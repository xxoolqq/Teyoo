<template>
  <section class="meta">
    <div class="meta-row">
      <span class="meta-label">科目类别</span>
      <div class="meta-options">
        <label v-for="name in COURSES" :key="name" class="opt">
          <input v-model="meta.course" type="radio" name="admin-meta-course" :value="name" />
          <span>{{ name }}</span>
        </label>
      </div>
    </div>

    <div class="meta-row">
      <span class="meta-label">适用年级</span>
      <div class="meta-options">
        <label v-for="name in CLASS_LEVEL_NAMES" :key="name" class="opt">
          <input v-model="meta.classLevelName" type="radio" name="admin-meta-level" :value="name" />
          <span>{{ name }}</span>
        </label>
      </div>
    </div>

    <div class="meta-row">
      <span class="meta-label">难易程度</span>
      <div class="meta-options">
        <label v-for="level in EASY_LEVELS" :key="level" class="opt">
          <input v-model="meta.easy" type="radio" name="admin-meta-easy" :value="level" />
          <span>{{ level }}</span>
        </label>
      </div>
    </div>

    <div class="meta-row is-stack">
      <span class="meta-label">知识点</span>
      <textarea
        v-model="meta.knowledgePoints"
        class="meta-textarea"
        rows="2"
        placeholder="知识点用空格分开，英语科目使用逗号隔开"
      ></textarea>
    </div>
  </section>
</template>

<script setup lang="ts">
// 题单元信息。三个选项都用单选组（ctbapp 也是 RadioGroup + Radio）：
// 录题时同一章节连着录，点一下比展开下拉再找快得多。
//
// 做成独立组件是因为「纠错」页与这一页用的是同一套元信息（ctbapp 的 FixError.vue
// 与 CommitExercise.vue 就是同一份 RadioGroup），校验规则一起复用 utils/topic-meta.ts。
import { CLASS_LEVEL_NAMES } from '../utils/class-level'
import { COURSES, EASY_LEVELS, type TopicMeta } from '../utils/topic-meta'

// 表单值由页面持有：提交时要连着题目、答案一起打包，校验顺序也由页面统一决定
const meta = defineModel<TopicMeta>({ required: true })
</script>

<style scoped>
.meta {
  flex: none;
  padding: 8px 12px;
  border-top: 1px solid var(--admin-border);
  background: var(--admin-bg-soft);
}

.meta-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 3px 0;
}

.meta-row.is-stack {
  align-items: stretch;
  flex-direction: column;
  gap: 4px;
}

.meta-label {
  flex: none;
  width: 60px;
  padding-top: 3px;
  color: var(--admin-text-weak);
  font-size: 12px;
}

.meta-options {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 4px;
}

.opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 12px;
  color: var(--admin-text);
  font-size: 12px;
  cursor: pointer;
}

.opt:hover {
  background: var(--admin-hover);
}

.opt input {
  margin: 0;
  accent-color: var(--admin-primary);
}

/* 选中态交给 :has，省掉一层 JS 状态（Chromium 105+ 支持） */
.opt:has(input:checked) {
  border-color: var(--admin-primary);
  background: var(--admin-primary-weak);
  color: var(--admin-primary);
}

.opt:has(input:focus-visible) {
  outline: 2px solid var(--admin-primary);
  outline-offset: 1px;
}

.meta-textarea {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--admin-border);
  border-radius: 4px;
  background: var(--admin-bg);
  color: var(--admin-text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}

.meta-textarea:focus {
  border-color: var(--admin-primary);
  outline: none;
}
</style>
