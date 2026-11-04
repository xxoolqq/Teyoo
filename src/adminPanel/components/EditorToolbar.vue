<template>
  <div ref="root" class="toolbar" role="toolbar" :aria-label="`${tag}格式工具栏`">
    <!-- mousedown.prevent 是必须的：按钮一旦拿到焦点，textarea 就失焦，选区
         （selectionStart/End）随之丢失，插语法就不知道往哪儿插。 -->
    <div class="heading-dropdown">
      <button
        type="button"
        class="toolbar-btn heading-select-btn title-select-btn"
        aria-haspopup="true"
        :aria-expanded="open === 'block'"
        title="标题大小"
        @mousedown.prevent
        @click="toggle('block')"
      >
        <span class="select-label">标题</span>
      </button>
      <div v-show="open === 'block'" class="heading-menu" role="menu">
        <button
          v-for="item in BLOCK_ITEMS"
          :key="item.kind"
          type="button"
          role="menuitem"
          class="heading-menu-item"
          @mousedown.prevent
          @click="pick('block', item.kind)"
        >{{ item.label }}</button>
      </div>
    </div>

    <div class="heading-dropdown">
      <button
        type="button"
        class="toolbar-btn heading-select-btn font-select-btn"
        aria-haspopup="true"
        :aria-expanded="open === 'font'"
        title="字体（先选中文字）"
        @mousedown.prevent
        @click="toggle('font')"
      >
        <svg width="16" height="16" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true">
          <path d="M653.568 724.352l-366.72 0.32L216.32 893.888l158.656 0 0 57.088L64 950.976l0-57.088 55.424 0L495.232 73.088 528 73.088l386.304 820.8L960 893.888l0 57.088-280.96 0 0-57.088 60.544 0L653.568 724.352zM339.264 614.656l256.64-0.768L480 376.768 456.96 376.768 339.264 614.656z"/>
        </svg>
      </button>
      <div v-show="open === 'font'" class="heading-menu" role="menu">
        <button
          v-for="font in FONT_FAMILIES"
          :key="font.value"
          type="button"
          role="menuitem"
          class="font-menu-item"
          :style="{ fontFamily: `'${font.value}'` }"
          @mousedown.prevent
          @click="pick('font', font.value)"
        >{{ font.zh }}</button>
      </div>
    </div>

    <div class="heading-dropdown">
      <button
        type="button"
        class="toolbar-btn heading-select-btn fontsize-select-btn"
        aria-haspopup="true"
        :aria-expanded="open === 'size'"
        title="字号（先选中文字）"
        @mousedown.prevent
        @click="toggle('size')"
      >
        <svg width="16" height="16" viewBox="0 0 1144 1024" fill="currentColor" aria-hidden="true">
          <path d="M978.823529 722.823529h-120.470588v-165.647058h-150.588235v-120.470589h150.588235V271.058824h120.470588v165.647058h150.588236v120.470589h-150.588236V722.823529z m135.529412 165.647059V1024H722.823529v-135.529412h391.529412zM527.058824 150.588235v873.411765h-150.588236V150.588235H0V0h903.529412v150.588235H527.058824z"/>
        </svg>
      </button>
      <div v-show="open === 'size'" class="heading-menu" role="menu">
        <button
          v-for="size in FONT_SIZES"
          :key="size.value"
          type="button"
          role="menuitem"
          class="fontsize-menu-item"
          @mousedown.prevent
          @click="pick('size', size.value)"
        >{{ size.zh }}</button>
      </div>
    </div>

    <span class="toolbar-sep" aria-hidden="true"></span>

    <button
      type="button"
      class="toolbar-btn"
      title="引用块（> ）"
      @mousedown.prevent
      @click="emit('insert', 'quotation')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" stroke="none">
        <path d="M7.2 3.2C4.9 3.7 3.7 5.5 3.7 8v4.3h3.6V8.4H5.4c0-1.4.6-2.4 2-2.7l-.2-2.5zm5.6 0c-2.3.5-3.5 2.3-3.5 4.8v4.3h3.6V8.4H11c0-1.4.6-2.4 2-2.7l-.2-2.5z"/>
      </svg>
    </button>

    <span class="toolbar-sep" aria-hidden="true"></span>

    <button
      type="button"
      class="toolbar-btn tb-text"
      title="加粗（**粗体**）"
      @mousedown.prevent
      @click="emit('insert', 'bold')"
    ><b>B</b></button>
    <button
      type="button"
      class="toolbar-btn tb-text"
      title="斜体（*斜体*）"
      @mousedown.prevent
      @click="emit('insert', 'italic')"
    ><i>I</i></button>
    <button
      type="button"
      class="toolbar-btn tb-text"
      title="下划线（<u>下划线</u>）"
      @mousedown.prevent
      @click="emit('insert', 'underline')"
    ><u>U</u></button>
    <button
      type="button"
      class="toolbar-btn tb-text"
      title="中划线（~~中划线~~）"
      @mousedown.prevent
      @click="emit('insert', 'throughline')"
    ><span class="tb-strike">S</span></button>

    <button
      type="button"
      class="toolbar-btn"
      title="字下着重号（@.文字.@）"
      @mousedown.prevent
      @click="emit('insert', 'emphdot')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
        <line x1="3" y1="5" x2="8" y2="5"/>
        <line x1="3" y1="8.5" x2="10.5" y2="8.5"/>
        <circle cx="3.6" cy="12.3" r="1.05" fill="currentColor" stroke="none"/>
        <circle cx="6.9" cy="12.3" r="1.05" fill="currentColor" stroke="none"/>
        <circle cx="10.2" cy="12.3" r="1.05" fill="currentColor" stroke="none"/>
      </svg>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="下标（_{x}）"
      @mousedown.prevent
      @click="emit('insert', 'sub')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <text x="1.5" y="13" font-size="11" font-weight="600" fill="currentColor" font-style="italic">x</text>
        <text x="9.5" y="15" font-size="7.5" font-weight="600" fill="currentColor">2</text>
      </svg>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="上标（^{2}）"
      @mousedown.prevent
      @click="emit('insert', 'sup')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <text x="1.5" y="13" font-size="11" font-weight="600" fill="currentColor" font-style="italic">x</text>
        <text x="9.5" y="8.5" font-size="7.5" font-weight="600" fill="currentColor">2</text>
      </svg>
    </button>

    <span class="toolbar-sep" aria-hidden="true"></span>

    <button
      type="button"
      class="toolbar-btn"
      title="插入长空白（4 个全角空格）"
      @mousedown.prevent
      @click="emit('insert', 'longblank')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 6H5v12h4"/>
        <path d="M15 6h4v12h-4"/>
      </svg>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="填空线（--(3)，括号里是宽度）"
      @mousedown.prevent
      @click="emit('insert', 'blankline')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="6" y1="8" x2="6" y2="13"/>
        <line x1="12" y1="8" x2="12" y2="13"/>
        <line x1="18" y1="8" x2="18" y2="13"/>
        <line x1="3" y1="17" x2="21" y2="17"/>
      </svg>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="汉字右上角带圈序号（^{1}）"
      @mousedown.prevent
      @click="emit('insert', 'circled')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24">
        <text x="5" y="18" font-size="15" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">字</text>
        <circle cx="18" cy="5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/>
        <text x="18" y="6.8" text-anchor="middle" font-size="5" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">1</text>
      </svg>
    </button>

    <!-- 常用符号：项目工具栏那个 Ω 面板。符号表用它的（renderer/toolbar.ts 的
         SYMBOL_GROUPS），不在面板里另抄一份，免得两边走散。 -->
    <div class="symbol-dropdown">
      <button
        type="button"
        class="toolbar-btn tb-omega"
        aria-haspopup="true"
        :aria-expanded="open === 'symbol'"
        title="插入常用符号"
        @mousedown.prevent
        @click="toggle('symbol')"
      >
        <span>Ω</span>
      </button>
      <div v-show="open === 'symbol'" class="symbol-menu" role="menu">
        <template v-for="group in SYMBOL_GROUPS" :key="group.label">
          <div class="symbol-group-label">{{ group.label }}</div>
          <div class="symbol-grid">
            <button
              v-for="ch in group.chars"
              :key="ch"
              type="button"
              class="symbol-item"
              :class="{ 'is-wide': ch.length > 1 }"
              :title="`插入 ${ch}`"
              @mousedown.prevent
              @click="pick('symbol', ch)"
            >{{ ch }}</button>
          </div>
        </template>
      </div>
    </div>

    <span class="toolbar-sep" aria-hidden="true"></span>

    <button
      type="button"
      class="toolbar-btn"
      title="无序列表（- ）"
      @mousedown.prevent
      @click="emit('insert', 'ul')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
        <line x1="5.5" y1="4" x2="13.5" y2="4"/>
        <line x1="5.5" y1="8" x2="13.5" y2="8"/>
        <line x1="5.5" y1="12" x2="13.5" y2="12"/>
        <circle cx="3" cy="4" r="1" fill="currentColor" stroke="none"/>
        <circle cx="3" cy="8" r="1" fill="currentColor" stroke="none"/>
        <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none"/>
      </svg>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="有序列表（1. ）"
      @mousedown.prevent
      @click="emit('insert', 'ol')"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
        <line x1="5.5" y1="4" x2="13.5" y2="4"/>
        <line x1="5.5" y1="8" x2="13.5" y2="8"/>
        <line x1="5.5" y1="12" x2="13.5" y2="12"/>
        <text x="1.4" y="5.9" font-size="5.6" fill="currentColor" stroke="none" font-family="sans-serif">1</text>
        <text x="1.4" y="9.9" font-size="5.6" fill="currentColor" stroke="none" font-family="sans-serif">2</text>
        <text x="1.4" y="13.9" font-size="5.6" fill="currentColor" stroke="none" font-family="sans-serif">3</text>
      </svg>
    </button>

    <span class="toolbar-sep" aria-hidden="true"></span>

    <button
      type="button"
      class="toolbar-btn"
      title="插入公式（LaTeX，可勾块公式）"
      @mousedown.prevent
      @click="openModal('math')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24">
        <text x="8" y="15" text-anchor="middle" font-size="16" fill="currentColor" font-family="Georgia,'Times New Roman',serif" font-style="italic">∑</text>
      </svg>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="插入图片"
      aria-haspopup="dialog"
      @mousedown.prevent
      @click="openModal('image')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2"/>
        <circle cx="9" cy="10" r="2"/>
        <path d="M3 17l5-5 4 4 3-3 6 6"/>
      </svg>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="插入子块（内容 / 边框 / 对齐）"
      @mousedown.prevent
      @click="openModal('subblock')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="1" />
        <line x1="3" y1="10" x2="21" y2="10" />
        <text x="12" y="8" text-anchor="middle" font-size="3.5" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">text</text>
      </svg>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="插入分栏（N 列等宽或 A:B 比例）"
      @mousedown.prevent
      @click="openModal('cols')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="1" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </svg>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="插入田字格（纯汉字 / 空白格 / 带拼音）"
      @mousedown.prevent
      @click="openModal('tianzi')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <line x1="3" y1="12" x2="21" y2="12" stroke-dasharray="2 2"/>
        <line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2 2"/>
      </svg>
    </button>
    <!-- 插入表格：划格子选行列。面板沿用下拉那套外壳（.heading-menu）与定位
         （.heading-dropdown），里面是 10 × 10 个格子按钮。 -->
    <div class="heading-dropdown">
      <button
        type="button"
        class="toolbar-btn"
        title="插入表格（划格子选行列）"
        aria-haspopup="true"
        :aria-expanded="open === 'table'"
        @mousedown.prevent
        @click="toggle('table')"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="16" height="14" rx="1"/>
          <line x1="2" y1="8" x2="18" y2="8"/>
          <line x1="2" y1="13" x2="18" y2="13"/>
          <line x1="8" y1="3" x2="8" y2="17"/>
          <line x1="13" y1="3" x2="13" y2="17"/>
        </svg>
      </button>
      <div v-show="open === 'table'" class="heading-menu table-grid-menu" role="menu">
        <div class="table-grid" @mouseleave="hovered = null">
          <template v-for="r in GRID_INDEX" :key="r">
            <button
              v-for="c in GRID_INDEX"
              :key="c"
              type="button"
              class="table-grid-cell"
              :class="{ 'is-on': hovered !== null && r <= hovered.row && c <= hovered.col }"
              :aria-label="`${r + 1} 行 ${c + 1} 列`"
              @mousedown.prevent
              @mouseenter="hovered = { row: r, col: c }"
              @click="pickTable(r, c)"
            ></button>
          </template>
        </div>
        <div class="table-grid-size">
          {{ hovered ? `${hovered.row + 1} 行 × ${hovered.col + 1} 列` : '划格子选行列' }}
        </div>
      </div>
    </div>

    <!-- 三个弹出框。都 Teleport 到 body（组件里写了原因），摆在这儿不影响这条
         工具条的布局。 -->
    <ImageInsertModal
      v-if="modal === 'image'"
      @insert="onImageInsert"
      @cancel="modal = null"
    />
    <SubblockModal
      v-if="modal === 'subblock'"
      @insert="onSubblockInsert"
      @cancel="modal = null"
    />
    <ColsModal v-if="modal === 'cols'" @insert="onColsInsert" @cancel="modal = null" />
    <TianziModal v-if="modal === 'tianzi'" @insert="onTianziInsert" @cancel="modal = null" />
    <MathModal v-if="modal === 'math'" @insert="onMathInsert" @cancel="modal = null" />
  </div>
