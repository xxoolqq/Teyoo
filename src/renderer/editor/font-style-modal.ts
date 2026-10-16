// 字体样式模态框 —— 工具栏「修改样式」按钮
//
// 前置条件：光标/选区命中字体样式（行内 font_span mark 或块级 :::font 容器），
// 由 getToolbarState().font 判定；按钮在非命中态是禁用的，这里再兜一次底。
//
// 行为：三个下拉都直接显示光标/选区检测到实际值（无「保持不变」占位），
// 未检测到的字段显示默认值（宋体 / 12pt / left）；点「应用」→ applyFont(attrs)
// 按显示值全量写入。字段顺序与取值遵循规约H（.trae/规约H：字体大小规约.md）：
// 字体 → 字号 → 对齐。

import {
  applyFont,
  getToolbarState,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_ALIGN,
} from './editor'
import { isChinese } from '../ui-language'

// 与工具栏字体下拉同一份清单（含开源替代字体）
export const FONT_FAMILIES: { value: string; zh: string; en: string }[] = [
  { value: 'SimSun', zh: '宋体', en: 'SimSun' },
  { value: 'SimHei', zh: '黑体', en: 'SimHei' },
  { value: 'KaiTi', zh: '楷体', en: 'KaiTi' },
  { value: 'FangSong', zh: '仿宋', en: 'FangSong' },
  { value: 'Microsoft YaHei', zh: '微软雅黑', en: 'Microsoft YaHei' },
  { value: 'Noto Serif SC', zh: '思源宋体', en: 'Noto Serif SC' },
  { value: 'Noto Sans SC', zh: '思源黑体', en: 'Noto Sans SC' },
  { value: 'LXGW WenKai', zh: '霞鹜文楷', en: 'LXGW WenKai' },
  { value: 'Times New Roman', zh: 'Times New Roman', en: 'Times New Roman' },
  { value: 'Arial', zh: 'Arial', en: 'Arial' },
  { value: 'Courier New', zh: 'Courier New', en: 'Courier New' },
  { value: 'STIX Two Math', zh: 'STIX Two Math', en: 'STIX Two Math' },
]

export const FONT_SIZES: { value: string; zh: string; en: string }[] = [
  { value: '36pt', zh: '小初 36pt', en: '36pt' },
  { value: '26pt', zh: '一号 26pt', en: '26pt' },
  { value: '24pt', zh: '小一 24pt', en: '24pt' },
  { value: '22pt', zh: '二号 22pt', en: '22pt' },
  { value: '18pt', zh: '小二 18pt', en: '18pt' },
  { value: '16pt', zh: '三号 16pt', en: '16pt' },
  { value: '15pt', zh: '小三 15pt', en: '15pt' },
  { value: '14pt', zh: '四号 14pt', en: '14pt' },
  { value: '12pt', zh: '小四 12pt', en: '12pt' },
  { value: '10.5pt', zh: '五号 10.5pt', en: '10.5pt' },
  { value: '9pt', zh: '小五 9pt', en: '9pt' },
]

// 对齐方式（规约H 2.2：left 为默认，行内 mark 仅做标记透传）
const FONT_ALIGNS: { value: string; zh: string; en: string }[] = [
  { value: 'left', zh: '左对齐（默认）', en: 'Left (default)' },
  { value: 'center', zh: '居中', en: 'Center' },
  { value: 'right', zh: '右对齐', en: 'Right' },
  { value: 'justify', zh: '两端对齐', en: 'Justify' },
]

function alignLabel(value: string, zh: boolean): string {
  const hit = FONT_ALIGNS.find((item) => item.value === value)
  if (hit) return zh ? hit.zh : hit.en
  return value
}

// 三个下拉都不再插「保持不变」占位项：直接落在 current 上（即光标/选区检测到的值），
// 未检测到时由调用方传入默认值（宋体 / 12pt / left）。
function buildSelect(
  options: { value: string; zh: string; en: string }[],
  current: string
): HTMLSelectElement {
  const select = document.createElement('select')
  select.className = 'image-modal-input image-modal-select'
  const zh = isChinese()
  for (const item of options) {
    const option = document.createElement('option')
    option.value = item.value
    option.textContent = zh ? item.zh : item.en
    option.style.fontFamily = `'${item.value}'`
    select.append(option)
  }
  // 当前值不在清单里（文档里可能是任意 family）→ 补一项，避免显示成「保持不变」
  if (current && !options.some((item) => item.value === current)) {
    const option = document.createElement('option')
    option.value = current
    option.textContent = current
    select.append(option)
  }
  select.value = current
  return select
}

