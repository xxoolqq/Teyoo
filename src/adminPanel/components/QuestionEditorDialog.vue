<template>
  <!-- 录入新题目：覆盖在本地题库页上的弹窗（MathBank 的 #editorSection.question-editor-dialog）。
       三步切换 · 分类信息 / 题干编辑 / 解析编辑，保存写本地 SQLite 题库。
       Teleport 到 body：弹窗要盖住整个面板，留在页面容器里会被祖先的 overflow 裁掉。 -->
  <Teleport to="body">
    <div
      v-if="open"
      id="question-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qe-title"
      @click.self="close"
      @keydown.esc="close"
      @paste="onPaste"
    >
      <div class="qe-surface">
        <!-- 标题条 -->
        <header class="qe-header">
          <div class="qe-heading">
            <span class="qe-heading-icon" aria-hidden="true">
              <i class="fa-solid fa-pen-nib"></i>
            </span>
            <div class="qe-heading-copy">
              <h2 id="qe-title">录入新题目</h2>
              <small>{{ headingSubtitle }}</small>
            </div>
          </div>
          <div class="qe-header-actions">
            <button type="button" class="qe-clear" @click="clearDraft">清空草稿</button>
            <button type="button" class="qe-save" :disabled="saving" @click="save">
              <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
              <span>{{ saving ? '保存中…' : '保存' }}</span>
            </button>
            <button type="button" class="qe-close" aria-label="关闭录入窗口" @click="close">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </header>

        <!-- 三步 -->
        <nav class="qe-steps" aria-label="录入步骤">
          <button
            v-for="item in STEPS"
            :key="item.key"
            type="button"
            class="qe-step"
            :class="{ 'is-active': step === item.key }"
            :aria-current="step === item.key ? 'step' : undefined"
            @click="step = item.key"
          >
            <span>{{ item.index }}</span>
            <strong>{{ item.title }}</strong>
            <small>{{ item.hint }}</small>
          </button>
        </nav>

        <div class="qe-body">
          <p class="qe-hint" :class="{ 'is-complete': ready }" role="status">
            {{ hintText }}
          </p>

          <!-- ① 分类信息 -->
          <section v-show="step === 'classification'" class="qe-panel">
            <h3 class="qe-panel-title">
              <i class="fa-solid fa-tags" aria-hidden="true"></i>
              <span>分类信息</span>
            </h3>

            <div class="qe-grid-3">
              <label class="qe-field">
                <span>科目<i class="req">*</i></span>
                <select v-model="form.subjectCode" @change="onSubjectChange">
                  <option value="">-- 选择科目 --</option>
                  <option v-for="item in subjectOptions" :key="item.code" :value="item.code">
                    {{ item.name }}
                  </option>
                </select>
              </label>
              <label class="qe-field">
                <span>题型</span>
                <select v-model="form.subjectTypeCode">
                  <option v-for="item in typeOptions" :key="item.code" :value="item.code">
                    {{ item.name }}
                  </option>
                </select>
              </label>
              <label class="qe-field">
                <span>难度</span>
                <select v-model="form.easy">
                  <option v-for="item in easyOptions" :key="item.value" :value="item.value">
                    {{ item.label }}
                  </option>
                </select>
              </label>
            </div>

            <div class="qe-grid-2">
              <label class="qe-field">
                <span>学段</span>
                <!-- 学段决定知识点范围：值直接写 primary / junior / senior / other，
                     既入库到 exercise.stage 与 class_level，也是 key_points 的
                     class_level 取值（与导入中心的学段选择同一口径）。 -->
                <select v-model="form.classLevel" @change="onClassLevelChange">
                  <option value="">-- 选择学段 --</option>
                  <option v-for="item in STAGE_OPTIONS" :key="item.value" :value="item.value">
                    {{ item.label }}
                  </option>
                  <option v-if="legacyClassLevel" :value="form.classLevel">
                    {{ legacyClassLevel }}（历史年级）
                  </option>
                </select>
              </label>
              <label class="qe-field">
                <span>来源</span>
                <input v-model="form.source" type="text" placeholder="如：2025全国甲卷" />
              </label>
            </div>

            <!-- 知识点 -->
            <div class="qe-kp">
              <span class="qe-kp-label">知识点</span>
              <button type="button" class="qe-kp-toggle" @click="toggleKpPanel">选择知识点</button>
              <span v-if="!form.knowledgePoints.length" class="qe-kp-status">未选择</span>
              <div v-else class="qe-kp-chips">
                <button
                  v-for="point in form.knowledgePoints"
                  :key="point.code"
                  type="button"
                  class="qe-kp-chip"
                  :title="`移除「${point.name}」`"
                  @click="removeKnowledgePoint(point.code)"
                >
                  <span>{{ point.name }}</span>
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </div>
            </div>

            <div v-if="kpOpen" class="qe-kp-panel">
              <input
                v-model="kpKeyword"
                type="text"
                class="qe-kp-search"
                placeholder="搜索知识点名称或编码…"
              />
              <div class="qe-kp-options">
                <button
                  v-for="option in kpOptions"
                  :key="option.code"
                  type="button"
                  class="qe-kp-option"
                  :class="{ 'is-picked': isPicked(option.code) }"
                  @click="toggleKnowledgePoint(option)"
                >
                  {{ option.name }}
                </button>
              </div>
              <p v-if="!kpOptions.length" class="qe-kp-empty">
                {{
                  kpLoading
                    ? '正在读取考点…'
                    : !form.classLevel
                      ? '请先在上面选择学段'
                      : '没有匹配的知识点'
                }}
              </p>
              <p v-else-if="kpCatalog.length > kpOptions.length" class="qe-kp-empty">
                共 {{ kpCatalog.length }} 条，输入关键词继续缩小范围
              </p>
            </div>
          </section>

          <!-- ② 题干编辑 -->
          <section v-show="step === 'content'" class="qe-panel">
            <h3 class="qe-panel-title">
              <i class="fa-solid fa-file-signature" aria-hidden="true"></i>
              <span>题干内容录入</span>
            </h3>

            <div class="qe-tabs" role="tablist" aria-label="题干录入方式">
              <button
                type="button"
                class="qe-tab"
                :class="{ 'is-active': contentTab === 'ocr' }"
                role="tab"
                :aria-selected="contentTab === 'ocr'"
                @click="contentTab = 'ocr'"
              >
                <i class="fa-solid fa-camera" aria-hidden="true"></i>
                <span>OCR 图像识别</span>
              </button>
              <button
                type="button"
                class="qe-tab"
                :class="{ 'is-active': contentTab === 'manual' }"
                role="tab"
                :aria-selected="contentTab === 'manual'"
                @click="contentTab = 'manual'"
              >
                <i class="fa-solid fa-keyboard" aria-hidden="true"></i>
                <span>手动输入</span>
              </button>
            </div>

            <!-- 辅助区只在 OCR 页出现：「手动输入」下没有任何辅助工具，
                 留个空框只会白占高度 -->
            <div v-show="contentTab === 'ocr'" class="qe-aux" data-illustration="content">
              <div class="qe-aux-head">
                <p>
                  <i class="fa-solid fa-camera" aria-hidden="true"></i>
                  <span>拖拽或上传题目截图</span>
                </p>
                <label class="qe-check">
                  <input v-model="skipTikz" type="checkbox" />
                  <span>禁用 TikZ 自动绘图，自动截取原图</span>
                </label>
              </div>
              <div
                class="qe-dropzone"
                :class="{ 'is-busy': ocrBusy === 'content' }"
                :aria-busy="ocrBusy === 'content'"
                role="button"
                tabindex="0"
                @click="pickOcrImage('content')"
                @keydown.enter.prevent="pickOcrImage('content')"
                @dragover.prevent
                @drop.prevent="onOcrDrop($event, 'content')"
              >
                <i class="fa-solid fa-crop-simple" aria-hidden="true"></i>
                <p v-if="ocrBusy === 'content'">正在识别：MinerU 解析版面与公式…</p>
                <p v-else>将题目截图拖拽到此，或点击上传 (支持截图粘贴)</p>
                <p class="qe-dropzone-sub">
                  {{
                    ocrBusy === 'content'
                      ? '通常需要几十秒，结果会写进下方「题干」框'
                      : '识别结果写进下方「题干」编辑框，可再手动润色'
                  }}
                </p>
              </div>
            </div>

            <div class="qe-editor">
              <div class="qe-editor-head">
                <label class="qe-editor-label" for="qe-content">题干<i class="req">*</i></label>
                <div class="qe-editor-tools">
                  <button type="button" class="qe-tool" @click="applyFractions('content')">
                    <i class="fa-solid fa-divide" aria-hidden="true"></i>
                    <span>规范分式</span>
                  </button>
                </div>
              </div>

              <div class="qe-editor-grid">
                <!-- 左列 = 源码框 + 配图区，宽度与题干源码框一致：配图属于「输入侧」，
                     放进右列或者铺满整行都会让人以为它是独立区块 -->
                <div class="qe-editor-column" data-illustration="content">
                  <textarea
                    id="qe-content"
                    v-model="form.content"
                    class="qe-textarea"
                    rows="8"
                    placeholder="在此输入题干内容…&#10;行内公式使用 $...$，行间公式使用 $$...$$&#10;例如：已知集合 $A = \{x | x^2 - 3x + 2 = 0\}$…"
                  ></textarea>

                  <!-- 题目配图 / 插图 -->
                  <div class="qe-illustration">
                    <div class="qe-illustration-head">
                      <i class="fa-solid fa-image" aria-hidden="true"></i>
                      <span>题目配图 / 插图</span>
                    </div>
                    <div
                      class="qe-illustration-drop"
                      :class="{ 'is-over': dragOver, 'is-busy': uploading }"
                      role="button"
                      tabindex="0"
                      :aria-busy="uploading"
                      @click="pickIllustration('content')"
                      @keydown.enter.prevent="pickIllustration('content')"
                      @dragover.prevent="dragOver = true"
                      @dragleave="dragOver = false"
                      @drop.prevent="onIllustrationDrop($event, 'content')"
                    >
                      <i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i>
                      <p>
                        {{
                          uploading
                            ? '正在保存图片…'
                            : '拖拽插图到此，或点击上传 (支持粘贴剪贴板截图)'
                        }}
                      </p>
                      <small>上传后将自动生成插图标签</small>
                      <input
                        ref="illustrationInputRef"
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        @change="onIllustrationPick($event, 'content')"
                      />
                    </div>

                    <div v-if="illustrations.length" class="qe-illustration-list">
                      <figure
                        v-for="item in illustrations"
                        :key="item.url"
                        class="qe-illustration-item"
                      >
                        <img :src="item.url" :alt="item.name" />
                        <button
                          type="button"
                          class="qe-illustration-remove"
                          :title="`移除「${item.name}」`"
                          @click="removeIllustration(item.url, 'content')"
                        >
                          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                        </button>
                        <figcaption>{{ item.name }}</figcaption>
                      </figure>
                    </div>
                  </div>
                </div>

                <div class="qe-preview">
                  <div class="qe-preview-head">
                    <span><i class="fa-solid fa-eye" aria-hidden="true"></i>实时排版预览</span>
                    <span>点图片可改尺寸</span>
                  </div>
                  <div v-if="!form.content.trim()" class="qe-preview-body qe-preview-empty">
                    在左侧框中输入，此处将实时展示最终排版效果…
                  </div>
                  <div
                    v-else
                    id="qe-content-preview"
                    class="qe-preview-body"
                    @click="onPreviewImageClick($event, 'content')"
                    @dblclick.capture.stop="() => {}"
                  ></div>
                </div>
              </div>
            </div>
          </section>

          <!-- ③ 解析编辑 -->
          <section v-show="step === 'answer'" class="qe-panel">
            <h3 class="qe-panel-title">
              <i class="fa-solid fa-list-check" aria-hidden="true"></i>
              <span>解析录入</span>
            </h3>

            <details class="qe-cheatsheet" open>
              <summary>AI、识图与图片辅助工具（可选）</summary>

              <div class="qe-tabs" role="tablist" aria-label="解析录入方式">
                <button
                  type="button"
                  class="qe-tab"
                  :class="{ 'is-active': answerTab === 'ai' }"
                  role="tab"
                  :aria-selected="answerTab === 'ai'"
                  @click="answerTab = 'ai'"
                >
                  <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
                  <span>AI 智能生成</span>
                </button>
                <button
                  type="button"
                  class="qe-tab"
                  :class="{ 'is-active': answerTab === 'ocr' }"
                  role="tab"
                  :aria-selected="answerTab === 'ocr'"
                  @click="answerTab = 'ocr'"
                >
                  <i class="fa-solid fa-camera" aria-hidden="true"></i>
                  <span>OCR 图像识别</span>
                </button>
              </div>

              <div class="qe-aux">
                <div v-show="answerTab === 'ai'">
                  <div class="qe-ai-field">
                    <label for="qe-ai-prompt">补充引导指令 (可选)</label>
                    <input
                      id="qe-ai-prompt"
                      v-model="aiPrompt"
                      type="text"
                      placeholder="可输入提示词，例如：'提供两种解答方法'，'用解析几何建系解答'…"
                    />
                  </div>
                  <div class="qe-ai-actions">
                    <button
                      type="button"
                      class="qe-thinking"
                      :class="{ 'is-on': thinking }"
                      :aria-pressed="thinking"
                      @click="thinking = !thinking"
                    >
                      <span class="qe-switch" aria-hidden="true"></span>
                      <span class="qe-thinking-label">
                        <i class="fa-solid fa-brain" aria-hidden="true"></i>
                        <span>深度思考</span>
                      </span>
                    </button>
                    <button type="button" class="qe-ai-run" @click="notImplemented('一键生成解析')">
                      <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
                      <span>一键生成解析</span>
                    </button>
                  </div>
                </div>

                <div v-show="answerTab === 'ocr'" data-illustration="answer">
                  <div class="qe-aux-head">
                    <p>
                      <i class="fa-solid fa-camera" aria-hidden="true"></i>
                      <span>拖拽或上传答案截图</span>
                    </p>
                    <label class="qe-check">
                      <input v-model="skipTikz" type="checkbox" />
                      <span>禁用 TikZ 自动绘图，自动截取原图</span>
                    </label>
                  </div>
                  <div
                    class="qe-dropzone"
                    :class="{ 'is-busy': ocrBusy === 'answer' }"
                    :aria-busy="ocrBusy === 'answer'"
                    role="button"
                    tabindex="0"
                    @click="pickOcrImage('answer')"
                    @keydown.enter.prevent="pickOcrImage('answer')"
                    @dragover.prevent
                    @drop.prevent="onOcrDrop($event, 'answer')"
                  >
                    <i class="fa-solid fa-crop-simple" aria-hidden="true"></i>
                    <p v-if="ocrBusy === 'answer'">正在识别：MinerU 解析版面与公式…</p>
                    <p v-else>将答案或题目截图拖拽到此，或点击上传 (支持粘贴)</p>
                    <p class="qe-dropzone-sub">
                      {{
                        ocrBusy === 'answer'
                          ? '通常需要几十秒，结果会写进下方「答案与解析」框'
                          : '识别结果写进下方「答案与解析」编辑框，可再手动润色'
                      }}
                    </p>
                  </div>
                </div>
              </div>
            </details>

            <div class="qe-divider" aria-hidden="true"></div>

            <div class="qe-editor">
              <div class="qe-editor-head">
                <label class="qe-editor-label" for="qe-answer">答案与解析</label>
                <div class="qe-editor-tools">
                  <button type="button" class="qe-tool" @click="applyFractions('answer')">
                    <i class="fa-solid fa-divide" aria-hidden="true"></i>
                    <span>规范分式</span>
                  </button>
                </div>
              </div>

              <div class="qe-editor-grid">
                <!-- 左列同题干：源码框 + 配图区。配图只跟源码框同宽，不铺进右列 -->
                <div class="qe-editor-column" data-illustration="answer">
                  <textarea
                    id="qe-answer"
                    v-model="form.answerMarkdown"
                    class="qe-textarea"
                    rows="10"
                    placeholder="在此处精细排版或合并您的答案与详细解析过程… 支持 LaTeX / KaTeX 公式、Markdown 段落…"
                  ></textarea>

                  <!-- 解析配图 / 插图 -->
                  <div class="qe-illustration">
                    <div class="qe-illustration-head">
                      <i class="fa-solid fa-image" aria-hidden="true"></i>
                      <span>解析配图 / 插图</span>
                    </div>
                    <div
                      class="qe-illustration-drop"
                      :class="{ 'is-over': answerDragOver, 'is-busy': answerUploading }"
                      role="button"
                      tabindex="0"
                      :aria-busy="answerUploading"
                      @click="pickIllustration('answer')"
                      @keydown.enter.prevent="pickIllustration('answer')"
                      @dragover.prevent="answerDragOver = true"
                      @dragleave="answerDragOver = false"
                      @drop.prevent="onIllustrationDrop($event, 'answer')"
                    >
                      <i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i>
                      <p>
                        {{
                          answerUploading
                            ? '正在保存图片…'
                            : '拖拽插图到此，或点击上传 (支持粘贴剪贴板截图)'
                        }}
                      </p>
                      <small>上传后将自动追加到解析末尾</small>
                      <input
                        ref="answerIllustrationInputRef"
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        @change="onIllustrationPick($event, 'answer')"
                      />
                    </div>
                  </div>
                </div>

                <div class="qe-preview">
                  <div class="qe-preview-head">
                    <span><i class="fa-solid fa-eye" aria-hidden="true"></i>解析最终排版预览</span>
                    <span>实时同步 · 点图片可改尺寸</span>
                  </div>
                  <div v-if="!form.answerMarkdown.trim()" class="qe-preview-body qe-preview-empty">
                    在左侧输入解析内容，此处将实时展示最终排版效果…
                  </div>
                  <div
                    v-else
                    id="qe-answer-preview"
                    class="qe-preview-body"
                    @click="onPreviewImageClick($event, 'answer')"
                    @dblclick.capture.stop="() => {}"
                  ></div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// 「录入新数学题」弹窗：新建与编辑共用一套表单。
