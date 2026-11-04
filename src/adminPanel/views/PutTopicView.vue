<template>
  <div class="put-topic-page">
    <!-- id="editor" 不是笔误：主题（base.css / premium.css）里的排版规则全部写成
         `#editor .ProseMirror …` 形式，右侧预览要长得和编辑器里一样，就得落在这个 id
         底下。宿主本体的 #editor 在 body.admin-panel-view 下被隐藏了，且文档顺序里
         这个 #editor 排在宿主那个前面（#admin-panel 在前）—— 两者都记在下面样式里。 -->
    <div id="editor" class="put-body">
      <!-- 两栏的高度由 flex-grow 分（.entry 是 flex: 1 1 0），比例存在 topicShare
           里；答案那一条工具条正好压在两栏的分界线上，它就是拖动面。 -->
      <section
        v-for="entry in ENTRY_LIST"
        :key="entry.root"
        :ref="(el) => setSection(entry, el)"
        class="entry"
        :class="{ 'is-resizable': entry === answerEntry }"
        :style="entryStyle(entry)"
      >
        <EditorToolbar
          :tag="entry.tag"
          @insert="onInsert(entry, $event)"
          @block="onBlock(entry, $event)"
          @font="onFont(entry, $event)"
          @size="onSize(entry, $event)"
          @symbol="onSymbol(entry, $event)"
          @image="onInlineMarkdown(entry, $event)"
          @tianzi="onInlineMarkdown(entry, $event)"
          @table="onTable(entry, $event)"
          @math="onMath(entry, $event)"
          @subblock="onBlockMarkdown(entry, $event)"
          @cols="onBlockMarkdown(entry, $event)"
          @pointerdown="onToolbarPointerDown(entry, $event)"
        />
        <div class="entry-split">
          <!-- 左边：markdown 源文本。这一页的真相就在这两个 textarea 里，提交时原样
               送后端；右边只是它的渲染结果。 -->
          <textarea
            :ref="(el) => setInput(entry, el)"
            v-model="entry.text.value"
            class="md-input"
            spellcheck="false"
            :placeholder="entry.placeholder"
            @scroll="onInputScroll(entry, $event)"
          ></textarea>
          <!-- 右边：只读预览。内容由 watch 驱动 setMarkdown 刷新，交互由这里锁掉。 -->
          <div class="preview-pane">
            <div :id="entry.root" class="preview-root"></div>
          </div>
        </div>
      </section>
    </div>

    <footer class="put-foot">
      <!-- 元信息与题目、答案同属一次提交，值放在这一层持有：打包和校验顺序都由这里定。
           表单本体收进右侧抽屉，提交条上只留一个「附加信息」按钮。 -->
      <TopicMetaForm v-model="meta" />

      <!-- 与标题栏「提交」按钮（main.ts 的 uploadGlyph）一模一样：文字 + 上传图标 -->
      <button
        class="btn is-primary is-block"
        type="button"
        :disabled="submitting"
        @click="onSubmit"
      >
        {{ submitting ? '提交中…' : '提交' }}
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
          <path d="M8 11.4V4.4" />
          <path d="M4.9 7.5 8 4.4l3.1 3.1" />
          <path d="M3.8 12.6h8.4" />
        </svg>
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance,
  type Ref
} from 'vue'
import {
  hasEditor,
  setMarkdown
} from '../../renderer/editor/editor'
import { hasLivePreview, mountReadonlyPreview } from '../utils/readonly-preview'
import EditorToolbar from '../components/EditorToolbar.vue'
import TopicMetaForm from '../components/TopicMetaForm.vue'
import { submitSubject, submitSubjectWithImages } from '../api/topics'
import { session } from '../stores/session'
import { describeError, showError, showInfo, showSuccess } from '../stores/toast'
import { bumpTopicsVersion } from '../stores/topic-events'
import { classLevelCode } from '../utils/class-level'
import { checkPhotoLimits, extractEmbeddedImagesAsync, type ExtractResult } from '../utils/topic-images'
import {
  applyHeading,
  applyInlineFont,
  insertBlockMarkdown,
  insertPlain,
  insertSyntax,
  tableMarkdown,
  type BlockKind,
  type InsertResult,
  type SyntaxKey
} from '../utils/md-syntax'
import { blankProblem, createMeta, firstMetaProblem } from '../utils/topic-meta'

