<template>
  <div
    ref="pageRef"
    class="nc-page"
    :style="{ '--nc-list-width': `${listWidth}px` }"
  >
    <!-- 左列表 + 右详情两栏常驻。点某一行的「审核加入」不再整页替换，
         而是把右栏换成审核面板（见下方 aside），左栏还能继续看 / 切别的班。
         这一层只做分组：display: contents，本身不生成盒子，里面的元素照样
         是 .nc-page 的 grid 子项。 -->
    <div class="nc-content">
      <!-- 顶部工具条：左边条数，右边创建 / 加入 / 刷新，横跨两栏
           （版式照「编码映射」页：左列表 + 可拖分隔条 + 右详情） -->
      <div class="nc-toolbar">
        <span class="nc-count">共 {{ total }} 个班级</span>
        <div class="nc-toolbar-actions">
          <button class="big-btn create" type="button" @click="openCreate">创建班级</button>
          <button class="big-btn apply" type="button" @click="openApply">加入班级</button>
          <button class="btn ghost" type="button" :disabled="refreshing" @click="refreshList">
            {{ refreshing ? '刷新中…' : '刷新' }}
          </button>
        </div>
      </div>

      <!-- 左栏：我的班级列表。点一行选中，右栏显示详情与操作入口 -->
      <div class="nc-list">
        <p v-if="loading" class="nc-state">加载中…</p>
        <p v-else-if="rows.length === 0" class="nc-state">
          还没有班级，点上方「创建班级」新建一个
        </p>
        <ul v-else class="nc-items">
          <li
            v-for="row in rows"
            :key="row.classCode"
            class="nc-item"
            :class="{ 'is-selected': row.classCode === selectedCode }"
            role="button"
            tabindex="0"
            @click="select(row)"
            @keydown.enter.prevent="select(row)"
            @keydown.space.prevent="select(row)"
          >
            <div class="nc-item-head">
              <span class="nc-item-name" :title="row.className">{{ row.className }}</span>
              <span v-if="row.applyStatus === 'applying'" class="pending-tag">审核中</span>
            </div>
            <div class="nc-item-meta">
              <span class="meta-cell"><span class="meta-label">ID</span>{{ row.classCode }}</span>
              <template v-if="levelLabel(row)">
                <span class="meta-dot"></span>
                <span class="meta-cell">{{ levelLabel(row) }}</span>
              </template>
            </div>

            <!-- 操作直接摆在每个班自己的卡片里：点按钮不算选中这行（.stop） -->
            <div class="nc-item-actions">
              <!-- 审核中的班级还不是成员，改名 / 查映射 / 加映射都用不上，只留审核入口 -->
              <button
                v-if="row.applyStatus !== 'applying'"
                class="btn small"
                type="button"
                @click.stop="openEdit(row)"
              >
                修改信息
              </button>
              <button class="btn small ghost" type="button" @click.stop="goAudit(row)">
                审核加入
              </button>
              <!-- 查看这个班的编码映射：跳「班级映射」页并默认选中这个班（只读：查看 + 统计） -->
              <button
                v-if="row.applyStatus !== 'applying'"
                class="btn small ghost"
                type="button"
                title="看这个班收到的全部编码映射，可以查看和统计"
                @click.stop="goMapping(row)"
              >
                查看编码映射
              </button>
              <!-- 把本班添加进别人已发布的映射：输入映射 ID，本班学生就能作答 -->
              <button
                v-if="row.applyStatus !== 'applying'"
                class="btn small ghost"
                type="button"
                title="输入别的老师已发布的映射 ID，把本班添加进它"
                @click.stop="openJoin(row)"
              >
                添加映射
              </button>
              <!-- 这个班的成绩录入（「班级管理 → 成绩录入」那一页，嵌到右栏里） -->
              <button
                v-if="row.applyStatus !== 'applying'"
                class="btn small ghost"
                type="button"
                title="给这个班的学生录入 / 查看成绩"
                @click.stop="goScore(row)"
              >
                成绩管理
              </button>
            </div>
          </li>
        </ul>
      </div>

      <!-- 分页只贴左栏底部，不横穿右栏 -->
      <div class="nc-footer">
        <Pagination
          :total="total"
          :page-num="pageNum"
          :page-size="PAGE_SIZE"
          @change="onPage"
        />
      </div>

      <!-- 中：可拖的分隔条（与「编码映射」页同款） -->
      <div
        class="nc-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整班级列表的宽度，右侧详情自动占满剩下的空间"
        :aria-valuenow="listWidth"
        aria-valuemin="420"
        @pointerdown="startResize"
      >
        <span class="nc-resizer-grip" aria-hidden="true"></span>
      </div>

      <!-- 右：默认是选中班级的详情；点「审核加入」/「查看编码映射」/「成绩管理」时同一块地方换面板。
           面板都嵌在右栏里（embedded），不走整页替换，左栏列表一直在。 -->
      <aside
        class="nc-pane"
        :class="{ 'is-auditing': auditOpen, 'is-mapping': mappingOpen, 'is-scoring': scoreOpen }"
      >
        <header class="nc-pane-head">
          <span class="nc-pane-title">{{ paneTitle }}</span>
          <button
            v-if="auditOpen || mappingOpen || scoreOpen"
            class="btn ghost small"
            type="button"
            title="收起当前面板，回到班级详情"
            @click="closePane"
          >
            返回详情
          </button>
        </header>

        <!-- key 用班级编码：从 A 班的面板直接点 B 班的「审核加入」时整个面板重建，
             下拉和申请列表按 B 班重新拉，不会停在 A 班的数据上 -->
        <JoinAuditPanel
          v-if="auditOpen"
          :key="auditClassCode"
          :initial-class-code="auditClassCode"
          embedded
        />

        <!-- 这个班收到的编码映射：右栏内部再分左右两列，左列表、右「映射详情」。
             key 用班级编码：换班直接点另一行的「查看编码映射」时整块重建 -->
        <ClassMappingView
          v-else-if="mappingOpen"
          :key="`map-${mappingClassCode}`"
          embedded
          :preset-class-code="mappingClassCode"
          :preset-class-name="mappingClassName"
        />

        <!-- 这个班的成绩录入：直接复用「成绩录入」那页，班定死，科目 / 满分照常选 -->
        <PutScoreView
          v-else-if="scoreOpen"
          :key="`score-${scoreClassCode}`"
          embedded
          :preset-class-code="scoreClassCode"
        />

        <div v-else-if="!selected" class="nc-pane-empty">
          <p class="nc-pane-empty-title">还没有选中的班级</p>
          <p class="nc-pane-empty-text">
            点左侧任意一个班级，这里显示它的班级 ID、年级和当前状态；改信息、审核加入、
            查映射都在左侧那张卡片里操作。
          </p>
        </div>

        <div v-else class="nc-pane-body">
          <div class="nc-pane-name-row">
            <span class="nc-pane-name" :title="selected.className">{{ selected.className }}</span>
            <span v-if="isApplying" class="pending-tag">审核中</span>
          </div>

          <dl class="nc-facts">
            <div class="nc-fact">
              <dt>班级 ID</dt>
              <dd class="mono">{{ selected.classCode }}</dd>
            </div>
            <div class="nc-fact">
              <dt>年级</dt>
              <dd>{{ levelLabel(selected) || '未标注' }}</dd>
            </div>
            <div class="nc-fact">
              <dt>状态</dt>
              <dd>{{ isApplying ? '审核中：等班级创建者通过' : '已加入' }}</dd>
            </div>
          </dl>

          <p v-if="isApplying" class="nc-pane-tip">
            审核通过前不能改名、查看编码映射或添加映射，先等班级创建者通过申请。
          </p>
        </div>
      </aside>

    <!-- 创建班级模态框 -->
    <div v-if="createOpen" class="mask" @click.self="createOpen = false">
      <div class="dialog dialog-wide">
        <div class="dialog-head">
          <span>创建班级</span>
          <button class="dialog-close" type="button" title="关闭" @click="createOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">班级名：</span>
            <span class="field-ctl">
              <input
                v-model="createName"
                class="ctl"
                maxlength="60"
                placeholder="如，2026 实验小学二年级二班"
                @keyup.enter="submitCreate"
              />
              <span class="word-limit">{{ createName.length }}/60</span>
            </span>
          </label>
          <!-- 命名说明常显在输入框下方，不再用问号图标控制展开 -->
          <p class="field-help">命名规则：当前年份学校名班级名，8-60字符</p>
          <label class="field">
            <span class="field-label">年级：</span>
            <select v-model="createLevel" class="ctl">
              <option v-for="c in CLASS_LEVEL_OPTIONS" :key="c.value" :value="c.value">
                {{ c.label }}
              </option>
            </select>
          </label>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
          <button class="btn" type="button" :disabled="createSubmitting" @click="submitCreate">
            确定
          </button>
        </div>
      </div>
    </div>

    <!-- 修改班级信息模态框（打开时回填该行现有值；版式与创建弹窗保持一致） -->
    <div v-if="editOpen" class="mask" @click.self="editOpen = false">
      <div class="dialog dialog-wide">
        <div class="dialog-head">
          <span>修改班级信息</span>
          <button class="dialog-close" type="button" title="关闭" @click="editOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">班级名：</span>
            <span class="field-ctl">
              <input
                v-model="editName"
                class="ctl"
                maxlength="60"
                placeholder="如，2026 实验小学二年级二班"
                @keyup.enter="submitEdit"
              />
              <span class="word-limit">{{ editName.length }}/60</span>
            </span>
          </label>
          <p class="field-help">命名规则：当前年份学校名班级名，8-60字符</p>
          <label class="field">
            <span class="field-label">年级：</span>
            <select v-model="editLevel" class="ctl">
              <option v-for="c in CLASS_LEVEL_OPTIONS" :key="c.value" :value="c.value">
                {{ c.label }}
              </option>
            </select>
          </label>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="editOpen = false">取消</button>
          <button class="btn" type="button" :disabled="editSubmitting" @click="submitEdit">
            确定
          </button>
        </div>
      </div>
    </div>

    <!-- 申请加入模态框 -->
    <div v-if="applyOpen" class="mask" @click.self="applyOpen = false">
      <div class="dialog">
        <div class="dialog-head">
          <!-- 说明小字放在标题下面、分割线上面 -->
          <div class="dialog-head-text">
            <span>申请加入</span>
            <span class="dialog-tip">加入别的老师创建的班级</span>
          </div>
          <button class="dialog-close" type="button" title="关闭" @click="applyOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">班级代码：</span>
            <input
              v-model="applyCode"
              class="ctl"
              maxlength="10"
              placeholder="输入班级数字代码"
              @keyup.enter="submitApply"
            />
          </label>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="applyOpen = false">取消</button>
          <button class="btn" type="button" :disabled="applySubmitting" @click="submitApply">
            确定
          </button>
        </div>
      </div>
    </div>

    <!-- 添加映射模态框：输入别人已发布的映射 ID，把本班加进它的发放范围。
         本班老师加入后，这份映射的学生作答 / 统计就覆盖本班，映射本身的内容不会变。 -->
    <div v-if="joinOpen" class="mask" @click.self="joinOpen = false">
      <div class="dialog">
        <div class="dialog-head">
          <div class="dialog-head-text">
            <span>添加映射</span>
            <span class="dialog-tip">把「{{ joinClassName }}」添加进一份已发布的映射</span>
          </div>
          <button class="dialog-close" type="button" title="关闭" @click="joinOpen = false">
            ×
          </button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">映射 ID：</span>
            <input
              v-model="joinSurveyId"
              class="ctl"
              maxlength="10"
              inputmode="numeric"
              placeholder="输入映射编号"
              @keyup.enter="submitJoin"
            />
          </label>
          <p class="field-help">
            映射必须是已发布的；添加后本班学生就能作答，映射名与题目对不会变。
          </p>
        </div>
        <div class="dialog-foot">
          <button class="btn ghost" type="button" @click="joinOpen = false">取消</button>
          <button class="btn" type="button" :disabled="joinSubmitting" @click="submitJoin">
            {{ joinSubmitting ? '添加中…' : '确定' }}
          </button>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Pagination from '../components/Pagination.vue'
