import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// WebView2 宿主页：一个自包含的静态页面，里面是桌面版同一套 Milkdown 编辑器。
//
// 产物是「一个 HTML 文件」：JS 与 CSS 全部内联，脚本是普通 <script> 而不是
// <script type="module">。理由：用 file:// 打开时模块脚本会被 CORS 拦掉（file
// 源是 opaque origin），外链资源同理；内联的经典脚本没有这个限制。于是 C# 侧
// 既可以 Navigate("file:///…/index.html")，也可以挂虚拟域名用 https://。
//
// 与 vite.web.config.ts（官网的主题体验页）互相独立：那边是多文件 + 模块脚本
// （部署在 https 站点上），这边是单文件 + 经典脚本（塞进 Word 插件里）。

/** 把这次构建产出的 JS / CSS 全部内联进 HTML 模板，只留一个文件。 */
function singleFileHtml(templatePath: string): Plugin {
  return {
    name: 'colamd-webview2-single-file',
    enforce: 'post',
    generateBundle(_options, bundle) {
      let js = ''
      let css = ''
      for (const fileName of Object.keys(bundle)) {
        const output = bundle[fileName]
        if (output.type === 'chunk' && fileName.endsWith('.js')) {
          js += `${output.code}\n`
        } else if (output.type === 'asset' && fileName.endsWith('.css') && typeof output.source === 'string') {
          css += `${output.source}\n`
        }
        delete bundle[fileName] // 中间产物不落盘
      }

      // 内联脚本里出现 </script 会提前闭合标签，先转义（只可能出现在字符串里）。
      const script = js.replace(/<\/script/gi, '<\\/script')
      const html = readFileSync(templatePath, 'utf8')
        .replace('<!--COLA_STYLE-->', () => `<style>\n${css}</style>`)
        .replace('<!--COLA_SCRIPT-->', () => `<script>\n${script}\n</script>`)

      this.emitFile({ type: 'asset', fileName: 'index.html', source: html })
    }
  }
}

// mathjax-full/js/components/version.js 在模块求值时这样取版本号：
//   VERSION = typeof PACKAGE_VERSION > 'u' ? eval('require')('path')… : PACKAGE_VERSION
// 浏览器里 PACKAGE_VERSION 未定义 → 走 eval('require') → ReferenceError，
// 整个脚本在第一行就崩（编辑器根本不会挂载）。预置这个常量后它走另一条分支，
// 不再碰 require。版本号直接从依赖里读，不会写死过期。
const mathjaxVersion = JSON.parse(
  readFileSync(resolve(__dirname, 'node_modules/mathjax-full/package.json'), 'utf8')
).version as string

export default defineConfig({
  root: resolve(__dirname, 'src/webview2'),
  resolve: {
    alias: {
      // docx-import.ts（Word → Markdown）原本跑在主进程，依赖 @napi-rs/canvas
      // 的原生 Skia 绑定来栅格化 MathType 公式图片。页面里没有 Node 原生模块，
      // 换成同接口的 Canvas/OffscreenCanvas 实现 —— 源码一行不改。
      '@napi-rs/canvas': resolve(__dirname, 'src/webview2/canvas-shim.ts'),
    },
  },
  define: {
    PACKAGE_VERSION: JSON.stringify(mathjaxVersion)
  },
  build: {
    outDir: resolve(__dirname, 'dist-webview2'),
    emptyOutDir: true,
    // WebView2 常青版 Chromium 足够新；es2020 也避开过于激进的语法降级。
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 64 * 1024 * 1024, // 图片/字体一并内联，保持单文件
    modulePreload: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/webview2/main.ts'),
      formats: ['iife'],
      name: 'ColamdEditorBundle',
      fileName: () => 'editor.js'
    }
  },
  plugins: [singleFileHtml(resolve(__dirname, 'src/webview2/index.html'))]
})
