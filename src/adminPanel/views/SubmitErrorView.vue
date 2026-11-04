<template>
  <!-- 我的 → 提交错题（左右两栏）。
       左栏：孩子所在班级里已发布（status=1）的编码映射，列表版式照「编码映射」页，
             每条右侧一个「去提交」；
       右栏：该映射下的每道题（题号 + 题码 + 题干），每道题一个可选中的按钮，
             勾完点「提交所选」走 CTBRedisPutController.submitSubjects 批量提交。
       顶层那条是提交要带的学生资料（后端逐项校验，缺一项整批拒绝）。
       旧版「手输题码」的单页实现已停用，备份在 SubmitErrorView.old.vue.txt。 -->
  <div class="se-page">
    <!-- 提交对象：孩子 + 后端要的学校代码 / 年级 / 城市（选孩子后自动带出，可改） -->
    <header class="se-bar">
      <label class="bar-field is-child">
        <span class="bar-label">孩子</span>
        <select v-model="childCode" class="ctl" :disabled="childrenLoading || children.length === 0">
          <option value="" disabled>{{ childrenLoading ? '加载中…' : '请选择孩子' }}</option>
          <option v-for="child in children" :key="child.childCode" :value="child.childCode">
            {{ child.studentName }}（{{ child.childCode }}）
          </option>
        </select>
      </label>

      <label class="bar-field">
        <span class="bar-label">学校代码</span>
        <input
          v-model.trim="form.schoolCode"
          class="ctl is-narrow"
          type="text"
          maxlength="6"
          placeholder="4~6 位数字"
        />
      </label>

      <label class="bar-field">
        <span class="bar-label">年级</span>
        <select v-model="form.classLevel" class="ctl is-narrow">
          <option value="">未选择</option>
          <option v-for="level in CLASS_LEVEL_OPTIONS" :key="level.value" :value="level.value">
            {{ level.label }}
          </option>
        </select>
      </label>

      <label class="bar-field">
        <span class="bar-label">城市</span>
        <select v-model="form.city" class="ctl is-narrow">
          <option value="">未选择</option>
          <option v-for="city in cityOptions" :key="city.value" :value="city.value">
            {{ city.label }}
          </option>
        </select>
      </label>

      <span v-if="!childrenLoading && children.length === 0" class="bar-hint">
        还没有关联孩子，先到「我的 → 关联孩子」添加
        <button class="link-btn" type="button" @click="goMyChild">去添加</button>
      </span>

      <!-- 右上角：手输题码的批量提交（旧版页面的能力）收进抽屉，
           不占左右两栏的位置，点开才从右侧滑出。 -->
      <div class="bar-actions">
        <button class="manual-btn" type="button" @click="drawerOpen = true">自主批量提交</button>
      </div>
    </header>

    <div class="se-split">
      <!-- 左：班级里已发布的编码映射 -->
      <section class="pane">
        <div class="pane-head">
          <span class="pane-title">班级发布的编码映射</span>
          <span class="pane-count">共 {{ total }} 条</span>
        </div>

        <div class="pane-body">
          <p v-if="!childCode" class="state">先在上面选择一个孩子</p>
          <p v-else-if="listLoading" class="state">加载中…</p>
          <p v-else-if="listError" class="state is-error">{{ listError }}</p>
          <template v-else>
            <p v-if="mappings.length === 0" class="state">
              孩子所在班级还没有已发布的编码映射
            </p>
            <ul v-else class="map-list">
              <li
                v-for="item in mappings"
                :key="item.surveyId"
                class="map-item"
                :class="{ 'is-active': item.surveyId === activeId }"
              >
                <div class="map-main">
                  <div class="map-head">
                    <span class="map-name" :title="item.title">{{ item.title || '未命名映射' }}</span>
                    <span class="map-badge">已发布</span>
                  </div>
                  <div class="map-meta">
                    <span class="meta-cell">
                      <span class="meta-label">班级</span>{{ item.className || '班级已删除' }}
                    </span>
                    <span class="meta-dot"></span>
                    <span class="meta-cell">
                      <span class="meta-label">题码</span>{{ item.itemCount ?? item.items?.length ?? 0 }} 对
                    </span>
                  </div>
                </div>
                <button
                  class="go-btn"
                  type="button"
                  :class="{ 'is-on': item.surveyId === activeId }"
                  @click="openMapping(item)"
                >
                  {{ item.surveyId === activeId ? '已选' : '去提交' }}
                </button>
              </li>
            </ul>
          </template>
        </div>

        <div class="pane-foot">
          <Pagination
            :total="total"
            :page-num="pageNum"
            :page-size="PAGE_SIZE"
            @change="onPageChange"
          />
        </div>
      </section>

      <!-- 右：选中映射下的题目 + 可选中按钮 -->
      <section class="pane">
        <div class="pane-head">
          <span class="pane-title">{{ active ? active.title : '题目' }}</span>
          <span class="pane-count">已选 {{ selected.length }} / {{ MAX_COUNT }}</span>
        </div>

        <div class="pane-body">
          <p v-if="!active" class="state">从左侧点「去提交」，这里会列出该映射的每一道题</p>
          <template v-else>
            <p class="quest-tip">
              勾选这次要提交的题目，单次最多 {{ MAX_COUNT }} 道；同一道题重复提交只会累加次数。
            </p>
            <p v-if="quests.length === 0" class="state">这份映射还没有题码</p>
            <ul v-else class="quest-list">
              <li v-for="(quest, index) in quests" :key="quest.code" class="quest-item">
                <button
                  class="pick-btn"
                  type="button"
                  :class="{ 'is-on': isSelected(quest.code) }"
                  :aria-pressed="isSelected(quest.code)"
                  @click="toggle(quest.code)"
                >
                  <span class="pick-dot" aria-hidden="true"></span>
                  {{ isSelected(quest.code) ? '已选' : '选择' }}
                </button>
                <div class="quest-main">
                  <div class="quest-head">
                    <span class="quest-no">第 {{ quest.sortNo || index + 1 }} 题</span>
                    <span class="quest-code">{{ quest.code }}</span>
                  </div>
                  <!-- 题干是后端渲染好的 HTML，与「题目详情」页同一套口径，前端不做解析 -->
                  <div v-if="quest.html" class="quest-html" v-html="quest.html"></div>
                  <p v-else-if="quest.loading" class="quest-muted">题目内容加载中…</p>
                  <p v-else class="quest-muted">题目内容暂不可用，提交时按题码记</p>
                </div>
              </li>
            </ul>
          </template>
        </div>

        <div class="pane-foot is-actions">
          <button class="btn" type="button" :disabled="!canSubmit" @click="submit">
            {{ submitting ? '提交中…' : '提交所选' }}
          </button>
          <button
            class="btn ghost"
            type="button"
            :disabled="submitting || selected.length === 0"
            @click="selected = []"
          >
            清空选择
          </button>
          <span v-if="blockedReason" class="blocked">{{ blockedReason }}</span>
        </div>
      </section>
    </div>

    <!-- 自主批量提交：手输题码的入口（旧版「提交错题」单页的能力）。
         复用页面上已选的孩子与学校代码 / 年级 / 城市，只多一个班级下拉，
         提交仍走 CTBRedisPutController.submitSubjects，一次最多 10 个题码。 -->
    <Transition name="se-drawer">
      <div v-if="drawerOpen" class="drawer-layer" @click.self="drawerOpen = false">
        <aside class="drawer" role="dialog" aria-label="自主批量提交">
          <header class="drawer-head">
            <div class="drawer-title">自主批量提交</div>
            <button class="drawer-close" type="button" aria-label="收起" @click="drawerOpen = false">
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
            <!-- 提交对象：孩子与页面共用，班级只在这里用（映射里的 classCode 已经自带） -->
            <section class="drawer-card">
              <h3 class="drawer-card-title">提交对象</h3>
              <p class="drawer-card-sub">
                与页面上方的孩子、学校代码、年级、城市是同一份资料，改了这边那边跟着变。
              </p>

              <div class="form-grid">
                <label class="field">
                  <span class="field-label">孩子</span>
                  <select
                    v-model="childCode"
                    class="ctl"
                    :disabled="childrenLoading || children.length === 0"
                  >
                    <option value="" disabled>
                      {{ childrenLoading ? '加载中…' : '请选择孩子' }}
                    </option>
                    <option v-for="child in children" :key="child.childCode" :value="child.childCode">
                      {{ child.studentName }}（{{ child.childCode }}）
                    </option>
                  </select>
                </label>

                <label class="field">
                  <span class="field-label">班级</span>
                  <select
                    v-model="manualClassCode"
                    class="ctl"
                    :disabled="!childCode || joinedClasses.length === 0"
                    @change="onManualClassChange"
                  >
                    <option value="">未加入班级</option>
                    <option v-for="cls in joinedClasses" :key="cls.classCode" :value="cls.classCode">
                      {{ cls.className }}
                    </option>
                  </select>
                </label>

                <label class="field">
                  <span class="field-label">学校代码</span>
                  <input
                    v-model.trim="form.schoolCode"
                    class="ctl"
                    type="text"
                    maxlength="6"
                    placeholder="4~6 位数字"
                  />
                </label>

                <label class="field">
                  <span class="field-label">年级</span>
                  <select v-model="form.classLevel" class="ctl">
                    <option value="">未选择</option>
                    <option v-for="level in CLASS_LEVEL_OPTIONS" :key="level.value" :value="level.value">
                      {{ level.label }}
                    </option>
                  </select>
                </label>

                <label class="field">
                  <span class="field-label">城市</span>
                  <select v-model="form.city" class="ctl">
                    <option value="">未选择</option>
                    <option v-for="city in cityOptions" :key="city.value" :value="city.value">
                      {{ city.label }}
                    </option>
                  </select>
                </label>
              </div>

              <p v-if="!childrenLoading && children.length === 0" class="hint">
                还没有关联孩子，先到「我的 → 关联孩子」添加
                <button class="link-btn" type="button" @click="goMyChild">去添加</button>
              </p>
            </section>

            <!-- is-fill：这张卡吃掉抽屉剩余高度，题码框再撑满整张卡 -->
            <section class="drawer-card is-fill">
              <div class="drawer-card-head">
                <h3 class="drawer-card-title">题码</h3>
                <span class="counter" :class="{ 'is-over': manualParsed.list.length > MAX_COUNT }">
                  {{ manualParsed.list.length }} / {{ MAX_COUNT }}
                </span>
              </div>
              <p class="drawer-card-sub">
                空格、换行、逗号都可以分隔，重复的题码会自动去重；同一道题重复提交只累加次数。
              </p>

              <textarea
                v-model="manualRaw"
                class="ctl codes"
                rows="8"
                placeholder="例如：100001 100002&#10;一行一个也行"
              ></textarea>

              <p v-if="manualParsed.invalid.length > 0" class="warn">
                有 {{ manualParsed.invalid.length }} 个不是 6~8 位数字，提交时会跳过：{{
                  manualParsed.invalid.join('、')
                }}
              </p>
            </section>
          </div>

          <footer class="drawer-foot">
            <span v-if="manualBlocked" class="blocked">{{ manualBlocked }}</span>
            <span v-else class="drawer-tip">不存在的题码会被后端跳过</span>
            <div class="foot-actions">
              <button
                class="btn ghost"
                type="button"
                :disabled="manualSubmitting || !manualRaw"
                @click="manualRaw = ''"
              >
                清空题码
              </button>
              <button class="btn" type="button" :disabled="!canManualSubmit" @click="submitManual">
                {{ manualSubmitting ? '提交中…' : '提交' }}
              </button>
            </div>
          </footer>
        </aside>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Pagination from '../components/Pagination.vue'
