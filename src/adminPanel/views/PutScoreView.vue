<template>
  <div class="ps-page">
   

    <!-- ── 查询条件：科目 + 班级（照 ctbapp PutScore 的排布）──────────────── -->
    <section class="card">
      <div class="grid">
         <label class="field">
          <span class="field-label">班级：</span>
          <select v-model="selectedClass" class="ctl">
            <option v-for="item in classOptions" :key="item.classCode" :value="item.classCode">
              {{ item.className }}
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
          <span class="field-label">满分：</span>
          <select v-model="fullScore" class="ctl">
            <option value="" disabled>请选择</option>
            <option v-for="s in FULL_SCORE_OPTIONS" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
    
      </div>
      <div class="actions">
        <button class="btn confirm" type="button" :disabled="searching" @click="doSearch">
          确定
        </button>
      </div>
    </section>

    <!-- ── 学生名单：姓名 / 操作 ──────────────────────────────────────────── -->
    <section v-if="searched" class="card">
      <table class="table">
        <thead>
          <tr>
            <th>姓名</th>
            <th class="col-op">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td colspan="2" class="empty">没有符合条件的记录</td>
          </tr>
          <tr v-for="row in rows" :key="row.childCode">
            <td class="name-cell">{{ row.realName }}</td>
            <td class="col-op">
              <button class="btn small" type="button" @click="openScoreModal(row)">录入成绩</button>
              <button class="btn small refuse" type="button" @click="openHistory(row)">查看</button>
            </td>
          </tr>
        </tbody>
      </table>
      <Pagination :total="total" :page-num="pageNum" :page-size="PAGE_SIZE" @change="onPage" />
    </section>

    <!-- ── 录入成绩模态框：科目 / 满分只读展示 + 得分输入，提交时折算成 150 分制 ── -->
    <div v-if="scoreOpen" class="mask" @click.self="scoreOpen = false">
      <div class="dialog">
        <div class="dialog-head">
          <span>录入成绩<span v-if="scoreName"> · {{ scoreName }}</span></span>
          <button class="dialog-close" type="button" title="关闭" @click="scoreOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <!-- 科目取顶部下拉的选择，进来时是什么科目就显示什么 -->
          <div class="modal-row">
            <span class="field-label">科目：</span>
            <span class="full-score">{{ courseLabel || '未选择' }}</span>
          </div>
          <div class="modal-row">
            <span class="field-label">满分：</span>
            <span class="full-score">{{ fullScore || '未选择' }}</span>
          </div>
          <div class="modal-row">
            <span class="field-label">得分：</span>
            <input
              v-model="scoreInput"
              class="ctl"
              type="number"
              placeholder="该学生本次得分"
              @keyup.enter="submitScore"
            />
          </div>
          <p class="hint">提交时按满分 {{ fullScore || '（未选择）' }} 折算成 150 分制（四舍五入）</p>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="scoreOpen = false">取消</button>
          <button class="btn" type="button" :disabled="submitting" @click="submitScore">确定</button>
        </div>
      </div>
    </div>

    <!-- ── 查看历史成绩模态框 ────────────────────────────────────────────── -->
    <div v-if="historyOpen" class="mask" @click.self="historyOpen = false">
      <div class="dialog">
        <div class="dialog-head">
          <span>查看历史成绩<span v-if="courseLabel"> · {{ courseLabel }}</span></span>
          <button class="dialog-close" type="button" title="关闭" @click="historyOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <p v-if="historyLoading" class="history-hint">正在加载…</p>
          <p v-else-if="historyRows.length === 0" class="history-hint">暂无历史成绩</p>
          <ol v-else class="history-list">
            <li v-for="(item, index) in historyRows" :key="item.id">
              <span class="history-index">第 {{ index + 1 }} 次</span>
              <span class="history-score">{{ item.stuScore }} 分</span>
            </li>
          </ol>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="historyOpen = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Pagination from '../components/Pagination.vue'
import { fetchClassOptions, type ClassItem } from '../api/classes'
import {
  addStudentScore,
  fetchClassStudents,
  fetchScoreHistory,
  type HistoryScoreItem,
  type ScoreStudentRow
} from '../api/scores'
import { COURSE_OPTIONS } from '../utils/course'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

// ── 查询条件 ─────────────────────────────────────────────────────────────

const course = ref('')
const selectedClass = ref('')
const classOptions = ref<ClassItem[]>([])
/** 顶部选的科目，录入弹窗里按中文名展示（提交给后端的是课程代码） */
const courseLabel = computed(
  () => COURSE_OPTIONS.find((item) => item.value === course.value)?.label ?? ''
)
/** 满分下拉的可选值（提交时按它折算成 150 分制） */
const FULL_SCORE_OPTIONS = ['100', '120', '150'] as const

