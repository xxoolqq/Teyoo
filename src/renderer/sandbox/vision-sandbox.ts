// 可视化解题的绘图沙箱页脚本
// ─────────────────────────────────────────────────────────────────────────────
// 协议（与宿主 src/visualSolve/sandbox-bridge.ts 对应）：
//   收：{ type: 'render', id, spec, theme: { text } }
//   发：{ type: 'result', id, ok, svg?, width?, height?, error? }
//
// 为什么要有这一页（而不是把库打进主界面）：见 visualSolve/graphics.ts 顶部说明。
// 三条硬约束：
//   1. 只回传 SVG **字符串**，不传库对象/不把图画进主文档；
//   2. 标签必须画进 SVG（JSXGraph 默认把文字做成浮在画布上的 HTML div —— 那样
//      序列化会丢字，所以把 text.display 设成 internal）；
//   3. 样式自带（主文档是用 <img src="data:image/svg+xml…"> 显示的，继承不到主题）。

import functionPlot from 'function-plot'
import JXG from 'jsxgraph'
import type { FigureSpec, GraphicSpec, PlotSpec } from '../../visualSolve/graphics'

const WIDTH = 520
const HEIGHT = 320

// 标签画进 SVG 里（否则序列化时点名的 A/B/C 全丢）；画布不留版权/导航按钮。
JXG.Options.text.display = 'internal'
JXG.Options.board.showCopyright = false
JXG.Options.board.showNavigation = false

function stage(): HTMLElement {
  return document.getElementById('stage') as HTMLElement
}

function renderPlot(spec: PlotSpec, theme: { text: string }): SVGSVGElement | null {
  const host = document.createElement('div')
  host.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;background:transparent`
  stage().replaceChildren(host)
  const data: Record<string, unknown>[] = spec.functions.map((fn) => ({ fn, color: theme.text }))
  if (spec.points.length) {
    // function-plot 1.x 的散点写法：fnType: 'points' + graphType: 'scatter'
    data.push({
      fnType: 'points',
      graphType: 'scatter',
      points: spec.points.map((point) => [point.x, point.y]),
      color: theme.text
    })
  }
  functionPlot({
    target: host,
    width: WIDTH,
    height: HEIGHT,
    grid: true,
    xAxis: { domain: spec.domain },
    ...(spec.range ? { yAxis: { domain: spec.range } } : {}),
    data: data as never
  })
  return host.querySelector('svg')
}

function renderFigure(spec: FigureSpec, theme: { text: string }): SVGSVGElement | null {
  const host = document.createElement('div')
  host.id = `jxg-${Math.random().toString(36).slice(2)}`
  host.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;background:transparent`
  stage().replaceChildren(host)

  // 视野：包住所有点，四面各留 1 个单位；没有点（只有圆/多边形）就以原点为中心
  const xs = spec.points.map((point) => point.x)
  const ys = spec.points.map((point) => point.y)
  const pad = 1
  const minX = (xs.length ? Math.min(...xs) : -3) - pad
  const maxX = (xs.length ? Math.max(...xs) : 3) + pad
  const minY = (ys.length ? Math.min(...ys) : -3) - pad
  const maxY = (ys.length ? Math.max(...ys) : 3) + pad
  const span = Math.max(maxX - minX, maxY - minY)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2

  const board = JXG.JSXGraph.initBoard(host.id, {
    // [左, 上, 右, 下]
    boundingbox: [cx - span / 2, cy + span / 2, cx + span / 2, cy - span / 2],
    axis: true,
    grid: false,
    keepAspectRatio: true,
    showCopyright: false,
    showNavigation: false,
    // 静态快照：平移关掉（缩放本来就要按键/滚轮，而且我们只取一次 SVG 就完事）
    pan: { enabled: false }
  })

  const nodes = new Map<string, JXG.GeometryElement>()
  for (const point of spec.points) {
    nodes.set(
      point.name,
      board.create('point', [point.x, point.y], {
        name: point.name,
        size: 3,
        fixed: true,
        strokeColor: theme.text,
        fillColor: theme.text,
        label: { color: theme.text, fontSize: 14 }
      })
    )
  }
  // 点名 → 已建好的点元素；坐标字面量 `(x,y)` → 坐标对（JSXGraph 两种都收）；
  // 认不出来返回 null —— 宁可这一条指令不画，也不要默默画到原点去。
  // （真机上出过这事：`circle (2,1.5) 2.5` 把普通对象当点交给 JSXGraph，整张图
  //  直接报错、退成指令原文；早先的 `?? {x:0,y:0}` 更是把画错位置的图当成功。）
  type Anchor = JXG.GeometryElement | [number, number]
  const resolve = (token: string): Anchor | null => {
    const named = nodes.get(token)
    if (named) return named
    const coords = /^\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(token)
    if (!coords) return null
    const x = Number(coords[1])
    const y = Number(coords[2])
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  const anchors = (...tokens: string[]): Anchor[] | null => {
    const list = tokens.map((token) => resolve(token))
    return list.every((item): item is Anchor => item !== null) ? list : null
  }
  const stroke = { strokeColor: theme.text, strokeWidth: 1.5 }

  for (const [a, b] of spec.segments) {
    const pair = anchors(a, b)
    if (pair) board.create('segment', pair as never, stroke)
  }
  for (const circle of spec.circles) {
    const center = circle.center.name
      ? (nodes.get(circle.center.name) ?? null)
      : ([circle.center.x, circle.center.y] as [number, number])
    if (center) board.create('circle', [center, circle.radius] as never, stroke)
  }
  for (const polygon of spec.polygons) {
    const points = anchors(...polygon)
    if (!points) continue
    board.create('polygon', points as never, {
      ...stroke,
      fillColor: theme.text,
      fillOpacity: 0.08,
      borders: { strokeColor: theme.text }
    })
  }
  for (const [a, b, c] of spec.angles) {
    const triple = anchors(a, b, c)
    if (!triple) continue
    board.create('angle', triple as never, {
      radius: 0.7,
      strokeColor: theme.text,
      fillColor: theme.text,
      fillOpacity: 0
    })
  }

  return host.querySelector('svg')
}

/** 序列化成自包含的 SVG 字符串：显式尺寸 + 命名空间 + 透明底 */
function serialize(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(WIDTH))
  clone.setAttribute('height', String(HEIGHT))
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`)
  return new XMLSerializer().serializeToString(clone)
}

function handle(id: string, spec: GraphicSpec, theme: { text: string }): void {
  const svg = spec.kind === 'figure' ? renderFigure(spec, theme) : renderPlot(spec, theme)
  if (!svg) {
    window.parent.postMessage({ type: 'result', id, ok: false, error: 'NO_SVG' }, '*')
    return
  }
  window.parent.postMessage({ type: 'result', id, ok: true, svg: serialize(svg), width: WIDTH, height: HEIGHT }, '*')
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; id?: string; spec?: GraphicSpec; theme?: { text?: string } }
  if (data?.type !== 'render' || !data.id || !data.spec) return
  const theme = { text: data.theme?.text || '#333' }
  try {
    handle(data.id, data.spec, theme)
  } catch (error) {
    stage().replaceChildren()
    window.parent.postMessage(
      { type: 'result', id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) },
      '*'
    )
  }
})
