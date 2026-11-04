<template>
  <!-- 审查题卡：与 MathBank import.js 的 parsed-card 模板逐类对齐。
       q 由父组件以 reactive 数组元素传入，本组件直接改其字段（可编辑卡的语义）；
       预览为自研轻量行渲染（MathJax 引擎出公式，见脚本区的实现说明）。 -->
  <article
    class="glass-card rounded-xl p-4 space-y-3 flex flex-col relative"
    :class="{ 'opacity-90': saved }"
  >
    <!-- Card Top Configs Bar：题型/难度来自字典表，题型按本题科目筛 -->
    <div class="grid grid-cols-2 sm:grid-cols-6 gap-2 border-b pb-3 shrink-0">
      <div class="flex items-center space-x-2 select-none text-slate-700 text-xs font-bold">
        <input
          type="checkbox"
          class="card-select-checkbox h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 cursor-pointer transition-colors"
          :disabled="saved"
          :checked="selected"
          @click.stop
          @change="emit('update:selected', ($event.target as HTMLInputElement).checked)"
        />
        <span
          class="h-5 w-5 bg-brand-50 text-brand-600 rounded-full flex items-center justify-center text-[10px] font-bold border border-brand-100"
        >
          {{ index + 1 }}
        </span>
      </div>
      <select
        v-model="q.subjectTypeCode"
        class="glass-select px-2 py-1.5 rounded-lg text-[10px] font-semibold"
        :class="{ 'text-amber-600': !q.subjectTypeCode }"
        aria-label="题型"
      >
        <!-- 未启用题型分类时模型不返回题型：留一个不可选的占位项，免得下拉显示成第一项
             而实际值是空串，用户以为已经选好了 -->
        <option v-if="!q.subjectTypeCode" value="" disabled>请选择题型</option>
        <option v-for="opt in typeOptions" :key="opt.code" :value="opt.code">
          {{ opt.name }}
        </option>
      </select>
      <select
        v-model="q.easy"
        class="glass-select px-2 py-1.5 rounded-lg text-[10px] font-semibold"
        aria-label="难度"
      >
        <option v-for="opt in easyOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <select
        v-model="q.classLevel"
        class="glass-select px-2 py-1.5 rounded-lg text-[10px] font-semibold"
        aria-label="年级"
      >
        <!-- 跨年级 = 整个学段通用：值直接写本题学段码（senior/junior/primary），
             与题库里的约定一致（store.ts 允许学段码作 class_level）。
             历史/模型给的空串另补一条，别让它显示成空白。 -->
        <option v-if="q.classLevel === '' && crossGradeValue !== ''" value="">
          跨年级（未指定学段）
        </option>
        <option :value="crossGradeValue">{{ crossGradeLabel }}</option>
        <option v-for="opt in classLevelOptions" :key="opt.code" :value="opt.code">
          {{ opt.name }}
        </option>
      </select>
      <!-- 跨年级（整个学段）没有学期概念：禁用并清空，导入时也不写学期 -->
      <select
        v-model="q.term"
        class="glass-select px-2 py-1.5 rounded-lg text-[10px] font-semibold"
        :disabled="isCrossGrade"
        :title="isCrossGrade ? '跨年级题不区分学期' : ''"
        aria-label="学期"
      >
        <option value="">未填学期</option>
        <option value="1">上学期</option>
        <option value="2">下学期</option>
      </select>
      <input
        v-model="source"
        type="text"
        class="glass-input px-2.5 py-1.5 rounded-lg text-[10px] font-semibold"
        placeholder="题目来源"
      />
    </div>

    <!-- Knowledge points -->
    <div
      v-if="q.knowledgePoints.length > 0"
      class="rounded-lg border border-slate-200 p-3 space-y-2"
      aria-label="本题知识点分类"
    >
      <strong class="text-xs text-slate-700">知识点分类</strong>
      <div
        v-for="kp in q.knowledgePoints"
        :key="kp.code"
        class="flex flex-wrap items-center gap-2 text-[11px]"
      >
        <span class="text-slate-700">{{ kp.name }}</span>
        <select v-model="kp.role" class="glass-select text-[11px]" :aria-label="kp.name + '考查作用'">
          <option value="main">主要考查</option>
          <option value="auxiliary">辅助涉及</option>
        </select>
        <button
          type="button"
          class="text-[11px] font-semibold text-slate-500 hover:text-rose-600 transition-colors"
          @click="removeKnowledgePoint(kp.code)"
        >
          移除
        </button>
        <details v-if="kp.evidence || kp.reason" class="w-full text-slate-500">
          <summary class="cursor-pointer select-none">查看依据</summary>
          <p v-if="kp.evidence" class="mt-1 leading-relaxed">{{ kp.evidence }}</p>
          <p v-if="kp.reason" class="mt-1 leading-relaxed">{{ kp.reason }}</p>
        </details>
      </div>
    </div>

    <!-- Body Content Split

         左「编辑」右「渲染预览」，两栏严格等高，行高写死在容器上（BODY_HEIGHT）：
         预览框的上边框贴「题干编辑」的上边框，下边框贴「答案与解析编辑」的下边框；
         内容超出时预览框内滚动，绝不撑大（见 BODY_HEIGHT 的注释）。

         为什么行内样式和 CSS 双份（数值一致，见 daoru-center.css 的 .pc-*）：
         这套高度是布局契约，之前只写 CSS 时踩过坑 —— 规则明明在文件里，运行时却
         没生效，右栏被渲染内容顶高、两栏下边线错开，查问题时很难看出「样式在文件
         里但没应用」。双份后哪条先到都生效。改高度请同时改 BODY_HEIGHT 与
         daoru-center.css 里 .pc-body 的 height。 -->
    <div
      class="pc-body grid grid-cols-1 md:grid-cols-2 gap-4"
      :style="{ height: BODY_HEIGHT + 'px' }"
    >
      <!-- Left: editors -->
      <div class="pc-edit-col" style="min-height: 0">
        <div class="pc-edit-field">
          <div class="flex items-center">
            <label class="text-[9px] font-bold text-slate-500 tracking-wider">题干编辑</label>
            <!-- 插入长空白：4 个全角空格（U+3000），与编辑器工具栏同一串。
                 紧挨「题干编辑」标签，间距 20px（ml-5）。
                 @mousedown.prevent 防止按钮抢焦点，光标位置得以保留。 -->
            <button
              type="button"
              class="pc-insert-blank ml-5"
              title="插入长空白（4 个全角空格）"
              aria-label="插入长空白（4 个全角空格）"
              @mousedown.prevent
              @click="insertLongBlank(contentEl)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6H5v12h4"/>
                <path d="M15 6h4v12h-4"/>
              </svg>
            </button>
          </div>
          <textarea
            ref="contentEl"
            v-model="q.content"
            class="glass-input w-full p-2.5 rounded-lg font-mono text-[10px] resize-none custom-scrollbar"
            spellcheck="false"
          ></textarea>
        </div>
        <div class="pc-edit-field">
          <div class="flex items-center">
            <label class="text-[9px] font-bold text-slate-500 tracking-wider">答案与解析编辑</label>
            <!-- 插入长空白：与题干编辑同款（4 个全角空格，紧挨标签、间距 20px） -->
            <button
              type="button"
              class="pc-insert-blank ml-5"
              title="插入长空白（4 个全角空格）"
              aria-label="插入长空白（4 个全角空格）"
              @mousedown.prevent
              @click="insertLongBlank(answerEl)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6H5v12h4"/>
                <path d="M15 6h4v12h-4"/>
              </svg>
            </button>
          </div>
          <textarea
            ref="answerEl"
            v-model="q.answerMarkdown"
            class="glass-input w-full p-2.5 rounded-lg font-mono text-[10px] resize-none custom-scrollbar"
            spellcheck="false"
          ></textarea>
        </div>
      </div>

      <!-- Right: realtime preview（全新实现）
           公式走主编辑器同一套数学引擎（默认 MathJax），正文为自研行渲染；
           题干与答案各渲染一块，中间留白分隔，全程不产生任何线条。 -->
      <div class="pc-preview-col">
        <div class="flex items-center justify-between gap-2">
          <label class="text-[9px] font-bold text-slate-500 tracking-wider">渲染预览</label>
        </div>
        <div class="pc-preview rounded-xl bg-slate-50/60 text-xs font-serif leading-relaxed custom-scrollbar select-text">
          <div ref="previewEl" class="pc-preview-content"></div>
        </div>
      </div>
    </div>

    <!-- Card Actions Footer -->
    <div class="border-t border-slate-100 pt-3 shrink-0">
      <div
        v-if="q.referencedImages.length > 0"
        class="flex flex-wrap items-center gap-1.5 pb-2"
        aria-label="本题配图文件"
      >
        <span
          v-for="src in q.referencedImages"
          :key="src"
          class="text-[9px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded"
          :title="src"
        >
          {{ fileNameOf(src) }}
        </span>
      </div>
      <!-- 入库失败原因常驻在这里：toast 2.6 秒就淡出，而「导入后题库里没有」
           这件事是过一会儿才发现的。颜色写字面量而不加新工具类 —— 这份样式是
           Tailwind 的静态产物，加类就得重跑一遍生成流程。 -->
      <p
        v-if="q.importError"
        class="flex items-center gap-1.5 pb-2 text-[9px] font-semibold"
        style="color: #e11d48"
        role="alert"
      >
        <i class="fa-solid fa-circle-exclamation"></i>
        <span>{{ q.importError }}</span>
      </p>
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="glass-btn text-indigo-700 font-bold px-3 py-1.5 rounded-lg text-[10px] flex items-center space-x-1 shrink-0"
          :disabled="generating"
          :title="generating ? '正在调用模型生成解析…' : '对本题单独调用 AI 生成详细解答与解析'"
          @click="emit('regenerate', index)"
        >
          <i
            class="fa-solid"
            :class="generating ? 'fa-spinner fa-spin text-indigo-400' : 'fa-wand-magic-sparkles text-indigo-500'"
          ></i>
          <span>{{ generating ? '生成中…' : q.answerMarkdown ? '重生成解析' : 'AI 生成解析' }}</span>
        </button>
        <button
          type="button"
          class="px-4 py-1.5 rounded-lg text-[10px] flex items-center space-x-1 shrink-0 glass-btn text-brand-700 font-bold"
          :disabled="importing"
          :title="importing ? '正在写入本地题库…' : undefined"
          @click="emit('import', index)"
        >
          <!-- 用 FontAwesome 的 fa-spin 而不是 Tailwind 的 animate-spin：这份样式是
               静态生成的产物，加一个工具类就得重跑整条 Tailwind 生成流程 -->
          <i
            class="fa-solid"
            :class="importing ? 'fa-spinner fa-spin' : saved ? 'fa-rotate-right' : 'fa-file-arrow-up'"
          ></i>
          <span>{{ importing ? '导入中…' : saved ? '再次导入' : '导入此题' }}</span>
        </button>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { isStageCode, stageLabelOf } from '../utils/class-level'
