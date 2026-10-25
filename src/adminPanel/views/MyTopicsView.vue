<template>
  <!-- 版式照 ctbapp 的 MyTopic.vue：一列居中，题目区 850px 宽、自己滚动，
       分页压在底部。卡片长什么样由 TopicCard 决定（两页共用同一张卡）。 -->
  <div class="container">
    <div class="search_body">
      <!-- 刷新机制的一半：手动按钮。另一半在 script 里 —— watch topicsVersion，
           录入 / 纠错成功后自动重拉，人不在这个标签页也照刷 -->
      <div class="list-toolbar">
        <span class="count">共 {{ total }} 条</span>
        <button class="refresh-btn" type="button" :disabled="loading" @click="onRefresh">
          刷新
        </button>
      </div>
      <p v-if="loading" class="state">加载中…</p>
      <p v-else-if="error" class="state is-error">{{ error }}</p>
      <template v-else>
        <p v-if="items.length === 0" class="state">还没有录入过题目</p>
        <!-- 卡片上的四个操作与 ctbapp 一字不差：解析 / 纠错 / 收藏 / 下载。
             前两个在面板顶部开一个新标签页显示（原 ctbapp 是 window.open），
             收藏接的是后端 favorite/toggle.do：点击切换收藏状态，
             列表加载时用 status 批量查询摆好初始状态。 -->
        <!-- id="editor"：卡片里的题干是 Milkdown 只读渲染，主题的排版规则全写成
             `#editor .ProseMirror …`（base.css 一百多处），得给它们一个 #editor
             祖先才不变成裸文本（与录入页同一招，外壳规则在下面 CSS 里复位） -->
        <div id="editor" class="topic-list-host">
          <TopicCard v-for="item in items" :key="item.exerciseCode" :item="item">
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

    <!-- 分页：与后端 PageHelper 对齐（pageNum 从 1 起算，返回 total） -->
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
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Pagination from '../components/Pagination.vue'
import TopicCard from '../components/TopicCard.vue'
import { fetchMyTopics, type TopicItem } from '../api/topics'
import { fetchFavoriteStatus, toggleFavorite } from '../api/favorites'
import { describeError, showError } from '../stores/toast'
import { rememberTopics } from '../stores/topic-detail'
import { topicsVersion } from '../stores/topic-events'
import { LIST_PAGE_MY_TOPIC, downloadTopic, goTopicDetail, goTopicFixError } from '../utils/topic-actions'
import iconJiexi from '../assets/jiexi.png'
import iconJiucuo from '../assets/jiucuo.png'
import iconFavNo from '../assets/weishoucang.png'
import iconFavYes from '../assets/yishoucang.png'
import iconDownload from '../assets/download.png'

// ctbapp 的 MyTopic 每页 5 条；这里保持它自己的默认值（原文件 page.pageSize=5）
const PAGE_SIZE = 5

const router = useRouter()

const items = ref<TopicItem[]>([])
const total = ref(0)
const pageNum = ref(1)
const loading = ref(false)
const error = ref('')

/** 本页已收藏的题号集合：卡片上「收藏」按钮的初始状态（status 批量查询） */
const favoredCodes = ref(new Set<string>())
/** 正在切换收藏的题号：请求进行中忽略重复点击 */
const favPending = new Set<string>()

async function load(page: number): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await fetchMyTopics(page, PAGE_SIZE)
    // 刷新时当前页可能已经空了（题被删、总数变少）：退回最后一页，别停在一片
    // 空白上。page 严格递减，最多回溯到第 1 页，不会来回弹
    if (result.list.length === 0 && page > 1 && result.total > 0) {
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
      await load(Math.min(lastPage, page - 1))
      return
    }
    items.value = result.list
    total.value = result.total
    pageNum.value = page
    // 顺手记下来：点「解析 / 纠错」时详情页直接从缓存取，不用再拉一次
    rememberTopics(result.list)
    // 摆好「收藏」按钮的初始状态；查失败不阻塞列表（按钮退回未收藏态）
    try {
      favoredCodes.value = await fetchFavoriteStatus(result.list.map((it) => String(it.exerciseCode)))
    } catch (err) {
      favoredCodes.value = new Set()
      console.warn('[MyTopicsView] 收藏状态查询失败', err)
    }
  } catch (err) {
    error.value = describeError(err)
    showError(error.value)
  } finally {
    loading.value = false
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

function onPageChange(page: number): void {
  void load(page)
}

/** 手动刷新：留在当前页，别把用户翻回去第一页 */
function onRefresh(): void {
  void load(pageNum.value)
}

// 刷新机制的另一半：录入 / 纠错成功后 bump 版本号，这里自动重拉当前页。
// 页面被 KeepAlive 缓存着、人还在别的标签页时也照刷 —— 切回来看到的就是新的。
watch(topicsVersion, () => {
  void load(pageNum.value)
})

// 解析 / 纠错 / 下载三个操作与「检索题目」页共用一份实现（utils/topic-actions），
// 两页只在「纠错前要不要查权限」上不同：这里的题都是自己的，不用查。

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

/* 题目区：850px 宽、可滚动（ctbapp 的 .search_body） */
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

/* 顶部工具条：左边条数、右边刷新。与卡片同宽（830px）对齐 */
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

/* 这块 #editor 只为承接主题的 `#editor .ProseMirror …` 排版规则而存在，
   外壳规则（base.css #editor 的固定高度 / 40px 内边距）和
   body.admin-panel-view #editor { display: none } 都要在这里压回去。
   选择器带两个 id 才压得过主题那两条（与录入页 #editor.put-body 同一写法） */
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

/* 分页条：固定在底部居中（ctbapp 是 absolute bottom，这里用 flex 收尾，
   免得面板高度变化时压住最后一张卡） */
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

/* 已收藏的「收藏」操作：主题色高亮，和普通操作区分开 */
.topic-list-host :deep(.op.is-favored) {
  color: var(--admin-primary, #2d8cf0);
}
</style>
