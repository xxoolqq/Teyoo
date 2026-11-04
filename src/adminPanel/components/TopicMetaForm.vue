<template>
  <!-- 附加信息：默认收起，只在提交条上占一个次级按钮。
       点开从右侧滑出抽屉，左半边编辑区保持可见 —— 录题时一边看题一边补元信息，
       不用再为这几项在页面底部长期租一块地方。点击抽屉外的空白处（或 Esc）收起。
       抽屉内部照「本地题库 → 录入新题目」弹窗的分类信息面板排：四列下拉 + 知识点选集。 -->
  <button class="meta-trigger" type="button" @click="open = true">
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2.8 4.6h10.4" />
      <path d="M2.8 8h10.4" />
      <path d="M2.8 11.4h6.2" />
    </svg>
    <span>附加信息</span>
    <span class="meta-count" :class="{ 'is-done': filledCount === TOTAL }">
      {{ filledCount }}/{{ TOTAL }}
    </span>
  </button>

  <Transition name="meta-drawer">
    <div v-if="open" class="drawer-layer" @click.self="open = false">
      <aside class="drawer" role="dialog" aria-label="附加信息">
        <header class="drawer-head">
          <div class="drawer-title">附加信息</div>
          <button class="drawer-close" type="button" aria-label="收起" @click="open = false">
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="m4.4 4.4 7.2 7.2" />
              <path d="m11.6 4.4-7.2 7.2" />
            </svg>
          </button>
        </header>

        <div class="drawer-body">
          <!-- 布局对齐「本地题库 → 录入新题目」弹窗的分类信息面板：
               一张白卡 + 标题行 + 字段网格，剩下的高度全给知识点。
               知识点从自由文本改成「按科目 + 学段查询的考点选择器」，与弹窗同一套交互。 -->
          <div class="panel">
            <h3 class="panel-title">
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M2.6 7.1V3.6a1 1 0 0 1 1-1h3.5l5.6 5.6a1 1 0 0 1 0 1.4l-3.1 3.1a1 1 0 0 1-1.4 0L2.6 7.1Z" />
                <circle cx="5.6" cy="5.6" r="0.9" />
              </svg>
              <span>分类信息</span>
            </h3>

            <div class="grid-4">
              <label class="field">
                <span>科目类别</span>
                <select v-model="meta.course" @change="onSubjectChange">
                  <option value="">未选择</option>
                  <option v-for="name in COURSES" :key="name" :value="name">{{ name }}</option>
                </select>
              </label>

              <!-- 学段只用于决定考点范围（key_points 按 course_code + class_level 两列筛），
                   入库仍用右边的年级码 —— 与「录入新题目」弹窗同一口径 -->
              <label class="field">
                <span>学段</span>
                <select v-model="meta.stage" @change="onStageChange">
                  <option value="">未选择</option>
                  <option v-for="item in STAGE_OPTIONS" :key="item.value" :value="item.value">
                    {{ item.label }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>适用年级</span>
                <select v-model="meta.classLevelName">
                  <option value="">未选择</option>
                  <option v-for="name in CLASS_LEVEL_NAMES" :key="name" :value="name">
                    {{ name }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>难易程度</span>
                <select v-model="meta.easy">
                  <option value="">未选择</option>
                  <option v-for="level in EASY_LEVELS" :key="level" :value="level">
                    {{ level }} 级
                  </option>
                </select>
              </label>
            </div>

            <!-- 知识点：已选考点在上，展开的候选面板吃掉余下高度 -->
            <div class="kp">
              <div class="kp-head">
                <span class="kp-label">知识点</span>
                <button type="button" class="kp-toggle" @click="toggleKpPanel">
                  {{ kpOpen ? '收起考点' : '选择知识点' }}
                </button>
                <span class="kp-status">{{
                  picked.length ? `已选 ${picked.length}/${KP_MAX}` : '未选择'
                }}</span>
              </div>

              <div v-if="picked.length" class="kp-chips">
                <button
                  v-for="point in picked"
                  :key="point.code || point.name"
                  type="button"
                  class="kp-chip"
                  :title="`移除「${point.name}」`"
                  @click="removePoint(point)"
                >
                  <span>{{ point.name }}</span>
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    aria-hidden="true"
                  >
                    <path d="m4.4 4.4 7.2 7.2" />
                    <path d="m11.6 4.4-7.2 7.2" />
                  </svg>
                </button>
              </div>

              <div v-if="kpOpen" class="kp-panel">
                <input
                  v-model="kpKeyword"
                  type="text"
                  class="kp-search"
                  placeholder="搜索知识点名称或编码…"
                />
                <div v-if="kpOptions.length" class="kp-options">
                  <button
                    v-for="option in kpOptions"
                    :key="option.code"
                    type="button"
                    class="kp-option"
                    :class="{ 'is-picked': isPicked(option) }"
                    @click="togglePoint(option)"
                  >
                    {{ option.name }}
                  </button>
                </div>
                <p v-else class="kp-empty">{{ kpEmptyText }}</p>
                <p v-if="kpOptions.length && kpMatched.length > KP_LIMIT" class="kp-empty">
                  命中 {{ kpMatched.length }} 条，先显示前 {{ KP_LIMIT }} 条，输入关键词可继续缩小
                </p>
              </div>
            </div>
          </div>
        </div>

        <footer class="drawer-foot">
          <span class="drawer-tip">收起后不会丢失已填内容</span>
          <button class="drawer-done" type="button" @click="open = false">完成</button>
        </footer>
      </aside>
    </div>
  </Transition>
</template>

<script setup lang="ts">
// 题单元信息：四项下拉（科目 / 学段 / 适用年级 / 难易程度）+ 知识点选择器。
// 结构与交互都照「本地题库 → 录入新题目」弹窗的分类信息面板：知识点点按钮展开
// 候选面板，候选按「科目 + 学段」从 key_points 里取。
//
// 做成独立组件是因为「纠错」页与这一页用的是同一套元信息（ctbapp 的 FixError.vue
// 与 CommitExercise.vue 就是同一份 RadioGroup），校验规则一起复用 utils/topic-meta.ts。
//
// 摆放方式也由组件自己负责：宿主只把 <TopicMetaForm v-model="meta" /> 放进提交条即可，
// 抽屉用绝对定位盖在宿主页面右侧 —— 所以宿主页面需要 position: relative。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showInfo } from '../stores/toast'
import { CLASS_LEVEL_NAMES, STAGE_OPTIONS } from '../utils/class-level'
import { COURSE_OPTIONS } from '../utils/course'
import { fetchKeyPoints, type KnowledgePointOption } from '../utils/question-bank'
import { COURSES, EASY_LEVELS, type TopicMeta } from '../utils/topic-meta'

// 表单值由页面持有：提交时要连着题目、答案一起打包，校验顺序也由页面统一决定
const meta = defineModel<TopicMeta>({ required: true })

const open = ref(false)

/** 五项：科目 / 学段 / 适用年级 / 难易程度 / 知识点 */
const TOTAL = 5

// 收起的按钮上也留一个进度：五项填了几项，扫一眼就知道还差什么
const filledCount = computed(() => {
  const value = meta.value
  return [
    value.course,
    value.stage,
    value.classLevelName,
    value.easy,
    value.knowledgePoints.trim()
  ].filter((item) => !!item).length
})

/**
 * 科目名 → 科目码（0000…0008）。
 *
 * 提交用的是中文名（ctbapp 口径），而 key_points 的 course_code 是四位码 —— 两套
 * 体系都要用，就在这里翻一次；映射表直接用 utils/course（与各页下拉同一份）。
 */
const COURSE_CODE_BY_NAME = new Map(COURSE_OPTIONS.map((item) => [item.label, item.value]))

// ── 知识点 ──────────────────────────────────────────────────────────────────

/**
 * 已选考点。
 *
 * 对外的真相仍是 meta.knowledgePoints 那一串文本（后端只要它）：这里维护一份
 * 「码 + 名」的数组，只是为了让候选面板认得出哪几个已经选过（同名考点在
 * key_points 里可能不止一条，只靠名字高亮会一起亮、一起删）。
 * 文本 ↔ 数组的同步走 syncFromText / applyPicked 这一对，两边都做相等判断防回环。
 */
interface PickedPoint {
  code: string
  name: string
}

const picked = ref<PickedPoint[]>([])
const kpOpen = ref(false)
const kpKeyword = ref('')
const kpLoading = ref(false)
const kpCatalog = ref<KnowledgePointOption[]>([])

/** 分隔规则与后端一致：空格、中英文逗号、顿号、分号都算（历史数据里有手填的） */
function splitPoints(text: string): string[] {
  return String(text ?? '')
    .split(/[\s,，、;；]+/)
    .filter(Boolean)
}

/** 文本 → 已选数组；码来自候选目录（回显的历史题只有名字，码留空、按名字匹配） */
function syncFromText(): void {
  const names = splitPoints(meta.value.knowledgePoints)
  const known = new Map(picked.value.filter((point) => point.code).map((point) => [point.name, point.code]))
  const next = names.map((name) => ({
    code: known.get(name) ?? kpCatalog.value.find((option) => option.name === name)?.code ?? '',
    name
  }))
  const same =
    next.length === picked.value.length &&
    next.every((point, index) => point.name === picked.value[index].name && point.code === picked.value[index].code)
  if (!same) picked.value = next
}

/** 已选数组 → 文本（写回后 watch 会再跑一次，值相同即停在相等判断上） */
function applyPicked(): void {
  const text = picked.value.map((point) => point.name).join(' ')
  if (text !== meta.value.knowledgePoints) meta.value.knowledgePoints = text
}

// 页面上直接改文本（纠错页回显、外部清空）时跟上；立即执行一次把初始值装进来
watch(() => meta.value.knowledgePoints, syncFromText, { immediate: true })
// 目录到货后补码：回显的 chips 一开始只有名字，拿到 key_points 才能对上编码
watch(kpCatalog, syncFromText)

/** 一次最多渲染 120 个按钮：761 条考点全铺出来，滚动和重排都会变涩 */
const KP_LIMIT = 120

/**
 * 一道题最多挂 6 个知识点。
 *
 * 只拦「新增」，不裁已有的：库里回显的老题可能早就超过 6 个，截断就成了静默改数据。
 * 满了之后点候选会弹提示，不会悄悄吞掉这一下点击。
 */
const KP_MAX = 6

/** 关键词命中的全部考点（不截断，只用来报总数） */
const kpMatched = computed(() => {
  const keyword = kpKeyword.value.trim()
  if (!keyword) return kpCatalog.value
  return kpCatalog.value.filter(
    (option) => option.name.includes(keyword) || option.code.includes(keyword)
  )
})

const kpOptions = computed(() => kpMatched.value.slice(0, KP_LIMIT))

const kpEmptyText = computed(() => {
  if (kpLoading.value) return '正在读取考点…'
  if (!meta.value.course) return '请先在上面选择科目'
  if (!meta.value.stage) return '请先在上面选择学段'
  if (!kpCatalog.value.length) return '该科目 · 学段下暂无考点'
  return '没有匹配的知识点'
})

/**
 * 拉考点：key_points 按 (course_code, class_level) 两列筛。
 * 科目或学段没定就不查 —— 不知道展开哪一支，查了也是空，还会把「没选」伪装成「没有」。
 */
async function loadKnowledge(): Promise<void> {
  const courseCode = COURSE_CODE_BY_NAME.get(meta.value.course) ?? ''
  const stage = meta.value.stage
  if (!courseCode || !stage) {
    kpCatalog.value = []
    return
  }
  kpLoading.value = true
  try {
    kpCatalog.value = await fetchKeyPoints(courseCode, stage)
  } finally {
    kpLoading.value = false
  }
}

function toggleKpPanel(): void {
  kpOpen.value = !kpOpen.value
  if (kpOpen.value) void loadKnowledge()
}

/**
 * 认「已选」优先认编码：key_points 里同名考点不止一条（不同层级 / 教材），
 * 只按名字比会把它们一起点亮、一起删掉。码为空的是回显的历史题，退回按名比。
 */
function isPicked(option: KnowledgePointOption): boolean {
  return picked.value.some((point) =>
    point.code ? point.code === option.code : point.name === option.name
  )
}

function togglePoint(option: KnowledgePointOption): void {
  if (isPicked(option)) {
    removePoint({ code: option.code, name: option.name })
    return
  }
  if (picked.value.length >= KP_MAX) {
    showInfo(`知识点最多选 ${KP_MAX} 个，先移除一个再选`)
    return
  }
  picked.value = [...picked.value, { code: option.code, name: option.name }]
  applyPicked()
}

function removePoint(point: PickedPoint): void {
  picked.value = picked.value.filter((item) =>
    point.code ? item.code !== point.code : item.name !== point.name
  )
  applyPicked()
}

/** 换科目 / 换学段：考点范围整批换，已选的清掉（与录入弹窗一致） */
function resetKnowledge(): void {
  picked.value = []
  kpCatalog.value = []
  kpKeyword.value = ''
  applyPicked()
}

function onSubjectChange(): void {
  resetKnowledge()
  if (kpOpen.value) void loadKnowledge()
}

function onStageChange(): void {
  resetKnowledge()
  if (kpOpen.value) void loadKnowledge()
}

// ── 抽屉开关 ────────────────────────────────────────────────────────────────

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false
}

watch(open, (isOpen) => {
  if (isOpen) window.addEventListener('keydown', onKeydown)
  else window.removeEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
/* 触发按钮：次级动作的规格 —— 描边、白底，与提交按钮同高并排 */
.meta-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  /* 与提交按钮（.btn 30px 高、内容盒 28px）齐平 */
  height: 30px;
  padding: 0 11px 0 12px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text);
  border: 1px solid var(--admin-border);
  border-radius: 6px;
  background: var(--admin-surface);
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}

.meta-trigger svg {
  flex: none;
  color: var(--admin-text-weak);
  transition: color 0.12s ease;
}

.meta-trigger:hover {
  color: var(--admin-primary);
  border-color: var(--admin-primary-weak);
  border-color: color-mix(in srgb, var(--admin-primary) 32%, transparent);
  background: var(--admin-primary-weak);
}

.meta-trigger:hover svg {
  color: var(--admin-primary);
}

/* 进度小胶囊：填满时点亮成主色，是"这题元信息齐了"唯一的视觉反馈 */
.meta-count {
  flex: none;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--admin-bg-soft);
  color: var(--admin-text-weak);
  font-size: 11px;
  line-height: 17px;
  font-variant-numeric: tabular-nums;
}

