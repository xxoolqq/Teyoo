<template>
  <div class="ad-page">
    <h1 class="page-title">纠错审核</h1>

    <!-- 待审工单列表：题号 / 提交人 / 类型 / 纠错原因 / 提交时间 / 操作 -->
    <section class="card">
      <table class="table">
        <thead>
          <tr>
            <th>题号</th>
            <th>提交人</th>
            <th>类型</th>
            <th>纠错原因</th>
            <th>提交时间</th>
            <th class="col-op">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0 && !loading">
            <td colspan="6" class="empty">{{ checked ? '暂无待审核的纠错工单' : '' }}</td>
          </tr>
          <tr v-for="row in rows" :key="row.id">
            <td class="name-cell">{{ row.exerciseCode }}</td>
            <td>{{ row.submitterCode }}</td>
            <td>{{ row.submitterType === 'teacher' ? '教师' : '学生' }}</td>
            <td class="reason-cell">{{ row.reason }}</td>
            <td>{{ formatTime(row.createTime) }}</td>
            <td class="col-op">
              <button class="btn small" type="button" @click="openDetail(row)">查看 / 审核</button>
            </td>
          </tr>
        </tbody>
      </table>
      <Pagination :total="total" :page-num="pageNum" :page-size="PAGE_SIZE" @change="onPage" />
    </section>

    <!-- 工单详情 + 审核模态框 -->
    <div v-if="detailOpen" class="mask" @click.self="closeDetail">
      <div class="dialog">
        <div class="dialog-head">
          <span>纠错工单 #{{ detail?.id }}（题号 {{ detail?.exerciseCode }}）</span>
          <button class="dialog-close" type="button" title="关闭" @click="closeDetail">×</button>
        </div>
        <div class="dialog-body">
          <p v-if="detail" class="meta-line">
            提交人：{{ detail.submitterCode }}（{{ detail.submitterType === 'teacher' ? '教师' : '学生' }}）
            · 提交时间：{{ formatTime(detail.createTime) }}
          </p>

          <div class="field-block">
            <h3 class="field-title">纠错原因</h3>
            <p class="md-text">{{ detail?.reason }}</p>
          </div>

          <div v-if="detail?.subjectSelf" class="field-block">
            <h3 class="field-title">修改后题干</h3>
            <p class="md-text">{{ toImageUrls(detail.subjectSelf) }}</p>
          </div>

          <div v-if="detail?.answerSelf" class="field-block">
            <h3 class="field-title">修改后答案</h3>
            <p class="md-text">{{ toImageUrls(detail.answerSelf) }}</p>
          </div>

          <div v-if="detail?.testPoints" class="field-block">
            <h3 class="field-title">修改后知识点</h3>
            <p class="md-text">{{ detail.testPoints }}</p>
          </div>

          <p v-if="!detail?.subjectSelf && !detail?.answerSelf && !detail?.testPoints" class="md-text">
            工单未携带修改内容
          </p>

          <label class="field-block">
            <h3 class="field-title">审核意见{{ rejectPending ? '（驳回建议填写）' : '' }}</h3>
            <textarea
              v-model="comment"
              class="comment"
              rows="3"
              placeholder="填写审核意见，驳回时将展示给提交人"
            ></textarea>
          </label>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" :disabled="submitting" @click="closeDetail">
            取消
          </button>
          <button
            class="btn refuse"
            type="button"
            :disabled="submitting"
            @click="submitReview('reject')"
          >
            驳回
          </button>
          <button class="btn pass" type="button" :disabled="submitting" @click="submitReview('approve')">
            通过
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Pagination from '../components/Pagination.vue'
import {
  fetchCorrectionDetail,
  fetchCorrectionPendingList,
  type CorrectionItem
} from '../api/corrections'
import { reviewCorrection } from '../api/corrections'
import { API_BASE } from '../api/endpoints'
import { describeError, showError, showSuccess } from '../stores/toast'

const PAGE_SIZE = 10

// ── 待审列表 + 分页 ────────────────────────────────────────────────────────

const pageNum = ref(1)
const total = ref(0)
const rows = ref<CorrectionItem[]>([])
const loading = ref(false)
/** 首查完成过一次才显示"暂无"，避免加载瞬间闪空态 */
const checked = ref(false)

