// ─── 类 docx 文档的工具栏 ─────────────────────────────────────────────────
// 与官方 demo（hufe.club/canvas-editor）保持一致，三件套都来自官方仓库：
//   · DOM      ← Hufe921/canvas-editor 根目录 index.html（见 menu-html.ts）
//   · 样式/图标 ← src/style.css + src/assets/images（见 menu.css / assets）
//   · 事件绑定 ← src/main.ts 的「2~6」分组（menu 项的全部命令调用）
//
// 为适配"一个窗口多份工具栏"（每个标签页一份），做了三处改造：
//   1. 官方的 document.querySelector 全部换成 scoped 到 root 的 q / qa，
//      否则多份工具栏会互相串台；DOM 里的 id 也一并换成 class。
//   2. 去掉依赖 prismjs 的代码块高亮（不想为一个按钮引入 prism）。
//   3. 去掉全屏（Electron 里无意义，且会抢 F11）与批注系统相关部分。

import {
  BlockType,
  ControlState,
  ControlType,
  EditorMode,
  ElementType,
  ListStyle,
  ListType,
  PageMode,
  PaperDirection,
  RowFlex,
  TextDecorationStyle,
  TitleLevel,
  splitText
} from '@hufe921/canvas-editor'
import type {
  Editor,
  IBlock,
  ICatalogItem,
  IElement
} from '@hufe921/canvas-editor'
import { Dialog } from './dialog/Dialog'
import {
  exportMarkdownToDisk,
  importJsonIntoNewTab,
  // 已停用：导入 Markdown（用户要求撤下）。菜单项在 menu-html.ts 里注释掉了，
  // 恢复时把这里和下面 onmousedown 里的分支一起放开。
  // importMarkdownIntoNewTab,
  openSpecialCharacters
} from './io'
import './menu.css'

/**
 * 把官方那套菜单接到某个编辑器实例上：root 是渲染了 MENU_HTML 的容器。
 * 返回解绑函数（全局监听要跟着标签页一起走）。
 */