//
// 数据流：本组件只维护一份扁平表单 → 保存时拼成 ExerciseInput → 交给
// utils/question-bank 的 saveQuestion（主进程做校验/查重/事务）。分类的合法值
// 来自 math-parse 的教材树（与导入中心的卡片同一个来源），这样手录的题和拆题
// 入库的题在库里长得一样，本地题库的筛选、检索都能直接用。
//
// 实时预览走 Milkdown 只读实例（前缀固定、切题只 setMarkdown），与详情页同一条
// 渲染管线；公式排版因此和最终显示完全一致，不会出现「预览好看、详情崩掉」。
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import '../assets/fontawesome/css/all.min.css'
import '../styles/question-editor.css'
import {
  describeQuestionBankError,
  diskPathOfFile,
  fetchDictionaries,
  fetchKeyPoints,
  saveQuestion,
  saveQuestionImage,
  type ExerciseInput,
  type ExerciseListItem,
  type KnowledgePointOption
} from '../utils/question-bank'
import { STAGE_OPTIONS, isStageCode } from '../utils/class-level'
import { showToast } from '../utils/math-parse'
import { normalizeFractionStyle } from '../utils/fraction-style'
import { mountReadonlyPreview, offPreviewChange, onPreviewChange } from '../utils/readonly-preview'
import { getActiveEditorId, getEditorView, setActiveEditor } from '../../renderer/editor/editor'
import { imageModal, type ImageAttrs } from '../../renderer/editor/image-modal'
import { showError, showSuccess } from '../stores/toast'

