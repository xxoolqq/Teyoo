<template>
  <section id="paper-builder">
    <!-- 顶部命令条：搜索 + 筛选 + 试卷信息 + AI 选题 -->
    <header class="pb-toolbar">
      <div class="pb-search">
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <input v-model="keyword" type="search" placeholder="搜索题干、来源或标签..." />
      </div>
      <button
        type="button"
        class="pb-tool"
        :class="{ 'is-on': filtersOpen }"
        @click="filtersOpen = !filtersOpen"
      >
        <i class="fa-solid fa-filter" aria-hidden="true"></i>
        <span>筛选</span>
      </button>
      <button
        type="button"
        class="pb-tool"
        :class="{ 'is-on': infoOpen }"
        @click="infoOpen = !infoOpen"
      >
        <i class="fa-regular fa-file-lines" aria-hidden="true"></i>
        <span>试卷信息</span>
      </button>
      <button type="button" class="pb-tool is-accent" @click="aiPick">
        <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
        <span>AI 选题</span>
      </button>
    </header>

    <div v-show="filtersOpen" class="pb-filters">
      <label class="pb-filter">
        <span>科目</span>
        <select v-model="subject">
          <option value="">全部</option>
          <option v-for="item in dictionaries.subjects" :key="item.code" :value="item.code">
            {{ item.name }}
          </option>
        </select>
      </label>
      <label class="pb-filter">
        <span>题型</span>
        <select v-model="questionType">
          <option value="">全部</option>
          <option v-for="item in typeOptions" :key="item.code" :value="item.code">
            {{ item.name }}
          </option>
        </select>
      </label>
      <label class="pb-filter">
        <span>难度</span>
        <select v-model="difficulty">
          <option value="">全部</option>
          <option v-for="item in dictionaries.easyLevels" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select>
      </label>
      <label class="pb-filter">
        <span>年级</span>
        <select v-model="classLevel">
          <option value="">全部</option>
          <option v-for="item in dictionaries.classLevels" :key="item.code" :value="item.code">
            {{ item.name }}
          </option>
        </select>
      </label>
      <button type="button" class="pb-link" @click="resetFilters">重置</button>
    </div>

    <div v-show="infoOpen" class="pb-info">
      <label class="pb-info-field">
        <span>试卷标题</span>
        <input v-model="paperTitle" type="text" placeholder="例如：高二数学·立体几何专项" />
      </label>
      <span class="pb-info-hint">
        导出时写在卷面顶部：共 {{ entries.length }} 题 · 满分 {{ totalScore }} 分
      </span>
    </div>

    <div class="pb-body">
      <!-- 左：题目列表 -->
      <div class="pb-list">
        <div class="pb-list-scroll">
          <div v-if="loading" class="pb-state">
            <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
            <span>正在读取题库…</span>
          </div>

          <div v-else-if="error" class="pb-state is-error" role="alert">
            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
            <span>{{ error }}</span>
            <button type="button" class="pb-link" @click="load(page)">重新加载</button>
          </div>

          <div v-else-if="!items.length" class="pb-state">
            <i class="fa-solid fa-box-open" aria-hidden="true"></i>
            <span>{{ hasFilter ? '没有匹配的题目，换个条件试试' : '本地题库还是空的' }}</span>
            <span class="pb-state-sub">
              {{
                hasFilter
                  ? '搜索词、题型、难度、章节任一条件都可能把它筛掉'
                  : '到「导入中心」上传试卷并导入题目后，这里就能选题'
              }}
            </span>
          </div>

          <template v-else>
            <article
              v-for="item in items"
              :key="item.id"
              class="pb-card"
              :class="{ 'is-added': addedIds.has(item.id) }"
            >
              <div class="pb-card-head">
                <span class="pb-card-id">#{{ item.id }}</span>
                <span class="pb-card-type">{{ typeLabel(item.subjectTypeCode) }}</span>
                <div class="pb-card-actions">
                  <button type="button" class="pb-link" @click="toggleAnswer(item.id)">
                    <i class="fa-regular fa-eye" aria-hidden="true"></i>
                    <span>查看答案</span>
                  </button>
                  <button
                    type="button"
                    class="pb-add"
                    :class="{ 'is-added': addedIds.has(item.id) }"
                    @click="toggleEntry(item)"
                  >
                    <i
                      class="fa-solid"
                      :class="addedIds.has(item.id) ? 'fa-check' : 'fa-plus'"
                      aria-hidden="true"
                    ></i>
                    <span>{{ addedIds.has(item.id) ? '已加入' : '加入试卷' }}</span>
                  </button>
                </div>
              </div>

              <div class="pb-card-badges">
                <span
                  class="pb-diff"
                  :style="{
                    color: easyColor(item.easy),
                    background: `${easyColor(item.easy)}1a`
                  }"
                >
                  {{ easyLabel(item.easy) }}
                </span>
                <span class="pb-card-meta">{{ metaTitle(item) }}</span>
              </div>

              <div class="pb-card-source">来源：{{ item.source || '未标注' }}</div>

              <div v-if="item.knowledgePoints.length" class="pb-card-kp">
                <span class="pb-kp-label">知识点</span>
                <span v-for="point in item.knowledgePoints.slice(0, 3)" :key="point.code" class="pb-kp">
                  {{ point.name }} · {{ point.role === 'auxiliary' ? '辅助' : '主要' }}
                </span>
                <span v-if="item.knowledgePoints.length > 3" class="pb-kp">
                  +{{ item.knowledgePoints.length - 3 }}
                </span>
              </div>

              <div class="pb-card-body" v-html="bodyHtml(item)"></div>

              <div v-if="expandedIds.has(item.id)" class="pb-card-answer">
                <span class="pb-answer-title">参考答案与解析</span>
                <div v-if="item.answerMarkdown.trim()" v-html="answerHtml(item)"></div>
                <p v-else class="pb-answer-empty">这道题还没有录入答案与解析。</p>
              </div>
            </article>
          </template>
        </div>

        <div v-if="pageCount > 1 && !loading && !error" class="pb-pager">
          <button type="button" :disabled="page <= 1" @click="load(page - 1)">上一页</button>
          <span>{{ page }} / {{ pageCount }} · 共 {{ total }} 题</span>
          <button type="button" :disabled="page >= pageCount" @click="load(page + 1)">下一页</button>
        </div>
      </div>

      <!-- 右：试卷预览 -->
      <aside class="pb-panel">
        <div class="pb-panel-head">
          <span class="pb-panel-title">
            <i class="fa-regular fa-file-lines" aria-hidden="true"></i>
            试卷预览
          </span>
          <span class="pb-live">
            <i class="fa-solid fa-bolt" aria-hidden="true"></i>
            实时预览
          </span>
        </div>

        <div class="pb-summary">
          <div class="pb-summary-top">
            <span class="pb-total">总分：<b>{{ totalScore }}</b> 分</span>
            <span class="pb-count"><b>{{ entries.length }}</b> 题</span>
          </div>

          <div class="pb-diffbar">
            <span class="pb-diffbar-label">难度比</span>
            <span class="pb-diffbar-track" role="img" :aria-label="difficultyText">
              <i
                v-for="bucket in activeBuckets"
                :key="bucket.key"
                :style="{ flexGrow: bucket.count, background: bucket.color }"
              ></i>
            </span>
            <span class="pb-diffbar-text">{{ difficultyText }}</span>
          </div>

          <div class="pb-gap-row">
            <label for="pb-gap">题宫</label>
            <select id="pb-gap-preset" v-model.number="gapPreset" @change="applyGapPreset">
              <option v-for="preset in GAP_PRESETS" :key="preset.value" :value="preset.value">
                {{ preset.label }}
              </option>
            </select>
            <input id="pb-gap" v-model.number="gapCm" type="number" min="1" max="20" step="0.5" />
            <span>cm</span>
          </div>

          <div class="pb-actions">
            <button type="button" class="pb-ghost" :disabled="!entries.length" @click="clearEntries">
              清空卷面
            </button>
            <button type="button" class="pb-primary" :disabled="!entries.length || busy" @click="savePaper">
              <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
              保存试卷
            </button>
          </div>

          <div class="pb-exports">
            <button
              type="button"
              class="pb-ghost"
              :disabled="!entries.length || busy"
              @click="previewPdf"
            >
              <i class="fa-regular fa-file-pdf" aria-hidden="true"></i>
              PDF 预览
            </button>
            <button
              type="button"
              class="pb-ghost"
              :disabled="!entries.length || busy"
              @click="exportWord"
            >
              <i class="fa-regular fa-file-word" aria-hidden="true"></i>
              Word 导出
            </button>
          </div>

          <button
            type="button"
            class="pb-ghost pb-wide"
            :disabled="!entries.length || busy"
            @click="previewAnswerSheet"
          >
            <i class="fa-regular fa-rectangle-list" aria-hidden="true"></i>
            答题卡 PDF 预览
          </button>

          <p class="pb-hint">从左加入题目后，即可保存和导出。</p>
        </div>

        <div v-if="entries.length" class="pb-entries">
          <div v-for="(entry, index) in entries" :key="entry.id" class="pb-entry">
            <span class="pb-entry-no">{{ index + 1 }}</span>
            <span class="pb-entry-title" :title="`#${entry.id} ${typeLabel(entry.item.subjectTypeCode)}`">
              #{{ entry.id }} · {{ typeLabel(entry.item.subjectTypeCode) }}
            </span>
            <input v-model.number="entry.score" class="pb-entry-score" type="number" min="0" step="1" />
            <span class="pb-entry-unit">分</span>
            <button
              type="button"
              class="pb-entry-remove"
              :title="`从卷面移除第 ${index + 1} 题`"
              @click="removeEntry(entry.id)"
            >
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </div>

        <div class="pb-history">
          <div class="pb-history-head">
            <span>最近导出预览（保留最近 5 次）</span>
            <button v-if="history.length" type="button" class="pb-link" @click="clearHistory">清空</button>
          </div>
          <ul v-if="history.length" class="pb-history-list">
            <li v-for="record in history" :key="record.id">
              <i
                class="fa-regular"
                :class="record.ok ? 'fa-circle-check is-ok' : 'fa-circle-xmark is-fail'"
                aria-hidden="true"
              ></i>
              <span class="pb-history-name" :title="record.path || record.name">{{ record.name }}</span>
              <time>{{ formatTime(record.at) }}</time>
            </li>
          </ul>
          <p v-else class="pb-history-empty">还没有导出记录。</p>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
