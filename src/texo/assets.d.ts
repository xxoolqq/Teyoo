// Vite 资产导入类型（本项目 tsconfig 未引 vite/client，这里只声明用到的形态）
declare module '*.png?inline' {
  const url: string
  export default url
}

// MathLive 的字体表（包 exports 里的 ./fonts.css → mathlive-fonts.css）。
// 里面的 woff2 由 Vite 打成同目录 asset 一起打包，不去 CDN。
declare module 'mathlive/fonts.css'
