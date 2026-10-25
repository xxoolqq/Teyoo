<template>
  <!-- 检索题目（ctbapp 的 Search.vue 对位页），数据走 ElasticController 的
       /elastic/search/match/query.do。
       版式与「我录入的题」同款：一列居中、结果区 850px 宽自己滚、分页压底。 -->
  <div class="container">
    <!-- 检索条件：字段 + 值 + 按钮。字段决定「值」是输入框还是下拉 ——
         题号/科目/年级/难度在 ES 里是 keyword，match 等价精确匹配，只能选不能敲 -->
    <div class="search_wrapper">
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

    <!-- 注意这里刻意不用 v-if/v-else 串成一条链：检索中（loading）时结果区
         不卸载 —— 卡片一卸载，里面的 Milkdown 实例就跟着进回收站，下次还得
         整批重建。loading 只是多一行提示，旧结果原地留着。 -->
    <div ref="bodyEl" class="search_body">
      <p v-if="loading" class="state">检索中…</p>
      <p v-if="error && !loading" class="state is-error">{{ error }}</p>
      <p v-if="!searched && !loading" class="state">选择字段、填好内容后点「检索」</p>
      <p v-if="searched && items.length === 0 && !loading" class="state">没有匹配的题目</p>
      <template v-if="searched && items.length > 0">
        <!-- id="editor"：题干是 Milkdown 只读渲染，主题排版规则全写成
             `#editor .ProseMirror …`，得给它一个 #editor 祖先（同「我录入的题」页） -->
        <div id="editor" class="topic-list-host">
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
                <!-- 检索页的收藏是摆设（ctbapp 原版就没绑事件），一律画成未收藏 -->
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
    </div>

    <!-- 后端不返回 total，翻页只认「上一页 / 本页取满了就还有下一页」 -->
    <div v-if="searched" class="page_part">
      <button class="page-btn" type="button" :disabled="pageNum <= 1 || loading" @click="goPage(pageNum - 1)">
        上一页
      </button>
      <span class="page-info">第 {{ pageNum }} 页</span>
      <button class="page-btn" type="button" :disabled="!hasMore || loading" @click="goPage(pageNum + 1)">
        下一页
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import TopicCard from '../components/TopicCard.vue'
import { searchTopics, type SearchField, type TopicItem } from '../api/topics'
import { describeError, showError, showInfo } from '../stores/toast'
import { rememberTopics } from '../stores/topic-detail'
import { CLASS_LEVEL_OPTIONS } from '../utils/class-level'
import { COURSE_OPTIONS } from '../utils/course'
import { EASY_LEVELS } from '../utils/topic-meta'
import { canFixTopic, downloadTopic, goTopicDetail, goTopicFixError } from '../utils/topic-actions'
import iconJiexi from '../assets/jiexi.png'
import iconJiucuo from '../assets/jiucuo.png'
import iconFavNo from '../assets/weishoucang.png'
import iconDownload from '../assets/download.png'

// 后端默认 10、上限 50（ElasticController.MAX_PAGE_SIZE），这里取默认值
const PAGE_SIZE = 10

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

const router = useRouter()

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
      pageSize: PAGE_SIZE
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
    if (bodyEl.value) bodyEl.value.scrollTop = 0
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

/* 检索栏（ctbapp 的 .search_wrapper：输入框 + 检索按钮并排） */
.search_wrapper {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 850px;
  padding: 16px 10px 12px;
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
   与「我录入的题」页同一写法 */
#admin-panel .search_body #editor.topic-list-host {
  display: block;
  position: static;
  width: 100%;
  height: auto;
  padding: 0;
  overflow: visible;
}

/* 分页条（ctbapp 是 iView Page，这里只有上一页/下一页 + 页码） */
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

/* 「收藏」在原版里就没绑事件，这里也不给可点的观感 */
.op.is-inert {
  cursor: default;
}

.op.is-inert:hover {
  color: inherit;
}
</style>
