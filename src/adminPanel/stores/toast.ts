import { reactive } from 'vue'
import { ApiError } from '../api/common'

// 页面上要有反馈：加载失败、提交成功、token 过期，都得有条看得见的提示。
// 不引 Message 组件库（那会带来一整套全局样式），用一个 30 行的 reactive 队列。

export type ToastKind = 'info' | 'error' | 'success'

export interface ToastItem {
  id: number
  text: string
  kind: ToastKind
}

export const toasts = reactive<ToastItem[]>([])

let seq = 0

function push(text: string, kind: ToastKind): void {
  const id = ++seq
  toasts.push({ id, text, kind })
  // 就在这几分钟停留，自动消失；错误也一样 —— 错误信息留在身边的控制台里，
  // 页面上不做「点掉才消失」的强交互
  window.setTimeout(() => {
    const index = toasts.findIndex((item) => item.id === id)
    if (index >= 0) toasts.splice(index, 1)
  }, 3200)
}

export function showError(text: string): void {
  push(text, 'error')
}

export function showInfo(text: string): void {
  push(text, 'info')
}

/** 成功单独一种：绿色底，扫一眼就知道成了，不用读字 */
export function showSuccess(text: string): void {
  push(text, 'success')
}

/** 把未知异常翻译成一句话：业务失败用后端的 msg，其余用错误自己的描述 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
