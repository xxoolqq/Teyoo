<template>
  <div class="nc-page">
    <!-- 顶部两个大按钮（版式与 ctbapp NewClass 一致：绿 = 创建，蓝 = 申请） -->
    <div class="nc-actions">
      <button class="big-btn create" type="button" @click="openCreate">创建班级</button>
      <button class="big-btn apply" type="button" @click="openApply">申请加入</button>
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
            <td>{{ row.className }}</td>
            <td class="col-op">
              <button class="btn small" type="button" @click="openEdit(row)">修改</button>
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
      <div class="dialog">
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
                maxlength="10"
                placeholder="班级名"
                @keyup.enter="submitCreate"
              />
              <span class="word-limit">{{ createName.length }}/10</span>
            </span>
          </label>
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

    <!-- 修改班级信息模态框（打开时回填该行现有值） -->
    <div v-if="editOpen" class="mask" @click.self="editOpen = false">
      <div class="dialog">
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
                maxlength="10"
                placeholder="班级名"
                @keyup.enter="submitEdit"
              />
              <span class="word-limit">{{ editName.length }}/10</span>
            </span>
          </label>
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
          <span>申请加入</span>
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
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Pagination from '../components/Pagination.vue'
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

/* ── 顶部大按钮（配色照 ctbapp：绿 = 创建、dodgerblue = 申请）──────────── */

.nc-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.big-btn {
  height: 40px;
  padding: 0 28px;
  font-size: 15px;
  color: #fff;
  border: none;
  border-radius: 5px;
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
  width: 200px;
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
