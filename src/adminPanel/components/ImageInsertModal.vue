<template>
  <!-- Teleport 到 body 是必须的：遮罩层用项目自己的 .math-modal-overlay
       （base.css:1831：position: fixed + inset 40px + z-index 10000），挂在后台面板
       里面会被 #admin-panel 那层（z-index: 4，自成层叠上下文）锁住 —— 与提示框
       （ToastHost）同一个道理。
       类名全部沿用项目那套全局类（.math-modal / .image-modal / .image-modal-row …），
       不在面板里抄第二份样式：这样这个弹出框与「新建 md 文档」工具栏那个长得一样，
       也不会走散。 -->
  <Teleport to="body">
    <div class="math-modal-overlay" @mousedown.self="emit('cancel')" @keydown="onKeydown">
      <div class="math-modal image-modal" role="dialog" aria-modal="true" aria-label="插入图片">
        <h3>插入图片</h3>

        <div class="image-modal-preview-wrap">
          <img v-if="src.trim()" class="image-modal-preview" :src="previewUrl" alt="" />
        </div>

        <div class="image-modal-row">
          <div class="image-modal-col">
            <label class="image-modal-label" for="adm-img-src">路径 / URL</label>
            <div class="image-modal-src-flex">
              <input
                id="adm-img-src"
                ref="srcInput"
                v-model="src"
                class="image-modal-input"
                type="text"
                placeholder="本地路径或 URL"
              />
              <button
                type="button"
                class="image-modal-convert-btn"
                :disabled="picking"
                @click="pickFile"
              >
                {{ browseText }}
              </button>
              <button
                type="button"
                class="image-modal-convert-btn"
                :disabled="converting"
                @click="convertToBase64"
              >
                {{ convertText }}
              </button>
            </div>
          </div>
        </div>

        <div class="image-modal-row">
          <div class="image-modal-col">
            <label class="image-modal-label" for="adm-img-alt">描述文本</label>
            <input
              id="adm-img-alt"
              v-model="alt"
              class="image-modal-input"
              type="text"
              placeholder="图片描述（用于无障碍/粘贴纯文本）"
            />
          </div>
        </div>

        <div class="image-modal-row">
          <div class="image-modal-col">
            <label class="image-modal-label" for="adm-img-width">宽度</label>
            <input
              id="adm-img-width"
              v-model="width"
              class="image-modal-input"
              type="text"
              placeholder="auto / 100px / 50%"
            />
          </div>
          <div class="image-modal-col">
            <label class="image-modal-label" for="adm-img-height">高度</label>
            <input
              id="adm-img-height"
              v-model="height"
              class="image-modal-input"
              type="text"
              placeholder="auto / 100px / 50%"
            />
          </div>
        </div>

        <div class="image-modal-row">
          <div class="image-modal-col">
            <label class="image-modal-label" for="adm-img-align">对齐方式</label>
            <select id="adm-img-align" v-model="align" class="image-modal-input image-modal-select">
              <option v-for="opt in ALIGN_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.zh }}
              </option>
            </select>
          </div>
        </div>

        <div class="image-modal-options">
          <input id="adm-img-border" v-model="border" type="checkbox" />
          <label class="image-modal-cb-label" for="adm-img-border">边框</label>
          <input id="adm-img-shadow" v-model="shadow" type="checkbox" />
          <label class="image-modal-cb-label" for="adm-img-shadow">阴影</label>
          <input id="adm-img-radius" v-model="radius" type="checkbox" />
          <label class="image-modal-cb-label" for="adm-img-radius">圆角</label>
        </div>

        <div class="math-modal-footer">
          <button type="button" class="math-modal-btn cancel" @click="emit('cancel')">取消</button>
          <button type="button" class="math-modal-btn save" @click="save">插入</button>
        </div>
      </div>
    </div>

    <!-- 选本地文件的隐藏 input。放在遮罩外面（与宿主那个弹框同一处理）：它靠
         .click() 弹出系统对话框，display: none 不影响；放在模态框里会被键盘处理吃掉。 -->
    <input
      ref="fileInput"
      class="img-modal-file"
      type="file"
      accept="image/*"
      @change="onFilePicked"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { showInfo } from '../stores/toast'
import {
  ALIGN_OPTIONS,
  stringifyImageAlt,
  toFileUrl,
  type ImageAlign
} from '../../extensions/image-style/lib'
import {
  describeCompression,
  fileToEmbeddableDataUrl,
  urlToDataUrl
} from '../../renderer/editor/image-embed'