</template>

<script setup lang="ts">
// 每栏一条工具条（题目、答案各一条）。
//
// 按钮集**只留本项目格式工具栏（src/renderer/index.html 的 #toolbar）里有的**，
// 图标 SVG 也是从那里逐字抄来的（含 viewBox 与描边宽度），所以这条工具条与编辑器
// 那条同源同观感。项目工具栏里没有对应按钮的一律不摆：
//   标记、居左、居中、居右、块公式（项目没有）、转换、注音、词拼音（两套图标都没有）
//   —— 「转换」（MathType \[] → $）连功能一起去掉了。
// 项目工具栏里用文字表示的那几个（B / I / U / S）照旧用文字 —— 项目自己就是
// `<b>B</b>` 这种写法，不是图标。
// 另外两条虽借了项目的图标，但插的不是同一个东西，title 已写明：
//   长空白 = 项目的「插入长空白（4 个全角空格）」原样；
//   填空线 = 项目工具栏那条插的是 10 个全角下划线，这里插的是规约 C 的 `--(N)`。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { FONT_FAMILIES, FONT_SIZES } from '../../renderer/editor/font-style-modal'
import { SYMBOL_GROUPS } from '../../renderer/toolbar'
import ImageInsertModal from './ImageInsertModal.vue'
import SubblockModal from './SubblockModal.vue'
import ColsModal from './ColsModal.vue'
import TianziModal from './TianziModal.vue'
import MathModal from './MathModal.vue'
import type { BlockKind, SyntaxKey } from '../utils/md-syntax'

