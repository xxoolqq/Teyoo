<template>
  <!-- 编码映射（现挂在「班级管理」分组下，映射按班级发放）。
       新建一条 = 建一份「问卷」：映射名 + 所属班级（可多选）+ 若干 题码-题号 对
       （后端 SurveyController#createSurveyMapping）；列表走 scanSurveyMapping
       分页查当前登录老师自己关联的班（PageHelper 口径，与「我的收藏」同一套分页组件）。
       后端一行一个班，同一份映射发多个班就有多行，列表在 groupedMappings 里按 surveyId 归组，
       修改 / 统计都按整份映射做；已发布只能改映射名。追加班级不在这里：
      别的老师要在「创建班级」页用「添加映射」按 ID 加入，本页只看我创建的映射。
      按班级看「这个班收到的全部映射」（含别人创建 / 别人加入的）走「班级映射」页。 -->
  <div
    ref="pageRef"
    class="mapping-page"
    :style="{ '--editor-width': `${editorWidth}px` }"
  >
    <div class="list-toolbar">
      <!-- 后端一行一个班：total 是班级行数，列表已按映射归组，这里把两个口径都说清 -->
      <span class="count">
        共 {{ total }} 条班级记录
        <template v-if="groupedMappings.length !== total">
          （本页 {{ groupedMappings.length }} 份映射）
        </template>
      </span>
      <button class="new-btn" type="button" @click="openCreate">新建编码映射</button>
    </div>

    <div class="mapping-body">
      <p v-if="loading" class="state">加载中…</p>
      <p v-else-if="loadError" class="state is-error">{{ loadError }}</p>
      <template v-else>
        <p v-if="mappings.length === 0" class="state">
          还没有编码映射，点右上角「新建编码映射」开始
        </p>
        <ul v-else class="mapping-list">
          <!-- 一份映射一行（88px，宽度收窄）：上排是映射名 + 状态徽章，下排是班级名，
               操作按钮靠右。点一行即选中 —— 淡紫底 + 左侧紫竖线，取自「本地题库」的选中卡片。
               后端一行一个班（同一份映射发多个班就有多行），这里已按 surveyId 归组。 -->
          <li
            v-for="item in groupedMappings"
            :key="item.surveyId"
            class="mapping-item"
            :class="{ 'is-selected': item.surveyId === selectedId }"
            role="button"
            tabindex="0"
            @click="select(item)"
            @keydown.enter.prevent="select(item)"
            @keydown.space.prevent="select(item)"
          >
            <div class="mapping-main">
              <div class="mapping-head">
                <span class="mapping-name" :title="item.title">{{ item.title }}</span>
                <span class="mapping-badge" :class="statusClass(item.status)">
                  {{ statusText(item.status) }}
                </span>
              </div>
              <div class="mapping-meta">
                <span class="meta-cell" :title="classNamesText(item)">
                  <span class="meta-label">班级</span>{{ classNamesText(item) }}
                </span>
                <span class="meta-dot"></span>
                <span class="meta-cell">
                  <span class="meta-label">题码</span>{{ item.itemCount ?? 0 }} 对
                </span>
              </div>
            </div>

            <!-- 右侧动作区：一行四颗等宽按钮（查看 / 发布 / 修改 / 统计）。
                 「把我的班加入别人的映射」入口在班级管理页，不在这里，避免同一动作两个入口。 -->
            <div class="mapping-actions">
              <div class="act-row">
                <button class="act act-view" type="button" @click="openView(item)">查看</button>
                <button
                  class="act act-publish"
                  type="button"
                  :disabled="item.status !== 0 || publishingId === item.surveyId"
                  :title="publishHint(item)"
                  @click="onPublish(item)"
                >
                  {{ publishingId === item.surveyId ? '发布中' : '发布' }}
                </button>
                <button
                  class="act act-edit"
                  type="button"
                  :disabled="item.status === 2"
                  :title="editHint(item)"
                  @click="openEdit(item)"
                >
                  修改
                </button>
                <button class="act act-stats" type="button" @click="onStats(item)">统计</button>
              </div>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <div class="mapping-footer">
      <Pagination
        :total="total"
        :page-num="pageNum"
        :page-size="PAGE_SIZE"
        @change="onPageChange"
      />
    </div>

    <!-- 中：可拖的分隔条（照「本地题库」的 bank-split-resizer） -->
    <div
      class="mapping-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整映射列表和修改面板的宽度"
      :aria-valuenow="editorWidth"
      aria-valuemin="320"
      @pointerdown="startResize"
    >
      <span class="mapping-resizer-grip" aria-hidden="true"></span>
    </div>

    <!-- 右：新建 / 修改 / 统计共用这一块，点对应按钮就在这里就地打开：
         新建与修改是「考试名 + 所属班级 + 完整的题码-题号映射」，统计是每题的对错表 -->
    <aside class="mapping-editor-pane" :class="{ 'is-editing': isPaneOpen }">
      <header class="editor-head">
        <span class="editor-title">
          {{
            isStat
              ? '答题统计'
              : isPaneOpen
                ? isCreate
                  ? '新建编码映射'
                  : '修改编码映射'
                : '映射详情'
          }}
        </span>
        <button
          v-if="isPaneOpen"
          class="editor-close"
          type="button"
          :title="isStat ? '关闭统计' : isCreate ? '退出新建（不保存）' : '退出修改（不保存）'"
          :aria-label="isStat ? '关闭统计' : isCreate ? '退出新建' : '退出修改'"
          @click="closePane"
        >
          ×
        </button>
      </header>

      <!-- 空态：既没在新建 / 修改，也没点「统计」 -->
      <div v-if="!isPaneOpen" class="editor-empty">
        <p class="editor-empty-title">还没有打开的映射</p>
        <p class="editor-empty-text">
          点右上角「新建编码映射」新建一份，或点左侧任意一条映射的「修改」/「统计」，这里显示它的考试名、所属班级、题码-题号映射或每题的对错统计。
        </p>
      </div>

      <!-- 统计：一题一行 —— 题码 / 正确数 / 错误数 / 正确率 / 错误率（空白不计入比率分母） -->
      <template v-else-if="isStat">
        <div class="stat-head">
          <div class="stat-title-row">
            <span class="stat-name" :title="statSurvey?.title">{{ statSurvey?.title }}</span>
            <span class="stat-total">共 {{ statTotal }} 题</span>
          </div>
          <!-- 统计范围：本页 classes 只含自己加的班，默认全选，点一下就能单看某个班 -->
          <div class="stat-class-picker" role="group" aria-label="统计的班级">
            <span class="stat-class-label">统计班级</span>
            <button
              v-for="cls in statSurvey?.classes ?? []"
              :key="cls.classCode"
              class="class-chip is-mini"
              :class="{ 'is-on': statPicked.includes(cls.classCode) }"
              type="button"
              :title="cls.className"
              :aria-pressed="statPicked.includes(cls.classCode)"
              @click="toggleStatClass(cls.classCode)"
            >
              {{ cls.className }}
            </button>
          </div>
        </div>

        <div class="editor-body">
          <p v-if="statLoading" class="state">统计中…</p>
          <p v-else-if="statError" class="state is-error">{{ statError }}</p>
          <p v-else-if="statRows.length === 0" class="state">
            这些班级还没有学生提交答卷，暂无统计数据
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

        <!-- 题码多于一页才出现这条；单页时不占一条空白的底栏 -->
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
          <label class="field">
            <span class="field-label">考试名（映射名）</span>
            <input
              v-model="form.name"
              class="field-input"
              type="text"
              maxlength="255"
              autocomplete="off"
              placeholder="请输入考试名"
              @keyup.enter="submitCreate"
              @input="clearError"
            />
          </label>

          <!-- 班级多选：一份映射可以同时发给自己的多个班（别的老师的班走列表里的「加发布班级」） -->
          <div class="field">
            <span class="field-label">所属班级（可多选）</span>
            <p v-if="classesLoading" class="field-hint">班级加载中…</p>
            <div v-else class="class-picker">
              <button
                v-for="cls in classes"
                :key="cls.classCode"
                class="class-chip"
                :class="{ 'is-on': form.classCodes.includes(cls.classCode) }"
                type="button"
                :disabled="draftLocked"
                :title="cls.className"
                :aria-pressed="form.classCodes.includes(cls.classCode)"
                @click="toggleFormClass(cls.classCode)"
              >
                {{ cls.className }}
              </button>
            </div>
          </div>

          <p v-if="!classesLoading && classes.length === 0" class="field-hint">
            还没有班级可选，请先到「班级管理 → 创建班级」建一个
          </p>
          <p v-else-if="draftLocked" class="field-hint is-warn">
            这份映射已发布：班级与题码-题号对锁定，只能改映射名
          </p>
          <p v-else-if="classes.length > 0" class="field-hint">
            已选 {{ form.classCodes.length }} 个班；没出现在这里的班，等映射发布后用「加发布班级」追加
          </p>

          <!-- 完整的题码-题号：每行两对（右栏被拖窄时自动退成一列），可直接改题码 / 题号，也可增删 -->
          <div class="sub-block">
            <div class="sub-head">
              <span class="editor-section-title">
                题码 — 题号
                <span class="editor-count">共 {{ form.subs.length }} 对</span>
              </span>
              <button
                v-if="!draftLocked"
                class="add-sub-btn"
                type="button"
                @click="addSubMapping"
              >
                增加映射
              </button>
            </div>

            <!-- 旧版后端不带明细时的降级提示：update 是全量覆盖，得让老师知道要重填 -->
            <p v-if="form.subs.length === 0 && editingCount > 0" class="field-hint is-warn">
              列表里没带回这个映射的明细，保存会把原来的 {{ editingCount }} 对整体覆盖，请先把它们重新填上。
            </p>
            <p v-else-if="form.subs.length === 0 && !draftLocked" class="field-hint">
              还没有题码-题号，点「增加映射」逐条添加
            </p>
            <p v-else-if="form.subs.length === 0" class="field-hint">
              这份映射还没有题码-题号
            </p>

            <div v-if="form.subs.length > 0" class="sub-table">
              <div v-for="(sub, index) in form.subs" :key="sub.key" class="sub-pair">
                <span class="sub-index">{{ index + 1 }}</span>
                <input
                  v-model="sub.questionCode"
                  class="field-input"
                  :class="{ 'is-invalid': dupCodes.has(sub.questionCode.trim()) }"
                  type="text"
                  maxlength="10"
                  autocomplete="off"
                  placeholder="题码"
                  title="题码"
                  :disabled="draftLocked"
                  @input="clearError"
                />
                <input
                  v-model="sub.serial"
                  class="field-input is-narrow"
                  :class="{ 'is-invalid': dupNos.has(sub.serial.trim()) }"
                  type="text"
                  maxlength="4"
                  autocomplete="off"
                  placeholder="题号"
                  title="题号"
                  :disabled="draftLocked"
                  @input="clearError"
                />
                <button
                  v-if="!draftLocked"
                  class="sub-remove"
                  type="button"
                  title="移除这对题码-题号"
                  @click="removeSubMapping(sub)"
                >
                  ×
                </button>
              </div>
            </div>

            <p v-if="formError" class="form-error">{{ formError }}</p>
          </div>
        </div>

        <footer class="editor-actions">
          <button class="editor-btn" type="button" :disabled="submitting" @click="closePane">
            取消
          </button>
          <button
            class="editor-btn is-primary"
            type="button"
            :disabled="submitting"
            @click="submitCreate"
          >
            {{
              submitting
                ? '保存中…'
                : isCreate
                  ? '新建'
                  : draftLocked
                    ? '保存映射名'
                    : '保存修改'
            }}
          </button>
        </footer>
      </template>
    </aside>

    <!-- 查看：只读详情，与右栏的「修改」分开：这里只读，字段取自列表接口 -->
    <ModalDialog
      :open="viewOpen"
      title="映射详情"
      confirm-text="关闭"
      hide-cancel
      width="440px"
      @confirm="closeView"
      @cancel="closeView"
    >
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
          <dd>{{ viewing.classes.map((one) => one.className).join('、') || '班级已删除' }}</dd>
        </div>
        <div class="detail-row">
          <dt>班级编码</dt>
          <dd>{{ viewing.classes.map((one) => one.classCode).join('、') || '—' }}</dd>
        </div>
        <div class="detail-row">
          <dt>题码-题号</dt>
          <dd>{{ viewing.itemCount ?? 0 }} 对</dd>
        </div>
        <div class="detail-row">
          <dt>状态</dt>
          <dd>
            <span class="mapping-badge" :class="statusClass(viewing.status)">
              {{ statusText(viewing.status) }}
            </span>
          </dd>
        </div>
        <div class="detail-row">
          <dt>创建时间</dt>
          <dd>{{ formatCreatedAt(viewing.createdAt) }}</dd>
        </div>
      </dl>
      <p class="detail-tip">题码与题号的明细要等后端提供详情接口</p>
    </ModalDialog>

    <!-- 发布不可逆（发布后学生立即可作答、映射不能再改）：点一下先确认再发 -->
    <ConfirmDialog
      :open="confirmPublish !== null"
      title="发布这份编码映射？"
      :message="confirmPublish ? `「${confirmPublish.title}」发布后学生即可作答，映射不能再修改。` : ''"
      confirm-text="发布"
      cancel-text="再想想"
      @confirm="doPublish"
      @cancel="cancelPublish"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ModalDialog from '../components/ModalDialog.vue'