/**
 * 一栏 = 标签 / 源文本 / 预览挂载点。
 *
 * 文本存在普通的 ref 里而不是编辑器状态里：这页的输入是纯文本，浏览器的 textarea
 * 原生就带撤销、输入法、选区，预览那边只是它的一个渲染结果。
 */
interface Entry {
  tag: string
  placeholder: string
  /** 预览编辑器 createEditor 的挂载元素 id */
  root: string
  text: Ref<string>
  /** 回调式 ref 拿到的 textarea 本体，插语法时读它的选区 */
  input: HTMLTextAreaElement | null
  /** 回调式 ref 拿到的这一栏本体，拖分界线时量高度用 */
  el: HTMLElement | null
}

const topicEntry: Entry = {
  tag: '题目',
  placeholder: '请编辑题目内容（markdown 语法，右侧实时预览）',
  root: 'preview-topic',
  text: ref(''),
  input: null,
  el: null
}
const answerEntry: Entry = {
  tag: '答案',
  placeholder: '请编辑答案内容（markdown 语法，右侧实时预览）',
  root: 'preview-answer',
  text: ref(''),
  input: null,
  el: null
}
const ENTRY_LIST: Entry[] = [topicEntry, answerEntry]

const submitting = ref(false)
const meta = ref(createMeta())

function setInput(entry: Entry, el: Element | ComponentPublicInstance | null): void {
  entry.input = el instanceof HTMLTextAreaElement ? el : null
}

function setSection(entry: Entry, el: Element | ComponentPublicInstance | null): void {
  entry.el = el instanceof HTMLElement ? el : null
}

// ─── 题目区 / 答案区的高度分配 ────────────────────────────────────────────────

/** 题目区占的高度比例（0..1），两栏合计为 1 */
const topicShare = ref(0.5)

/** 与 .entry 的 min-height 同一档：两栏都不许被拖得更小 */
const MIN_ENTRY_PX = 190

/**
 * 两栏的高度分配。
 *
 * .entry 是 flex: 1 1 0，两栏 basis 都是 0，高度只由 flex-grow 分 —— 改题目区
 * 那一份即可。值给字符串：flex-grow 无单位，别让 Vue 按数字去补 px。
 */
function entryStyle(entry: Entry): Record<string, string> {
  const share = entry === topicEntry ? topicShare.value : 1 - topicShare.value
  return { flexGrow: share.toFixed(4) }
}

/**
 * 拖「答案」那一条工具条，改两栏高度。
 *
 * 它正好压在两栏的分界线上，就是这一页的分隔条。手法照宿主拖文件面板那条
 * #panel-resizer（main.ts:initPanelResize）：pointerdown → setPointerCapture（拖出
 * 这一条也不丢事件）→ 拖时给条加 .is-dragging、给 body 加 .entry-resizing（整窗换成
 * 上下拖动的光标 + 禁选字）→ 松手一次性摘掉监听。
 *
 * 按在按钮上的不算拖：这一条上全是按钮，按下的那一格留给按钮自己；空白处（两端
 * 内边距、按钮之间的间隙、行尾余量，也占这一条的大部分）才是拖动面。
 */
function onToolbarPointerDown(entry: Entry, event: PointerEvent): void {
  if (entry !== answerEntry) return
  if (event.button !== 0) return
  if ((event.target as HTMLElement | null)?.closest('button')) return

  const topic = topicEntry.el
  const answer = answerEntry.el
  const bar = event.currentTarget
  if (!topic || !answer || !(bar instanceof HTMLElement)) return

  const startY = event.clientY
  const startTopicPx = topic.getBoundingClientRect().height
  const total = startTopicPx + answer.getBoundingClientRect().height
  // 两栏都得放得下 min-height 才分得动（这一页 min-height 620px，正常到不了这）
  if (total < MIN_ENTRY_PX * 2) return

  event.preventDefault()
  try {
    bar.setPointerCapture(event.pointerId)
  } catch {
    /* 合成事件、个别环境拿不到捕获：move/up 挂在 window 上，照样收得到 */
  }
  bar.classList.add('is-dragging')
  document.body.classList.add('entry-resizing')

  const move = (moveEvent: PointerEvent): void => {
    // 指针往下走多少，题目区就长多少；往上走同理
    const next = startTopicPx + (moveEvent.clientY - startY)
    const clamped = Math.min(Math.max(next, MIN_ENTRY_PX), total - MIN_ENTRY_PX)
    topicShare.value = clamped / total
  }
  const finish = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    bar.classList.remove('is-dragging')
    document.body.classList.remove('entry-resizing')
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}