defineProps<{
  /** 只进 aria-label（"题目格式工具栏"），不在界面上显示 */
  tag: string
}>()

const emit = defineEmits<{
  insert: [key: SyntaxKey]
  /** 标题下拉：把光标/选区所在的行设为这一级 */
  block: [kind: BlockKind]
  /** 字体下拉：给选中的文字套行内字体（规约H 4.1） */
  font: [family: string]
  /** 字号下拉：给选中的文字套行内字号 */
  size: [size: string]
  /** 符号面板：把符号插到光标处 */
  symbol: [ch: string]
  /** 插入图片弹出框：弹出框产出的一段图片 markdown，插到光标处 */
  image: [markdown: string]
  /** 子块弹出框：产出的一段子块 markdown（块级，插到光标所在段落之后） */
  subblock: [markdown: string]
  /** 分栏弹出框：产出的一段分栏 markdown（块级，插到光标所在段落之后） */
  cols: [markdown: string]
  /** 田字格弹出框：产出的一段田字格 markdown（行内，插在光标处） */
  tianzi: [markdown: string]
  /** 划格子选出的行列数（首行算表头行；块级，插到光标所在段落之后） */
  table: [size: { rows: number; cols: number }]
  /** 公式弹出框：产出的公式串；块公式整块插到段后，行内插在光标处 */
  math: [item: { markdown: string; block: boolean }]
}>()