type StepKey = 'classification' | 'content' | 'answer'

const STEPS: { key: StepKey; index: number; title: string; hint: string }[] = [
  { key: 'classification', index: 1, title: '分类信息', hint: '题型与知识归属' },
  { key: 'content', index: 2, title: '题干编辑', hint: 'OCR、正文与插图' },
  { key: 'answer', index: 3, title: '解析编辑', hint: '答案、解析与关联' }
]

/** 兜底：字典拉不到时至少能录数学题（与主进程 seed 的数学四类一致） */
const FALLBACK_SUBJECTS = [{ code: '0001', name: '数学' }]
const FALLBACK_TYPES = [
  { code: 'single_choice', name: '单选题', parent: '0001' },
  { code: 'multi_choice', name: '多选题', parent: '0001' },
  { code: 'fill_in_blank', name: '填空题', parent: '0001' },
  { code: 'detailed_answer', name: '解答题', parent: '0001' }
]
const FALLBACK_EASY = [
  { value: '1', label: '很易' },
  { value: '2', label: '易' },
  { value: '3', label: '中' },
  { value: '4', label: '难' },
  { value: '5', label: '拔高' }
]

const props = defineProps<{
  open: boolean
  /** 有值 = 编辑已有题目（保存走 UPDATE），null = 新建 */
  item: ExerciseListItem | null
}>()