import JoinAuditPanel from '../components/JoinAuditPanel.vue'
import ClassMappingView from './ClassMappingView.vue'
import PutScoreView from './PutScoreView.vue'
import { CLASS_LEVEL_OPTIONS, classLevelLabel } from '../utils/class-level'
import {
  applyJoinClass,
  createMyClass,
  fetchMyClasses,
  updateMyClass,
  type ClassItem
} from '../api/classes'
import { addSurveyMappingClass } from '../api/surveys'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

// ── 我的班级列表 + 分页 ───────────────────────────────────────────────────

const PAGE_SIZE = 10
const pageNum = ref(1)
const total = ref(0)
const rows = ref<ClassItem[]>([])
const loading = ref(true)

/** 左栏当前选中的班级（classCode）：只影响高亮和右栏内容，不影响数据加载 */
const selectedCode = ref('')

const selected = computed<ClassItem | null>(
  () => rows.value.find((row) => row.classCode === selectedCode.value) ?? null
)

/** 选中的班还在审核中：改名 / 查映射 / 加映射都用不上，右栏只留提示与审核入口 */
const isApplying = computed(() => selected.value?.applyStatus === 'applying')

/** 列表里那行小字：年级（后端给的是两位码，翻成人话再显示；认不出就空着） */
function levelLabel(row: ClassItem): string {
  return classLevelLabel(String(row.classLevel ?? ''))
}