// 标题下拉的条目与项目那条逐条对齐（index.html 的 #heading-menu：正文 / 标题 1-6）。
// 项目那边按钮上的字是跟随光标所在块的（BLOCK_LABELS），这里没有文档树可跟随，
// 就固定显示「标题」—— 也正是项目在普通段落里的显示。
const BLOCK_ITEMS: { kind: BlockKind; label: string }[] = [
  { kind: 'paragraph', label: '正文' },
  { kind: 'heading1', label: '标题 1' },
  { kind: 'heading2', label: '标题 2' },
  { kind: 'heading3', label: '标题 3' },
  { kind: 'heading4', label: '标题 4' },
  { kind: 'heading5', label: '标题 5' },
  { kind: 'heading6', label: '标题 6' }
]

/** 下拉 / 面板的名字：标题、字体、字号、符号，以及划格子的插入表格 */
type PanelName = 'block' | 'font' | 'size' | 'symbol' | 'table'

// 同时只开一个。点条目、点面板外、按 Esc 都关。
const open = ref<PanelName | null>(null)
const root = ref<HTMLElement | null>(null)

// ─── 插入表格：划格子选行列（tiptap 那种选择器）───────────────────────────────
// 6 × 6 格（与主编辑器工具栏的表格选择器一致）：鼠标划过就高亮「左上角 → 当前格」
// 这一片，点一下插对应行列数的表格。
// 首行算表头行，所以划 3 行 4 列得到的是「表头 + 2 个内容行 × 4 列」。
const GRID_MAX = 6
/** 0..5 的行/列下标，模板里 v-for 用 */
const GRID_INDEX = Array.from({ length: GRID_MAX }, (_, i) => i)
const hovered = ref<{ row: number; col: number } | null>(null)

