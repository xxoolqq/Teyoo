import { defineConfig } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    // 与 renderer 同因：mathjax-full 的 components/version.js 在缺打包器变量时
    // 执行 eval('require') 探测版本。主进程虽无 CSP，但 ESM 化打包后 require
    // /__dirname 未必可用；编译期注入 PACKAGE_VERSION 使该分支永不执行。
    define: {
      PACKAGE_VERSION: JSON.stringify('3.2.1')
    },
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // @napi-rs/canvas、onnxruntime-node 是原生模块（.node 二进制），必须
        // 运行时从 node_modules 加载，交给 rollup 打包会破坏二进制 require 路径。
        // @huggingface/transformers 是 ESM 大包且内部按环境 require onnxruntime-node，
        // 一并 external（运行时动态 import 原包，见 texo-ocr.ts）。
        // better-sqlite3 同样是原生模块（prebuilds/*.node），公式识别历史用它。
        external: [
          '@napi-rs/canvas',
          '@huggingface/transformers',
          'onnxruntime-node',
          'better-sqlite3'
        ],
        output: {
          chunkFileNames: 'chunks/[name].js'
        }
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        // 两张门禁卡：主窗口那张（index）与截屏浮层专用的最小那张（snip）。产物
        // 分别是 dist/preload/index.js 与 dist/preload/snip.js，后者由
        // main/snip-window.ts 建浮层窗口时单独指定 —— 那个页面要画的是整屏截来的
        // 内容，没必要让它拿着主窗口的全套权限。
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          snip: resolve(__dirname, 'src/preload/snip.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // ── mathjax-full CSP 兼容 ─────────────────────────────────────────────
    // mathjax-full/js/components/version.js 在打包变量缺失时会执行
    //   var load = eval('require'); var dirname = eval('__dirname');
    // 而渲染端 CSP 为 default-src 'self'（无 'unsafe-eval'），eval 在模块
    // 求值阶段直接抛 EvalError，导致整个渲染端启动失败（白屏）。
    // 官方预期做法：编译期注入 PACKAGE_VERSION 使该分支永不执行。
    // 注意：dev 模式下依赖由 esbuild 预打包（不吃 renderer.define），
    // 必须同时配 optimizeDeps.esbuildOptions.define 才能覆盖 .vite/deps。
    define: {
      PACKAGE_VERSION: JSON.stringify('3.2.1')
    },
    optimizeDeps: {
      esbuildOptions: {
        define: {
          PACKAGE_VERSION: '"3.2.1"'
        }
      }
    },
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          'mermaid-sandbox': resolve(__dirname, 'src/renderer/mermaid-sandbox.html'),
          // 截屏浮层是一个独立的 OS 窗口（不是主窗口里的 iframe），要有自己的入口。
          // 它不 import base.css：样式全部内联在 html 里（见 P1）。
          snip: resolve(__dirname, 'src/renderer/snip.html')
        }
      }
    }
  }
})
