import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'
import type { MathEngine, MathOutputFormat } from './types'
import { renderError } from './katex-engine'

// MathJax 引擎（mathjax-full v3）。
// ────────────────────────────────────────────────────────────────────────────
// 输出链路：TeX 编译 → MmlTree → SVG OutputJax 自绘排版 →
// <mjx-container><svg>…</svg></mjx-container> 直接插入编辑器 DOM。
//
// 曾用「序列化 MathML → Chromium 原生 MathML Core 渲染」（v3 没有 MathML
// 输出 Jax，直出是官方 tex2mml 的做法），但 MathML Core 删除了 mtable 的
// columnalign / columnspacing / rowspacing 与 mo 的 fence / stretchy 等
// MathML 3 布局属性 → array / matrix 方程组排版崩坏（040.md 用例：
// 单元格横向摊开、两行错位、花括号不拉伸）。SVG 自绘与 KaTeX 同一策略，
// 排版质量与浏览器 MathML 实现水平无关。
//
// 注意：mjx-container 的少量配套样式（mathjax-full SVG.commonStyles：
// direction / svg overflow / 链接色）在 convert() 直插 DOM 的用法下不经
// styleSheet 注入，已手写进 themes/base.css 的 MATH 区块。
//
// fontCache 保持默认 'local'：每个 SVG 自带字形 path，自包含，适配编辑器
// 节点频繁创建/销毁/移动的场景（'global' 依赖 document 级共享缓存节点）。
//
// TeX 包列表：AllPackages 剔除 require / autoload（这两个依赖运行时动态加载
// 组件，与 Vite 打包方式不兼容），再手动补上 physics。
// 补 physics 的原因：mathjax-full 3.2 的 AllPackages 只有 30 个包，里面
// 有 mhchem 却没有 physics（physics 在 v3 里不属于 "all"，要单独加载）。
// bussproofs 曾因「直出 MathML 时代无 OutputJax，其编译期 postfilter 调
// outputJax.getBBox() 会抛错」被剔除；换 SVG 输出后 CommonOutputJax 提供
// getBBox，已恢复。
const TEX_PACKAGES = [
  ...AllPackages.filter((name) => name !== 'require' && name !== 'autoload'),
  'physics', // 导数 \dv / 狄拉克符号 \bra / 矢量 \va 等；AllPackages 里没有
]

// mathjax 实例懒初始化：选 KaTeX 的用户不为 MathJax 付出启动开销
let compiled: { doc: ReturnType<typeof mathjax.document> } | null = null

function ensureCompiled(): { doc: ReturnType<typeof mathjax.document> } {
  if (compiled) return compiled
  RegisterHTMLHandler(browserAdaptor())
  const doc = mathjax.document('', {
    // macros：写在这里的命令 MathJax 也要认（与 KaTeX 的 PHYSICS_MACROS 同名同义，
    // 否则同一份 \hl{…} 在 KaTeX 下是高亮、在 MathJax 下报未定义）。
    // 颜色同样用命名色 —— 展开体里的 `#` 会被当成参数引用（详见 physics-macros.ts）。
    InputJax: new TeX({ packages: TEX_PACKAGES, macros: { hl: ['\\textcolor{darkorange}{#1}', 1] } }),
    OutputJax: new SVG(),
  })
  compiled = { doc }
  return compiled
}

export const mathjaxEngine: MathEngine = {
  id: 'mathjax',
  label: 'MathJax',
  render(latex, displayMode, format: MathOutputFormat = 'svg') {
    if (format !== 'svg') {
      // 预留接口：chtml 待后续实现；mathml 序列化需求由导出链路
      // （src/main/formula）独立承担，预览端统一走 svg 自绘
      console.warn(`[math-engine] MathJax 输出格式 ${format} 尚未实现，回退到 svg`)
    }
    const el = document.createElement(displayMode ? 'div' : 'span')
    el.classList.add('math-engine-mathjax')
    try {
      const { doc } = ensureCompiled()
      // 有 OutputJax 时 convert 返回 <mjx-container>（browserAdaptor 产出真实 DOM 节点）
      const node = doc.convert(latex, { display: displayMode })
      if (!node) throw new Error('MathJax compile returned empty output')
      el.appendChild(node as unknown as Node)
    } catch (err) {
      el.replaceChildren(renderError(String(err instanceof Error ? err.message : err), latex))
    }
    return el
  },
}