import Pagination from '../components/Pagination.vue'
import { fetchClassOptions, type ClassItem } from '../api/classes'
import {
  createSurveyMapping,
  fetchSurveyClassStat,
  fetchSurveyMappings,
  publishSurveyMapping,
  updateSurveyMapping,
  type SurveyClassStatRow,
  type SurveyMappingItem,
  type SurveyMappingRow
} from '../api/surveys'
import { validateMappingDrafts } from '../utils/mapping-items'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'

/** 一页多少条：与后端 scanCreatorMappings 的默认值一致 */
const PAGE_SIZE = 10

/** 一条子映射：题码 + 题号（编辑中的草稿带 key，提交前折成后端要的 items） */
interface SubMappingDraft {
  key: number
  questionCode: string
  serial: string
}

/**
 * 列表里的一份映射：后端一行一个班（同一份映射发给几个班就有几行），
 * 这里按 surveyId 归组后再展示 —— 不然「修改 / 统计」按行做，会把其它班漏掉。
 */
interface MappingGroup {
  surveyId: number
  title: string
  status?: number
  createdAt?: SurveyMappingRow['createdAt']
  itemCount?: number
  items?: SurveyMappingItem[]
  /** 自己关联的班（创建时绑的 + 自己后加的），至少一个 */
  classes: { classCode: string; className: string }[]
}

