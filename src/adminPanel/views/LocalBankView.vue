<template>
  <!-- 版式照 MathBank 的题库工作区（static/index.html 的 bankWorkspaceSection）：
       顶部一条命令条（库/草稿箱切换 + 搜索 + 筛选 + 新建），下面左列表右详情，
       中间一条可拖的分隔条。样式在 styles/local-bank.css，不读宿主主题。 -->
  <section id="local-bank" ref="rootRef" :class="{ 'is-drafts': tab === 'drafts' }">
    <!-- 顶部命令条 -->
    <header class="bank-management-header workspace-command-bar">
      <div class="bank-sidebar-tabs">
        <div class="glass-tab">
          <button
            type="button"
            class="glass-tab-item"
            :class="{ 'is-active': tab === 'bank' }"
            @click="switchTab('bank')"
          >
            <i class="fa-solid fa-database" aria-hidden="true"></i>
            <span>本地题库</span>
          </button>
          <button
            type="button"
            class="glass-tab-item"
            :class="{ 'is-active': tab === 'drafts' }"
            @click="switchTab('drafts')"
          >
            <i class="fa-solid fa-box-archive" aria-hidden="true"></i>
            <!-- 计数恒为 0：草稿只存在于导入中心的审查卡里，还没有落库的数据源 -->
            <span>草稿箱 (0)</span>
          </button>
        </div>
      </div>

      <div class="bank-search-row">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input
          v-model="keyword"
          type="text"
          class="glass-input"
          aria-label="搜索本地题库"
          placeholder="搜索题干、解析、来源或标签（#题号）…"
        />
      </div>

      <button
        type="button"
        class="glass-btn bank-filter-toggle"
        :aria-expanded="filtersOpen ? 'true' : 'false'"
        @click="filtersOpen = !filtersOpen"
      >
        <i class="fa-solid fa-filter" aria-hidden="true"></i>
        <span>筛选</span>
      </button>

      <div class="bank-management-actions">
        <button type="button" class="glass-btn-primary bank-create-btn" @click="openCreate">
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
          <span>新建题目</span>
        </button>
      </div>
    </header>

    <!-- 筛选面板：默认收起（与 MathBank 的 bank-filter-fields 一致）。
         五个条件全部来自字典表，选科目后题型候选项自动收窄。 -->
    <section v-show="filtersOpen" class="bank-filter-toolbar" aria-label="题库筛选条件">
      <select
        v-model="filterSubject"
        class="glass-select"
        aria-label="科目"
        @change="onSubjectChange"
      >
        <option value="">所有科目</option>
        <option v-for="item in dictionaries.subjects" :key="item.code" :value="item.code">
          {{ item.name }}
        </option>
      </select>
      <select v-model="filterClassLevel" class="glass-select" aria-label="年级" @change="applyFilters">
        <option value="">所有年级</option>
        <!-- 跨年级题按学段码入库（senior/junior/primary），筛选里也要能选到 -->
        <option v-for="item in CROSS_GRADE_OPTIONS" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
        <option v-for="item in dictionaries.classLevels" :key="item.code" :value="item.code">
          {{ item.name }}
        </option>
      </select>
      <select v-model="filterType" class="glass-select" aria-label="题型" @change="applyFilters">
        <option value="">所有题型</option>
        <option v-for="item in typeOptions" :key="item.code" :value="item.code">
          {{ item.name }}
        </option>
      </select>
      <select v-model="filterEasy" class="glass-select" aria-label="难度" @change="applyFilters">
        <option value="">所有级别</option>
        <option v-for="item in dictionaries.easyLevels" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>
      <button
        type="button"
        class="glass-btn bank-clear-filters"
        :disabled="!hasFilter"
        @click="clearFilters"
      >
        清除筛选
      </button>
    </section>

    <!-- 草稿箱：数据源还没有（草稿是导入中心审查卡的内存态，不入库），
         先给一块整幅空态，别让标签点了没反应 -->
    <div v-if="tab === 'drafts'" class="bank-drafts-pane">
      <div class="ui-state">
        <span class="ui-state-icon" aria-hidden="true">
          <i class="fa-solid fa-box-open"></i>
        </span>
        <strong class="ui-state-title">草稿箱是空的</strong>
        <span class="ui-state-description">
          导入中心的审查卡在点「导入此题」之前只是草稿，还没有落库；<br />
          导入之后就会出现在「本地题库」里。
        </span>
      </div>
    </div>

    <template v-else>
      <!-- 左：题目列表 -->
      <section ref="listPaneRef" class="bank-library-panel bank-question-pane">
        <div class="bank-list-toolbar">
          <strong>共 {{ total }} 道题</strong>
          <div class="bank-list-actions">
            <!-- 手动刷新：导入中心刚入库的题，靠切标签页时的自动重拉也能出来，
                 但那要求在别的页面来回一次；这个按钮让「刚导完就来确认」不用绕路 -->
            <button
              type="button"
              class="glass-btn bank-refresh-btn"
              :disabled="loading"
              title="重新读取本地题库"
              @click="reload"
            >
              <i class="fa-solid fa-rotate-right" :class="{ 'fa-spin': loading }" aria-hidden="true"></i>
              <span>{{ loading ? '读取中' : '刷新' }}</span>
            </button>
            <label class="bank-sort-control">
              <i class="fa-solid fa-arrow-down-wide-short" aria-hidden="true"></i>
              <select v-model="sort" aria-label="题目排序方式" @change="applyFilters">
                <option value="desc">倒序排列</option>
                <option value="asc">正序排列</option>
              </select>
            </label>
          </div>
        </div>

        <div class="bank-question-list">
          <div v-if="loading" class="ui-state" role="status">
            <span class="ui-state-icon" aria-hidden="true">
              <i class="fa-solid fa-circle-notch fa-spin"></i>
            </span>
            <strong class="ui-state-title">正在获取题库</strong>
            <span class="ui-state-description">题目列表加载完成后会自动显示在这里。</span>
          </div>

          <div v-else-if="error" class="ui-state ui-state-error" role="alert">
            <span class="ui-state-icon" aria-hidden="true">
              <i class="fa-solid fa-triangle-exclamation"></i>
            </span>
            <strong class="ui-state-title">读取本地题库失败</strong>
            <span class="ui-state-description">{{ error }}</span>
            <button type="button" class="ui-state-action" @click="reload">重新加载</button>
          </div>

          <div v-else-if="items.length === 0" class="ui-state">
            <span class="ui-state-icon" aria-hidden="true">
              <i class="fa-solid fa-box-open"></i>
            </span>
            <strong class="ui-state-title">
              {{ hasFilter || keyword.trim() ? '未找到匹配题目' : '本地题库还是空的' }}
            </strong>
            <span class="ui-state-description">
              {{
                hasFilter || keyword.trim()
                  ? '请调整搜索词或筛选条件后重试。'
                  : '到「导入中心」上传试卷、解析后点「导入此题」，题目就会进到这里。'
              }}
            </span>
          </div>

          <template v-else>
            <div
              v-for="item in items"
              :key="item.id"
              role="button"
              tabindex="0"
              class="bank-question-card"
              :class="{ 'is-active': item.id === selectedId }"
              @click="selectedId = item.id"
              @keydown.enter.prevent="selectedId = item.id"
              @keydown.space.prevent="selectedId = item.id"
            >
              <div class="bank-question-card-header">
                <span class="bank-question-type">{{ typeLabel(item.subjectTypeCode) }}</span>
                <div class="bank-question-badges">
                  <span class="badge-difficulty" :class="easyClass(item.easy)">
                    {{ easyLabel(item.easy) }}
                  </span>
                  <span class="badge-seq">#{{ item.id }}</span>
                </div>
              </div>

              <!-- 摘要走轻量渲染（转义 + KaTeX），卡片数量多时不用为每张卡建 Milkdown 实例 -->
              <div class="bank-question-excerpt" v-html="excerptHtml(item.content)"></div>

              <div class="bank-question-meta">
                <span :title="metaTitle(item)">
                  <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
                  {{ metaTitle(item) }}
                </span>
                <span class="bank-question-source">{{ sourceLabel(item.source) }}</span>
                <time>{{ formatDate(item.createdAt) }}</time>
              </div>

              <div v-if="item.knowledgePoints.length" class="mb-kp-badges">
                <span
                  v-for="point in item.knowledgePoints.slice(0, 3)"
                  :key="point.code"
                  class="mb-kp-badge"
                >
                  {{ point.name }} · {{ point.isMain ? '主要' : '辅助' }}
                </span>
                <span v-if="item.knowledgePoints.length > 3" class="mb-kp-badge">
                  +{{ item.knowledgePoints.length - 3 }}
                </span>
              </div>
            </div>
          </template>
        </div>

        <div v-if="pageCount > 1 && !loading && !error" class="sidebar-pagination">
          <button
            type="button"
            class="pagination-btn pagination-btn-nav"
            :disabled="page <= 1"
            @click="goPage(page - 1)"
          >
            上一页
          </button>
          <label class="pagination-page-label">
            第
            <input
              class="pagination-jump-input"
              type="number"
              min="1"
              :max="pageCount"
              :value="page"
              aria-label="跳转页码"
              @change="onJump($event)"
            />
            / {{ pageCount }} 页
          </label>
          <button
            type="button"
            class="pagination-btn pagination-btn-nav"
            :disabled="page >= pageCount"
            @click="goPage(page + 1)"
          >
            下一页
          </button>
        </div>
      </section>

      <!-- 中：可拖的分隔条（MathBank 的 resizer-1） -->
      <div
        class="bank-split-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整题目列表和题目详情的宽度"
        :aria-valuenow="Math.round(listRatio)"
        aria-valuemin="34"
        aria-valuemax="72"
        @pointerdown="startResize"
      >
        <span class="bank-split-resizer-grip" aria-hidden="true"></span>
      </div>

      <!-- 右：题目详情 -->
      <section ref="detailPaneRef" class="bank-preview-panel bank-detail-panel">
        <div class="bank-preview-toolbar">
          <span class="bank-preview-title">
            <i class="fa-solid fa-file-invoice" aria-hidden="true"></i>
            <span>题目详情</span>
          </span>
          <button
            type="button"
            class="glass-btn-primary bank-detail-edit-btn"
            :disabled="!selected"
            aria-label="编辑当前题目"
            @click="onEdit"
          >
            <i class="fa-solid fa-pen" aria-hidden="true"></i>
            <span>编辑</span>
          </button>
        </div>

        <div class="bank-preview-content">
          <div v-if="!selected" class="ui-state">
            <span class="ui-state-icon" aria-hidden="true">
              <i class="fa-solid fa-file-circle-question"></i>
            </span>
            <strong class="ui-state-title">还没有选中题目</strong>
            <span class="ui-state-description">点左侧任意一张题目卡片，这里显示完整题干与解析。</span>
          </div>

          <div v-else class="paper-card">
            <div class="bank-document-body">
              <div class="paper-badges">
                <span class="badge-seq">编号： #{{ selected.id }}</span>
                <span class="badge-type">题型： {{ typeLabel(selected.subjectTypeCode) }}</span>
                <span class="badge-difficulty" :class="easyClass(selected.easy)">
                  难度： {{ easyLabel(selected.easy) }}
                </span>
                <span class="badge-date">
                  <i class="fa-regular fa-clock" aria-hidden="true"></i>
                  {{ formatDate(selected.createdAt) }}
                </span>
                <span
                  v-for="point in selected.knowledgePoints"
                  :key="point.code"
                  class="mb-kp-badge"
                >
                  {{ point.name }} · {{ point.isMain ? '主要' : '辅助' }}
                </span>
              </div>

              <!-- 题干：真 Milkdown 只读实例（与录入页/详情页同一条渲染管线） -->
              <div class="preview-wrap">
                <div id="local-bank-content" class="preview-box is-content"></div>
                <button type="button" class="copy-btn" @click="copy(selected.content, '题干')">
                  <i class="fa-regular fa-copy" aria-hidden="true"></i>
                  <span>复制题干</span>
                </button>
              </div>

              <div class="paper-analysis">
                <div class="paper-analysis-head">
                  <span class="paper-analysis-title">
                    <i class="fa-solid fa-signature" aria-hidden="true"></i>
                    <span>参考答案与详细解析</span>
                  </span>
                  <button type="button" class="paper-analysis-toggle" @click="answerOpen = !answerOpen">
                    <i
                      :class="answerOpen ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'"
                      aria-hidden="true"
                    ></i>
                    <span>{{ answerOpen ? '隐藏解析' : '显示解析' }}</span>
                  </button>
                </div>

                <!-- 收起时只做 v-show：解析的渲染实例留着，反复切换不会重建 -->
                <div v-show="answerOpen" class="preview-wrap">
                  <div
                    v-if="selected.answerMarkdown.trim()"
                    id="local-bank-answer"
                    class="preview-box is-answer"
                  ></div>
                  <div v-else class="preview-box is-answer is-empty">暂无解析内容。</div>
                  <button
                    v-if="selected.answerMarkdown.trim()"
                    type="button"
                    class="copy-btn"
                    @click="copy(selected.answerMarkdown, '解析')"
                  >
                    <i class="fa-regular fa-copy" aria-hidden="true"></i>
                    <span>复制解析</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="paper-footer">
              <span>来源: {{ selected.source || '本地教研录入' }}</span>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- 录入 / 编辑弹窗（Teleport 到 body，样式在 styles/question-editor.css） -->
    <QuestionEditorDialog
      :open="editorOpen"
      :item="editorItem"
      @close="closeEditor"
      @saved="onEditorSaved"
    />
  </section>