import {
  fetchChildDetail,
  fetchChildJoinedClasses,
  fetchMyChildren,
  type ChildItem,
  type JoinedChildClass
} from '../api/children'
import { fetchChildPublishedMappings, type SurveyMappingRow, type SurveyMappingItem } from '../api/surveys'
import { fetchTopicByCode } from '../api/topics'
import { SUBMIT_MAX_COUNT, submitSubjects } from '../api/wrongbook'
import { CLASS_LEVEL_OPTIONS } from '../utils/class-level'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

const MAX_COUNT = SUBMIT_MAX_COUNT
/** 左栏一页几条：与编码映射页一致 */
const PAGE_SIZE = 10

/** 城市下拉：与「关联孩子」页同一口径（后端 checkCity 只认 6 位行政区划码） */
const CITIES: { value: string; label: string }[] = [{ value: '371300', label: '临沂市' }]

const router = useRouter()

const children = ref<ChildItem[]>([])
const childrenLoading = ref(false)
const childCode = ref('')
const joinedClasses = ref<JoinedChildClass[]>([])

/** 提交时要带的三项资料：选孩子后自动带出，允许手动改 */
const form = reactive({
  schoolCode: '',
  classLevel: '',
  city: ''
})

/** 城市下拉：孩子详情里的城市不在预置列表时补一项显示原码，别让下拉空着 */
const cityOptions = computed<{ value: string; label: string }[]>(() => {
  if (form.city && !CITIES.some((city) => city.value === form.city)) {
    return [...CITIES, { value: form.city, label: form.city }]
  }
  return CITIES
})