/** 当前页的列表（只存后端返回的那一页，翻页就整页换掉；一行一个班，未归组） */
const mappings = ref<SurveyMappingRow[]>([])
const total = ref(0)
const pageNum = ref(1)
const loading = ref(false)
const loadError = ref('')

/**
 * 把「一行一个班」的原始列表按 surveyId 归组：班级列表攒全，修改 / 统计才有完整作用域。
 * 班级被删（后端 left join 出来 classCode 为空）的行直接丢掉：这种班既不能统计也不能改。
 */
const groupedMappings = computed<MappingGroup[]>(() => {
  const groups = new Map<number, MappingGroup>()
  for (const row of mappings.value) {
    const classCode = (row.classCode ?? '').trim()
    if (!classCode) continue
    const existed = groups.get(row.surveyId)
    if (existed) {
      if (!existed.classes.some((one) => one.classCode === classCode)) {
        existed.classes.push({ classCode, className: row.className || classCode })
      }
      continue
    }
    groups.set(row.surveyId, {
      surveyId: row.surveyId,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      itemCount: row.itemCount,
      items: row.items,
      classes: [{ classCode, className: row.className || classCode }]
    })
  }
  return [...groups.values()]
})

/** 列表里的班级文案：两个以内全列，再多就折成「A、B 等 N 个班」（title 里给全量） */
function classNamesText(item: MappingGroup): string {
  const names = item.classes.map((one) => one.className)
  if (names.length === 0) return '班级已删除'
  if (names.length <= 2) return names.join('、')
  return `${names.slice(0, 2).join('、')} 等 ${names.length} 个班`
}

const classes = ref<ClassItem[]>([])
const classesLoading = ref(false)
/** 当前选中的行（只影响高亮：淡紫底 + 左侧紫竖线，与「本地题库」的选中卡片同一口径） */
const selectedId = ref<number | null>(null)
/** 正在发布的 surveyId：那一行的「发布」转灰显示「发布中」，防连点（发布是单向的） */
const publishingId = ref<number | null>(null)
/** 待确认发布的那一条：非空即弹确认框，确认或取消后清空 */
const confirmPublish = ref<MappingGroup | null>(null)
/** 查看弹窗：只存当前看的那一条，关掉就清空 */
const viewOpen = ref(false)
const viewing = ref<MappingGroup | null>(null)
/** 右栏的四种状态：没打开 / 新建 / 修改 / 统计。三种打开态共用右栏，只是内容不同 */
const panelMode = ref<'empty' | 'create' | 'edit' | 'stat'>('empty')
/** 非空表示右栏正在修改这一条（存 surveyId）；null 表示新建模式或右栏没打开 */
const editingId = ref<number | null>(null)
/** 正在改的这一条的状态：已发布（1）时班级与题对锁定，只允许改映射名 */
const editingStatus = ref<number | null>(null)
/** 原映射有几对：万一后端没带回明细，用它提醒「要重填这么多对」 */
const editingCount = ref(0)
/** 右栏是否打开（新建 / 修改 / 统计都算） */
const isPaneOpen = computed(() => panelMode.value !== 'empty')
/** 当前是新建模式：决定标题、提交按钮文案和走哪个接口 */
const isCreate = computed(() => panelMode.value === 'create')
/** 当前是统计模式：右栏显示每题对错表 */
const isStat = computed(() => panelMode.value === 'stat')
/** 修改已发布的映射：后端只接受标题变化，班级与题对在表单里锁死并按原样提交 */
const draftLocked = computed(() => panelMode.value === 'edit' && editingStatus.value === 1)