function pickTable(row: number, col: number): void {
  open.value = null
  hovered.value = null
  emit('table', { rows: row + 1, cols: col + 1 })
}

/** 四个弹出框（插入图片 / 子块 / 分栏 / 田字格）。开的时候收掉下拉，免得两层叠着 */
type ModalName = 'image' | 'subblock' | 'cols' | 'tianzi' | 'math'
const modal = ref<ModalName | null>(null)

function openModal(name: ModalName): void {
  open.value = null
  modal.value = name
}

function onImageInsert(markdown: string): void {
  modal.value = null
  emit('image', markdown)
}

function onSubblockInsert(markdown: string): void {
  modal.value = null
  emit('subblock', markdown)
}

function onColsInsert(markdown: string): void {
  modal.value = null
  emit('cols', markdown)
}

function onTianziInsert(markdown: string): void {
  modal.value = null
  emit('tianzi', markdown)
}

function onMathInsert(item: { markdown: string; block: boolean }): void {
  modal.value = null
  emit('math', item)
}

function toggle(name: PanelName): void {
  open.value = open.value === name ? null : name
  // 重新打开划格子面板时清掉上一次的高亮
  if (name === 'table' && open.value === 'table') hovered.value = null
}

function pick(name: 'block' | 'font' | 'size' | 'symbol', value: string): void {
  open.value = null
  if (name === 'block') emit('block', value as BlockKind)
  else if (name === 'font') emit('font', value)
  else if (name === 'size') emit('size', value)
  else emit('symbol', value)
}

function onDocClick(event: MouseEvent): void {
  if (!root.value?.contains(event.target as Node)) open.value = null
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = null
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
/* 度量与配色照本项目自己的格式工具栏（base.css 的 #toolbar 那一套，逐条对齐）：
   28×28 方钮、radius 6、gap 2px、分组之间 1px × 19px 竖线、底色 --chrome-bg、
   下边线 --shell-line、图标统一 19px、hover 是 9% 文字色叠底、cursor: default。
   没有直接复用 base.css 的规则：那些都挂在 #toolbar 这个 id 底下，而这是后台面板里
   的一条工具条，不该把自己装成全局格式工具栏。
   两处与项目不同，都因为这条工具条不在整窗宽度里：高度用 min-height（项目是固定
   38px）、允许换行（项目是 nowrap 且 overflow: visible，窄了会被裁切）。 */
.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  min-height: 38px;
  padding: 2px 10px;
  background: var(--chrome-bg, var(--admin-bg-soft));
  border-bottom: 1px solid var(--shell-line, var(--admin-border));
  user-select: none;
}

/* 分组分隔线：与项目工具栏同尺寸（1px × 19px，两侧 5px） */
.toolbar-sep {
  flex: none;
  width: 1px;
  height: 19px;
  margin: 0 5px;
  background: var(--shell-line, var(--admin-border));
}

