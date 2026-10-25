<template>
  <div class="mc-page">
    <!-- 关联孩子：挂在当前登录的账号下 -->
    <section class="card">
      <h2 class="card-title">关联孩子</h2>
      <p class="card-sub">
        孩子会挂在当前登录的账号下，关联后可在成绩、错题等功能里按孩子查看。
      </p>

      <div class="form-grid">
        <label class="field">
          <span class="field-label">孩子姓名</span>
          <input
            v-model.trim="form.studentName"
            class="ctl"
            type="text"
            maxlength="6"
            placeholder="请输入孩子姓名"
            @keyup.enter="submit"
          />
        </label>

        <label class="field">
          <span class="field-label">年级</span>
          <select v-model="form.classLevel" class="ctl">
            <option value="">未选择</option>
            <option v-for="c in CLASS_LEVEL_OPTIONS" :key="c.value" :value="c.value">
              {{ c.label }}
            </option>
          </select>
        </label>

        <!-- 省份 / 城市目前只有一档，先按默认值给出，留成下拉方便以后扩 -->
        <label class="field">
          <span class="field-label">省份</span>
          <select v-model="form.province" class="ctl">
            <option v-for="p in PROVINCES" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">城市</span>
          <select v-model="form.city" class="ctl">
            <option v-for="c in CITIES" :key="c.value" :value="c.value">{{ c.label }}</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">县区</span>
          <select v-model="form.country" class="ctl">
            <option value="" disabled>请选择县区</option>
            <option v-for="d in DISTRICTS" :key="d.value" :value="d.value">{{ d.label }}</option>
          </select>
        </label>

        <div class="field">
          <span class="field-label">性别</span>
          <div class="gender-row">
            <label v-for="item in GENDERS" :key="item.value" class="gender-item">
              <input v-model="form.gender" type="radio" :value="item.value" />
              <span>{{ item.label }}</span>
            </label>
          </div>
        </div>

        <label class="field">
          <span class="field-label">身份证号</span>
          <input
            v-model.trim="form.cardId"
            class="ctl"
            type="text"
            maxlength="18"
            placeholder="选填"
            @keyup.enter="submit"
          />
        </label>

        <!-- 入学时间：只填知道的那一段，留空表示没填。
             下拉给的是「2015-09」这种年月，提交时补成 yyyy-MM-dd（-01） -->
        <label class="field">
          <span class="field-label">一年级入学时间</span>
          <select v-model="form.classOneTime" class="ctl">
            <option value="">未选择</option>
            <option v-for="m in ONE_MONTHS" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">七年级（初一）入学时间</span>
          <select v-model="form.classSevenTime" class="ctl">
            <option value="">未选择</option>
            <option v-for="m in SEVEN_MONTHS" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">高一入学时间</span>
          <select v-model="form.classTenTime" class="ctl">
            <option value="">未选择</option>
            <option v-for="m in TEN_MONTHS" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
      </div>

      <div class="form-actions">
        <button class="btn" type="button" :disabled="submitting" @click="submit">
          {{ submitting ? '提交中…' : '关联' }}
        </button>
        <button class="btn ghost" type="button" :disabled="submitting" @click="resetForm">重置</button>
      </div>
    </section>

    <!-- 我的孩子：加完能立刻看到，也方便核对孩子代码 -->
    <section class="card">
      <div class="list-head">
        <h2 class="card-title">我的孩子</h2>
        <button class="btn small ghost" type="button" :disabled="listLoading" @click="loadList">
          刷新
        </button>
      </div>

      <table class="table">
        <thead>
          <tr>
            <th>孩子代码</th>
            <th>姓名</th>
            <th>年级</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="listLoading">
            <td colspan="4" class="empty">加载中…</td>
          </tr>
          <tr v-else-if="children.length === 0">
            <td colspan="4" class="empty">还没关联，先在上方添加一个</td>
          </tr>
          <template v-else>
            <tr v-for="child in children" :key="child.childCode">
              <td class="mono">{{ child.childCode }}</td>
              <td>{{ child.studentName }}</td>
              <td>{{ levelText(child.classLevel) }}</td>
              <td class="class-cell">
                <template v-if="child.className">
                  <span class="class-name">{{ child.className }}</span>
                </template>
                <button v-else class="btn small" type="button" @click="openApply(child)">
                  加入班级
                </button>
                <button class="btn small ghost" type="button" @click="openJoined(child)">
                  已加入班级
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <!-- 加入班级：版式与「创建班级」页的申请弹窗一致 -->
    <div v-if="applyOpen" class="mask" @click.self="applyOpen = false">
      <div class="dlg">
        <div class="dlg-head">
          <span>申请加入{{ applyChildName ? ` · ${applyChildName}` : '' }}</span>
          <button class="dlg-close" type="button" title="关闭" @click="applyOpen = false">×</button>
        </div>
        <div class="dlg-body">
          <label class="dlg-field">
            <span class="dlg-label">班级代码：</span>
            <input
              v-model="applyCode"
              class="dlg-input"
              maxlength="10"
              placeholder="输入班级数字代码"
              @keyup.enter="submitApply"
            />
          </label>
        </div>
        <div class="dlg-foot">
          <button class="btn ghost" type="button" @click="applyOpen = false">取消</button>
          <button class="btn" type="button" :disabled="applySubmitting" @click="submitApply">
            确定
          </button>
        </div>
      </div>
    </div>

    <!-- 已加入的班级：点行内「已加入班级」打开，列出该孩子已加入的班级 -->
    <div v-if="joinedOpen" class="mask" @click.self="joinedOpen = false">
      <div class="dlg dlg-wide">
        <div class="dlg-head">
          <span>已加入的班级{{ joinedChildName ? ` · ${joinedChildName}` : '' }}</span>
          <button class="dlg-close" type="button" title="关闭" @click="joinedOpen = false">×</button>
        </div>
        <div class="dlg-body">
          <p v-if="joinedLoading" class="joined-hint">正在加载…</p>
          <p v-else-if="joinedRows.length === 0" class="joined-hint">该孩子还没有已加入的班级</p>
          <table v-else class="table">
            <thead>
              <tr>
                <th>班级ID</th>
                <th>班级名</th>
                <th>年级</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in joinedRows" :key="row.classCode">
                <td class="mono">{{ row.classCode }}</td>
                <td>{{ row.className }}</td>
                <td>{{ levelText(row.classLevel) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="dlg-foot">
          <button class="btn ghost" type="button" @click="joinedOpen = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import {
  addChild,
  fetchChildJoinedClasses,
  fetchMyChildren,
  type ChildItem,
  type JoinedChildClass
} from '../api/children'
import { joinChildToClass } from '../api/classes'
import { CLASS_LEVEL_OPTIONS } from '../utils/class-level'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

const GENDERS = [
  { value: 'male', label: '男' },
  { value: 'female', label: '女' }
] as const

// 省 / 市 / 区县都是 6 位行政区划代码（后端 checkCity 的口径）
const PROVINCES = [{ value: '370000', label: '山东省' }] as const
const CITIES = [{ value: '371300', label: '临沂市' }] as const

/** 临沂市下可选的县区（只有这些，后端按代码归类统计） */
const DISTRICTS = [
  { value: '371302', label: '兰山区' },
  { value: '371311', label: '罗庄区' },
  { value: '371312', label: '河东区' },
  { value: '371321', label: '沂南县' },
  { value: '371322', label: '郯城县' },
  { value: '371323', label: '沂水县' },
  { value: '371324', label: '兰陵县' },
  { value: '371325', label: '费县' },
  { value: '371326', label: '平邑县' },
  { value: '371327', label: '莒南县' },
  { value: '371328', label: '蒙阴县' },
  { value: '371329', label: '临沭县' }
] as const

/** 生成「年-09」的倒序列表（from → to，含两端），近的年份排在前面 */
function enrollMonths(from: number, to: number): string[] {
  const out: string[] = []
  for (let year = from; year >= to; year -= 1) out.push(`${year}-09`)
  return out
}

// 一年级：2026-09 ~ 2015-09；七年级 / 高一：只给近三年 2026-09 ~ 2024-09
const ONE_MONTHS = enrollMonths(2026, 2020)
const SEVEN_MONTHS = enrollMonths(2026, 2024)
const TEN_MONTHS = enrollMonths(2026, 2024)

/** 下拉里的「2015-09」补成后端要的 yyyy-MM-dd（当月 1 号） */
function toFullDate(month: string): string | undefined {
  return month ? `${month}-01` : undefined
}

const EMPTY_FORM = {
  studentName: '',
  classLevel: '',
  province: '370000',
  city: '371300',
  country: '',
  gender: 'male' as 'male' | 'female',
  cardId: '',
  // 三个入学时间：表单里是 yyyy-MM，提交时再补成 yyyy-MM-dd
  classOneTime: '',
  classSevenTime: '',
  classTenTime: ''
}

const form = reactive({ ...EMPTY_FORM })
const submitting = ref(false)

// ── 加入班级（给当前行的孩子申请，走 App 的 join/class/step_2）──────────────
const applyOpen = ref(false)
const applyCode = ref('')
const applySubmitting = ref(false)
// 弹窗是给哪个孩子申请：后端要拿 childCode 校验归属，所以必须带上
const applyChildCode = ref('')
const applyChildName = ref('')

function openApply(child: ChildItem): void {
  applyChildCode.value = child.childCode
  applyChildName.value = child.studentName
  applyCode.value = ''
  applyOpen.value = true
}

async function submitApply(): Promise<void> {
  if (applySubmitting.value) return
  const code = applyCode.value.trim()
  if (!code) {
    showInfo('请输入班级代码')
    return
  }

  applySubmitting.value = true
  try {
    const msg = await joinChildToClass(code, applyChildCode.value)
    showSuccess(msg || '已提交申请')
    applyOpen.value = false
    // 申请通过后列表里的班级才会有值，这里先刷一遍
    await loadList()
  } catch (error) {
    showError(describeError(error))
  } finally {
    applySubmitting.value = false
  }
}

// ── 已加入的班级（点行内按钮弹出的只读列表）──────────────────────────────
const joinedOpen = ref(false)
const joinedLoading = ref(false)
const joinedChildName = ref('')
const joinedRows = ref<JoinedChildClass[]>([])

async function openJoined(child: ChildItem): Promise<void> {
  joinedChildName.value = child.studentName
  joinedRows.value = []
  joinedOpen.value = true
  joinedLoading.value = true
  try {
    joinedRows.value = await fetchChildJoinedClasses(child.childCode)
  } catch (error) {
    showError(describeError(error))
  } finally {
    joinedLoading.value = false
  }
}

const children = ref<ChildItem[]>([])
const listLoading = ref(false)

/** 后端存的是两位年级码，表格里翻回「三年级」这种写法 */
function levelText(code: string | undefined): string {
  return CLASS_LEVEL_OPTIONS.find((item) => item.value === code)?.label ?? '未填'
}

async function loadList(): Promise<void> {
  listLoading.value = true
  try {
    children.value = await fetchMyChildren()
  } catch (error) {
    showError(describeError(error))
  } finally {
    listLoading.value = false
  }
}

function resetForm(): void {
  Object.assign(form, EMPTY_FORM)
}

async function submit(): Promise<void> {
  if (submitting.value) return

  const name = form.studentName.trim()
  // 与后端 ArgsTools.checkName 同一口径：2~6 个字符
  if (name.length < 2 || name.length > 6) {
    showInfo('孩子姓名需 2~6 个字符')
    return
  }
  if (!form.country) {
    showInfo('请选择县区')
    return
  }
  if (form.cardId && !/^\d{17}[\dXx]$/.test(form.cardId)) {
    showInfo('身份证号格式不正确')
    return
  }

  submitting.value = true
  try {
    const childCode = await addChild({
      studentName: name,
      classLevel: form.classLevel || undefined,
      province: form.province,
      city: form.city,
      country: form.country,
      gender: form.gender,
      cardId: form.cardId || undefined,
      classOneTime: toFullDate(form.classOneTime),
      classSevenTime: toFullDate(form.classSevenTime),
      classTenTime: toFullDate(form.classTenTime)
    })
    showSuccess(childCode ? `添加成功，孩子代码 ${childCode}` : '添加成功')
    resetForm()
    await loadList()
  } catch (error) {
    showError(describeError(error))
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  void loadList()
})
</script>

<style scoped>
.mc-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px 24px 32px;
}

