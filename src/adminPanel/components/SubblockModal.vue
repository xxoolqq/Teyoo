<template>
  <!-- 与「插入图片」同一个道理：Teleport 到 body，样式用项目那套全局类
       （base.css 的 .math-modal-overlay / .subblock-modal / .subblock-modal-textarea
       / .image-modal-cb-row …），所以这个弹窗与「新建 md 文档」工具栏那个长得一样。 -->
  <Teleport to="body">
    <div class="math-modal-overlay" @mousedown.self="emit('cancel')" @keydown="onKeydown">
      <div class="math-modal subblock-modal" role="dialog" aria-modal="true" aria-label="插入子块">
        <h3>插入子块</h3>

        <label class="image-modal-label" for="adm-sub-text">内容</label>
        <textarea
          id="adm-sub-text"
          ref="textArea"
          v-model="text"
          class="math-modal-input subblock-modal-textarea"
          rows="4"
          placeholder="输入文本内容…"
        ></textarea>

        <div class="image-modal-cb-row">
          <label class="image-modal-cb-item">
            <input v-model="boxed" type="checkbox" />
            <span class="image-modal-cb-label">边框</span>
          </label>
          <div class="image-modal-cb-item">
            <span class="image-modal-cb-label">对齐</span>
            <select v-model="align" class="image-modal-select">
              <option v-for="opt in ALIGN_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.zh }}
              </option>
            </select>
          </div>
        </div>

        <div class="math-modal-footer">
          <button type="button" class="math-modal-btn cancel" @click="emit('cancel')">取消</button>
          <button type="button" class="math-modal-btn save" @click="save">插入</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { escapeInnerMarkers } from '../../extensions/columns/stringify'

/**
 * 「插入子块」弹出框 —— 字段与产出照宿主那个（renderer/editor/subblock-modal.ts）：
 * 内容 / 边框 / 对齐，插入后是 `@box[#对齐]\n内容\n@`。
 *
 * 与宿主唯一的差别是产出形态：那边插的是 ProseMirror 节点，这一页的真相是纯
 * markdown 文本，所以按规约F 的序列化拼串（与 stringify.ts 的
 * subBlockStringifyHandler 同一拼法，含内部标记的防御性转义）。
 */
const emit = defineEmits<{ insert: [markdown: string]; cancel: [] }>()

// 子块自己的对齐三选（schema 的 align: 'left' | 'center' | 'right'）。不能 import
// 宿主那份：subblock-modal.ts 顶层 new SubBlockModal()，一 import 就往 body 挂 DOM。
const ALIGN_OPTIONS: { value: string; zh: string }[] = [
  { value: 'left', zh: '左对齐' },
  { value: 'center', zh: '居中' },
  { value: 'right', zh: '右对齐' }
]

const text = ref('')
const boxed = ref(true)
const align = ref('left')
const textArea = ref<HTMLTextAreaElement | null>(null)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
    return
  }
  // 多行输入框：Enter 是换行，保存走 Ctrl/Cmd+Enter（与宿主那个弹框一致）
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    save()
  }
}

function save(): void {
  // 头：`@` + box（带边框）+ #对齐（非左对齐时才写）—— 与 subBlockStringifyHandler 同款
  const head = '@' + (boxed.value ? 'box' : '') + (align.value !== 'left' ? `#${align.value}` : '')
  const body = escapeInnerMarkers(text.value.trim())
  emit('insert', body ? `${head}\n${body}\n@` : `${head}\n@`)
}

onMounted(() => {
  window.setTimeout(() => textArea.value?.focus(), 50)
})
</script>
