import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'

// 家长账号下的孩子：列表 + 新增。
//
// 后端 ChildController 的入参是 ChildArgs（token 放在 body 里，不是只靠请求头）：
//   /background/child/list.do  → data: ChildInfo[]（附当前已通过的主班级）
//   /background/child/add.do   → data: 新生成的 childCode
// 两个接口的 body 都必须带上当前登录用户的 userCode（后端会拿它和 token 对一遍）。

/** 列表里的一行，字段与后端 args/ChildInfo 对应 */
export interface ChildItem {
  childCode: string
  studentName: string
  classLevel: string
  /** 当前已通过的第一个班级，可能为空 */
  classCode?: string
  className?: string
  schoolCode?: string
}

/** 新增孩子的资料，对应后端 ChildArgs 里可选/必填的那几项 */
export interface AddChildPayload {
  /** 必填，后端 ArgsTools.checkName：2~6 个字符 */
  studentName: string
  /** 两位年级码，见 utils/class-level.ts；不填后端也接受 */
  classLevel?: string
  /** 省 / 市 / 区县代码，均为 6 位数字（如山东 370000、临沂 371300、兰山区 371302） */
  province?: string
  city?: string
  country?: string
  gender?: 'male' | 'female'
  /** 身份证号，可不填 */
  cardId?: string
  /** 入学时间，yyyy-MM-dd，可不填（对应 child 表的三个 DATE 列） */
  classOneTime?: string
  classSevenTime?: string
  classTenTime?: string
}

/** 孩子已加入的班级：后端返回 ClassTable（只含已通过审核的入班记录，最多 10 条） */
export interface JoinedChildClass {
  id: number
  classCode: string
  className: string
  classLevel?: string
  schoolCode?: string
  createTime?: string
  [key: string]: unknown
}

/** 查某个孩子已加入的班级（ChildController/ClassController.getChildJoinedClasses） */
export async function fetchChildJoinedClasses(childCode: string): Promise<JoinedChildClass[]> {
  const { data } = await client.post<ApiEnvelope<JoinedChildClass[] | null>>(
    endpoints.childJoinedClasses,
    { childCode }
  )
  return Array.isArray(data.data) ? data.data : []
}

/** 我的孩子列表 */
export async function fetchMyChildren(): Promise<ChildItem[]> {
  const { data } = await client.post<ApiEnvelope<ChildItem[]>>(endpoints.childList, {
    token: session.token,
    userCode: session.userCode
  })
  return Array.isArray(data.data) ? data.data : []
}

/** 新增孩子，返回后端生成的孩子代码（失败由拦截器抛 ApiError） */
export async function addChild(payload: AddChildPayload): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.childAdd, {
    token: session.token,
    userCode: session.userCode,
    ...payload
  })
  return typeof data.data === 'string' ? data.data : ''
}