// ── 左栏：班级里已发布的编码映射 ─────────────────────────────────────────

const mappings = ref<SurveyMappingRow[]>([])
const total = ref(0)
const pageNum = ref(1)
const listLoading = ref(false)
const listError = ref('')

// ── 右栏：当前映射的题目 + 勾选 ─────────────────────────────────────────

const activeId = ref<number | null>(null)
const active = computed(
  () => mappings.value.find((one) => one.surveyId === activeId.value) ?? null
)
const selected = ref<string[]>([])
const submitting = ref(false)

/** 题干的三种状态分开存：按题码缓存，切映射再切回来不用重拉 */
const topicHtml = ref<Record<string, string>>({})
const topicLoading = ref<Record<string, boolean>>({})
const topicFailed = ref<Record<string, boolean>>({})

/** 当前映射的题目：题号 + 题码 + 题干（题干异步补上） */
const quests = computed(() => {
  const items = active.value?.items ?? []
  return items
    .map((one, index) => {
      const code = (one.exerciseCode ?? '').trim()
      return {
        code,
        sortNo: one.sortNo ?? index + 1,
        html: topicHtml.value[code] ?? '',
        loading: topicLoading.value[code] === true
      }
    })
    .filter((one) => one.code !== '')
})

/** 不能提交的原因：非空就禁用按钮并显示这句，避免点了没反应 */
const blockedReason = computed(() => {
  if (!childCode.value) return '先选择一个孩子'
  if (!active.value) return '先从左侧选一份编码映射'
  if (selected.value.length === 0) return '勾选至少一道题'
  if (!/^\d{4,6}$/.test(form.schoolCode)) return '学校代码要是 4~6 位数字'
  if (!/^\d{2}$/.test(form.classLevel)) return '请选择年级'
  if (!/^\d{6}$/.test(form.city)) return '请选择城市'
  return ''
})

