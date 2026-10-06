// KaTeX 的 contrib 扩展（化学式 \ce / \pu）不带类型声明，这里是纯副作用导入。
declare module 'katex/contrib/mhchem'

declare module 'katex/dist/katex.min.css?inline' {
  const css: string
  export default css
}

// Vite 的 ?url 资产导入（pdf.js 的 worker）：构建时把文件原样 emit 到
// dist/renderer，导入进来的是它的 URL。
declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const url: string
  export default url
}

interface Window {
  electronAPI: import('../preload/index').ElectronAPI
}
