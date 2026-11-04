<template>
  <!-- 导入中心：UI 按 MathBank 的 static/index.html#importWorkspaceSection 一比一还原。
       样式来源两份：daoru-center.css（app.css 里 pull 出来的自定义类）与
       daoru-center.tailwind.css（Tailwind 3 针对本文件生成的工具类，已作用域到
       #daoru-center）。两者都不进全局，见各自的文件头。

       功能边界：docx / tex / md 由主进程本地归一成 Markdown；PDF 走 MinerU 云识别
      （math-parse-pdf 通道）。两条来源在「拆题」这一步合流，之后的锁公式、审查卡、
      入库完全共用一套逻辑。 -->

  <section id="daoru-center" class="import-workspace-section">
    <div class="import-workspace-shell flex w-full flex-col overflow-hidden">
      <!-- 标题区：workspace-context-heading 是视觉隐藏（sr-only），只为无障碍保留语义 ——
           这也是截图里看不到「导入中心」标题的原因，别把它当遗漏删掉 -->
      <div
        class="workspace-context-heading import-workspace-header flex justify-between items-center border-b border-slate-200/50 px-6 py-4 shrink-0"
      >
        <div class="import-workspace-heading">
          <span class="import-workspace-heading-icon" aria-hidden="true">
            <i class="fa-solid fa-file-import"></i>
          </span>
          <div>
            <h3 id="importWorkspaceTitle" class="font-bold text-lg text-slate-800">导入中心</h3>
            <p>PDF、Word、LaTeX 与 Markdown 试卷的拆解、审查和批量入库</p>
          </div>
        </div>
      </div>

      <ol class="import-workspace-steps" aria-label="试卷导入流程">
        <li v-for="item in steps" :key="item.no" :class="{ 'is-current': item.no === step }">
          <span>{{ item.no }}</span>
          <div>
            <strong>{{ item.title }}</strong>
            <small>{{ item.hint }}</small>
          </div>
        </li>
      </ol>

      <div id="importWorkspaceContent" class="import-workspace-content flex-1 flex overflow-hidden">
        <!-- 左栏：试卷输入（右上角的折叠按钮可把它整个收起，审查区随之占满） -->
        <div
          id="importInputPane"
          v-show="!inputPaneCollapsed"
          class="import-source-pane w-5/12 border-r border-slate-200 p-6 overflow-y-auto space-y-4 bg-white/50 flex flex-col"
        >
          <!-- 本地 PDF 工程：实际渲染里由「有没有本地工程」决定是否出现，没有时不显示 -->
          <details v-show="showLocalProjects" class="import-config-card shrink-0 text-xs">
            <summary class="cursor-pointer font-semibold text-slate-700">本地 PDF 工程 · 保留 7 天</summary>
            <p class="mt-2 text-[11px] text-slate-500">
              原 PDF、识别工作稿和校对稿保存在本机服务，最后使用后保留 7 天。
            </p>
            <button type="button" class="glass-btn rounded-lg px-3 py-2 my-2 text-xs font-semibold">
              刷新工程列表
            </button>
            <div class="space-y-2"></div>
          </details>

          <!-- 试卷标题 -->
          <div class="import-config-card space-y-1.5 shrink-0">
            <label for="importPaperTitle" class="block text-xs font-bold text-slate-500">
              试卷标题（可选，用作题目来源）
            </label>
            <input
              id="importPaperTitle"
              v-model="paperTitle"
              type="text"
              placeholder="请输入试卷标题，例如：XX中学2025-2026高一期中"
              class="w-full px-3.5 py-2 border border-slate-200 rounded-xl outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all text-xs"
            />
          </div>

          <!-- 学科 → 学段两层选择：
               学科决定题型候选、知识点范围与要不要锁公式；
               学段决定 prompt 里的角色句与题型口径；
               年级/学期不在这里选 —— 整卷、跨年级是常态，词表一律取全量。 -->
          <div class="import-config-card space-y-2 shrink-0">
            <div class="flex items-center justify-between gap-2">
              <label for="importSubject" class="block text-xs font-bold text-slate-500">
                学科<i class="text-rose-500">*</i>
              </label>
              <span class="text-[10px] text-slate-400">决定题型与知识点词表</span>
            </div>
            <select
              id="importSubject"
              v-model="subjectCode"
              class="w-full px-3 py-2 border border-slate-200 rounded-xl outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all text-xs bg-white"
            >
              <option value="">-- 选择科目 --</option>
              <option v-for="item in catalog.subjects" :key="item.code" :value="item.code">
                {{ item.name }}
              </option>
            </select>

            <!-- 学段：单选，决定 prompt 里的角色句与题型口径。
                 年级/学期不再在这里选：拖进来的多是整卷或跨年级题，勾选只会
                 收窄知识点词表、把 prompt 变短却更容易漏点；现在一律取全量。 -->
            <div class="flex items-center justify-between gap-2 pt-1">
              <span class="text-xs font-bold text-slate-500">学段</span>
              <span class="text-[10px] text-slate-400">决定角色句与题型口径</span>
            </div>
            <div class="import-stage-grid">
              <button
                v-for="item in STAGES"
                :key="item.code"
                type="button"
                class="px-2 py-1 rounded-lg border text-[10px] font-semibold transition-colors"
                :class="
                  stage === item.code
                    ? 'bg-brand-50 text-brand-700 border-brand-200'
                    : 'bg-white text-slate-500 border-slate-200 hover:border-brand-300'
                "
                @click="pickStage(item.code)"
              >
                {{ item.name }}
              </button>
            </div>
          </div>

          <!-- 文件拖放区 -->
          <div class="import-config-card space-y-1.5 flex-1 flex flex-col min-h-[220px]">
            <label class="block text-xs font-bold text-slate-500 shrink-0">上传试卷文件</label>
            <div
              id="texDropzone"
              class="border-2 border-dashed border-slate-200 hover:border-brand-500/80 rounded-xl p-3.5 text-center cursor-pointer transition-all duration-200 bg-white hover:bg-brand-50/20 flex flex-col justify-center items-center shrink-0 mb-2"
              :class="{ 'is-dragging': dragging }"
              @click="pickFile"
              @dragover.prevent="dragging = true"
              @dragleave.prevent="dragging = false"
              @drop.prevent="onDrop"
            >
              <!-- id 不能省：daoru-center.css 里有 #texFileName{font-size:14px !important} 和
                   #texDropzone{min-height:130px} 两条覆盖，没 id 就还原不出原稿的高度与字号 -->
              <i id="texFileIcon" class="fa-solid text-xl mb-1.5" :class="dropIconClass"></i>
              <span id="texFileName" class="text-xs" :class="dropNameClass">
                {{ fileName || '点击或拖放 .md / .pdf / .docx 试卷文件' }}
              </span>
            </div>
            <input
              ref="fileInput"
              type="file"
              accept=".tex,.md,.MD,.pdf,.docx,text/markdown,application/x-tex,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              class="hidden"
              @change="onFileChange"
            />

            <!-- 二进制源（pdf/docx）的说明文案，与 MathBank 的 importFileSummary 一致 -->
            <p v-show="fileSummary" id="importFileSummary" class="import-file-summary" role="status">
              {{ fileSummary }}
            </p>
          </div>

          <!-- TeX 配套图片：只有文本源（.tex）时才需要 -->
          <div v-show="isTexSource" class="import-config-card space-y-1.5 shrink-0">
            <label class="block text-xs font-bold text-slate-500">TeX 配套图片（可选）</label>
            <div
              class="border-2 border-dashed border-slate-200 hover:border-brand-500/80 rounded-xl p-3 text-center cursor-pointer transition-all duration-200 bg-white hover:bg-brand-50/20 flex flex-col justify-center items-center"
            >
              <i class="fa-solid fa-images text-slate-400 text-xl mb-1.5"></i>
              <span class="text-xs text-slate-600 font-medium">点击或多选拖入试卷引用的所有图片</span>
              <span class="text-[9px] text-slate-400 mt-1">
                支持 PNG、JPEG、GIF、WebP；请尽量保留与 \includegraphics 相同的文件名
              </span>
            </div>
          </div>

          <!-- AI 解答开关 -->
          <div
            class="import-config-card import-ai-option flex items-start space-x-3 p-3 bg-slate-50/80 border border-slate-200/60 rounded-xl shrink-0"
          >
            <input
              id="importGenerateAnswers"
              v-model="generateAnswers"
              type="checkbox"
              class="w-4 h-4 text-brand-600 border-slate-300 rounded focus:ring-brand-500 cursor-pointer mt-0.5"
            />
            <div class="flex-1">
              <label for="importGenerateAnswers" class="block text-xs font-bold text-slate-700 cursor-pointer">
                自动生成 AI 解答与详细解析
              </label>
              <span class="text-[10px] text-slate-400 block leading-normal mt-0.5">
                若开启，当试卷源码只有题干没有参考答案时，AI 会在后台自动解答并推理；若关闭，则答案内容保持留空。
              </span>
            </div>
          </div>

          <!-- 拆题能力开关：只影响 Prompt 体积，关掉后对应字段留空、由人工在审查卡补 -->
          <div
            class="import-config-card p-3 bg-slate-50/80 border border-slate-200/60 rounded-xl shrink-0 space-y-2.5"
          >
            <label class="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                id="importClassifySubjectType"
                v-model="classifySubjectType"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span>
                <span class="font-semibold">AI 判断题型</span>
                <span class="block mt-1 text-[10px] text-slate-500 leading-normal">
                  把该学段的题型清单交给模型，由它给出题型代码；关闭后题型留空，在审查卡手动选。
                </span>
              </span>
            </label>
            <label class="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                id="importAnnotateKnowledge"
                v-model="annotateKnowledge"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span>
                <span class="font-semibold">AI 标注知识点</span>
                <span class="block mt-1 text-[10px] text-slate-500 leading-normal">
                  知识点词表较长（约 310 条），开启会明显加长 Prompt；关闭后知识点留空，由人工补。
                </span>
              </span>
            </label>
          </div>

          <!-- docx 疑点核对：选了 .docx 才出现 -->
          <div
            v-show="isDocxSource"
            class="import-config-card p-3 bg-slate-50/80 border border-slate-200/60 rounded-xl shrink-0"
          >
            <label class="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                v-model="verifyDocx"
                type="checkbox"
                class="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span>
                <span class="font-semibold">自动核对疑点</span>
                <span class="block mt-1 text-[10px] text-slate-500 leading-normal">
                  对照 Word 原页核对疑点；明确差异自动修正并复核，最多 3 轮，通过后不再提示。
                </span>
              </span>
            </label>
          </div>

          <!-- PDF 解析范围：选了 .pdf 才出现 -->
          <div
            v-show="isPdfSource"
            class="import-config-card space-y-2.5 p-3 bg-indigo-50/40 border border-indigo-100 rounded-xl shrink-0"
          >
            <div class="flex flex-wrap gap-2 items-center justify-between">
              <label class="block text-xs font-bold text-indigo-950 flex items-center space-x-1.5">
                <i class="fa-solid fa-microchip text-brand-600"></i>
                <span>PDF 解析范围</span>
              </label>
              <div class="flex items-center space-x-1.5">
                <label for="pdfPageRange" class="text-[10px] font-bold text-slate-500">页码范围:</label>
                <input
                  id="pdfPageRange"
                  v-model="pdfPageRange"
                  type="text"
                  placeholder="如: 1-6"
                  class="w-20 px-2 py-1 border border-slate-200 focus:border-brand-500 outline-none rounded-lg text-xs font-mono text-center bg-white shadow-sm transition-all shrink-0"
                  title="例如: 1-6, 8, 10-12 (留空则默认解析全部页面)"
                />
              </div>
            </div>

            <p class="text-[10px] text-slate-500 leading-normal">
              范围请包含题目与答案页；封面、细目表等可按需排除。留空处理全部页面，不会自动删除最后一页。
            </p>

            <!-- 只剩一条管线（MinerU 智能图文提取）。原来的两张卡片是 MathBank 原稿的
                 排版，其中「文字优先」是本地 pdf-inspector 路线，本项目没接，选中只会报错，
                 所以整张卡片去掉；单选只剩一项也就不再占用一行。 -->
            <div class="flex items-start gap-2 p-2 bg-white border border-slate-200 rounded-xl">
              <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500"></span>
              <span>
                <span class="block text-xs font-bold text-slate-800">智能图文提取</span>
                <span class="block mt-1 text-[10px] text-slate-500 leading-normal">
                  提取文字、公式与配图，核对图片归属；提取说明可按需查看，不影响导入。
                </span>
              </span>
            </div>

            <p class="text-[10px] text-slate-500 leading-normal">
              智能模式沿用已配置的识图模型核对配图，可能产生额外调用与等待。结果仍需对照原卷审查。
            </p>
          </div>

          <!-- 主操作：两个按钮平分宽度（各占一半），清空重置仍靠右不参与分配 -->
          <div class="import-primary-actions flex items-center space-x-2.5 shrink-0 pt-1">
            <button
              type="button"
              class="flex-1 glass-btn-primary flex items-center justify-center space-x-2 py-3 rounded-xl font-bold text-sm"
              :disabled="phase === 'loading' || !bridgeAvailable"
              @click="startParse"
            >
              <i class="fa-solid fa-wand-magic-sparkles"></i>
              <span>开始解析</span>
            </button>
            <!-- 手动解析：不调模型，按源码里的水平分割线（--- 或 ***）直接切成草稿题卡。
                 试卷本来就分好题、或不想为一次切题等模型时用；题型 / 知识点留空，
                 在审查卡上人工补。 -->
            <button
              type="button"
              class="flex-1 glass-btn manual-parse-btn flex items-center justify-center space-x-2 py-3 rounded-xl font-bold text-sm"
              :disabled="phase === 'loading'"
              title="不调用模型：按独占一行的 --- 或 *** 把源码切成草稿题卡（___ 不算），题型与知识点留空待人工补"
              @click="manualParse"
            >
              <i class="fa-solid fa-scissors"></i>
              <span>手动解析</span>
            </button>
            <button
              type="button"
              class="px-4 py-3 rounded-xl bg-slate-100 hover:bg-rose-50 hover:text-rose-600 text-slate-600 font-bold text-xs border border-slate-200 hover:border-rose-200 transition-all active:scale-95 flex items-center space-x-1.5 shrink-0"
              title="清空试卷源码、图片映射与右侧拆分出的题目草稿，恢复初始待拆解状态"
              @click="resetAll"
            >
              <i class="fa-solid fa-rotate-left text-slate-400 group-hover:text-rose-500"></i>
              <span>清空重置</span>
            </button>
          </div>
        </div>

        <!-- 右栏：审查区（左栏收起时占满整行；卡内题干/渲染预览两列按 1fr 等比变宽，
             行高 BODY_HEIGHT 不受影响） -->
        <div
          id="importReviewPane"
          class="import-result-pane w-7/12 p-6 overflow-y-auto space-y-4 flex flex-col bg-slate-100/50 relative"
          :class="{ 'is-full': inputPaneCollapsed }"
        >
          <!-- 待拆解 -->
          <div
            v-show="phase === 'empty'"
            class="import-result-placeholder ui-state ui-state-empty flex-1 flex flex-col items-center justify-center text-center space-y-3 p-12"
          >
            <div
              class="ui-state-icon h-16 w-16 bg-white border border-slate-200 rounded-2xl shadow-sm flex items-center justify-center text-brand-600 text-2xl"
            >
              <i class="fa-solid fa-robot animate-bounce"></i>
            </div>
            <div>
              <h4 class="ui-state-title font-bold text-slate-700 text-sm">等待拆解</h4>
              <p class="ui-state-description text-xs text-slate-500 max-w-sm mt-1.5 leading-relaxed">
                上传 PDF、Word 或 MD 文件，再点击“开始解析”由 AI 拆题；
                试卷本身已用分割线分好题时，可直接点“手动解析”按分割线切成草稿。
                PDF 会先由 MinerU 识别成 Markdown，再进入同一条管线。
              </p>
              <p
                v-if="parseError"
                class="ui-state-description text-xs font-semibold text-rose-600 max-w-sm mt-1.5 leading-relaxed"
              >
                {{ parseError }}
              </p>
              <p
                v-if="!bridgeAvailable"
                class="ui-state-description text-[11px] text-amber-600 max-w-sm mt-1 leading-relaxed"
              >
                当前环境没有解析通道（需要桌面版客户端）。
              </p>
            </div>
          </div>

          <!-- 拆解中 -->
          <div
            v-show="phase === 'loading'"
            role="status"
            aria-live="polite"
            class="ui-state ui-state-loading flex-1 flex flex-col items-center justify-center text-center space-y-4 p-12"
          >
            <div
              class="ui-state-icon h-16 w-16 bg-white border border-brand-200/80 rounded-2xl shadow-sm flex items-center justify-center text-brand-600 text-2xl mb-1"
            >
              <i class="fa-solid fa-circle-notch fa-spin text-brand-600 text-3xl inline-block"></i>
            </div>
            <div class="space-y-1.5 w-full max-w-xs flex flex-col items-center">
              <h4 class="ui-state-title font-bold text-slate-700 text-sm">正在拆解题目...</h4>
              <div class="w-full bg-slate-200 rounded-full h-1.5 mt-2">
                <div
                  class="bg-brand-600 h-1.5 rounded-full transition-all duration-300"
                  :style="{ width: progress + '%' }"
                ></div>
              </div>
              <p class="text-xs text-slate-500 max-w-xs leading-relaxed mt-1">
                {{ loadingHint }}（已用时 {{ elapsed }} 秒）
              </p>
            </div>
            <div
              class="w-full max-w-md bg-slate-50 rounded-xl p-3 text-left font-mono text-[10px] text-slate-600 overflow-y-auto h-24 select-none shadow-inner border border-slate-200"
              role="log"
              aria-live="polite"
              aria-label="试卷拆解进度日志"
            >
              <div v-for="(line, index) in logs" :key="index">{{ line }}</div>
            </div>
            <div class="flex items-center space-x-2 pt-1">
              <button
                type="button"
                class="px-4 py-1.5 rounded-xl border border-slate-300 hover:border-red-300 bg-white hover:bg-red-50/80 text-slate-600 hover:text-red-600 font-bold text-xs transition-all shadow-sm active:scale-95 flex items-center space-x-1.5 cursor-pointer"
                title="点击或按键盘 ESC 键可安全中止当前任务"
                @click="cancelParse"
              >
                <i class="fa-solid fa-ban text-xs text-red-500"></i>
                <span>中止拆分 (ESC)</span>
              </button>
            </div>
          </div>

          <!-- 拆解结果 -->
          <div v-show="phase === 'parsed'" class="flex-1 flex flex-col space-y-4">
            <div
              class="flex flex-wrap items-center justify-between gap-3 shrink-0 bg-white/70 backdrop-blur-sm p-3.5 border border-white/50 rounded-xl shadow-sm"
            >
              <div class="flex items-center space-x-3.5">
                <div class="flex items-center space-x-2">
                  <span class="text-xs font-bold text-slate-700">拆解结果审查</span>
                  <span
                    class="text-[10px] font-bold px-2 py-0.5 rounded bg-brand-50 text-brand-600 border border-brand-100"
                  >
                    共 {{ parsedCount }} 题
                  </span>
                </div>
                <div class="flex items-center space-x-3 border-l pl-3.5 border-slate-200">
                  <label
                    class="flex items-center space-x-1.5 cursor-pointer text-[10px] font-semibold text-slate-500 hover:text-brand-600 transition-colors select-none"
                  >
                    <input
                      :checked="allSelected"
                      :indeterminate="allIndeterminate"
                      :disabled="unsavedCount === 0"
                      type="checkbox"
                      class="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500 transition-colors"
                      @change="toggleAll"
                    />
                    <span>全选</span>
                  </label>
                  <button
                    type="button"
                    class="text-[10px] font-semibold text-slate-500 hover:text-brand-600 transition-colors flex items-center space-x-1 select-none"
                    @click="invertSelect"
                  >
                    <i class="fa-solid fa-arrows-rotate text-[9px]"></i>
                    <span>反选</span>
                  </button>
                  <span
                    class="text-[10px] font-bold text-slate-400 bg-slate-100/80 px-1.5 py-0.5 rounded border border-slate-200"
                  >
                    已选 {{ checkedUnsaved }} / {{ unsavedCount }} 题
                  </span>
                </div>
              </div>
              <div class="flex items-center space-x-2.5">
                <button
                  type="button"
                  class="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 font-bold text-xs border border-rose-200 shadow-sm transition-all active:scale-95"
                  @click="clearAllDrafts"
                >
                  <i class="fa-solid fa-trash-can text-[10px]"></i>
                  <span>一键清除</span>
                </button>
                <button
                  type="button"
                  class="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold text-xs border border-slate-200 shadow-sm transition-all active:scale-95"
                  @click="clearAllTitles"
                >
                  <i class="fa-solid fa-eraser text-[10px]"></i>
                  <span>一键清除标题</span>
                </button>
                <button
                  type="button"
                  :disabled="checkedUnsaved === 0"
                  class="flex items-center space-x-1.5 px-4 py-2 rounded-xl font-bold text-xs shadow-sm transition-all"
                  :class="
                    checkedUnsaved === 0
                      ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                      : 'bg-brand-600/80 hover:bg-brand-600 text-white backdrop-blur-sm border border-brand-500/20'
                  "
                  @click="importSelected"
                >
                  <i class="fa-solid fa-cloud-arrow-up"></i>
                  <span>{{ checkedUnsaved > 0 ? `导入选中 (${checkedUnsaved})` : '导入选中题目' }}</span>
                </button>
              </div>
            </div>

            <!-- 本地校验提示：知识点被丢、教材位置降级、答案被清空都落在这里。
                 默认折叠 —— 题目本身仍然可用，这些是给校对者的线索。 -->
            <details
              v-if="parseWarnings.length"
              class="shrink-0 rounded-xl border border-amber-200 bg-amber-50/70 p-3"
            >
              <summary class="cursor-pointer text-xs font-bold text-amber-800">
                校验提示 {{ parseWarnings.length }} 条
              </summary>
              <ul
                class="mt-2 space-y-1 text-[11px] text-amber-800/90 leading-relaxed max-h-40 overflow-y-auto custom-scrollbar"
              >
                <li v-for="(warning, i) in parseWarnings" :key="i">· {{ warning }}</li>
              </ul>
            </details>

            <div class="flex-1 overflow-y-auto space-y-3 pr-1.5 custom-scrollbar pb-6">
              <ParseResultCard
                v-for="(question, i) in questions"
                :key="i"
                :question="question"
                :index="i"
                :catalog="catalog"
                :selected="selectedIndexes.has(i)"
                :importing="importing.has(i)"
                :generating="generating.has(i)"
                @update:selected="toggleSelected(i, $event)"
                @import="importOne"
                @regenerate="regenerateOne"
              />
              <p
                v-if="questions.length === 0"
                class="ui-state-description text-xs text-slate-500 text-center py-10"
              >
                模型没有切出题目：请确认来源是试卷正文，或换一个模型重试。
              </p>
            </div>
          </div>
        </div>

        <!-- 左栏折叠开关：展开时悬在左栏右上角（« 收起）；收起后移到审查区左上角
             （» 展开）。悬停定位由 daoru-center.css 的 .daoru-pane-toggle 负责。 -->
        <button
          type="button"
          class="daoru-pane-toggle"
          :class="{ 'is-collapsed': inputPaneCollapsed }"
          :title="inputPaneCollapsed ? '显示录入面板' : '收起录入面板'"
          :aria-label="inputPaneCollapsed ? '显示录入面板' : '收起录入面板'"
          @click="inputPaneCollapsed = !inputPaneCollapsed"
        >
          <i
            class="fa-solid"
            :class="inputPaneCollapsed ? 'fa-angles-right' : 'fa-angles-left'"
          ></i>
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import '../assets/fontawesome/css/all.min.css'
import '../styles/daoru-center.css'
import '../styles/daoru-center.tailwind.css'
import ParseResultCard from '../components/ParseResultCard.vue'
import {
  subscribeImportSource,
  takeImportSource,
  type ImportSourceEntry
} from '../import-entry'
import {
  describeParseError,
  FALLBACK_EASY_LEVELS,
  FALLBACK_SUBJECTS,
  FALLBACK_SUBJECT_TYPES,
  fetchMathParseCatalog,
  hasMathParseBridge,
  resolveSourceMarkdown,
  runMathParse,
  runMathParseAnswer,
  showToast,
  spreadChoiceOptions,
  splitMarkdownByRule,
  subscribeParseLogs,
  type EditableQuestion,
  type SourceKind
} from '../utils/math-parse'
import {
  describeQuestionBankError,
  saveQuestion,
  saveQuestions,
  toExerciseInput
} from '../utils/question-bank'
import type { MathParseCatalog } from '../../preload/index'

