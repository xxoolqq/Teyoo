<template>
  <div class="ad-page">
    <h1 class="page-title">审核加入</h1>

    <!-- 顶栏：选班级 → 查该班的加入申请（版式照 ctbapp Auditing：下拉 + 绿色确定） -->
    <div class="top-bar">
      <label class="field">
        <span class="field-label">班级：</span>
        <select v-model="selectedClass" class="ctl">
          <option v-for="item in classOptions" :key="item.classCode" :value="item.classCode">
            {{ item.className }}
          </option>
        </select>
      </label>
      <button class="btn confirm" type="button" :disabled="loading" @click="onSearch">确定</button>
    </div>

    <!-- 申请列表：姓名 / 类型 / 审核状态 / 操作 -->
    <section class="card">
      <table class="table">
        <thead>
          <tr>
            <th>姓名</th>
            <th>类型</th>
            <th>审核状态</th>
            <th class="col-op">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td colspan="4" class="empty">
              {{ selectedClass ? '该班级暂无加入申请' : '请先选择班级' }}
            </td>
          </tr>
          <tr v-for="row in rows" :key="row.id">
            <td class="name-cell">{{ row.studentName }}</td>
            <td>{{ row.userType }}</td>
            <td>{{ statusLabel(row.applyStatus) }}</td>
            <td class="col-op">
              <button class="btn small pass" type="button" @click="openConfirm(row, 'agree')">
                通过
              </button>
              <button class="btn small refuse" type="button" @click="openConfirm(row, 'refused')">
                拒绝
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <Pagination :total="total" :page-num="pageNum" :page-size="PAGE_SIZE" @change="onPage" />
    </section>

    <!-- 审核确认模态框（通过 / 拒绝共用一个壳） -->
    <div v-if="confirmOpen" class="mask" @click.self="confirmOpen = false">
      <div class="dialog">
        <div class="dialog-head">
          <span>{{ pendingAction === 'agree' ? '审核通过' : '拒绝' }}</span>
          <button class="dialog-close" type="button" title="关闭" @click="confirmOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <p class="confirm-text">{{ pendingAction === 'agree' ? '确定通过吗？' : '确定拒绝吗？' }}</p>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="confirmOpen = false">取消</button>
          <button
            class="btn"
            type="button"
            :class="{ refuse: pendingAction === 'refused' }"
            :disabled="submitting"
            @click="submitConfirm"
          >
            确定
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
  fetchClassOptions,
  fetchJoinApplyList,
  reviewJoinApply,
  type ApplyItem,
  type ClassItem
} from '../api/classes'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

const PAGE_SIZE = 10

// ── 班级下拉 ──────────────────────────────────────────────────────────────

const classOptions = ref<ClassItem[]>([])
const selectedClass = ref('')

onMounted(async () => {
  try {
    classOptions.value = await fetchClassOptions()
    // 默认选中第一个班，页面打开即可直接看，不用每次都手动点一遍
    if (classOptions.value.length > 0) {
      selectedClass.value = classOptions.value[0].classCode
      await loadPage()
    }
  } catch (error) {
    showError(describeError(error))
  }
})

// ── 申请列表 + 分页 ───────────────────────────────────────────────────────

const pageNum = ref(1)
const total = ref(0)
const rows = ref<ApplyItem[]>([])
const loading = ref(false)

async function loadPage(): Promise<void> {
  if (!selectedClass.value) return
  loading.value = true
  try {
    const page = await fetchJoinApplyList(selectedClass.value, pageNum.value, PAGE_SIZE)
    rows.value = page.list
    total.value = page.total
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

/** 换了班级重查，回第一页 */
function onSearch(): void {
  if (!selectedClass.value) {
    showInfo('请选择班级')
    return
  }
  pageNum.value = 1
  void loadPage()
}

function onPage(page: number): void {
  pageNum.value = page
  void loadPage()
}

// ── 审核动作 ──────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  agree: '已通过',
  refused: '已拒绝',
  wait: '待审核'
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

const confirmOpen = ref(false)
const submitting = ref(false)
/** 待审核行的主键与冗余字段，原样回传后端（与 ctbapp 同一字段） */
const pendingID = ref(0)
const pendingUserType = ref('')
const pendingStatus = ref('')
const pendingAction = ref<'agree' | 'refused'>('agree')

function openConfirm(row: ApplyItem, action: 'agree' | 'refused'): void {
  // 已经是这个结果的申请不让重复审（ctbapp 里 asyncOk 的同款守卫，提前到开框时）
  if (row.applyStatus === action) {
    showInfo('该申请已审核过')
    return
  }
  pendingID.value = row.id
  pendingUserType.value = row.userType
  pendingStatus.value = row.applyStatus
  pendingAction.value = action
  confirmOpen.value = true
}

async function submitConfirm(): Promise<void> {
  if (pendingStatus.value === pendingAction.value) {
    showInfo('该申请已审核过')
    confirmOpen.value = false
    return
  }
  submitting.value = true
  try {
    const msg = await reviewJoinApply(pendingID.value, pendingUserType.value, pendingAction.value)
    showSuccess(msg || '操作成功')
    confirmOpen.value = false
    await loadPage()
  } catch (error) {
    showError(describeError(error))
  } finally {
    submitting.value = false
  }
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

/* ── 顶栏（选班级 + 确定）───────────────────────────────────────────── */

.top-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field-label {
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

.btn.confirm {
  background: #19be6b;
}

.btn.confirm:hover {
  background: #16a45f;
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

.btn.small.pass {
  margin-right: 5px;
}

/* 拒绝按钮（表格行内与确认框共用红色） */
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
  width: min(360px, 90vw);
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

.confirm-text {
  margin: 0;
  font-size: 15px;
  text-align: center;
  color: var(--admin-text, #1f2d3d);
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--admin-border, #d8dee6);
}
</style>