</template>

<script setup lang="ts">
// 「本地题库」页：读 userData/question-bank.db（导入中心「导入此题」写进去的那些题）。
//
// 三个约定：
//   1. 数据一次性取全（列表 + 知识点 + 解析），切题不再发请求 —— 本地 SQLite 上
//      一次 20 行的 JOIN 比一次 IPC 往返便宜，翻页手感也更好。
//   2. 摘要用轻量渲染（utils/bank-excerpt），详情才建 Milkdown 实例：一页 20 个
//      Milkdown 要排队创建，进页面会看到卡片一张张跳出来。
//   3. 刷新靠 onActivated：导入中心刚入库的题，切回这个标签页就能看到。
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'
import '../assets/fontawesome/css/all.min.css'
import '../styles/local-bank.css'
import QuestionEditorDialog from '../components/QuestionEditorDialog.vue'
import {
  describeQuestionBankError,
  fetchDictionaries,
  listQuestions,
  type Dictionaries,
  type ExerciseListItem
} from '../utils/question-bank'
import { renderExcerptHtml } from '../utils/bank-excerpt'
import { classLevelLabel } from '../utils/class-level'
import { mountReadonlyPreview } from '../utils/readonly-preview'
import { showError, showSuccess } from '../stores/toast'

// MathBank 的 PAGE_LIMIT，截图里「共 41 道题 / 第 1 / 3 页」就是它
const PAGE_SIZE = 20

