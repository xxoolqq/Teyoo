<template>
  <!-- 纠错（ctbapp 的 /fix_error 跳 FixError.vue）。
       版式沿用「录入题目」的两栏：左源文本、右只读预览，下接元信息表单、大提交按钮。
       进页面时按题目编号从列表缓存取，没有就现拉一次（api/topics.fetchTopicByCode）。 -->
  <div class="fix-page">
    <header class="fix-head">
      <button class="back" type="button" @click="goBack">返回列表</button>
      <span class="code">纠错 · 题目编号 {{ code }}</span>
    </header>

    <p v-if="loading" class="state">加载中…</p>
    <p v-else-if="error" class="state is-error">{{ error }}</p>
    <p v-else-if="!item" class="state">没有找到这道题</p>
    <template v-else>
      <!-- id="editor" 与录入页同因：主题里大量 `#editor .ProseMirror …` 规则 -->
      <div id="editor" class="fix-body">
        <section
          v-for="entry in ENTRY_LIST"
          :key="entry.root"
          class="entry"
        >
          <EditorToolbar
            :tag="entry.tag"
            @insert="onInsert(entry, $event)"
            @block="onBlock(entry, $event)"
            @font="onFont(entry, $event)"
            @size="onSize(entry, $event)"
            @symbol="onSymbol(entry, $event)"
            @image="onInlineMarkdown(entry, $event)"
            @tianzi="onInlineMarkdown(entry, $event)"
            @table="onTable(entry, $event)"
            @math="onMath(entry, $event)"
            @subblock="onBlockMarkdown(entry, $event)"
            @cols="onBlockMarkdown(entry, $event)"
          />
          <div class="entry-split">
            <textarea
              :ref="(el) => setInput(entry, el)"
              v-model="entry.text.value"
              class="md-input"
              spellcheck="false"
              :placeholder="entry.placeholder"
              @scroll="onInputScroll(entry, $event)"
            ></textarea>
            <div class="preview-pane">
              <div :id="entry.root" class="preview-root"></div>
            </div>
          </div>
        </section>
      </div>

      <footer class="fix-foot">
        <!-- 元信息收进右侧抽屉，这里只留入口（与录入页一致） -->
        <TopicMetaForm v-model="meta" />

        <button
          class="btn is-primary is-block"
          type="button"
          :disabled="submitting"
          @click="onSubmit"
        >
          {{ submitting ? '提交中…' : '提交' }}
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M8 11.4V4.4" />
            <path d="M4.9 7.5 8 4.4l3.1 3.1" />
            <path d="M3.8 12.6h8.4" />
          </svg>
        </button>
      </footer>
    </template>

    <!-- 换题 / 返回列表时若有未提交的修改：先确认丢弃 -->
    <ConfirmDialog
      :open="confirmState.open"
      :title="confirmState.title"
      :message="confirmState.message"
      :confirm-text="confirmState.confirmText"
      cancel-text="取消"
      @confirm="answerConfirm(true)"
      @cancel="answerConfirm(false)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type ComponentPublicInstance, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { hasEditor, setMarkdown } from '../../renderer/editor/editor'
import { mountReadonlyPreview } from '../utils/readonly-preview'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import EditorToolbar from '../components/EditorToolbar.vue'
import TopicMetaForm from '../components/TopicMetaForm.vue'
import {
  applyHeading,
  applyInlineFont,
  insertBlockMarkdown,
  insertPlain,
  insertSyntax,
  tableMarkdown,
  type BlockKind,
  type InsertResult,
  type SyntaxKey
} from '../utils/md-syntax'
import { fetchTopicByCode, fixErrorSubject, type TopicItem } from '../api/topics'
import { session } from '../stores/session'
import { describeError, showError, showSuccess } from '../stores/toast'
import { bumpTopicsVersion } from '../stores/topic-events'
import { getCachedTopic, rememberTopics } from '../stores/topic-detail'
import { listPathOf } from '../utils/topic-actions'
import {
  classLevelCode,
  classLevelName,
  isStageCode,
  stageByClassName
} from '../utils/class-level'
import { COURSE_OPTIONS } from '../utils/course'
import { blankProblem, createMeta, firstMetaProblem, type TopicMeta } from '../utils/topic-meta'

// 与 PutTopicView 同一种 Entry：标签 / 源文本 / 预览挂载点
interface Entry {
  tag: string
  placeholder: string
  root: string
  text: Ref<string>
  input: HTMLTextAreaElement | null
}