import { renderMarkdownSection } from '../utils/extension-preview'
import { LONG_BLANK } from '../utils/md-syntax'
import type { EditableQuestion } from '../utils/math-parse'
import type { MathParseCatalog } from '../../preload/index'

/**
 * 卡片正文（左编辑 / 右预览）这一行的高度，**固定值**。
 *
 * 预览框的上边框贴「题干编辑」的上边框、下边框贴「答案与解析编辑」的下边框，
 * 全靠这行高度定死：左栏两个输入框各分一半，右栏预览撑满其余，内容超出时
 * 在框内滚（overflow-y: auto），绝不把框撑高或缩矮。
 */
const BODY_HEIGHT = 250

const props = defineProps<{
  question: EditableQuestion
  index: number
  selected: boolean
  catalog: MathParseCatalog
  /** 正在写库：按钮禁用并显示「导入中…」 */
  importing: boolean
  /** 正在调模型生成解析：按钮禁用并显示「生成中…」 */
  generating: boolean
}>()
const emit = defineEmits<{
  'update:selected': [value: boolean]
  import: [index: number]
  regenerate: [index: number]
}>()

// q 故意是可变引用：编辑卡的全部意义就是就地改这份拆题草稿。
// 父组件持有 reactive 数组，这里的写入会直接反映到「导入选中」的载荷里。
const q = props.question
const saved = computed(() => q.saved === true)