// ─── 预览：内核实例 + setMarkdown，只读由 CSS 与 tabIndex 锁死 ─────────────────

/**
 * 预览是**真的 Milkdown 实例**（内核本来就支持多实例，Webview2 那页就是两个），
 * 喂什么就渲染什么，题目里的公式、拼音、田字格、分栏跟编辑器里长得一模一样 ——
 * 宿主「提交」标签页的预览也是这么来的（把 #editor 移过去 + setMarkdown）。
 *
 * 只读则是宿主那套现成的手法：外层 CSS `pointer-events: none`（见 body.submit-view
 * #editor 的注释「不可交互（纯预览）」）。另加 tabIndex = -1 把 Tab 键也挡在外面 ——
 * contenteditable 是 ProseMirror 自己维护的属性，下一次 setMarkdown 就会按 editable
 * 重写回去，手动改留不住；tabIndex 不在它管辖内。
 */
/**
 * 这个挂载点里是否已经有一个活着的实例 —— 判定挪去了 utils/readonly-preview
 * （hasLivePreview），判定理由（为什么不能只看内核注册表）的说明也在那边。
 */
async function bootEditors(): Promise<void> {
  for (const entry of ENTRY_LIST) {
    // 已经有活的实例就跳过：重复创建会叠加监听器，注册表也只增不减。
    if (hasLivePreview(entry.root)) continue
    try {
      // 经 utils/readonly-preview 的全局串行队列挂载（内部 createEditor +
      // lockPreview + setMarkdown 一条龙）：内核里每个实例的插件是逐个注册的，
      // 并发会交错；现在「题库管理 / 检索 / 详情 / 纠错」几处的只读预览都
      // 排同一条队，跨页面也不会撞。
      await mountReadonlyPreview(entry.root, entry.text.value)
    } catch (error) {
      // 预览挂了不等于这页废了：左边是纯 textarea，照样能录入、能提交
      showError(`预览初始化失败：${describeError(error)}（题目仍可录入提交）`)
    }
  }
  renderPreviews()
}

/** 把两栏的源文本重新渲染一遍。flushHistory=true：预览刷新不进 undo 栈。 */
function renderPreviews(): void {
  for (const entry of ENTRY_LIST) {
    if (hasEditor(entry.root)) setMarkdown(entry.text.value, true, entry.root)
  }
}

// 每次按键都整篇重解析一遍太重（setMarkdown 走 replaceAll 重建文档），
// 攒一小会儿再刷。120ms 是打字时察觉不到、连打又不会卡的量级。
const PREVIEW_DELAY = 120
let previewTimer = 0

function schedulePreview(): void {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(renderPreviews, PREVIEW_DELAY)
}

watch(
  ENTRY_LIST.map((entry) => entry.text),
  schedulePreview
)

onMounted(() => {
  void bootEditors()
})

// 后台面板整个销毁时（不是路由切走 —— 那种情况 KeepAlive 会保住 DOM）拦住
// 还在排队的刷新：内核没有 destroy，记录和 DOM 都不在了，setMarkdown 再跑就是
// 往一个脱了文档的编辑器里重建状态。
onBeforeUnmount(() => {
  window.clearTimeout(previewTimer)
})

// ─── 工具条：往源文本里插语法 ─────────────────────────────────────────────────

/**
 * 一次文本编辑的结果落到状态里，然后按结果恢复选区。
 *
 * 只改状态：textarea 由 v-model 回填，预览由 watch 刷新。直接写 input.value 会
 * 让 v-model 状态与 DOM 脱节（下一次输入就把手改的那次覆盖掉）。
 */
function applyEdit(entry: Entry, result: InsertResult): void {
  const input = entry.input
  if (!input) return
  entry.text.value = result.text
  void nextTick(() => {
    input.focus()
    input.setSelectionRange(result.start, result.end)
  })
}

/** 当前选区（textarea 没拿到就返回 null） */
function currentRange(entry: Entry): { start: number; end: number } | null {
  const input = entry.input
  if (!input) return null
  return { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 }
}

function onInsert(entry: Entry, key: SyntaxKey): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, insertSyntax(entry.text.value, range.start, range.end, key))
}

/**
 * 子块 / 分栏：弹出框产出整块 markdown，按块级语法插到**光标所在段落之后的新段落**
 * （它们的标记必须独占一行，见 insertBlockMarkdown）。
 */
function onBlockMarkdown(entry: Entry, markdown: string): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, insertBlockMarkdown(entry.text.value, range.start, markdown))
}