const canSubmit = computed(() => !submitting.value && blockedReason.value === '')

// ── 自主批量提交（右侧抽屉：手输题码） ───────────────────────────────────

const drawerOpen = ref(false)

/** 抽屉里的班级：孩子换掉时跟着重算，映射那条路用的是映射自带的 classCode，互不影响 */
const manualClassCode = ref('')
const manualRaw = ref('')
const manualSubmitting = ref(false)

/** 抽屉题码的解析结果：能提交的（去重、保序）+ 格式不对的（页面提示用） */
const manualParsed = computed<{ list: string[]; invalid: string[] }>(() => {
  // 分隔规则与页面其它入口一致：空格 / 换行 / 中英文逗号 / 顿号 / 分号都算
  const tokens = manualRaw.value.split(/[\s,，、;；]+/).filter(Boolean)
  const seen = new Set<string>()
  const list: string[] = []
  const invalid: string[] = []
  for (const token of tokens) {
    // 后端只认 6~8 位、不以 0 开头的纯数字（ArgsTools.isNumeric），其它跳过
    if (!/^[1-9]\d{5,7}$/.test(token)) {
      if (!invalid.includes(token)) invalid.push(token)
      continue
    }
    if (seen.has(token)) continue
    seen.add(token)
    list.push(token)
  }
  return { list, invalid }
})

