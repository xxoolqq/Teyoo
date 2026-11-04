// docx-image-store.ts 的浏览器替身。
//
// 与 canvas-shim.ts 同一套手法：vite.webview2.config.ts 把 './docx-image-store'
// 别名到本文件，于是 docx-import.ts 那份源码一行不用改 —— 它在 Word 任务窗格
// 里照样 import 这个模块，但拿到的实现永远返回 null，图片退回 mammoth 的
// data URI 内嵌（页面里本来也没有文件系统可写）。
//
// 签名必须与真身一致，否则 tsconfig 与调用方会对不上。

export function resolveImagesDir(workDir: string): string {
  return `${workDir.replace(/\/+$/, '')}/images`
}

export async function storeDocxImage(
  _mime: string,
  _bytes: Uint8Array,
  _overrideDir?: string,
): Promise<string | null> {
  return null
}

/** 编辑器插图落盘：任务窗格没有文件系统，永远返回 null（调用方退回内嵌） */
export async function storeEditorImage(
  _mime: string,
  _bytes: Uint8Array,
): Promise<string | null> {
  return null
}