.meta-count.is-done {
  background: var(--admin-primary);
  color: #fff;
}

/* 抽屉层：绝对定位在宿主页面里（不是 fixed）—— 只盖住内容区，
   侧栏、页签、左半边编辑区都不受影响，正因为遮罩是透明的，
   左栏连颜色都不会变，只是点一下会被用来收起抽屉。

   overflow: hidden 是给滑入动画兜底：抽屉是从 translateX(100%) 滑进来的，
   那一截会留在层的右边界外。宿主右栏是 overflow: auto 的滚动容器，这份溢出
   会被算进它的 scrollWidth —— 横向滚动条一出现就压掉 6~8px 的高度，底部提交条
   跟着上移，看着就是「抽屉出来时页面跳一下」。裁在层里，外面一点都看不见，
   抽屉自己的投影（向左扩散）仍在层的范围内，不会被削。 */
.drawer-layer {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  justify-content: flex-end;
  overflow: hidden;
}

/* 784px = 原宽 392 的两倍：抽屉里是一屏表单，宽一点选项能横排成行，
   不必挤成三四行胶囊。窄窗口下仍给左栏留 56px 的活口。 */
.drawer {
  display: flex;
  flex-direction: column;
  width: 784px;
  max-width: calc(100% - 56px);
  height: 100%;
  background: var(--admin-surface);
  border-left: 1px solid var(--admin-border);
  box-shadow: -18px 0 40px rgba(15, 23, 42, 0.1);
}