/** 抽屉不能提交的原因：非空就禁用按钮并显示这句，避免点了没反应 */
const manualBlocked = computed(() => {
  if (!childCode.value) return '先选择一个孩子'
  if (manualParsed.value.list.length === 0) return '请填入至少一个题码'
  if (manualParsed.value.list.length > MAX_COUNT) return `单次最多 ${MAX_COUNT} 个题码`
  if (!/^\d{4,6}$/.test(form.schoolCode)) return '学校代码要是 4~6 位数字'
  if (!/^\d{2}$/.test(form.classLevel)) return '请选择年级'
  if (!/^\d{6}$/.test(form.city)) return '请选择城市'
  return ''
})

const canManualSubmit = computed(
  () => !manualSubmitting.value && manualBlocked.value === ''
)

/** 抽屉里改班级时把学校代码跟着换掉（不同学校代码不同） */
function onManualClassChange(): void {
  const row = joinedClasses.value.find((cls) => cls.classCode === manualClassCode.value)
  if (row?.schoolCode) form.schoolCode = row.schoolCode
}

async function submitManual(): Promise<void> {
  if (!canManualSubmit.value) return
  manualSubmitting.value = true
  try {
    await submitSubjects({
      childCode: childCode.value,
      subjectCodes: manualParsed.value.list.join(' '),
      // 孩子还没加入班级时后端要的是 '0'（见 Cuotiben.classCode 的注释），不是空串
      classCode: manualClassCode.value || '0',
      schoolCode: form.schoolCode,
      classLevel: form.classLevel,
      city: form.city
    })
    // 后端对不存在的题码是静默跳过的，提示里把这一点说清楚
    showSuccess(`已提交 ${manualParsed.value.list.length} 个题码（不存在的题码会被跳过）`)
    manualRaw.value = ''
  } catch (err) {
    showError(describeError(err))
  } finally {
    manualSubmitting.value = false
  }
}

// Esc 收起抽屉：只在抽屉挂着时响应
function onDrawerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') drawerOpen.value = false
}

watch(drawerOpen, (isOpen) => {
  if (isOpen) window.addEventListener('keydown', onDrawerKeydown)
  else window.removeEventListener('keydown', onDrawerKeydown)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onDrawerKeydown))

function isSelected(code: string): boolean {
  return selected.value.includes(code)
}

function toggle(code: string): void {
  if (!code) return
  if (isSelected(code)) {
    selected.value = selected.value.filter((one) => one !== code)
    return
  }
  if (selected.value.length >= MAX_COUNT) {
    showInfo(`单次最多提交 ${MAX_COUNT} 道题`)
    return
  }
  selected.value = [...selected.value, code]
}

/** 点「去提交」：切到这份映射，清空上一份的勾选，异步补题干 */
function openMapping(item: SurveyMappingRow): void {
  activeId.value = item.surveyId
  selected.value = []
  void loadTopics(item.items ?? [])
}

/** 逐题拉题干：失败只降级为「内容暂不可用」，绝不挡住提交 */
async function loadTopics(items: SurveyMappingItem[]): Promise<void> {
  const codes = [...new Set(items.map((one) => (one.exerciseCode ?? '').trim()).filter(Boolean))]
  await Promise.all(
    codes.map(async (code) => {
      if (topicHtml.value[code] || topicLoading.value[code] || topicFailed.value[code]) return
      topicLoading.value = { ...topicLoading.value, [code]: true }
      try {
        const topic = await fetchTopicByCode(code)
        const html = topic?.subjectHtml ?? ''
        if (html) {
          topicHtml.value = { ...topicHtml.value, [code]: html }
        } else {
          topicFailed.value = { ...topicFailed.value, [code]: true }
        }
      } catch {
        topicFailed.value = { ...topicFailed.value, [code]: true }
      } finally {
        topicLoading.value = { ...topicLoading.value, [code]: false }
      }
    })
  )
}

// ── 左栏数据 ─────────────────────────────────────────────────────────────

// 切孩子/翻页都可能并发，只认最后一次请求的结果
let listSeq = 0

