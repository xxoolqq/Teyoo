// ─── 画布里的 LaTeX 渲染：换成项目自己的 MathJax 引擎 ────────────────────
//
// canvas-editor 自带的公式渲染是「自研解析 + Hershey 描边字体 + 手工 bbox」：
// 字是单线描出来的，上下标位置靠手算，矩阵/根式这类结构容易歪。
//
// 它没有留替换口子 —— 逐一排查过：
//   · IEditorOption 里没有 latex 相关配置
//   · Editor 的 register 只有 { contextMenuList, getContextMenuList, shortcutList,
//     langMap }，不持有任何管理器实例
//   · Draw 实例在 Editor 构造函数里是局部变量，只被 command 的闭包引用，
//     从 editor 对象图不可达（实测：从 editor 出发 8 层 DFS 找不到 laTexParticle）
//   · Override / EventBus 里没有渲染钩子
//
// 整条渲染链路只有一个收口，在 @hufe921/canvas-editor/dist/canvas-editor.js：
//   · 排版时对每个 latex 元素
//       const { svg, width, height } = LaTexParticle.convertLaTextToSVG(value)
//       element.width ||= width; element.height ||= height; element.laTexSVG = svg
//   · 绘制时 LaTexParticle.render 把 laTexSVG（data URL）当图片画出来；
//     悬浮预览（resizer，mime=svg）取的也是同一个 laTexSVG
//
// 于是换掉这一个静态方法，宽度、描图、预览就整条换了：元素 type 仍是 latex，
// 导出 Markdown、复制、选中、编辑交互一行都不受影响。
//
// LaTexParticle 上游没有导出（类名在产物里被压成 mt），静态方法从外部摸不到，
// 所以由 patches/@hufe921+canvas-editor+1.0.4.patch 在 dist 的导出表里补上它。
//
// 两个已知行为，与自带实现一致，不是本次改动引入的：
//   · 宽度只在元素原本没有 width/height 时才被采用（`n.width = n.width || t`）。
//     从 Markdown 导入、工具栏插入的 latex 元素都不带尺寸，走的是我们的值；
//     但带旧尺寸的元素（例如以前导出的 JSON 再导入）会沿用旧尺寸，把新图拉伸
//     变形 —— 这类文件需要重新导入 Markdown 才会得到正确比例。
//   · convertLaTextToSVG 只拿到 latex 字符串，拿不到元素自身的 size，所以公式
//     字号是固定的（自带实现用固定 SCALE_X/Y，同样不看 size）。
//
// 这里固定用 MathJax 而不是跟随 math-engine 的偏好：KaTeX 输出的是 HTML+CSS
// 而不是 SVG，样式全在外部 CSS 里，嵌进 <img> 就丢了。

import { LaTexParticle } from '@hufe921/canvas-editor'
import type { IElement } from '@hufe921/canvas-editor'
import { mathjaxEngine } from '../math-engine/mathjax-engine'

/** 与 canvas 自带的 LaTexSVG 同构：data URL + px 宽高 */
interface CanvasLaTexSVG {
  svg: string
  width: number
  height: number
}

/** 公式参考字号，与 createCanvasEditorOptions 的 defaultSize 保持一致 */
const LATEX_FONT_SIZE = 14

const SVG_CACHE = new Map<string, CanvasLaTexSVG>()

/**
 * depth（基线下方的深度，未缩放的 px），按 svg data URL 索引。
 * 绘制时需要它把公式摆正，见 installMathJaxLatexRenderer 里的 render 补丁。
 */
const DEPTH_BY_SVG = new Map<string, number>()

/** 解析 SVG 的 viewBox：`0 -1449.5 5138.6 2399` → 原点与尺寸 */
function parseViewBox(value: string | null): { y: number; height: number } | null {
  if (!value) return null
  const parts = value.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  return { y: parts[1], height: parts[3] }
}

let patched = false
let measureHost: HTMLElement | null = null

/**
 * 测量宿主：MathJax 的 SVG 宽高属性是 ex 单位，必须真的参与布局才能量出 px，
 * 所以只能藏到屏幕外（visibility:hidden 仍然参与布局）。
 */
function ensureMeasureHost(): HTMLElement {
  if (measureHost?.isConnected) return measureHost
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText =
    'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;white-space:nowrap;'
  host.style.fontSize = `${LATEX_FONT_SIZE}px`
  document.body.appendChild(host)
  measureHost = host
  return host
}

