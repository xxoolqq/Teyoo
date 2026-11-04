<template>
  <!-- 题海拾贝：版式与「错题统计」页一致 —— 整页左右两栏，查询条件与结果表都在左栏，
       右栏预留给后续的图表 / 明细。 -->
  <div class="shell-page">
    <div class="shell-main">
      <!-- ── 第一步：按名字查 ID（ctbapp 里这一步跳 Name2ID 页，这里本页出结果）── -->
      <section class="card">
        <div class="field-row">
          <label class="field">
            <span class="field-label">领域：</span>
            <select v-model="nameType" class="ctl">
              <option v-for="t in FIELD_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </label>
          <label class="field grow">
            <span class="field-label">名字：</span>
            <input
              v-model="nameInput"
              class="ctl"
              placeholder="个人、班级、学校或城市的名字"
              @keyup.enter="searchId"
            />
          </label>
          <button class="btn" type="button" :disabled="idSearching" @click="searchId">确定</button>
        </div>

        <table v-if="idRows.length" class="table mini">
          <thead>
            <tr>
              <th>名字</th>
              <th>ID</th>
              <th>类型</th>
              <th class="col-op"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in idRows" :key="row.codeID">
              <td>{{ row.name }}</td>
              <td>{{ row.codeID }}</td>
              <td>{{ nameTypeLabel(row.nameType) }}</td>
              <td class="col-op">
                <button
                  class="btn small"
                  type="button"
                  title="把该 ID 填进第二步的 ID 号"
                  @click="useId(row.codeID)"
                >
                  填入 ID
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- ── 第二步：条件统计 ──────────────────────────────────────────────── -->
      <section class="card">
        <div class="grid">
          <label class="field">
            <span class="field-label">年级：</span>
            <select v-model="classLevel" class="ctl">
              <option v-for="c in CLASS_LEVEL_OPTIONS" :key="c.value" :value="c.value">
                {{ c.label }}
              </option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">科目：</span>
            <select v-model="course" class="ctl">
              <option v-for="c in COURSE_OPTIONS" :key="c.value" :value="c.value">{{ c.label }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">领域：</span>
            <select v-model="field" class="ctl">
              <option v-for="t in FIELD_TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">ID号：</span>
            <input
              v-model="idno"
              class="ctl"
              type="number"
              placeholder="学生、班级、学校、城市ID"
            />
          </label>
          <label class="field">
            <span class="field-label">最低分：</span>
            <input v-model="lowScore" class="ctl" type="number" />
          </label>
          <label class="field">
            <span class="field-label">最高分：</span>
            <input v-model="highScore" class="ctl" type="number" />
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
        <p class="hint">按照满分150分计算</p>
        <div class="actions">
          <button class="btn wide" type="button" :disabled="searching" @click="doSearch">
            查询
          </button>
          <button class="btn wide" type="button" :disabled="downloading" @click="doDownload">
            下载
          </button>
        </div>
      </section>

      <!-- ── 查询结果：本页内嵌表格 + 分页 ──────────────────────────────────── -->
      <section v-if="searched" class="card">
        <table class="table">
          <thead>
            <tr>
              <th>题号</th>
              <th>人数</th>
              <th class="col-op">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="rows.length === 0">
              <td colspan="3" class="empty">没有符合条件的记录</td>
            </tr>
            <tr v-for="row in rows" :key="row.exerciseCode">
              <td class="mono">{{ row.exerciseCode }}</td>
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
                <button class="btn small" type="button" @click="downloadRow(row.exerciseCode)">
                  下载
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <Pagination
          :total="total"
          :page-num="pageNum"
          :page-size="PAGE_SIZE"
          @change="onPage"
        />
      </section>
    </div>

    <aside class="shell-side">右侧栏位预留</aside>

    <!-- ── 查看弹层：只读渲染题目 + 答案（v-show：关掉后实例和 DOM 都留着复用）── -->
    <div v-show="viewerOpen" class="viewer-mask" @click.self="closeViewer">
      <div class="viewer-card">
        <div class="viewer-head">
          <span class="viewer-title">题目查看<span v-if="viewerCode"> · {{ viewerCode }}</span></span>
          <button class="viewer-close" type="button" title="关闭" @click="closeViewer">×</button>
        </div>
        <div class="viewer-body">
          <p v-if="viewerLoading" class="viewer-loading">正在加载题目…</p>
          <div v-show="!viewerLoading" id="shell-view-root" class="preview-root"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import Pagination from '../components/Pagination.vue'
import {
  fetchShellSubject,
  pickShellDownloadText,
  pickShellStats,
  searchIdByName,
  type IdNameItem,
  type ShellRow
} from '../api/shell'
import { createEditor, hasEditor, setMarkdown } from '../../renderer/editor/editor'
import { CLASS_LEVEL_OPTIONS } from '../utils/class-level'
import { COURSE_OPTIONS } from '../utils/course'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

// ── 选项表：与 ctbapp PickShell.vue 的下拉一字不差 ──────────────────────────

/** 领域：名字查 ID 与第二步统计各自一份，值域相同 */
const FIELD_TYPES = [
  { value: 'stu', label: '学生' },
  { value: 'cls', label: '班级' },
  { value: 'school', label: '学校' },
  { value: 'city', label: '城市' }
] as const

/** 后端 nameType 码 → 显示名（表格「类型」列用） */
function nameTypeLabel(type: string): string {
  return FIELD_TYPES.find((t) => t.value === type)?.label ?? type
}

// ── 第一步：名字查 ID ─────────────────────────────────────────────────────

const nameType = ref('stu')
const nameInput = ref('')
const idRows = ref<IdNameItem[]>([])
const idSearching = ref(false)

async function searchId(): Promise<void> {
  if (!nameInput.value.trim()) {
    showInfo('请先输入要查询的名字')
    return
  }
  idSearching.value = true
  try {
    const rows = await searchIdByName(nameType.value, nameInput.value.trim())
    idRows.value = rows
    if (rows.length === 0) showInfo('没有找到该名字对应的 ID')
  } catch (error) {
    showError(describeError(error))
  } finally {
    idSearching.value = false
  }
}

/** 把查到的 ID 填进第二步的 ID 输入框 */
function useId(codeID: string): void {
  idno.value = codeID
  showInfo(`已填入 ID：${codeID}`)
}

// ── 第二步：条件统计 + 分页 ───────────────────────────────────────────────

const classLevel = ref('')
const course = ref('')
const field = ref('')
const idno = ref('')
const lowScore = ref('')
const highScore = ref('')
const beginDate = ref('')
const endDate = ref('')

const PAGE_SIZE = 10
const pageNum = ref(1)
const total = ref(0)
const rows = ref<ShellRow[]>([])
/** 点过「查询」才出结果区（初始隐藏，不拿空表占屏） */
const searched = ref(false)
const searching = ref(false)
const downloading = ref(false)

/**
 * 组请求体。未填的字段按 ctbapp 的原样行为传空串——后端拿空串当「不限」。
 */
function buildQuery() {
  return {
    class_level: classLevel.value,
    course: course.value,
    field: field.value,
    idno: idno.value.trim(),
    lowscore: lowScore.value,
    highscore: highScore.value,
    starttime: beginDate.value,
    endtime: endDate.value
  }
}

async function loadPage(): Promise<void> {
  searching.value = true
  try {
    const page = await pickShellStats(buildQuery(), pageNum.value, PAGE_SIZE)
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

// ── 下载（整包 / 单题）：后端给 markdown 文本，前端存成 .md ─────────────────

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
    const text = await pickShellDownloadText(buildQuery())
    if (!text) {
      showInfo('后端没有返回可下载的内容')
      return
    }
    saveMarkdown('题海拾贝.md', text)
    showSuccess('已下载')
  } catch (error) {
    showError(describeError(error))
  } finally {
    downloading.value = false
  }
}

/** 单题下载（题号 + 题干 + 答案，与 ctbapp PickShellResult 的拼接一致） */
async function downloadRow(exerciseCode: string): Promise<void> {
  try {
    const { subjectSelf, answerSelf } = await fetchShellSubject(exerciseCode)
    saveMarkdown(
      `${exerciseCode}.md`,
      `题号${exerciseCode}\n\n${subjectSelf}\n\n## 答案\n\n${answerSelf}`
    )
  } catch (error) {
    showError(describeError(error))
  }
}

// ── 查看弹层：复用只读渲染管线（同 PutTopicView 的预览手法）────────────────

const VIEWER_ROOT = 'shell-view-root'
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
/* 整页左右两栏：对半分，中间一条淡灰竖线（右栏的 border-left）分隔。
   页面自己撑满可视高度，滚动收在左栏里 —— 右栏的白底才能一直铺到页脚。
   版式与「错题统计」页（ClassTJView）保持同一套。 */
.shell-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  box-sizing: border-box;
  overflow: hidden;
}

