// 后端约定的统一响应壳：{ code, msg, data }。
//
// 放在这里是刻意的 —— client.ts 和 auth.ts 都要用它，而 auth.ts 又要 import
// client.ts，常量留在上层才不会绕成环。

/** code === 2000 才是成功，其余一律看 msg */
export const API_OK = 2000

export interface ApiEnvelope<T> {
  code: number
  msg?: string
  data?: T
}

/** 业务失败：接口通了，但后端说不行（验证码错、没权限、…），msg 是给人看的 */
export class ApiError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