/**
 * 「插入图片」弹出框 —— 字段与交互照宿主那个（src/renderer/editor/image-modal.ts）：
 * 同样的字段、同样的 Esc / Ctrl+Enter、点遮罩关闭、输入 src 即时预览。
 *
 * 两处不一样，都是因为这一页的真相是**纯 markdown 文本**（textarea），不是
 * ProseMirror 文档：
 *   1. 产出是 `![描述#宽#高#对齐#B#S#R](url)` 这串文本，由项目自己的
 *      stringifyImageAlt 拼（image-style/lib.ts），预览那边同一个扩展能原样解析回来；
 *   2. 本地图片一律内嵌成 base64。宿主那里还能写本地路径（存盘时文件就在磁盘上），
 *      这一页的内容是要提交给后端的 —— 服务端读不到用户机器上的路径，只有内嵌
 *      活得下来（image-embed.ts 开头的注释就是这个理由）。
 */

const emit = defineEmits<{
  insert: [markdown: string]
  cancel: []
}>()

const src = ref('')
const alt = ref('')
const width = ref('')
const height = ref('')
const align = ref('')
const border = ref(false)
const shadow = ref(false)
const radius = ref(false)

const srcInput = ref<HTMLInputElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

/** 本地绝对路径在 <img> 里加载不了，统一转 file://（与宿主那个弹框一致） */
const previewUrl = computed(() => toFileUrl(src.value.trim()))

/** 尺寸值的校验：空 / auto / Npx / N% —— 与宿主 save() 里同一条 */
const RE_SIZE = /^(|auto|\d+(?:\.\d+)?px|\d+(?:\.\d+)?%)$/

// 「浏览」「转 Base64」两个按钮的瞬时文案（读取中 / 已压缩 / 已转换 …），到点恢复
// 默认 —— 与宿主 ImageModal.flashButton 同一手法。
const picking = ref(false)
const converting = ref(false)
const browseText = ref('浏览')
const convertText = ref('转 Base64')

function flash(text: string, target: 'browse' | 'convert', duration = 1500): void {
  if (target === 'browse') browseText.value = text
  else convertText.value = text
  window.setTimeout(() => {
    if (target === 'browse') browseText.value = '浏览'
    else convertText.value = '转 Base64'
  }, duration)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
    return
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    save()
  }
}

function save(): void {
  const url = src.value.trim()
  if (!url) {
    // 与这一页其它「前置条件不满足」同一处理：说清楚，不硬塞（字体/字号按钮同理）
    showInfo('先填图片的路径或 URL，或用「浏览」选一张本地图片')
    return
  }
  // 参数串交给规约自己的序列化：宽 → 高 → 对齐 → B → S → R（image-style/lib.ts）
  const altText = stringifyImageAlt(alt.value, {
    width: RE_SIZE.test(width.value.trim()) ? width.value.trim() : '',
    height: RE_SIZE.test(height.value.trim()) ? height.value.trim() : '',
    align: (align.value || '') as ImageAlign | undefined,
    border: border.value,
    shadow: shadow.value,
    radius: radius.value
  })
  emit('insert', `![${altText}](${url})`)
}

function pickFile(): void {
  fileInput.value?.click()
}

async function onFilePicked(): Promise<void> {
  const input = fileInput.value
  const file = input?.files?.[0]
  // 立刻清空，否则下次选同一个文件不会再触发 change
  if (input) input.value = ''
  if (!file) return

  picking.value = true
  browseText.value = '读取中…'
  try {
    const result = await fileToEmbeddableDataUrl(file)
    src.value = result.dataUrl
    // alt 空着时用文件名兜底（去扩展名），与宿主 altFromPath 同一处理
    if (!alt.value.trim()) alt.value = file.name.replace(/\.[^.]+$/, '')
    // 压缩了就多报一句、多留一会儿：提交内容的大小用户在意
    if (result.compressed) {
      flash(`已压缩 ${describeCompression(result)}`, 'browse', 3000)
    } else {
      flash('已选择', 'browse', 1200)
    }
  } catch (error) {
    console.error('读取本地图片失败:', error)
    flash('读取失败', 'browse', 3000)
  } finally {
    picking.value = false
  }
}

async function convertToBase64(): Promise<void> {
  const url = src.value.trim()
  if (!url || converting.value) return
  if (/^data:/i.test(url)) {
    flash('已是 Base64', 'convert')
    return
  }
  converting.value = true
  convertText.value = '转换中…'
  try {
    // 本地路径（D:\… / 相对）在浏览器里取不到字节，先转 file:// 再取
    const dataUrl = await urlToDataUrl(toFileUrl(url)).catch(() => null)
    if (!dataUrl) {
      flash('转换失败', 'convert', 3000)
      return
    }
    src.value = dataUrl
    flash('已转换', 'convert')
  } finally {
    converting.value = false
  }
}

onMounted(() => {
  // 与宿主一致：进来就落在 src 上，通常第一个要填的就是它
  window.setTimeout(() => {
    srcInput.value?.focus()
    srcInput.value?.select()
  }, 50)
})
</script>

<style scoped>
/* 隐藏的文件选择框：display: none 不影响 .click() 弹系统对话框 */
.img-modal-file {
  display: none;
}
</style>
