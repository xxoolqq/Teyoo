<template>
  <!-- 题目详情（ctbapp 里「解析」跳的 /about）。
       在面板顶部标签栏里作为一个新标签页打开，内容取自列表缓存，
       缓存里没有就按题目编号现拉一次（api/topics.fetchTopicByCode）。

       题干 / 答案和列表卡同一条规矩：后端没给 subjectHtml，用 subjectSelf
       （markdown 原文）挂只读 Milkdown 实例就地渲染。 -->
  <div class="detail-page">
    <header class="detail-head">
      <button class="back" type="button" @click="goBack">返回列表</button>
      <span class="code">题目编号：{{ code }}</span>
      <button class="fix" type="button" :disabled="!item" @click="goFixError">纠错</button>
    </header>

    <p v-if="loading" class="state">加载中…</p>
    <p v-else-if="error" class="state is-error">{{ error }}</p>
    <p v-else-if="!item" class="state">没有找到这道题</p>
    <template v-else>
      <!-- id="editor" 与录入页同一个理由：主题里的排版规则全写成 `#editor …` -->
      <div id="editor" class="detail-body">
        <section class="block">
          <h3 class="block-title">题目</h3>
          <div v-if="subjectHtmlText" class="block-html" v-html="subjectHtmlText"></div>
          <div v-else-if="subjectFailed" class="block-html"><pre class="md-raw">{{ subjectMd }}</pre></div>
          <div v-else-if="subjectMd" id="detail-render-subject" class="md-render"></div>
          <p v-else class="is-empty">（空）</p>
        </section>
        <section class="block">
          <h3 class="block-title">答案 / 解析</h3>
          <div v-if="answerHtmlText" class="block-html" v-html="answerHtmlText"></div>
          <div v-else-if="answerFailed" class="block-html"><pre class="md-raw">{{ answerMd }}</pre></div>
          <div v-else-if="answerMd" id="detail-render-answer" class="md-render"></div>
          <p v-else class="is-empty">（空）</p>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { mountReadonlyPreview } from '../utils/readonly-preview'
import { fetchTopicByCode, type TopicItem } from '../api/topics'
import { describeError, showError } from '../stores/toast'
import { getCachedTopic } from '../stores/topic-detail'
import { listPathOf } from '../utils/topic-actions'

const SUBJECT_ROOT = 'detail-render-subject'
const ANSWER_ROOT = 'detail-render-answer'

const route = useRoute()
const router = useRouter()

const code = computed(() => String(route.query.id ?? '').trim())
const item = ref<TopicItem | null>(null)
const loading = ref(false)
const error = ref('')

/** 后端直给的 HTML（优先用，现在实际走不到——后端不填） */
const subjectHtmlText = computed(() => String(item.value?.subjectHtml ?? '').trim())
const answerHtmlText = computed(() => String(item.value?.answerHtml ?? '').trim())
/** markdown 原文（实际数据源，图片链接出库前已被换成可访问 URL） */
const subjectMd = computed(() => String(item.value?.subjectSelf ?? '').trim())
const answerMd = computed(() => String(item.value?.answerSelf ?? '').trim())

/** Milkdown 挂不起来（极端情况）时各自退回裸文本，别整块空白 */
const subjectFailed = ref(false)
const answerFailed = ref(false)

async function load(): Promise<void> {
  const cached = getCachedTopic(code.value)
  if (cached) {
    item.value = cached
    return
  }
  loading.value = true
  error.value = ''
  try {
    item.value = await fetchTopicByCode(code.value)
  } catch (err) {
    error.value = describeError(err)
    showError(error.value)
  } finally {
    loading.value = false
  }
}

/** 与「录入题目」右侧预览同一套管线（扩展语法全量渲染），经全局串行队列排队 */
async function bootRender(rootId: string, md: string, failed: { value: boolean }): Promise<void> {
  if (!md) return
  try {
    await mountReadonlyPreview(rootId, md)
  } catch (err) {
    failed.value = true
    console.warn('[TopicDetail] 内容渲染失败，回退为纯文本', err)
  }
}

// 回来源列表页（「题库管理」或检索页），不是固定回检索页
function goBack(): void {
  void router.push(listPathOf(route))
}

function goFixError(): void {
  // 来源照样往下传：从纠错返回时也回得去原来的列表页
  void router.push({ path: '/home/fix_error', query: { id: code.value, from: listPathOf(route) } })
}

/** 载入并渲染当前 query.id 指向的那道题（首次进来和换题都走这里） */
async function refresh(): Promise<void> {
  await load()
  if (!item.value) return
  // 换题了：上一题的渲染失败标记不能串到这一题上
  subjectFailed.value = false
  answerFailed.value = false
  await bootRender(SUBJECT_ROOT, subjectMd.value, subjectFailed)
  await bootRender(ANSWER_ROOT, answerMd.value, answerFailed)
}

onMounted(() => {
  void refresh()
})

// 「题目详情」是单例标签（路由 meta.singleton）：点另一道题的「解析」只是把
// query.id 换掉，组件被复用、mounted 不会再跑 —— 必须盯着题号自己重载，
// 否则标签换了、内容还停在上一题。
watch(code, () => {
  void refresh()
})
</script>

<style scoped>
.detail-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.detail-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--admin-border, #d8dee6);
}

.code {
  font-size: 13px;
  font-family: 楷体, '楷体_GB2312';
  color: var(--admin-text, #1f2d3d);
}

.back,
.fix {
  height: 28px;
  padding: 0 12px;
  font-family: inherit;
  font-size: 12px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
}

.fix {
  margin-left: auto;
}

.back:hover:not(:disabled),
.fix:hover:not(:disabled) {
  color: var(--admin-primary, #2d8cf0);
  border-color: var(--admin-primary, #2d8cf0);
}

/* 与录入页同一条高优先级选择器：把 #editor 从
   body.admin-panel-view #editor { display: none } 手里抢回来 */
#admin-panel .detail-page #editor.detail-body {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  margin: 0;
  padding: 0;
  overflow: auto;
}

.block {
  padding: 14px 20px;
}

.block + .block {
  border-top: 1px solid var(--shell-line, var(--admin-border));
}

.block-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--admin-text-weak, #8492a6);
}

/* 后端直给 HTML 的显示路径 */
.block-html {
  font-family: 'Microsoft YaHei';
  font-size: 14px;
  line-height: 2em;
  color: var(--admin-text, #1f2d3d);
  overflow-x: auto;
}

.block-html :deep(img) {
  max-width: 100%;
  height: auto;
}

.block-html :deep(table) {
  border-collapse: collapse;
}

.block-html :deep(p) {
  margin: 0 0 8px;
}

/* Milkdown 只读渲染（同 TopicCard） */
.md-render {
  pointer-events: none;
  cursor: default;
}

.md-render :deep(.milkdown) {
  display: flex;
  flex-direction: column;
}

.md-render :deep(.ProseMirror) {
  max-width: none;
  margin: 0;
  font-family: 'Microsoft YaHei';
  font-size: 14px;
  line-height: 2em;
}

.md-render :deep(.code-copy-btn) {
  display: none;
}

.md-render :deep(img) {
  max-width: 100%;
  height: auto;
}

/* 渲染失败退回的裸文本 */
.md-raw {
  margin: 0;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.is-empty {
  margin: 0;
  font-size: 14px;
  color: var(--admin-text-weak, #8492a6);
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
