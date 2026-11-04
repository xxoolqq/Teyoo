// 「批量录入」的交接条：PDF 对照标签页把转好的 Markdown 交给导入中心。
//
// 为什么要有这一层：
//   PDF 对照页（src/renderer）与后台管理系统（src/adminPanel）是同一个窗口里的
//   两个标签页，共用同一个 JS 上下文 —— 但前者不认识 Vue Router，后者不认识
//   Electron（见 host.ts 的分工）。中间就靠这个模块级对象传一次手。
//
// 刻意不 import 'vue'：
//   宿主入口 src/renderer/main.ts 会直接引用本文件，而那边的注释反复强调
//   adminPanel 的那几个 chunk 必须懒加载、不能压在启动路径上。一个 ref 就会把
//   整个 Vue 拽进启动包，所以这里用普通对象 + 回调数组（消费者自己包成 ref）。
//
// 语义：
//   setImportSource()  → 面板没挂载时先存成 pending，onMounted 再取；
//   setImportSource()  → 面板已挂载（订阅者存在）时直接推给它，不留 pending，
//                        避免「先推一次、挂载/激活时又取到一次」重复导入同一份。

export interface ImportSourceEntry {
  /** 文件名（带扩展名）：拖放区显示它，sourceKind 也按后缀判定（这里始终是 .md） */
  name: string
  /** 试卷 Markdown 原文：图片已内嵌成 data URL，自包含，不依赖磁盘 */
  markdown: string
  /** 来源标签，只用于日志与提示（目前只有 PDF 转 md 这一条） */
  from: string
  /** 交接序号：同一份内容再点一次「批量录入」也要能触发一次，消费者按它区分 */
  seq: number
}

type Listener = (entry: ImportSourceEntry) => void

/** 还没人接手的那一份（面板尚未挂载时用） */
let pending: ImportSourceEntry | null = null
/** 自增序号：只涨不回，比较大小无意义，只看变化 */
let seq = 0
/** 已挂载的消费者（导入中心） */
const listeners = new Set<Listener>()

/**
 * 交接一份试卷源码。
 *
 * 面板已经挂载时直接推给订阅者；否则留在 pending 里，等导入中心 onMounted 取。
 * 两条路互斥，同一份只会被消费一次。
 */
export function setImportSource(input: { name: string; markdown: string; from?: string }): void {
  if (!input.markdown.trim()) return
  seq += 1
  const entry: ImportSourceEntry = {
    name: input.name,
    markdown: input.markdown,
    from: input.from ?? '',
    seq
  }
  if (listeners.size > 0) {
    pending = null
    for (const listener of listeners) listener(entry)
    return
  }
  // 连续点两次都以最后一次为准：中间那份没人看过，留着只会多弹一次替换确认
  pending = entry
}

/** 取走还没人接手的那一份（取过即清空） */
export function takeImportSource(): ImportSourceEntry | null {
  const entry = pending
  pending = null
  return entry
}

/** 订阅交接（导入中心挂载时调），返回退订函数 */
export function subscribeImportSource(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
