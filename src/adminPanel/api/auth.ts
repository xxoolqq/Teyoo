import client from './client'
import { endpoints } from './endpoints'
import type { ApiEnvelope } from './common'

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 验证码用的随机串，与 ctbapp 的 utils/uuidCodeMa.js 同一套（16 位、基数 16） */
export function newCodeMaToken(len = 16, radix = 16): string {
  let out = ''
  for (let i = 0; i < len; i += 1) out += CHARS[Math.floor(Math.random() * radix)]
  return out
}

/** 验证码图片地址：换 uuid 就等于换一张图 */
export function codeMaUrl(uuid: string): string {
  return `${endpoints.codeMa}?d=${encodeURIComponent(uuid)}`
}

export interface LoginPayload {
  /** 手机号或用户 ID */
  phone: string
  passwd: string
  codeMa: string
  uuid: string
}

export interface LoginData {
  /** 后端把 token 放在 qq 字段里（ctbapp 就这么取的，不是笔误） */
  qq: string
  phone: string
  userCode: string
  schoolCode: string
  userType: string
  [key: string]: unknown
}

/** 失败会被 client 的拦截器翻成 ApiError，走到这里就一定成功了 */
export async function login(payload: LoginPayload): Promise<LoginData> {
  const { data } = await client.post<ApiEnvelope<LoginData>>(endpoints.login, payload)
  if (!data.data) throw new Error('登录成功了，但后端没返回用户信息')
  return data.data
}