onMounted(async () => {
  try {
    classOptions.value = await fetchClassOptions()
    // 默认选中第一个班（与审核加入 / 错题统计同一做法）
    if (classOptions.value.length > 0) selectedClass.value = classOptions.value[0].classCode
  } catch (error) {
    showError(describeError(error))
  }
})

// ── 学生名单 + 分页 ──────────────────────────────────────────────────────

const PAGE_SIZE = 10
const pageNum = ref(1)
const total = ref(0)
const rows = ref<ScoreStudentRow[]>([])
/** 点过「确定」才出结果区（初始隐藏，不拿空表占屏） */
const searched = ref(false)
const searching = ref(false)

async function loadPage(): Promise<void> {
  searching.value = true
  try {
    // 名单与科目无关：getClassChildInfo 只按班级查（孩子 + 家长账号的组合行）
    const page = await fetchClassStudents(selectedClass.value, pageNum.value, PAGE_SIZE)
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

// ── 录入成绩 ─────────────────────────────────────────────────────────────

const scoreOpen = ref(false)
const submitting = ref(false)
/** 当前行的学生，提交时原样回传后端（与 ctbapp 同一字段） */
const scoreCode = ref('')
const scoreName = ref('')
/** 满分（'' / '100' / '120' / '150'）：查询条件里选一次，录分时统一按它折算 */
const fullScore = ref('')
const scoreInput = ref('')

function openScoreModal(row: ScoreStudentRow): void {
  // 成绩挂在孩子身上，用 childCode（不是家长账号的 userCode）
  scoreCode.value = row.childCode
  scoreName.value = row.realName
  // 满分在顶部查询条件里已经选过，这里不重置
  scoreInput.value = ''
  scoreOpen.value = true
}

async function submitScore(): Promise<void> {
  if (!course.value) {
    showInfo('请先选择科目')
    return
  }
  if (!fullScore.value) {
    showInfo('请先在顶部选择满分')
    return
  }
  const raw = Number(scoreInput.value)
  if (scoreInput.value === '' || Number.isNaN(raw)) {
    showInfo('请填写得分')
    return
  }
  // 折算成 150 分制四舍五入（ctbapp asyncOK 的同一算法）
  const normalized = Math.round((150 * raw) / Number(fullScore.value))
  submitting.value = true
  try {
    const msg = await addStudentScore(scoreCode.value, course.value, normalized)
    showSuccess(msg || '提交成功')
    scoreOpen.value = false
    // 刷新当前页，让「最近成绩」立刻变过来
    await loadPage()
  } catch (error) {
    showError(describeError(error))
  } finally {
    submitting.value = false
  }
}

// ── 查看历史成绩 ─────────────────────────────────────────────────────────

const historyOpen = ref(false)
const historyLoading = ref(false)
const historyRows = ref<HistoryScoreItem[]>([])

async function openHistory(row: ScoreStudentRow): Promise<void> {
  historyRows.value = []
  historyOpen.value = true
  historyLoading.value = true
  try {
    historyRows.value = await fetchScoreHistory(row.childCode, course.value)
  } catch (error) {
    showError(describeError(error))
  } finally {
    historyLoading.value = false
  }
}
</script>

<style scoped>
.ps-page {
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

/* 确定 照 ctbapp 是绿色（type="success"） */
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

.btn.small + .btn.small {
  margin-left: 6px;
}

/* 查看按钮照 ctbapp 是红色（type="error"） */
.btn.refuse {
  background: #ed4014;
}

.btn.refuse:hover {
  background: #d63510;
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

/* ── 模态框 ───────────────────────────────────────────────────── */

.mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 22, 36, 0.45);
}

.dialog {
  width: min(420px, 90vw);
  background: var(--admin-surface, #fff);
  border-radius: 8px;
  box-shadow: 0 8px 30px rgba(15, 22, 36, 0.25);
  overflow: hidden;
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  font-size: 15px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  border-bottom: 1px solid var(--admin-border, #d8dee6);
}

.dialog-close {
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

.dialog-close:hover {
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-nav-hover, #eef2f7);
}

.dialog-body {
  padding: 16px;
}

.modal-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.modal-row:last-of-type {
  margin-bottom: 0;
}

/* 弹窗里只展示顶部选中的满分，不再单独选 */
.full-score {
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
}

.modal-row .ctl {
  width: 300px;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 历史成绩：提示语与列表左右边距一致，行与行用细线分隔，视觉上对齐成一列 */
.history-hint {
  margin: 0;
  padding: 10px 0;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.history-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
}

.history-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--admin-border, #e8edf3);
}

.history-list li:last-child {
  border-bottom: none;
}

.history-index {
  color: var(--admin-text-weak, #8492a6);
}

.history-score {
  font-weight: 600;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--admin-border, #d8dee6);
}
</style>