const emit = defineEmits<{
  close: []
  saved: [id: number | null]
}>()

const step = ref<StepKey>('classification')
// 默认停在「手动输入」：OCR 要联网且要等几十秒，一进来就停在识别页没必要
const contentTab = ref<'ocr' | 'manual'>('manual')
const answerTab = ref<'ai' | 'ocr'>('ai')
const skipTikz = ref(false)
const thinking = ref(true)
const aiPrompt = ref('')
const saving = ref(false)
const kpOpen = ref(false)
const kpKeyword = ref('')
const kpLoading = ref(false)
const kpCatalog = ref<KnowledgePointOption[]>([])
/** 字典：科目 / 年级 / 题型 / 难度。分类的合法值全部来自这里 */
const dictionaries = ref<{
  subjects: { code: string; name: string }[]
  classLevels: { code: string; name: string; parent?: string }[]
  subjectTypes: { code: string; name: string; parent?: string }[]
  easyLevels: { value: string; label: string }[]
}>({ subjects: [], classLevels: [], subjectTypes: [], easyLevels: [] })

// 配图状态（声明要在 resetForm 之前：watch(open, {immediate}) 会在挂载时同步跑一遍
// resetForm，那时 const 还没初始化就是 TDZ 报错）
interface IllustrationItem {
  url: string
  name: string
}

const illustrations = ref<IllustrationItem[]>([])
const illustrationInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const dragOver = ref(false)

// 解析区的配图：落盘与插入逻辑与题干共用，只是目标文本换成 answerMarkdown
const answerIllustrations = ref<IllustrationItem[]>([])
const answerIllustrationInputRef = ref<HTMLInputElement | null>(null)
const answerUploading = ref(false)
const answerDragOver = ref(false)

/** 插图插到哪一段：题干 or 解析（两块的 markdown 字段不同） */
type IllustrationTarget = 'content' | 'answer'

/** 正在 OCR 的是哪一块（null = 空闲）。两块共用一条链路，同一时间只跑一个 */
const ocrBusy = ref<IllustrationTarget | null>(null)

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 插图标签名（alt / 图注）的上限：原文件名再长也压到 26 个字符 */
const MAX_ILLUSTRATION_LABEL = 26
/** 只认 file:// 的插图标签：网络图（https）不该出现在本地题库里 */
const ILLUSTRATION_PATTERN = /!\[([^\]]*)\]\((file:[^)\s]+)\)/g

const form = reactive({
  subjectCode: '0001',
  subjectTypeCode: 'single_choice',
  easy: '3',
  classLevel: '',
  source: '',
  content: '',
  answerMarkdown: '',
  // role 要带着：编辑已有题目时如果统一重置成 main，会把原来的辅助知识点悄悄改成主考点
  knowledgePoints: [] as { code: string; name: string; role: 'main' | 'auxiliary' }[]
})

const subjectOptions = computed(() =>
  dictionaries.value.subjects.length ? dictionaries.value.subjects : FALLBACK_SUBJECTS
)

/** 题型按科目筛：subject_type.parent 就是科目码 */
const typeOptions = computed(() => {
  const all = dictionaries.value.subjectTypes.length
    ? dictionaries.value.subjectTypes
    : FALLBACK_TYPES
  const list = all.filter((item) => !item.parent || item.parent === form.subjectCode)
  return withCurrentOption(list, { code: form.subjectTypeCode, name: form.subjectTypeCode })
})

const easyOptions = computed(() =>
  dictionaries.value.easyLevels.length ? dictionaries.value.easyLevels : FALLBACK_EASY
)

/**
 * 历史数据里的年级码（01…12 / 201）—— 年级已改成学段，这些值仍要能显示出来：
 * 下拉里补一条只读选项，避免编辑老题时显示成空白而保存又能过。
 */
const legacyClassLevel = computed(() => {
  const value = String(form.classLevel ?? '').trim()
  return value && !isStageCode(value) ? value : ''
})