async function loadMappings(page: number): Promise<void> {
  const code = childCode.value
  if (!code) {
    mappings.value = []
    total.value = 0
    return
  }
  const seq = ++listSeq
  listLoading.value = true
  listError.value = ''
  try {
    const result = await fetchChildPublishedMappings(code, page, PAGE_SIZE)
    if (seq !== listSeq) return
    // 当前页被清空时退回上一页，别停在空页上（与「我的收藏」同一处理）
    if (result.list.length === 0 && page > 1 && result.total > 0) {
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
      if (lastPage !== page) {
        void loadMappings(lastPage)
        return
      }
    }
    mappings.value = result.list
    total.value = result.total
    pageNum.value = page
    // 选中的映射不在这一页了：右栏回到空态，避免提交别的班的题
    if (activeId.value !== null && !result.list.some((one) => one.surveyId === activeId.value)) {
      activeId.value = null
      selected.value = []
    }
  } catch (err) {
    if (seq !== listSeq) return
    listError.value = describeError(err)
    mappings.value = []
    total.value = 0
  } finally {
    if (seq === listSeq) listLoading.value = false
  }
}

function onPageChange(page: number): void {
  void loadMappings(page)
}

// ── 孩子与提交资料 ───────────────────────────────────────────────────────

// 换孩子时重拉上下文：详情补城市，已加入的班级补学校代码与年级
let contextSeq = 0
async function loadChildContext(code: string): Promise<void> {
  const seq = ++contextSeq
  const item = children.value.find((child) => child.childCode === code)
  // 两个接口各自兜底：详情查不到城市、班级列表为空都不该把整页卡死
  const [joined, detail] = await Promise.all([
    fetchChildJoinedClasses(code).catch(() => [] as JoinedChildClass[]),
    fetchChildDetail(code).catch(() => null)
  ])
  if (seq !== contextSeq) return

  joinedClasses.value = joined
  // 优先用「当前已通过的主班级」，没有就取第一个已加入的班级
  const first = joined.find((cls) => cls.classCode === item?.classCode) ?? joined[0] ?? null
  form.schoolCode = first?.schoolCode ?? item?.schoolCode ?? ''
  form.classLevel = item?.classLevel ?? detail?.classLevel ?? ''
  form.city = detail?.city ?? ''
  // 抽屉里的班级下拉跟着孩子重算，避免上一位孩子的班级留在里面
  manualClassCode.value = first?.classCode ?? item?.classCode ?? ''

  // 资料就位后再拉映射列表（列表本身按孩子已加入的班级过滤）
  void loadMappings(1)
}

async function loadChildren(): Promise<void> {
  childrenLoading.value = true
  try {
    children.value = await fetchMyChildren()
    // 只有一个孩子时直接选中，省一次点击
    if (!childCode.value && children.value.length > 0) {
      childCode.value = children.value[0].childCode
    }
  } catch (err) {
    showError(describeError(err))
  } finally {
    childrenLoading.value = false
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value || !active.value) return
  submitting.value = true
  try {
    await submitSubjects({
      childCode: childCode.value,
      subjectCodes: selected.value.join(' '),
      // 孩子还没加入班级时后端要的是 '0'（见 Cuotiben.classCode 的注释），不是空串
      classCode: active.value.classCode || '0',
      schoolCode: form.schoolCode,
      classLevel: form.classLevel,
      city: form.city
    })
    // 后端对不存在的题码是静默跳过的，提示里把这一点说清楚
    showSuccess(`已提交 ${selected.value.length} 道题（不存在的题码会被跳过）`)
    selected.value = []
  } catch (err) {
    showError(describeError(err))
  } finally {
    submitting.value = false
  }
}

function goMyChild(): void {
  void router.push('/home/my_child')
}

watch(childCode, (code) => {
  // 换孩子先清空右栏：上一位孩子的映射和勾选不能留在页面上
  activeId.value = null
  selected.value = []
  if (code) void loadChildContext(code)
})

onMounted(() => {
  void loadChildren()
})
</script>

<style scoped>
/* 版式：顶部一条学生资料，下面左右两栏各自滚动。
   高度 100% 与「编码映射」页同一套路，滚动交给 .pane-body，分页条贴底。 */
.se-page {
  /* position: relative 是给「自主批量提交」抽屉定位用的（抽屉在本组件内是 absolute，
     只盖内容区，侧栏与顶栏不受影响） */
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 16px 20px 0;
  box-sizing: border-box;
  overflow: hidden;
}

/* 顶部资料条：字段左起排，窄屏自动换行 */
.se-bar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 14px;
  padding: 0 0 14px;
}