const topicEntry: Entry = {
  tag: '题目',
  placeholder: '请编辑题目内容（markdown 语法，右侧实时预览）',
  root: 'fix-preview-topic',
  text: ref(''),
  input: null
}
const answerEntry: Entry = {
  tag: '答案',
  placeholder: '请编辑答案内容（markdown 语法，右侧实时预览）',
  root: 'fix-preview-answer',
  text: ref(''),
  input: null
}
const ENTRY_LIST: Entry[] = [topicEntry, answerEntry]

const route = useRoute()
const router = useRouter()

const code = computed(() => String(route.query.id ?? '').trim())
const item = ref<TopicItem | null>(null)
const loading = ref(false)
const error = ref('')
const submitting = ref(false)
const meta = reactive<TopicMeta>(createMeta())

// ── 未保存修改的保护 ────────────────────────────────────────────────────
// 单例标签换题会直接覆盖编辑器内容，所以换题 / 返回列表前先比对「当前值」和
// 「加载时那份快照」，有差异就弹确认。

/** 编辑器里当前装的是哪道题（和 route.query.id 不一定相同：取消切换时会回退） */
let loadedCode = ''

interface EditorSnapshot {
  topic: string
  answer: string
  course: string
  stage: string
  classLevelName: string
  easy: string
  knowledgePoints: string
}

function snapshot(): EditorSnapshot {
  return {
    topic: topicEntry.text.value,
    answer: answerEntry.text.value,
    course: meta.course,
    stage: meta.stage,
    classLevelName: meta.classLevelName,
    easy: meta.easy,
    knowledgePoints: meta.knowledgePoints
  }
}

/** 加载完那一刻的基线；加载失败时清空，避免把上一题的改动算到新题头上 */
let baseline: EditorSnapshot = snapshot()

function isDirty(): boolean {
  const now = snapshot()
  return (Object.keys(now) as (keyof EditorSnapshot)[]).some((key) => now[key] !== baseline[key])
}

// 弹窗状态 + Promise 化的确认（await askConfirm(...) 拿到 true/false）
const confirmState = reactive({ open: false, title: '', message: '', confirmText: '切换' })
let confirmResolve: ((ok: boolean) => void) | null = null

function askConfirm(message: string, confirmText = '切换'): Promise<boolean> {
  confirmState.title = '放弃未提交的修改？'
  confirmState.message = message
  confirmState.confirmText = confirmText
  confirmState.open = true
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve
  })
}

function answerConfirm(ok: boolean): void {
  confirmState.open = false
  const resolve = confirmResolve
  confirmResolve = null
  resolve?.(ok)
}

// 课程码（后端 Exercise.course）→ 名称，回显到元信息表单用
function courseCodeToName(code: string): string {
  return COURSE_OPTIONS.find((o) => o.value === code)?.label ?? ''
}

