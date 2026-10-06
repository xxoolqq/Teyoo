// 桌面版由 Electron preload 注入 window.electronAPI；WebView2 里没有它。
//
// 编辑器内核里绝大多数调用写作 window.electronAPI?.x?.()，对象缺席就整段跳过，
// 只有两处是「不判空直接调」的：
//   - readClipboardText()：插入链接时用剪贴板里的网址预填弹窗（editor.ts:1114）
//   - openExternal(href)  ：点击正文里的外链（editor.ts:2096）
//
// 这里只补这两个，其余一律保持未定义 —— 这样「有 API 才走」的分支行为与桌面版
// 完全一致，不会因为假装有 Electron 而跑进半截流程（比如假装能存盘）。
// 本模块必须在 editor 模块之前 import：见 main.ts 的 import 顺序。

const w = window as unknown as { electronAPI?: Record<string, unknown> }

if (!w.electronAPI) {
  w.electronAPI = {
    readClipboardText: async (): Promise<string> => {
      try {
        return (await navigator.clipboard.readText()) ?? ''
      } catch {
        return '' // 无用户手势/无权限：返回空串，弹窗照常打开
      }
    },
    openExternal: (href: string): void => {
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  }
}

export {}