// source 在 JSON 里是 null（无来源），textarea 需要字符串
const source = computed({
  get: () => q.source ?? '',
  set: (v: string) => {
    q.source = v.trim() || null
  }
})

// ── 下拉候选（全部来自字典表，按本题科目筛） ──────────────────────────────
//
// subjectTypes 的 parent 是科目码：一道物理题不该在下拉里看到「完形填空」，
// 主进程的 SUBJECT_TYPE_MISMATCH 校验也会拒。没有 parent 的历史行一律放行。
//
// 题型在字典里按「科目 × 学段」各存一行（高中/初中的“单选题”是两行不同
// code），只按科目筛会把所有学段的同名题型全部倒进下拉 —— 下拉里“单选题”
// 重复十几条就是这么来的。规则与主进程拆题侧（store.ts 取题型清单）一致：
// 先取本学段的行；该学段没有专用行时回退到没限定学段（stage 为空）的历史
// 行；最后按 code 去重兜底（库里还有 8 行 class_level 为 NULL 的历史脏数据）。
const typeOptions = computed(() => {
  const matched = props.catalog.subjectTypes.filter(
    (item) => item.parent === q.subjectCode
  )
  const stageRows = matched.filter((item) => item.stage && item.stage === q.stage)
  const unfiltered = stageRows.length ? stageRows : matched.filter((item) => !item.stage)
  const seen = new Set<string>()
  const list = unfiltered.filter((item) => {
    if (seen.has(item.code)) return false
    seen.add(item.code)
    return true
  })
  return withCurrentOption(list.map((item) => ({ code: item.code, name: item.name })), {
    code: q.subjectTypeCode,
    name: q.subjectTypeCode
  })
})

