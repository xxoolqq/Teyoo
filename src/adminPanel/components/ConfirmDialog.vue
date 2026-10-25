<template>
  <!-- 确认弹窗。面板里没有现成的 modal，这里做最小可用版：
       遮罩 + 卡片 + 两个按钮，Esc / 点遮罩都算取消。

       不 Teleport 到 body：主题变量（--admin-*）定义在 #admin-panel 作用域里，
       挪到 body 底下会拿不到变量、配色直接失效。fixed 定位在这里够用。 -->
  <div v-if="open" class="mask" @click.self="onCancel" @keydown.esc="onCancel">
    <div class="dialog" role="dialog" aria-modal="true">
      <h3 class="title">{{ title }}</h3>
      <p class="message">{{ message }}</p>
      <div class="actions">
        <button class="btn" type="button" @click="onCancel">{{ cancelText }}</button>
        <button class="btn is-primary" type="button" @click="onConfirm">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    message: string
    confirmText?: string
    cancelText?: string
  }>(),
  { title: '确认', confirmText: '确定', cancelText: '取消' }
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()

function onConfirm(): void {
  emit('confirm')
}

function onCancel(): void {
  emit('cancel')
}

// Esc 关闭：弹窗开着的时候才把监听挂上（不然整页都在等一个不存在的对话框）
function onKeydown(event: KeyboardEvent): void {
  if (props.open && event.key === 'Escape') {
    event.preventDefault()
    onCancel()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.dialog {
  width: 340px;
  padding: 18px 20px 16px;
  border-radius: 10px;
  background: var(--admin-surface, #fff);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.message {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--admin-text-weak, #8492a6);
  white-space: pre-wrap;
}

.actions {
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  height: 30px;
  padding: 0 16px;
  font-family: inherit;
  font-size: 13px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
}

.btn:hover {
  color: var(--admin-primary, #2d8cf0);
  border-color: var(--admin-primary, #2d8cf0);
}

.btn.is-primary {
  color: #fff;
  border-color: #3b82f6;
  background: #3b82f6;
  font-weight: 600;
}

.btn.is-primary:hover {
  color: #fff;
  background: #2f74e0;
  border-color: #2f74e0;
}
</style>