/**
 * 插入表格：工具栏划过几格就是几行几列，拼成 GFM 管道表后按块级插入
 * （表格也得自己占一段才认得出，故与子块 / 分栏同一条路）。
 */
function onTable(entry: Entry, size: { rows: number; cols: number }): void {
  onBlockMarkdown(entry, tableMarkdown(size.rows, size.cols))
}

/**
 * 插入公式：块公式（$$…$$）整块插到段后新段落，行内公式（$…$）插在光标处。
 */
function onMath(entry: Entry, item: { markdown: string; block: boolean }): void {
  if (item.block) onBlockMarkdown(entry, item.markdown)
  else onInlineMarkdown(entry, item.markdown)
}

/** 标题下拉：把光标/选区所在的行整体设为这一级（对应编辑器的 setBlockKind） */
function onBlock(entry: Entry, kind: BlockKind): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, applyHeading(entry.text.value, range.start, range.end, kind))
}

/**
 * 字体 / 字号的处理：都是行内样式，作用于**选中的文字**（规约H 8.2）。
 *
 * 前置条件不满足就直接说清楚，不往里塞东西：
 *   - 没选中文字 → 提示先选；
 *   - 选区跨自然段 → 行内标记只能存在于同一自然段内，提示逐段选中。
 *     （规约H 8.2 的原话是这种情形下按钮置灰；这里按钮的可用性跟不了 textarea
 *     的选区，就在按下这一刻拦。）
 */
function inlineStyleRange(entry: Entry): { start: number; end: number } | null {
  const range = currentRange(entry)
  if (!range) return null
  if (range.start === range.end) {
    showInfo('先在左边选中要改样式的文字，再选字体或字号')
    return null
  }
  if (/\n[ \t]*\n/.test(entry.text.value.slice(range.start, range.end))) {
    showInfo('行内字体/字号不能跨自然段（规约H 8.2），请逐段选中')
    return null
  }
  return range
}

function onFont(entry: Entry, family: string): void {
  const range = inlineStyleRange(entry)
  if (!range) return
  applyEdit(entry, applyInlineFont(entry.text.value, range.start, range.end, { family }))
}

function onSize(entry: Entry, size: string): void {
  const range = inlineStyleRange(entry)
  if (!range) return
  applyEdit(entry, applyInlineFont(entry.text.value, range.start, range.end, { size }))
}

/** 符号面板：普通字符，插在光标处（有选区就替换掉） */
function onSymbol(entry: Entry, ch: string): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, insertPlain(entry.text.value, range.start, range.end, ch))
}

/**
 * 行内语法（插入图片 / 田字格）：markdown 串由弹出框拼好 —— 图片那串含
 * #宽#高#对齐#样式 参数，田字格是 ++…++。这里只管插到光标处（有选区就替换）。
 */
function onInlineMarkdown(entry: Entry, markdown: string): void {
  const range = currentRange(entry)
  if (!range) return
  applyEdit(entry, insertPlain(entry.text.value, range.start, range.end, markdown))
}

/**
 * 源文本滚动 → 预览跟着滚（ctbapp 就是这么做的）。
 * 是朴素的像素对齐，不是内容对齐：两边高度不同时会逐渐错开，只当个粗对位用。
 */
function onInputScroll(entry: Entry, event: Event): void {
  const pane = document.getElementById(entry.root)?.parentElement
  if (!pane) return
  pane.scrollTop = (event.target as HTMLTextAreaElement).scrollTop
}

// ─── 提交 ─────────────────────────────────────────────────────────────────────

