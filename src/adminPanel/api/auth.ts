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
  /**
   * 账号。新接口（login/v1）后端用 ArgsTools.checkPhone 校验，只认 11 位手机号，
   * 旧接口那种「用户 ID 也能登」的用法已经不支持了。
   */
  phone: string
  passwd: string
  codeMa: string
  uuid: string
}

/**
 * 登录返回，与后端 args/ResponseLogin（record）逐项对应。
 *
 * 与旧接口的差别：
 *   - token 直接在 token 字段（旧接口藏在 qq 里）；
 *   - 没有 userType：后端改成 RBAC，用 roles / permissions 区分身份
 *     （LoginRegisterController 的注释：「不再用 confirm / userType 区分家长和老师，
 *     登录后按 RBAC 权限决定能做什么」）；
 *   - schoolCode 有（取自 common_user.school_code，注册时填的那个），
 *     创建班级 / 录题 / 加减分这些老接口还要求它，所以必须进 session。
 */
export interface LoginData {
  id: number
  userCode: string
  phone: string
  passwd: string | null
  email: string
  /** Sa-Token 的 token 值，请求头 token 里带它 */
  token: string
  /** Sa-Token 的 token 名，后端配置 sa-token.token-name=token */
  tokenName: string
  /** 有效秒数（application.yaml 里 timeout: 2592000，30 天） */
  tokenTimeout: number
  realName: string
  createTime: string | null
  city: string
  country: string
  /** 学校代码（4~6 位数字），注册时填的，老接口普遍还要求它 */
  schoolCode: string
  vip: string
  vipExpired: string | null
  confirm: string
  /** 纠错审核人：'yes' / 'no' */
  isReviewer: string
  roles: string[]
  permissions: string[]
  /** 旧版登录态里可能还有 userType，迁移时兼容一下（新接口不返回） */
  userType?: string
  [key: string]: unknown
}

/** 失败会被 client 的拦截器翻成 ApiError，走到这里就一定成功了 */
export async function login(payload: LoginPayload): Promise<LoginData> {
  const { data } = await client.post<ApiEnvelope<LoginData>>(endpoints.login, payload)
  if (!data.data) throw new Error('登录成功了，但后端没返回用户信息')
  return data.data
}

/**
 * 注册入参（后端 RegisterArgs）。与 ctbapp 的 RegisterTeacher.vue 对齐，
 * 只是 userType 由注册页的「类型」单选给（parent / teacher），gender 后端
 * register2/v1 已经不看了，这里不再传。
 *
 * 后端校验口径（ArgsTools）：
 *   phone 11 位手机号；password / passwd 6~18 位且字母数字都要有、且两者相等；
 *   realName 2~6 个字符；mail 6~100 字符；schoolCode 4~6 位数字；codeMa 4 位。
 */
export interface RegisterPayload {
  phone: string
  password: string
  /** 再次输入的密码 */
  passwd: string
  realName: string
  mail: string
  schoolCode: string
  /** 账号类型：教师 / 家长，后端只认这两个值 */
  userType: 'parent' | 'teacher'
  uuid: string
  codeMa: string
}

/**
 * 统一注册（家长 / 教师）。后端成功时把生成的用户代码放在 data 里
 * （Result.success(codeStr)），失败时 msg 是给人看的原因。
 */
export async function register(payload: RegisterPayload): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.register2, payload)
  if (typeof data.data === 'string' && data.data) return data.data
  return data.msg || '注册成功'
}
