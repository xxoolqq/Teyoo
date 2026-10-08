// physics 宏（KaTeX / Temml 用）
// ─────────────────────────────────────────────────────────────────────────────
// MathJax 那边直接加载了官方 physics 包（见 mathjax-engine.ts 的 TEX_PACKAGES）；
// KaTeX 生态没有官方 physics 实现，只能把最常用的命令用 macros 近似。
// 同一份宏同时喂给三处，保证「预览」与「导出 Word」看到的结果一致：
//   · src/renderer/math-engine/katex-engine.ts  编辑器预览
//   · src/main/formula/converters/temml-omml.ts 导出 OMML
//   · src/renderer/editor/editor.ts 的 katexOptionsCtx（兜底，见下）
//
// 取舍与已知差异（都是刻意接受的近似，不是漏实现）：
//   1. 不支持 physics 的「可选参数」与 starred 形式（\dv*、\pdv[f]{y}{x} 等）；
//      KaTeX 的 macros 机制没有可选参数，只做最常用的一/二/三参数形态。
//   1b. 凡「用字面定界符当语法」的命令一律不收录：\qty(x)、\bqty[x]、\vqty|x|、
//      \eval{f}|_{a}^{b}。KaTeX 宏只把 {…} 当参数，\qty(a+b) 会被抓成空参数
//      并把括号撒在外面（实测输出的括号数翻倍、内容跑到括号外）。宁可让它报
//      「未定义命令」（红色可见），也不要静默渲染成错的式子。
//      → 这些内容请用花括号写法：\norm{x} / \absolutevalue{x} / \order{x}。
//   2. \dd 只展开成 \mathrm{d}（不带参数），\dd x 得到 \mathrm{d}x。
//   3. 矢量族 va…vz 一律用 \vec（physics 里 \va 是箭头，\vb 是粗体，这里不区分）。
//   4. 未收录 \abs / \tr 这类高冲突名字：用户文档里常自己 \newcommand{\abs}，
//      一旦同名 KaTeX 会报 "command already defined"。physics 的 \absolutevalue
//      / \norm 仍然可用。
//   5. \div 没有重定义成散度（那会毁掉已有的除号 ÷），散度用 \divergence。

/** KaTeX / Temml 的 macros 选项：键带反斜杠，参数用 #1 #2 #3。 */
export const PHYSICS_MACROS: Record<string, string> = {
  // ── 可视化解题用的高亮 ────────────────────────────────────────────────
  // \hl{2x}：把"这一步变化的那一项"标出来（解题步骤里用，见 src/visualSolve）。
  // 颜色必须用**命名色**：宏展开体里的 `#` 会被当成参数引用
  // （写成 \textcolor{#c2410c}{#1} 会报 "Illegal macro parameter reference"，
  // 真机上踩过）。MathJax 那边见 mathjax-engine.ts 的同名定义，两边一致。
  '\\hl': '\\textcolor{darkorange}{#1}',

  // ── 导数与微分 ────────────────────────────────────────────────────────
  '\\dv': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}',
  '\\pdv': '\\frac{\\partial #1}{\\partial #2}',
  '\\fdv': '\\frac{\\delta #1}{\\delta #2}',
  '\\dd': '\\mathrm{d}',

  // ── 定界括号族（只收花括号形态，见顶部 1b）────────────────────────────
  '\\absolutevalue': '\\left\\lvert#1\\right\\rvert',
  '\\norm': '\\left\\lVert#1\\right\\rVert',
  '\\order': '\\mathcal{O}\\left(#1\\right)',
  '\\commutator': '\\left[#1,#2\\right]',
  '\\anticommutator': '\\left\\{#1,#2\\right\\}',
  '\\poissonbracket': '\\left\\{#1,#2\\right\\}',

  // ── 狄拉克符号 ────────────────────────────────────────────────────────
  '\\bra': '\\left\\langle#1\\right|',
  '\\ket': '\\left|#1\\right\\rangle',
  '\\braket': '\\left\\langle#1\\right\\rangle',
  '\\ketbra': '\\left|#1\\right\\rangle\\!\\left\\langle#2\\right|',
  '\\innerproduct': '\\left\\langle#1,#2\\right\\rangle',
  '\\outerproduct': '\\left|#1\\right\\rangle\\!\\left\\langle#2\\right|',
  '\\expectationvalue': '\\left\\langle#1\\right\\rangle',
  '\\matrixelement': '\\left\\langle#1\\middle|#2\\middle|#3\\right\\rangle',

  // ── 矢量（箭头）与算符 ────────────────────────────────────────────────
  '\\va': '\\vec{#1}',
  '\\vb': '\\vec{#1}',
  '\\vc': '\\vec{#1}',
  '\\vd': '\\vec{#1}',
  '\\ve': '\\vec{#1}',
  '\\vf': '\\vec{#1}',
  '\\vg': '\\vec{#1}',
  '\\vh': '\\vec{#1}',
  '\\vi': '\\vec{#1}',
  '\\vj': '\\vec{#1}',
  '\\vk': '\\vec{#1}',
  '\\vl': '\\vec{#1}',
  '\\vm': '\\vec{#1}',
  '\\vn': '\\vec{#1}',
  '\\vo': '\\vec{#1}',
  '\\vp': '\\vec{#1}',
  '\\vq': '\\vec{#1}',
  '\\vr': '\\vec{#1}',
  '\\vs': '\\vec{#1}',
  '\\vt': '\\vec{#1}',
  '\\vu': '\\vec{#1}',
  '\\vv': '\\vec{#1}',
  '\\vw': '\\vec{#1}',
  '\\vx': '\\vec{#1}',
  '\\vy': '\\vec{#1}',
  '\\vz': '\\vec{#1}',
  '\\uv': '\\hat{#1}',
  '\\grad': '\\nabla',
  '\\divergence': '\\nabla\\cdot',
  '\\curl': '\\nabla\\times',
  '\\laplacian': '\\nabla^{2}',
}