/** 统计一页多少行（与后端 statByItemAndClasses 的默认值一致） */
const STAT_PAGE_SIZE = 10
/** 正在看统计的那条映射 */
const statSurvey = ref<MappingGroup | null>(null)
/** 统计范围：自己关联的班（classes 里就这些），默认全选，可单独取消 */
const statPicked = ref<string[]>([])
const statRows = ref<SurveyClassStatRow[]>([])
const statTotal = ref(0)
const statPage = ref(1)
const statLoading = ref(false)
const statError = ref('')
const statPageCount = computed(() =>
  Math.max(1, Math.ceil(statTotal.value / Math.max(1, STAT_PAGE_SIZE)))
)
/**
 * 右栏宽度（px）：中间的分隔条拖动时改它，最小 320，最大取页面宽的 62%。
 * 默认 540px（原来的 420 太窄，题码对和统计表都挤），窗口小的时候拖动会被夹回可用范围。
 */
const editorWidth = ref(540)
const pageRef = ref<HTMLElement | null>(null)
const submitting = ref(false)
/** 提交时的一句话错误（右栏内红字），与 toast 同时给，避免只闪一下看不清 */
const formError = ref('')
/** 重复的题码 / 题号，用于把对应输入框标红 */
const dupCodes = ref<Set<string>>(new Set())
const dupNos = ref<Set<string>>(new Set())

let nextSubKey = 1

const form = reactive<{ name: string; classCodes: string[]; subs: SubMappingDraft[] }>({
  name: '',
  classCodes: [],
  subs: []
})

/** 点班级块：选上 / 取消。已发布的映射锁定班级，点不动 */
function toggleFormClass(classCode: string): void {
  if (draftLocked.value) return
  const index = form.classCodes.indexOf(classCode)
  if (index >= 0) form.classCodes.splice(index, 1)
  else form.classCodes.push(classCode)
  clearError()
}

/** 「增加子映射」：追加一组空的题码 / 题号输入 */
function addSubMapping(): void {
  form.subs.push({ key: nextSubKey++, questionCode: '', serial: '' })
}

function removeSubMapping(sub: SubMappingDraft): void {
  const index = form.subs.indexOf(sub)
  if (index >= 0) form.subs.splice(index, 1)
  clearError()
}

/** 用户一改动就把上一次报错收掉，别让红字和红框挂在那儿 */
function clearError(): void {
  if (!formError.value && dupCodes.value.size === 0 && dupNos.value.size === 0) return
  formError.value = ''
  dupCodes.value = new Set()
  dupNos.value = new Set()
}

/**
 * 点「新建编码映射」：右栏切成新建模式（不再是弹窗）。
 * 上次填了一半关掉的表单在这里清干净，进来就是一张白纸。
 */
function openCreate(): void {
  resetForm()
  resetStat()
  editingId.value = null
  editingStatus.value = null
  editingCount.value = 0
  panelMode.value = 'create'
  // 新建的这一条还不存在，收起之前的高亮，免得看起来像在改列表里那一条
  selectedId.value = null
  if (classes.value.length === 0) void loadClasses()
}

/**
 * 点「修改」：不弹窗，右侧面板就地打开这一份映射的 考试名 / 班级 / 完整题码-题号。
 * 明细由列表接口顺带返回（SurveyMappingVo.items，按题号升序），后端 update 是全量提交：
 * - 草稿：班级与题对都能改；
 * - 已发布：后端只放行标题，班级与题对锁成只读，提交时按原样带上；
 * - 已停止收集：后端一律拒绝，这里直接把按钮置灰。
 */
function openEdit(item: MappingGroup): void {
  if (item.status === 2) {
    showInfo('已停止收集的映射不能再修改')
    return
  }
  const rows = item.items ?? []
  form.name = item.title
  form.classCodes = item.classes.map((one) => one.classCode)
  form.subs = rows.map((one) => ({
    key: nextSubKey++,
    questionCode: one.exerciseCode ?? '',
    serial: one.sortNo === null || one.sortNo === undefined ? '' : String(one.sortNo)
  }))
  formError.value = ''
  dupCodes.value = new Set()
  dupNos.value = new Set()
  resetStat()
  editingId.value = item.surveyId
  editingStatus.value = item.status ?? 0
  editingCount.value = item.itemCount ?? rows.length
  panelMode.value = 'edit'
  // 右栏打开时把那一条选中，左列表跟着高亮，视线能对上
  selectedId.value = item.surveyId
  if (classes.value.length === 0) void loadClasses()
}

/** 「修改」按钮的悬停说明：说清这一条现在能改到哪一步 */
function editHint(item: MappingGroup): string {
  if (item.status === 2) return '已停止收集，不能再修改'
  if (item.status === 1) return '已发布：只能改映射名，班级与题码-题号对锁定'
  return '修改映射名 / 班级 / 题码对'
}

/** 关掉右栏并丢弃草稿 / 统计结果（「取消」、×、保存成功后都走这里） */
function closePane(): void {
  resetForm()
  resetStat()
  editingId.value = null
  editingStatus.value = null
  editingCount.value = 0
  panelMode.value = 'empty'
}

function resetForm(): void {
  form.name = ''
  form.classCodes = []
  form.subs = []
  formError.value = ''
  dupCodes.value = new Set()
  dupNos.value = new Set()
}