// 候选项要把「当前值」并进去：编辑历史题目时，它记的科目/年级可能已经不在字典里
// （字典改过、或者是旧数据）。不并进去下拉就没有对应 option，界面会显示成空值 ——
// 用户以为没选，保存却又能过，最难解释。
function withCurrentOption<T extends { code: string; name: string }>(
  list: T[],
  current: { code: string; name: string }
): T[] {
  // 学段码（跨年级）不在年级字典里，但它有自己的选项，不该被标成「不在当前字典」
  if (!current.code || isStageCode(current.code) || list.some((item) => item.code === current.code)) {
    return list
  }
  return [...list, { code: current.code, name: `${current.name}（不在当前字典）` } as T]
}

const headingSubtitle = computed(() =>
  props.item ? `#${props.item.id} · 编辑中` : '新题目 · 尚未入库'
)

/**
 * 入库用的学段：表单里选的就是学段码，直接用。
 * 历史数据存的是年级码（01…12 / 201）时从字典的 parent 反推；都认不出按 other 落
 * —— exercise.stage 是必填且有枚举约束，不能留空。
 */
function stageOf(classLevel: string): string {
  if (isStageCode(classLevel)) return classLevel
  const hit = dictionaries.value.classLevels.find((item) => item.code === classLevel)
  return hit?.parent && isStageCode(hit.parent) ? hit.parent : 'other'
}

/** 编辑已有题时回填学段：记录里的 stage 优先，其次 class_level 本身是学段码的情况 */
function stageValueOf(item?: ExerciseListItem | null): string {
  const stage = String(item?.stage ?? '').trim()
  if (isStageCode(stage)) return stage
  const level = String(item?.classLevel ?? '').trim()
  return isStageCode(level) ? level : ''
}

const missing = computed(() => {
  const list: string[] = []
  if (!form.content.trim()) list.push('题干')
  if (!form.subjectCode) list.push('科目')
  if (!form.subjectTypeCode) list.push('题型')
  return list
})

const ready = computed(() => missing.value.length === 0)

const hintText = computed(() =>
  ready.value
    ? '信息已齐全，可以保存。'
    : `保存前请补充: ${missing.value.join('、')}。带 * 的项目为必填项。`
)

const kpOptions = computed(() => {
  const keyword = kpKeyword.value.trim()
  if (!keyword) return kpCatalog.value.slice(0, 80)
  return kpCatalog.value
    .filter((option) => option.name.includes(keyword) || option.code.includes(keyword))
    .slice(0, 80)
})

// ── 初始化 / 预填 ───────────────────────────────────────────────────────────

function resetForm(): void {
  const item = props.item
  form.subjectCode = item?.subjectCode || '0001'
  form.subjectTypeCode = item?.subjectTypeCode || 'single_choice'
  form.easy = item?.easy || '3'
  // 学段取代了年级：老题记的是年级码，这里换成它的学段（原值在表单里以只读选项兜底）
  form.classLevel = stageValueOf(item) || (item?.classLevel ?? '')
  form.source = item?.source ?? ''
  form.content = item?.content ?? ''
  form.answerMarkdown = item?.answerMarkdown ?? ''
  // 知识点词表随科目 + 年级变：编辑时重新拉一次，别用上一次打开时的缓存
  kpCatalog.value = []
  // 题干 / 解析里已有的插图标签还原成缩略图，否则编辑时看不到已经配了哪些图
  illustrations.value = parseIllustrations(form.content)
  answerIllustrations.value = parseIllustrations(form.answerMarkdown)
  uploading.value = false
  dragOver.value = false
  answerUploading.value = false
  answerDragOver.value = false
  ocrBusy.value = null
  form.knowledgePoints = (item?.knowledgePoints ?? []).map((point) => ({
    code: point.code,
    name: point.name,
    role: point.role
  }))
  step.value = 'classification'
  contentTab.value = 'manual'
  answerTab.value = 'ai'
  kpOpen.value = false
  kpKeyword.value = ''
  aiPrompt.value = ''
  thinking.value = true
}

watch(
  () => props.open,
  (open) => {
    if (open) resetForm()
  },
  { immediate: true }
)

async function loadCatalog(): Promise<void> {
  const dict = await fetchDictionaries()
  if (!dict.subjects.length && !dict.classLevels.length && !dict.subjectTypes.length) return
  dictionaries.value = dict
}

async function loadKnowledge(): Promise<void> {
  kpLoading.value = true
  // 考点按「科目 + 学段」查 key_points 那张全量考点树（不是拆题用的短词表）。
  // 编辑历史题时表单里可能还是年级码，先换成学段再查，否则一定查空。
  const stage = isStageCode(form.classLevel) ? form.classLevel : stageOf(form.classLevel)
  kpCatalog.value = await fetchKeyPoints(form.subjectCode, stage)
  kpLoading.value = false
}

// ── 分类联动 ────────────────────────────────────────────────────────────────

/**
 * 换科目：题型与知识点都要重选。
 *
 * 题型表的 parent 是科目码，旧题型码多半不属于新科目（主进程会报
 * SUBJECT_TYPE_MISMATCH）；知识点按科目取，留着旧科目的点同样会入库失败。
 */
function onSubjectChange(): void {
  form.subjectTypeCode = typeOptions.value[0]?.code ?? ''
  form.knowledgePoints = []
  kpCatalog.value = []
  if (kpOpen.value) void loadKnowledge()
}

/** 换学段：考点范围整批换（key_points 按 class_level = 学段筛），已选的要清掉 */
function onClassLevelChange(): void {
  form.knowledgePoints = []
  kpCatalog.value = []
  if (kpOpen.value) void loadKnowledge()
}

// ── 知识点 ──────────────────────────────────────────────────────────────────

function toggleKpPanel(): void {
  kpOpen.value = !kpOpen.value
  if (kpOpen.value) void loadKnowledge()
}

function isPicked(code: string): boolean {
  return form.knowledgePoints.some((point) => point.code === code)
}

function toggleKnowledgePoint(option: KnowledgePointOption): void {
  if (isPicked(option.code)) {
    removeKnowledgePoint(option.code)
    return
  }
  form.knowledgePoints.push({ code: option.code, name: option.name, role: 'main' })
}

function removeKnowledgePoint(code: string): void {
  form.knowledgePoints = form.knowledgePoints.filter((point) => point.code !== code)
}

// ── 实时预览（Milkdown 只读实例）────────────────────────────────────────────

