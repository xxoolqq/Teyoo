<template>
  <!-- 「题目」主页面：一页两视图。
       1) 检索题目 —— ctbapp 的 Search.vue 对位页，走 MeiliSearchController 的
          /meili/search/match/query.do，全库、单字段、后端不给 total；
       2) 线上习题 —— 原 OnlineExerciseView（ctbapp 的 MyTopic.vue），走
          /background/get/teacher/upload/exercises.do，只列自己录的题、分页带 total。

       两个视图的数据源是两套后端接口（能力不重叠：前者不能按上传者过滤、也没有
       总数，后者不能按关键词检索），所以合并的是「页面」而不是「查询」——
       切换视图只换取数逻辑，卡片、操作、分页条、空态都共用一套。 -->
  <div class="container">
    <!-- 视图切换：菜单里只留「检索题目」一项，线上习题收进这里。
         状态记在 query.view 上（不新开标签，见路由 meta.singleton），
         这样从题目详情/纠错「返回列表」时还能回到原来的视图。 -->
    <div class="view-switch" role="tablist">
      <button
        class="view-btn"
        :class="{ 'is-active': view === 'search' }"
        type="button"
        role="tab"
        :aria-selected="view === 'search'"
        @click="setView('search')"
      >
        检索题目
      </button>
      <button
        class="view-btn"
        :class="{ 'is-active': view === 'mine' }"
        type="button"
        role="tab"
        :aria-selected="view === 'mine'"
        @click="setView('mine')"
      >
        线上习题
      </button>
    </div>

    <!-- 检索条件：字段 + 值 + 按钮。字段决定「值」是输入框还是下拉 ——
         题号/科目/年级/难度在索引里是 keyword，match 等价精确匹配，只能选不能敲 -->
    <div v-if="view === 'search'" class="search_wrapper">
      <select v-model="fieldKey" class="field-select" @change="onFieldChange">
        <option v-for="opt in FIELD_OPTIONS" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>

      <select v-if="valueOptions" v-model="selectedValue" class="value-select">
        <option value="" disabled>请选择{{ currentField.label }}</option>
        <option v-for="opt in valueOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <input
        v-else
        v-model="phrase"
        class="search-input"
        type="text"
        maxlength="100"
        autocomplete="off"
        :placeholder="currentField.placeholder"
        @keyup.enter="doSearch"
      />

      <button class="search_btn" type="button" :disabled="loading" @click="doSearch">检索</button>
    </div>

    <!-- 线上习题的工具条：条数 + 刷新。刷新机制的另一半在 script 里 ——
         watch topicsVersion，录入 / 纠错成功后自动重拉，人不在这个视图也照刷 -->
    <div v-else class="list-toolbar">
      <span class="count">共 {{ mineTotal }} 条</span>
      <button class="refresh-btn" type="button" :disabled="mineLoading" @click="onMineRefresh">
        刷新
      </button>
    </div>

    <!-- 注意这里刻意不用 v-if/v-else 串成一条链：检索中（loading）时结果区
         不卸载 —— 卡片一卸载，里面的 Milkdown 实例就跟着进回收站，下次还得
         整批重建。loading 只是多一行提示，旧结果原地留着。 -->
    <div ref="bodyEl" class="search_body">
      <template v-if="view === 'search'">
        <p v-if="loading" class="state">检索中…</p>
        <p v-if="error && !loading" class="state is-error">{{ error }}</p>
        <p v-if="!searched && !loading" class="state">选择字段、填好内容后点「检索」</p>
        <p v-if="searched && items.length === 0 && !loading" class="state">没有匹配的题目</p>
        <!-- id="editor"：题干是 Milkdown 只读渲染，主题排版规则全写成
             `#editor .ProseMirror …`，得给它一个 #editor 祖先 -->
        <div v-if="items.length > 0" id="editor" class="topic-list-host">
          <TopicCard v-for="item in items" :key="item.exerciseCode" :item="item">
            <template #actions>
              <span class="op" @click="goTopicDetail(router, item)">
                <img :src="iconJiexi" alt="" />
                <span>解析</span>
              </span>
              <span class="op" @click="onFixError(item)">
                <img :src="iconJiucuo" alt="" />
                <span>纠错</span>
              </span>
              <span class="op is-inert">
                <!-- 检索结果里的收藏仍是摆设（ctbapp 原版就没绑事件），一律画成未收藏；
                     线上习题视图里的收藏是真的，两边的差异见下方注释 -->
                <img :src="iconFavNo" alt="" />
                <span>收藏</span>
              </span>
              <span class="op" @click="downloadTopic(item)">
                <img :src="iconDownload" alt="" />
                <span>下载</span>
              </span>
            </template>
          </TopicCard>
        </div>
      </template>

      <template v-else>
        <p v-if="mineLoading" class="state">加载中…</p>
        <p v-if="mineError && !mineLoading" class="state is-error">{{ mineError }}</p>
        <p v-if="mineLoaded && mineItems.length === 0 && !mineLoading && !mineError" class="state">
          还没有录入过题目
        </p>
        <!-- 我录入的题都是自己的，纠错前不用查权限；收藏是真的（后端 toggle +
             列表加载时用 status 批量查询摆好初始状态） -->
        <div v-if="mineItems.length > 0" id="editor" class="topic-list-host">
          <TopicCard v-for="item in mineItems" :key="item.exerciseCode" :item="item">
            <template #actions>
              <span class="op" @click="goTopicDetail(router, item, LIST_PAGE_MY_TOPIC)">
                <img :src="iconJiexi" alt="" />
                <span>解析</span>
              </span>
              <span class="op" @click="goTopicFixError(router, item, LIST_PAGE_MY_TOPIC)">
                <img :src="iconJiucuo" alt="" />
                <span>纠错</span>
              </span>
              <span
                class="op"
                :class="{ 'is-favored': favoredCodes.has(String(item.exerciseCode)) }"
                @click="toggleFav(item)"
              >
                <!-- 星标：未收藏空心（weishoucang）、已收藏实心（yishoucang） -->
                <img
                  :src="favoredCodes.has(String(item.exerciseCode)) ? iconFavYes : iconFavNo"
                  alt=""
                />
                <span>{{ favoredCodes.has(String(item.exerciseCode)) ? '已收藏' : '收藏' }}</span>
              </span>
              <span class="op" @click="downloadTopic(item)">
                <img :src="iconDownload" alt="" />
                <span>下载</span>
              </span>
            </template>
          </TopicCard>
        </div>
      </template>
    </div>

    <!-- 分页两套，因为两个后端口径不同：
         检索视图 —— 后端不返回 total，只认「上一页 / 本页取满了就还有下一页」；
         线上习题 —— PageHelper 分页，给 total，交给 Pagination 组件。 -->
    <div v-if="view === 'search' && searched" class="page_part">
      <button class="page-btn" type="button" :disabled="pageNum <= 1 || loading" @click="goPage(pageNum - 1)">
        上一页
      </button>
      <span class="page-info">第 {{ pageNum }} 页</span>
      <button class="page-btn" type="button" :disabled="!hasMore || loading" @click="goPage(pageNum + 1)">
        下一页
      </button>
    </div>
    <div v-else-if="view === 'mine'" class="page_part">
      <Pagination
        :total="mineTotal"
        :page-num="minePage"
        :page-size="MINE_PAGE_SIZE"
        @change="onMinePageChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Pagination from '../components/Pagination.vue'