.drawer-head {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 12px 18px;
  border-bottom: 1px solid var(--admin-border);
}

.drawer-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.drawer-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--admin-text-weak);
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.drawer-close:hover {
  color: var(--admin-text);
  background: var(--admin-hover);
}

/* 滚动区兼作灰槽：白卡浮在上面，与「录入新题目」弹窗的 surface + panel 同构。
   用 flex 让卡片自己填满，而不是 height:100% —— 后者加上 padding 会顶出一条滚动条。 */
.drawer-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px 16px 16px;
  overflow-y: auto;
  background: var(--admin-bg);
}

.drawer-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--admin-border);
}

.drawer-tip {
  color: var(--admin-text-weak);
  font-size: 11.5px;
}

.drawer-done {
  flex: none;
  height: 30px;
  padding: 0 16px;
  font-family: inherit;
  font-size: 13px;
  color: #fff;
  border: none;
  border-radius: 6px;
  background: var(--admin-primary);
  cursor: pointer;
  transition: filter 0.12s ease;
}

.drawer-done:hover {
  filter: brightness(1.06);
}

/* 分类信息面板：与「本地题库 → 录入新题目」弹窗的 .qe-panel 同一套规格
   （白卡、1px 淡边、大圆角、标题带图标），只是圆角按侧栏口径收到 14px */