// 「智能组卷」：左边挑题、右边成卷，与本地题库共用一份 SQLite 数据。
//
// 组卷状态只活在这一页（entries），不落库：试卷本身通过「保存试卷」（Markdown）/
// 「Word 导出」/「PDF 预览」三种方式带走。这与截图里的 MathBank 心智一致 ——
// 那个页面的「保存试卷」也只是把卷面交出去，不是写回题库。
//
// 题面排版走 utils/paper-render 的轻量渲染（转义 + KaTeX + 选项两列），不为每张
// 卡片建 Milkdown 实例：只读实例是全局串行创建的，20 张卡要排队好几秒。
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import '../assets/fontawesome/css/all.min.css'
import '../styles/paper-builder.css'
import {
  describeQuestionBankError,
  fetchDictionaries,
  listQuestions,
  type Dictionaries,
  type ExerciseListItem
} from '../utils/question-bank'
import { renderBodyHtml } from '../utils/paper-render'
import {
  buildAnswerSheetHtml,
  buildPaperHtml,
  buildPaperMarkdown,
  clearPaperHistory,
  DEFAULT_GAP_CM,
  DEFAULT_SCORE,
  describePaperError,
  easyBuckets,
  easyColor,
  easyLabel,
  exportPaperDocx,
  exportPaperPdfFile,
  loadPaperHistory,
  savePaperMarkdown,
  totalScore as sumScore,
  type PaperEntry,
  type PaperExportRecord
} from '../utils/paper'
import { showToast } from '../utils/math-parse'
import { showError, showSuccess } from '../stores/toast'