let previewTimer: number | undefined

function schedulePreview(): void {
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => {
    void renderPreview('content')
    void renderPreview('answer')
  }, 260)
}

async function renderPreview(kind: 'content' | 'answer'): Promise<void> {
  if (!props.open) return
  const rootId = kind === 'content' ? 'qe-content-preview' : 'qe-answer-preview'
  const text = kind === 'content' ? form.content : form.answerMarkdown
  if (!text.trim()) return
  await nextTick()
  if (!document.getElementById(rootId)) return
  void mountReadonlyPreview(rootId, text)
}

watch(() => [form.content, form.answerMarkdown], schedulePreview)
watch([step, () => props.open], () => {
  if (!props.open) return
  schedulePreview()
})

// ── 预览里的图片：点开参数面板改尺寸 ──────────────────────────────────────
//
// 预览实例是只读的（CSS pointer-events + tabIndex），唯一放开的交互是图片：
// 点一下弹正文同款参数面板（imageModal），保存后它 dispatch 改预览实例的 attrs，
// 再由 onPreviewChange 把 markdown 回写到左侧编辑框 —— 不回写的话，用户下一次
// 敲字触发的 setMarkdown 会把尺寸改动整篇覆盖掉。
//
// 为什么回写整篇而不是只替换那一张图的标签：面板能改 src / alt / 对齐 / 边框，
// 逐项拼回去等于重写一遍序列化器；预览实例用的本来就是同一套（往返保真修过）
// 序列化器，代价只是文本可能被规范化成等价的写法。

const PREVIEW_ROOT: Record<IllustrationTarget, string> = {
  content: 'qe-content-preview',
  answer: 'qe-answer-preview'
}

/** 面板保存后允许一次回写：用来跳过 setMarkdown 自身触发的那次 markdownUpdated */
let acceptPreviewWriteBack = false

const previewChangeListeners: Array<[string, (markdown: string) => void]> = []

for (const target of ['content', 'answer'] as const) {
  const rootId = PREVIEW_ROOT[target]
  const listener = (markdown: string): void => {
    if (!acceptPreviewWriteBack) return
    acceptPreviewWriteBack = false
    // 内容没变说明只是 setMarkdown 回灌，不是面板改出来的东西
    const current = target === 'answer' ? form.answerMarkdown : form.content
    if (markdown.trim() === current.trim()) return
    if (target === 'answer') form.answerMarkdown = markdown
    else form.content = markdown
    showSuccess('图片参数已更新')
  }
  previewChangeListeners.push([rootId, listener])
  onPreviewChange(rootId, listener)
}

onBeforeUnmount(() => {
  for (const [rootId, listener] of previewChangeListeners) offPreviewChange(rootId, listener)
})

/** 最小结构类型：只为拿 pos，不为一个方法把 prosemirror 类型引进 adminPanel */
interface PreviewEditorView {
  posAtDOM: (node: Node, offset: number) => number
  state: {
    doc: {
      content: { size: number }
      nodeAt: (pos: number) => { type: { name: string }; attrs: Record<string, unknown> } | null
    }
  }
}

/** 图片 nodeView 的 DOM → 文档位置。posAtDOM 可能落在 atom 节点内侧，前后各试一次 */
function locateImagePos(view: PreviewEditorView, dom: HTMLElement): number | null {
  try {
    const base = view.posAtDOM(dom, 0)
    for (const pos of [base, base - 1]) {
      if (pos < 0 || pos > view.state.doc.content.size) continue
      if (view.state.doc.nodeAt(pos)?.type.name === 'image') return pos
    }
  } catch {
    // 面板开着时预览被 setMarkdown 重建：DOM 已经失效，放弃这次
  }
  return null
}

function onPreviewImageClick(event: MouseEvent, target: IllustrationTarget): void {
  const dom = (event.target as HTMLElement | null)?.closest?.('.teyoo-image-view')
  if (!(dom instanceof HTMLElement)) return
  const view = getEditorView(PREVIEW_ROOT[target])
  if (!view) return
  const pos = locateImagePos(view, dom)
  if (pos == null) return
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  // imageModal 保存时取的是「活跃实例」：先把活跃实例切到这块预览，关面板再还回去
  const previous = getActiveEditorId()
  setActiveEditor(PREVIEW_ROOT[target])
  acceptPreviewWriteBack = true
  const attrs: ImageAttrs = {
    src: String(node.attrs.src ?? ''),
    alt: String(node.attrs.alt ?? ''),
    width: String(node.attrs.width ?? ''),
    height: String(node.attrs.height ?? ''),
    align: String(node.attrs.align ?? ''),
    border: node.attrs.border === true,
    shadow: node.attrs.shadow === true,
    radius: node.attrs.radius === true
  }
  imageModal.show(attrs, pos, () => {
    if (previous) setActiveEditor(previous)
  })
}

// ── 题目配图 / 插图 ────────────────────────────────────────────────────────
//
// 图片落盘交给主进程，默认写进「工作目录/images」（与编辑器插图、docx 导入同一
// 处）；源图已经在那里时直接引用，不重复复制。markdown 里只留一个 file:// 标签
// —— 题干是要反复编辑的文本，不能塞 base64。CSP 的 img-src 已经放行 file:。

/** 从题干 / 解析里认出已有的插图标签（编辑已有题目时要还原缩略图列表） */
function parseIllustrations(markdown: string): IllustrationItem[] {
  const list: IllustrationItem[] = []
  const seen = new Set<string>()
  for (const match of markdown.matchAll(ILLUSTRATION_PATTERN)) {
    const url = match[2]
    if (seen.has(url)) continue
    seen.add(url)
    list.push({ url, name: match[1]?.trim() || '插图' })
  }
  return list
}

function describeImageError(code?: string): string {
  if (code === 'IMAGE_TOO_LARGE') return '图片超过 8MB，请先压缩再上传'
  if (code === 'EMPTY_IMAGE') return '没有读到图片内容，请重试'
  if (code === 'NO_BRIDGE') return '当前环境不支持保存图片（需要桌面版）'
  return `保存配图失败：${code ?? '未知错误'}`
}

function isUploading(target: IllustrationTarget): boolean {
  return target === 'answer' ? answerUploading.value : uploading.value
}

function setUploading(target: IllustrationTarget, value: boolean): void {
  if (target === 'answer') answerUploading.value = value
  else uploading.value = value
}

