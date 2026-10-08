// 可视化解题：图形指令的解析（模型给的是**受限指令**，不是 SVG/JS）
// ─────────────────────────────────────────────────────────────────────────────
// 为什么不让模型直接产 SVG / 画图代码：
//   ① 安全：模型产出的 markup 会被插入正文、被导出成 HTML/PDF —— 只收"点/线/圆"这种
//      结构化指令，画由我们自己控制的渲染器完成；
//   ② 质量：模型写 SVG 十次有五次是坏的（坐标错、viewBox 乱、文字压线）；
//   ③ 可交互：结构化的图以后能拖点、能随参数重画（SVG 死图不能）。
//
// 语法（写进系统提示词，见 protocol.ts）：
//   ```plot
//   f: 2*x + 1          ← 一条或多条
//   domain: -5..5       ← x 范围（可选，默认 -5..5）
//   range: -3..3        ← y 范围（可选）
//   points: (2,5) (3,1) ← 标注点（可选）
//   ```
//   ```figure
//   A=(0,0)  B=(4,0)  C=(0,3)   ← 先给点
//   segment A B                 ← 线段
//   circle A 2                  ← 圆心 + 半径（圆心也可以直接写 (1,2)）
//   polygon A B C               ← 多边形
//   angle A B C                 ← 角标记（顶点在中间那个）
//   ```
// 认不出的行直接忽略（宽容解析），整块没一条可用指令就返回 null，界面退回显示原文。

export interface GraphicPoint {
  name: string
  x: number
  y: number
}

/** 自由参数：拖动滑块就把它代进表达式重画（"a 变了图像怎么变"这类问题直接看） */
export interface PlotParam {
  name: string
  value: number
  min: number
  max: number
}

export interface PlotSpec {
  kind: 'plot'
  /** 函数表达式，例如 `2*x+1` / `x^2-2*x`（交给 function-plot 求值） */
  functions: string[]
  domain: [number, number]
  range?: [number, number]
  points: { x: number; y: number }[]
  /** 表达式里可以出现的自由参数；空数组 = 静态图 */
  params: PlotParam[]
}

/** 参数名合法性：单个字母或字母数字组合（避免把函数名当参数替换掉） */
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/

export interface FigureSpec {
  kind: 'figure'
  points: GraphicPoint[]
  segments: [string, string][]
  circles: { center: GraphicPoint; radius: number }[]
  polygons: string[][]
  angles: [string, string, string][]
}

export type GraphicSpec = PlotSpec | FigureSpec

/** 表达式白名单：数字、字母、四则运算、乘方、括号、逗号、空格与常见函数名。
 *  这不是"安全沙箱"（求值发生在绘图沙箱页里），只是把明显不是函数的输入挡在门外。 */
const FUNCTION_RE = /^[0-9a-zA-Z_+\-*/^()., ]+$/

function parseNumber(text: string): number | null {
  const value = Number(text.trim())
  return Number.isFinite(value) ? value : null
}

function parseRange(text: string): [number, number] | null {
  const match = /^\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*$/.exec(text)
  if (!match) return null
  const from = parseNumber(match[1])
  const to = parseNumber(match[2])
  if (from === null || to === null || from >= to) return null
  return [from, to]
}

function parsePoints(text: string): { x: number; y: number }[] {
  const found: { x: number; y: number }[] = []
  const re = /\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const x = parseNumber(match[1])
    const y = parseNumber(match[2])
    if (x !== null && y !== null) found.push({ x, y })
  }
  return found
}

function parsePlot(lines: string[]): PlotSpec | null {
  const spec: PlotSpec = { kind: 'plot', functions: [], domain: [-5, 5], points: [], params: [] }
  for (const line of lines) {
    const body = line.trim()
    if (!body) continue
    const colon = body.indexOf(':')
    if (colon < 0) continue
    const key = body.slice(0, colon).trim().toLowerCase()
    const value = body.slice(colon + 1).trim()
    if (key === 'f' || key === 'y') {
      if (FUNCTION_RE.test(value)) spec.functions.push(value)
      continue
    }
    if (key === 'domain') {
      const range = parseRange(value)
      if (range) spec.domain = range
      continue
    }
    if (key === 'range' || key === 'yrange') {
      const range = parseRange(value)
      if (range) spec.range = range
      continue
    }
    if (key === 'points') {
      spec.points.push(...parsePoints(value))
      continue
    }
    // params: a = 1 (-5..5)   ← 一行一个；不给范围就默认 -5..5
    if (key === 'params' || key === 'param') {
      const match = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(-?[\d.]+)\s*(?:\(\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*\))?$/.exec(value)
      if (!match || !PARAM_NAME_RE.test(match[1])) continue
      const initial = parseNumber(match[2])
      if (initial === null) continue
      const min = match[3] !== undefined ? parseNumber(match[3]) : -5
      const max = match[4] !== undefined ? parseNumber(match[4]) : 5
      spec.params.push({
        name: match[1],
        value: initial,
        min: min ?? -5,
        max: max ?? 5
      })
    }
  }
  return spec.functions.length ? spec : null
}