const PAGE_SIZE = 20

const GAP_PRESETS = [
  { value: 5, label: '5.0 cm' },
  { value: 7, label: '7.0 cm（自定义）' },
  { value: 9, label: '9.0 cm' },
  { value: 12, label: '12.0 cm' }
]

// ── 题库列表 ────────────────────────────────────────────────────────────────

const items = ref<ExerciseListItem[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const questionType = ref('')
const difficulty = ref('')
const subject = ref('')
const classLevel = ref('')

/** 筛选项的候选：与本地题库页同一份字典（主进程 SQLite） */
const dictionaries = ref<Dictionaries>({
  subjects: [],
  classLevels: [],
  subjectTypes: [],
  easyLevels: []
})

/** 题型按科目收窄：一道物理题不该被「完形填空」这类题型关键词搜到 */
const typeOptions = computed(() =>
  subject.value
    ? dictionaries.value.subjectTypes.filter((item) => !item.parent || item.parent === subject.value)
    : dictionaries.value.subjectTypes
)

function typeLabel(code: string): string {
  return dictionaries.value.subjectTypes.find((item) => item.code === code)?.name ?? '题目'
}

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const hasFilter = computed(
  () =>
    !!keyword.value.trim() ||
    !!questionType.value ||
    !!difficulty.value ||
    !!subject.value ||
    !!classLevel.value
)

async function loadDictionaryOptions(): Promise<void> {
  const dict = await fetchDictionaries()
  if (!dict.subjects.length && !dict.classLevels.length && !dict.subjectTypes.length) return
  dictionaries.value = dict
}

async function load(targetPage = page.value): Promise<void> {
  loading.value = true
  error.value = ''
  const result = await listQuestions({
    keyword: keyword.value.trim() || undefined,
    subjectCode: subject.value || undefined,
    subjectTypeCode: questionType.value || undefined,
    easy: difficulty.value || undefined,
    classLevel: classLevel.value || undefined,
    page: Math.max(1, targetPage),
    pageSize: PAGE_SIZE
  })
  loading.value = false
  if (!result.ok) {
    error.value = describeQuestionBankError(result.error)
    items.value = []
    total.value = 0
    return
  }
  items.value = result.items
  total.value = result.total
  page.value = result.page
}

let searchTimer: number | undefined
watch(keyword, () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void load(1), 300)
})
watch([questionType, difficulty, classLevel], () => void load(1))

