<template>
  <div class="nc-page">
    <!-- 审核某一行时：整页内容让位给审核面板，回来再显示班级列表 -->
    <JoinAuditPanel
      v-if="auditMode"
      :initial-class-code="auditClassCode"
      @back="auditMode = false"
    />

    <template v-else>
    <!-- 顶部按钮行（版式与 ctbapp NewClass 一致：绿 = 创建，蓝 = 申请；刷新靠右） -->
    <div class="nc-actions">
      <button class="big-btn create" type="button" @click="openCreate">创建班级</button>
      <button class="big-btn apply" type="button" @click="openApply">加入班级</button>
      <button class="btn ghost refresh" type="button" :disabled="refreshing" @click="refreshList">
        {{ refreshing ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <!-- 我的班级列表：展示 ID 等基本信息，方便学生加入 -->
    <section class="card">
      <table class="table">
        <thead>
          <tr>
            <th>班级ID</th>
            <th>班级名</th>
            <th class="col-op">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td colspan="3" class="empty">还没有班级，点上方「创建班级」新建一个</td>
          </tr>
          <tr v-for="row in rows" :key="row.classCode">
            <td class="mono">{{ row.classCode }}</td>
            <td>
              {{ row.className }}
              <span v-if="row.applyStatus === 'applying'" class="pending-tag">审核中</span>
            </td>
            <td class="col-op">
              <!-- 审核中的班级还不是成员，改名 / 审核都没有意义，只留提示 -->
              <button
                v-if="row.applyStatus !== 'applying'"
                class="btn small"
                type="button"
                @click="openEdit(row)"
              >
                修改信息
              </button>
              <button class="btn small ghost audit" type="button" @click="goAudit(row)">审核加入</button>
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

    <!-- 创建班级模态框 -->
    <div v-if="createOpen" class="mask" @click.self="createOpen = false">
      <div class="dialog dialog-wide">
        <div class="dialog-head">
          <span>创建班级</span>
          <button class="dialog-close" type="button" title="关闭" @click="createOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">班级名：</span>
            <span class="field-ctl">
              <input
                v-model="createName"
                class="ctl"
                maxlength="60"
                placeholder="如，2026 实验小学二年级二班"
                @keyup.enter="submitCreate"
              />
              <span class="word-limit">{{ createName.length }}/60</span>
            </span>
          </label>
          <!-- 命名说明常显在输入框下方，不再用问号图标控制展开 -->
          <p class="field-help">命名规则：当前年份学校名班级名，8-60字符</p>
          <label class="field">
            <span class="field-label">年级：</span>
            <select v-model="createLevel" class="ctl">
              <option v-for="c in CLASS_LEVEL_OPTIONS" :key="c.value" :value="c.value">
                {{ c.label }}
              </option>
            </select>
          </label>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
          <button class="btn" type="button" :disabled="createSubmitting" @click="submitCreate">
            确定
          </button>
        </div>
      </div>
    </div>

    <!-- 修改班级信息模态框（打开时回填该行现有值；版式与创建弹窗保持一致） -->
    <div v-if="editOpen" class="mask" @click.self="editOpen = false">
      <div class="dialog dialog-wide">
        <div class="dialog-head">
          <span>修改班级信息</span>
          <button class="dialog-close" type="button" title="关闭" @click="editOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">班级名：</span>
            <span class="field-ctl">
              <input
                v-model="editName"
                class="ctl"
                maxlength="60"
                placeholder="如，2026 实验小学二年级二班"
                @keyup.enter="submitEdit"
              />
              <span class="word-limit">{{ editName.length }}/60</span>
            </span>
          </label>
          <p class="field-help">命名规则：当前年份学校名班级名，8-60字符</p>
          <label class="field">
            <span class="field-label">年级：</span>
            <select v-model="editLevel" class="ctl">
              <option v-for="c in CLASS_LEVEL_OPTIONS" :key="c.value" :value="c.value">
                {{ c.label }}
              </option>
            </select>
          </label>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="editOpen = false">取消</button>
          <button class="btn" type="button" :disabled="editSubmitting" @click="submitEdit">
            确定
          </button>
        </div>
      </div>
    </div>

    <!-- 申请加入模态框 -->
    <div v-if="applyOpen" class="mask" @click.self="applyOpen = false">
      <div class="dialog">
        <div class="dialog-head">
          <!-- 说明小字放在标题下面、分割线上面 -->
          <div class="dialog-head-text">
            <span>申请加入</span>
            <span class="dialog-tip">加入别的老师创建的班级</span>
          </div>
          <button class="dialog-close" type="button" title="关闭" @click="applyOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">班级代码：</span>
            <input
              v-model="applyCode"
              class="ctl"
              maxlength="10"
              placeholder="输入班级数字代码"
              @keyup.enter="submitApply"
            />
          </label>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="applyOpen = false">取消</button>
          <button class="btn" type="button" :disabled="applySubmitting" @click="submitApply">
            确定
          </button>
        </div>
      </div>
    </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Pagination from '../components/Pagination.vue'
import JoinAuditPanel from '../components/JoinAuditPanel.vue'
import { CLASS_LEVEL_OPTIONS } from '../utils/class-level'
import {
  applyJoinClass,
  createMyClass,
  fetchMyClasses,
  updateMyClass,
  type ClassItem
} from '../api/classes'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

// ── 我的班级列表 + 分页 ───────────────────────────────────────────────────

const PAGE_SIZE = 10
const pageNum = ref(1)
const total = ref(0)
const rows = ref<ClassItem[]>([])

async function loadPage(): Promise<void> {
  try {
    const page = await fetchMyClasses(pageNum.value, PAGE_SIZE)
    rows.value = page.list
    total.value = page.total
  } catch (error) {
    showError(describeError(error))
  }
}

function onPage(page: number): void {
  pageNum.value = page
  void loadPage()
}

// ── 审核模式：就地把本页换成「审核加入」面板 ─────────────────────────────
const auditMode = ref(false)
const auditClassCode = ref('')

function goAudit(row: ClassItem): void {
  // 老师申请加入的班级还没被创建者审核通过时，进去也审不了，先在这里拦一下
  if (row.applyStatus === 'applying') {
    showInfo('正在审核中，请等待班级创建者通过')
    return
  }
  auditClassCode.value = row.classCode
  auditMode.value = true
}

// ── 顶部刷新：重拉当前页（页码不变）───────────────────────────────────────
const refreshing = ref(false)

async function refreshList(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await loadPage()
  } finally {
    refreshing.value = false
  }
}

onMounted(() => {
  void loadPage()
})

// ── 创建班级 ──────────────────────────────────────────────────────────────

const createOpen = ref(false)
const createName = ref('')
const createLevel = ref('')
const createSubmitting = ref(false)

function openCreate(): void {
  createName.value = ''
  createLevel.value = ''
  createOpen.value = true
}

async function submitCreate(): Promise<void> {
  const name = createName.value.trim()
  if (!name) {
    showInfo('请填写班级名')
    return
  }
  // 与后端 ArgsTools.checkClassName 同一口径：8~60 字符，且只允许数字、字母、汉字
  if (name.length < 8 || name.length > 60) {
    showInfo('班级名需 8~60 个字符')
    return
  }
  if (!/^[a-zA-Z0-9\u4e00-\u9fa5]+$/.test(name)) {
    showInfo('班级名只能包含数字、字母和汉字')
    return
  }
  if (!createLevel.value) {
    showInfo('请选择年级')
    return
  }
  createSubmitting.value = true
  try {
    const msg = await createMyClass(name, createLevel.value)
    showSuccess(msg || '创建成功')
    createOpen.value = false
    // 新班级可能落在列表任何位置，回第一页重查最直观
    pageNum.value = 1
    await loadPage()
  } catch (error) {
    showError(describeError(error))
  } finally {
    createSubmitting.value = false
  }
}

// ── 修改班级信息 ──────────────────────────────────────────────────────────

const editOpen = ref(false)
const editSubmitting = ref(false)
/** 正在编辑的行：id / classCode 跟随提交体，name / level 回填输入框 */
const editId = ref(0)
const editCode = ref('')
const editName = ref('')
const editLevel = ref('')

function openEdit(row: ClassItem): void {
  editId.value = row.id
  editCode.value = row.classCode
  editName.value = row.className
  // 后端列表里带着 classLevel 就回填，没有就留给用户重选
  editLevel.value = typeof row.classLevel === 'string' ? row.classLevel : ''
  editOpen.value = true
}

async function submitEdit(): Promise<void> {
  const name = editName.value.trim()
  if (!name) {
    showInfo('请填写班级名')
    return
  }
  // 与创建同一口径（后端 ArgsTools.checkClassName）
  if (name.length < 8 || name.length > 60) {
    showInfo('班级名需 8~60 个字符')
    return
  }
  if (!/^[a-zA-Z0-9\u4e00-\u9fa5]+$/.test(name)) {
    showInfo('班级名只能包含数字、字母和汉字')
    return
  }
  if (!editLevel.value) {
    showInfo('请选择年级')
    return
  }
  editSubmitting.value = true
  try {
    const msg = await updateMyClass({
      id: editId.value,
      classCode: editCode.value,
      className: name,
      classLevel: editLevel.value
    })
    showSuccess(msg || '修改成功')
    editOpen.value = false
    await loadPage()
  } catch (error) {
    showError(describeError(error))
  } finally {
    editSubmitting.value = false
  }
}

// ── 申请加入 ──────────────────────────────────────────────────────────────

const applyOpen = ref(false)
const applyCode = ref('')
const applySubmitting = ref(false)

function openApply(): void {
  applyCode.value = ''
  applyOpen.value = true
}

async function submitApply(): Promise<void> {
  const code = applyCode.value.trim()
  if (!code) {
    showInfo('请输入班级代码')
    return
  }
  applySubmitting.value = true
  try {
    const msg = await applyJoinClass(code)
    showSuccess(msg || '已提交申请')
    applyOpen.value = false
    // 新接口会把审核中的班级也列出来，刷新一下能立刻看到「审核中」标记
    await loadPage()
  } catch (error) {
    showError(describeError(error))
  } finally {
    applySubmitting.value = false
  }
}
</script>

<style scoped>
.nc-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px 24px 32px;
}

