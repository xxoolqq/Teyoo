<template>
  <!-- 版式与「我录入的题」同一副：一列居中、850px 宽、自己滚动、分页压底，
       卡片共用 TopicCard。收藏页多两件事：
       1) 每张卡可勾选，工具栏把勾选的题目合并成一份 md 下载；
       2) 卡片上的「收藏」在两页里是摆设，在这里是「取消收藏」——点了调后端
          toggle 后从列表移除当前题。 -->
  <div class="container">
    <div class="search_body">
      <div class="list-toolbar">
        <span class="count">共 {{ total }} 条<template v-if="selectedCodes.size > 0">，已选 {{ selectedCodes.size }}/{{ MAX_MERGE }} 题</template></span>
        <span class="toolbar-ops">
          <!-- 类名别用 .toolbar-btn：那是编辑器工具栏的全局类（base.css 里
               width: 28px / padding: 0 的图标按钮），撞上就会被钉成 28px 宽，
               文字直接横穿边框（"下载合并md" 那种错位就是这么来的）。 -->
          <button class="merge-btn" type="button" :disabled="loading || selectedCodes.size === 0" @click="downloadMerged">
            下载合并md
          </button>
          <button class="refresh-btn" type="button" :disabled="loading" @click="onRefresh">
            刷新
          </button>
        </span>
      </div>
      <p v-if="loading" class="state">加载中…</p>
      <p v-else-if="error" class="state is-error">{{ error }}</p>
      <template v-else>
        <p v-if="items.length === 0" class="state">还没有收藏过题目</p>
        <!-- id="editor"：与「我录入的题」同一招，给主题的 #editor 排版规则一个锚点 -->
        <div id="editor" class="topic-list-host">
          <!-- 选中态的边框高亮靠 class 直通到 TopicCard 根元素（Vue 的 attrs
               fallthrough），不用动共用组件 -->
          <TopicCard
            v-for="item in items"
            :key="item.exerciseCode"
            :class="{ 'is-selected': selectedCodes.has(String(item.exerciseCode)) }"
            :item="item"
          >
            <template #actions>
              <span class="op" @click="goTopicDetail(router, item, LIST_PAGE_MY_FAVORITES)">
                <img :src="iconJiexi" alt="" />
                <span>解析</span>
              </span>
              <span class="op" @click="goTopicFixError(router, item, LIST_PAGE_MY_FAVORITES)">
                <img :src="iconJiucuo" alt="" />
                <span>纠错</span>
              </span>
              <span class="op" title="从收藏中移除" @click="removeFavorite(item)">
                <!-- 这一页的题都是已收藏的，用实心星 -->
                <img :src="iconFavYes" alt="" />
                <span>取消收藏</span>
              </span>
              <span class="op" @click="downloadTopic(item)">
                <img :src="iconDownload" alt="" />
                <span>下载</span>
              </span>
              <span class="op is-select" @click="toggleSelect(item)">
                <img :src="iconCollate" alt="" />
                <span>{{ selectedCodes.has(String(item.exerciseCode)) ? '已选' : '选择' }}</span>
              </span>
              <!-- 收藏时间给个只读展示，方便按收藏先后整理下载清单 -->
              <span class="fav-time">{{ formatTime(item.favoriteTime) }}</span>
            </template>
          </TopicCard>
        </div>
      </template>
    </div>

    <div class="page_part">
      <Pagination
        :total="total"
        :page-num="pageNum"
        :page-size="PAGE_SIZE"
        @change="onPageChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Pagination from '../components/Pagination.vue'
import TopicCard from '../components/TopicCard.vue'
import { fetchFavorites, type FavoriteItem } from '../api/favorites'
import { describeError, showError, showSuccess } from '../stores/toast'
import { rememberTopics } from '../stores/topic-detail'
import { LIST_PAGE_MY_FAVORITES, downloadTopic, goTopicDetail, goTopicFixError, topicCode } from '../utils/topic-actions'
import { toggleFavorite } from '../api/favorites'
import iconJiexi from '../assets/jiexi.png'
import iconJiucuo from '../assets/jiucuo.png'
import iconCollate from '../assets/collate.png'
import iconFavYes from '../assets/yishoucang.png'
import iconDownload from '../assets/download.png'

const PAGE_SIZE = 5

/** 合并下载的单次题数上限：勾选时硬限制，超了选不进去（下载动作本身不产生网络请求，纯前端拼接） */
const MAX_MERGE = 20

const router = useRouter()

const items = ref<FavoriteItem[]>([])
const total = ref(0)
const pageNum = ref(1)
const loading = ref(false)
const error = ref('')

/** 已勾选题目的题号集合（跨页翻页时保留勾选，下载合并时一并带上） */
const selectedCodes = ref(new Set<string>())

async function load(page: number): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await fetchFavorites(page, PAGE_SIZE)
    // 当前页因取消收藏变空时退回最后一页，与「我录入的题」同一处理
    if (result.list.length === 0 && page > 1 && result.total > 0) {
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
      await load(Math.min(lastPage, page - 1))
      return
    }
    items.value = result.list as FavoriteItem[]
    total.value = result.total
    pageNum.value = page
    // 详情 / 纠错页的缓存：从这页点进去就不用再拉一次
    rememberTopics(result.list)
    // 勾选集合清掉已不在收藏里的题号（下载合并只对现存条目生效）
    const alive = new Set(result.list.map((it) => topicCode(it)))
    for (const code of selectedCodes.value) {
      if (!alive.has(code)) selectedCodes.value.delete(code)
    }
  } catch (err) {
    error.value = describeError(err)
    showError(error.value)
  } finally {
    loading.value = false
  }
}