const easyOptions = computed(() => {
  const list = props.catalog.easyLevels?.length
    ? props.catalog.easyLevels
    : [
        { value: '1', label: '很易' },
        { value: '2', label: '易' },
        { value: '3', label: '中' },
        { value: '4', label: '难' },
        { value: '5', label: '拔高' }
      ]
  return list
})

const classLevelOptions = computed(() => {
  // 本题学段由解析前那次选择决定，年级只列该学段的 —— 小学题不该能选「高三」
  const list = props.catalog.classLevels
    .filter((item) => !q.stage || item.parent === q.stage)
    .map((item) => ({ code: item.code, name: item.name }))
  // 模型/历史数据给的年级可能不在字典里：并进去，否则下拉显示空白而保存又能过
  return withCurrentOption(list, { code: q.classLevel, name: q.classLevel })
})

// 「跨年级」= 整个学段通用，值就是本题学段码；没有学段时退回空串（未指定）
const crossGradeValue = computed(() => (isStageCode(q.stage) ? q.stage : ''))

const crossGradeLabel = computed(() => {
  const label = stageLabelOf(crossGradeValue.value)
  return label ? `跨年级（${label}）` : '跨年级'
})

// 跨年级题没有学期：切到跨年级就清空下拉（immediate 处理编辑已有数据的情形），
// 入库时 toExerciseInput 还会再忽略一次 —— 界面与载荷两头都不留脏值
const isCrossGrade = computed(() => isStageCode(q.classLevel))
watch(
  () => q.classLevel,
  (value) => {
    if (isStageCode(value)) q.term = ''
  },
  { immediate: true }
)