async function onSubmit(): Promise<void> {
  if (submitting.value) return

  const topicText = topicEntry.text.value
  const answerText = answerEntry.text.value

  // 校验顺序与文案照 ctbapp 的 submit()：习题 → 答案 → 科目 → 难易程度 →
  // 适用年级 → 知识点，一次只报一条
  const problem =
    blankProblem(topicText, '习题') ?? blankProblem(answerText, '答案') ?? firstMetaProblem(meta.value)
  if (problem) {
    showError(problem)
    return
  }

  // 读本地图片可能要几百毫秒到一两秒，从这里就锁住按钮，避免连点重复读盘 / 重复提交
  submitting.value = true
  try {
    // 提交前把图片拆成「ctbimg:// 占位符 + 文件」（后端 addSubjectWithImages 的约定）：
    //   - 本地路径引用（D:\a.png / images/a.png）先读成 data URL —— 后端读不到磁盘；
    //   - 内嵌 base64 直接拆。
    // 题目和答案共用一个 usedIds，保证 id 不重复；拆完文本变短、alt 保留样式参数，
    // 预览不受影响 —— 预览渲染的还是编辑中的原文。
    let topic: ExtractResult
    let answer: ExtractResult
    try {
      const usedIds = new Set<string>()
      topic = await extractEmbeddedImagesAsync(topicText, usedIds)
      answer = await extractEmbeddedImagesAsync(answerText, usedIds)
    } catch (error) {
      showError(describeError(error))
      return
    }
    const photos = [...topic.files, ...answer.files]

    // 张数 / 大小的前置校验（后端同样的规则，先拦下来省一次上传）
    const limitProblem = checkPhotoLimits(photos)
    if (limitProblem) {
      showError(limitProblem)
      return
    }

    const base = {
      course: meta.value.course,
      userCode: session.userCode,
      schoolCode: session.schoolCode,
      classLevel: classLevelCode(meta.value.classLevelName),
      easy: meta.value.easy,
      knowledgePoints: meta.value.knowledgePoints.trim(),
      token: session.token,
      subjectID: ''
    }
    // 有图走 multipart 新接口（图片上传 OSS + 占位符替换后落库），
    // 无图仍走老 JSON 接口 —— 两个接口互不影响（对接说明第一节）
    const msg =
      photos.length > 0
        ? await submitSubjectWithImages(
            { ...base, subjectSelf: topic.markdown, subjectAnswer: answer.markdown },
            photos
          )
        : await submitSubject({
            ...base,
            subjectSelf: topicText,
            subjectAnswer: answerText
          })
    showSuccess(msg || '提交成功')
    // 通知「题库管理」：数据变了，它自己重拉（人此刻可能在别的标签页）
    bumpTopicsVersion()
    // 只清题目与答案：元信息留着，接着录同一章节的下一题时不用重选一遍
    for (const entry of ENTRY_LIST) entry.text.value = ''
    renderPreviews()
  } catch (error) {
    showError(`提交失败：${describeError(error)}`)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* 页面自己留出呼吸：四周一圈底色的空隙，题目与答案各是一张浮在底色上的白卡片。
   position: relative 是给「附加信息」抽屉定位用的（组件内是 absolute）。 */
.put-topic-page {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 620px;
  gap: 12px;
  padding: 14px 18px 0;
  background: var(--admin-bg);
  box-sizing: border-box;
}

/* 编辑区。这一层同时管三件事：flex 布局、把显示权从宿主那条
   body.admin-panel-view #editor { display: none } 手里抢回来、以及让右侧预览命中
   主题里那些 `#editor …` 规则。
   三件事必须写在同一条高优先级选择器里 —— 主题的 #editor 是 id 选择器，任何类
   选择器都会被它压过去，分开写就会出现「布局生效了、但元素仍是 display: none」
   这种半生效状态。
   height / padding 都归零或改由页面自己定：主题给 #editor 的是视口高度 + 40px 留白，
   那是文档编辑器的排法；这里高度由本页的 flex 分配，留白交给每栏自己。 */
#admin-panel .put-topic-page #editor.put-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  /* 两栏各是一张卡片，间距交给 gap；外层不再通栏贴边 */
  margin: 0;
  padding: 0;
  overflow: hidden;
}

/* 一栏 = 一条工具条 + 一块左右分栏的编辑面，包成一张白卡片。
   卡片靠 1px 淡边 + 极轻的投影浮在灰色页面底上，层次只靠这两层，
   不用加深边框或大阴影。 */
.entry {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 190px;
  overflow: hidden;
  /* 必须跟 --admin-surface 走：宿主主题里的 --bg-color 在深色下是纯黑，
     会和右边白色/深灰的预览面、以及灰色页面底割裂成三块 */
  background: var(--admin-surface);
  border: 1px solid var(--admin-border);
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.entry-split {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

/* ─── 答案那条工具条 = 题目区 / 答案区的分隔条 ─────────────────────────────────
   整条可拖（按在按钮上的除外，见 onToolbarPointerDown），指针样式换上下拖动。
   这里只放光标，不放任何视觉提示：抓手点阵参与 flex 布局，会把整串按钮推右、与题目
   那条对不齐；画在分界线上的亮线又压在题目区那条 1px 分线上，多此一笔。 */
.entry.is-resizable > :deep(.toolbar) {
  cursor: row-resize;
}

/* 拖动中：整窗保持上下拖动的光标、禁掉选字 —— 照 #panel-resizer 的
   body.panel-resizing（base.css:941）。用 :global 是因为这条规则的目的地是 body
   自己，带上 scoped 属性就永远不命中了。 */
:global(body.entry-resizing) {
  cursor: row-resize;
  user-select: none;
}

/* 左：源文本。等宽字体 —— markdown 的标记对齐靠它。
   分栏线用 --shell-line（编辑器里工具条、面板边框用的就是它），不是后台面板的
   --admin-border：这页的观感对齐的是标签页，不是后台表单。
   字号/行高取右手边预览那一档（主题 #editor .ProseMirror，base.css:1192），
   不是另找一个数：两栏并排，同一行行距不同会一路错位下去。 */
/* 左：源文本。底色比右侧预览浅一档，一眼分得清"写的地方"和"看的结果"；
   等宽字体保留 —— markdown 的标记对齐靠它。 */
.md-input {
  flex: 1 1 50%;
  min-width: 0;
  min-height: 0;
  padding: 16px 20px;
  border: none;
  border-right: 1px solid var(--admin-border);
  background: var(--admin-bg-soft);
  color: var(--text-color, var(--admin-text));
  font-family: Consolas, 'Courier New', monospace;
  font-size: 16px;
  line-height: 1.75;
  tab-size: 2;
  resize: none;
  outline: none;
}

.md-input::placeholder {
  color: var(--text-muted, var(--admin-text-weak));
}

/* 右：预览。滚动在这一层，预览本身交出滚动（与宿主提交页同一手法）。
   白底：与左边浅灰的源文本形成"纸 vs 台面"的对照。 */
.preview-pane {
  flex: 1 1 50%;
  min-width: 0;
  padding: 16px 20px;
  background: var(--admin-surface);
  overflow-y: auto;
}

/* 提交条：「附加信息」在前，「提交」紧跟在它右侧并排靠左 —— 两个都是这一屏的
   收尾动作，挨着放比一头一个、中间空一整行更好扫。 */
.put-foot {
  flex: none;
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 12px;
  padding: 12px 0 14px;
}

/* 纯预览，不可交互 —— 鼠标归这里管，Tab 键由 lockPreview 的 tabIndex 管。
   点不到、也 Tab 不进来，内容就只能由左边的源文本决定。 */
.preview-root {
  pointer-events: none;
  cursor: default;
}

/* .milkdown / .ProseMirror 是内核运行时插进来的，没有 scoped 属性，故用 :deep。
   主题里 #editor > .milkdown 是直接子代选择器，这里多了一层包裹，得自己补上。 */
.preview-root :deep(.milkdown) {
  display: flex;
  flex-direction: column;
}

/* 内核往挂载点里塞的代码块「复制」按钮也要挡掉。它的外观与隐藏（含 opacity: 0，
   所以编辑器里平常看不见）全写在主题的直接子代规则 `#editor > .code-copy-btn` 里，
   这里多了一层 .preview-root，那些规则一条都不命中 —— 它就以普通流内元素露在
   预览正文最上面，正文里就出现「复制」二字。何况本层是 pointer-events: none，
   留着也点不动，直接隐藏。 */
.preview-root :deep(.code-copy-btn) {
  display: none;
}



.btn {
  height: 30px;
  padding: 0 14px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text);
  border: 1px solid var(--admin-border);
  border-radius: 6px;
  background: var(--admin-surface);
  cursor: pointer;
}

.btn:hover:not(:disabled) {
  color: var(--admin-primary);
  border-color: var(--admin-primary);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 与标题栏「提交」按钮（base.css 的 .tab-submit-btn）一模一样：同蓝 #3b82f6、
   hover 加深 #2f74e0、8px 圆角、白字 600 字重、无边框。底色是固定色值，
   不跟 --admin-primary 走。 */
.btn.is-primary {
  --submit-bg: #3b82f6;
  --submit-bg-hover: #2f74e0;
  color: #fff;
  background: var(--submit-bg);
  border: none;
  border-radius: 8px;
  font-weight: 600;
}

.btn.is-primary:hover:not(:disabled) {
  color: #fff;
  background: var(--submit-bg-hover);
}

/* 尺寸也照 .tab-submit-btn 一模一样：28px 高、width auto、12px 字号 ——
   #titlebar > button 的 28×28 垫底，tab-submit-btn 覆盖成 width: auto、
   min-width: 28px、padding: 0 12px，这里对齐同一组值。 */
.btn.is-block {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: auto;
  min-width: 28px;
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  white-space: nowrap;
}
</style>
