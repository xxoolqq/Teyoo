// 表格插入选择器（工具栏「表格」按钮）
//
// 取代原来的模态框：悬停时按行列区块逐格高亮，单击即插入对应 rows×cols 的
// GFM 表格。网格 6 列 × 6 行；网格下方带一条细分隔线 + 「行 × 列」尺寸标注
// （数字各自套小边框方块，跟随悬停实时更新，参考用户截图样式）。
//
// 定位：position:fixed，锚定触发按钮的 getBoundingClientRect，渲染到 body 层
// 避免被工具栏/祖先的 overflow 裁剪，并做视口边界 clamp（见经验 100001967）。

import { insertTable, getEditorView } from './editor'

// 网格规模
const COLS = 6
const ROWS = 6

export class TablePicker {
  private card: HTMLDivElement
  private readonly cells: HTMLButtonElement[] = []
  // 尺寸标注的两个数字（悬停时更新为 行数 × 列数）
  private readonly rowNum: HTMLSpanElement
  private readonly colNum: HTMLSpanElement
  // 触发这次弹出层的按钮；外部点击判断与重定位都靠它
  private anchor: HTMLElement | null = null

  constructor() {
    this.card = document.createElement('div')
    this.card.className = 'table-picker'
    this.card.hidden = true
    this.card.setAttribute('role', 'dialog')

    const grid = document.createElement('div')
    grid.className = 'table-picker-grid'

    for (let r = 1; r <= ROWS; r++) {
      for (let c = 1; c <= COLS; c++) {
        const cell = document.createElement('button')
        cell.type = 'button'
        cell.className = 'table-picker-cell'
        cell.tabIndex = -1
        cell.dataset.row = String(r)
        cell.dataset.col = String(c)
        grid.appendChild(cell)
        this.cells.push(cell)
      }
    }
    this.card.appendChild(grid)

    // 尺寸标注：行 × 列（数字各套一个小边框方块）
    this.rowNum = document.createElement('span')
    this.rowNum.className = 'table-picker-num'
    this.colNum = document.createElement('span')
    this.colNum.className = 'table-picker-num'
    const times = document.createElement('span')
    times.className = 'table-picker-x'
    times.textContent = '×'
    const size = document.createElement('div')
    size.className = 'table-picker-size'
    size.append(this.rowNum, times, this.colNum)
    this.card.appendChild(size)

    // 悬停：按行列区块逐格高亮
    grid.addEventListener('mousemove', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.table-picker-cell')
      if (!cell) return
      this.highlight(Number(cell.dataset.row), Number(cell.dataset.col))
    })
    // 移出网格：清空高亮
    grid.addEventListener('mouseleave', () => this.highlight(0, 0))

    // 单击即插入（行列数取单元格上的 data-row / data-col）
    grid.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.table-picker-cell')
      if (!cell) return
      this.hide()
      // 工具栏按钮是文档外的元素，点它会让编辑器失焦；空文档（从未点进正文）
      // 更是从来没有焦点。先把焦点还给编辑器，否则 insertTable 的 hasFocus
      // 闸门会直接吞掉这次插入（表现为「空文档插不进表格」）。
      getEditorView()?.focus()
      insertTable(Number(cell.dataset.row), Number(cell.dataset.col))
    })

    // 点击弹层不让编辑器失焦（保住选区，insertTable 的 hasFocus 闸门才过）
    this.card.addEventListener('mousedown', (e) => e.preventDefault())

    // 外部点击关闭：弹层内、触发按钮自身都豁免——按钮豁免是为了允许「再点一次收起」
    document.addEventListener('mousedown', (e) => {
      if (this.card.hidden) return
      const t = e.target as Node
      if (this.card.contains(t)) return
      if (this.anchor?.contains(t)) return
      this.hide()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.card.hidden) this.hide()
    })
    // 窗口尺寸变化会让 fixed 坐标失效，直接关闭
    window.addEventListener('resize', () => this.hide())

    document.body.appendChild(this.card)
  }

  /** 单击/悬停区块高亮：row/col 为 0 表示清空（标注回落到 1 × 1） */
  private highlight(row: number, col: number): void {
    for (const cell of this.cells) {
      cell.classList.toggle(
        'is-active',
        Number(cell.dataset.row) <= row && Number(cell.dataset.col) <= col,
      )
    }
    this.rowNum.textContent = String(Math.max(1, row))
    this.colNum.textContent = String(Math.max(1, col))
  }

  private position(): void {
    const anchor =
      this.anchor ?? document.querySelector<HTMLElement>('.toolbar-btn[data-tb-cmd="table"]')
    // 无锚点（菜单栏 / 宿主调用）：贴在视口左上方一个固定位置
    if (!anchor) {
      this.card.style.top = '60px'
      this.card.style.left = '40px'
      return
    }
    const rect = anchor.getBoundingClientRect()
    const cardRect = this.card.getBoundingClientRect()
    // 默认贴按钮下沿；空间不足则上翻，越界则左右夹取
    let top = rect.bottom + 6
    if (top + cardRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - cardRect.height - 6)
    }
    let left = rect.left
    if (left + cardRect.width > window.innerWidth - 8) {
      left = window.innerWidth - cardRect.width - 8
    }
    if (left < 8) left = 8
    this.card.style.top = `${Math.round(top)}px`
    this.card.style.left = `${Math.round(left)}px`
  }

  show(anchor?: HTMLElement): void {
    // 同一个按钮再点一次：收起（开关式）
    if (!this.card.hidden && this.anchor === (anchor ?? null)) {
      this.hide()
      return
    }
    this.anchor = anchor ?? null
    this.highlight(0, 0)
    this.card.hidden = false
    this.position()
  }

  hide(): void {
    this.card.hidden = true
    this.anchor = null
  }
}

export const tablePicker = new TablePicker()
