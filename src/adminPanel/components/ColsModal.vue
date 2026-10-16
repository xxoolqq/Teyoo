<template>
  <!-- 同「插入图片」「插入子块」：Teleport 到 body + 项目那套全局类
       （base.css 的 .cols-modal / .cols-modal-preview / .cols-preview-grid /
       .cols-preview-cell / .cols-modal-hint），与宿主那个弹窗同一观感。 -->
  <Teleport to="body">
    <div class="math-modal-overlay" @mousedown.self="emit('cancel')" @keydown="onKeydown">
      <div class="math-modal cols-modal" role="dialog" aria-modal="true" aria-label="插入分栏">
        <h3>插入分栏</h3>

        <label class="image-modal-label" for="adm-cols-spec">列数与比例</label>
        <input
          id="adm-cols-spec"
          ref="specInput"
          v-model="spec"
          class="image-modal-input"
          type="text"
          placeholder="如 2、3、1:2、2:3"
        />

        <!-- 实时预览，照宿主那个弹框：合法就按 spec 画格子，不合法退回 2 列示例 -->
        <div class="cols-modal-preview">
          <div
            class="cols-preview-grid"
            :style="{ gridTemplateColumns: gridTemplate(valid ? spec.trim() : '2') }"
          >
            <div v-for="i in count" :key="i" class="cols-preview-cell">子块{{ i }}内容</div>
          </div>
        </div>
        <div class="cols-modal-hint" :style="{ color: isError ? '#d33' : '' }">{{ hint }}</div>

        <div class="math-modal-footer">
          <button type="button" class="math-modal-btn cancel" @click="emit('cancel')">取消</button>
          <button type="button" class="math-modal-btn save" @click="save">插入</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { columnCount, gridTemplate, isValidSpec } from '../../extensions/columns/schema'

/**
 * 「插入分栏」弹出框 —— 字段、实时预览、校验都照宿主那个
 * （renderer/editor/cols-modal.ts）：一个 spec 输入框（N 等宽 或 A:B 比例），
 * 下面按 spec 实时画格子。
 *
 * 差别仍在产出形态：宿主插的是 cols 节点 + N 个空子块，这一页要的是这类结构的
 * markdown（规约F）：`@@cols <spec>\n@box\n@\n@box\n@\n@@`。
 * 列内容留空而不是塞占位文字 —— 与宿主一致（那边建的也是空子块）。
 */
const emit = defineEmits<{ insert: [markdown: string]; cancel: [] }>()

/** 默认 2 列：与 cols 节点的默认 spec 一致（schema.ts 的 default: '2'） */
const spec = ref('2')
/** 点了「插入」但 spec 非法 → 把红字逼出来（不然点了没反应） */
const forced = ref(false)
const specInput = ref<HTMLInputElement | null>(null)

const valid = computed(() => isValidSpec(spec.value.trim()))
const count = computed(() => (valid.value ? columnCount(spec.value.trim()) : 2))
const isError = computed(() => !valid.value && (spec.value.trim() !== '' || forced.value))

const hint = computed(() => {
  const v = spec.value.trim()
  if (valid.value) {
    return v.includes(':') ? `比例分栏：${v}（左:右）` : `等宽分栏：${columnCount(v)} 列`
  }
  return isError.value
    ? '格式无效：请输入数字（如 2）或 数字:数字（如 1:2）'
    : '示例：2 列等宽（输入数字 N 或 数字:数字 比例）'
})

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
    return
  }
  // 单行输入：Enter 直接保存（与宿主那个弹框一致）
  if (event.key === 'Enter') {
    event.preventDefault()
    save()
  }
}

function save(): void {
  const v = spec.value.trim()
  if (!isValidSpec(v)) {
    forced.value = true
    return
  }
  // cols 只装子块（schema.ts 的 content: sub_block+），每列一个空的带框子块
  const cells = Array.from({ length: columnCount(v) }, () => '@box\n@')
  emit('insert', `@@cols ${v}\n${cells.join('\n')}\n@@`)
}

onMounted(() => {
  window.setTimeout(() => {
    specInput.value?.focus()
    specInput.value?.select()
  }, 50)
})
</script>