/* 窄屏（<900px）再并排会把左栏的表格挤成一条，改成上下叠：上查询、下预留区 */
@media (max-width: 900px) {
  .shell-page {
    grid-template-columns: minmax(0, 1fr);
    /* 单列时高度交给内容，滚动还给外层 */
    height: auto;
    overflow: visible;
  }
}

.shell-main {
  min-width: 0;
  min-height: 0;
  padding: 16px 20px 24px;
  overflow-y: auto;
}

@media (max-width: 900px) {
  .shell-main {
    overflow: visible;
  }
}

/* 右栏：纯白底，左侧一条淡灰分割线，高度跟页面一致 */
.shell-side {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 16px 20px;
  box-sizing: border-box;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
  background: var(--admin-surface, #fff);
  border-left: 1px solid var(--admin-border, #d8dee6);
}

/* 单列时竖线改到上边，并留出可视高度 */
@media (max-width: 900px) {
  .shell-side {
    min-height: 180px;
    border-left: none;
    border-top: 1px solid var(--admin-border, #d8dee6);
  }
}

.card {
  margin-bottom: 16px;
  padding: 16px;
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
}

/* ── 表单 ─────────────────────────────────────────────────────── */

.field-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field.grow {
  flex: 1;
  min-width: 320px;
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
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
}

.field .ctl {
  width: 200px;
}

.field.grow .ctl {
  flex: 1;
  width: auto;
}

.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
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

.btn.wide {
  width: 160px;
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

.table.mini {
  width: auto;
  min-width: 420px;
}

.table .mono {
  font-family: Consolas, 'Courier New', monospace;
}

.table .empty {
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
}

.col-op {
  white-space: nowrap;
}

.col-op .btn + .btn {
  margin-left: 6px;
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

/* 只读渲染：与 PutTopicView 的 .preview-root 同一套手法 —— 鼠标由
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
