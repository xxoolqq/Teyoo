// 截屏浮层窗口的门禁卡：只给三件事 —— 收这张屏幕快照、把框出来的一块交回去、
// 取消。主窗口那张卡（src/preload/index.ts）上有几十个方法，而这个窗口要画的
// 是整屏截出来的内容（别人的窗口、网页、PDF），没必要让它握着整个应用的权限。
//
// 与主窗口那张卡（src/preload/index.ts）同一个规矩：contextIsolation + contextBridge：浮层页面
// 拿不到 Node，只能经这里过桥。

import { contextBridge, ipcRenderer } from 'electron'

/** 快照是哪来的：整屏，还是整屏失败后退回的「Teyoo 自己的窗口」 */
export type SnipSource = 'screen' | 'window'

export interface SnipAPI {
  /** 主进程抓完屏就把快照（data URL）送过来 */
  onSnapshot: (callback: (dataUrl: string, source: SnipSource) => void) => void
  /** 用户确认：把选区裁出来的那一块交回去 */
  submit: (dataUrl: string) => void
  /** 用户放弃（Esc / 取消按钮） */
  cancel: () => void
}

const api: SnipAPI = {
  onSnapshot: (callback) => {
    ipcRenderer.on('snip-snapshot', (_event, dataUrl: string, source: SnipSource) => callback(dataUrl, source))
  },
  submit: (dataUrl) => {
    ipcRenderer.send('snip-submit', dataUrl)
  },
  cancel: () => {
    ipcRenderer.send('snip-cancel')
  }
}

contextBridge.exposeInMainWorld('snipAPI', api)
