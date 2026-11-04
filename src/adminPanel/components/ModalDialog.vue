<template>
  <!-- 通用表单弹窗：标题 + 插槽内容 + 取消/确定。
       与 ConfirmDialog 分开：那个是「问一句要不要」的结果型弹窗，这个是装表单的，
       正文由调用方给（映射名、下拉框…），这里只管外壳与交互。

       不 Teleport 到 body：主题变量（--admin-*）定义在 #admin-panel 作用域里，
       挪到 body 底下会拿不到变量、配色直接失效（与 ConfirmDialog 同一取舍）。 -->
  <!-- 遮罩不响应点击：表单弹窗里点空白处就把没填完的内容丢掉太容易误触，
       只保留「取消」按钮和 Esc 两种关闭方式。 -->
  <div v-if="open" class="mask" @keydown.esc="onCancel">
    <div class="dialog" :style="{ width }" role="dialog" aria-modal="true">
      <h3 class="title">{{ title }}</h3>
      <div class="body"><slot /></div>
      <div class="actions">
        <button v-if="!hideCancel" class="btn" type="button" @click="onCancel">
          {{ cancelText }}
        </button>
        <button class="btn is-primary" type="button" :disabled="confirmDisabled" @click="onConfirm">
          {{ confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    confirmText?: string
    cancelText?: string
    /** 表单没填完时置灰确定按钮（校验的最终判定仍放在调用方） */
    confirmDisabled?: boolean
    /**
     * 弹窗宽度，默认 380px（单列表单够用）。内容横向需要更多位置时由调用方给，
     * 例如子映射一行两组时给 540px。窄屏仍受 .dialog 的 max-width 约束。
     *
     * 高度不跟着变：正文区有 max-height，内容多时在弹窗内部滚动，弹窗本身不会被撑高。
     */
    width?: string
    /**
     * 只读弹窗（例如「查看详情」）不需要「取消」，只留一个关闭动作。
     * 默认 false，表单弹窗仍是取消 + 确定两个按钮。
     */
    hideCancel?: boolean
  }>(),
  { confirmText: '确定', cancelText: '取消', confirmDisabled: false, width: '380px', hideCancel: false }
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()

function onConfirm(): void {
  emit('confirm')
}

function onCancel(): void {
  emit('cancel')
}

// Esc 关闭：只在这个弹窗挂着时响应（同 ConfirmDialog）
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
  /* 实际宽度由 width 属性以内联样式给出，这里是兜底 */
  width: 380px;
  /* 窄屏收窄，不横向溢出 */
  max-width: calc(100vw - 40px);
  padding: 18px 20px 16px;
  border-radius: 10px;
  background: var(--admin-surface, #fff);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
  color: var(--admin-text, #1f2d3d);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 18px;
  /* 高度上限：条目再多也只在弹窗内部滚，弹窗本身不被撑高 */
  max-height: 60vh;
  overflow-y: auto;
  /* 滚动条不贴着边框，留一点呼吸 */
  padding-right: 2px;
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

.btn:hover:not(:disabled) {
  color: var(--admin-primary, #2d8cf0);
  border-color: var(--admin-primary, #2d8cf0);
}

.btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.btn.is-primary {
  color: #fff;
  border-color: #3b82f6;
  background: #3b82f6;
  font-weight: 600;
}

.btn.is-primary:hover:not(:disabled) {
  color: #fff;
  background: #2f74e0;
  border-color: #2f74e0;
}
</style>
