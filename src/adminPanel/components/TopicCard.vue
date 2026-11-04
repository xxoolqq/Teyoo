<template>
  <!-- 题卡。「题库管理」和「检索题目」显示的是同一种东西，所以抽出来共用。

       版式照 ctbapp 的 MyTopic.vue：830px 宽、10px 圆角、gainsboro 细边的卡片，
       题干铺在上半，下面压一条 #f4f4f4 的元信息条（40px 高，左右各 20px 内边距），
       左边题目编号（楷体），右边一排「图标 + 文字」的操作项。

       题干显示：后端列表接口从来没填过 subjectHtml（ExerciseMapper 的列清单里
       就没有这一列，实体里也无人赋值），实际可用的是 subjectSelf —— markdown
       原文，图片链接出库前已由 resolveImages 换成可直接访问的 URL。这里给它
       挂一个只读 Milkdown 实例就地渲染，与「录入题目」的预览同一套管线，
       公式 / 表格 / 图片（含 alt 尺寸参数）都按同一副样式出。 -->
  <article class="topic-card">
    <div class="topic-body">
      <!-- 优先用现成 HTML（后端哪天真填了 subjectHtml 就直接用），
           没有就本地渲染 markdown，再没有就提示空 -->
      <div v-if="subjectHtmlText" class="html-body" v-html="subjectHtmlText"></div>
      <div v-else-if="renderFailed" class="md-raw">{{ markdownText }}</div>
      <div v-else-if="markdownText" :id="renderRootId" class="md-render"></div>
      <p v-else class="is-empty">（题干为空）</p>
    </div>
    <footer class="topic-meta">
      <span class="code">题目编号：{{ item.exerciseCode }}</span>
      <!-- 各页自己要加的操作按钮（解析 / 纠错 / 收藏…）放这个插槽 -->
      <span class="ops"><slot name="actions"></slot></span>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { mountReadonlyPreview } from '../utils/readonly-preview'
import type { TopicItem } from '../api/topics'

const props = defineProps<{ item: TopicItem }>()

const subjectHtmlText = computed(() => String(props.item.subjectHtml ?? '').trim())
const markdownText = computed(() => String(props.item.subjectSelf ?? '').trim())

/** 每张卡一个挂载点；题号全局唯一，直接当 id 用 */
const renderRootId = computed(() => `topic-render-${String(props.item.exerciseCode ?? '')}`)

/** Milkdown 挂不起来（极端情况）时退回裸文本，别整卡空白 */
const renderFailed = ref(false)

onMounted(() => {
  if (subjectHtmlText.value || !markdownText.value) return
  // 与「录入题目」右侧预览同一套管线（扩展语法全量渲染），但经全局串行队列
  // 排队 —— 一页 5 张卡各自 onMounted 同时开跑的话，内核并发建实例会交错。
  void mountReadonlyPreview(renderRootId.value, markdownText.value).catch((err) => {
    renderFailed.value = true
    // 一页 5 张卡，弹 5 条 toast 太吵：只落控制台
    console.warn('[TopicCard] 题干渲染失败，回退为纯文本', err)
  })
})
</script>

<style scoped>
/* 卡片：圆角边框 + 溢出裁切 —— 不裁的话底部那条灰条的圆角会翘在圆角外面 */
.topic-card {
  width: 100%;
  max-width: 830px;
  margin: 0 0 20px;
  border: 1px solid gainsboro;
  border-radius: 10px;
  overflow: hidden;
  background: var(--admin-surface, #fff);
}

/* 题干（ctbapp 的 .search_content：20px 内边距、雅黑、2 倍行高） */
.topic-body {
  margin: 20px;
  overflow-x: auto;
}

/* 后端直给 HTML 的显示路径（现在走不到，留作后端补齐 subjectHtml 后的捷径） */
.html-body {
  font-family: 'Microsoft YaHei';
  font-size: 14px;
  line-height: 2em;
  color: var(--admin-text, #1f2d3d);
}

/* Milkdown 只读渲染：整块不吃鼠标（滚动交给卡片层 overflow），免得点题干
   把「活跃编辑器」抢走、表格悬浮条浮出来 */
.md-render {
  pointer-events: none;
  cursor: default;
}

.md-render :deep(.milkdown) {
  display: flex;
  flex-direction: column;
}

/* 主题给正文限宽 780px 居中（那是编辑器页面的版心），卡片里铺满即可；
   字号按 ctbapp 卡片来：14px / 2 倍行高 */
.md-render :deep(.ProseMirror) {
  max-width: none;
  margin: 0;
  font-family: 'Microsoft YaHei';
  font-size: 14px;
  line-height: 2em;
}

/* 编辑器才需要的东西：代码块复制按钮、图片选中框都收掉 */
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
  color: var(--admin-text, #1f2d3d);
}

.is-empty {
  margin: 0;
  font-size: 14px;
  color: var(--admin-text-weak, #8492a6);
}

/* v-html 的内容拿不到 scoped 的 data 属性，这几条要用 :deep 才能生效 */
.html-body :deep(img) {
  max-width: 100%;
  height: auto;
  vertical-align: middle;
}

.html-body :deep(table) {
  border-collapse: collapse;
}

.html-body :deep(p) {
  margin: 0 0 8px;
}

/* 底部元信息条（ctbapp 的 .search_meta） */
.topic-meta {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 40px;
  padding: 0 20px;
  background-color: #f4f4f4;
  border-bottom-left-radius: 10px;
  border-bottom-right-radius: 10px;
}

/* 题目编号（ctbapp 用 SimHei 包一层，这里按同一档字号给楷体） */
.code {
  font-size: 14px;
  font-family: 楷体, '楷体_GB2312';
  color: #000000;
}

.ops {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: 20px;
  font-size: 14px;
}

/* 操作项：20px 图标 + 文字，间距 20px（ctbapp 的 .meta_right_item） */
.ops :deep(.op) {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.ops :deep(.op:hover) {
  color: var(--admin-primary, #2d8cf0);
}

/* 图标 20×20，与 ctbapp 的 width="20" 一致 */
.ops :deep(.op img) {
  width: 20px;
  height: 20px;
  display: block;
}
</style>