async function load(): Promise<void> {
  const cached = getCachedTopic(code.value)
  item.value = cached
  if (!cached) {
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
  if (item.value) {
    topicEntry.text.value = String(item.value.subjectSelf ?? '')
    answerEntry.text.value = String(item.value.answerSelf ?? '')
    meta.course = courseCodeToName(String(item.value.course ?? ''))
    const rawLevel = String(item.value.classLevel ?? '')
    meta.classLevelName = classLevelName(rawLevel)
    // 老题目没有学段这一栏：本来存的就是学段码（跨年级题）就直接用，否则按年级反推
    // （都认不出来就留空，让人自己选，不猜）
    meta.stage = isStageCode(rawLevel) ? rawLevel.trim() : stageByClassName(meta.classLevelName)
    meta.easy = String(item.value.easy ?? '')
    meta.knowledgePoints = String(item.value.testPoints ?? '')
  }
}

function setInput(entry: Entry, el: Element | ComponentPublicInstance | null): void {
  entry.input = el instanceof HTMLTextAreaElement ? el : null
}

async function bootEditors(): Promise<void> {
  // 与「录入题目」右侧预览同一套管线，经全局串行队列排队（跟列表页的卡片
  // 预览互不插队）；内部自带只读锁和内容刷新，这里只兜错误提示
  for (const entry of ENTRY_LIST) {
    try {
      await mountReadonlyPreview(entry.root, entry.text.value)
    } catch (err) {
      showError(`预览初始化失败：${describeError(err)}（仍可正常录入与提交）`)
    }
  }
}

function renderPreviews(): void {
  for (const entry of ENTRY_LIST) {
    if (hasEditor(entry.root)) setMarkdown(entry.text.value, true, entry.root)
  }
}

const PREVIEW_DELAY = 120
let previewTimer = 0
function schedulePreview(): void {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(renderPreviews, PREVIEW_DELAY)
}
watch(ENTRY_LIST.map((e) => e.text), schedulePreview)

function currentRange(entry: Entry): { start: number; end: number } | null {
  const input = entry.input
  if (!input) return null
  return { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 }
}

function applyEdit(entry: Entry, result: InsertResult): void {
  const input = entry.input
  if (!input) return
  entry.text.value = result.text
  void nextTick(() => {
    input.focus()
    input.setSelectionRange(result.start, result.end)
  })
}

function onInsert(entry: Entry, key: SyntaxKey): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, insertSyntax(entry.text.value, range.start, range.end, key))
}
function onBlockMarkdown(entry: Entry, markdown: string): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, insertBlockMarkdown(entry.text.value, range.start, markdown))
}
function onTable(entry: Entry, size: { rows: number; cols: number }): void {
  onBlockMarkdown(entry, tableMarkdown(size.rows, size.cols))
}
function onMath(entry: Entry, item: { markdown: string; block: boolean }): void {
  if (item.block) onBlockMarkdown(entry, item.markdown)
  else onInlineMarkdown(entry, item.markdown)
}
function onBlock(entry: Entry, kind: BlockKind): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, applyHeading(entry.text.value, range.start, range.end, kind))
}
function inlineStyleRange(entry: Entry): { start: number; end: number } | null {
  const range = currentRange(entry)
  if (!range) return null
  if (range.start === range.end) return null
  if (/\n[ \t]*\n/.test(entry.text.value.slice(range.start, range.end))) return null
  return range
}
function onFont(entry: Entry, family: string): void {
  const range = inlineStyleRange(entry)
  if (!range) return
  applyEdit(entry, applyInlineFont(entry.text.value, range.start, range.end, { family }))
}
function onSize(entry: Entry, size: string): void {
  const range = inlineStyleRange(entry)
  if (!range) return
  applyEdit(entry, applyInlineFont(entry.text.value, range.start, range.end, { size }))
}
function onSymbol(entry: Entry, ch: string): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, insertPlain(entry.text.value, range.start, range.end, ch))
}
function onInlineMarkdown(entry: Entry, markdown: string): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, insertPlain(entry.text.value, range.start, range.end, markdown))
}
function onInputScroll(entry: Entry, event: Event): void {
  const pane = document.getElementById(entry.root)?.parentElement
  if (!pane) return
  pane.scrollTop = (event.target as HTMLTextAreaElement).scrollTop
}

async function onSubmit(): Promise<void> {
  if (submitting.value || !item.value) return
  const topic = topicEntry.text.value
  const answer = answerEntry.text.value
  const problem =
    blankProblem(topic, '习题') ?? blankProblem(answer, '答案') ?? firstMetaProblem(meta)
  if (problem) {
    showError(problem)
    return
  }
  submitting.value = true
  try {
    const msg = await fixErrorSubject({
      subjectSelf: topic,
      subjectAnswer: answer,
      course: meta.course,
      userCode: session.userCode,
      schoolCode: session.schoolCode,
      classLevel: classLevelCode(meta.classLevelName),
      easy: meta.easy,
      knowledgePoints: meta.knowledgePoints.trim(),
      token: session.token,
      subjectID: code.value,
      id: (item.value as { id?: number }).id ?? null
    })
    showSuccess(msg || '提交成功')
    // 列表缓存里这条也换掉：详情页（解析）是按题号从缓存取的，不更新就会
    // 一直显示改之前的题面
    if (item.value) {
      rememberTopics([{ ...item.value, subjectSelf: topic, answerSelf: answer }])
    }
    // 题干 / 答案改过了，通知列表页重拉
    bumpTopicsVersion()
  } catch (err) {
    showError(`提交失败：${describeError(err)}`)
  } finally {
    submitting.value = false
  }
}

// 回来源列表页（「题库管理」或检索页），不是固定回检索页
// 回来源列表页（「题库管理」或检索页），有未提交修改时先确认
async function goBack(): Promise<void> {
  if (isDirty()) {
    const ok = await askConfirm('当前题目有未提交的修改，返回列表后这些修改会丢失。', '返回列表')
    if (!ok) return
  }
  void router.push(listPathOf(route))
}