type Phase = 'empty' | 'loading' | 'parsed'

const steps = [
  { no: 1, title: '选择试卷', hint: '上传或粘贴原始内容' },
  { no: 2, title: '解析配置', hint: '范围与配图' },
  { no: 3, title: 'AI 拆解', hint: '切分题目并匹配属性' },
  { no: 4, title: '审查入库', hint: '校对后批量保存' }
] as const

const step = ref(1)
const paperTitle = ref('')
const fileName = ref('')
const sourceKind = ref<SourceKind>('')
const generateAnswers = ref(true)
// 题型分类默认开（历史行为）；知识点词表约 310 条 / 6K 字符，默认不注入省 token
const classifySubjectType = ref(true)
const annotateKnowledge = ref(false)
const verifyDocx = ref(true)
const pdfPageRange = ref('')
const phase = ref<Phase>('empty')
/** 左栏（录入面板）折叠：收起后右栏审查区占满整行，再点一次恢复 44% / 56% 布局 */
const inputPaneCollapsed = ref(false)
/** 拆解中的那段说明：自动 / 手动两条路耗时差一个量级，不能共用一句「1–3 分钟」 */
const loadingHint = ref('AI 正在切分题目并匹配题型与知识点，通常需要 1–3 分钟')
const progress = ref(0)
const logs = ref<string[]>(['[SYSTEM] 准备就绪，等待上传试卷…'])
// 没有本地 PDF 工程时这一段不出现（实际渲染里由工程列表决定）
const showLocalProjects = ref(false)

