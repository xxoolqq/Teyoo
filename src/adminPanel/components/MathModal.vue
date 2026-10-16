<template>
  <!-- 同其它四个弹窗：Teleport 到 body + 项目那套全局类（base.css 的
       .math-modal-overlay / .math-modal / .math-modal-input / .math-modal-options /
       .math-modal-footer / .math-modal-btn）。 -->
  <Teleport to="body">
    <div class="math-modal-overlay" @mousedown.self="emit('cancel')" @keydown="onKeydown">
      <div class="math-modal" role="dialog" aria-modal="true" aria-label="插入公式">
        <h3>插入公式</h3>

        <textarea
          ref="input"
          v-model="value"
          class="math-modal-input"
          rows="4"
          spellcheck="false"
          placeholder="输入 LaTeX 代码，例如 E=mc^2"
        ></textarea>

        <div class="math-modal-options">
          <input id="adm-math-block" v-model="isBlock" type="checkbox" />
          <label for="adm-math-block"> 作为块公式显示（居中）</label>
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
import { showInfo } from '../stores/toast'

/**
 * 「插入公式」弹出框 —— 字段、快捷键与按钮照宿主那个（renderer/editor/math-modal.ts）：
 * 一段 LaTeX，加一个「作为块公式显示（居中）」开关。
 *
 * 产出串直接取宿主在**源码模式**下的写法（math-modal.ts 的 save：
 * `$${value}$` / `\n$$\n${value}\n$$\n`）—— 那边也是往 textarea 里插，与这一页
 * 同一情形。块公式的首尾空行由 insertBlockMarkdown 补（它整块挪到段后新段落），
 * 所以这里只给 `$$\n…\n$$`，不带那两个换行，免得多出空行。
 */
const emit = defineEmits<{
  insert: [item: { markdown: string; block: boolean }]
  cancel: []
}>()

const value = ref('')
const isBlock = ref(false)
const input = ref<HTMLTextAreaElement | null>(null)

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
  const latex = value.value.trim()
  if (!latex) {
    // 与这一页其它「前置条件不满足」同一处理：说清楚，不插空壳
    showInfo('先输入 LaTeX 代码')
    return
  }
  emit('insert', {
    markdown: isBlock.value ? `$$\n${latex}\n$$` : `$${latex}$`,
    block: isBlock.value
  })
}

onMounted(() => {
  window.setTimeout(() => input.value?.focus(), 50)
})
</script>