/**
 * LaTeX → { svg(data URL), width, height(px) }。
 * 返回 null 表示这一步没做成，调用方回退到 canvas 自带渲染。
 */
function renderLatex(latex: string): CanvasLaTexSVG | null {
  const cached = SVG_CACHE.get(latex)
  if (cached) return cached

  const host = ensureMeasureHost()
  // 编译失败时引擎自己返回带错误信息的节点，这里只看有没有 svg
  const rendered = mathjaxEngine.render(latex, false)
  host.replaceChildren(rendered)
  const svg = rendered.querySelector('svg')
  if (!svg) {
    host.replaceChildren()
    return null
  }

  const rect = svg.getBoundingClientRect()
  const width = Math.ceil(rect.width)
  const height = Math.ceil(rect.height)
  // MathJax 以数学基线为 y=0 排版，viewBox 的「原点 y + 高」就是基线到底边的
  // 单位数 —— 换成 px 就是 depth。宽高要 ceil，图会被同比例拉伸，depth 跟着走。
  const viewBox = parseViewBox(svg.getAttribute('viewBox'))
  const depth =
    viewBox && viewBox.height > 0
      ? Math.max(0, (viewBox.y + viewBox.height) * (height / viewBox.height))
      : 0
  host.replaceChildren()
  if (!width || !height) return null

  // 拷一份独立使用：data URL 进 <img> 后是独立文档，不能依赖页面 CSS
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', `${width}`)
  clone.setAttribute('height', `${height}`)
  // vertical-align 是给行内排版用的，画成图片没有意义
  clone.removeAttribute('style')

  const result: CanvasLaTexSVG = {
    svg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      new XMLSerializer().serializeToString(clone)
    )}`,
    width,
    height
  }
  SVG_CACHE.set(latex, result)
  DEPTH_BY_SVG.set(result.svg, depth)
  return result
}

/**
 * 把画布里的公式渲染换成 MathJax。补丁打在类的静态方法上，全进程只打一次
 * （多个标签页共用同一份 bundle）。
 *
 * 拿不到 LaTexParticle 时静默放弃（patches 没应用 —— 例如装了依赖但没跑
 * postinstall），画布退回自带渲染，标签页本身照常可用。
 */
export function installMathJaxLatexRenderer(): void {
  if (patched) return
  if (!LaTexParticle || typeof LaTexParticle.convertLaTextToSVG !== 'function') {
    console.warn('[canvas-latex] LaTexParticle 不可用，画布公式仍用自带渲染')
    return
  }
  const original = LaTexParticle.convertLaTextToSVG.bind(LaTexParticle)
  LaTexParticle.convertLaTextToSVG = (latex: string): CanvasLaTexSVG => {
    try {
      const rendered = renderLatex(latex)
      if (rendered) return rendered
    } catch (error) {
      console.warn('[canvas-latex] MathJax 渲染失败，本次回退自带渲染：', error)
    }
    return original(latex)
  }

  // 竖直位置：canvas 把 latex 当图片排 —— 图片底边压在文字基线上（实测：文字
  // fillText 的 y=216，图片 drawImage 的 y=132、高 82.5，底边 214.5）。单行高的
  // 公式勉强能看，cases / 分数 / 矩阵这类高公式就会整块浮到文字上方。
  //
  // 正确做法是让公式的「数学基线」落在文字基线上。MathJax 的基线写在 viewBox
  // 里（就是上面的 depth），把元素整体下移这么多即可 —— 公式底边本来就该低于
  // 基线（下标、分号、行列式的下半截都在那）。
  //
  // 只挪绘制位置，不动 element 的尺寸与坐标：命中测试、光标、悬浮预览仍按
  // canvas 自己的那套走。代价是公式的可点击区域比视觉位置略高一点。
  const originalRender = LaTexParticle.prototype.render
  LaTexParticle.prototype.render = function (
    ctx: CanvasRenderingContext2D,
    element: IElement,
    x: number,
    y: number
  ): void {
    const svg = (element as { laTexSVG?: string }).laTexSVG
    const depth = svg ? DEPTH_BY_SVG.get(svg) : undefined
    if (!depth) {
      originalRender.call(this, ctx, element, x, y)
      return
    }
    // 绘制坐标是缩放后的，element.height 是缩放前的，depth 跟着前者走
    const scale = (this as unknown as { options?: { scale?: number } }).options?.scale ?? 1
    originalRender.call(this, ctx, element, x, y + depth * scale)
  }

  patched = true
}
