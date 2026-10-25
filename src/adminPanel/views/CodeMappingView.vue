<template>
  <!-- 提交错题任务（原「编码映射」，现挂在「班级管理」分组下，任务按班级建）。
       现阶段只有「新建」这一个交互：工具栏按钮 → 弹窗（映射名 + 所属班级）。 -->
  <div class="mapping-page">
    <div class="list-toolbar">
      <span class="count">共 {{ mappings.length }} 条</span>
      <button class="new-btn" type="button" @click="openCreate">新建错题任务</button>
    </div>

    <div class="mapping-body">
      <p v-if="mappings.length === 0" class="state">
        还没有错题任务，点右上角「新建错题任务」开始
      </p>
      <ul v-else class="mapping-list">
        <li v-for="item in mappings" :key="item.id" class="mapping-item">
          <span class="mapping-name">{{ item.name }}</span>
          <span class="mapping-meta">
            <span class="mapping-class">{{ item.className }}</span>
            <span v-if="item.subs.length > 0" class="mapping-subs">
              {{ item.subs.length }} 条子映射
            </span>
          </span>
        </li>
      </ul>
    </div>

    <!-- 新建弹窗 -->
    <ModalDialog
      :open="createOpen"
      title="新建错题任务"
      confirm-text="确定"
      :confirm-disabled="submitting"
      width="540px"
      @confirm="submitCreate"
      @cancel="closeCreate"
    >
      <label class="field">
        <span class="field-label">映射名</span>
        <input
          v-model="form.name"
          class="field-input"
          type="text"
          maxlength="50"
          autocomplete="off"
          placeholder="请输入映射名"
          @keyup.enter="submitCreate"
        />
      </label>

      <label class="field">
        <span class="field-label">所属班级</span>
        <select v-model="form.classCode" class="field-input" :disabled="classesLoading">
          <option value="" disabled>
            {{ classesLoading ? '班级加载中…' : '请选择班级' }}
          </option>
          <option v-for="cls in classes" :key="cls.classCode" :value="cls.classCode">
            {{ cls.className }}
          </option>
        </select>
      </label>

      <p v-if="!classesLoading && classes.length === 0" class="field-hint">
        还没有班级可选，请先到「班级管理 → 创建班级」建一个
      </p>

      <!-- 子映射：一条映射下可以挂多条「题码 → 序号」。
           点「增加子映射」追加一组输入，右侧 × 删掉这一组。 -->
      <div class="sub-block">
        <!-- 原来这里有个「子映射」文字标签，已去掉：按钮直接占那个位置 -->
        <div class="sub-head">
          <button class="add-sub-btn" type="button" @click="addSubMapping">增加子映射</button>
        </div>
        <p v-if="form.subs.length === 0" class="field-hint">
          还没有子映射，可点「增加子映射」逐条添加
        </p>
        <!-- 每行两个子映射，中间用逗号分隔；行内每组仍是「题码 + 序号 + ×」 -->
        <div v-for="(row, rowIndex) in subRows" :key="rowIndex" class="sub-line">
          <template v-for="(sub, colIndex) in row" :key="sub.key">
            <span v-if="colIndex > 0" class="sub-comma">，</span>
            <div class="sub-item">
              <input
                v-model="sub.questionCode"
                class="field-input"
                type="text"
                maxlength="20"
                autocomplete="off"
                placeholder="题码"
              />
              <input
                v-model="sub.serial"
                class="field-input"
                type="text"
                maxlength="10"
                autocomplete="off"
                placeholder="序号"
              />
              <button class="sub-remove" type="button" title="移除这条子映射" @click="removeSubMapping(sub)">
                ×
              </button>
            </div>
          </template>
        </div>
      </div>
    </ModalDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import ModalDialog from '../components/ModalDialog.vue'
import { fetchClassOptions, type ClassItem } from '../api/classes'
import { describeError, showError, showSuccess } from '../stores/toast'

/** 一条子映射：题码 + 序号（编辑中的草稿带 key，保存后只留业务字段） */
interface SubMappingDraft {
  key: number
  questionCode: string
  serial: string
}

interface SubMappingItem {
  questionCode: string
  serial: string
}

/** 一条错题任务（原编码映射；后端接口还没提供，先把表单收集到的字段存在本页） */
interface CodeMappingItem {
  id: number
  name: string
  classCode: string
  className: string
  subs: SubMappingItem[]
}

const mappings = ref<CodeMappingItem[]>([])
const classes = ref<ClassItem[]>([])
const classesLoading = ref(false)
const createOpen = ref(false)
const submitting = ref(false)

let nextId = 1
let nextSubKey = 1

const form = reactive<{ name: string; classCode: string; subs: SubMappingDraft[] }>({
  name: '',
  classCode: '',
  subs: []
})

/** 每行两个子映射，供模板按行渲染 */
const subRows = computed<SubMappingDraft[][]>(() => {
  const rows: SubMappingDraft[][] = []
  for (let i = 0; i < form.subs.length; i += 2) {
    rows.push(form.subs.slice(i, i + 2))
  }
  return rows
})

/** 「增加子映射」：追加一组空的题码 / 序号输入 */
function addSubMapping(): void {
  form.subs.push({ key: nextSubKey++, questionCode: '', serial: '' })
}