/** 拉某一页。分页口径与后端 PageHelper 一致（pageNum 从 1 起算） */
async function load(page: number): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const result = await fetchSurveyMappings(page, PAGE_SIZE)
    // 当前页被清空时退回上一页，别停在空页上（与「我的收藏」同一处理）
    if (result.list.length === 0 && page > 1 && result.total > 0) {
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
      await load(Math.min(lastPage, page - 1))
      return
    }
    mappings.value = result.list
    total.value = result.total
    pageNum.value = page
    // 选中项不在这一页了（翻页、新建后回第一页）：收起高亮，别让紫条留在别处
    if (!result.list.some((item) => item.surveyId === selectedId.value)) selectedId.value = null
  } catch (err) {
    loadError.value = describeError(err)
    showError(loadError.value)
  } finally {
    loading.value = false
  }
}

function onPageChange(page: number): void {
  void load(page)
}

/** 点一行就选中它；再点一次保持选中（不做反选，避免高亮闪没） */
function select(item: MappingGroup): void {
  selectedId.value = item.surveyId
}

/**
 * 创建时间只展示到「日」。后端 Date 出参的形态取决于 Jackson 配置，可能是
 * 时间戳（秒 / 毫秒）也可能是 'yyyy-MM-dd HH:mm:ss'，这里都兼容。
 */
function formatCreatedAt(value: SurveyMappingRow['createdAt']): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string') {
    const text = value.trim()
    // 日期串直接截日期段，不进 Date，也就不会因时区差出一天
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
    const stamp = Number(text)
    return Number.isNaN(stamp) ? text : formatStamp(stamp)
  }
  return formatStamp(value)
}