.panel {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 16px;
  border: 1px solid var(--admin-border);
  border-radius: 14px;
  background: var(--admin-surface);
  box-sizing: border-box;
}

.panel-title {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  color: var(--admin-text);
  font-size: 14px;
  font-weight: 600;
}

.panel-title svg {
  flex: none;
  color: var(--admin-text-weak);
}

/* 四个字段压成一行：省下的纵向空间全部让给知识点 */
.grid-4 {
  flex: none;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.field > span {
  margin-bottom: 5px;
  color: var(--admin-text-weak);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.field select {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--admin-border);
  border-radius: 10px;
  background: var(--admin-bg-soft);
  color: var(--admin-text);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
}

.field select:hover {
  background: var(--admin-hover);
}

.field select:focus {
  outline: none;
  border-color: var(--admin-primary);
  box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.14);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--admin-primary) 14%, transparent);
}

/* 知识点：选择器面板吃掉面板剩下的全部高度（选择题比敲字更需要一眼看全） */
.kp {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.kp-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.kp-label {
  color: var(--admin-text-weak);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

/* 选择按钮的规格照录入弹窗的 .qe-kp-toggle：小、描边、hover 才染主色 */
.kp-toggle {
  padding: 4px 10px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  color: var(--admin-text);
  border: 1px solid var(--admin-border);
  border-radius: 8px;
  background: var(--admin-surface);
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}

.kp-toggle:hover {
  color: var(--admin-primary);
  border-color: color-mix(in srgb, var(--admin-primary) 32%, transparent);
  background: var(--admin-primary-weak);
}

/* 右边这行小字报个数：填了就说「已选 N 个」，空了就说「未选择」 */
.kp-status {
  color: var(--admin-text-weak);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* 已选考点：多到放不下时自己滚，别把下边的候选面板挤没 */
.kp-chips {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 92px;
  margin-bottom: 8px;
  overflow-y: auto;
}

.kp-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 4px 8px;
  font-family: inherit;
  font-size: 11px;
  color: var(--admin-primary);
  border: 1px solid color-mix(in srgb, var(--admin-primary) 28%, transparent);
  border-radius: 7px;
  background: var(--admin-primary-weak);
  cursor: pointer;
  overflow-wrap: anywhere;
}

.kp-chip svg {
  flex: none;
  color: var(--admin-text-weak);
}

.kp-chip:hover svg {
  color: #ef4444;
}

/* 候选面板：搜索框钉在顶部，选项区吃掉余下高度并自己滚 */
.kp-panel {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px;
  border: 1px solid var(--admin-border);
  border-radius: 10px;
  background: var(--admin-bg-soft);
}

.kp-search {
  flex: none;
  width: 100%;
  height: 34px;
  margin-bottom: 8px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--admin-text);
  border: 1px solid var(--admin-border);
  border-radius: 9px;
  background: var(--admin-surface);
  box-sizing: border-box;
}

.kp-search::placeholder {
  color: var(--admin-text-weak);
}

/* 只换边线与光晕：改底色会让深色下的输入框和卡片同色，"边界"反而消失 */
.kp-search:focus {
  outline: none;
  border-color: var(--admin-primary);
  box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.14);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--admin-primary) 14%, transparent);
}