import TopicCard from '../components/TopicCard.vue'
import { fetchMyTopics, searchTopics, type SearchField, type TopicItem } from '../api/topics'
import { fetchFavoriteStatus, toggleFavorite } from '../api/favorites'
import { describeError, showError, showInfo } from '../stores/toast'
import { rememberTopics } from '../stores/topic-detail'
import { topicsVersion } from '../stores/topic-events'
import { CLASS_LEVEL_OPTIONS } from '../utils/class-level'
import { COURSE_OPTIONS } from '../utils/course'
import { EASY_LEVELS } from '../utils/topic-meta'
import {
  LIST_PAGE_MY_TOPIC,
  canFixTopic,
  downloadTopic,
  goTopicDetail,
  goTopicFixError
} from '../utils/topic-actions'
import iconJiexi from '../assets/jiexi.png'
import iconJiucuo from '../assets/jiucuo.png'
import iconFavNo from '../assets/weishoucang.png'
import iconFavYes from '../assets/yishoucang.png'
import iconDownload from '../assets/download.png'

/** 视图：检索全库 / 我录入的。以 URL 的 query.view 为准，刷新和返回都不丢 */
type View = 'search' | 'mine'

// 后端默认 10、上限 50（ElasticController.MAX_PAGE_SIZE），检索取默认值
const SEARCH_PAGE_SIZE = 10
// 线上习题沿用 ctbapp 的 MyTopic 默认值（原文件 page.pageSize = 5）
const MINE_PAGE_SIZE = 5