/** 右栏正在显示审核面板（点某行的「审核加入」进去）；false 时显示班级详情 */
const auditOpen = ref(false)
/** 审核面板针对的班级编码；从 A 班直接点 B 班时这里换掉，面板按 key 重建 */
const auditClassCode = ref('')

/** 右栏正在显示编码映射面板（点某行的「查看编码映射」进去） */
const mappingOpen = ref(false)
/** 映射面板针对的班级；同审核面板，换班时按 key 重建 */
const mappingClassCode = ref('')
const mappingClassName = ref('')

/** 右栏正在显示成绩录入面板（点某行的「成绩管理」进去） */
const scoreOpen = ref(false)
const scoreClassCode = ref('')
const scoreClassName = ref('')

/** 右栏标题：哪个面板开着就显示哪个，都没开显示班级详情 */
const paneTitle = computed(() => {
  if (auditOpen.value) return '审核加入'
  if (mappingOpen.value) return `编码映射 · ${mappingClassName.value || mappingClassCode.value}`
  if (scoreOpen.value) return `成绩管理 · ${scoreClassName.value || scoreClassCode.value}`
  return '班级详情'
})

/** 收起右栏里的面板，回到选中班级的详情 */
function closePane(): void {
  auditOpen.value = false
  mappingOpen.value = false
  scoreOpen.value = false
}