const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)

const isPdfSource = computed(() => sourceKind.value === 'pdf')
const isDocxSource = computed(() => sourceKind.value === 'docx')
const isTexSource = computed(() => sourceKind.value === 'tex')

// 拖放区的三种已选状态，图标与配色逐项抄 MathBank（import.js:4405 / 4422 / 4440）
const dropIconClass = computed(() => {
  if (!fileName.value) return 'fa-file-lines text-slate-400'
  if (sourceKind.value === 'pdf') return 'fa-file-pdf text-brand-500 animate-bounce'
  if (sourceKind.value === 'docx') return 'fa-file-word text-blue-600 animate-bounce'
  return 'fa-file-circle-check text-brand-500 animate-bounce'
})
const dropNameClass = computed(() =>
  fileName.value ? 'text-brand-600 font-bold' : 'text-slate-600 font-medium'
)
/** 二进制源（pdf/docx）才显示的那句说明，文案与 MathBank 的 updateImportSourceView 一致 */
const fileSummary = computed(() => {
  if (sourceKind.value === 'pdf') return 'PDF 已选择。请设置页码范围与识别策略，然后开始解析。'
  if (sourceKind.value === 'docx') return 'Word 已选择。将提取正文、公式和插图，结果可逐题校对。'
  return ''
})