// 换科目要把题型清掉（旧题型码多半不属于新科目），清空本身又会触发题型 watch ——
// 用标记吃掉那一次，别发两遍请求
let resettingType = false
watch(subject, () => {
  if (questionType.value) {
    resettingType = true
    questionType.value = ''
  }
  void load(1)
})
watch(questionType, () => {
  if (resettingType) {
    resettingType = false
    return
  }
  void load(1)
})

function resetFilters(): void {
  keyword.value = ''
  questionType.value = ''
  difficulty.value = ''
  subject.value = ''
  classLevel.value = ''
  void load(1)
}

// ── 题面渲染（按 id 缓存，模板每次渲染都会取）──────────────────────────────

const bodyCache = new Map<number, string>()
const answerCache = new Map<number, string>()

function bodyHtml(item: ExerciseListItem): string {
  const cached = bodyCache.get(item.id)
  if (cached !== undefined) return cached
  const html = renderBodyHtml(item.content)
  bodyCache.set(item.id, html)
  return html
}

function answerHtml(item: ExerciseListItem): string {
  const cached = answerCache.get(item.id)
  if (cached !== undefined) return cached
  const html = renderBodyHtml(item.answerMarkdown)
  answerCache.set(item.id, html)
  return html
}

function metaTitle(item: ExerciseListItem): string {
  const subjectName =
    dictionaries.value.subjects.find((entry) => entry.code === item.subjectCode)?.name ?? ''
  const levelName =
    dictionaries.value.classLevels.find((entry) => entry.code === item.classLevel)?.name ?? ''
  const parts = [subjectName, levelName].filter(Boolean)
  return parts.length ? parts.join(' · ') : '未标注科目/年级'
}