/** 三个面板互斥：开一个就收起另外两个 */
function openOnly(panel: 'audit' | 'mapping' | 'score'): void {
  auditOpen.value = panel === 'audit'
  mappingOpen.value = panel === 'mapping'
  scoreOpen.value = panel === 'score'
}

/** 点一行就选中它；再点一次保持选中（与「编码映射」页同一口径，不做反选） */
function select(row: ClassItem): void {
  // 正在看 A 班的面板时点了 B 班：右栏回到 B 班的详情，别让面板盖住它的信息
  if (auditOpen.value && row.classCode !== auditClassCode.value) auditOpen.value = false
  if (mappingOpen.value && row.classCode !== mappingClassCode.value) mappingOpen.value = false
  if (scoreOpen.value && row.classCode !== scoreClassCode.value) scoreOpen.value = false
  selectedCode.value = row.classCode
}

async function loadPage(): Promise<void> {
  loading.value = true
  try {
    const page = await fetchMyClasses(pageNum.value, PAGE_SIZE)
    rows.value = page.list
    total.value = page.total
    // 翻页 / 刷新后原来那个班可能已经不在本页，右栏跟着清空，免得详情和列表对不上
    if (selectedCode.value && !page.list.some((row) => row.classCode === selectedCode.value)) {
      selectedCode.value = ''
    }
  } catch (error) {
    showError(describeError(error))
  } finally {
    loading.value = false
  }
}

function onPage(page: number): void {
  pageNum.value = page
  void loadPage()
}

// ── 审核：右栏换成「审核加入」面板（不再整页替换）─────────────────────────
function goAudit(row: ClassItem): void {
  // 老师申请加入的班级还没被创建者审核通过时，进去也审不了，先在这里拦一下
  if (row.applyStatus === 'applying') {
    showInfo('正在审核中，请等待班级创建者通过')
    return
  }
  // 顺手选中这一行：收起审核面板后，右栏看到的就是这个班的详情
  select(row)
  openOnly('audit')
  auditClassCode.value = row.classCode
}

// ── 「查看编码映射」：右栏换成这个班的映射面板（左列表 + 右详情）────────────
function goMapping(row: ClassItem): void {
  // 审核中的班级还不是成员，后端「只有该班老师才能查看」也过不去，拦一下
  if (row.applyStatus === 'applying') {
    showInfo('正在审核中，请等待班级创建者通过')
    return
  }
  // 顺手选中这一行：收起映射面板后，右栏看到的就是这个班的详情
  select(row)
  openOnly('mapping')
  mappingClassCode.value = row.classCode
  mappingClassName.value = row.className
}