/**
 * 「跨年级」按学段码入库（senior = 整个高中），筛选下拉要能选到这些值。
 * 与导入中心的一致：whole-stage 的题不是某个年级的题。
 */
const CROSS_GRADE_OPTIONS = [
  { value: 'primary', label: '跨年级（小学）' },
  { value: 'junior', label: '跨年级（初中）' },
  { value: 'senior', label: '跨年级（高中）' }
]

/** 难度五档：与主进程 store 的 EASY_LABELS 同口径 */
const EASY_LABELS: Record<string, string> = {
  '1': '很易',
  '2': '易',
  '3': '中',
  '4': '难',
  '5': '拔高'
}

const SEARCH_DEBOUNCE_MS = 300

const rootRef = ref<HTMLElement | null>(null)
const listPaneRef = ref<HTMLElement | null>(null)
const detailPaneRef = ref<HTMLElement | null>(null)

const tab = ref<'bank' | 'drafts'>('bank')
const items = ref<ExerciseListItem[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const error = ref('')
const selectedId = ref<number | null>(null)
const answerOpen = ref(true)

const keyword = ref('')
const sort = ref<'desc' | 'asc'>('desc')
const filtersOpen = ref(false)
const filterType = ref('')
const filterEasy = ref('')
const filterSubject = ref('')
const filterClassLevel = ref('')

/** 筛选项的候选：科目 / 年级 / 题型 / 难度全来自字典表（与拆题共用一份） */
const dictionaries = ref<Dictionaries>({
  subjects: [],
  classLevels: [],
  subjectTypes: [],
  easyLevels: []
})

/**
 * 选了科目就只看该科目的题型。
 *
 * 题型表的 parent 是科目码；「所有科目」时给全量 —— 否则选「物理」之前
 * 连「单选题」都看不到，用户会以为题型没拉到。
 */
const typeOptions = computed(() =>
  filterSubject.value
    ? dictionaries.value.subjectTypes.filter(
        (item) => !item.parent || item.parent === filterSubject.value
      )
    : dictionaries.value.subjectTypes
)

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

const selected = computed(() => items.value.find((item) => item.id === selectedId.value) ?? null)

const hasFilter = computed(
  () =>
    Boolean(filterType.value) ||
    Boolean(filterEasy.value) ||
    Boolean(filterSubject.value) ||
    Boolean(filterClassLevel.value)
)

function typeLabel(value: string): string {
  return dictionaries.value.subjectTypes.find((item) => item.code === value)?.name ?? '未课题型'
}

function easyLabel(value: string): string {
  return EASY_LABELS[value] ?? dictionaries.value.easyLevels.find((l) => l.value === value)?.label ?? '未定'
}

function easyClass(value: string): string {
  return EASY_LABELS[value] ? `diff-${value}` : 'diff-unknown'
}

/** 卡片上的一行归属信息：科目名优先，其次年级名（跨年级题显示「跨年级（高中）」） */
function metaTitle(item: ExerciseListItem): string {
  const subject =
    dictionaries.value.subjects.find((s) => s.code === item.subjectCode)?.name ?? item.subjectCode
  // classLevelLabel 同时认年级码与学段码；空串（未指定）返回空串
  const level = classLevelLabel(item.classLevel)
  return [subject, level].filter(Boolean).join(' · ') || '未分类'
}

function sourceLabel(source: string | null): string {
  if (!source) return '本地录入'
  return source.length > 12 ? source.slice(0, 12) : source
}

function formatDate(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function excerptHtml(content: string): string {
  return renderExcerptHtml(content)
}

// ── 读取 ────────────────────────────────────────────────────────────────────

let loadToken = 0

async function load(targetPage = page.value): Promise<void> {
  const token = ++loadToken
  loading.value = true
  const result = await listQuestions({
    keyword: keyword.value.trim() || undefined,
    subjectCode: filterSubject.value || undefined,
    classLevel: filterClassLevel.value || undefined,
    subjectTypeCode: filterType.value || undefined,
    easy: filterEasy.value || undefined,
    sort: sort.value,
    page: targetPage,
    pageSize: PAGE_SIZE
  })
  // 关键词连打时后发的请求可能先回来：只认最后一次
  if (token !== loadToken) return
  loading.value = false

  if (!result.ok) {
    error.value = describeQuestionBankError(result.error)
    items.value = []
    total.value = 0
    selectedId.value = null
    showError(error.value)
    return
  }

  error.value = ''
  items.value = result.items
  total.value = result.total
  page.value = result.page
  // 库里退回的页码可能比请求的小（删过题）：跟着响应走，别把界面停在不存在的页
  if (!items.value.some((item) => item.id === selectedId.value)) {
    selectedId.value = items.value[0]?.id ?? null
  }
}

function reload(): void {
  void load(page.value)
}

function goPage(target: number): void {
  const next = Math.min(pageCount.value, Math.max(1, Math.floor(target) || 1))
  if (next === page.value) return
  void load(next)
}

/** 页码输入框：回车/失焦时跳页，非法值直接退回当前页 */
function onJump(event: Event): void {
  const input = event.target as HTMLInputElement
  const value = Number(input.value)
  const next = Number.isFinite(value) ? Math.min(pageCount.value, Math.max(1, Math.floor(value))) : page.value
  input.value = String(next)
  goPage(next)
}

function switchTab(next: 'bank' | 'drafts'): void {
  if (tab.value === next) return
  tab.value = next
  if (next === 'bank') void load(page.value)
}

/** 筛选改动一律回第 1 页：停在第 3 页却只剩 1 页结果是最难解释的状态 */
function applyFilters(): void {
  void load(1)
}

function clearFilters(): void {
  filterType.value = ''
  filterEasy.value = ''
  filterSubject.value = ''
  filterClassLevel.value = ''
  applyFilters()
}

function onSubjectChange(): void {
  // 科目一换，题型候选项整批换掉：旧值留着会筛出一个必然空的结果
  filterType.value = ''
  applyFilters()
}

// ── 录入 / 编辑弹窗 ────────────────────────────────────────────────────────
//
// 「新建题目」与详情里的「编辑」共用一个弹窗：编辑态把当前题传进去预填，
// 保存时主进程按 options.id 走 UPDATE；新建态传 null。

const editorOpen = ref(false)
const editorItem = ref<ExerciseListItem | null>(null)

function openCreate(): void {
  editorItem.value = null
  editorOpen.value = true
}

function onEdit(): void {
  if (!selected.value) return
  editorItem.value = selected.value
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
  editorItem.value = null
}

/**
 * 保存成功：回到「最新优先」的第一页并选中它。
 *
 * 不能只 load 当前页 —— 新题按 created_at 排在最前，若用户停在第 3 页或正序，
 * 保存完看到的还是旧列表，会以为没存进去。
 */
async function onEditorSaved(id: number | null): Promise<void> {
  editorOpen.value = false
  editorItem.value = null
  if (sort.value !== 'desc') sort.value = 'desc'
  await load(1)
  if (id !== null && items.value.some((item) => item.id === id)) {
    selectedId.value = id
  }
}

async function copy(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    showSuccess(`已复制${label}`)
  } catch {
    showError('复制失败：当前环境不允许写剪贴板')
  }
}

// ── 详情渲染（Milkdown 只读实例）───────────────────────────────────────────
//
// 两个挂载点固定（#local-bank-content / #local-bank-answer），切题只 setMarkdown，
// 不重建实例 —— 每重建一次内核里就多一条永不销毁的死记录（见 readonly-preview）。

async function renderDetail(): Promise<void> {
  const item = selected.value
  if (!item) return
  await nextTick()
  // 挂载点可能不在（草稿箱标签、空态）：mountReadonlyPreview 拿不到 DOM 会抛
  if (document.getElementById('local-bank-content')) {
    void mountReadonlyPreview('local-bank-content', item.content)
  }
  if (item.answerMarkdown.trim() && document.getElementById('local-bank-answer')) {
    void mountReadonlyPreview('local-bank-answer', item.answerMarkdown)
  }
}

watch([selectedId, tab], () => {
  void renderDetail()
})

// 解析区换题时默认展开：MathBank 也是每次选中就摆好
watch(selectedId, () => {
  answerOpen.value = true
})

// ── 检索 / 筛选（都回到第 1 页）─────────────────────────────────────────────

let searchTimer: number | undefined
watch(keyword, () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    void load(1)
  }, SEARCH_DEBOUNCE_MS)
})