/** 拖进来的那个 File 本身 —— 只留名字的话没法读内容（docx 要字节、md/tex 要文本） */
const sourceFile = ref<File | null>(null)
/** 可编辑草稿：元素是 reactive 的，题卡组件就地改字段，「导入」只翻转 saved */
const questions = ref<EditableQuestion[]>([])
/**
 * 审查卡下拉的数据源。
 *
 * 起手就是兜底值而不是空表：v-model 的值匹配不到任何 option 时 <select> 显示空白，
 * 看上去跟「模型没返回这个字段」一模一样，而实际原因是选项没拉到 —— 排查方向被带偏到
 * 模型那边，几个回合也查不出来。宁可先用本地那份把框填满，再去覆盖真实的目录数据。
 */
const catalog = ref<MathParseCatalog>({
  subjects: FALLBACK_SUBJECTS,
  classLevels: [],
  subjectTypes: FALLBACK_SUBJECT_TYPES,
  easyLevels: FALLBACK_EASY_LEVELS
})
/** 字典是否拉到：拿不到时科目/题型只剩兜底值（数学四类），年级为空 */
const catalogReady = ref(false)

/**
 * 拆题的学科输入。整卷一份：题目逐题可改年级，但科目与学段由这次选择决定 ——
 * 一道题换科目说明选错了卷子，该重新解析。
 */