// ── 「成绩管理」：右栏换成这个班的成绩录入（复用 PutScoreView，班定死）───────
function goScore(row: ClassItem): void {
  // 审核中的班级还不是成员，学生名单也拉不到，拦一下
  if (row.applyStatus === 'applying') {
    showInfo('正在审核中，请等待班级创建者通过')
    return
  }
  select(row)
  openOnly('score')
  scoreClassCode.value = row.classCode
  scoreClassName.value = row.className
}

// ── 「添加映射」：把本班加入一份别人建好、已发布的编码映射 ────────────────
// 后端 add/survey/class.do 只要求「映射已发布 + 我是该班审核通过的老师」，
// 不要求我是创建者 —— 教研组共用的映射靠这个入口铺到各个班。

const joinOpen = ref(false)
const joinSurveyId = ref('')
const joinClassCode = ref('')
const joinClassName = ref('')
const joinSubmitting = ref(false)

function openJoin(row: ClassItem): void {
  // 审核中的班级还不是成员，后端校验「该班老师」也过不去，先拦一下
  if (row.applyStatus === 'applying') {
    showInfo('正在审核中，请等待班级创建者通过')
    return
  }
  joinClassCode.value = row.classCode
  joinClassName.value = row.className
  joinSurveyId.value = ''
  joinOpen.value = true
}

async function submitJoin(): Promise<void> {
  if (joinSubmitting.value) return
  const raw = joinSurveyId.value.trim()
  // 后端 surveyId 是 Long，这里只放行正整数，避免把 0 / 负数 / 带空格的值发过去
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    showInfo('请输入映射编号')
    return
  }
  joinSubmitting.value = true
  try {
    await addSurveyMappingClass(Number(raw), joinClassCode.value)
    showSuccess(`已把「${joinClassName.value}」添加进该映射，本班学生现在可以作答了`)
    joinOpen.value = false
  } catch (error) {
    // 映射不存在 / 还没发布 / 该班已关联 / 不是本班老师：后端 msg 直接给人看
    showError(describeError(error))
  } finally {
    joinSubmitting.value = false
  }
}

// ── 顶部刷新：重拉当前页（页码不变）───────────────────────────────────────
const refreshing = ref(false)

async function refreshList(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await loadPage()
  } finally {
    refreshing.value = false
  }
}

// ── 左栏宽度（拖中间的分隔条）─────────────────────────────────────────────

/** 左栏（班级卡片列）默认宽度；右栏不再定宽，直接吃掉右边剩下的空间 */
const listWidth = ref(560)
const pageRef = ref<HTMLElement | null>(null)