.bar-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.bar-field.is-child {
  width: 220px;
}

.bar-label {
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.bar-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 右上角动作区：margin-left: auto 把按钮顶到资料条最右侧 */
.bar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* 「自主批量提交」：紫色实心，与左栏「去提交」同一套主色 */
.manual-btn {
  height: 32px;
  padding: 0 14px;
  font-family: inherit;
  font-size: 13px;
  color: #fff;
  background: rgb(124, 92, 255);
  border: 1px solid rgb(124, 92, 255);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.manual-btn:hover {
  background: rgb(108, 74, 244);
}

/* 抽屉层：绝对定位在页面里（不是 fixed）—— 只盖内容区，侧栏与顶栏不受影响。
   overflow: hidden 给滑入动画兜底：从 translateX(100%) 滑进来的那一截会被裁掉，
   不会把宿主页面的 scrollWidth 撑宽。 */
.drawer-layer {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  overflow: hidden;
  background: rgba(15, 23, 42, 0.14);
}

.drawer {
  display: flex;
  flex-direction: column;
  width: 560px;
  max-width: calc(100% - 48px);
  height: 100%;
  background: var(--admin-surface, #fff);
  border-left: 1px solid var(--admin-border, #d8dee6);
  box-shadow: -18px 0 40px rgba(15, 23, 42, 0.12);
}

.drawer-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 12px 18px;
  border-bottom: 1px solid var(--admin-border, #d8dee6);
}

.drawer-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.drawer-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--admin-text-weak, #8492a6);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.drawer-close:hover {
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-nav-hover, #eef2f7);
}

/* 滚动区兼作灰槽：白卡浮在上面，与「附加信息」抽屉同构 */
.drawer-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 14px 16px 16px;
  overflow-y: auto;
  background: var(--admin-bg, #f1f4f9);
}

.drawer-card {
  flex: none;
  padding: 14px 16px 16px;
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 10px;
}

/* is-fill：卡片吃掉抽屉剩下的全部高度，内部的题码框再撑满卡片 */
.drawer-card.is-fill {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 填满型卡片里，标题 / 说明 / 提示都定高，只有题码框伸缩 */
.drawer-card.is-fill > .drawer-card-head,
.drawer-card.is-fill > .drawer-card-sub,
.drawer-card.is-fill > .warn {
  flex: none;
}

.drawer-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.drawer-card-title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.drawer-card-head .drawer-card-title {
  margin: 0 0 6px;
}

.drawer-card-sub {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--admin-text-weak, #8492a6);
}

/* 表单两列；窄屏自动并成一列 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
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
  min-width: 0;
}

.field-label {
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 题码框：铺满卡片宽度，并纵向吃掉卡片剩下的高度（一题一行地贴，行多也不用滚） */
.codes {
  flex: 1 1 auto;
  width: 100%;
  height: auto;
  min-height: 96px;
  padding: 8px;
  box-sizing: border-box;
  line-height: 1.7;
  /* 高度交给 flex 撑，不再留手动拖拽的手柄（拖了也会被拉回） */
  resize: none;
}

/* 已填题码计数，超过上限变红 */
.counter {
  flex: none;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
  font-variant-numeric: tabular-nums;
}

.counter.is-over {
  color: #e5534b;
}

.warn {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #b7791f;
}

.hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.drawer-foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--admin-border, #d8dee6);
}

.drawer-tip {
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.foot-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.link-btn {
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  color: rgb(124, 92, 255);
  background: none;
  border: none;
  cursor: pointer;
}

.link-btn:hover {
  text-decoration: underline;
}

/* 两栏：左列表固定宽度区间，右题目区吃掉剩余空间 */
.se-split {
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
  padding: 0 0 16px;
}

/* 窄屏（<900px）两栏并排会把右边挤成一条，改成上下叠：上列表、下题目 */
@media (max-width: 900px) {
  .se-split {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(160px, 36%) minmax(0, 1fr);
  }
}

.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  overflow: hidden;
}

.pane-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--admin-border, #d8dee6);
}

.pane-title {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pane-count {
  flex: none;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.pane-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px;
}

.pane-foot {
  flex: none;
  padding: 8px 12px;
  border-top: 1px solid var(--admin-border, #d8dee6);
}

.pane-foot.is-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.state {
  margin: 24px 0;
  font-size: 13px;
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
}

.state.is-error {
  color: #e5534b;
}

/* 映射卡片：与「编码映射」页同一版式（88px 行高、上名次班、右操作） */
.map-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.map-item {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 76px;
  padding: 10px 12px 10px 14px;
  box-sizing: border-box;
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
}

.map-item:hover {
  border-color: rgba(139, 92, 246, 0.45);
  box-shadow: 0 4px 14px rgba(139, 92, 246, 0.14);
}

/* 选中：淡紫底 + 左缘紫竖线，取自「本地题库」选中卡片 */
.map-item.is-active {
  border-color: rgba(139, 92, 246, 0.45);
  background: rgba(245, 243, 255, 0.94);
  box-shadow: 0 4px 16px rgba(139, 92, 246, 0.16);
}

.map-item.is-active::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 999px;
  background: rgb(139, 92, 246);
}

.map-main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
}

.map-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

.map-name {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 已发布徽章：绿色 */
.map-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
  line-height: 1;
  color: #2f855a;
  background: rgba(47, 133, 90, 0.16);
  border-radius: 999px;
}

.map-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.meta-cell {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta-label {
  margin-right: 4px;
  color: var(--admin-text-weak, #8492a6);
  opacity: 0.85;
}

.meta-dot {
  flex: none;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.5;
}

/* 「去提交」：紫色实心，选中后转为浅紫描边（表示已经在右边了） */
.go-btn {
  flex: none;
  height: 28px;
  padding: 0 12px;
  font-family: inherit;
  font-size: 13px;
  color: #fff;
  background: rgb(124, 92, 255);
  border: 1px solid rgb(124, 92, 255);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.go-btn:hover {
  background: rgb(108, 74, 244);
}

.go-btn.is-on {
  color: rgb(124, 92, 255);
  background: rgba(245, 243, 255, 0.94);
}

/* 右栏题目列表 */
.quest-tip {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.quest-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.quest-item {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  box-sizing: border-box;
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 8px;
}

.quest-main {
  flex: 1 1 auto;
  min-width: 0;
}

.quest-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.quest-no {
  font-size: 13px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.quest-code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.quest-html {
  font-size: 13px;
  line-height: 1.7;
  color: var(--admin-text, #1f2d3d);
  word-break: break-word;
}

/* 题干是后端 HTML：图片别撑破卡片，段落间距收一收 */
.quest-html :deep(img) {
  max-width: 100%;
  height: auto;
}

.quest-html :deep(p) {
  margin: 0 0 6px;
}

.quest-html :deep(p:last-child) {
  margin-bottom: 0;
}

.quest-html :deep(table) {
  max-width: 100%;
}

.quest-muted {
  margin: 0;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 可选中按钮：未选灰描边，选中紫底白字 */
.pick-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 999px;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.pick-btn:hover {
  border-color: rgba(139, 92, 246, 0.55);
  color: rgb(124, 92, 255);
}

.pick-btn.is-on {
  color: #fff;
  background: rgb(124, 92, 255);
  border-color: rgb(124, 92, 255);
}

.pick-dot {
  width: 8px;
  height: 8px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

.pick-btn.is-on .pick-dot {
  background: currentColor;
}

.blocked {
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.ctl {
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

.ctl:disabled {
  background: var(--admin-bg-soft, #eef1f6);
  cursor: default;
}

/* 顶部的小字段：学校代码 / 年级 / 城市不需要铺满 */
.ctl.is-narrow {
  width: 120px;
}

.btn {
  height: 30px;
  padding: 0 18px;
  font-family: inherit;
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

/* 滑入：位移交给抽屉本身，淡入交给整层 */
.se-drawer-enter-active,
.se-drawer-leave-active {
  transition: opacity 0.18s ease;
}

.se-drawer-enter-active .drawer,
.se-drawer-leave-active .drawer {
  transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.se-drawer-enter-from,
.se-drawer-leave-to {
  opacity: 0;
}

.se-drawer-enter-from .drawer,
.se-drawer-leave-to .drawer {
  transform: translateX(100%);
}
</style>