export function showFontStyleModal(): void {
  const state = getToolbarState()
  // 未命中字体样式：按钮本应禁用，这里兜底（例如从菜单栏触发）
  if (!state.font) return
  const zh = isChinese()

  const overlay = document.createElement('div')
  overlay.className = 'math-modal-overlay'

  const modal = document.createElement('div')
  modal.className = 'math-modal font-style-modal'

  const header = document.createElement('h3')
  header.textContent = zh ? '修改样式' : 'Edit Style'

  // 三个字段都显示检测到的实际值，未检测到的落到默认值
  // （宋体 / 12pt 小四 / left，字号与对齐默认值见规约H 2.2）。
  const familySelect = buildSelect(FONT_FAMILIES, state.fontFamily ?? DEFAULT_FONT_FAMILY)
  const sizeSelect = buildSelect(FONT_SIZES, state.fontSize ?? DEFAULT_FONT_SIZE)
  const alignSelect = buildSelect(FONT_ALIGNS, state.fontAlign ?? DEFAULT_FONT_ALIGN)

  const familyRow = document.createElement('div')
  familyRow.className = 'image-modal-row'
  const familyCol = document.createElement('div')
  familyCol.className = 'image-modal-col'
  const familyLabel = document.createElement('label')
  familyLabel.className = 'image-modal-label'
  familyLabel.textContent = zh ? '字体' : 'Font'
  familyCol.append(familyLabel, familySelect)
  familyRow.appendChild(familyCol)

  const sizeRow = document.createElement('div')
  sizeRow.className = 'image-modal-row'
  const sizeCol = document.createElement('div')
  sizeCol.className = 'image-modal-col'
  const sizeLabel = document.createElement('label')
  sizeLabel.className = 'image-modal-label'
  sizeLabel.textContent = zh ? '字号' : 'Size'
  sizeCol.append(sizeLabel, sizeSelect)
  sizeRow.appendChild(sizeCol)

  // 字段：对齐（在字号下方，规约H 的 family / size / align 顺序）
  const alignRow = document.createElement('div')
  alignRow.className = 'image-modal-row'
  const alignCol = document.createElement('div')
  alignCol.className = 'image-modal-col'
  const alignLabelEl = document.createElement('label')
  alignLabelEl.className = 'image-modal-label'
  alignLabelEl.textContent = zh ? '对齐' : 'Align'
  alignCol.append(alignLabelEl, alignSelect)
  alignRow.appendChild(alignCol)

  // 检测到的当前样式：让用户确认「这一段确实带样式、带的是什么」
  const detected = document.createElement('p')
  detected.className = 'circled-sup-modal-hint'
  const parts: string[] = []
  if (state.fontFamily) parts.push(state.fontFamily)
  if (state.fontSize) parts.push(state.fontSize)
  if (state.fontAlign) parts.push(alignLabel(state.fontAlign, zh))
  // 未检测到任何样式 → 提示将落到的默认值，与下拉里显示的保持一致
  detected.textContent = parts.length
    ? (zh ? '检测到当前样式：' : 'Detected style: ') + parts.join(' · ')
    : (zh ? '未检测到样式，将应用默认值：' : 'No style detected, defaults: ')
      + [DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, alignLabel(DEFAULT_FONT_ALIGN, zh)].join(' · ')

  const footer = document.createElement('div')
  footer.className = 'math-modal-footer'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'math-modal-btn cancel'
  cancelBtn.textContent = zh ? '取消' : 'Cancel'
  cancelBtn.addEventListener('click', () => overlay.remove())

  const applyBtn = document.createElement('button')
  applyBtn.type = 'button'
  applyBtn.className = 'math-modal-btn save'
  applyBtn.textContent = zh ? '应用' : 'Apply'

  const apply = (): void => {
    // 三个下拉都无「保持不变」，一律按当前显示值写入（未检测到即默认值）
    const attrs: { family?: string; size?: string; align?: string } = {
      family: familySelect.value || DEFAULT_FONT_FAMILY,
      size: sizeSelect.value || DEFAULT_FONT_SIZE,
      align: alignSelect.value || DEFAULT_FONT_ALIGN,
    }
    applyFont(attrs)
    overlay.remove()
  }
  applyBtn.addEventListener('click', apply)

  for (const field of [familySelect, sizeSelect, alignSelect]) {
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        apply()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        overlay.remove()
      }
    })
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) overlay.remove()
  })

  footer.append(cancelBtn, applyBtn)
  modal.append(header, detected, familyRow, sizeRow, alignRow, footer)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  familySelect.focus()
}
