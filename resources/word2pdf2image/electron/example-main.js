// example-main.js — Electron 主进程接入示例
// 演示 converter-service 的三种典型用法和 IPC 注册。
// 约定: 打包或开发时 bin/ 下放 doc2pdf.exe 与 pdf2png.exe
//   开发期: 仓库根 bin/ + 环境变量 ELECTRON_DEV=1
//   打包后: %resourcesPath%\bin\ (electron-builder extraResources 配置见注释)

// electron-builder.yml 片段:
// extraResources:
//   - from: bin/
//     to: bin/

const { app, ipcMain, BrowserWindow } = require('electron')
const svc = require('./converter-service')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // 见文末 preload 片段
    },
  })
}

/* -------------------------------------------------------------------------
 * preload.js 中这样把服务暴露给渲染进程（file:// 环境下记得走 contextBridge）:
 *
 *   const { contextBridge, ipcRenderer } = require('electron')
 *   contextBridge.exposeInMainWorld('converter', {
 *     convert: (input, opts) => ipcRenderer.invoke('convert:full', { input, opts }),
 *     docxToPdf: (input, opts) => ipcRenderer.invoke('convert:doc2pdf', { input, opts }),
 *     pdfToPng: (input, opts) => ipcRenderer.invoke('convert:pdf2png', { input, opts }),
 *     onProgress: (cb) => ipcRenderer.on('convert:progress', (e, info) => cb(info)),
 *   })
 * ---------------------------------------------------------------------- */

// 完整管线: docx -> pdf -> png
ipcMain.handle('convert:full', async (event, { input, opts = {} }) => {
  return svc.convert(input, {
    ...opts,
    sender: event.sender, // 进度事件自动推给发起方
  })
})

// 仅 docx -> pdf
ipcMain.handle('convert:doc2pdf', async (event, { input, opts = {} }) => {
  return svc.docxToPdf(input, { ...opts, sender: event.sender })
})

// 仅 pdf -> png
ipcMain.handle('convert:pdf2png', async (event, { input, opts = {} }) => {
  return svc.pdfToPng(input, { ...opts, sender: event.sender })
})

// 渲染进程调用示意:
//   await window.converter.convert('D:\\案例\\测试.docx', { dpi: 300 })
//   window.converter.onProgress(info => console.log(info))
//   // info 形如:
//   //   { stage:'doc2pdf', type:'item', src:'a.docx', dest:'a.pdf' }
//   //   { stage:'pdf2png', type:'item', src:'a.pdf',  dest:'a_001.png' }
//   //   { stage:'pdf2png', type:'error', file:'a.pdf', message:'第3页渲染失败...' }
//   // 返回值:
//   //   { ok, pdfPaths:[...], pngPaths:[...], errors:[...] }

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