/** 载入并渲染当前 query.id 指向的那道题（首次进来和换题都走这里） */
async function refresh(): Promise<void> {
  // 上一题的提交还没回来就换了题：结果落在新题上没意义，直接把按钮放开
  submitting.value = false
  await load()
  if (!item.value) {
    // 没加载出来就别把它当"当前题"：下一次切换按首次处理，不弹确认
    loadedCode = ''
    return
  }
  // 换题复用同两个挂载点，实例已经活着时 mountReadonlyPreview 只刷新内容、不重建
  await bootEditors()
  loadedCode = code.value
  baseline = snapshot()
}

/**
 * 切到 query.id 指向的题。有未提交修改时先确认。
 *
 * 取消时要把路由回退到 loadedCode：此时地址已经是新题号了，不回退的话
 * 标签 / 地址和编辑器里的内容对不上，再点一次同一道题也不会触发 watch。
 */
async function switchTo(next: string): Promise<void> {
  if (next === loadedCode) return
  // 弹窗还开着时又点了别的题：以手上这个弹窗为准，别叠第二个
  if (confirmState.open) return
  if (!loadedCode || !isDirty()) {
    void refresh()
    return
  }
  const ok = await askConfirm('当前题目有未提交的修改，切换到另一道题后这些修改会丢失。')
  if (ok) {
    void refresh()
    return
  }
  void router.replace({ path: '/home/fix_error', query: { id: loadedCode, from: listPathOf(route) } })
}

onMounted(() => {
  void refresh()
})

// 「纠错」是单例标签（路由 meta.singleton）：点另一道题的「纠错」只是把
// query.id 换掉、组件被复用，mounted 不会再跑 —— 必须盯着题号自己重载。
watch(code, (next) => {
  void switchTo(next)
})

onBeforeUnmount(() => {
  window.clearTimeout(previewTimer)
})
</script>

<style scoped>
.fix-page {
  /* 给「附加信息」抽屉定位（组件内是 absolute） */
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 620px;
}

.fix-head {
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

.back {
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

.back:hover {
  color: var(--admin-primary, #2d8cf0);
  border-color: var(--admin-primary, #2d8cf0);
}

/* 与录入页同一招：把 #editor 从 body.admin-panel-view #editor { display: none }
   手里抢回来，否则两边都会被主题规则藏掉 */
#admin-panel .fix-page #editor.fix-body {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  margin: 0;
  padding: 0;
  overflow: hidden;
}

.entry {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 190px;
  overflow: hidden;
  background: var(--bg-color, var(--admin-surface));
  border-bottom: 1px solid var(--shell-line, var(--admin-border));
}

.entry:last-child {
  border-bottom: none;
}

.entry-split {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.md-input {
  flex: 1 1 50%;
  min-width: 0;
  min-height: 0;
  padding: 14px 18px;
  border: none;
  border-right: 1px solid var(--shell-line, var(--admin-border));
  background: transparent;
  color: var(--text-color, var(--admin-text));
  font-family: Consolas, 'Courier New', monospace;
  font-size: 16px;
  line-height: 1.75;
  tab-size: 2;
  resize: none;
  outline: none;
}

.md-input::placeholder {
  color: var(--text-muted, var(--admin-text-weak));
}

.preview-pane {
  flex: 1 1 50%;
  min-width: 0;
  padding: 14px 18px;
  overflow-y: auto;
}

.preview-root {
  pointer-events: none;
  cursor: default;
}

.preview-root :deep(.milkdown) {
  display: flex;
  flex-direction: column;
}

.preview-root :deep(.code-copy-btn) {
  display: none;
}

/* 左「附加信息」、右「提交」，与录入页同一条规则 */
.fix-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px 16px;
}

.btn {
  height: 30px;
  padding: 0 14px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text);
  border: 1px solid var(--admin-border);
  border-radius: 6px;
  background: var(--admin-surface);
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  color: var(--admin-primary);
  border-color: var(--admin-primary);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn.is-primary {
  color: #fff;
  background: #3b82f6;
  border: none;
  border-radius: 8px;
  font-weight: 600;
}

.btn.is-primary:hover:not(:disabled) {
  color: #fff;
  background: #2f74e0;
}

.btn.is-block {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 28px;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  white-space: nowrap;
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