interface FieldOption {
  value: SearchField
  label: string
  /** 文本字段的输入提示（下拉字段用不到） */
  placeholder: string
}

const FIELD_OPTIONS: FieldOption[] = [
  { value: 'subjectSelf', label: '题干', placeholder: '输入题干关键词，回车检索' },
  { value: 'answerSelf', label: '答案', placeholder: '输入答案关键词，回车检索' },
  { value: 'exerciseCode', label: '题目编号', placeholder: '输入题目编号，精确匹配' },
  { value: 'course', label: '科目', placeholder: '' },
  { value: 'classLevel', label: '适用年级', placeholder: '' },
  { value: 'easy', label: '难易程度', placeholder: '' }
]

const route = useRoute()
const router = useRouter()

const view = computed<View>(() => (route.query.view === 'mine' ? 'mine' : 'search'))

/** 切换视图走 router.replace：不进历史，也不在标签栏里新开一个标签 */
function setView(next: View): void {
  if (next === view.value) return
  void router.replace(next === 'mine' ? { path: '/home', query: { view: 'mine' } } : { path: '/home' })
}

/* ── 检索视图 ─────────────────────────────────────────────────────────── */

const fieldKey = ref<SearchField>('subjectSelf')
const phrase = ref('')
const selectedValue = ref('')

const items = ref<TopicItem[]>([])
const loading = ref(false)
const error = ref('')
/** 至少检索过一次才显示「没有匹配 / 分页」，否则一进页面就是一句「没有匹配」 */
const searched = ref(false)
const pageNum = ref(1)
const hasMore = ref(false)

const bodyEl = ref<HTMLElement | null>(null)

const currentField = computed(
  () => FIELD_OPTIONS.find((opt) => opt.value === fieldKey.value) ?? FIELD_OPTIONS[0]
)

/** keyword 字段的值域（码 → 人话），文本字段返回 null 表示用输入框 */
const valueOptions = computed<{ value: string; label: string }[] | null>(() => {
  switch (fieldKey.value) {
    case 'course':
      return COURSE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))
    case 'classLevel':
      return CLASS_LEVEL_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))
    case 'easy':
      return EASY_LEVELS.map((level) => ({ value: level, label: `${level}` }))
    default:
      return null
  }
})

/** 上一次真正提交的检索条件：翻页沿用它，不理会输入框里改了没提交的内容 */
let lastQuery: { field: SearchField; keyphrase: string } | null = null

/** 字段一换，旧的值和旧的结果都不再成立 */
function onFieldChange(): void {
  selectedValue.value = ''
  phrase.value = ''
  items.value = []
  searched.value = false
  error.value = ''
  pageNum.value = 1
  hasMore.value = false
  lastQuery = null
}

/** 当前界面上的检索条件（下拉字段取选项值，文本字段取输入框） */
function currentKeyphrase(): string {
  return valueOptions.value ? selectedValue.value : phrase.value.trim()
}

async function run(query: { field: SearchField; keyphrase: string }, page: number): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await searchTopics({
      field: query.field,
      keyphrase: query.keyphrase,
      pageNum: page,
      pageSize: SEARCH_PAGE_SIZE
    })
    // 末页恰好取满时，「下一页」会落到空页（后端不给 total，只能这么推断）：
    // 退回上一页、收起下一页按钮，别把用户丢在一片空白上
    if (result.list.length === 0 && page > 1) {
      pageNum.value = page - 1
      hasMore.value = false
      return
    }
    items.value = result.list
    hasMore.value = result.hasMore
    pageNum.value = page
    searched.value = true
    // 点「解析 / 纠错」时详情页直接从缓存取，不用再拉一次
    rememberTopics(result.list)
    // 翻页后回到顶部，别停在上一页的位置
    scrollBodyToTop()
  } catch (err) {
    error.value = describeError(err)
    showError(error.value)
  } finally {
    loading.value = false
  }
}

