<template>
  <!-- 班级映射：某一个班级视角下的编码映射列表 —— 谁创建的、谁按 ID 加入的都列出来。
       后端 SurveyController#scanClassMappings（POST background/scan/class/survey.do），
       入参 { userCode, classCode, pageNum, pageSize }，身份以 header token 为准，
       且当前老师必须是该班审核通过的老师。

       与「编码映射」页的分工：
       - 编码映射页 = 我创建的映射，能新建 / 修改 / 发布；
       - 本页 = 这个班收到的映射，只读，只保留「查看」和「统计」两个动作。
       列表接口只给题对数量（itemCount），详情里的逐条题码-题号复用统计接口
       （background/stat/survey/class.do，以 survey_item 为左表，全部题对都返回）。 -->
  <div class="cm-page" :class="{ 'is-embedded': embedded }">
    <div class="cm-toolbar">
      <!-- 嵌在「创建班级」右栏时班已经定死了，不用再放班级下拉 -->
      <div v-if="!embedded" class="cm-class-row">
        <span class="cm-class-label">班级</span>
        <p v-if="classesLoading" class="state-inline">班级加载中…</p>
        <p v-else-if="classes.length === 0" class="state-inline">
          你还没有班级，先到「创建班级」建一个
        </p>
        <!-- 班级用下拉选：本页一次只看一个班，班级多时一排 chip 会挤成几行 -->
        <select
          v-else
          class="cm-class-select"
          :value="classCode"
          :title="className"
          aria-label="选择班级"
          @change="onClassChange"
        >
          <option v-for="cls in classes" :key="cls.classCode" :value="cls.classCode">
            {{ cls.className }}
          </option>
        </select>
      </div>
      <span class="count">共 {{ total }} 份映射</span>
    </div>

    <div class="cm-body">
      <section class="cm-list">
        <p v-if="!classCode" class="state">先在上方选一个班级</p>
        <p v-else-if="loading" class="state">加载中…</p>
        <p v-else-if="loadError" class="state is-error">{{ loadError }}</p>
        <p v-else-if="rows.length === 0" class="state">
          这个班还没有编码映射。到「编码映射」页新建，或在「创建班级」页用「添加映射」按 ID 加入。
        </p>
        <ul v-else class="mapping-list">
          <li
            v-for="row in rows"
            :key="row.surveyId"
            class="mapping-item"
            :class="{ 'is-selected': row.surveyId === selectedId }"
            role="button"
            tabindex="0"
            @click="openDetail(row)"
            @keydown.enter.prevent="openDetail(row)"
            @keydown.space.prevent="openDetail(row)"
          >
            <div class="mapping-main">
              <div class="mapping-title-row">
                <span class="mapping-name" :title="row.title">{{ row.title }}</span>
                <span class="mapping-badge" :class="badgeClass(row.status)">
                  {{ badgeText(row.status) }}
                </span>
              </div>
              <div class="mapping-meta">
                <span class="meta-cell">{{ row.itemCount ?? 0 }} 对题码</span>
                <span class="meta-dot"></span>
                <span class="meta-cell" :title="`创建者：${creatorText(row)}`">
                  <span class="meta-label">创建</span>{{ creatorText(row) }}
                </span>
                <span class="meta-dot"></span>
                <span class="meta-cell" :title="`把本班加入的老师：${addedByText(row)}`">
                  <span class="meta-label">加入</span>{{ addedByText(row) }}
                </span>
                <span class="meta-dot"></span>
                <span class="meta-cell">{{ formatCreatedAt(row.createdAt) }}</span>
              </div>
            </div>

            <!-- 只保留查看 / 统计：本页不新建、不修改、不发布 -->
            <div class="mapping-actions">
              <div class="act-row">
                <button class="act act-view" type="button" @click.stop="openDetail(row)">查看</button>
                <button
                  class="act act-stats"
                  type="button"
                  :disabled="row.status === 0"
                  :title="statHint(row)"
                  @click.stop="openStat(row)"
                >
                  统计
                </button>
              </div>
            </div>
          </li>
        </ul>

        <div v-if="classCode" class="cm-footer">
          <Pagination
            :total="total"
            :page-num="pageNum"
            :page-size="PAGE_SIZE"
            @change="onPageChange"
          />
        </div>
      </section>

      <aside class="cm-pane" :class="{ 'is-active': mode !== 'empty' }">
        <header class="editor-head">
          <span class="editor-title">{{ mode === 'stat' ? '答题统计' : '映射详情' }}</span>
          <!-- 这里的 × 只清空本列的详情 / 统计；整个面板收起由外层的「返回详情」负责 -->
          <button
            v-if="mode !== 'empty'"
            class="editor-close"
            type="button"
            :title="mode === 'stat' ? '关闭统计' : '关闭详情'"
            @click="closePane"
          >
            ×
          </button>
        </header>

        <div v-if="mode === 'empty'" class="editor-empty">
          <p class="editor-empty-title">还没有打开的映射</p>
          <p class="editor-empty-text">
            点左侧任意一条映射的「查看」看字段明细，或点「统计」看这个班每题的对错。
          </p>
        </div>

        <template v-else-if="mode === 'stat'">
          <div class="stat-head">
            <div class="stat-title-row">
              <span class="stat-name" :title="statSurvey?.title">{{ statSurvey?.title }}</span>
              <span class="stat-total">共 {{ statTotal }} 题</span>
            </div>
            <!-- 班级视角只有一个班，不需要多选器，写清统计范围即可 -->
            <p class="stat-scope">统计班级：{{ className || '—' }}</p>
          </div>

          <div class="editor-body">
            <p v-if="statLoading" class="state">统计中…</p>
            <p v-else-if="statError" class="state is-error">{{ statError }}</p>
            <p v-else-if="statRows.length === 0" class="state">
              这个班还没有学生提交答卷，暂无统计数据
            </p>
            <table v-else class="stat-table">
              <thead>
                <tr>
                  <th class="stat-code">题码</th>
                  <th>正确数</th>
                  <th>错误数</th>
                  <th>正确率</th>
                  <th>错误率</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in statRows" :key="`${row.sortNo}-${row.exerciseCode}`">
                  <td
                    class="stat-code"
                    :title="`第 ${row.sortNo ?? '-'} 题：${row.exerciseCode || '—'}`"
                  >
                    {{ row.exerciseCode || '—' }}
                  </td>
                  <td>{{ row.cntRight ?? 0 }}</td>
                  <td>{{ row.cntWrong ?? 0 }}</td>
                  <td>{{ formatRate(row.rightRate) }}</td>
                  <td>{{ formatRate(row.wrongRate) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <footer v-if="statTotal > STAT_PAGE_SIZE" class="editor-actions is-stat">
            <button
              class="editor-btn"
              type="button"
              :disabled="statPage <= 1"
              @click="onStatPageChange(statPage - 1)"
            >
              上一页
            </button>
            <span class="stat-page">{{ statPage }} / {{ statPageCount }}</span>
            <button
              class="editor-btn"
              type="button"
              :disabled="statPage >= statPageCount"
              @click="onStatPageChange(statPage + 1)"
            >
              下一页
            </button>
          </footer>
        </template>

        <template v-else>
          <div class="editor-body">
            <dl v-if="viewing" class="detail">
              <div class="detail-row">
                <dt>映射编号</dt>
                <dd>{{ viewing.surveyId }}</dd>
              </div>
              <div class="detail-row">
                <dt>映射名</dt>
                <dd>{{ viewing.title }}</dd>
              </div>
              <div class="detail-row">
                <dt>所属班级</dt>
                <dd>{{ className || '—' }}</dd>
              </div>
              <div class="detail-row">
                <dt>班级编码</dt>
                <dd class="mono">{{ classCode || '—' }}</dd>
              </div>
              <div class="detail-row">
                <dt>题码对数</dt>
                <dd>{{ viewing.itemCount ?? 0 }} 对</dd>
              </div>
              <div class="detail-row">
                <dt>状态</dt>
                <dd>{{ badgeText(viewing.status) }}</dd>
              </div>
              <div class="detail-row">
                <dt>创建者</dt>
                <dd>{{ creatorText(viewing) }}</dd>
              </div>
              <div class="detail-row">
                <dt>加入者</dt>
                <dd>{{ addedByText(viewing) }}</dd>
              </div>
              <div class="detail-row">
                <dt>创建时间</dt>
                <dd>{{ formatCreatedAt(viewing.createdAt) }}</dd>
              </div>
            </dl>
            <!-- 题码-题号明细：列表接口（ClassSurveyMappingVo）只给对数，逐条清单复用统计接口
                 —— statByItemAndClasses 以 survey_item 为左表，没作答的题码也会返回，草稿也能查 -->
            <div class="detail-subs">
              <div class="detail-subs-head">
                <span class="detail-subs-title">题码 — 题号</span>
                <span class="detail-subs-total">共 {{ detailSubsTotal }} 对</span>
              </div>
              <p v-if="detailSubsLoading" class="state">读取题码明细中…</p>
              <p v-else-if="detailSubsError" class="state is-error">{{ detailSubsError }}</p>
              <p v-else-if="detailSubs.length === 0" class="state">这份映射还没有题码-题号</p>
              <template v-else>
                <table class="detail-subs-table">
                  <thead>
                    <tr>
                      <th class="detail-no">题号</th>
                      <th>题码</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="sub in detailSubs" :key="`${sub.sortNo}-${sub.exerciseCode}`">
                      <td class="detail-no">{{ sub.sortNo ?? '—' }}</td>
                      <td class="detail-code">{{ sub.exerciseCode || '—' }}</td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="detailSubsTotal > detailSubs.length" class="detail-subs-more">
                  只列出前 {{ detailSubs.length }} 对，还剩 {{ detailSubsTotal - detailSubs.length }} 对
                </p>
              </template>
            </div>
          </div>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Pagination from '../components/Pagination.vue'
import { fetchClassOptions, type ClassItem } from '../api/classes'
import {
  fetchClassSurveyMappings,
  fetchSurveyClassStat,
  type ClassSurveyMappingRow,
  type SurveyClassStatRow
} from '../api/surveys'
import { CLASS_MAPPING_CLASS_KEY } from '../utils/class-mapping-preset'
import { describeError, showInfo } from '../stores/toast'

/**
 * 两种用法：
 * - 整页（路由 ClassMapping）：自带班级下拉，从「创建班级」跳过来时 classCode 走 sessionStorage；
 * - 嵌入（创建班级页右栏）：embedded=true，班级由 presetClassCode 定死，不再拉班级下拉。
 */
const props = defineProps<{
  embedded?: boolean
  presetClassCode?: string
  presetClassName?: string
}>()

/** 一页多少份映射：与后端 scanClassMappings 的默认 pageSize 一致 */
const PAGE_SIZE = 10
/** 统计一页多少行 */
const STAT_PAGE_SIZE = 10
/** 详情里的题对一次取多少对：一份映射通常几十对，取 200 省得详情栏里再翻页，超出时提示只列前 N 对 */
const DETAIL_ITEM_SIZE = 200

const classes = ref<ClassItem[]>([])
const classesLoading = ref(false)

/** 当前查看的班级 */
const classCode = ref('')
const className = ref('')

const rows = ref<ClassSurveyMappingRow[]>([])
const total = ref(0)
const pageNum = ref(1)
const loading = ref(false)
const loadError = ref('')

/** 列表里高亮的那一行（查看 / 统计共用） */
const selectedId = ref<number | null>(null)
type PaneMode = 'empty' | 'detail' | 'stat'
const mode = ref<PaneMode>('empty')
const viewing = ref<ClassSurveyMappingRow | null>(null)

const statSurvey = ref<ClassSurveyMappingRow | null>(null)
const statRows = ref<SurveyClassStatRow[]>([])
const statTotal = ref(0)
const statPage = ref(1)
const statLoading = ref(false)
const statError = ref('')
const statPageCount = computed(() =>
  Math.max(1, Math.ceil(statTotal.value / Math.max(1, STAT_PAGE_SIZE)))
)

/** 详情栏里的题码-题号清单（同上，来自统计接口，只用到 sortNo / exerciseCode） */
const detailSubs = ref<SurveyClassStatRow[]>([])
const detailSubsTotal = ref(0)
const detailSubsLoading = ref(false)
const detailSubsError = ref('')
/** 详情请求序号：切到别的映射 / 关右栏后，旧请求回来直接丢掉 */
let detailSeq = 0

// ── 数据加载 ──────────────────────────────────────────────────────────────

async function loadClasses(): Promise<void> {
  classesLoading.value = true
  try {
    classes.value = await fetchClassOptions()
  } catch (err) {
    loadError.value = describeError(err)
  } finally {
    classesLoading.value = false
  }
}

async function load(page: number): Promise<void> {
  if (!classCode.value) return
  loading.value = true
  loadError.value = ''
  try {
    const result = await fetchClassSurveyMappings(classCode.value, page, PAGE_SIZE)
    // 当前页被翻空（数据变少）：退回上一页，别停在空页上
    if (result.list.length === 0 && page > 1 && result.total > 0) {
      await load(page - 1)
      return
    }
    rows.value = result.list
    total.value = result.total
    pageNum.value = page
    // 选中的那条不在这一页了：右栏跟着关掉，避免详情和列表对不上
    if (selectedId.value !== null && !result.list.some((one) => one.surveyId === selectedId.value)) {
      closePane()
    }
  } catch (err) {
    loadError.value = describeError(err)
    rows.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function onPageChange(page: number): void {
  void load(page)
}

/** 下拉里换了班：收起右栏（详情 / 统计都属于上一个班），从第一页重新拉 */
function onClassChange(event: Event): void {
  const code = (event.target as HTMLSelectElement).value
  if (code === classCode.value) return
  const target = classes.value.find((one) => one.classCode === code)
  if (!target) return
  classCode.value = target.classCode
  className.value = target.className
  closePane()
  void load(1)
}

// ── 查看 / 统计 ───────────────────────────────────────────────────────────

function openDetail(row: ClassSurveyMappingRow): void {
  mode.value = 'detail'
  viewing.value = row
  selectedId.value = row.surveyId
  void loadDetailSubs(row)
}

/**
 * 详情里的题码-题号清单：列表接口（ClassSurveyMappingVo）只有对数，逐条内容复用统计接口。
 * statByItemAndClasses 以 survey_item 为左表，所以没作答的题码、草稿状态的映射也都列得出来；
 * 权限与列表同口径（我是该班审核通过的老师），不再看 survey_scope.added_by。
 */
async function loadDetailSubs(row: ClassSurveyMappingRow): Promise<void> {
  const seq = ++detailSeq
  detailSubs.value = []
  detailSubsTotal.value = 0
  detailSubsError.value = ''
  if (!classCode.value) {
    detailSubsLoading.value = false
    return
  }
  detailSubsLoading.value = true
  try {
    const result = await fetchSurveyClassStat(row.surveyId, [classCode.value], 1, DETAIL_ITEM_SIZE)
    // 已经切到别的映射 / 关掉右栏：这份结果作废
    if (seq !== detailSeq) return
    detailSubs.value = result.list
    detailSubsTotal.value = result.total
  } catch (err) {
    if (seq !== detailSeq) return
    detailSubsError.value = describeError(err)
  } finally {
    if (seq === detailSeq) detailSubsLoading.value = false
  }
}

/** 草稿映射还没有学生作答，统计没意义；已停止收集仍可看历史数据 */
function statHint(row: ClassSurveyMappingRow): string {
  if (row.status === 0) return '草稿映射还没有学生作答，发布后才能统计'
  return '看这个班每题的对错'
}

function openStat(row: ClassSurveyMappingRow): void {
  // 草稿没有学生作答，按钮已置灰；这里兜一层，键盘触发也进不去
  if (row.status === 0) {
    showInfo('草稿映射还没有学生作答，发布后才能统计')
    return
  }
  mode.value = 'stat'
  statSurvey.value = row
  selectedId.value = row.surveyId
  void loadStat(1)
}

async function loadStat(page: number): Promise<void> {
  const item = statSurvey.value
  if (!item || !classCode.value) return
  statLoading.value = true
  statError.value = ''
  try {
    // 班级视角只有一个班：classCodes 恒为当前班（后端只要求我是该班审核通过的老师）
    const result = await fetchSurveyClassStat(
      item.surveyId,
      [classCode.value],
      page,
      STAT_PAGE_SIZE
    )
    if (result.list.length === 0 && page > 1 && result.total > 0) {
      await loadStat(page - 1)
      return
    }
    statRows.value = result.list
    statTotal.value = result.total
    statPage.value = page
  } catch (err) {
    statError.value = describeError(err)
    statRows.value = []
    statTotal.value = 0
  } finally {
    statLoading.value = false
  }
}

function onStatPageChange(page: number): void {
  void loadStat(page)
}

function closePane(): void {
  mode.value = 'empty'
  viewing.value = null
  // 关掉右栏时把在途的题对请求作废，回来也别再写状态
  detailSeq += 1
  detailSubs.value = []
  detailSubsTotal.value = 0
  detailSubsLoading.value = false
  detailSubsError.value = ''
  statSurvey.value = null
  statRows.value = []
  statTotal.value = 0
  statPage.value = 1
  statError.value = ''
  selectedId.value = null
}

// ── 展示用的小工具 ────────────────────────────────────────────────────────

function badgeText(status?: number): string {
  if (status === 1) return '已发布'
  if (status === 2) return '已停止'
  return '草稿'
}

function badgeClass(status?: number): string {
  if (status === 1) return 'is-published'
  if (status === 2) return 'is-stopped'
  return 'is-draft'
}

function creatorText(row: ClassSurveyMappingRow): string {
  return row.creatorRealName || row.creatorUserCode || '—'
}

function addedByText(row: ClassSurveyMappingRow): string {
  return row.addedByRealName || row.addedByUserCode || '—'
}

/** 创建时间只展示到「日」；后端可能是日期串、10 位秒戳或 13 位毫秒戳 */
function formatCreatedAt(value?: string | number | null): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
    const stamp = Number(text)
    if (Number.isNaN(stamp)) return text
    return normalizeStamp(stamp)
  }
  return normalizeStamp(value)
}

function normalizeStamp(stamp: number): string {
  const date = new Date(stamp < 1e11 ? stamp * 1000 : stamp)
  if (Number.isNaN(date.getTime())) return ''
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function formatRate(rate?: number | null): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '0%'
  return `${rate}%`
}

// ── 进页面 ────────────────────────────────────────────────────────────────

onMounted(async () => {
  // 嵌在「创建班级」右栏：班由外层指定，省掉班级下拉那次请求
  if (props.embedded) {
    classCode.value = (props.presetClassCode ?? '').trim()
    className.value = (props.presetClassName ?? '').trim()
    if (classCode.value) void load(1)
    return
  }

  // 整页进来时，班级码可能来自「创建班级 → 查看编码映射」（sessionStorage，读一次就删）
  const preset = (sessionStorage.getItem(CLASS_MAPPING_CLASS_KEY) ?? '').trim()
  if (preset) sessionStorage.removeItem(CLASS_MAPPING_CLASS_KEY)

  await loadClasses()
  if (classes.value.length === 0) return

  const target = classes.value.find((one) => one.classCode === preset) ?? classes.value[0]
  classCode.value = target.classCode
  className.value = target.className
  void load(1)
})
</script>

<style scoped>
/* 版式与「编码映射」页同一套：左边映射列表，右边详情 / 统计栏。
   两行 = 工具条 / 正文（分页条挂在左栏底部）；两列由 .cm-body 决定。 */
.cm-page {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: 100%;
  height: 100%;
  padding: 16px 20px 0;
  box-sizing: border-box;
  overflow: hidden;
}

/* 顶部工具条：左边班级选择，右边计数 */
.cm-toolbar {
  grid-column: 1 / -1;
  grid-row: 1;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 0 12px;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.cm-class-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.cm-class-label {
  flex: none;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.state-inline {
  margin: 0;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.count {
  flex: none;
  white-space: nowrap;
}

/* 正文：左列表 + 右栏。右栏随内容宽浮动（46%），夹在 340~480 之间：
   1440 视口右栏 480、左栏 844；1024 视口（带 230 侧栏）右栏 347、左栏 391，
   列表行的 140px 动作区放得下，统计表 5 列也不至于挤成一团。 */
.cm-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(340px, 46%, 480px);
  gap: 0 16px;
  min-height: 0;
}

.cm-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.cm-footer {
  flex: none;
  padding-top: 10px;
}

/* 班级下拉：班级多时不会像一排 chip 那样撑成几行；宽度夹住，班名太长就由
   原生 select 自己裁掉（title 里给全名） */
.cm-class-select {
  flex: 0 1 auto;
  min-width: 160px;
  max-width: 300px;
  height: 30px;
  padding: 0 8px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.cm-class-select:hover {
  border-color: rgba(139, 92, 246, 0.45);
}

.cm-class-select:focus {
  outline: none;
  border-color: #8b5cf6;
  box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.14);
}

/* ── 列表行 ─────────────────────────────────────────────────────────── */

.mapping-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0 2px 0 0;
  list-style: none;
  overflow: auto;
  min-height: 0;
}

.mapping-item {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  min-height: 88px;
  padding: 10px 18px 10px 20px;
  box-sizing: border-box;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 10px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
}

.mapping-item:hover {
  border-color: rgba(139, 92, 246, 0.45);
  box-shadow: 0 4px 14px rgba(139, 92, 246, 0.14);
}

.mapping-item.is-selected {
  border-color: rgba(139, 92, 246, 0.45);
  background: rgba(245, 243, 255, 0.94);
  box-shadow: 0 4px 16px rgba(139, 92, 246, 0.16);
}

.mapping-item.is-selected::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 999px;
  background: rgb(139, 92, 246);
}

.mapping-item:focus-visible {
  outline: 2px solid rgba(139, 92, 246, 0.5);
  outline-offset: 1px;
}

.mapping-main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}

.mapping-title-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

.mapping-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.mapping-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
  line-height: 1;
  border-radius: 999px;
}