// 首次进入靠 onMounted；之后每次从别的标签页切回来，onActivated 再拉一次
// （导入中心刚入库的题要靠这一下才出现）。
//
// 两个钩子都写，是因为 keepAlive 若没命中组件名，onActivated 根本不会触发 ——
// 那时页面会永远停在「本地题库还是空的」，而库里其实有题。首次挂载时 mount 与
// activate 会连着触发一次，用标志位跳过 activate 那一次，避免同屏查两遍。
let skipFirstActivate = true

/**
 * 筛选候选（科目 / 年级 / 题型 / 难度）。
 *
 * 只拉一次：字典是静态数据，标签页来回切不该反复过桥。拉不到时下拉为空，
 * 但列表本身照常能读 —— 不能因为筛选候选缺失就把整页判成「打不开」。
 */
let dictionariesLoaded = false
async function loadDictionaryOptions(): Promise<void> {
  if (dictionariesLoaded) return
  const dict = await fetchDictionaries()
  if (!dict.subjects.length && !dict.classLevels.length && !dict.subjectTypes.length) return
  dictionaries.value = dict
  dictionariesLoaded = true
}

onMounted(() => {
  void loadDictionaryOptions()
  void load(page.value)
})

onActivated(() => {
  if (skipFirstActivate) {
    skipFirstActivate = false
    return
  }
  void load(page.value)
})

// ── 左右两栏比例（拖拽）─────────────────────────────────────────────────────

const listRatio = ref(45)

function applyRatio(ratio: number): void {
  const clamped = Math.min(72, Math.max(34, ratio))
  listRatio.value = clamped
  rootRef.value?.style.setProperty('--bank-list-track', `${clamped}fr`)
  rootRef.value?.style.setProperty('--bank-detail-track', `${100 - clamped}fr`)
}

function startResize(event: PointerEvent): void {
  const listPane = listPaneRef.value
  const detailPane = detailPaneRef.value
  const root = rootRef.value
  if (!listPane || !detailPane || !root) return
  event.preventDefault()

  const handle = event.currentTarget as HTMLElement
  const listRect = listPane.getBoundingClientRect()
  const detailRect = detailPane.getBoundingClientRect()
  const available = detailRect.right - listRect.left - handle.getBoundingClientRect().width
  handle.classList.add('is-dragging')

  const onMove = (moveEvent: PointerEvent): void => {
    const desired = moveEvent.clientX - listRect.left - handle.getBoundingClientRect().width / 2
    applyRatio((desired / Math.max(1, available)) * 100)
  }
  const onUp = (): void => {
    handle.classList.remove('is-dragging')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
</script>