export function bindMenu(editor: Editor, root: HTMLElement): () => void {
  const q = <T extends Element = Element>(selector: string): T | null =>
    root.querySelector<T>(selector)
  const qa = <T extends Element = Element>(
    selector: string
  ): NodeListOf<T> => root.querySelectorAll<T>(selector)
  const isApple =
    typeof navigator !== 'undefined' && /Mac OS X/.test(navigator.userAgent)

  // 菜单弹窗销毁：官方 demo 注册在 window 上（document.querySelector('.visible')），
  // 一个窗口多份工具栏时会关错人 —— 这里 scoped 到本份工具栏，返回时注销。
  const onDocumentClick = (evt: MouseEvent): void => {
    const visibleDom = root.querySelector('.visible')
    if (!visibleDom || visibleDom.contains(<Node>evt.target)) return
    visibleDom.classList.remove('visible')
  }
  document.addEventListener('click', onDocumentClick, { capture: true })

  // 2. | 撤销 | 重做 | 格式刷 | 清除格式 |
  const undoDom = q<HTMLDivElement>('.menu-item__undo')!
  undoDom.title = `撤销(${isApple ? '⌘' : 'Ctrl'}+Z)`
  undoDom.onclick = function () {

    editor.command.executeUndo()
  }

  const redoDom = q<HTMLDivElement>('.menu-item__redo')!
  redoDom.title = `重做(${isApple ? '⌘' : 'Ctrl'}+Y)`
  redoDom.onclick = function () {

    editor.command.executeRedo()
  }

  const painterDom = q<HTMLDivElement>(
    '.menu-item__painter'
  )!

  let isFirstClick = true
  let painterTimeout: number
  painterDom.onclick = function () {
    if (isFirstClick) {
      isFirstClick = false
      painterTimeout = window.setTimeout(() => {

        isFirstClick = true
        editor.command.executePainter({
          isDblclick: false
        })
      }, 200)
    } else {
      window.clearTimeout(painterTimeout)
    }
  }

  painterDom.ondblclick = function () {

    isFirstClick = true
    window.clearTimeout(painterTimeout)
    editor.command.executePainter({
      isDblclick: true
    })
  }

  q<HTMLDivElement>('.menu-item__format')!.onclick =
    function () {

      editor.command.executeFormat()
    }

  // 3. | 字体 | 字体变大 | 字体变小 | 加粗 | 斜体 | 下划线 | 删除线 | 上标 | 下标 | 字体颜色 | 背景色 |
  const fontDom = q<HTMLDivElement>('.menu-item__font')!
  const fontSelectDom = fontDom.querySelector<HTMLDivElement>('.select')!
  const fontOptionDom = fontDom.querySelector<HTMLDivElement>('.options')!
  fontDom.onclick = function () {

    fontOptionDom.classList.toggle('visible')
  }
  fontOptionDom.onclick = function (evt) {
    const li = evt.target as HTMLLIElement
    editor.command.executeFont(li.dataset.family!)
  }

  const sizeSetDom = q<HTMLDivElement>('.menu-item__size')!
  const sizeSelectDom = sizeSetDom.querySelector<HTMLDivElement>('.select')!
  const sizeOptionDom = sizeSetDom.querySelector<HTMLDivElement>('.options')!
  sizeSetDom.title = `设置字号`
  sizeSetDom.onclick = function () {

    sizeOptionDom.classList.toggle('visible')
  }
  sizeOptionDom.onclick = function (evt) {
    const li = evt.target as HTMLLIElement
    editor.command.executeSize(Number(li.dataset.size!))
  }

  const sizeAddDom = q<HTMLDivElement>(
    '.menu-item__size-add'
  )!
  sizeAddDom.title = `增大字号(${isApple ? '⌘' : 'Ctrl'}+[)`
  sizeAddDom.onclick = function () {

    editor.command.executeSizeAdd()
  }

  const sizeMinusDom = q<HTMLDivElement>(
    '.menu-item__size-minus'
  )!
  sizeMinusDom.title = `减小字号(${isApple ? '⌘' : 'Ctrl'}+])`
  sizeMinusDom.onclick = function () {

    editor.command.executeSizeMinus()
  }

  const boldDom = q<HTMLDivElement>('.menu-item__bold')!
  boldDom.title = `加粗(${isApple ? '⌘' : 'Ctrl'}+B)`
  boldDom.onclick = function () {

    editor.command.executeBold()
  }

  const italicDom =
    q<HTMLDivElement>('.menu-item__italic')!
  italicDom.title = `斜体(${isApple ? '⌘' : 'Ctrl'}+I)`
  italicDom.onclick = function () {

    editor.command.executeItalic()
  }

  const underlineDom = q<HTMLDivElement>(
    '.menu-item__underline'
  )!
  underlineDom.title = `下划线(${isApple ? '⌘' : 'Ctrl'}+U)`
  const underlineOptionDom =
    underlineDom.querySelector<HTMLDivElement>('.options')!
  underlineDom.querySelector<HTMLSpanElement>('.select')!.onclick =
    function () {
      underlineOptionDom.classList.toggle('visible')
    }
  underlineDom.querySelector<HTMLElement>('i')!.onclick = function () {

    editor.command.executeUnderline()
    underlineOptionDom.classList.remove('visible')
  }
  underlineDom.querySelector<HTMLUListElement>('ul')!.onmousedown = function (
    evt
  ) {
    const li = evt.target as HTMLLIElement
    const decorationStyle = <TextDecorationStyle>li.dataset.decorationStyle
    editor.command.executeUnderline({
      style: decorationStyle
    })
    underlineOptionDom.classList.remove('visible')
  }

  const strikeoutDom = q<HTMLDivElement>(
    '.menu-item__strikeout'
  )!
  strikeoutDom.onclick = function () {

    editor.command.executeStrikeout()
  }

  const superscriptDom = q<HTMLDivElement>(
    '.menu-item__superscript'
  )!
  superscriptDom.title = `上标(${isApple ? '⌘' : 'Ctrl'}+Shift+,)`
  superscriptDom.onclick = function () {

    editor.command.executeSuperscript()
  }

  const subscriptDom = q<HTMLDivElement>(
    '.menu-item__subscript'
  )!
  subscriptDom.title = `下标(${isApple ? '⌘' : 'Ctrl'}+Shift+.)`
  subscriptDom.onclick = function () {

    editor.command.executeSubscript()
  }

  const colorControlDom = q<HTMLInputElement>('.color-input')!
  colorControlDom.oninput = function () {
    editor.command.executeColor(colorControlDom.value)
  }
  const colorDom = q<HTMLDivElement>('.menu-item__color')!
  const colorSpanDom = colorDom.querySelector('span')!
  colorDom.onclick = function () {

    colorControlDom.click()
  }

  const highlightControlDom =
    q<HTMLInputElement>('.highlight-input')!
  highlightControlDom.oninput = function () {
    editor.command.executeHighlight(highlightControlDom.value)
  }
  const highlightDom = q<HTMLDivElement>(
    '.menu-item__highlight'
  )!
  const highlightSpanDom = highlightDom.querySelector('span')!
  highlightDom.onclick = function () {

    highlightControlDom?.click()
  }

  const titleDom = q<HTMLDivElement>('.menu-item__title')!
  const titleSelectDom = titleDom.querySelector<HTMLDivElement>('.select')!
  const titleOptionDom = titleDom.querySelector<HTMLDivElement>('.options')!
  titleOptionDom.querySelectorAll('li').forEach((li, index) => {
    li.title = `Ctrl+${isApple ? 'Option' : 'Alt'}+${index}`
  })

  titleDom.onclick = function () {

    titleOptionDom.classList.toggle('visible')
  }
  titleOptionDom.onclick = function (evt) {
    const li = evt.target as HTMLLIElement
    const level = <TitleLevel>li.dataset.level
    editor.command.executeTitle(level || null)
  }

  const leftDom = q<HTMLDivElement>('.menu-item__left')!
  leftDom.title = `左对齐(${isApple ? '⌘' : 'Ctrl'}+L)`
  leftDom.onclick = function () {

    editor.command.executeRowFlex(RowFlex.LEFT)
  }

  const centerDom =
    q<HTMLDivElement>('.menu-item__center')!
  centerDom.title = `居中对齐(${isApple ? '⌘' : 'Ctrl'}+E)`
  centerDom.onclick = function () {

    editor.command.executeRowFlex(RowFlex.CENTER)
  }

  const rightDom = q<HTMLDivElement>('.menu-item__right')!
  rightDom.title = `右对齐(${isApple ? '⌘' : 'Ctrl'}+R)`
  rightDom.onclick = function () {

    editor.command.executeRowFlex(RowFlex.RIGHT)
  }

  const alignmentDom = q<HTMLDivElement>(
    '.menu-item__alignment'
  )!
  alignmentDom.title = `两端对齐(${isApple ? '⌘' : 'Ctrl'}+J)`
  alignmentDom.onclick = function () {

    editor.command.executeRowFlex(RowFlex.ALIGNMENT)
  }

  const justifyDom = q<HTMLDivElement>(
    '.menu-item__justify'
  )!
  justifyDom.title = `分散对齐(${isApple ? '⌘' : 'Ctrl'}+Shift+J)`
  justifyDom.onclick = function () {

    editor.command.executeRowFlex(RowFlex.JUSTIFY)
  }

  const rowMarginDom = q<HTMLDivElement>(
    '.menu-item__row-margin'
  )!
  const rowOptionDom = rowMarginDom.querySelector<HTMLDivElement>('.options')!
  rowMarginDom.onclick = function () {

    rowOptionDom.classList.toggle('visible')
  }
  rowOptionDom.onclick = function (evt) {
    const li = evt.target as HTMLLIElement
    editor.command.executeRowMargin(Number(li.dataset.rowmargin!))
  }

  const listDom = q<HTMLDivElement>('.menu-item__list')!
  listDom.title = `列表(${isApple ? '⌘' : 'Ctrl'}+Shift+U)`
  const listOptionDom = listDom.querySelector<HTMLDivElement>('.options')!
  listDom.onclick = function () {

    listOptionDom.classList.toggle('visible')
  }
  listOptionDom.onclick = function (evt) {
    const li = evt.target as HTMLLIElement
    const listType = <ListType>li.dataset.listType || null
    const listStyle = <ListStyle>(<unknown>li.dataset.listStyle)
    editor.command.executeList(listType, listStyle)
  }

  // 4. | 表格 | 图片 | 超链接 | 分割线 | 水印 | 代码块 | 分隔符 | 控件 | 复选框 | LaTeX | 日期选择器
  const tableDom = q<HTMLDivElement>('.menu-item__table')!
  const tablePanelContainer = q<HTMLDivElement>(
    '.menu-item__table__collapse'
  )!
  const tableClose = q<HTMLDivElement>('.table-close')!
  const tableTitle = q<HTMLDivElement>('.table-select')!
  const tablePanel = q<HTMLDivElement>('.table-panel')!
  // 绘制行列
  const tableCellList: HTMLDivElement[][] = []
  for (let i = 0; i < 10; i++) {
    const tr = document.createElement('tr')
    tr.classList.add('table-row')
    const trCellList: HTMLDivElement[] = []
    for (let j = 0; j < 10; j++) {
      const td = document.createElement('td')
      td.classList.add('table-cel')
      tr.append(td)
      trCellList.push(td)
    }
    tablePanel.append(tr)
    tableCellList.push(trCellList)
  }
  let colIndex = 0
  let rowIndex = 0
  // 移除所有格选择
  function removeAllTableCellSelect() {
    tableCellList.forEach(tr => {
      tr.forEach(td => td.classList.remove('active'))
    })
  }
  // 设置标题内容
  function setTableTitle(payload: string) {
    tableTitle.innerText = payload
  }
  // 恢复初始状态
  function recoveryTable() {
    // 还原选择样式、标题、选择行列
    removeAllTableCellSelect()
    setTableTitle('插入')
    colIndex = 0
    rowIndex = 0
    // 隐藏panel
    tablePanelContainer.style.display = 'none'
  }
  tableDom.onclick = function () {

    tablePanelContainer!.style.display = 'block'
  }
  tablePanel.onmousemove = function (evt) {
    const celSize = 16
    const rowMarginTop = 10
    const celMarginRight = 6
    const { offsetX, offsetY } = evt
    // 移除所有选择
    removeAllTableCellSelect()
    colIndex = Math.ceil(offsetX / (celSize + celMarginRight)) || 1
    rowIndex = Math.ceil(offsetY / (celSize + rowMarginTop)) || 1
    // 改变选择样式
    tableCellList.forEach((tr, trIndex) => {
      tr.forEach((td, tdIndex) => {
        if (tdIndex < colIndex && trIndex < rowIndex) {
          td.classList.add('active')
        }
      })
    })
    // 改变表格标题
    setTableTitle(`${rowIndex}×${colIndex}`)
  }
  tableClose.onclick = function () {
    recoveryTable()
  }
  tablePanel.onclick = function () {
    // 应用选择
    editor.command.executeInsertTable(rowIndex, colIndex)
    recoveryTable()
  }

  const imageDom = q<HTMLDivElement>('.menu-item__image')!
  const imageFileDom = q<HTMLInputElement>('.image-input')!
  imageDom.onclick = function () {
    imageFileDom.click()
  }
  imageFileDom.onchange = function () {
    const file = imageFileDom.files![0]!
    const fileReader = new FileReader()
    fileReader.readAsDataURL(file)
    fileReader.onload = function () {
      // 计算宽高
      const image = new Image()
      const value = fileReader.result as string
      image.src = value
      image.onload = function () {
        editor.command.executeImage({
          value,
          width: image.width,
          height: image.height
        })
        imageFileDom.value = ''
      }
    }
  }

  const hyperlinkDom = q<HTMLDivElement>(
    '.menu-item__hyperlink'
  )!
  hyperlinkDom.onclick = function () {

    new Dialog({
      title: '超链接',
      data: [
        {
          type: 'text',
          label: '文本',
          name: 'name',
          required: true,
          placeholder: '请输入文本',
          value: editor.command.getRangeText()
        },
        {
          type: 'text',
          label: '链接',
          name: 'url',
          required: true,
          placeholder: '请输入链接'
        }
      ],
      onConfirm: payload => {
        const name = payload.find(p => p.name === 'name')?.value
        if (!name) return
        const url = payload.find(p => p.name === 'url')?.value
        if (!url) return
        editor.command.executeHyperlink({
          url,
          valueList: splitText(name).map(n => ({
            value: n,
            size: 16
          }))
        })
      }
    })
  }

  const separatorDom = q<HTMLDivElement>(
    '.menu-item__separator'
  )!
  const separatorOptionDom =
    separatorDom.querySelector<HTMLDivElement>('.options')!
  separatorDom.onclick = function () {

    separatorOptionDom.classList.toggle('visible')
  }
  separatorOptionDom.onmousedown = function (evt) {
    let payload: number[] = []
    const li = evt.target as HTMLLIElement
    const separatorDash = li.dataset.separator?.split(',').map(Number)
    if (separatorDash) {
      const isSingleLine = separatorDash.every(d => d === 0)
      if (!isSingleLine) {
        payload = separatorDash
      }
    }
    editor.command.executeSeparator(payload)
  }

  const pageBreakDom = q<HTMLDivElement>(
    '.menu-item__page-break'
  )!
  pageBreakDom.onclick = function () {

    editor.command.executePageBreak()
  }

  const watermarkDom = q<HTMLDivElement>(
    '.menu-item__watermark'
  )!
  const watermarkOptionDom =
    watermarkDom.querySelector<HTMLDivElement>('.options')!
  watermarkDom.onclick = function () {

    watermarkOptionDom.classList.toggle('visible')
  }
  watermarkOptionDom.onmousedown = function (evt) {
    const li = evt.target as HTMLLIElement
    const menu = li.dataset.menu!
    watermarkOptionDom.classList.toggle('visible')
    if (menu === 'add') {
      new Dialog({
        title: '水印',
        data: [
          {
            type: 'text',
            label: '内容',
            name: 'data',
            required: true,
            placeholder: '请输入内容'
          },
          {
            type: 'color',
            label: '颜色',
            name: 'color',
            required: true,
            value: '#AEB5C0'
          },
          {
            type: 'number',
            label: '字体大小',
            name: 'size',
            required: true,
            value: '120'
          },
          {
            type: 'number',
            label: '透明度',
            name: 'opacity',
            required: true,
            value: '0.3'
          },
          {
            type: 'select',
            label: '重复',
            name: 'repeat',
            value: '0',
            required: false,
            options: [
              {
                label: '不重复',
                value: '0'
              },
              {
                label: '重复',
                value: '1'
              }
            ]
          },
          {
            type: 'number',
            label: '水平间隔',
            name: 'horizontalGap',
            required: false,
            value: '10'
          },
          {
            type: 'number',
            label: '垂直间隔',
            name: 'verticalGap',
            required: false,
            value: '10'
          }
        ],
        onConfirm: payload => {
          const nullableIndex = payload.findIndex(p => !p.value)
          if (~nullableIndex) return
          const watermark = payload.reduce(
            (pre, cur) => {
              pre[cur.name] = cur.value
              return pre
            },
            <any>{}
          )
          const repeat = watermark.repeat === '1'
          editor.command.executeAddWatermark({
            data: watermark.data,
            color: watermark.color,
            size: Number(watermark.size),
            opacity: Number(watermark.opacity),
            repeat,
            gap:
              repeat && watermark.horizontalGap && watermark.verticalGap
                ? [
                    Number(watermark.horizontalGap),
                    Number(watermark.verticalGap)
                  ]
                : undefined
          })
        }
      })
    } else {
      editor.command.executeDeleteWatermark()
    }
  }


  const controlDom = q<HTMLDivElement>(
    '.menu-item__control'
  )!
  const controlOptionDom = controlDom.querySelector<HTMLDivElement>('.options')!
  controlDom.onclick = function () {

    controlOptionDom.classList.toggle('visible')
  }
  controlOptionDom.onmousedown = function (evt) {
    controlOptionDom.classList.toggle('visible')
    const li = evt.target as HTMLLIElement
    const type = <ControlType>li.dataset.control
    switch (type) {
      case ControlType.TEXT:
        new Dialog({
          title: '文本控件',
          data: [
            {
              type: 'text',
              label: '占位符',
              name: 'placeholder',
              required: true,
              placeholder: '请输入占位符'
            },
            {
              type: 'text',
              label: '默认值',
              name: 'value',
              placeholder: '请输入默认值'
            }
          ],
          onConfirm: payload => {
            const placeholder = payload.find(
              p => p.name === 'placeholder'
            )?.value
            if (!placeholder) return
            const value = payload.find(p => p.name === 'value')?.value || ''
            editor.command.executeInsertControl({
              type: ElementType.CONTROL,
              value: '',
              control: {
                type,
                value: value
                  ? [
                      {
                        value
                      }
                    ]
                  : null,
                placeholder
              }
            })
          }
        })
        break
      case ControlType.SELECT:
        new Dialog({
          title: '列举控件',
          data: [
            {
              type: 'text',
              label: '占位符',
              name: 'placeholder',
              required: true,
              placeholder: '请输入占位符'
            },
            {
              type: 'text',
              label: '默认值',
              name: 'code',
              placeholder: '请输入默认值'
            },
            {
              type: 'textarea',
              label: '值集',
              name: 'valueSets',
              required: true,
              height: 100,
              placeholder: `请输入值集JSON，例：\n[{\n"value":"有",\n"code":"98175"\n}]`
            }
          ],
          onConfirm: payload => {
            const placeholder = payload.find(
              p => p.name === 'placeholder'
            )?.value
            if (!placeholder) return
            const valueSets = payload.find(p => p.name === 'valueSets')?.value
            if (!valueSets) return
            const code = payload.find(p => p.name === 'code')?.value
            editor.command.executeInsertControl({
              type: ElementType.CONTROL,
              value: '',
              control: {
                type,
                code,
                value: null,
                placeholder,
                valueSets: JSON.parse(valueSets)
              }
            })
          }
        })
        break
      case ControlType.CHECKBOX:
        new Dialog({
          title: '复选框控件',
          data: [
            {
              type: 'text',
              label: '默认值',
              name: 'code',
              placeholder: '请输入默认值，多个值以英文逗号分割'
            },
            {
              type: 'textarea',
              label: '值集',
              name: 'valueSets',
              required: true,
              height: 100,
              placeholder: `请输入值集JSON，例：\n[{\n"value":"有",\n"code":"98175"\n}]`
            }
          ],
          onConfirm: payload => {
            const valueSets = payload.find(p => p.name === 'valueSets')?.value
            if (!valueSets) return
            const code = payload.find(p => p.name === 'code')?.value
            editor.command.executeInsertControl({
              type: ElementType.CONTROL,
              value: '',
              control: {
                type,
                code,
                value: null,
                valueSets: JSON.parse(valueSets)
              }
            })
          }
        })
        break
      case ControlType.RADIO:
        new Dialog({
          title: '单选框控件',
          data: [
            {
              type: 'text',
              label: '默认值',
              name: 'code',
              placeholder: '请输入默认值'
            },
            {
              type: 'textarea',
              label: '值集',
              name: 'valueSets',
              required: true,
              height: 100,
              placeholder: `请输入值集JSON，例：\n[{\n"value":"有",\n"code":"98175"\n}]`
            }
          ],
          onConfirm: payload => {
            const valueSets = payload.find(p => p.name === 'valueSets')?.value
            if (!valueSets) return
            const code = payload.find(p => p.name === 'code')?.value
            editor.command.executeInsertControl({
              type: ElementType.CONTROL,
              value: '',
              control: {
                type,
                code,
                value: null,
                valueSets: JSON.parse(valueSets)
              }
            })
          }
        })
        break
      case ControlType.DATE:
        new Dialog({
          title: '日期控件',
          data: [
            {
              type: 'text',
              label: '占位符',
              name: 'placeholder',
              required: true,
              placeholder: '请输入占位符'
            },
            {
              type: 'text',
              label: '默认值',
              name: 'value',
              placeholder: '请输入默认值'
            },
            {
              type: 'select',
              label: '日期格式',
              name: 'dateFormat',
              value: 'yyyy-MM-dd hh:mm:ss',
              required: true,
              options: [
                {
                  label: 'yyyy-MM-dd hh:mm:ss',
                  value: 'yyyy-MM-dd hh:mm:ss'
                },
                {
                  label: 'yyyy-MM-dd',
                  value: 'yyyy-MM-dd'
                }
              ]
            }
          ],
          onConfirm: payload => {
            const placeholder = payload.find(
              p => p.name === 'placeholder'
            )?.value
            if (!placeholder) return
            const value = payload.find(p => p.name === 'value')?.value || ''
            const dateFormat =
              payload.find(p => p.name === 'dateFormat')?.value || ''
            editor.command.executeInsertControl({
              type: ElementType.CONTROL,
              value: '',
              control: {
                type,
                dateFormat,
                value: value
                  ? [
                      {
                        value
                      }
                    ]
                  : null,
                placeholder
              }
            })
          }
        })
        break
      case ControlType.NUMBER:
        new Dialog({
          title: '数值控件',
          data: [
            {
              type: 'text',
              label: '占位符',
              name: 'placeholder',
              required: true,
              placeholder: '请输入占位符'
            },
            {
              type: 'text',
              label: '默认值',
              name: 'value',
              placeholder: '请输入默认值'
            }
          ],
          onConfirm: payload => {
            const placeholder = payload.find(
              p => p.name === 'placeholder'
            )?.value
            if (!placeholder) return
            const value = payload.find(p => p.name === 'value')?.value || ''
            editor.command.executeInsertControl({
              type: ElementType.CONTROL,
              value: '',
              control: {
                type,
                value: value
                  ? [
                      {
                        value
                      }
                    ]
                  : null,
                placeholder
              }
            })
          }
        })
        break
      default:
        break
    }
  }

  const checkboxDom = q<HTMLDivElement>(
    '.menu-item__checkbox'
  )!
  checkboxDom.onclick = function () {

    editor.command.executeInsertElementList([
      {
        type: ElementType.CHECKBOX,
        checkbox: {
          value: false
        },
        value: ''
      }
    ])
  }

  const radioDom = q<HTMLDivElement>('.menu-item__radio')!
  radioDom.onclick = function () {

    editor.command.executeInsertElementList([
      {
        type: ElementType.RADIO,
        checkbox: {
          value: false
        },
        value: ''
      }
    ])
  }

  const latexDom = q<HTMLDivElement>('.menu-item__latex')!
  latexDom.onclick = function () {

    new Dialog({
      title: 'LaTeX',
      data: [
        {
          type: 'textarea',
          height: 100,
          name: 'value',
          placeholder: '请输入LaTeX文本'
        }
      ],
      onConfirm: payload => {
        const value = payload.find(p => p.name === 'value')?.value
        if (!value) return
        editor.command.executeInsertElementList([
          {
            type: ElementType.LATEX,
            value
          }
        ])
      }
    })
  }

  const dateDom = q<HTMLDivElement>('.menu-item__date')!
  const dateDomOptionDom = dateDom.querySelector<HTMLDivElement>('.options')!
  dateDom.onclick = function () {

    dateDomOptionDom.classList.toggle('visible')
    // 定位调整
    const bodyRect = document.body.getBoundingClientRect()
    const dateDomOptionRect = dateDomOptionDom.getBoundingClientRect()
    if (dateDomOptionRect.left + dateDomOptionRect.width > bodyRect.width) {
      dateDomOptionDom.style.right = '0px'
      dateDomOptionDom.style.left = 'unset'
    } else {
      dateDomOptionDom.style.right = 'unset'
      dateDomOptionDom.style.left = '0px'
    }
    // 当前日期
    const date = new Date()
    const year = date.getFullYear().toString()
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const day = date.getDate().toString().padStart(2, '0')
    const hour = date.getHours().toString().padStart(2, '0')
    const minute = date.getMinutes().toString().padStart(2, '0')
    const second = date.getSeconds().toString().padStart(2, '0')
    const dateString = `${year}-${month}-${day}`
    const dateTimeString = `${dateString} ${hour}:${minute}:${second}`
    dateDomOptionDom.querySelector<HTMLLIElement>('li:first-child')!.innerText =
      dateString
    dateDomOptionDom.querySelector<HTMLLIElement>('li:last-child')!.innerText =
      dateTimeString
  }
  dateDomOptionDom.onmousedown = function (evt) {
    const li = evt.target as HTMLLIElement
    const dateFormat = li.dataset.format!
    dateDomOptionDom.classList.toggle('visible')
    editor.command.executeInsertElementList([
      {
        type: ElementType.DATE,
        value: '',
        dateFormat,
        valueList: [
          {
            value: li.innerText.trim()
          }
        ]
      }
    ])
  }

  const blockDom = q<HTMLDivElement>('.menu-item__block')!
  blockDom.onclick = function () {

    new Dialog({
      title: '内容块',
      data: [
        {
          type: 'select',
          label: '类型',
          name: 'type',
          value: 'iframe',
          required: true,
          options: [
            {
              label: '网址',
              value: 'iframe'
            },
            {
              label: '视频',
              value: 'video'
            }
          ]
        },
        {
          type: 'number',
          label: '宽度',
          name: 'width',
          placeholder: '请输入宽度（默认页面内宽度）'
        },
        {
          type: 'number',
          label: '高度',
          name: 'height',
          required: true,
          placeholder: '请输入高度'
        },
        {
          type: 'input',
          label: '地址',
          name: 'src',
          required: false,
          placeholder: '请输入地址'
        },
        {
          type: 'textarea',
          label: 'HTML',
          height: 100,
          name: 'srcdoc',
          required: false,
          placeholder: '请输入HTML代码（仅网址类型有效）'
        }
      ],
      onConfirm: payload => {
        const type = payload.find(p => p.name === 'type')?.value
        if (!type) return
        const width = payload.find(p => p.name === 'width')?.value
        const height = payload.find(p => p.name === 'height')?.value
        if (!height) return
        // 地址或HTML代码至少存在一项
        const src = payload.find(p => p.name === 'src')?.value
        const srcdoc = payload.find(p => p.name === 'srcdoc')?.value
        const block: IBlock = {
          type: <BlockType>type
        }
        if (block.type === BlockType.IFRAME) {
          if (!src && !srcdoc) return
          block.iframeBlock = {
            src,
            srcdoc
          }
        } else if (block.type === BlockType.VIDEO) {
          if (!src) return
          block.videoBlock = {
            src
          }
        }
        const blockElement: IElement = {
          type: ElementType.BLOCK,
          value: '',
          height: Number(height),
          block
        }
        if (width) {
          blockElement.width = Number(width)
        }
        editor.command.executeInsertElementList([blockElement])
      }
    })
  }

  // 5. | 搜索&替换 | 打印 |
  const searchCollapseDom = q<HTMLDivElement>(
    '.menu-item__search__collapse'
  )!
  const searchInputDom = q<HTMLInputElement>(
    '.menu-item__search__collapse__search input'
  )!
  const replaceInputDom = q<HTMLInputElement>(
    '.menu-item__search__collapse__replace input'
  )!
  const searchRegInputDom =
    q<HTMLInputElement>('.option-reg')!
  const searchCaseInputDom =
    q<HTMLInputElement>('.option-case')!
  const searchSelectionInputDom =
    q<HTMLInputElement>('.option-selection')!
  const searchDom =
    q<HTMLDivElement>('.menu-item__search')!
  searchDom.title = `搜索与替换(${isApple ? '⌘' : 'Ctrl'}+F)`
  const searchResultDom =
    searchCollapseDom.querySelector<HTMLLabelElement>('.search-result')!
  function setSearchResult() {
    const result = editor.command.getSearchNavigateInfo()
    if (result) {
      const { index, count } = result
      searchResultDom.innerText = `${index}/${count}`
    } else {
      searchResultDom.innerText = ''
    }
  }
  searchDom.onclick = function () {

    searchCollapseDom.style.display = 'block'
    const bodyRect = document.body.getBoundingClientRect()
    const searchRect = searchDom.getBoundingClientRect()
    const searchCollapseRect = searchCollapseDom.getBoundingClientRect()
    if (searchRect.left + searchCollapseRect.width > bodyRect.width) {
      searchCollapseDom.style.right = '0px'
      searchCollapseDom.style.left = 'unset'
    } else {
      searchCollapseDom.style.right = 'unset'
    }
    searchInputDom.focus()
  }
  searchCollapseDom.querySelector<HTMLSpanElement>('span')!.onclick =
    function () {
      searchCollapseDom.style.display = 'none'
      searchInputDom.value = ''
      replaceInputDom.value = ''
      editor.command.executeSearch(null)
      setSearchResult()
    }

  function emitSearch() {
    editor.command.executeSearch(searchInputDom.value || null, {
      isRegEnable: searchRegInputDom.checked,
      isIgnoreCase: searchCaseInputDom.checked,
      isLimitSelection: searchSelectionInputDom.checked
    })
    setSearchResult()
  }

  searchInputDom.oninput = emitSearch
  searchRegInputDom.onchange = emitSearch
  searchCaseInputDom.onchange = emitSearch
  searchSelectionInputDom.onchange = emitSearch
  searchInputDom.onkeydown = function (evt) {
    if (evt.key === 'Enter') {
      emitSearch()
    }
  }
  searchCollapseDom.querySelector<HTMLButtonElement>('button')!.onclick =
    function () {
      const searchValue = searchInputDom.value
      const replaceValue = replaceInputDom.value
      if (searchValue && searchValue !== replaceValue) {
        editor.command.executeReplace(replaceValue)
      }
    }
  searchCollapseDom.querySelector<HTMLDivElement>('.arrow-left')!.onclick =
    function () {
      editor.command.executeSearchNavigatePre()
      setSearchResult()
    }
  searchCollapseDom.querySelector<HTMLDivElement>('.arrow-right')!.onclick =
    function () {
      editor.command.executeSearchNavigateNext()
      setSearchResult()
    }

  const printDom = q<HTMLDivElement>('.menu-item__print')!
  printDom.title = `打印(${isApple ? '⌘' : 'Ctrl'}+P)`
  printDom.onclick = function () {

    editor.command.executePrint()
  }

  // 6. 目录显隐 | 页面模式 | 纸张缩放 | 纸张大小 | 纸张方向 | 页边距 | 全屏 | 设置
  const editorOptionDom =
    q<HTMLDivElement>('.editor-option')!
  editorOptionDom.onclick = function () {
    const options = editor.command.getOptions()
    new Dialog({
      title: '编辑器配置',
      data: [
        {
          type: 'textarea',
          name: 'option',
          width: 350,
          height: 300,
          required: true,
          value: JSON.stringify(options, null, 2),
          placeholder: '请输入编辑器配置'
        }
      ],
      onConfirm: payload => {
        const newOptionValue = payload.find(p => p.name === 'option')?.value
        if (!newOptionValue) return
        const newOption = JSON.parse(newOptionValue)
        editor.command.executeUpdateOptions(newOption)
      }
    })
  }

  async function updateCatalog() {
    const catalog = await editor.command.getCatalog()
    const catalogMainDom =
      q<HTMLDivElement>('.catalog__main')!
    catalogMainDom.innerHTML = ''
    if (catalog) {
      const appendCatalog = (
        parent: HTMLDivElement,
        catalogItems: ICatalogItem[]
      ) => {
        for (let c = 0; c < catalogItems.length; c++) {
          const catalogItem = catalogItems[c]
          const catalogItemDom = document.createElement('div')
          catalogItemDom.classList.add('catalog-item')
          // 渲染
          const catalogItemContentDom = document.createElement('div')
          catalogItemContentDom.classList.add('catalog-item__content')
          const catalogItemContentSpanDom = document.createElement('span')
          catalogItemContentSpanDom.innerText = catalogItem.name
          catalogItemContentDom.append(catalogItemContentSpanDom)
          // 定位
          catalogItemContentDom.onclick = () => {
            editor.command.executeLocationCatalog(catalogItem.id)
          }
          catalogItemDom.append(catalogItemContentDom)
          if (catalogItem.subCatalog && catalogItem.subCatalog.length) {
            appendCatalog(catalogItemDom, catalogItem.subCatalog)
          }
          // 追加
          parent.append(catalogItemDom)
        }
      }
      appendCatalog(catalogMainDom, catalog)
    }
  }
  let isCatalogShow = true
  const catalogDom = q<HTMLElement>('.catalog')!
  const catalogModeDom =
    q<HTMLDivElement>('.catalog-mode')!
  const catalogHeaderCloseDom = q<HTMLDivElement>(
    '.catalog__header__close'
  )!
  const switchCatalog = () => {
    isCatalogShow = !isCatalogShow
    if (isCatalogShow) {
      catalogDom.style.display = 'block'
      updateCatalog()
    } else {
      catalogDom.style.display = 'none'
    }
  }
  catalogModeDom.onclick = switchCatalog
  catalogHeaderCloseDom.onclick = switchCatalog

  const pageModeDom = q<HTMLDivElement>('.page-mode')!
  const pageModeOptionsDom =
    pageModeDom.querySelector<HTMLDivElement>('.options')!
  pageModeDom.onclick = function () {
    pageModeOptionsDom.classList.toggle('visible')
  }
  pageModeOptionsDom.onclick = function (evt) {
    const li = evt.target as HTMLLIElement
    editor.command.executePageMode(<PageMode>li.dataset.pageMode!)
  }

  q<HTMLDivElement>('.page-scale-percentage')!.onclick =
    function () {

      editor.command.executePageScaleRecovery()
    }

  q<HTMLDivElement>('.page-scale-minus')!.onclick =
    function () {

      editor.command.executePageScaleMinus()
    }

  q<HTMLDivElement>('.page-scale-add')!.onclick =
    function () {

      editor.command.executePageScaleAdd()
    }

  // 纸张大小
  const paperSizeDom = q<HTMLDivElement>('.paper-size')!
  const paperSizeDomOptionsDom =
    paperSizeDom.querySelector<HTMLDivElement>('.options')!
  paperSizeDom.onclick = function () {
    paperSizeDomOptionsDom.classList.toggle('visible')
  }
  paperSizeDomOptionsDom.onclick = function (evt) {
    const li = evt.target as HTMLLIElement
    const paperType = li.dataset.paperSize!
    const [width, height] = paperType.split('*').map(Number)
    editor.command.executePaperSize(width, height)
    // 纸张状态回显
    paperSizeDomOptionsDom
      .querySelectorAll('li')
      .forEach(child => child.classList.remove('active'))
    li.classList.add('active')
  }

  // 纸张方向
  const paperDirectionDom =
    q<HTMLDivElement>('.paper-direction')!
  const paperDirectionDomOptionsDom =
    paperDirectionDom.querySelector<HTMLDivElement>('.options')!
  paperDirectionDom.onclick = function () {
    paperDirectionDomOptionsDom.classList.toggle('visible')
  }
  paperDirectionDomOptionsDom.onclick = function (evt) {
    const li = evt.target as HTMLLIElement
    if (li.tagName !== 'LI' || li.classList.contains('option-caption')) return
    const { paperDirection, sectionDirection } = li.dataset
    if (sectionDirection) {
      // 指定页面方向（本节）
      editor.command.executePageDirection(
        sectionDirection === 'inherit' ? null : <PaperDirection>sectionDirection
      )
    } else if (paperDirection) {
      editor.command.executePaperDirection(<PaperDirection>paperDirection)
    }
    // 纸张方向状态回显
    paperDirectionDomOptionsDom
      .querySelectorAll('li')
      .forEach(child => child.classList.remove('active'))
    li.classList.add('active')
  }

  // 页面边距
  const paperMarginDom =
    q<HTMLDivElement>('.paper-margin')!
  paperMarginDom.onclick = function () {
    const [topMargin, rightMargin, bottomMargin, leftMargin] =
      editor.command.getPaperMargin()
    new Dialog({
      title: '页边距',
      data: [
        {
          type: 'text',
          label: '上边距',
          name: 'top',
          required: true,
          value: `${topMargin}`,
          placeholder: '请输入上边距'
        },
        {
          type: 'text',
          label: '下边距',
          name: 'bottom',
          required: true,
          value: `${bottomMargin}`,
          placeholder: '请输入下边距'
        },
        {
          type: 'text',
          label: '左边距',
          name: 'left',
          required: true,
          value: `${leftMargin}`,
          placeholder: '请输入左边距'
        },
        {
          type: 'text',
          label: '右边距',
          name: 'right',
          required: true,
          value: `${rightMargin}`,
          placeholder: '请输入右边距'
        }
      ],
      onConfirm: payload => {
        const top = payload.find(p => p.name === 'top')?.value
        if (!top) return
        const bottom = payload.find(p => p.name === 'bottom')?.value
        if (!bottom) return
        const left = payload.find(p => p.name === 'left')?.value
        if (!left) return
        const right = payload.find(p => p.name === 'right')?.value
        if (!right) return
        editor.command.executeSetPaperMargin([
          Number(top),
          Number(right),
          Number(bottom),
          Number(left)
        ])
      }
    })
  }

  // 分栏配置
  const columnConfigDom =
    q<HTMLDivElement>('.column-config')!
  columnConfigDom.onclick = function () {
    const current = editor.command.getColumns()
    const count = current?.count ?? 1
    const gap = current?.gap ?? 20
    const separator = current?.separator ? 'true' : 'false'
    new Dialog({
      title: '分栏',
      data: [
        {
          type: 'select',
          label: '栏数',
          name: 'count',
          required: true,
          value: `${count}`,
          options: [
            { value: '1', label: '1（关闭）' },
            { value: '2', label: '2' },
            { value: '3', label: '3' },
            { value: '4', label: '4' },
            { value: '5', label: '5' }
          ]
        },
        {
          type: 'text',
          label: '栏间距',
          name: 'gap',
          required: true,
          value: `${gap}`,
          placeholder: '请输入栏间距（像素）'
        },
        {
          type: 'select',
          label: '分隔线',
          name: 'separator',
          required: true,
          value: separator,
          options: [
            { value: 'false', label: '不显示' },
            { value: 'true', label: '显示' }
          ]
        }
      ],
      onConfirm: payload => {
        const countValue = payload.find(p => p.name === 'count')?.value
        if (!countValue) return
        const gapValue = payload.find(p => p.name === 'gap')?.value
        if (!gapValue) return
        const separatorValue = payload.find(p => p.name === 'separator')?.value
        if (!separatorValue) return
        editor.command.executeSetColumns({
          count: Number(countValue),
          gap: Number(gapValue),
          separator: separatorValue === 'true'
        })
      }
    })
  }

  // 标尺开关
  const rulerToggleDom =
    q<HTMLDivElement>('.ruler-toggle')!
  rulerToggleDom.onclick = function () {
    editor.command.executeToggleRuler()
  }

  // 编辑模式：官方 demo 的第 7 组。批注连接线绘制依赖整套批注系统，没搬；
  // 模式切换本身是自包含的，涂鸦就在这个下拉里（EditorMode.GRAFFITI）。
  const modeList: { mode: EditorMode; name: string }[] = [
    { mode: EditorMode.EDIT, name: '编辑模式' },
    { mode: EditorMode.CLEAN, name: '清洁模式' },
    { mode: EditorMode.READONLY, name: '只读模式' },
    { mode: EditorMode.FORM, name: '表单模式' },
    { mode: EditorMode.PRINT, name: '打印模式' },
    { mode: EditorMode.DESIGN, name: '设计模式' },
    { mode: EditorMode.GRAFFITI, name: '涂鸦模式' },
    { mode: EditorMode.TRACE, name: '留痕模式' }
  ]
  const modeElement = q<HTMLDivElement>('.editor-mode')
  if (modeElement) {
    const modeOptionsElement =
      modeElement.querySelector<HTMLUListElement>('.options')!
    const modeTextElement =
      modeElement.querySelector<HTMLSpanElement>('.text')!
    const modeTextMap = modeList.reduce<Record<string, string>>((acc, item) => {
      acc[item.mode] = item.name
      return acc
    }, {})
    modeOptionsElement.onmousedown = function (evt) {
      const li = evt.target as HTMLLIElement
      const mode = <EditorMode | undefined>li.dataset.mode
      if (!mode) return
      qa<HTMLLIElement>('.editor-mode .options li').forEach(child =>
        child.classList.remove('active')
      )
      li.classList.add('active')
      editor.command.executeMode(mode)
      modeTextElement.textContent = modeTextMap[mode] || '编辑模式'
    }
    // 留痕开关：勾选后新增/删除记为留痕
    const traceToggleInput =
      modeElement.querySelector<HTMLInputElement>('.trace-toggle__input')
    traceToggleInput?.addEventListener('change', () => {
      editor.command.executeToggleTrace()
    })
  }

  // 导出：官方 demo 没有这一项，按同样的下拉样式补在「打印」右边。
  // Markdown 是我们自己从元素树转出来的（见 markdown/export-markdown.ts），
  // 读写走主进程对话框（toolbar/io.ts）；JSON = getValue() 落地成文件；PDF =
  // 交给 canvas-editor 的打印（系统打印对话框里选「另存为 PDF」）。
  const exportDom = q<HTMLDivElement>('.menu-item__export')
  if (exportDom) {
    const exportOptionsDom =
      exportDom.querySelector<HTMLDivElement>('.options')!
    exportDom.onclick = function () {
      exportOptionsDom.classList.toggle('visible')
    }
    // 插件动作都是异步的（要过主进程对话框），失败只记日志：不打断编辑。
    const reportFailure = (error: unknown): void => {
      console.error('canvas plugin action failed:', error)
    }
    exportOptionsDom.onmousedown = function (evt) {
      exportOptionsDom.classList.toggle('visible')
      const li = evt.target as HTMLLIElement
      const type = li.dataset.export
      // 已停用：导入 Markdown（用户要求撤下）。菜单项见 menu-html.ts。
      // if (type === 'import-md') {
      //   void importMarkdownIntoNewTab().catch(reportFailure)
      //   return
      // }
      if (type === 'import-json') {
        void importJsonIntoNewTab().catch(reportFailure)
        return
      }
      if (type === 'export-md') {
        void exportMarkdownToDisk(editor).catch(reportFailure)
        return
      }
      if (type === 'json') {
        const value = editor.command.getValue()
        const blob = new Blob([JSON.stringify(value, null, 2)], {
          type: 'application/json'
        })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = 'canvas-editor.json'
        link.click()
        URL.revokeObjectURL(url)
        return
      }
      if (type === 'pdf') {
        void editor.command.executePrint()
      }
    }
  }

  // 8. 内部事件监听：按钮选中态 / 页码 / 字数 / 行列（官方第 8 组，批注部分已剔除）
  const nextTick = (fn: () => void): void => {
    void Promise.resolve().then(fn)
  }
  // 8. 内部事件监听
  editor.listener.rangeStyleChange = function (payload) {
    // 控件类型
    payload.type === ElementType.SUBSCRIPT
      ? subscriptDom.classList.add('active')
      : subscriptDom.classList.remove('active')
    payload.type === ElementType.SUPERSCRIPT
      ? superscriptDom.classList.add('active')
      : superscriptDom.classList.remove('active')
    payload.type === ElementType.SEPARATOR
      ? separatorDom.classList.add('active')
      : separatorDom.classList.remove('active')
    separatorOptionDom
      .querySelectorAll('li')
      .forEach(li => li.classList.remove('active'))
    if (payload.type === ElementType.SEPARATOR) {
      const separator = payload.dashArray.join(',') || '0,0'
      const curSeparatorDom = separatorOptionDom.querySelector<HTMLLIElement>(
        `[data-separator='${separator}']`
      )!
      if (curSeparatorDom) {
        curSeparatorDom.classList.add('active')
      }
    }

    // 富文本
    fontOptionDom
      .querySelectorAll<HTMLLIElement>('li')
      .forEach(li => li.classList.remove('active'))
    const curFontDom = fontOptionDom.querySelector<HTMLLIElement>(
      `[data-family='${payload.font}']`
    )
    if (curFontDom) {
      fontSelectDom.innerText = curFontDom.innerText
      fontSelectDom.style.fontFamily = payload.font
      curFontDom.classList.add('active')
    }
    sizeOptionDom
      .querySelectorAll<HTMLLIElement>('li')
      .forEach(li => li.classList.remove('active'))
    const curSizeDom = sizeOptionDom.querySelector<HTMLLIElement>(
      `[data-size='${payload.size}']`
    )
    if (curSizeDom) {
      sizeSelectDom.innerText = curSizeDom.innerText
      curSizeDom.classList.add('active')
    } else {
      sizeSelectDom.innerText = `${payload.size}`
    }
    payload.bold
      ? boldDom.classList.add('active')
      : boldDom.classList.remove('active')
    payload.italic
      ? italicDom.classList.add('active')
      : italicDom.classList.remove('active')
    payload.underline
      ? underlineDom.classList.add('active')
      : underlineDom.classList.remove('active')
    payload.strikeout
      ? strikeoutDom.classList.add('active')
      : strikeoutDom.classList.remove('active')
    if (payload.color) {
      colorDom.classList.add('active')
      colorControlDom.value = payload.color
      colorSpanDom.style.backgroundColor = payload.color
    } else {
      colorDom.classList.remove('active')
      colorControlDom.value = '#000000'
      colorSpanDom.style.backgroundColor = '#000000'
    }
    if (payload.highlight) {
      highlightDom.classList.add('active')
      highlightControlDom.value = payload.highlight
      highlightSpanDom.style.backgroundColor = payload.highlight
    } else {
      highlightDom.classList.remove('active')
      highlightControlDom.value = '#ffff00'
      highlightSpanDom.style.backgroundColor = '#ffff00'
    }

    // 行布局
    leftDom.classList.remove('active')
    centerDom.classList.remove('active')
    rightDom.classList.remove('active')
    alignmentDom.classList.remove('active')
    justifyDom.classList.remove('active')
    if (payload.rowFlex && payload.rowFlex === 'right') {
      rightDom.classList.add('active')
    } else if (payload.rowFlex && payload.rowFlex === 'center') {
      centerDom.classList.add('active')
    } else if (payload.rowFlex && payload.rowFlex === 'alignment') {
      alignmentDom.classList.add('active')
    } else if (payload.rowFlex && payload.rowFlex === 'justify') {
      justifyDom.classList.add('active')
    } else {
      leftDom.classList.add('active')
    }

    // 行间距
    rowOptionDom
      .querySelectorAll<HTMLLIElement>('li')
      .forEach(li => li.classList.remove('active'))
    const curRowMarginDom = rowOptionDom.querySelector<HTMLLIElement>(
      `[data-rowmargin='${payload.rowMargin}']`
    )!
    curRowMarginDom.classList.add('active')

    // 功能
    payload.undo
      ? undoDom.classList.remove('no-allow')
      : undoDom.classList.add('no-allow')
    payload.redo
      ? redoDom.classList.remove('no-allow')
      : redoDom.classList.add('no-allow')
    payload.painter
      ? painterDom.classList.add('active')
      : painterDom.classList.remove('active')

    // 标题
    titleOptionDom
      .querySelectorAll<HTMLLIElement>('li')
      .forEach(li => li.classList.remove('active'))
    if (payload.level) {
      const curTitleDom = titleOptionDom.querySelector<HTMLLIElement>(
        `[data-level='${payload.level}']`
      )!
      titleSelectDom.innerText = curTitleDom.innerText
      curTitleDom.classList.add('active')
    } else {
      titleSelectDom.innerText = '正文'
      titleOptionDom.querySelector('li:first-child')!.classList.add('active')
    }

    // 列表
    listOptionDom
      .querySelectorAll<HTMLLIElement>('li')
      .forEach(li => li.classList.remove('active'))
    if (payload.listType) {
      listDom.classList.add('active')
      const listType = payload.listType
      const listStyle =
        payload.listType === ListType.OL ? ListStyle.DECIMAL : payload.listType
      const curListDom = listOptionDom.querySelector<HTMLLIElement>(
        `[data-list-type='${listType}'][data-list-style='${listStyle}']`
      )
      if (curListDom) {
        curListDom.classList.add('active')
      }
    } else {
      listDom.classList.remove('active')
    }

    // 行列信息
    const rangeContext = editor.command.getRangeContext()
    if (rangeContext) {
      q<HTMLSpanElement>('.row-no')!.innerText = `${
        rangeContext.startRowNo + 1
      }`
      q<HTMLSpanElement>('.col-no')!.innerText = `${
        rangeContext.startColNo + 1
      }`
    }
  }

  editor.listener.visiblePageNoListChange = function (payload) {
    const text = payload.map(i => i + 1).join('、')
    q<HTMLSpanElement>('.page-no-list')!.innerText = text
  }

  editor.listener.pageSizeChange = function (payload) {
    q<HTMLSpanElement>('.page-size')!.innerText =
      `${payload}`
  }

  editor.listener.intersectionPageNoChange = function (payload) {
    q<HTMLSpanElement>('.page-no')!.innerText = `${
      payload + 1
    }`
  }

  editor.listener.pageScaleChange = function (payload) {
    q<HTMLSpanElement>(
      '.page-scale-percentage'
    )!.innerText = `${Math.floor(payload * 10 * 10)}%`
  }

  editor.listener.controlChange = function (payload) {
    const disableMenusInControlContext = [
      'table',
      'hyperlink',
      'separator',
      'page-break',
      'control'
    ]
    // 菜单操作权限
    disableMenusInControlContext.forEach(menu => {
      const menuDom = q<HTMLDivElement>(
        `.menu-item__${menu}`
      )!
      payload.state === ControlState.ACTIVE
        ? menuDom.classList.add('disable')
        : menuDom.classList.remove('disable')
    })
  }

  editor.listener.pageModeChange = function (payload) {
    const activeMode = pageModeOptionsDom.querySelector<HTMLLIElement>(
      `[data-page-mode='${payload}']`
    )!
    pageModeOptionsDom
      .querySelectorAll('li')
      .forEach(li => li.classList.remove('active'))
    activeMode.classList.add('active')
  }

  const handleContentChange = async function () {
    // 字数
    const wordCount = await editor.command.getWordCount()
    q<HTMLSpanElement>('.word-count')!.innerText = `${
      wordCount || 0
    }`
    // 目录
    if (isCatalogShow) {
      nextTick(() => {
        updateCatalog()
      })
    }
  }
  // 官方的 debounce 来自 demo 的 utils；这里就地实现：200ms 内只统计一次
  let contentChangeTimer = 0
  editor.listener.contentChange = function () {
    window.clearTimeout(contentChangeTimer)
    contentChangeTimer = window.setTimeout(() => {
      void handleContentChange()
    }, 200)
  }
  handleContentChange()


  // 插入：官方插件的特殊字符面板（原 Word 工具的位置，Word 工具需要后端
  // 服务，没接）。下拉里目前只有这一项，将来要加别的往 ul 里补 li 即可。
  const insertDom = q<HTMLDivElement>('.menu-item__insert')
  if (insertDom) {
    const insertOptionsDom = insertDom.querySelector<HTMLDivElement>('.options')!
    insertDom.onclick = function () {
      insertOptionsDom.classList.toggle('visible')
    }
    insertOptionsDom.onmousedown = function (evt) {
      insertOptionsDom.classList.remove('visible')
      const li = evt.target as HTMLLIElement
      if (li.dataset.insert === 'special-characters') {
        openSpecialCharacters(editor)
      }
    }
  }

  return () => {
    document.removeEventListener('click', onDocumentClick, { capture: true })
  }
}