async function loadPage(): Promise<void> {
  loading.value = true
  try {
    const page = await fetchCorrectionPendingList(pageNum.value, PAGE_SIZE)
    rows.value = page.list
    total.value = page.total
    checked.value = true
    // 刚审完正好删空了当前页时退一页，避免停在空页上
    if (page.list.length === 0 && pageNum.value > 1) {
      pageNum.value -= 1
      await loadPage()
    }
  } catch (error) {
    showError(describeError(error))
  } finally {
    loading.value = false
  }
}

function onPage(page: number): void {
  pageNum.value = page
  void loadPage()
}

onMounted(() => {
  void loadPage()
})

// ── 工单详情模态框 ─────────────────────────────────────────────────────────

const detailOpen = ref(false)
const detail = ref<CorrectionItem | null>(null)
const comment = ref('')
const submitting = ref(false)
/** 驳回前先标红意见栏标题（驳回建议填，但不强制） */
const rejectPending = ref(false)

async function openDetail(row: CorrectionItem): Promise<void> {
  detail.value = row
  comment.value = ''
  rejectPending.value = false
  detailOpen.value = true
  try {
    // 列表行没有修改内容（md），打开时再拉详情
    detail.value = await fetchCorrectionDetail(row.id)
  } catch (error) {
    showError(describeError(error))
  }
}

function closeDetail(): void {
  detailOpen.value = false
}

async function submitReview(action: 'approve' | 'reject'): Promise<void> {
  if (!detail.value) return
  if (action === 'reject' && !comment.value.trim()) {
    // 驳回没填意见：标一次标题提示，第二次（补了意见或执意提交）放行
    if (!rejectPending.value) {
      rejectPending.value = true
      return
    }
  }
  submitting.value = true
  try {
    const msg = await reviewCorrection(detail.value.id, action, comment.value.trim())
    showSuccess(msg || (action === 'approve' ? '已通过' : '已驳回'))
    detailOpen.value = false
    await loadPage()
  } catch (error) {
    // 2001 的典型场景：原题在工单提交后被改过（冲突阻断），msg 已是人话
    showError(describeError(error))
  } finally {
    submitting.value = false
  }
}

// ── 展示辅助 ───────────────────────────────────────────────────────────────

/** JSON Date → 本地时间串；失败原样返回 */
function formatTime(value: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 工单 md 里图片是 ctbimg://<key> 占位符，纯文本展示看不出图 —— 换成本地
 * 图片服务的完整 URL（与后端出库 resolveToUrls 的 nativeFiles 侧同一路径）。
 */
function toImageUrls(md: string): string {
  return md.replace(/ctbimg:\/\//g, `${API_BASE}images/`)
}
</script>

<style scoped>
.ad-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px 24px 32px;
}

.page-title {
  margin: 0 0 16px;
  font-size: 20px;
  color: var(--admin-text, #1f2d3d);
}

/* ── 列表卡片 ───────────────────────────────────────────────────────── */

.card {
  padding: 16px;
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
}

.table th,
.table td {
  padding: 8px 12px;
  border: 1px solid var(--admin-border, #d8dee6);
  text-align: left;
  vertical-align: top;
}

.table th {
  font-weight: 600;
  background: var(--admin-surface, #fff);
}

.table tbody tr:hover td {
  background: var(--admin-nav-hover, #f0f4f8);
}

.name-cell {
  font-weight: 600;
  white-space: nowrap;
}

.reason-cell {
  max-width: 260px;
}

.table .empty {
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
}

.col-op {
  white-space: nowrap;
}

/* ── 按钮 ───────────────────────────────────────────────────────────── */

.btn {
  height: 30px;
  padding: 0 18px;
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

.btn.ghost {
  color: var(--admin-text, #1f2d3d);
  background: transparent;
  border: 1px solid var(--admin-border, #d8dee6);
}

.btn.ghost:hover {
  background: var(--admin-nav-hover, #eef2f7);
}

.btn.small {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}

.btn.pass {
  background: #19be6b;
}

.btn.pass:hover {
  background: #16a45f;
}

.btn.refuse {
  background: #ed4014;
}

.btn.refuse:hover {
  background: #d63510;
}

/* ── 模态框 ─────────────────────────────────────────────────────────── */

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
  display: flex;
  flex-direction: column;
  width: min(640px, 92vw);
  max-height: 86vh;
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
  flex: 1;
  padding: 16px;
  overflow-y: auto;
}

.meta-line {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.field-block {
  margin-bottom: 12px;
}

.field-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--admin-text-weak, #8492a6);
}

.md-text {
  margin: 0;
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-nav-hover, #f0f4f8);
  border-radius: 4px;
}

.comment {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
  resize: vertical;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--admin-border, #d8dee6);
}
</style>