// ── 组卷状态 ────────────────────────────────────────────────────────────────

const entries = ref<PaperEntry[]>([])
const expandedIds = ref<Set<number>>(new Set())
const paperTitle = ref(defaultPaperTitle())
const gapCm = ref(DEFAULT_GAP_CM)
const gapPreset = ref(DEFAULT_GAP_CM)
const busy = ref(false)
const filtersOpen = ref(false)
const infoOpen = ref(false)

function defaultPaperTitle(): string {
  const now = new Date()
  return `${now.getFullYear()} 年 ${now.getMonth() + 1} 月智能组卷`
}

const addedIds = computed(() => new Set(entries.value.map((entry) => entry.id)))
const totalScore = computed(() => sumScore(entries.value))
const buckets = computed(() => easyBuckets(entries.value))
const activeBuckets = computed(() => buckets.value.filter((bucket) => bucket.count > 0))
const difficultyText = computed(() => {
  if (!entries.value.length) return '—'
  return activeBuckets.value.map((bucket) => `${bucket.label} ${bucket.percent}%`).join(' · ')
})

function defaultScoreFor(item: ExerciseListItem): number {
  return item.subjectTypeCode === 'detailed_answer' ? 10 : DEFAULT_SCORE
}

function toggleEntry(item: ExerciseListItem): void {
  const index = entries.value.findIndex((entry) => entry.id === item.id)
  if (index >= 0) {
    entries.value.splice(index, 1)
    return
  }
  entries.value.push({ id: item.id, score: defaultScoreFor(item), item })
}

function removeEntry(id: number): void {
  entries.value = entries.value.filter((entry) => entry.id !== id)
}

function clearEntries(): void {
  entries.value = []
}