.kp-options {
  flex: 1 1 auto;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 6px;
  min-height: 0;
  overflow-y: auto;
}

.kp-option {
  padding: 4px 8px;
  font-family: inherit;
  font-size: 11.5px;
  text-align: left;
  color: var(--admin-text);
  border: 1px solid var(--admin-border);
  border-radius: 7px;
  background: var(--admin-surface);
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}

.kp-option:hover {
  color: var(--admin-primary);
  border-color: color-mix(in srgb, var(--admin-primary) 32%, transparent);
}

.kp-option.is-picked {
  color: var(--admin-primary);
  border-color: color-mix(in srgb, var(--admin-primary) 48%, transparent);
  background: var(--admin-primary-weak);
  font-weight: 600;
}

.kp-empty {
  margin: 0;
  padding: 6px 2px;
  color: var(--admin-text-weak);
  font-size: 11.5px;
}

/* 滑入：位移交给抽屉本身，淡入交给整层 */
.meta-drawer-enter-active,
.meta-drawer-leave-active {
  transition: opacity 0.18s ease;
}

.meta-drawer-enter-active .drawer,
.meta-drawer-leave-active .drawer {
  transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.meta-drawer-enter-from,
.meta-drawer-leave-to {
  opacity: 0;
}

.meta-drawer-enter-from .drawer,
.meta-drawer-leave-to .drawer {
  transform: translateX(100%);
}
</style>