.toolbar-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, var(--admin-text-weak));
  font-family: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: default;
  transition: background 0.12s ease, color 0.12s ease;
}

/* 图标统一放大到 19px（项目那条同样用一条规则盖掉 SVG 自带的 16/20 尺寸） */
.toolbar-btn svg {
  width: 19px;
  height: 19px;
}

.toolbar-btn:hover {
  background: color-mix(in srgb, var(--text-color, var(--admin-text)) 9%, transparent);
  color: var(--text-color, var(--admin-text));
}

/* 按下的那一瞬。项目里 .is-active 是光标落在对应格式内时的常驻态，这里没有
   编辑器选区可跟随（源文本是 textarea），所以只保留点击反馈。 */
.toolbar-btn:active {
  background: color-mix(in srgb, var(--text-color, var(--admin-text)) 14%, transparent);
}

/* 中划线那个 S */
.tb-strike {
  text-decoration: line-through;
  text-decoration-thickness: 1.2px;
}

/* 标题下拉按钮上的字。项目那条是 #heading-select-label，这里不能借那个 id
   （它是全局格式工具栏的），所以自带一个类，规则照抄它的三条。 */
.select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 标题按钮不是 28×28 方钮，宽度要随内容。项目那条靠全局 .heading-select-btn 的
   `width: auto` + `font-size: 12.5px` 盖过 .toolbar-btn；这里因为 scoped 属性，
   .toolbar-btn[data-v-…] 反倒更特化 —— 定宽 28px 与本条工具条的 15px 字（两个字
   正好 30px）合起来就把「标题」压成了「标…」。显式再盖一次：宽度随内容、
   左右留出内边距。字体 / 字号那两个也是 .heading-select-btn，但它们是图标钮，
   仍该是 28×28，故不给它们加这个类。 */
.toolbar :deep(.title-select-btn) {
  width: auto;
  min-width: max-content;
  padding: 0 6px;
}

/* 三个下拉与符号面板的观感全部来自项目全局类名（.heading-dropdown /
   .heading-menu / .heading-menu-item / .font-menu-item / .fontsize-menu-item /
   .symbol-menu / .symbol-item …）—— base.css 里这些规则都没挂在 #toolbar 底下，
   这里正好接着用，不必抄第二份。只有高度要自己管：这一栏是 .entry，而它是
   overflow: hidden，菜单按项目那份 min-content 高度会被裁掉，于是像项目的符号
   面板一样封顶 + 内部滚动（项目那条 max-height 是 min(60vh, 460px)，这里得按
   栏高来）。 */
.toolbar :deep(.heading-menu),
.toolbar :deep(.symbol-menu) {
  max-height: 220px;
  overflow-y: auto;
}

/* 一条竖线之后紧跟的 Ω：项目里 .symbol-menu 靠右对齐（right: 0），在整窗宽度的
   工具栏里合适，在这条窄工具条里会向左探出去。改靠按钮左缘对齐。 */
.toolbar :deep(.symbol-menu) {
  right: auto;
  left: 0;
}

/* ─── 插入表格：划格子面板 ────────────────────────────────────────────────────
   外壳沿用下拉那套（.heading-menu：定位、边框、底色、阴影），这里只排版格子。
   格子 16px：6 行连间隙的净高 106px，加上尺寸行与内边距 —— 与其它下拉
   面板一样落在这条工具条能给出的高度里（.entry 是 overflow: hidden，再高会被裁）。 */
.table-grid-menu {
  gap: 6px;
  padding: 8px 10px;
}

.table-grid {
  display: grid;
  grid-template-columns: repeat(6, 16px);
  gap: 2px;
}

.table-grid-cell {
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--shell-line, var(--admin-border));
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
}

/* 划过的那一片（左上角 → 当前格）实心：颜色与文字同色，深浅主题下都够显眼 */
.table-grid-cell.is-on {
  background: var(--text-color, var(--admin-text));
  border-color: var(--text-color, var(--admin-text));
}

.table-grid-size {
  font-size: 12px;
  text-align: center;
  color: var(--text-muted, var(--admin-text-weak));
  font-variant-numeric: tabular-nums;
}
</style>