/**
 * 把参数值代进表达式，得到"这一刻"的图。
 * 只做**整词替换**（`a` 不会误替换掉 `abs` 里的 a），替换值加括号避免优先级问题：
 * `a*x` 代入 -2 得到 `(-2)*x`。
 */
export function withParams(spec: PlotSpec, values: Record<string, number>): PlotSpec {
  if (!spec.params.length) return spec
  const substitute = (expression: string): string => {
    let out = expression
    for (const param of spec.params) {
      const value = values[param.name] ?? param.value
      out = out.replace(new RegExp(`\\b${param.name}\\b`, 'g'), `(${value})`)
    }
    return out
  }
  return { ...spec, functions: spec.functions.map(substitute) }
}

/** 点定义：允许一行里写多个（模型常写成 `A=(0,0)  B=(4,0)  C=(0,3)`，
 *  早先要求"整行恰好是一个点"，真机上直接解析失败、几何图退成指令原文）。 */
const POINT_DEF_GLOBAL = /([A-Za-z][A-Za-z0-9_]*)\s*=\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g

function parseFigure(lines: string[]): FigureSpec | null {
  const byName = new Map<string, GraphicPoint>()
  const segments: [string, string][] = []
  const circles: { center: GraphicPoint; radius: number }[] = []
  const polygons: string[][] = []
  const angles: [string, string, string][] = []

  const resolve = (token: string): GraphicPoint | null => {
    const named = byName.get(token)
    if (named) return named
    const coords = /^\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(token)
    if (coords) {
      const x = parseNumber(coords[1])
      const y = parseNumber(coords[2])
      if (x !== null && y !== null) return { name: '', x, y }
    }
    return null
  }

  for (const line of lines) {
    const body = line.trim().replace(/;$/, '')
    if (!body) continue
    // 先摘出这一行里**所有**点名定义（一行多个点也要认），剩下的当指令解析
    POINT_DEF_GLOBAL.lastIndex = 0
    const rest = body
      .replace(POINT_DEF_GLOBAL, (_match, name: string, x: string, y: string) => {
        const px = parseNumber(x)
        const py = parseNumber(y)
        if (px !== null && py !== null) byName.set(name, { name, x: px, y: py })
        return ' '
      })
      .trim()
    if (!rest) continue
    const parts = rest.split(/\s+/)
    const keyword = parts[0].toLowerCase()
    if (keyword === 'segment' && parts.length >= 3) {
      const a = parts[1]
      const b = parts[2]
      if (resolve(a) && resolve(b)) segments.push([a, b])
      continue
    }
    if (keyword === 'circle' && parts.length >= 3) {
      const center = resolve(parts[1])
      const radius = parseNumber(parts[2])
      if (center && radius !== null && radius > 0) circles.push({ center, radius })
      continue
    }
    if (keyword === 'polygon' && parts.length >= 4) {
      const names = parts.slice(1)
      if (names.every((name) => resolve(name))) polygons.push(names)
      continue
    }
    if (keyword === 'angle' && parts.length >= 4) {
      const names: [string, string, string] = [parts[1], parts[2], parts[3]]
      if (names.every((name) => resolve(name))) angles.push(names)
    }
  }

  if (!byName.size && !segments.length && !circles.length && !polygons.length) return null
  return { kind: 'figure', points: [...byName.values()], segments, circles, polygons, angles }
}

/** 解析一条图形指令；认不出来返回 null（调用方退回显示原文） */
export function parseGraphic(kind: 'plot' | 'figure', code: string): GraphicSpec | null {
  const lines = code.replace(/\r\n?/g, '\n').split('\n')
  return kind === 'figure' ? parseFigure(lines) : parsePlot(lines)
}

/** 同一份图形指令只渲一次（解题页流式重绘很频繁） */
export function specKey(spec: GraphicSpec): string {
  return JSON.stringify(spec)
}