.mapping-badge.is-draft {
  color: #b7791f;
  background: rgba(214, 158, 46, 0.16);
}

.mapping-badge.is-published {
  color: #2f855a;
  background: rgba(47, 133, 90, 0.16);
}

.mapping-badge.is-stopped {
  color: var(--admin-text-weak, #8492a6);
  background: var(--admin-bg-soft, #eef1f6);
}

.mapping-meta {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  font-size: 12.5px;
  color: var(--admin-text-weak, #8492a6);
  white-space: nowrap;
  overflow: hidden;
}

.meta-cell {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-label {
  margin-right: 4px;
  opacity: 0.72;
}

.meta-dot {
  flex: none;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--admin-border, #d8dee6);
}

/* ── 动作按钮：只有查看 / 统计两颗，21px 高，占 140px ─────────────────── */

.mapping-actions {
  flex: none;
  width: 140px;
}

.act-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.act {
  flex: 1 1 0;
  min-width: 0;
  height: 21px;
  padding: 0 6px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  color: var(--admin-text, #1f2d3d);
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background-color 0.15s ease;
}

.act-view:hover {
  color: #7c5cd6;
  border-color: rgba(124, 92, 214, 0.42);
  background: #f7f4ff;
}

.act-stats {
  color: var(--admin-text-weak, #8492a6);
}

.act-stats:hover:not(:disabled) {
  color: #7c5cd6;
  border-color: rgba(124, 92, 214, 0.42);
  background: #f7f4ff;
}

.act:disabled {
  color: #a3adbd;
  border-color: #e6eaf1;
  background: #f4f6f9;
  cursor: not-allowed;
}

/* ── 空态 / 加载 / 报错 ─────────────────────────────────────────────── */

.state {
  margin: 0;
  padding: 40px 12px;
  font-size: 13px;
  line-height: 1.8;
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
}

.state.is-error {
  color: #c05621;
}

.editor-body .state {
  padding: 32px 8px;
}

/* ── 右栏：详情 / 统计 ───────────────────────────────────────────────── */

.cm-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-bottom: 12px;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 12px;
  background: var(--admin-surface, #fff);
  overflow: hidden;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.cm-pane.is-active {
  border-color: rgba(139, 92, 246, 0.4);
  box-shadow: 0 6px 20px rgba(139, 92, 246, 0.1);
}

.editor-head {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid #eef0f4;
}

.editor-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.editor-close {
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  font-family: inherit;
  font-size: 16px;
  line-height: 1;
  color: var(--admin-text-weak, #8492a6);
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.editor-close:hover {
  color: #7c5cd6;
  border-color: rgba(124, 92, 214, 0.32);
  background: #f7f4ff;
}

.editor-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.editor-empty-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: #5a6473;
}

.editor-empty-text {
  margin: 0;
  max-width: 300px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--admin-text-weak, #8492a6);
}

.editor-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 14px 16px;
  overflow: auto;
}

.detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}

.detail-row {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 12px;
}

.detail-row dt {
  flex: none;
  width: 72px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--admin-text-weak, #8492a6);
}

.detail-row dd {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--admin-text, #1f2d3d);
  word-break: break-word;
}

.mono {
  font-family: Consolas, 'Courier New', monospace;
}

/* ── 详情里的题码-题号清单（接在字段详情下面，两列小表） ──────────────── */

.detail-subs {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #eef0f4;
}

.detail-subs-head {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.detail-subs-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.detail-subs-total {
  flex: none;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.detail-subs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  color: var(--admin-text, #1f2d3d);
}

.detail-subs-table th,
.detail-subs-table td {
  padding: 6px 8px;
  border-bottom: 1px solid #eef0f4;
  text-align: left;
  white-space: nowrap;
}

.detail-subs-table th {
  font-weight: 600;
  color: #5a6473;
  background: #fafbfd;
}

.detail-subs-table .detail-no {
  width: 56px;
  color: var(--admin-text-weak, #8492a6);
}

.detail-code {
  font-family: Consolas, 'Courier New', monospace;
}

.detail-subs-more {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--admin-text-weak, #8492a6);
}

/* ── 统计：头 + 表 + 翻页 ───────────────────────────────────────────── */

.stat-head {
  flex: none;
  padding: 12px 16px 10px;
  border-bottom: 1px solid #eef0f4;
}

.stat-title-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.stat-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.stat-total {
  flex: none;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.stat-scope {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.stat-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  color: var(--admin-text, #1f2d3d);
}

.stat-table th,
.stat-table td {
  padding: 7px 8px;
  border-bottom: 1px solid #eef0f4;
  text-align: center;
  white-space: nowrap;
}

.stat-table th {
  font-weight: 600;
  color: #5a6473;
  background: #fafbfd;
}

.stat-table .stat-code {
  text-align: left;
  font-family: Consolas, 'Courier New', monospace;
}

.editor-actions.is-stat {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid #eef0f4;
}

.editor-btn {
  height: 26px;
  padding: 0 12px;
  font-family: inherit;
  font-size: 12px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
}

.editor-btn:hover:not(:disabled) {
  color: #7c5cd6;
  border-color: rgba(124, 92, 214, 0.42);
  background: #f7f4ff;
}

.editor-btn:disabled {
  color: #a3adbd;
  background: #f4f6f9;
  cursor: not-allowed;
}

.stat-page {
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* ── 嵌在「创建班级」右栏时的紧凑版 ──────────────────────────────────────
   右栏内部再分左右两列：左边映射列表，右边「映射详情」。外层 .nc-pane 已经给了
   边框，这里不再撑页面高度，也不再自己加一圈内边距。 */

.cm-page.is-embedded {
  gap: 0;
  padding: 0;
}

/* 只剩一句「共 N 份映射」，靠右对齐 */
.is-embedded .cm-toolbar {
  justify-content: flex-end;
  padding: 0 2px 8px;
}

/* 两列都允许收缩（右栏被拖窄时不会撑破），列表稍窄、详情稍宽 */
.is-embedded .cm-body {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
  gap: 0 10px;
}

.is-embedded .mapping-list {
  gap: 8px;
}

/* 一列只有 300 出头：横排的 140px 动作区放不下，改成一列三行 */
.is-embedded .mapping-item {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  min-height: 0;
  padding: 10px 12px;
}

.is-embedded .mapping-meta {
  flex-wrap: wrap;
  row-gap: 4px;
  white-space: normal;
}

.is-embedded .mapping-actions {
  width: auto;
}

.is-embedded .cm-pane {
  margin-bottom: 0;
}

.is-embedded .editor-head {
  padding: 10px 12px 8px;
}

.is-embedded .editor-body {
  padding: 10px 12px;
}

.is-embedded .editor-empty {
  padding: 16px 12px;
}

/* 详情在 300 出头宽时标签列收窄一点，值那边多留点地方 */
.is-embedded .detail-row dt {
  width: 64px;
}

/* 右栏被拖得很窄（或窗口窄）时两列各不到 200，谁都没法读：改成上下堆叠，
   列表在上、详情在下。容器是外层 .nc-pane（见 NewClassView）。 */
@container ncpane (max-width: 520px) {
  .is-embedded .cm-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px 0;
  }

  .is-embedded .mapping-item {
    padding: 8px 10px;
  }
}
</style>