function onPageChange(page: number): void {
  void load(page)
}

function onRefresh(): void {
  void load(pageNum.value)
}

/** 勾选 / 取消勾选：合并下载的选题开关。已选满 20 题时勾不进去，直接提示 */
function toggleSelect(item: FavoriteItem): void {
  const code = topicCode(item)
  const next = new Set(selectedCodes.value)
  if (next.has(code)) {
    next.delete(code)
  } else {
    if (next.size >= MAX_MERGE) {
      showError(`每次最多合并 ${MAX_MERGE} 道题，请先取消部分勾选`)
      return
    }
    next.add(code)
  }
  // Set 的响应式替换：重新赋值一个新 Set，免得依赖 deep 监听的组件漏更新
  selectedCodes.value = next
}

/** 取消收藏：调后端 toggle，成功后把这道题从当前页移除（不整页重刷，位置不跳） */
async function removeFavorite(item: FavoriteItem): Promise<void> {
  const code = topicCode(item)
  try {
    await toggleFavorite(code)
  } catch (err) {
    showError(describeError(err))
    return
  }
  // 不弹提示：卡片直接从列表里消失，本身就是最清楚的反馈
  selectedCodes.value = new Set([...selectedCodes.value].filter((c) => c !== code))
  // 本页还有剩：原地移除并改计数；本页被清空：回到最后一页（load 里自会回退）
  const rest = items.value.filter((it) => topicCode(it) !== code)
  if (rest.length > 0) {
    items.value = rest
    total.value = Math.max(0, total.value - 1)
  } else {
    void load(pageNum.value)
  }
}

/** 把勾选的题目拼成一份 md 下载：每题「题号 + 题干 + 答案」，题间用分隔线隔开 */
function downloadMerged(): void {
  const picked = items.value.filter((it) => selectedCodes.value.has(topicCode(it)))
  if (picked.length === 0) return
  const parts: string[] = ['# 收藏习题合并']
  for (const it of picked) {
    parts.push(
      `## 题号${topicCode(it)}`,
      String(it.subjectSelf ?? '').trim(),
      '**答案**',
      String(it.answerSelf ?? '').trim(),
      '---'
    )
  }
  const blob = new Blob([parts.join('\n\n')], { type: 'text/markdown' })
  const objectURL = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectURL
  anchor.download = `favorites-${dateStamp()}.md`
  anchor.click()
  URL.revokeObjectURL(objectURL)
  showSuccess(`已下载 ${picked.length} 题的合并 md`)
}

/** 收藏时间的展示格式：拿得到就 yyyy-MM-dd，拿不到就空着 */
function formatTime(value?: string): string {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dateStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

onMounted(() => {
  void load(1)
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

/* 题目区：850px 宽、可滚动（与「我录入的题」一致） */
.search_body {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  max-width: 850px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 16px 10px 0;
  overflow: auto;
}

/* 顶部工具条：左边条数/已选数，右边合并下载 + 刷新 */
.list-toolbar {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  max-width: 830px;
  padding: 0 0 12px;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

/* 左侧计数：超长省略（正常不会超，兜底），别把右侧按钮挤窄 */
.count {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 右侧操作组：整体不被压缩，按钮保持横向文字 */
.toolbar-ops {
  flex: none;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.refresh-btn,
.merge-btn {
  flex: none;
  /* width: auto 必须显式写：base.css 里 .toolbar-btn 那套图标按钮是
     width: 28px + padding: 0，同名类一旦被别处借用就会把按钮钉成方框、
     文字横穿边框。这里给一条兜底，宽度永远由内容决定 */
  width: auto;
  white-space: nowrap;
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

.merge-btn {
  color: var(--admin-primary, #2d8cf0);
  border-color: var(--admin-primary, #2d8cf0);
}

.refresh-btn:hover:not(:disabled),
.merge-btn:hover:not(:disabled) {
  color: var(--admin-primary, #2d8cf0);
  border-color: var(--admin-primary, #2d8cf0);
}

.refresh-btn:disabled,
.merge-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 与「我录入的题」同一副外壳复位（承接主题的 #editor 排版规则） */
#admin-panel .search_body #editor.topic-list-host {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: static;
  width: 100%;
  height: auto;
  padding: 0;
  overflow: visible;
}

/* 勾选中的卡片：TopicCard 根元素收到 class 直通（attrs fallthrough），
   给一圈主题色边框作为选中态 */
.topic-list-host :deep(.topic-card.is-selected) {
  border: 1px solid var(--admin-primary, #2d8cf0);
  box-shadow: 0 0 0 1px var(--admin-primary, #2d8cf0) inset;
}

.page_part {
  flex: none;
  display: flex;
  flex-direction: row;
  width: 100%;
  justify-content: center;
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

/* 「选择」操作：与普通操作同款样式，选中时文字跟主题色 */
.op.is-select {
  color: inherit;
}

.topic-list-host :deep(.topic-card.is-selected) .op.is-select {
  color: var(--admin-primary, #2d8cf0);
}

/* 收藏时间：灰色小字，不响应点击 */
.fav-time {
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
  cursor: default;
  user-select: none;
}
</style>
