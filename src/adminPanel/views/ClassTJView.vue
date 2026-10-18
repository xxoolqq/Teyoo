<template>
  <div class="tj-page">
    <h1 class="page-title">错题统计</h1>

    <!-- ── 通用查询条件（科目 / 班级 / 起止时间，照 ctbapp ClassTJ 的排布）── -->
    <section class="card">
      <div class="grid">
        <label class="field">
          <span class="field-label">科目：</span>
          <select v-model="course" class="ctl">
            <option v-for="c in COURSE_OPTIONS" :key="c.value" :value="c.value">{{ c.label }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">班级：</span>
          <select v-model="selectedClass" class="ctl">
            <option v-for="item in classOptions" :key="item.classCode" :value="item.classCode">
              {{ item.className }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">开始时间：</span>
          <input v-model="beginDate" class="ctl" type="date" />
        </label>
        <label class="field">
          <span class="field-label">截止时间：</span>
          <input v-model="endDate" class="ctl" type="date" />
        </label>
      </div>
      <div class="actions">
        <button class="btn confirm" type="button" :disabled="searching" @click="doSearch">
          确定
        </button>
        <button class="btn confirm" type="button" :disabled="downloading" @click="doDownload">
          导出MD
        </button>
      </div>
    </section>

    <!-- ── 统计结果：题号 / 错误数 / 查看 ─────────────────────────────────── -->
    <section v-if="searched" class="card">
      <table class="table">
        <thead>
          <tr>
            <th>题号</th>
            <th>错误数</th>
            <th class="col-op">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td colspan="3" class="empty">没有符合条件的记录</td>
          </tr>
          <tr v-for="row in rows" :key="row.exerciseCode">
            <td class="mono name-cell">{{ row.exerciseCode }}</td>
            <td>{{ row.exCount }}</td>
            <td class="col-op">
              <button
                class="btn small"
                type="button"
                :disabled="viewerCode === row.exerciseCode && viewerLoading"
                @click="openViewer(row.exerciseCode)"
              >
                查看
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <Pagination :total="total" :page-num="pageNum" :page-size="PAGE_SIZE" @change="onPage" />
    </section>

    <!-- ── 查看弹层：只读渲染题目 + 答案（v-show：关掉后实例和 DOM 都留着复用）── -->
    <div v-show="viewerOpen" class="viewer-mask" @click.self="closeViewer">
      <div class="viewer-card">
        <div class="viewer-head">
          <span class="viewer-title">题目查看<span v-if="viewerCode"> · {{ viewerCode }}</span></span>
          <button class="viewer-close" type="button" title="关闭" @click="closeViewer">×</button>
        </div>
        <div class="viewer-body">
          <p v-if="viewerLoading" class="viewer-loading">正在加载题目…</p>
          <div v-show="!viewerLoading" id="tj-view-root" class="preview-root"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import Pagination from '../components/Pagination.vue'
import { fetchClassOptions, type ClassItem } from '../api/classes'
import { fetchErrorStats, fetchErrorStatsMd, type ErrorStatRow } from '../api/tj'
import { fetchShellSubject } from '../api/shell'
import { COURSE_OPTIONS } from '../utils/course'
import { createEditor, hasEditor, setMarkdown } from '../../renderer/editor/editor'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

// ── 查询条件 ─────────────────────────────────────────────────────────────

const course = ref('')
const selectedClass = ref('')
const beginDate = ref('')
const endDate = ref('')

const classOptions = ref<ClassItem[]>([])

onMounted(async () => {
  try {
    classOptions.value = await fetchClassOptions()
    // 默认选中第一个班，减少一次必点操作（与审核加入页同一做法）
    if (classOptions.value.length > 0) selectedClass.value = classOptions.value[0].classCode
  } catch (error) {
    showError(describeError(error))
  }
})

/** 组请求体。未填的字段按 ctbapp 的原样行为传空串——后端拿空串当「不限」 */
function buildQuery() {
  return {
    course: course.value,
    classCode: selectedClass.value,
    starttime: beginDate.value,
    endtime: endDate.value
  }
}

// ── 统计 + 分页 ──────────────────────────────────────────────────────────

const PAGE_SIZE = 10
const pageNum = ref(1)
const total = ref(0)
const rows = ref<ErrorStatRow[]>([])
/** 点过「确定」才出结果区（初始隐藏，不拿空表占屏） */
const searched = ref(false)
const searching = ref(false)
const downloading = ref(false)

async function loadPage(): Promise<void> {
  searching.value = true
  try {
    const page = await fetchErrorStats(buildQuery(), pageNum.value, PAGE_SIZE)
    rows.value = page.list
    total.value = page.total
  } catch (error) {
    showError(describeError(error))
  } finally {
    searching.value = false
  }
}

function doSearch(): void {
  pageNum.value = 1
  searched.value = true
  void loadPage()
}

function onPage(page: number): void {
  pageNum.value = page
  void loadPage()
}

// ── 导出MD：后端给 markdown 文本，前端存成 .md ─────────────────────────────

/** 把文本按 .md 存到本地下载目录（Blob 临时链接触发，用完即回收） */
function saveMarkdown(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown' })
  const objectURL = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectURL
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(objectURL)
}

async function doDownload(): Promise<void> {
  downloading.value = true
  try {
    const text = await fetchErrorStatsMd(buildQuery())
    if (!text) {
      showInfo('后端没有返回可下载的内容')
      return
    }
    saveMarkdown('错题统计.md', text)
    showSuccess('已下载')
  } catch (error) {
    showError(describeError(error))
  } finally {
    downloading.value = false
  }
}

// ── 查看弹层：复用只读渲染管线（同题海拾贝的手法）──────────────────────────

const VIEWER_ROOT = 'tj-view-root'
const viewerOpen = ref(false)
const viewerLoading = ref(false)
const viewerCode = ref('')
/** 是否已建过只读实例（惰性：第一次点「查看」才建） */
let viewerBooted = false

/**
 * 只读锁：弹层容器 CSS `pointer-events: none` 管鼠标，这里补 tabIndex = -1 把
 * Tab 键也挡在外面（contenteditable 由 ProseMirror 维护，手动改留不住）。
 */
function lockViewer(): void {
  const el = document.getElementById(VIEWER_ROOT)?.querySelector('.ProseMirror')
  if (el instanceof HTMLElement) el.tabIndex = -1
}

/** 首次打开时创建只读实例；之后只 setMarkdown 换内容。 */
async function ensureViewer(): Promise<void> {
  if (viewerBooted && hasEditor(VIEWER_ROOT)) return
  await createEditor(VIEWER_ROOT)
  lockViewer()
  viewerBooted = true
}

async function openViewer(exerciseCode: string): Promise<void> {
  viewerCode.value = exerciseCode
  viewerOpen.value = true
  viewerLoading.value = true
  try {
    const [{ subjectSelf, answerSelf }] = await Promise.all([
      fetchShellSubject(exerciseCode),
      // 弹层是 v-show，DOM 一直在；首次打开要等 Vue 把 display 恢复后再建实例
      nextTick()
    ])
    await ensureViewer()
    // flushHistory=true：查看内容不进 undo 栈
    setMarkdown(
      `题号${exerciseCode}\n\n${subjectSelf}\n\n## 答案\n\n${answerSelf}`,
      true,
      VIEWER_ROOT
    )
  } catch (error) {
    showError(describeError(error))
    viewerOpen.value = false
  } finally {
    viewerLoading.value = false
  }
}

function closeViewer(): void {
  viewerOpen.value = false
}
</script>

<style scoped>
.tj-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px 24px 32px;
}

.page-title {
  margin: 0 0 16px;
  font-size: 20px;
  color: var(--admin-text, #1f2d3d);
}

.card {
  margin-bottom: 16px;
  padding: 16px;
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
}

/* ── 表单 ─────────────────────────────────────────────────────── */

.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
}

.field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-label {
  flex: none;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
}

.ctl {
  height: 30px;
  padding: 0 8px;
  box-sizing: border-box;
  width: 200px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: 14px;
}

.btn {
  height: 30px;
  padding: 0 16px;
  font-size: 14px;
  color: #fff;
  background: var(--admin-primary, #2d8cf0);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.btn:hover {
  background: var(--admin-primary-strong, #2f74e0);
}

.btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 确定 / 导出MD 照 ctbapp 都是绿色（type="success"） */
.btn.confirm {
  background: #19be6b;
}

.btn.confirm:hover {
  background: #16a45f;
}

.btn.small {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}

/* ── 表格 ─────────────────────────────────────────────────────── */

.table {
  width: 100%;
  margin-top: 12px;
  border-collapse: collapse;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
}

.table th,
.table td {
  padding: 8px 12px;
  border: 1px solid var(--admin-border, #d8dee6);
  text-align: left;
}

.table th {
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
}

.table tbody tr:hover td {
  background: var(--admin-nav-hover, #f0f4f8);
}

.table .mono {
  font-family: Consolas, 'Courier New', monospace;
}

.name-cell {
  font-weight: 600;
}

.table .empty {
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
}

.col-op {
  white-space: nowrap;
}

/* ── 查看弹层 ─────────────────────────────────────────────────── */

.viewer-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 22, 36, 0.45);
}

.viewer-card {
  display: flex;
  flex-direction: column;
  width: min(820px, 90vw);
  max-height: 86vh;
  background: var(--admin-surface, #fff);
  border-radius: 8px;
  box-shadow: 0 8px 30px rgba(15, 22, 36, 0.25);
  overflow: hidden;
}

.viewer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
  padding: 10px 16px;
  border-bottom: 1px solid var(--admin-border, #d8dee6);
}

.viewer-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.viewer-close {
  width: 28px;
  height: 28px;
  font-size: 18px;
  line-height: 1;
  color: var(--admin-text-weak, #8492a6);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.viewer-close:hover {
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-nav-hover, #eef2f7);
}

.viewer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.viewer-loading {
  margin: 40px 0;
  text-align: center;
  font-size: 14px;
  color: var(--admin-text-weak, #8492a6);
}

/* 只读渲染：与题海拾贝的 .preview-root 同一套手法 —— 鼠标由
   pointer-events 管，Tab 键由 lockViewer 的 tabIndex 管。 */
.preview-root {
  pointer-events: none;
  cursor: default;
}

.preview-root :deep(.milkdown) {
  display: flex;
  flex-direction: column;
}

/* 代码块的「复制」按钮写死在 #editor 作用域里，这里命中不了，
   pointer-events 又点不动，直接隐藏 */
.preview-root :deep(.code-copy-btn) {
  display: none;
}
</style>