function setDragOver(target: IllustrationTarget, value: boolean): void {
  if (target === 'answer') answerDragOver.value = value
  else dragOver.value = value
}

function illustrationList(target: IllustrationTarget) {
  return target === 'answer' ? answerIllustrations : illustrations
}

function pickIllustration(target: IllustrationTarget = 'content'): void {
  if (isUploading(target)) return
  if (target === 'answer') answerIllustrationInputRef.value?.click()
  else illustrationInputRef.value?.click()
}

async function onIllustrationPick(
  event: Event,
  target: IllustrationTarget = 'content'
): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  // 先清空 value：同一个文件连选两次不会再触发 change
  input.value = ''
  await uploadIllustrations(files, target)
}

async function onIllustrationDrop(
  event: DragEvent,
  target: IllustrationTarget = 'content'
): Promise<void> {
  setDragOver(target, false)
  await uploadIllustrations(Array.from(event.dataTransfer?.files ?? []), target)
}

/**
 * 粘贴剪贴板截图：只在剪贴板里真的有图片时接管，文本粘贴照常走。
 * 落到哪一块由事件源所在列决定（题干列 / 解析列都带 data-illustration）。
 */
function onPaste(event: ClipboardEvent): void {
  const items = Array.from(event.clipboardData?.items ?? [])
  const files = items
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
  if (!files.length) return
  event.preventDefault()
  const source = (event.target as HTMLElement | null)?.closest('[data-illustration="answer"]')
  const target: IllustrationTarget = source ? 'answer' : 'content'
  // OCR 页里粘贴截图是「识别这道题」，不是「给题目配一张图」
  if (ocrTabActive(target)) {
    void fileToDataUrl(files[0])
      .then((dataUrl) => recognizeImage(target, { dataUrl }))
      .catch(() => showError('读取截图失败，请重试'))
    return
  }
  void uploadIllustrations(files, target)
}

async function uploadIllustrations(
  files: File[],
  target: IllustrationTarget = 'content'
): Promise<void> {
  const images = files.filter((file) => file.type.startsWith('image/'))
  if (!images.length) {
    if (files.length) showError('只支持图片文件')
    return
  }

  setUploading(target, true)
  try {
    for (const file of images) {
      // 本地文件先拿磁盘路径：图片本来就在工作目录的 images 里时，主进程直接引用，
      // 不在里面才拷一份进去。粘贴的剪贴板截图没有路径，只能把字节送过去。
      const sourcePath = diskPathOfFile(file)
      if (!sourcePath && file.size > MAX_IMAGE_BYTES) {
        showError(`「${file.name}」超过 8MB，请先压缩再上传`)
        continue
      }
      const data = sourcePath ? undefined : new Uint8Array(await file.arrayBuffer())
      const result = await saveQuestionImage({ name: file.name, data, sourcePath })
      if (!result.ok || !result.url) {
        showError(describeImageError(result.error))
        continue
      }
      insertIllustration(result.url, file.name, target)
    }
  } finally {
    setUploading(target, false)
  }
}

function insertIllustration(
  url: string,
  fileName: string,
  target: IllustrationTarget = 'content'
): void {
  // 图注（markdown 的 alt / 缩略图下方那行）取原文件名，但压到 26 个字符以内：
  // 手机截图自带的文件名动不动几十个字，不截断会把图注撑成两行
  const cleaned = fileName.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '').trim()
  const label = (cleaned || '插图').slice(0, MAX_ILLUSTRATION_LABEL)
  const tag = `![${label}](${url})`
  if (target === 'answer') {
    const current = form.answerMarkdown.trimEnd()
    form.answerMarkdown = current ? `${current}\n\n${tag}\n` : `${tag}\n`
  } else {
    const current = form.content.trimEnd()
    form.content = current ? `${current}\n\n${tag}\n` : `${tag}\n`
  }
  const list = illustrationList(target)
  if (!list.value.some((item) => item.url === url)) {
    list.value.push({ url, name: label })
  }
  showSuccess(target === 'answer' ? '插图已插入解析' : '插图已插入题干')
}