/* ── 顶部按钮行（配色照 ctbapp：绿 = 创建、dodgerblue = 申请）──────────── */

.nc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

/* 刷新按钮和大按钮同一行，靠最右 */
.refresh {
  margin-left: auto;
}

.big-btn {
  width: auto;
  white-space: nowrap;
  height: 28px;
  padding: 0 14px;
  font-family: inherit;
  font-size: 12px;
  color: #fff;
  border: 1px solid #3b82f6;
  border-radius: 6px;
  background: #3b82f6;
  cursor: pointer;
}
.big-btn.create {
  background: #19be6b;
}

.big-btn.create:hover {
  background: #16a45f;
}

.big-btn.apply {
  background: dodgerblue;
}

.big-btn.apply:hover {
  background: #1a7fe0;
}

/* ── 列表卡片 ─────────────────────────────────────────────────── */

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

/* 「修改」「审核」两个小按钮之间留个缝 */
.col-op .btn + .btn {
  margin-left: 6px;
}

/* 班级名后面的「审核中」标记：老师申请了别人的班级，还没被创建者通过 */
.pending-tag {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 12px;
  color: #b8860b;
  background: #fff8e1;
  border: 1px solid #f0d58c;
  border-radius: 3px;
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

/* 创建 / 修改班级共用的宽版弹窗 */
.dialog-wide {
  width: min(500px, 90vw);
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

/* 标题 + 说明小字竖排，整块与右侧关闭按钮居中对齐 */
.dialog-head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 标题下的一行说明小字（在分割线之上） */
.dialog-tip {
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  color: var(--admin-text-weak, #8492a6);
}

.field {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}

.field:last-child {
  margin-bottom: 0;
}

.field-label {
  flex: none;
  width: 72px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
}

.field-ctl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ctl {
  height: 30px;
  padding: 0 8px;
  box-sizing: border-box;
  width: 300px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
}

.word-limit {
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 命名说明常显在输入框正下方：左边空出「班级名：」标签的宽度（72 + 间距 6） */
.field-help {
  margin: -6px 0 12px 78px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--admin-text-weak, #8492a6);
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--admin-border, #d8dee6);
}

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
</style>