function doSearch(): void {
  const keyphrase = currentKeyphrase()
  if (!keyphrase) {
    showInfo(valueOptions.value ? `请先选择${currentField.value.label}` : '先输入要检索的内容')
    return
  }
  lastQuery = { field: fieldKey.value, keyphrase }
  void run(lastQuery, 1)
}

function goPage(page: number): void {
  if (!lastQuery || page < 1) return
  void run(lastQuery, page)
}

/** 纠错要过权限：只有本人（或管理员 10028）能改，规则照 ctbapp 的 Search.vue */
function onFixError(item: TopicItem): void {
  if (!canFixTopic(item)) {
    showError('您没有权限修改')
    return
  }
  goTopicFixError(router, item)
}

/* ── 线上习题视图 ─────────────────────────────────────────────────────── */

const mineItems = ref<TopicItem[]>([])
const mineTotal = ref(0)
const minePage = ref(1)
const mineLoading = ref(false)
const mineError = ref('')
/** 是否已经拉过一次：没拉过就不显示「还没有录入过题目」，免得闪一下 */
const mineLoaded = ref(false)

/** 本页已收藏的题号集合：卡片上「收藏」按钮的初始状态（status 批量查询） */
const favoredCodes = ref(new Set<string>())
/** 正在切换收藏的题号：请求进行中忽略重复点击 */
const favPending = new Set<string>()

async function loadMine(page: number): Promise<void> {
  mineLoading.value = true
  mineError.value = ''
  try {
    const result = await fetchMyTopics(page, MINE_PAGE_SIZE)
    // 刷新时当前页可能已经空了（题被删、总数变少）：退回最后一页，别停在一片
    // 空白上。page 严格递减，最多回溯到第 1 页，不会来回弹
    if (result.list.length === 0 && page > 1 && result.total > 0) {
      const lastPage = Math.max(1, Math.ceil(result.total / MINE_PAGE_SIZE))
      await loadMine(Math.min(lastPage, page - 1))
      return
    }
    mineItems.value = result.list
    mineTotal.value = result.total
    minePage.value = page
    mineLoaded.value = true
    // 顺手记下来：点「解析 / 纠错」时详情页直接从缓存取，不用再拉一次
    rememberTopics(result.list)
    // 摆好「收藏」按钮的初始状态；查失败不阻塞列表（按钮退回未收藏态）
    try {
      favoredCodes.value = await fetchFavoriteStatus(result.list.map((it) => String(it.exerciseCode)))
    } catch (err) {
      favoredCodes.value = new Set()
      console.warn('[SearchView] 收藏状态查询失败', err)
    }
    scrollBodyToTop()
  } catch (err) {
    mineError.value = describeError(err)
    showError(mineError.value)
  } finally {
    mineLoading.value = false
  }
}

/** 点「收藏 / 已收藏」：调后端 toggle 切换，成功后就地更新按钮状态 */
async function toggleFav(item: TopicItem): Promise<void> {
  const code = String(item.exerciseCode)
  if (favPending.has(code)) return
  favPending.add(code)
  try {
    const favored = await toggleFavorite(code)
    const next = new Set(favoredCodes.value)
    if (favored) next.add(code)
    else next.delete(code)
    favoredCodes.value = next
    // 不弹「已收藏 / 已取消收藏」提示：星标图标本身就换了，再弹一条是噪音
  } catch (err) {
    showError(describeError(err))
  } finally {
    favPending.delete(code)
  }
}

function onMinePageChange(page: number): void {
  void loadMine(page)
}

/** 手动刷新：留在当前页，别把用户翻回去第一页 */
function onMineRefresh(): void {
  void loadMine(minePage.value)
}

/* ── 两视图共用 ───────────────────────────────────────────────────────── */

function scrollBodyToTop(): void {
  if (bodyEl.value) bodyEl.value.scrollTop = 0
}

// 切视图：滚回顶部；线上习题第一次进来才拉数据（之后靠刷新 / 版本号）
watch(
  view,
  (next) => {
    scrollBodyToTop()
    if (next === 'mine' && !mineLoaded.value && !mineLoading.value) void loadMine(1)
  },
  { immediate: true }
)