const subjectCode = ref('')
/** 学段：单选，只用于决定 prompt 里的角色句（年级/学期不在这里选，词表取全量） */
const stage = ref('')

const STAGES = [
  { code: 'primary', name: '小学' },
  { code: 'junior', name: '初中' },
  { code: 'senior', name: '高中' },
  { code: 'other', name: '其它' }
] as const

/** 切换学段；再点一次相同学段等于取消 */
function pickStage(next: string): void {
  stage.value = stage.value === next ? '' : next
}

/** 传给拆题的学段：没选就落 other（主进程只认这四个值） */
const stageOfSelection = computed(() => stage.value || 'other')

async function loadCatalog(): Promise<boolean> {
  try {
    const c = await fetchMathParseCatalog()
    catalog.value = {
      subjects: c.subjects?.length ? c.subjects : FALLBACK_SUBJECTS,
      classLevels: c.classLevels ?? [],
      subjectTypes: c.subjectTypes?.length ? c.subjectTypes : FALLBACK_SUBJECT_TYPES,
      easyLevels: c.easyLevels?.length ? c.easyLevels : FALLBACK_EASY_LEVELS
    }
    catalogReady.value = catalog.value.classLevels.length > 0
    return catalogReady.value
  } catch {
    // 桥不可用（Web 宿主）或 IPC 未注册（桌面端还没重载）：保留兜底值
    catalogReady.value = false
    return false
  }
}
void loadCatalog()
/** 勾选的下标集合。Set 原地改不触发更新，所有写操作都换成新 Set */
const selectedIndexes = ref<Set<number>>(new Set())
/** 正在写库的题目下标：按钮进「导入中…」并禁用，避免连点出两条重复记录 */
const importing = ref<Set<number>>(new Set())
/** 正在生成解析的题目下标：与 importing 同一套 Set 模式（原地改不触发更新） */
const generating = ref<Set<number>>(new Set())
const parseWarnings = ref<string[]>([])
const parseError = ref('')
const elapsed = ref(0)
/** 桌面版才有解析通道；Web 宿主里按钮直接禁用，而不是点了报错 */
const bridgeAvailable = hasMathParseBridge()

const parsedCount = computed(() => questions.value.length)
const unsavedCount = computed(() => questions.value.filter((q) => !q.saved).length)
const checkedUnsaved = computed(
  () => questions.value.filter((q, i) => !q.saved && selectedIndexes.value.has(i)).length
)
const allSelected = computed(
  () => unsavedCount.value > 0 && checkedUnsaved.value === unsavedCount.value
)
const allIndeterminate = computed(
  () => checkedUnsaved.value > 0 && checkedUnsaved.value < unsavedCount.value
)

/**
 * 每次解析一个 runId。
 *
 * 「中止」没法真的掐断主进程里那次 HTTP 请求（一次 invoke 没有 abort 通道），
 * 所以只做界面侧作废：把 runId 推进一格，迟到的结果一律丢弃。
 */
let runId = 0
let ticker: number | undefined

function stopTicker(): void {
  if (ticker !== undefined) window.clearInterval(ticker)
  ticker = undefined
}

// 主进程的阶段日志直插日志窗：慢的时候能看见卡在哪一步，而不是对着进度条干等
const unsubscribeLogs = subscribeParseLogs((line) => {
  if (phase.value !== 'loading') return
  logs.value.push(line)
})

function pickFile(): void {
  fileInput.value?.click()
}

/** 选好/拖入文件：登记 File、按后缀决定配置块，并作废上一次的结果 */
function applySourceFile(file: File): void {
  sourceFile.value = file
  fileName.value = file.name
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  sourceKind.value = (['tex', 'md', 'pdf', 'docx'] as const).includes(ext as 'tex')
    ? (ext as SourceKind)
    : ''
  questions.value = []
  selectedIndexes.value = new Set()
  parseWarnings.value = []
  parseError.value = ''
  phase.value = 'empty'
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) applySourceFile(file)
  input.value = ''
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) applySourceFile(file)
}

// ── 「批量录入」交接来的试卷源码（PDF 对照页 → 本页）──────────────────────

/**
 * 把 PDF 转 md 那份 Markdown 直接当成已选文件。
 *
 * 走内存 File + 同一个 applySourceFile，而不是另开一条「文本源」通路：文件名、
 * 后缀判定、拖放区的图标与说明全都复用同一处，少一套并行状态。内存 File 对 md
 * 完全够用（resolveSourceMarkdown 的 md 分支只读文本），但别拿它当 pdf/docx ——
 * 那两个要磁盘路径或原始字节。
 */
let importSeq = 0
function applyImportedSource(entry: ImportSourceEntry): void {
  // 同一份只消费一次：订阅与 pending 两条路都收口在这里
  if (entry.seq <= importSeq) return
  importSeq = entry.seq

  // 已有文件或拆好的草稿：先问一句，别把正在校对的东西冲掉
  if (
    (sourceFile.value || questions.value.length > 0) &&
    !window.confirm(`是否用「${entry.name}」替换当前试卷？`)
  ) {
    return
  }

  applySourceFile(new File([entry.markdown], entry.name, { type: 'text/markdown' }))
  // 标题跟着文件名走（与 startParse 里「标题没填就用文件名」同一口径）；已有标题不动
  if (!paperTitle.value.trim()) paperTitle.value = entry.name.replace(/\.[^.]+$/, '')
  logs.value = [
    `[SYSTEM] 已载入 ${entry.from || '外部来源'}：${entry.name}（${entry.markdown.length} 字）`,
    '[SYSTEM] 选好「学科」后点「开始解析」或「手动解析」'
  ]
}

/** 退订交接：本页被 KeepAlive 缓存，正常只会在应用卸载时跑一次 */
let unsubscribeImport: (() => void) | null = null
onMounted(() => {
  // 先订阅再取 pending：面板刚挂载时那一份在 pending 里，之后都走订阅
  unsubscribeImport = subscribeImportSource(applyImportedSource)
  const pending = takeImportSource()
  if (pending) applyImportedSource(pending)
})

/**
 * 开始解析。
 *
 * 全链路：来源归一（文件/粘贴 → Markdown）→ 主进程（锁公式 → 单次模型调用 →
 * JSON 校验 → 还原）→ 题卡列表。模型只在主进程那一步用到，渲染端不碰密钥。
 */