function removeSubMapping(sub: SubMappingDraft): void {
  const index = form.subs.indexOf(sub)
  if (index >= 0) form.subs.splice(index, 1)
}

/** 打开弹窗时重置表单：上次填了一半关掉的，下次进来应该是干净的（子映射也清） */
function openCreate(): void {
  form.name = ''
  form.classCode = ''
  form.subs = []
  createOpen.value = true
  if (classes.value.length === 0) void loadClasses()
}

function closeCreate(): void {
  createOpen.value = false
}

/** 班级下拉：后端一次给全（不分页），接口本身带当前老师的身份 */
async function loadClasses(): Promise<void> {
  classesLoading.value = true
  try {
    classes.value = await fetchClassOptions()
  } catch (err) {
    showError(describeError(err))
  } finally {
    classesLoading.value = false
  }
}

/**
 * 保存。
 *
 * 后端目前没有错题任务的新增接口（ClassController / SubjectController 里都没有），
 * 所以这里只做「校验 + 收进本页列表」：字段是真的、交互是真的，但刷新就没了。
 * 等接口给出（例如 /background/code/mapping/add.do）把这里换成一次 client.post 即可，
 * 列表也要改成从接口拉取。
 */
async function submitCreate(): Promise<void> {
  if (submitting.value) return
  const name = form.name.trim()
  if (!name) {
    showError('请输入映射名')
    return
  }
  const picked = classes.value.find((cls) => cls.classCode === form.classCode)
  if (!picked) {
    showError('请选择所属班级')
    return
  }

  // 子映射：整条都空就忽略；只填一半（有题码没序号 / 反之）拦下来，别把半条存进去
  const subs: SubMappingItem[] = []
  for (const [index, sub] of form.subs.entries()) {
    const questionCode = sub.questionCode.trim()
    const serial = sub.serial.trim()
    if (!questionCode && !serial) continue
    if (!questionCode || !serial) {
      showError(`第 ${index + 1} 条子映射的题码和序号要成对填写`)
      return
    }
    subs.push({ questionCode, serial })
  }

  submitting.value = true
  try {
    mappings.value = [
      { id: nextId++, name, classCode: picked.classCode, className: picked.className, subs },
      ...mappings.value
    ]
    showSuccess('已新建')
    closeCreate()
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  void loadClasses()
})
</script>

<style scoped>
.mapping-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100%;
  padding: 16px 10px 0;
  overflow: auto;
}

/* 顶部工具条：与「我录入的题」「我的收藏」同一副（830px、左右分布） */
.list-toolbar {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: 830px;
  padding: 0 0 12px;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.new-btn {
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

.new-btn:hover {
  background: #2f74e0;
  border-color: #2f74e0;
}

.mapping-body {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 830px;
  flex: 1 1 auto;
  min-height: 0;
}

.mapping-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mapping-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
  height: 44px;
  border: 1px solid gainsboro;
  border-radius: 8px;
  background: var(--admin-surface, #fff);
}

.mapping-name {
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
}

.mapping-class {
  font-size: 13px;
  font-family: 楷体, '楷体_GB2312';
  color: var(--admin-text-weak, #8492a6);
}

.state {
  padding: 8px 0;
  font-size: 14px;
  color: var(--admin-text-weak, #8492a6);
}

/* 弹窗内表单 */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 映射名 / 所属班级不跟着弹窗一起变宽，固定为单列表单的宽度：
     380px 弹窗 - 左右各 20px 内边距 - 正文区右侧 2px 滚动留白 */
  max-width: 338px;
}

.field-label {
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.field-input {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  outline: none;
  box-sizing: border-box;
}

.field-input:focus {
  border-color: var(--admin-primary, #2d8cf0);
}

.field-hint {
  margin: 0;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* ── 子映射 ───────────────────────────────────────────────────────────── */
.sub-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--admin-border, #d8dee6);
}

.sub-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
}

.add-sub-btn {
  width: auto;
  white-space: nowrap;
  height: 24px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 12px;
  color: var(--admin-primary, #2d8cf0);
  border: 1px solid var(--admin-primary, #2d8cf0);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
}

.add-sub-btn:hover {
  color: #fff;
  background: var(--admin-primary, #2d8cf0);
}

/* 一行：最多两组，组间用中文逗号分隔 */
.sub-line {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

/* 一组：题码 / 序号 / 移除。宽度全用定值，不跟着弹窗伸缩 */
.sub-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  flex: none;
}

/* 题码 / 序号固定宽度（基准：一行两组时每格约 153px）：
   题码 153 × 0.8 ≈ 122px
   序号 153 × 0.4 ≈ 61px
   一整行 = (122 + 8 + 61 + 8 + 24) × 2 + 逗号 13 + 两个组间距 12 ≈ 471px，
   弹窗 540px 就是照这个定的（再去掉 40 内边距、2 滚动留白，还剩约 27px 余量）。 */
.sub-item input:first-of-type {
  width: 122px;
}

.sub-item input:last-of-type {
  width: 61px;
}

.sub-comma {
  flex: none;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.sub-remove {
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: var(--admin-text-weak, #8492a6);
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.sub-remove:hover {
  color: #e5534b;
  border-color: #e5534b;
}

/* 列表行右侧：班级 + 子映射条数 */
.mapping-meta {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
}

.mapping-subs {
  font-size: 12px;
  color: var(--admin-primary, #2d8cf0);
}
</style>