// 刷新机制的另一半：录入 / 纠错成功后 bump 版本号，这里自动重拉当前页。
// 只在这个视图已经拉过数据之后才管 —— 从没打开过就不必为它打一次请求。
watch(topicsVersion, () => {
  if (mineLoaded.value) void loadMine(minePage.value)
})
</script>

<style scoped>
.container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  height: 100%;
}

/* 视图切换（检索题目 / 线上习题）：分段按钮，靠左与下面的检索栏对齐 */
.view-switch {
  flex: none;
  display: flex;
  flex-direction: row;
  gap: 4px;
  width: 100%;
  max-width: 850px;
  padding: 14px 10px 0;
}

.view-btn {
  height: 30px;
  padding: 0 14px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.view-btn:hover {
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-nav-hover, #f1f4f9);
}

.view-btn.is-active {
  color: var(--admin-primary, #2d8cf0);
  background: var(--admin-primary-weak, #e8f0fe);
  font-weight: 600;
}

/* 检索栏（ctbapp 的 .search_wrapper：输入框 + 检索按钮并排） */
.search_wrapper {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 850px;
  padding: 12px 10px;
}

.field-select,
.value-select,
.search-input {
  height: 40px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid gainsboro;
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  outline: none;
}

.field-select {
  flex: none;
  width: 110px;
}

.value-select,
.search-input {
  flex: 1 1 auto;
  min-width: 0;
}

/* ctbapp 的输入框是 480px 宽、40px 高，这里交给 flex 铺满同宽的检索栏 */
.search-input:focus,
.value-select:focus,
.field-select:focus {
  border-color: var(--admin-primary, #2d8cf0);
}

.search_btn {
  flex: none;
  height: 40px;
  padding: 0 26px;
  font-family: inherit;
  font-size: 14px;
  color: #fff;
  border: 1px solid var(--admin-primary, #2d8cf0);
  border-radius: 6px;
  background: var(--admin-primary, #2d8cf0);
  cursor: pointer;
}

.search_btn:hover:not(:disabled) {
  background: #2f74e0;
}

.search_btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 线上习题的工具条：左条数、右刷新，与卡片同宽（830px）对齐 */
.list-toolbar {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: 850px;
  padding: 12px 10px;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.refresh-btn {
  height: 26px;
  padding: 0 14px;
  font-family: inherit;
  font-size: 12px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
}

.refresh-btn:hover:not(:disabled) {
  color: var(--admin-primary, #2d8cf0);
  border-color: var(--admin-primary, #2d8cf0);
}

.refresh-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 结果区：850px 宽、可滚动（ctbapp 的 .search_body） */
.search_body {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  max-width: 850px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 10px;
  overflow: auto;
}

/* 这块 #editor 只为承接主题的 `#editor .ProseMirror …` 排版规则（外壳规则
   与 body.admin-panel-view #editor { display: none } 在这里压回去），
   与「题库管理」页同一写法 */
#admin-panel .search_body #editor.topic-list-host {
  display: block;
  position: static;
  width: 100%;
  height: auto;
  padding: 0;
  overflow: visible;
}

/* 分页条（检索视图是上一页/下一页，线上习题交给 Pagination） */
.page_part {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px 0 14px;
}

.page-btn {
  height: 30px;
  padding: 0 14px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
}

.page-btn:hover:not(:disabled) {
  color: var(--admin-primary, #2d8cf0);
  border-color: var(--admin-primary, #2d8cf0);
}

.page-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.page-info {
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.state {
  padding: 8px 0;
  font-size: 14px;
  color: var(--admin-text-weak, #8492a6);
}

.state.is-error {
  color: #e5534b;
  word-break: break-all;
}

/* 「收藏」在检索视图里没绑事件，不给可点的观感 */
.op.is-inert {
  cursor: default;
}

.op.is-inert:hover {
  color: inherit;
}

/* 线上习题视图的「收藏」：已收藏时主题色高亮，和普通操作区分开 */
.topic-list-host :deep(.op.is-favored) {
  color: var(--admin-primary, #2d8cf0);
}
</style>