.card {
  padding: 16px;
  margin-bottom: 16px;
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
}

.card-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.card-sub {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 表单两列，窗口窄了自动落成一列 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 20px;
}

@media (max-width: 560px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.ctl {
  width: 100%;
  height: 32px;
  padding: 0 8px;
  box-sizing: border-box;
  font-family: inherit;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
  outline: none;
}

.ctl:focus {
  border-color: var(--admin-primary, #2d8cf0);
}

.gender-row {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 32px;
}

.gender-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  cursor: pointer;
}

.gender-item input {
  margin: 0;
  cursor: pointer;
}

.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
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

/* 班级列：「加入班级」「已加入班级」两个按钮挨着排 */
.class-cell .btn + .btn {
  margin-left: 6px;
}

/* 「已加入的班级」列表为空时的提示 */
.joined-hint {
  margin: 8px 0;
  font-size: 13px;
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
}

.class-name {
  margin-right: 8px;
}

/* ── 加入班级弹窗：尺寸 / 间距照搬创建班级页的申请弹窗 ───────────────────
   这里用 dlg- 前缀，避免和表单那套 .field / .ctl 撞名（那套是竖排的两列表单） */
.mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 22, 36, 0.45);
}

.dlg {
  width: min(420px, 90vw);
  background: var(--admin-surface, #fff);
  border-radius: 8px;
  box-shadow: 0 8px 30px rgba(15, 22, 36, 0.25);
  overflow: hidden;
}

/* 「已加入的班级」里要放表格，宽一点 */
.dlg.dlg-wide {
  width: min(560px, 90vw);
}

.dlg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  font-size: 15px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  border-bottom: 1px solid var(--admin-border, #d8dee6);
}

.dlg-close {
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

.dlg-close:hover {
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-nav-hover, #eef2f7);
}

.dlg-body {
  padding: 16px;
}

.dlg-field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dlg-label {
  flex: none;
  width: 72px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
}

.dlg-input {
  width: 300px;
  height: 30px;
  padding: 0 8px;
  box-sizing: border-box;
  font-family: inherit;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
  outline: none;
}

.dlg-input:focus {
  border-color: var(--admin-primary, #2d8cf0);
}

.dlg-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--admin-border, #d8dee6);
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.list-head .card-title {
  margin: 0;
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
</style>