/** 时间戳转日期：10 位按秒算，13 位按毫秒算 */
function formatStamp(stamp: number): string {
  const date = new Date(stamp < 1e11 ? stamp * 1000 : stamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 状态文案：后端是 TINYINT，新建时写 0（草稿），1 / 2 由问卷端流转 */
function statusText(status?: number): string {
  if (status === 1) return '已发布'
  if (status === 2) return '已停止'
  return '草稿'
}

function statusClass(status?: number): string {
  if (status === 1) return 'is-published'
  if (status === 2) return 'is-stopped'
  return 'is-draft'
}

function publishHint(item: MappingGroup): string {
  if (publishingId.value === item.surveyId) return '正在发布…'
  return item.status === 0 ? '发布这份编码映射（发布后不可再修改）' : '只有草稿可以发布'
}

/** 查看：只读弹窗。列表里没有题码明细，能看的就这几个字段 */
function openView(item: MappingGroup): void {
  viewing.value = item
  viewOpen.value = true
}

function closeView(): void {
  viewOpen.value = false
  viewing.value = null
}

/** 点「发布」：先弹确认 —— 发布后学生立即可作答、映射不能再改，不可逆 */
function onPublish(item: MappingGroup): void {
  if (item.status !== 0 || publishingId.value !== null) return
  confirmPublish.value = item
}

function cancelPublish(): void {
  confirmPublish.value = null
}

/** 确认后真正发：走后端 /background/publish/survey/mapping.do（草稿 -> 已发布） */
async function doPublish(): Promise<void> {
  const item = confirmPublish.value
  confirmPublish.value = null
  if (!item) return
  publishingId.value = item.surveyId
  try {
    await publishSurveyMapping(item.surveyId)
    showSuccess(`「${item.title}」已发布，学生现在可以作答了`)
    // 状态与按钮可操作性都由后端算，重新拉当前页；不 await，免得刷新失败被当成发布失败再报一次
    void load(pageNum.value)
  } catch (err) {
    // 已是发布状态 / 已停止收集 / 不是自己创建的 → 后端 msg 直接给人看
    showError(describeError(err))
  } finally {
    publishingId.value = null
  }
}

/**
 * 点「统计」：右栏切成统计模式（与新建 / 修改共用同一块），按这份映射的班级拉每题对错。
 * 后端只要求统计的班是自己任教的班，而本页的 classes 本来只有自己加的班，默认全选，可以单选几个班看。
 */
function onStats(item: MappingGroup): void {
  const codes = item.classes.map((one) => one.classCode)
  if (codes.length === 0) {
    showError('这份映射没有可统计的班级，班级可能已被删除')
    return
  }
  // 从新建 / 修改切过来时先丢掉草稿，两套数据不串
  resetForm()
  editingId.value = null
  editingStatus.value = null
  editingCount.value = 0
  resetStat()
  panelMode.value = 'stat'
  statSurvey.value = item
  statPicked.value = [...codes]
  selectedId.value = item.surveyId
  void loadStat(1)
}

/** 统计范围内点某个班：选中 / 取消，至少留一个（后端 classCodes 不能为空） */
function toggleStatClass(classCode: string): void {
  const index = statPicked.value.indexOf(classCode)
  if (index >= 0) {
    if (statPicked.value.length === 1) {
      showInfo('至少要保留一个班级')
      return
    }
    statPicked.value.splice(index, 1)
  } else {
    statPicked.value.push(classCode)
  }
  void loadStat(1)
}

/** 清空统计的表格与分页（关右栏、切到别的模式时用） */
function resetStat(): void {
  statSurvey.value = null
  statPicked.value = []
  statRows.value = []
  statTotal.value = 0
  statPage.value = 1
  statError.value = ''
  statLoading.value = false
}

/** 拉统计的某一页：后端按题号排序分页，一条数据都没有时按空页处理 */
async function loadStat(page: number): Promise<void> {
  const item = statSurvey.value
  if (!item) return
  const classCodes = statPicked.value.slice()
  if (classCodes.length === 0) return
  statLoading.value = true
  statError.value = ''
  try {
    const result = await fetchSurveyClassStat(item.surveyId, classCodes, page, STAT_PAGE_SIZE)
    // 当前页翻空了（数据变少）：退回最后一页，别停在空页上
    if (result.list.length === 0 && page > 1 && result.total > 0) {
      const lastPage = Math.max(1, Math.ceil(result.total / STAT_PAGE_SIZE))
      await loadStat(Math.min(lastPage, page - 1))
      return
    }
    statRows.value = result.list
    statTotal.value = result.total
    statPage.value = page
  } catch (err) {
    statError.value = describeError(err)
    showError(statError.value)
  } finally {
    statLoading.value = false
  }
}

function onStatPageChange(page: number): void {
  void loadStat(page)
}

/** 比率：后端给的是百分数值（66.67），没有作答时后端给 0，这里统一补个 % */
function formatRate(rate?: number | null): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '0%'
  return `${rate}%`
}

/** 班级下拉：后端一次给全（不分页），接口本身带当前老师的身份 */
async function loadClasses(): Promise<void> {
  classesLoading.value = true
  try {
    classes.value = await fetchClassOptions()
  } catch (err) {
    showError(describeError(err))
  } finally {
    classesLoading.value = false
  }
}

/** 报错：右栏红字 + toast，并把出错项标红（重复值由校验函数带回） */
function collectItems(): SurveyMappingItem[] | null {
  const result = validateMappingDrafts(form.subs)
  if (result.error) {
    formError.value = result.error
    dupCodes.value = new Set(result.dupCodes)
    dupNos.value = new Set(result.dupNos)
    showError(result.error)
    return null
  }
  dupCodes.value = new Set()
  dupNos.value = new Set()
  return result.items
}

/**
 * 提交右栏表单：修改走 /background/update/survey/mapping.do，
 * 新建走 /background/create/survey/mapping.do（两者都是这三样整体提交）。
 */
async function submitCreate(): Promise<void> {
  if (submitting.value) return
  const title = form.name.trim()
  if (!title) {
    formError.value = ''
    showError('请输入映射名')
    return
  }
  // 多选班级：至少一个。已发布的映射在表单里是锁定的，这里拿到的就是原值
  const classCodes = form.classCodes.slice()
  if (classCodes.length === 0) {
    formError.value = ''
    showError('请至少选择一个所属班级')
    return
  }

  dupCodes.value = new Set()
  dupNos.value = new Set()
  const items = collectItems()
  if (!items) return

  const editing = editingId.value
  submitting.value = true
  try {
    if (editing !== null) {
      await updateSurveyMapping(editing, {
        classCodes,
        title,
        items
      })
      showSuccess('已保存修改')
      // 存完退出编辑态：右栏回到空态，列表按后端结果重拉
      closePane()
      // 停在当前页：改的是这一页上的某一条，标题 / 对数都会跟着变
      void load(pageNum.value)
    } else {
      await createSurveyMapping({
        classCodes,
        title,
        items
      })
      showSuccess('已新建编码映射')
      closePane()
      // 列表以服务端为准（排序、总数、时间都是后端算的），回第一页重新拉；
      // 不 await，免得刷新失败被下面的 catch 当成「创建失败」再报一次
      void load(1)
    }
  } catch (err) {
    // 题码不存在 / 班级不属于当前账号 / 发布后不可改 等都由后端判定，msg 直接给人看
    formError.value = describeError(err)
    showError(formError.value)
  } finally {
    submitting.value = false
  }
}

// ── 右栏宽度（拖中间的分隔条）─────────────────────────────────────────────

/** 拖动分隔条改右栏宽度：最小 320，最大取页面宽的 62%，左边列表始终留得出位置 */
function startResize(event: PointerEvent): void {
  const page = pageRef.value
  if (!page) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  const handleWidth = handle.getBoundingClientRect().width
  const pageRect = page.getBoundingClientRect()
  handle.classList.add('is-dragging')

  const onMove = (moveEvent: PointerEvent): void => {
    // 指针到页面右缘的距离（减掉页面右内边距 20px）就是右栏想要的宽度
    const desired = pageRect.right - 20 - moveEvent.clientX - handleWidth / 2
    // 上限两重：不超过页面宽 62%，且左列表至少留 420（否则名字和两行按钮挤成一团）
    const maxByList = pageRect.width - 40 - 14 - 420
    const max = Math.max(320, Math.min(Math.round(pageRect.width * 0.62), maxByList))
    editorWidth.value = Math.min(max, Math.max(320, Math.round(desired)))
  }
  const onUp = (): void => {
    handle.classList.remove('is-dragging')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

onMounted(async () => {
  void load(1)
  // 新建面板的班级块要用自己的班列表，和列表并行拉即可
  await loadClasses()
})
</script>

<style scoped>
/* 版式照「本地题库」：左边映射列表，右边修改面板，中间一条可拖的分隔条。
   三列 = 列表 / 分隔条 / 右栏（宽度由 --editor-width 控制）；
   三行 = 工具条 / 列表正文 / 分页条（分页只在左栏底下，不横穿右栏）。 */
.mapping-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 14px var(--editor-width, 540px);
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  padding: 16px 20px 0;
  box-sizing: border-box;
  /* 滚动交给正文区，分页条才能一直贴在底部 */
  overflow: hidden;
}

/* 顶部工具条：左右分布，靠左起排 */
.list-toolbar {
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

.new-btn {
  width: auto;
  white-space: nowrap;
  height: 30px;
  padding: 0 16px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  border: 1px solid #7c5cd6;
  border-radius: 8px;
  background: #7c5cd6;
  box-shadow: 0 3px 8px rgba(124, 92, 214, 0.28);
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.new-btn:hover {
  border-color: #6b49c8;
  background: #6b49c8;
}

.mapping-body {
  grid-column: 1;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  /* 长列表在正文里滚，分页条留在底部不动 */
  overflow: auto;
}

/* 分页条固定在左下角，宽度只跟左栏走 */
.mapping-footer {
  grid-column: 1;
  grid-row: 3;
  width: 100%;
}

/* ── 中间的拖拽分隔条 ─────────────────────────────────────────────────── */

.mapping-resizer {
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

.mapping-resizer-grip {
  display: block;
  width: 3px;
  height: 64px;
  border-radius: 999px;
  background: #dfe4ec;
  transition: width 0.15s ease, height 0.15s ease, background-color 0.15s ease,
    box-shadow 0.15s ease;
}

.mapping-resizer:hover .mapping-resizer-grip,
.mapping-resizer.is-dragging .mapping-resizer-grip {
  width: 5px;
  height: 88px;
  background: #7c5cd6;
  box-shadow: 0 0 0 4px rgba(124, 92, 214, 0.12);
}

/* ── 右侧：修改面板 ───────────────────────────────────────────────────── */

.mapping-editor-pane {
  grid-column: 3;
  grid-row: 2 / span 2;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* 分页条贴底，右栏留同样一条缝，两栏下缘才齐 */
  margin-bottom: 12px;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 12px;
  background: var(--admin-surface, #fff);
  overflow: hidden;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.mapping-editor-pane.is-editing {
  border-color: rgba(139, 92, 246, 0.4);
  box-shadow: 0 6px 20px rgba(139, 92, 246, 0.1);
}

.editor-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid #eef1f6;
}

.editor-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.editor-close {
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
  color: #e5534b;
  border-color: rgba(229, 83, 75, 0.4);
  background: #fff6f5;
}

/* 空态：还没点「修改」 */
.editor-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px 22px;
  text-align: center;
}

.editor-empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #6b7789;
}

.editor-empty-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: #9aa5b5;
}

.editor-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  overflow-y: auto;
  /* 让题码对的 @container 按右栏实际宽度决定一行两对还是一对 */
  container-type: inline-size;
}

/* ── 右栏统计：标题条 + 5 列对错表 ─────────────────────────────────────── */
.stat-head {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 14px 0;
}

.stat-title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.stat-name {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat-total {
  flex: none;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 统计范围：一排可点的小班级块，默认全选，点掉几个就只看剩下的班 */
.stat-class-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.stat-class-label {
  flex: none;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 数字列宽固定，题码列吃剩余宽度，窄栏里用省略号截断 */
.stat-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.stat-table th,
.stat-table td {
  padding: 7px 4px;
  text-align: right;
  border-bottom: 1px solid #f0f3f8;
}

.stat-table th {
  padding-top: 4px;
  font-weight: 500;
  color: var(--admin-text-weak, #8492a6);
  white-space: nowrap;
  border-bottom-color: var(--admin-border, #d8dee6);
}

/* 数字列定宽：正确/错误数 44，比率 54（「100%」也放得下）；
   剩下全给题码，右栏拖到最小 320 时 10 位题码仍能完整显示 */
.stat-table th:nth-child(2),
.stat-table th:nth-child(3) {
  width: 44px;
}

.stat-table th:nth-child(4),
.stat-table th:nth-child(5) {
  width: 54px;
}

.stat-table .stat-code {
  text-align: left;
  color: var(--admin-text, #1f2d3d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat-table tbody tr:last-child td {
  border-bottom: none;
}

.stat-table tbody tr:hover td {
  background: rgba(245, 243, 255, 0.7);
}

/* 统计的翻页：两个 editor-btn 撑满，中间夹页码 */
.stat-page {
  flex: none;
  align-self: center;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
  font-variant-numeric: tabular-nums;
}

/* 小标题：题码—题号 + 对数 */
.editor-section-title {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.editor-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--admin-text-weak, #8492a6);
}

/* 右栏的子映射头部：标题在左、按钮在右 */
.editor-body .sub-head {
  justify-content: space-between;
}

/* 每行两对：序号 / 题码 / 题号 / 删除，两列等分，奇数个时最后一行留空半格 */
.sub-table {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 10px;
}

.sub-pair {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.sub-index {
  flex: none;
  width: 15px;
  font-size: 11px;
  color: var(--admin-text-weak, #8492a6);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.sub-pair .field-input {
  height: 30px;
  padding: 0 7px;
}

/* 题码吃掉剩余宽度，题号固定 46px 居中 */
.sub-pair .field-input:first-of-type {
  flex: 1 1 auto;
  min-width: 0;
}

.sub-pair .field-input.is-narrow {
  flex: 0 0 46px;
  padding: 0 4px;
  text-align: center;
}

/* 删除按钮压到 18px：两列并排时给题码让出宽度 */
.sub-pair .sub-remove {
  flex: none;
  width: 18px;
  height: 18px;
  font-size: 14px;
}

/* 右栏被拖到 < 340px 时两列太挤，退成一列（容器查询按 editor-body 的实际宽度判断） */
@container (max-width: 340px) {
  .sub-table {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* 底部操作：取消 / 保存修改，等宽两颗 */
.editor-actions {
  flex: none;
  display: flex;
  flex-direction: row;
  gap: 8px;
  padding: 11px 14px;
  border-top: 1px solid #eef1f6;
  background: #fbfcfe;
}

.editor-btn {
  flex: 1 1 0;
  height: 32px;
  font-family: inherit;
  font-size: 13px;
  color: #6b7789;
  border: 1px solid #e2e6ee;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
}

.editor-btn:hover:not(:disabled) {
  color: #6b49c8;
  border-color: rgba(124, 92, 214, 0.45);
  background: #faf9ff;
}

.editor-btn.is-primary {
  color: #fff;
  font-weight: 600;
  border-color: #7c5cd6;
  background: #7c5cd6;
}

.editor-btn.is-primary:hover:not(:disabled) {
  border-color: #6b49c8;
  background: #6b49c8;
}

.editor-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.mapping-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0 2px 0 0;
  list-style: none;
}

/* 一份映射一行：上排「映射名 + 状态徽章」，下排「班级名」；行高 88px，
   宽度收窄（不再铺满面板），操作按钮靠右 */
.mapping-item {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  max-width: 560px;
  min-height: 88px;
  /* 行高由 min-height 撑起来，内容上下居中；左右留白比上下多，给名字留呼吸 */
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

/* 选中：淡紫底 + 左缘紫竖线，取自「本地题库」选中卡片 */
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

/* 左侧内容：映射名 + 徽章一行，班级名一行，都从左边起排 */
.mapping-main {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}

.mapping-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}

.mapping-name {
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 状态徽章：草稿琥珀、已发布绿、已停止灰 */
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

/* 映射名下方一行：班级名（+ 题码对数），从左边起排 */
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

/* 分隔小圆点，比竖线轻 */
.meta-dot {
  flex: none;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--admin-border, #d8dee6);
}

/* 右侧动作区：一行四颗，宽度固定，按钮平分这一行 */
.mapping-actions {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 208px;
}

.act-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.act-row .act {
  flex: 1 1 0;
  min-width: 0;
}

/* 动作按钮：21px 高（原 32px 减掉三分之一），12px 字 + 6px 圆角，
   小字号配小圆角，与行卡片的 10px 圆角不打架。
   层级由弱到强：查看 / 统计（灰描边）< 修改（浅紫底）< 发布（紫实心） */
.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 21px;
  padding: 0 8px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease, border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.act:active:not(:disabled) {
  transform: translateY(0.5px);
}

/* 只在键盘聚焦时描环，鼠标点过不留圈 */
.act:focus-visible {
  outline: 2px solid rgba(124, 92, 214, 0.45);
  outline-offset: 1px;
}

/* 查看 / 统计：中性 ghost，一组里最轻的两颗 */
.act-view,
.act-stats {
  color: #6b7789;
  border-color: #e2e6ee;
  background: #fff;
}

.act-view:hover,
.act-stats:hover {
  color: #6b49c8;
  border-color: rgba(124, 92, 214, 0.4);
  background: #faf9ff;
}

/* 修改：浅紫底 + 紫字，hover 反白成实心紫 */
.act-edit {
  color: #6b49c8;
  border-color: rgba(124, 92, 214, 0.16);
  background: #f1ecfb;
}

.act-edit:hover {
  color: #fff;
  border-color: #7c5cd6;
  background: #7c5cd6;
}

/* 发布：唯一的实心主按钮，用极轻的竖向渐变 + 1px 投影做出「可按」的厚度 */
.act-publish {
  color: #fff;
  font-weight: 600;
  border-color: #7c5cd6;
  background: linear-gradient(180deg, #8a6ce0 0%, #7c5cd6 100%);
  box-shadow: 0 1px 2px rgba(124, 92, 214, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.16);
}

.act-publish:hover:not(:disabled) {
  border-color: #6b49c8;
  background: linear-gradient(180deg, #7f61d9 0%, #6b49c8 100%);
  box-shadow: 0 2px 6px rgba(124, 92, 214, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.18);
}

/* 非草稿的「发布」：降成灰底占位，不抢视线，也不给人「可点」的错觉 */
.act-publish:disabled {
  color: #a3adbd;
  font-weight: 500;
  border-color: #e6eaf1;
  background: #f4f6f9;
  box-shadow: none;
  cursor: not-allowed;
}


/* 「查看」弹窗里的只读字段表 */
.detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}

.detail-row {
  display: flex;
  flex-direction: row;
  gap: 12px;
  font-size: 13px;
  line-height: 20px;
}

.detail-row dt {
  flex: none;
  width: 72px;
  color: var(--admin-text-weak, #8492a6);
}

.detail-row dd {
  display: flex;
  align-items: center;
  margin: 0;
  color: var(--admin-text, #1f2d3d);
  word-break: break-all;
}

.detail-tip {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

.state {
  padding: 8px 0;
  font-size: 14px;
  color: var(--admin-text-weak, #8492a6);
}

.state.is-error {
  color: #e5534b;
}

/* 表单字段（右栏的新建 / 修改） */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

/* 班级多选：圆角小块，选中的那块淡紫底 + 紫边，一眼看出选了哪几个班 */
.class-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.class-chip {
  max-width: 100%;
  height: 28px;
  padding: 0 12px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 14px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease, border-color 0.16s ease;
}

.class-chip:hover:not(:disabled) {
  color: #6d5bd0;
  border-color: rgba(124, 92, 214, 0.42);
}

.class-chip.is-on {
  color: #5b48c0;
  font-weight: 600;
  border-color: rgba(124, 92, 214, 0.55);
  background: #f3f0ff;
}

.class-chip:disabled {
  cursor: default;
  opacity: 0.7;
}

/* 锁定的已勾选班仍要看清是哪几个，不跟着变淡 */
.class-chip.is-on:disabled {
  opacity: 1;
}

.class-chip.is-mini {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}

.field-input {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  outline: none;
  box-sizing: border-box;
}

.field-input:focus {
  border-color: var(--admin-primary, #2d8cf0);
}

/* 重复项标红：解析器的校验结果落在具体某个输入框上，比只看 toast 直观 */
.field-input.is-invalid {
  border-color: #e5534b;
  background: #fff6f5;
}

.field-hint {
  margin: 0;
  font-size: 12px;
  color: var(--admin-text-weak, #8492a6);
}

/* 修改模式的提醒：琥珀底一句话，比普通提示显眼，但不至于像报错 */
.field-hint.is-warn {
  padding: 7px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: #a16207;
  border: 1px solid #f2e2b8;
  border-radius: 6px;
  background: #fdf8e8;
}

.form-error {
  margin: 0;
  font-size: 12px;
  color: #e5534b;
}

/* ── 子映射 ───────────────────────────────────────────────────────────── */
.sub-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--admin-border, #d8dee6);
}

.sub-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
}

.add-sub-btn {
  width: auto;
  white-space: nowrap;
  height: 24px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 12px;
  color: var(--admin-primary, #2d8cf0);
  border: 1px solid var(--admin-primary, #2d8cf0);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
}

.add-sub-btn:hover {
  color: #fff;
  background: var(--admin-primary, #2d8cf0);
}

.sub-remove {
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: var(--admin-text-weak, #8492a6);
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.sub-remove:hover {
  color: #e5534b;
  border-color: #e5534b;
}

</style>