/** 拖动分隔条改左栏宽度：右栏跟着走，两栏之间只隔那条 14px 的分隔条 */
function startResize(event: PointerEvent): void {
  const page = pageRef.value
  if (!page) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  const handleWidth = handle.getBoundingClientRect().width
  const pageRect = page.getBoundingClientRect()
  handle.classList.add('is-dragging')

  const onMove = (moveEvent: PointerEvent): void => {
    // 指针到页面左内边距（20px）的距离，就是左栏想要的宽度
    const desired = moveEvent.clientX - pageRect.left - 20 - handleWidth / 2
    // 下限 420：班名、ID/年级和四颗按钮排得下；上限给右栏留 300
    const max = Math.max(420, Math.round(pageRect.width - 40 - 14 - 300))
    listWidth.value = Math.min(max, Math.max(420, Math.round(desired)))
  }
  const onUp = (): void => {
    handle.classList.remove('is-dragging')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

onMounted(() => {
  void loadPage()
})

// ── 创建班级 ──────────────────────────────────────────────────────────────

const createOpen = ref(false)
const createName = ref('')
const createLevel = ref('')
const createSubmitting = ref(false)

function openCreate(): void {
  createName.value = ''
  createLevel.value = ''
  createOpen.value = true
}

async function submitCreate(): Promise<void> {
  const name = createName.value.trim()
  if (!name) {
    showInfo('请填写班级名')
    return
  }
  // 与后端 ArgsTools.checkClassName 同一口径：8~60 字符，且只允许数字、字母、汉字
  if (name.length < 8 || name.length > 60) {
    showInfo('班级名需 8~60 个字符')
    return
  }
  if (!/^[a-zA-Z0-9\u4e00-\u9fa5]+$/.test(name)) {
    showInfo('班级名只能包含数字、字母和汉字')
    return
  }
  if (!createLevel.value) {
    showInfo('请选择年级')
    return
  }
  createSubmitting.value = true
  try {
    const msg = await createMyClass(name, createLevel.value)
    showSuccess(msg || '创建成功')
    createOpen.value = false
    // 新班级可能落在列表任何位置，回第一页重查最直观
    pageNum.value = 1
    await loadPage()
  } catch (error) {
    showError(describeError(error))
  } finally {
    createSubmitting.value = false
  }
}

// ── 修改班级信息 ──────────────────────────────────────────────────────────

const editOpen = ref(false)
const editSubmitting = ref(false)
/** 正在编辑的行：id / classCode 跟随提交体，name / level 回填输入框 */
const editId = ref(0)
const editCode = ref('')
const editName = ref('')
const editLevel = ref('')

function openEdit(row: ClassItem): void {
  editId.value = row.id
  editCode.value = row.classCode
  editName.value = row.className
  // 后端列表里带着 classLevel 就回填，没有就留给用户重选
  editLevel.value = typeof row.classLevel === 'string' ? row.classLevel : ''
  editOpen.value = true
}

async function submitEdit(): Promise<void> {
  const name = editName.value.trim()
  if (!name) {
    showInfo('请填写班级名')
    return
  }
  // 与创建同一口径（后端 ArgsTools.checkClassName）
  if (name.length < 8 || name.length > 60) {
    showInfo('班级名需 8~60 个字符')
    return
  }
  if (!/^[a-zA-Z0-9\u4e00-\u9fa5]+$/.test(name)) {
    showInfo('班级名只能包含数字、字母和汉字')
    return
  }
  if (!editLevel.value) {
    showInfo('请选择年级')
    return
  }
  editSubmitting.value = true
  try {
    const msg = await updateMyClass({
      id: editId.value,
      classCode: editCode.value,
      className: name,
      classLevel: editLevel.value
    })
    showSuccess(msg || '修改成功')
    editOpen.value = false
    await loadPage()
  } catch (error) {
    showError(describeError(error))
  } finally {
    editSubmitting.value = false
  }
}

// ── 申请加入 ──────────────────────────────────────────────────────────────

const applyOpen = ref(false)
const applyCode = ref('')
const applySubmitting = ref(false)

function openApply(): void {
  applyCode.value = ''
  applyOpen.value = true
}

async function submitApply(): Promise<void> {
  const code = applyCode.value.trim()
  if (!code) {
    showInfo('请输入班级代码')
    return
  }
  applySubmitting.value = true
  try {
    const msg = await applyJoinClass(code)
    showSuccess(msg || '已提交申请')
    applyOpen.value = false
    // 新接口会把审核中的班级也列出来，刷新一下能立刻看到「审核中」标记
    await loadPage()
  } catch (error) {
    showError(describeError(error))
  } finally {
    applySubmitting.value = false
  }
}
</script>

<style scoped>
/* 版式照「编码映射」页：左边班级列表，右边详情面板，中间一条可拖的分隔条。
   三列 = 列表 / 分隔条 / 右栏（左栏宽度由 --nc-list-width 控制，右栏吃剩下的）；
   三行 = 工具条 / 列表正文 / 分页条（分页只在左栏底下，不横穿右栏）。 */
.nc-page {
  display: grid;
  /* 左栏按卡片宽度封顶（--nc-list-width，可拖），右栏 1fr 直接吃掉右边剩下的空间，
     两栏之间只留那条 14px 的分隔条 —— 右栏始终贴着列表项，不会在旁边留一块空的 */
  grid-template-columns: minmax(0, var(--nc-list-width, 560px)) 14px minmax(280px, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  padding: 16px 20px 0;
  box-sizing: border-box;
  /* 滚动交给列表正文，分页条才能一直贴在底部 */
  overflow: hidden;
}

/* 分组层不生成盒子，里面的元素直接当 .nc-page 的 grid 子项用 */
.nc-content {
  display: contents;
}

/* ── 顶部工具条（紫 = 创建、dodgerblue = 申请）──────────────────────────── */

.nc-toolbar {
  grid-column: 1 / -1;
  grid-row: 1;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 0 0 14px;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.nc-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 与工具条里的「刷新」(.btn) 同高，两排按钮才齐 */
.big-btn {
  width: auto;
  white-space: nowrap;
  height: 30px;
  padding: 0 14px;
  font-family: inherit;
  font-size: 13px;
  color: #fff;
  border: 1px solid #3b82f6;
  border-radius: 6px;
  background: #3b82f6;
  cursor: pointer;
}
/* 创建班级用「开始解析」那颗按钮的紫色：同一个品牌色 #7c3aed 的 75% 玻璃紫
   （见 styles/daoru-center.css 的 .glass-btn-primary，hover 到 85%）。
   原来是 ctbapp 那套绿，两个页面的主操作色不统一。 */
.big-btn.create {
  border-color: rgba(124, 58, 237, 0.9);
  background: rgba(124, 58, 237, 0.75);
}

.big-btn.create:hover {
  border-color: rgba(124, 58, 237, 0.95);
  background: rgba(124, 58, 237, 0.85);
}

.big-btn.apply {
  background: dodgerblue;
}

.big-btn.apply:hover {
  background: #1a7fe0;
}

/* ── 左栏：班级列表 ─────────────────────────────────────────────────────── */

.nc-list {
  grid-column: 1;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  /* 长列表在正文里滚，分页条留在底部不动 */
  overflow: auto;
}

.nc-state {
  margin: 0;
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.nc-items {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0 2px 0 0;
  list-style: none;
}

/* 一个班一行：上排「班级名 + 审核中」，下排「班级 ID · 年级」；
   选中态是淡紫底 + 左缘紫竖线，与「本地题库」「编码映射」同一口径 */
.nc-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 12px 18px 12px 20px;
  box-sizing: border-box;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 10px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
}

.nc-item:hover {
  border-color: rgba(139, 92, 246, 0.45);
  box-shadow: 0 4px 14px rgba(139, 92, 246, 0.14);
}

.nc-item.is-selected {
  border-color: rgba(139, 92, 246, 0.45);
  background: rgba(245, 243, 255, 0.94);
  box-shadow: 0 4px 16px rgba(139, 92, 246, 0.16);
}

.nc-item.is-selected::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 999px;
  background: rgb(139, 92, 246);
}

.nc-item:focus-visible {
  outline: 2px solid rgba(139, 92, 246, 0.5);
  outline-offset: 1px;
}

.nc-item-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

.nc-item-name {
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nc-item-meta {
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

/* 分隔小圆点，比竖线轻 */
.meta-dot {
  flex: none;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--admin-border, #d8dee6);
}

/* 卡片底部的操作按钮行：窗口窄了就换行，不把卡片撑宽 */
.nc-item-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  /* 按钮自己处理点击，别让按下时的文字选中干扰连续点两下 */
  user-select: none;
}

/* 分页条固定在左下角，宽度只跟左栏走 */
.nc-footer {
  grid-column: 1;
  grid-row: 3;
  width: 100%;
}

/* ── 中间的拖拽分隔条 ─────────────────────────────────────────────────── */

.nc-resizer {
  grid-column: 2;
  grid-row: 2 / span 2;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  min-height: 0;
  position: relative;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}

.nc-resizer-grip {
  display: block;
  width: 3px;
  height: 64px;
  border-radius: 999px;
  background: #dfe4ec;
  transition: width 0.15s ease, height 0.15s ease, background-color 0.15s ease,
    box-shadow 0.15s ease;
}

.nc-resizer:hover .nc-resizer-grip,
.nc-resizer.is-dragging .nc-resizer-grip {
  width: 5px;
  height: 88px;
  background: #7c5cd6;
  box-shadow: 0 0 0 4px rgba(124, 92, 214, 0.12);
}

/* ── 右栏：选中班级的详情与操作入口 ───────────────────────────────────── */

.nc-pane {
  grid-column: 3;
  grid-row: 2 / span 2;
  display: flex;
  flex-direction: column;
  align-self: start;
  min-width: 0;
  min-height: 0;
  /* 作为容器：里面的映射面板按这一列的实际宽度决定「左右分栏」还是「上下堆叠」 */
  container-type: inline-size;
  container-name: ncpane;
  /* 操作按钮搬去列表项后，这里只剩几行信息：卡片按内容收紧，别空撑一整屏 */
  max-height: 100%;
  margin-bottom: 16px;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 12px;
  background: var(--admin-surface, #fff);
  overflow: hidden;
}

/* 还没选中任何班时反而要占满：空态提示居中，位置才稳 */
.nc-pane:has(.nc-pane-empty) {
  align-self: stretch;
}

/* 审核面板里的申请列表可能很长：这一列占满高度，滚动交给面板内部 */
.nc-pane.is-auditing {
  align-self: stretch;
}

/* 映射面板同理：左列表和右详情各滚各的，整列撑满 */
.nc-pane.is-mapping {
  align-self: stretch;
}

.nc-pane.is-mapping :deep(.cm-page) {
  flex: 1 1 auto;
  min-height: 0;
}

/* 成绩录入面板：表单 + 名单可能比一屏长，整列撑满、滚动交给页面自己 */
.nc-pane.is-scoring {
  align-self: stretch;
}

.nc-pane.is-scoring :deep(.ps-page) {
  flex: 1 1 auto;
  min-height: 0;
}

.nc-pane-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--admin-border, #d8dee6);
}

.nc-pane-title {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  /* 「编码映射 · 班名」可能很长：截断，别把「返回详情」挤走 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nc-pane-head .btn.small {
  flex: none;
}

/* 空态：没选中任何班时右栏居中给一句说明 */
.nc-pane-empty {
  margin: auto;
  max-width: 360px;
  padding: 24px 22px;
  text-align: center;
}

.nc-pane-empty-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.nc-pane-empty-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--admin-text-weak, #8492a6);
}

.nc-pane-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 16px;
  overflow: auto;
}

.nc-pane-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.nc-pane-name {
  min-width: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 基本信息：一行一项，左边窄标签 + 右边值 */
.nc-facts {
  display: flex;
  flex-direction: column;
  margin: 0;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 8px;
  overflow: hidden;
}

.nc-fact {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
}

.nc-fact + .nc-fact {
  border-top: 1px solid var(--admin-border, #d8dee6);
}

.nc-fact dt {
  flex: none;
  width: 72px;
  color: var(--admin-text-weak, #8492a6);
}

.nc-fact dd {
  margin: 0;
  min-width: 0;
  word-break: break-all;
}

.mono {
  font-family: Consolas, 'Courier New', monospace;
}

/* 审核中的提醒条：与「审核中」标记同一色系（琥珀） */
.nc-pane-tip {
  margin: 0;
  padding: 8px 12px;
  font-size: 12.5px;
  line-height: 1.6;
  color: #b8860b;
  background: #fff8e1;
  border: 1px solid #f0d58c;
  border-radius: 6px;
}



/* 班级名后面的「审核中」标记：老师申请了别人的班级，还没被创建者通过。
   缩进由所在容器的 gap 统一给（列表行头 / 右栏标题行），这里不再加 margin */
.pending-tag {
  flex: none;
  padding: 1px 6px;
  font-size: 12px;
  color: #b8860b;
  background: #fff8e1;
  border: 1px solid #f0d58c;
  border-radius: 3px;
}

/* ── 模态框 ───────────────────────────────────────────────────── */

.mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 22, 36, 0.45);
}

.dialog {
  width: min(420px, 90vw);
  background: var(--admin-surface, #fff);
  border-radius: 8px;
  box-shadow: 0 8px 30px rgba(15, 22, 36, 0.25);
  overflow: hidden;
}

/* 创建 / 修改班级共用的宽版弹窗 */
.dialog-wide {
  width: min(500px, 90vw);
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  font-size: 15px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  border-bottom: 1px solid var(--admin-border, #d8dee6);
}

.dialog-close {
  width: 28px;
  height: 28px;
  font-size: 18px;
  line-height: 1;
  color: var(--admin-text-weak, #8492a6);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.dialog-close:hover {
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-nav-hover, #eef2f7);
}

.dialog-body {
  padding: 16px;
}

/* 标题 + 说明小字竖排，整块与右侧关闭按钮居中对齐 */
.dialog-head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 标题下的一行说明小字（在分割线之上） */
.dialog-tip {
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  color: var(--admin-text-weak, #8492a6);
}

.field {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}

.field:last-child {
  margin-bottom: 0;
}

.field-label {
  flex: none;
  width: 72px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
}

.field-ctl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ctl {
  height: 30px;
  padding: 0 8px;
  box-sizing: border-box;
  width: 300px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 4px;
}

.word-limit {
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 命名说明常显在输入框正下方：左边空出「班级名：」标签的宽度（72 + 间距 6） */
.field-help {
  margin: -6px 0 12px 78px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--admin-text-weak, #8492a6);
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--admin-border, #d8dee6);
}

.btn {
  height: 30px;
  padding: 0 18px;
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

/* 小号按钮：列表项里的四颗操作按钮、右栏头部的「返回详情」用 */
.btn.small {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}
</style>