/** 当前值不在候选里时补一条 —— 空白 option 比错值更难排查 */
function withCurrentOption<T extends { code: string; name: string }>(
  list: T[],
  current: { code: string; name: string }
): T[] {
  if (!current.code || isStageCode(current.code) || list.some((item) => item.code === current.code)) {
    return list
  }
  return [...list, { code: current.code, name: `${current.name}（不在当前字典）` } as T]
}

function removeKnowledgePoint(code: string): void {
  q.knowledgePoints = q.knowledgePoints.filter((kp) => kp.code !== code)
}

// ── 实时渲染预览（完整扩展语法版） ────────────────────────────────────────
//
// 渲染能力与「录入题目」右侧预览完全对齐：解析管线镜像编辑器的 remark 插件
// 装配顺序（拼音、着重号、下划线、上下标、带圈序号、田字格、分栏、字体块、
// 空行线、高亮、表格、列表等全部支持），公式走同一数学引擎（默认 MathJax）。
// 解析与 DOM 渲染的实现见 utils/extension-preview.ts。
//
// 题干 / 答案各自渲染一块（.pc-preview-answer 用留白分隔，无线）；整行 `---`
// （模型拆题记号）在渲染前删除，预览不产生分割线。

const previewEl = ref<HTMLElement | null>(null)

// ── 编辑框：插入长空白（4 个全角空格 U+3000） ────────────────────────────
//
// 题干与答案两个编辑框共用：走原生 value setter + input 事件，让 v-model 自然
// 同步；插入后光标落在插入串末尾。按钮上有 @mousedown.prevent，textarea 的
// 焦点与光标不会丢。
const contentEl = ref<HTMLTextAreaElement | null>(null)
const answerEl = ref<HTMLTextAreaElement | null>(null)

function insertLongBlank(ta: HTMLTextAreaElement | null): void {
  if (!ta) return
  const from = ta.selectionStart ?? ta.value.length
  const to = ta.selectionEnd ?? from
  const next = ta.value.slice(0, from) + LONG_BLANK + ta.value.slice(to)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter) setter.call(ta, next)
  else ta.value = next
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  const caret = from + LONG_BLANK.length
  ta.setSelectionRange(caret, caret)
  ta.focus()
}

function fileNameOf(src: string): string {
  const flat = src.replace(/\\/g, '/')
  return flat.slice(flat.lastIndexOf('/') + 1) || src
}

/**
 * 题干 / 答案 → 渲染好的块容器（解析与 DOM 输出见 utils/extension-preview.ts）。
 * 整行 `---`（拆题记号）已在渲染器内部删除；空内容返回 null，不占位。
 */
function renderSection(source: string, className: string): HTMLElement | null {
  return renderMarkdownSection(source, className)
}

/** 同步重渲：题干、答案各一块（.pc-preview-answer 用留白分隔，无线） */
function renderPreview(): void {
  const root = previewEl.value
  if (!root) return
  root.replaceChildren()
  const content = renderSection(q.content ?? '', 'pc-preview-question')
  if (content) root.append(content)
  const answer = renderSection(q.answerMarkdown ?? '', 'pc-preview-answer')
  if (answer) root.append(answer)
}

let previewTimer: number | undefined
watch(
  () => [q.content, q.answerMarkdown],
  () => {
    if (previewTimer !== undefined) window.clearTimeout(previewTimer)
    // 150ms：连续打字时不逐键重渲，停手即刻刷新（MathJax 单次渲染毫秒级，足够实时）
    previewTimer = window.setTimeout(renderPreview, 150)
  }
)
onMounted(renderPreview)
</script>