async function startParse(): Promise<void> {
  if (phase.value === 'loading') return
  const current = ++runId
  parseError.value = ''
  parseWarnings.value = []
  questions.value = []
  selectedIndexes.value = new Set()
  progress.value = 0
  elapsed.value = 0
  phase.value = 'loading'
  loadingHint.value = 'AI 正在切分题目并匹配题型与知识点，通常需要 1–3 分钟'
  logs.value = [`[SYSTEM] 来源：${fileName.value || '（空）'}`]
  if (sourceKind.value === 'pdf') {
    logs.value.push('[MINERU] PDF 走云端识别：先转成 Markdown，再进入同一条拆题管线')
    logs.value.push(
      pdfPageRange.value.trim()
        ? `[MINERU] 页码范围：${pdfPageRange.value.trim()}（主进程会先裁页再上传）`
        : '[MINERU] 页码范围留空：解析整份文件'
    )
  }
  stopTicker()

  ticker = window.setInterval(() => {
    elapsed.value += 1
  }, 1000)

  const fail = (message: string): void => {
    stopTicker()
    if (current !== runId) return
    progress.value = 0
    phase.value = 'empty'
    parseError.value = message
    logs.value.push(`[FAIL] ${message}`)
  }

  // 科目是拆题提示词的前提：没有它，题型候选与知识点词表都查不出来，
  // 模型只能凭常识自由发挥 —— 那样的结果既不能入库也不能用。
  if (!subjectCode.value) {
    fail('请先选择「学科」：题型、知识点词表与公式锁定都按科目查')
    return
  }

  try {
    const resolveStartedAt = Date.now()
    const source = await resolveSourceMarkdown({
      kind: sourceKind.value,
      file: sourceFile.value,
      pageRange: pdfPageRange.value
    })
    if (current !== runId) return
    if (!source.ok || !source.markdown) {
      fail(describeParseError(source.error))
      return
    }
    progress.value = 20
    logs.value.push(
      `[SOURCE] 源码 ${source.markdown.length} 字，来源归一耗时 ${(
        (Date.now() - resolveStartedAt) / 1000
      ).toFixed(1)}s`
    )
    // 前缀跟着来源走：PDF 的告警（复用结果目录、图片张数）标成 [DOCX] 会让人以为串台了
    const sourceLabel = sourceKind.value === 'pdf' ? 'PDF' : 'DOCX'
    for (const warning of source.warnings ?? []) logs.value.push(`[${sourceLabel}] ${warning}`)

    progress.value = 40
    logs.value.push(
      `[PARSE] 科目 ${subjectCode.value} · 学段 ${stageOfSelection.value} · ` +
        `题型分类${classifySubjectType.value ? '开' : '关'} · ` +
        `知识点标注${annotateKnowledge.value ? '开' : '关'} · ` +
        '锁定公式、拼装 Prompt，等待模型返回…'
    )
    // 试卷标题没填就用文件名（去扩展名）。它有两处作用：进 prompt 的【试卷标题】帮助模型
    // 认卷型，以及模型给不出出处时回填每道题的「题目来源」—— 空白卷正文里往往没有
    // 「2024·全国·高考真题」这类出处线索，不补的话来源一栏整份卷子都是空的。
    const result = await runMathParse({
      markdown: source.markdown,
      title: paperTitle.value.trim() || fileName.value.replace(/\.[^.]+$/, '') || undefined,
      generateAnswers: generateAnswers.value,
      classifySubjectType: classifySubjectType.value,
      annotateKnowledge: annotateKnowledge.value,
      subjectCode: subjectCode.value,
      stage: stageOfSelection.value,
      // 一律空数组（= 不限）：不再按年级收窄词表，整卷/跨年级题收窄只会漏点
      gradeTerms: []
    })
    stopTicker()
    // 用户中途点了「中止」：这次结果已经作废，不许覆盖界面
    if (current !== runId) return

    if (!result.ok) {
      fail(describeParseError(result.error))
      return
    }

    // 目录还没就位就再拉一次：常见的成因是这条 IPC 注册得比渲染端晚（热更新 / 未重启），
    // 重启一次就好。这里补拉 + 明确告警，免得表现成「题卡的教材下拉是空的」让人往模型上找。
    if (!catalogReady.value) {
      const ok = await loadCatalog()
      if (!ok) logs.value.push('[WARN] 拿不到教材目录：题目仍可编辑，但学段/章节需手动指定')
    }

    const list = result.questions ?? []
    // 科目与学段整卷一致；年级默认「跨年级 = 整个学段」（写成学段码，如 senior），
    // 想精确到某一年级再在审查卡上改 —— 整卷题干本身很少标年级，空着反而要人工补。
    // reactive 包装：题卡组件就地编辑这些对象（含逐题改年级/学期）。
    const scope = {
      subjectCode: subjectCode.value,
      stage: stageOfSelection.value,
      classLevel: stageOfSelection.value,
      term: ''
    }
    questions.value = list.map((q) => reactive({ ...q, ...scope, saved: false }) as EditableQuestion)
    // 默认全选：审查的常态是「都要」，逐题去掉比逐题勾上省事
    selectedIndexes.value = new Set(list.map((_, index) => index))
    parseWarnings.value = result.warnings ?? []
    progress.value = 100
    if (result.stats) {
      const s = result.stats
      logs.value.push(
        `[MODEL] ${s.model}（thinking=${s.thinking}，max_tokens=${s.maxTokens}，` +
          `prompt ${s.promptChars} 字符，知识点词表 ${s.knowledgePointCount} 条）`
      )
      logs.value.push(`[FORMULA] 锁定 ${s.lockedFormulas} 处，引用 ${s.referencedFormulas} 处`)
      logs.value.push(
        `[TIME] 本地 ${s.promptReadyMs}ms / 模型 ${Math.round(s.requestMs / 1000)}s` +
          `${s.degraded ? ' / 含参数降级重试' : ''}${s.repaired ? ' / 含 JSON 修复轮' : ''}`
      )
      if (s.reasoningTokens > 0) {
        const share = Math.round((s.reasoningTokens / Math.max(s.completionTokens, 1)) * 100)
        logs.value.push(
          `[THINK] 输出 ${s.completionTokens} token，其中思考 ${s.reasoningTokens}（${share}%）：` +
            '换非思考模型（如 deepseek-chat）会明显更快'
        )
      }
      if (s.repaired) {
        logs.value.push('[WARN] 触发过修复轮：输出多半被 max_tokens 截断，换个长输出模型或拆分试卷会快很多')
      }
    }
    logs.value.push(`[DONE] 切出 ${list.length} 题，用时 ${elapsed.value} 秒`)
    phase.value = 'parsed'
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

/**
 * 手动解析：不调模型，按独占一行的 `---` 把源码切成草稿题卡，一份一段
 * （`___` 不算分割线，见 utils/math-parse 的 splitMarkdownByRule）。
 *
 * 什么时候用：试卷本来就一道题一条分割线（题库导出、或在编辑器里整理过的稿子），
 * 再让模型猜一遍既慢（一次往返 1–3 分钟）又会改动原文。切出来的题卡只有题干 ——
 * 题型、难度、知识点一律留空，入库前在审查卡上补。
 *
 * 来源归一与自动解析完全共用：PDF 还是要先过 MinerU（否则没有 Markdown 可切），
 * docx 还是走主进程转换。
 */
async function manualParse(): Promise<void> {
  if (phase.value === 'loading') return
  const current = ++runId
  parseError.value = ''
  parseWarnings.value = []
  questions.value = []
  selectedIndexes.value = new Set()
  progress.value = 0
  elapsed.value = 0
  phase.value = 'loading'
  loadingHint.value = '正在按水平分割线切分题目（不调用模型）'
  logs.value = [`[SYSTEM] 手动解析：${fileName.value || '（空）'}`]
  if (sourceKind.value === 'pdf') {
    logs.value.push('[MANUAL] PDF 仍需先经 MinerU 识别成 Markdown，再按分割线切分')
  }
  stopTicker()
  ticker = window.setInterval(() => {
    elapsed.value += 1
  }, 1000)

  const fail = (message: string): void => {
    stopTicker()
    if (current !== runId) return
    progress.value = 0
    phase.value = 'empty'
    parseError.value = message
    logs.value.push(`[FAIL] ${message}`)
  }

  // 学科同样要选：题卡的题型下拉按科目筛候选，入库校验也要它
  if (!subjectCode.value) {
    fail('请先选择「学科」：题卡的题型候选与入库校验都按科目来')
    return
  }

  try {
    const source = await resolveSourceMarkdown({
      kind: sourceKind.value,
      file: sourceFile.value,
      pageRange: pdfPageRange.value
    })
    if (current !== runId) return
    if (!source.ok || !source.markdown) {
      fail(describeParseError(source.error))
      return
    }
    for (const warning of source.warnings ?? []) logs.value.push(`[SOURCE] ${warning}`)
    progress.value = 60

    const chunks = splitMarkdownByRule(source.markdown)
    if (chunks.length === 0) {
      fail('源码里没有可切分的内容：请确认文件不是空的')
      return
    }

    const scope = {
      subjectCode: subjectCode.value,
      stage: stageOfSelection.value,
      // 与自动解析同一口径：年级默认「跨年级 = 整个学段」（学段码）
      classLevel: stageOfSelection.value,
      term: ''
    }
    // 出处与自动解析同一套口径：标题没填就用文件名（去扩展名）
    const sourceLabel =
      paperTitle.value.trim() || fileName.value.replace(/\.[^.]+$/, '') || null
    questions.value = chunks.map((content) =>
      reactive({
        // 选项行排版规整：B/C/D… 前统一 4 个全角空格（见 spreadChoiceOptions）
        content: spreadChoiceOptions(content),
        answerMarkdown: '',
        subjectTypeCode: '',
        knowledgePoints: [],
        easy: '3',
        source: sourceLabel,
        referencedImages: [],
        ...scope,
        saved: false
      }) as EditableQuestion
    )
    selectedIndexes.value = new Set(chunks.map((_, index) => index))
    parseWarnings.value = ['手动解析只按分割线切分：题型、难度、知识点均为空，入库前请在审查卡上补']
    if (chunks.length === 1) {
      parseWarnings.value.push('只切出 1 段：源码里没有找到独占一行的 --- 或 *** 分割线')
    }
    progress.value = 100
    logs.value.push(`[DONE] 按分割线切出 ${chunks.length} 段，用时 ${elapsed.value} 秒`)
    stopTicker()
    phase.value = 'parsed'
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

function cancelParse(): void {
  runId += 1
  stopTicker()
  progress.value = 0
  phase.value = 'empty'
  logs.value.push('[SYSTEM] 已中止：本次结果到达后将被丢弃')
}

function resetAll(): void {
  runId += 1
  stopTicker()
  paperTitle.value = ''
  fileName.value = ''
  sourceKind.value = ''
  sourceFile.value = null
  pdfPageRange.value = ''
  progress.value = 0
  elapsed.value = 0
  questions.value = []
  selectedIndexes.value = new Set()
  parseWarnings.value = []
  parseError.value = ''
  phase.value = 'empty'
}

function toggleSelected(index: number, value: boolean): void {
  const next = new Set(selectedIndexes.value)
  if (value) next.add(index)
  else next.delete(index)
  selectedIndexes.value = next
}

function toggleAll(): void {
  if (allSelected.value) {
    selectedIndexes.value = new Set()
    return
  }
  const next = new Set<number>()
  questions.value.forEach((q, index) => {
    if (!q.saved) next.add(index)
  })
  selectedIndexes.value = next
}

function invertSelect(): void {
  const next = new Set<number>()
  questions.value.forEach((q, index) => {
    if (q.saved) return
    if (!selectedIndexes.value.has(index)) next.add(index)
  })
  selectedIndexes.value = next
}

/** 单题导入。入库接口未接：先在本地置 saved，让审查流可以走完整一遍 */
/**
 * 单题入库。
 *
 * 状态机：savedId 有值 = 这道题已经进过库，本次是「再次导入」→ 主进程 UPDATE 同一行；
 * 没有 savedId = 首次导入 → INSERT，成功后把返回的 id 记在卡片上。
 *
 * 查重命中不拦截：同题换个出处二次入库是合理的，弹一次确认交给用户决定。
 */
function markImporting(index: number, busy: boolean): void {
  const next = new Set(importing.value)
  if (busy) next.add(index)
  else next.delete(index)
  importing.value = next
}

async function importOne(index: number): Promise<void> {
  const q = questions.value[index]
  if (!q || importing.value.has(index)) return

  q.importError = ''
  // 科目/题型/难度是主进程的硬约束（缺了题目在题库里就是孤儿）：先在界面挡住，
  // 别让人点完之后只看到一条 2.6 秒的 toast，还以为已经导入成功了
  const missing = missingScope(q)
  if (missing) {
    q.importError = missing
    showToast(`第 ${index + 1} 题：${missing}`, 'warning')
    return
  }

  markImporting(index, true)
  try {
    const payload = toExerciseInput(q, q)
    const options = q.savedId === undefined ? undefined : { id: q.savedId }
    const first = await saveQuestion(payload, options)

    if (first.ok) {
      applySaved(index, q, first.id)
      showToast(`第 ${index + 1} 题导入成功`, 'success')
      return
    }
    if (!first.duplicate) {
      failImport(index, q, first.error)
      return
    }

    const duplicate = first.duplicate
    const hint = duplicate.source ? `（${duplicate.source}）` : ''
    if (!window.confirm(`题库里已有同一道题 #${duplicate.id}${hint}。\n仍要再导入一条吗？`)) return

    const forced = await saveQuestion(payload, { ...(options ?? {}), force: true })
    if (forced.ok) {
      applySaved(index, q, forced.id)
      showToast(`第 ${index + 1} 题已作为独立题目导入`, 'success')
    } else {
      failImport(index, q, forced.error)
    }
  } catch (error) {
    // 以前这里只有 finally：拼载荷/序列化抛出的异常会变成 unhandled rejection，
    // 界面上就是「点了没反应」—— 必须留一条人话在卡片上
    failImport(index, q, error instanceof Error ? error.message : String(error))
  } finally {
    markImporting(index, false)
  }
}

/** 缺入库必填项的原因（空串 = 齐了）。主进程也判，但在这里先挡一道 */
function missingScope(q: EditableQuestion): string {
  if (!(q.subjectCode ?? '').trim()) return '缺少科目：请回到左栏选择学科后重新解析'
  if (!(q.subjectTypeCode ?? '').trim()) return '请先选择题型'
  if (!(q.easy ?? '').trim()) return '请先选择难度'
  return ''
}

/** 入库失败：toast 一闪而过，原因同时挂在卡片上（清空前一直可见） */
function failImport(index: number, q: EditableQuestion, error?: string): void {
  const text = describeQuestionBankError(error)
  q.importError = text
  showToast(`第 ${index + 1} 题入库失败：${text}`, 'warning')
}

/** 写库成功：卡片翻成「已导入/再次导入」，并取消勾选（MathBank 同样在导入后取消） */
function applySaved(index: number, q: EditableQuestion, id?: number): void {
  q.saved = true
  q.importError = ''
  if (id !== undefined) q.savedId = id
  const next = new Set(selectedIndexes.value)
  next.delete(index)
  selectedIndexes.value = next
}

/**
 * 批量入库（「导入选中」）。
 *
 * 重复题集中确认一次，而不是逐题弹窗 —— 十几道题连着弹十几个 confirm 没人受得了。
 * 确认后只对重复的那几道带 force 重发，其余不重复提交。
 */
async function importSelected(): Promise<void> {
  const picked = questions.value
    .map((q, index) => ({ q, index }))
    .filter(({ q, index }) => !q.saved && selectedIndexes.value.has(index))
  if (picked.length === 0) return

  // 缺必填项的题先摘出去并标红：主进程一定拒，发出去只是多一条失败记录
  const skipped = picked.filter(({ q }) => missingScope(q))
  if (skipped.length > 0) {
    skipped.forEach(({ q }) => {
      q.importError = missingScope(q)
    })
    const left = new Set(selectedIndexes.value)
    skipped.forEach(({ index }) => left.delete(index))
    selectedIndexes.value = left
  }
  const targets = picked.filter(({ q }) => !missingScope(q))
  if (targets.length === 0) {
    showToast(`${skipped.length} 道题缺少题型/难度，已跳过（原因见卡片）`, 'warning')
    return
  }

  const busy = new Set(importing.value)
  targets.forEach(({ index }) => busy.add(index))
  importing.value = busy

  try {
    const batch = await saveQuestions(targets.map(({ q }) => toExerciseInput(q, q)))
    if (!batch.ok && batch.results.length === 0) {
      showToast(`批量入库失败：${describeQuestionBankError(batch.error)}`, 'warning')
      return
    }

    const duplicates: { target: (typeof targets)[number]; id: number; source: string | null }[] = []
    const failures: string[] = []

    batch.results.forEach((result) => {
      const target = targets[result.index]
      if (!target) return
      if (result.ok) {
        applySaved(target.index, target.q, result.id)
        return
      }
      if (result.duplicate) {
        duplicates.push({ target, id: result.duplicate.id, source: result.duplicate.source })
        return
      }
      target.q.importError = describeQuestionBankError(result.error)
      failures.push(`第 ${target.index + 1} 题：${target.q.importError}`)
    })

    // 重复题：一次确认，然后把它们逐个带 force 补进去
    let saved = batch.saved
    if (duplicates.length > 0) {
      const preview = duplicates
        .slice(0, 3)
        .map((d) => `第 ${d.target.index + 1} 题 → 题库 #${d.id}`)
        .join('\n')
      const more = duplicates.length > 3 ? `\n…等 ${duplicates.length} 道` : ''
      if (
        window.confirm(
          `有 ${duplicates.length} 道题与题库已有题目重复：\n${preview}${more}\n\n仍要一并导入吗？`
        )
      ) {
        for (const duplicate of duplicates) {
          const result = await saveQuestion(toExerciseInput(duplicate.target.q, duplicate.target.q), {
            force: true
          })
          if (result.ok) {
            applySaved(duplicate.target.index, duplicate.target.q, result.id)
            saved += 1
          } else {
            duplicate.target.q.importError = describeQuestionBankError(result.error)
            failures.push(
              `第 ${duplicate.target.index + 1} 题：${duplicate.target.q.importError}`
            )
          }
        }
      }
    }

    if (failures.length > 0) {
      showToast(`已入库 ${saved} 题；${failures.length} 题失败：${failures[0]}`, 'warning')
    } else if (saved > 0) {
      showToast(`已入库 ${saved} 题`, 'success')
    }
  } finally {
    // 只清自己圈住的那些下标：并发的单题导入不该被批量收尾顺手清掉
    const rest = new Set(importing.value)
    targets.forEach(({ index }) => rest.delete(index))
    importing.value = rest
  }
}

/** 单题生成解析的失败码 → 人话（describeParseError 管整卷管线，错误码不完全重叠） */
const ANSWER_ERROR_TEXT: Record<string, string> = {
  NO_BRIDGE: '桌面版才有 AI 生成解析通道',
  EMPTY_CONTENT: '题目内容为空，无法生成解析',
  BAD_SUBJECT: '科目未配置：请先在左栏选择学科后重新解析',
  BAD_PROMPT: '该科目/学段还没配置「生成解析」提示词（prompt_table 缺 answer_prompt_generate 行）',
  EMPTY_ANSWER: '模型返回了空解析，请重试'
}

/** 单题 AI 生成解析：按题调模型，成功后覆盖式写入 q.answerMarkdown */
async function regenerateOne(index: number): Promise<void> {
  const q = questions.value[index]
  if (!q || generating.value.has(index)) return
  if (!bridgeAvailable) {
    showToast('桌面版才有 AI 生成解析通道', 'warning')
    return
  }
  if (!q.subjectCode?.trim()) {
    showToast('缺少科目：请回到左栏选择学科后重新解析', 'warning')
    return
  }
  // 覆盖式写入是有损操作：已有解析时先确认一次，避免手滑把改好的解析冲掉
  if (q.answerMarkdown?.trim() && !window.confirm(`第 ${index + 1} 题已有解析，重新生成将覆盖，确定吗？`)) {
    return
  }

  const next = new Set(generating.value)
  next.add(index)
  generating.value = next
  q.importError = ''
  try {
    const result = await runMathParseAnswer({
      content: q.content,
      subjectCode: q.subjectCode,
      stage: q.stage || stageOfSelection.value
    })
    if (result.ok && result.answerMarkdown) {
      q.answerMarkdown = result.answerMarkdown
      for (const w of result.warnings ?? []) logs.value.push(`[ANSWER] ${w}`)
      logs.value.push(`[ANSWER] 第 ${index + 1} 题解析已生成（${result.answerMarkdown.length} 字）`)
      showToast(`第 ${index + 1} 题解析已生成`, 'success')
    } else {
      const reason =
        ANSWER_ERROR_TEXT[result.error ?? ''] ?? describeParseError(result.error ?? 'UNKNOWN')
      q.importError = `生成解析失败：${reason}`
      showToast(`第 ${index + 1} 题生成解析失败：${reason}`, 'warning')
    }
  } finally {
    const rest = new Set(generating.value)
    rest.delete(index)
    generating.value = rest
  }
}

/** 清空所有题目的来源标题（MathBank clearAllParsedSources 对齐物） */
function clearAllTitles(): void {
  if (questions.value.length === 0) {
    showToast('当前拆解列表为空！', 'warning')
    return
  }
  questions.value.forEach((q) => (q.source = null))
  showToast('已清空所有题目的来源标题', 'success')
}

/** 一键清除：确认后清空源码与全部草稿（MathBank confirmClearAllParsed 对齐物） */
function clearAllDrafts(): void {
  if (!window.confirm('确定要清空输入的试卷源码及拆解出的所有草稿题目吗？')) return
  resetAll()
  showToast('已清空所有录入数据与拆解草稿', 'info')
}

onUnmounted(() => {
  stopTicker()
  unsubscribeLogs()
  unsubscribeImport?.()
  unsubscribeImport = null
})
</script>
