<template>
  <!-- 同其它三个弹窗：Teleport 到 body + 项目那套全局类（base.css 的
       .tianzi-modal / .tianzi-modal-modes / .tianzi-modal-preview /
       .tianzi-modal-hint，格子本身复用扩展的 .tianzi-grid / .tz-cell …）。 -->
  <Teleport to="body">
    <div class="math-modal-overlay" @mousedown.self="emit('cancel')" @keydown="onKeydown">
      <div class="math-modal tianzi-modal" role="dialog" aria-modal="true" aria-label="插入田字格">
        <h3>插入田字格</h3>

        <div class="tianzi-modal-modes">
          <label v-for="m in MODES" :key="m.value" class="tianzi-modal-radio">
            <input v-model="mode" type="radio" name="adm-tianzi-mode" :value="m.value" />
            <span class="tianzi-mode-label">{{ m.zh }}</span>
          </label>
        </div>

        <!-- 三个输入常驻、按形态显隐（与宿主那个弹框一样是 display 切换）：三个都在
             DOM 里，切形态时焦点不会掉到 body 上，Esc / Enter 才接得住。 -->
        <div class="tianzi-modal-fields">
          <input
            ref="charsInput"
            v-show="mode === 'chars'"
            v-model="chars"
            class="image-modal-input tianzi-modal-field"
            type="text"
            placeholder="如：你好"
          />
          <input
            ref="blankInput"
            v-show="mode === 'blank'"
            v-model="blank"
            class="image-modal-input tianzi-modal-field"
            type="text"
            inputmode="numeric"
            placeholder="格数，如：3"
          />
          <input
            ref="pinyinInput"
            v-show="mode === 'pinyin'"
            v-model="pinyin"
            class="image-modal-input tianzi-modal-field"
            type="text"
            placeholder="如：tian1qi4（1阴平2阳平3上声4去声）"
          />
        </div>

        <div class="tianzi-modal-preview">
          <span v-if="model" class="tianzi-grid">
            <span v-for="(cell, i) in model.cells" :key="i" class="tz-cell">
              <span v-if="cell.pinyin" class="tz-py">{{ cell.pinyin }}</span>
              <span class="tz-box">
                <span v-if="cell.char" class="tz-char">{{ cell.char }}</span>
              </span>
            </span>
          </span>
        </div>

        <p class="tianzi-modal-hint" :style="{ color: hintError ? '#d33' : '' }">{{ hint }}</p>

        <div class="math-modal-footer">
          <button type="button" class="math-modal-btn cancel" @click="emit('cancel')">取消</button>
          <button type="button" class="math-modal-btn save" @click="save">插入</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { parseCells, type TianziKind } from '../../extensions/tianzi-grid/lib'

/**
 * 「插入田字格」弹出框 —— 三种形态、字段、实时预览、校验全部照宿主那个
 * （renderer/editor/tianzi-modal.ts）：纯汉字 / 空白格 / 带拼音格，下面实时画出格子。
 *
 * 差别只在产出：宿主插的是 tianzi_grid 节点，这一页要的是规约G 的 markdown
 * `++<inner>++`（inner 的三种写法与宿主 buildRaw() 一致）。田字格是行内语法，
 * 所以插在光标处（有选区就替换），不像子块 / 分栏那样整块挪到段后。
 */
const emit = defineEmits<{ insert: [markdown: string]; cancel: [] }>()

/** 三种形态互斥；example 是该形态的示例 inner（空输入时预览与提示都用它） */
const MODES: { value: TianziKind; zh: string; example: string }[] = [
  { value: 'chars', zh: '纯汉字', example: '你好' },
  { value: 'blank', zh: '空白格', example: '(3)' },
  { value: 'pinyin', zh: '带拼音格', example: '(tian1qi4)' }
]

const mode = ref<TianziKind>('chars')
const chars = ref('')
const blank = ref('')
const pinyin = ref('')
/** 点了「插入」但输入非法 → 把红字逼出来（空着点插入时不显示示例而显示错误） */
const forced = ref(false)

const charsInput = ref<HTMLInputElement | null>(null)
const blankInput = ref<HTMLInputElement | null>(null)
const pinyinInput = ref<HTMLInputElement | null>(null)

/** 当前形态下那一行原始输入 */
const typed = computed(() => {
  const raw = mode.value === 'chars' ? chars.value : mode.value === 'blank' ? blank.value : pinyin.value
  return raw.trim()
})
const example = computed(() => MODES.find((m) => m.value === mode.value)!.example)

/** 预览用的 inner：空输入就用该形态的示例，切形态总能看到样子（与宿主一致） */
const inner = computed(() => (typed.value ? (mode.value === 'chars' ? typed.value : `(${typed.value})`) : example.value))
const model = computed(() => parseCells(inner.value))

/** 组装 ++ 之间的 inner；null = 输入非法（与宿主 buildRaw() 同一套判断） */
function buildInner(): string | null {
  if (mode.value === 'chars') {
    return typed.value && /^[一-龥]+$/.test(typed.value) ? typed.value : null
  }
  if (mode.value === 'blank') {
    return /^\d+$/.test(typed.value) && Number(typed.value) > 0 ? `(${typed.value})` : null
  }
  const raw = `(${typed.value})`
  return typed.value && parseCells(raw) ? raw : null
}

const hintError = computed(() => buildInner() === null && (forced.value || typed.value !== ''))

const hint = computed(() => {
  if (hintError.value) {
    if (mode.value === 'chars') return '请输入纯汉字'
    if (mode.value === 'blank') return '请输入正整数'
    return '拼音格式无效：小写字母 + 可选 1-4 声调'
  }
  if (!typed.value) {
    const label =
      mode.value === 'chars'
        ? '示例（纯汉字，每字一格）'
        : mode.value === 'blank'
          ? '示例（3 个空白格）'
          : '示例（拼音每音节一格，上方带调）'
    return `${label}　++${example.value}++`
  }
  return `${inner.value} → ${model.value?.cells.length ?? 0} 格`
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
  const text = buildInner()
  if (text === null) {
    forced.value = true
    return
  }
  emit('insert', `++${text}++`)
}

const activeField = computed(() =>
  mode.value === 'chars' ? charsInput.value : mode.value === 'blank' ? blankInput.value : pinyinInput.value
)

function focusField(): void {
  activeField.value?.focus()
  activeField.value?.select()
}

// 改形态或改输入都把「已点过插入」的红字收回去
watch([mode, typed], () => {
  forced.value = false
})
// 切形态后焦点要跟到新出现的输入框上：焦点掉了的话上面那两个键就没人接了
watch(mode, () => focusField())

onMounted(() => {
  window.setTimeout(focusField, 50)
})
</script>