function toggleAnswer(id: number): void {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

function applyGapPreset(): void {
  gapCm.value = gapPreset.value
}

/** 手改数值就切回「自定义」 */
watch(gapCm, (value) => {
  const preset = GAP_PRESETS.find((item) => item.value === value)
  if (preset && preset.value === gapPreset.value) return
  if (preset) gapPreset.value = preset.value
})

function shuffle<T>(list: T[]): T[] {
  const copy = [...list]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

/**
 * 「AI 选题」：按难度配比从当前列表里抽题（很易 2 / 易 3 / 中 3 / 难 1 / 拔高 1）。
 *
 * 这里不调模型 —— 本地题库的难度字段已经是人工标的，按配比抽题比让模型猜更稳，
 * 而且立刻出结果。配比凑不满时用剩下的题随机补齐。
 *
 * 配比按五档写而不是「易/中/难」三桶：库里存的就是 '1'~'5'，三桶还得自己做映射，
 * 中间那档到底算易还是中，每次讨论都要重来一遍。
 */
function aiPick(): void {
  const pool = items.value.filter((item) => !addedIds.value.has(item.id))
  if (!pool.length) {
    showToast('当前列表里的题目都已经在卷面上了', 'info')
    return
  }
  const quota: Record<string, number> = { '1': 2, '2': 3, '3': 3, '4': 1, '5': 1 }
  const picked: ExerciseListItem[] = []
  for (const [key, count] of Object.entries(quota)) {
    const bucket = shuffle(pool.filter((item) => item.easy === key && !picked.includes(item)))
    picked.push(...bucket.slice(0, count))
  }
  const rest = shuffle(pool.filter((item) => !picked.includes(item)))
  picked.push(...rest.slice(0, Math.max(0, 10 - picked.length)))
  picked.forEach((item) => {
    entries.value.push({ id: item.id, score: defaultScoreFor(item), item })
  })
  showToast(
    `已按难度配比加入 ${picked.length} 题（很易 2 / 易 3 / 中 3 / 难 1 / 拔高 1，不足随机补齐）`,
    'info'
  )
}

// ── 导出 ────────────────────────────────────────────────────────────────────

const history = ref<PaperExportRecord[]>([])

function paperName(): string {
  const name = paperTitle.value.trim() || '未命名试卷'
  return name.replace(/[\\/:*?"<>|]/g, '-')
}

async function refreshHistory(): Promise<void> {
  history.value = await loadPaperHistory()
}

function formatTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function handleExportResult(
  result: { ok: boolean; error?: string },
  label: string
): void {
  if (result.ok) {
    showSuccess(`${label}已生成`)
    void refreshHistory()
    return
  }
  if (result.error === 'CANCELED') return
  showError(describePaperError(result.error))
}

async function savePaper(): Promise<void> {
  if (!entries.value.length || busy.value) return
  busy.value = true
  try {
    const result = await savePaperMarkdown(
      buildPaperMarkdown(entries.value, { title: paperTitle.value, gapCm: gapCm.value }),
      paperName()
    )
    if (result.ok) showSuccess(`试卷已保存：${result.name ?? ''}`)
    else if (result.error !== 'CANCELED') showError(describePaperError(result.error))
  } finally {
    busy.value = false
  }
}

/** PDF 预览 = 生成卷面 PDF 后直接交给系统 PDF 阅读器打开 */
async function previewPdf(): Promise<void> {
  if (!entries.value.length || busy.value) return
  busy.value = true
  try {
    const result = await exportPaperPdfFile({
      html: buildPaperHtml(entries.value, { title: paperTitle.value, gapCm: gapCm.value }),
      defaultName: paperName(),
      kind: 'pdf',
      openAfter: true
    })
    handleExportResult(result, '卷面 PDF')
  } finally {
    busy.value = false
  }
}

async function previewAnswerSheet(): Promise<void> {
  if (!entries.value.length || busy.value) return
  busy.value = true
  try {
    const result = await exportPaperPdfFile({
      html: buildAnswerSheetHtml(entries.value, { title: paperTitle.value, gapCm: gapCm.value }),
      defaultName: `${paperName()}-答题卡`,
      kind: 'answer-sheet',
      openAfter: true
    })
    handleExportResult(result, '答题卡 PDF')
  } finally {
    busy.value = false
  }
}

async function exportWord(): Promise<void> {
  if (!entries.value.length || busy.value) return
  busy.value = true
  try {
    const ok = await exportPaperDocx(
      buildPaperMarkdown(entries.value, { title: paperTitle.value, gapCm: gapCm.value }),
      paperName()
    )
    if (ok) {
      showSuccess('Word 已导出')
      void refreshHistory()
    } else {
      showError('Word 导出未完成（已取消或导出失败）')
    }
  } finally {
    busy.value = false
  }
}

async function clearHistory(): Promise<void> {
  const ok = await clearPaperHistory()
  if (ok) {
    history.value = []
    showSuccess('导出记录已清空')
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

let mounted = false

onMounted(async () => {
  // 字典先到，题型/难度/年级的下拉才有选项；列表可以并行拉，不互相等
  void loadDictionaryOptions()
  await load(1)
  void refreshHistory()
  mounted = true
})

// 保活页：从别的标签页切回来时刷新一次，题库里新导入的题目立刻可见。
// 首次挂载后 onActivated 也会立刻触发一次，用 mounted 挡掉，避免开场发两遍请求。
onActivated(() => {
  if (!mounted) return
  void load(page.value)
})
</script>
