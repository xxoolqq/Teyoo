<template>
  <div class="ad-panel" :class="{ 'is-embedded': embedded }">
    <!-- 嵌在「创建班级」右栏时，标题和返回按钮由外层给，这里不再重复一套 -->
    <div v-if="!embedded" class="panel-head">
      <h1 class="panel-title">审核加入</h1>
      <button class="btn ghost small" type="button" @click="emit('back')">返回班级列表</button>
    </div>

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

    <!-- 嵌在右栏（300–420 宽）时四列表格塞不下，改成一行一个申请的卡片式 -->
    <ul v-if="embedded" class="apply-list">
      <li v-if="rows.length === 0" class="apply-empty">
        {{ selectedClass ? '该班级暂无加入申请' : '请先选择班级' }}
      </li>
      <li v-for="row in rows" :key="row.id" class="apply-item">
        <div class="apply-title">
          <span class="apply-name" :title="row.studentName">{{ row.studentName }}</span>
          <span class="apply-status" :class="`is-${row.applyStatus}`">
            {{ statusLabel(row.applyStatus) }}
          </span>
        </div>
        <div class="apply-foot">
          <span class="apply-type">{{ row.userType }}</span>
          <span class="apply-ops">
            <!-- 已经通过的成员，「通过」置灰不可再点；要撤销只能走「移除班级」 -->
            <button
              class="btn small pass"
              type="button"
              :disabled="row.applyStatus === 'agree'"
              @click="openConfirm(row, 'agree')"
            >
              通过
            </button>
            <button class="btn small refuse" type="button" @click="openConfirm(row, 'refused')">
              移除班级
            </button>
          </span>
        </div>
      </li>
      <li v-if="rows.length > 0" class="apply-pager">
        <Pagination :total="total" :page-num="pageNum" :page-size="PAGE_SIZE" @change="onPage" />
      </li>
    </ul>

    <!-- 整页使用时还是表格，信息密度更高 -->
    <section v-else class="card">
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
              <!-- 已经通过的成员，「通过」置灰不可再点；要撤销只能走「移除班级」 -->
              <button
                class="btn small pass"
                type="button"
                :disabled="row.applyStatus === 'agree'"
                @click="openConfirm(row, 'agree')"
              >
                通过
              </button>
              <button class="btn small refuse" type="button" @click="openConfirm(row, 'refused')">
                移除班级
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
          <span>{{ pendingAction === 'agree' ? '审核通过' : '移除班级' }}</span>
          <button class="dialog-close" type="button" title="关闭" @click="confirmOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <p class="confirm-text">
            {{ pendingAction === 'agree' ? '确定通过吗？' : '确定把该成员移出班级吗？' }}
          </p>
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
import Pagination from './Pagination.vue'
import {
  fetchClassOptions,
  fetchJoinApplyList,
  reviewJoinApply,
  type ApplyItem,
  type ClassItem
} from '../api/classes'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

/**
 * 「审核加入」面板。原来是一个独立页面（AuditingView），
 * 现在挂在「创建班级」页的右栏：点某一行的「审核加入」把右栏换成本面板，
 * 进来时用 initialClassCode 直接选中该班。
 *
 * embedded = true 时按右栏宽度排版（不画自己的标题栏、申请列表改卡片式）；
 * 整页使用时不用传，保持原来的表格版。
 */
const props = defineProps<{ initialClassCode?: string; embedded?: boolean }>()
const emit = defineEmits<{ back: [] }>()

const PAGE_SIZE = 10

// ── 班级下拉 ──────────────────────────────────────────────────────────────

const classOptions = ref<ClassItem[]>([])
const selectedClass = ref('')

/**
 * 拉班级下拉，再加载当前班的申请列表。
 *
 * 选班优先级：props.initialClassCode（刚从列表某一行点进来，用户要的就是它）>
 * 面板里已经选中的班 > 第一个班。
 */
async function initAudit(): Promise<void> {
  try {
    classOptions.value = await fetchClassOptions()
    const preferred = props.initialClassCode || selectedClass.value
    if (preferred && classOptions.value.some((item) => item.classCode === preferred)) {
      selectedClass.value = preferred
    } else if (classOptions.value.length > 0) {
      // 没有指定就默认第一个班，页面打开即可直接看，不用每次手动点一遍
      selectedClass.value = classOptions.value[0].classCode
    } else {
      selectedClass.value = ''
    }
    if (selectedClass.value) await loadPage()
  } catch (error) {
    showError(describeError(error))
  }
}

// 外层每次「审核加入」都会重新挂载本组件（v-if + :key），onMounted 里拉一次就够；
// 换班级走下拉 + 确定，申请列表被别的老师处理掉时点「确定」重查。
onMounted(() => { void initAudit() })

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
  refused: '已剔除',
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
.ad-panel {
  /* 整页使用时：外层页面已经给了 max-width 和内边距 */
  width: 100%;
}

/* ── 嵌在右栏（创建班级页）时的紧凑版 ─────────────────────────────────── */

.ad-panel.is-embedded {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 12px 14px 14px;
  box-sizing: border-box;
}

.is-embedded .top-bar {
  flex: none;
  gap: 8px;
  margin-bottom: 0;
}

.is-embedded .field {
  flex: 1 1 auto;
  gap: 6px;
  min-width: 0;
}

.is-embedded .field-label {
  flex: none;
  font-size: 12.5px;
  color: var(--admin-text-weak, #8492a6);
  white-space: nowrap;
}

.is-embedded .ctl {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  height: 28px;
  font-size: 12.5px;
}

.is-embedded .btn.confirm {
  flex: none;
  height: 28px;
  padding: 0 12px;
  font-size: 12.5px;
}

/* 申请列表：一行一个，卡片式；超长时在这一块里滚，顶部「班级 + 确定」不动 */
.apply-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  margin: 0;
  padding: 0 2px 0 0;
  overflow: auto;
  list-style: none;
}

.apply-empty {
  padding: 28px 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--admin-text-weak, #8492a6);
}

.apply-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 8px;
}

.apply-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.apply-name {
  min-width: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 审核状态：三种结果各一个浅色底，扫一眼就能分出待审和已处理 */
.apply-status {
  flex: none;
  padding: 1px 7px;
  font-size: 11.5px;
  border-radius: 999px;
  color: var(--admin-text-weak, #8492a6);
  background: var(--admin-nav-hover, #eef2f7);
}

.apply-status.is-agree {
  color: #0f9d58;
  background: rgba(25, 190, 107, 0.12);
}

.apply-status.is-refused {
  color: #d63510;
  background: rgba(237, 64, 20, 0.1);
}

.apply-status.is-wait {
  color: #b8860b;
  background: #fff8e1;
}

.apply-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.apply-type {
  min-width: 0;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.apply-ops {
  flex: none;
  display: flex;
  gap: 6px;
}

/* 表格版给「通过」留的右间距在卡片版里由 gap 接管 */
.is-embedded .btn.small.pass {
  margin-right: 0;
}

.apply-pager {
  flex: none;
  padding-top: 2px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.panel-title {
  margin: 0;
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

/* 已通过的成员：「通过」置灰不可点（要撤销只能点「剔除」） */
.btn.small.pass:disabled {
  color: var(--admin-text-weak, #8492a6);
  background: var(--admin-nav-hover, #eef2f7);
  opacity: 1;
  cursor: not-allowed;
}

/* 「移除班级」按钮（表格行内与确认框共用）：中性灰，别跟「通过」抢视觉，
   但仍是可点的实心按钮（比禁用态的浅灰更显眼） */
.btn.refuse {
  background: #909399;
}

.btn.refuse:hover {
  background: #7d8189;
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