/** 移除插图：标签与缩略图一起删，避免「图没了但 markdown 还留着断链」 */
function removeIllustration(url: string, target: IllustrationTarget = 'content'): void {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)\\s*`, 'g')
  if (target === 'answer') {
    form.answerMarkdown = form.answerMarkdown
      .replace(pattern, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()
  } else {
    form.content = form.content
      .replace(pattern, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()
  }
  const list = illustrationList(target)
  list.value = list.value.filter((item) => item.url !== url)
}

// ── OCR 图像识别（MinerU）──────────────────────────────────────────────────
//
// 截图 → MinerU 版式解析 → 整篇 Markdown，直接填进题干 / 解析编辑框。
// 请求全在主进程（签名上传链接与 token 都不过桥），这里只维护「正在识别」这一个状态。

interface OcrBridge {
  pickMineruImageFile?: () => Promise<string | null>
  imageToMarkdown?: (payload: {
    filePath?: string
    dataUrl?: string
  }) => Promise<{ ok: boolean; text?: string; error?: string }>
}

function ocrBridge(): OcrBridge {
  return (window as unknown as { electronAPI?: OcrBridge }).electronAPI ?? {}
}

function ocrTabActive(target: IllustrationTarget): boolean {
  return target === 'answer' ? answerTab.value === 'ocr' : contentTab.value === 'ocr'
}

function describeOcrError(code?: string): string {
  if (code === 'NO_MINERU_TOKEN') {
    return '未配置 MinerU Token：在「设置 → AI 与识别」里填好才能 OCR（也可以切「手动输入」）'
  }
  if (code === 'NO_BRIDGE') return '当前环境不支持 OCR（需要桌面版）'
  if (code === 'NOT_AN_IMAGE') return '只支持 PNG / JPG / WebP 等图片格式'
  if (code === 'BAD_IMAGE') return '没有读到图片，请重试'
  if (code === 'EMPTY_RESULT') return 'MinerU 没识别出文字，换一张更清晰的截图试试'
  if (code === 'TIMEUP') return '识别超时：MinerU 排队较久，稍后重试或换张小一点的图'
  return `识别失败：${code ?? '未知错误'}`
}

/** 识别结果落进编辑框：已有内容就追加，不覆盖已经写好的部分 */
function writeRecognizedMarkdown(target: IllustrationTarget, markdown: string): void {
  const text = markdown.trim()
  if (!text) return
  if (target === 'answer') {
    const current = form.answerMarkdown.trimEnd()
    form.answerMarkdown = current ? `${current}\n\n${text}\n` : `${text}\n`
  } else {
    const current = form.content.trimEnd()
    form.content = current ? `${current}\n\n${text}\n` : `${text}\n`
  }
}

async function recognizeImage(
  target: IllustrationTarget,
  source: { filePath?: string; dataUrl?: string }
): Promise<void> {
  if (ocrBusy.value) return
  const api = ocrBridge()
  if (typeof api.imageToMarkdown !== 'function') {
    showError(describeOcrError('NO_BRIDGE'))
    return
  }
  ocrBusy.value = target
  try {
    const result = await api.imageToMarkdown(source)
    if (!result.ok || !result.text) {
      showError(describeOcrError(result.error))
      return
    }
    writeRecognizedMarkdown(target, result.text)
    showSuccess(target === 'answer' ? 'OCR 结果已写入解析编辑框' : 'OCR 结果已写入题干编辑框')
  } catch (error) {
    showError(describeOcrError(error instanceof Error ? error.message : String(error)))
  } finally {
    ocrBusy.value = null
  }
}

/** 点「上传」：直接用主进程的选图框拿路径，省一次图片落盘 */
async function pickOcrImage(target: IllustrationTarget): Promise<void> {
  if (ocrBusy.value) return
  const api = ocrBridge()
  if (typeof api.pickMineruImageFile !== 'function') {
    showError(describeOcrError('NO_BRIDGE'))
    return
  }
  const filePath = await api.pickMineruImageFile()
  if (!filePath) return
  await recognizeImage(target, { filePath })
}

/** 拖进来的文件没有磁盘路径（新版 Electron 去掉了 File.path），统一转 data URL 交主进程 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('READ_FAILED'))
    reader.readAsDataURL(file)
  })
}

async function onOcrDrop(event: DragEvent, target: IllustrationTarget): Promise<void> {
  const file = Array.from(event.dataTransfer?.files ?? []).find((item) =>
    item.type.startsWith('image/')
  )
  if (!file) {
    showError('请拖入图片文件')
    return
  }
  try {
    await recognizeImage(target, { dataUrl: await fileToDataUrl(file) })
  } catch (error) {
    showError(describeOcrError(error instanceof Error ? error.message : String(error)))
  }
}

// ── 工具按钮 ────────────────────────────────────────────────────────────────

function applyFractions(kind: 'content' | 'answer'): void {
  const before = kind === 'content' ? form.content : form.answerMarkdown
  const after = normalizeFractionStyle(before)
  if (after === before) {
    showToast('没有需要规范的分式：只处理成对 $…$ / $$…$$ 里的 \\frac', 'info')
    return
  }
  if (kind === 'content') form.content = after
  else form.answerMarkdown = after
  showSuccess('已规范分式：主体改 \\dfrac，上下标与内层保持 \\frac')
}

/**
 * 未接入的能力（OCR / AI 生成 / 图片答案 / TikZ 绘图）。
 *
 * 按钮位置和样式按截图还原，但功能这一版没做 —— 点下去必须给一句明确的话，
 * 不能静默：静默的按钮比没有按钮更让人困惑。
 */
function notImplemented(name: string): void {
  showToast(`${name}暂未接入：这一版只支持手动录入题干与解析`, 'info')
}

// ── 保存 ────────────────────────────────────────────────────────────────────

async function save(): Promise<void> {
  if (saving.value) return
  if (missing.value.length) {
    step.value = missing.value.includes('题干') ? 'content' : 'classification'
    showToast(`还差 ${missing.value.join('、')} 才能保存`, 'warning')
    return
  }

  saving.value = true
  try {
    // 入库只认编码：v2 的「主/辅」由数组顺序表达（下标 0 = 主要考查）。
    // 手录没有模型证据链，别伪造 evidence / reason —— 那会让库里看起来像模型挑的。
    const ordered = [
      ...form.knowledgePoints.filter((point) => point.role === 'main'),
      ...form.knowledgePoints.filter((point) => point.role !== 'main')
    ]
    const input: ExerciseInput = {
      subjectCode: form.subjectCode,
      stage: stageOf(form.classLevel),
      classLevel: form.classLevel,
      // 学段不区分学期：key_points 里也没有学期维度，term 一律留空
      term: '',
      subjectTypeCode: form.subjectTypeCode,
      easy: form.easy,
      content: form.content,
      answerMarkdown: form.answerMarkdown,
      source: form.source.trim() || null,
      knowledgePointCodes: Array.from(new Set(ordered.map((point) => point.code)))
    }

    const options = props.item ? { id: props.item.id } : undefined
    const result = await saveQuestion(input, options)

    if (result.ok) {
      showSuccess(props.item ? '已保存修改' : '已存入本地题库')
      emit('saved', result.id ?? props.item?.id ?? null)
      return
    }

    if (result.duplicate) {
      const hint = result.duplicate.source ? `（${result.duplicate.source}）` : ''
      const again = window.confirm(
        `题库里已有同一道题 #${result.duplicate.id}${hint}。\n仍要再存一条吗？`
      )
      if (!again) return
      const forced = await saveQuestion(input, { ...(options ?? {}), force: true })
      if (forced.ok) {
        showSuccess('已作为独立题目存入')
        emit('saved', forced.id ?? null)
      } else {
        showError(describeQuestionBankError(forced.error))
      }
      return
    }

    showError(describeQuestionBankError(result.error))
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error))
  } finally {
    saving.value = false
  }
}

/**
 * 清空草稿：只清内容，不清「这条题是谁」。
 *
 * 编辑态下 id 留着（保存仍然更新同一条记录），分类也保留 —— 用户清空多半是想
 * 重写题干，不是想重选一遍学段章节。
 */
function clearDraft(): void {
  if (!window.confirm('清空当前填写的题干与解析？')) return
  form.content = ''
  form.answerMarkdown = ''
  form.source = ''
}

function close(): void {
  emit('close')
}

// ── Esc 关闭 + 生命周期 ─────────────────────────────────────────────────────

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) close()
}

onMounted(() => {
  void loadCatalog()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearTimeout(previewTimer)
})
</script>
