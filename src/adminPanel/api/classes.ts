import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'

// 班级管理：我的班级列表（分页）、创建班级、修改班级信息、申请加入。
// 请求体字段与 ctbapp 的 NewClass.vue 一字不差；教师码 / 学校码 / userType
// 从 session 取（ctbapp 里是从 localStorage 读的同一批值，session 就是它们的镜像）。

/** 班级列表的一行。后端还回 classLevel、ctime 之类，留个口子防字段演进 */
export interface ClassItem {
  id: number
  classCode: string
  className: string
  [key: string]: unknown
}

export interface ClassPage {
  list: ClassItem[]
  total: number
}

/**
 * 我的班级列表。ctbapp 的 scanListClass 走的是 ulimit（不限量）那一路，
 * 对应本表里的 scanUlimitClassList。
 */
export async function fetchMyClasses(pageNum: number, pageSize = 10): Promise<ClassPage> {
  const { data } = await client.post<ApiEnvelope<ClassPage>>(endpoints.scanUlimitClassList, {
    teacherCode: session.userCode,
    pageNum,
    pageSize
  })
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/** 创建班级。返回后端 msg 当提示文案 */
export async function createMyClass(className: string, classLevel: string): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.createClass, {
    className,
    classLevel,
    teacherCode: session.userCode,
    schoolCode: session.schoolCode
  })
  return data.msg ?? ''
}

/** 修改班级信息（改名 / 改年级），按 ctbapp 需要把 id 与 classCode 一起回传 */
export async function updateMyClass(payload: {
  id: number
  classCode: string
  className: string
  classLevel: string
}): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.updateClassName, {
    id: payload.id,
    classCode: payload.classCode,
    className: payload.className,
    classLevel: payload.classLevel,
    teacherCode: session.userCode
  })
  return data.msg ?? ''
}

/** 申请加入班级（凭班级数字代码） */
export async function applyJoinClass(classCode: string): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.checkJoinApply, {
    classCode,
    userCode: session.userCode,
    userType: session.userType
  })
  return data.msg ?? ''
}

// ── 审核加入（对应 ctbapp Auditing.vue）────────────────────────────────────

/** 加入申请列表的一行 */
export interface ApplyItem {
  /** 后端的主键，审核动作原样回传它 */
  id: number
  studentName: string
  userType: string
  applyStatus: string
  [key: string]: unknown
}

export interface ApplyPage {
  list: ApplyItem[]
  total: number
}

/**
 * 审核页的班级下拉（不分页，后端一次给全）。
 * ctbapp 用的 getClsList 就是 scan/list/class.do 这一路。
 */
export async function fetchClassOptions(): Promise<ClassItem[]> {
  const { data } = await client.post<ApiEnvelope<ClassItem[]>>(endpoints.scanClassList, {
    teacherCode: session.userCode
  })
  return data.data ?? []
}

/** 某班级的加入申请列表。后端在「还没人申请」时回 data: null，按空列表处理 */
export async function fetchJoinApplyList(
  classCode: string,
  pageNum: number,
  pageSize = 10
): Promise<ApplyPage> {
  const { data } = await client.post<ApiEnvelope<ApplyPage | null>>(endpoints.checkJoinList, {
    teacherCode: session.userCode,
    classCode,
    pageNum,
    pageSize
  })
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/**
 * 审核：同意 / 拒绝一条申请。actionType 与 ctbapp 一致（'agree' | 'refused'）。
 * 返回后端 msg 当提示文案。
 */
export async function reviewJoinApply(
  tableID: number,
  userType: string,
  actionType: 'agree' | 'refused'
): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.checkJoinAction, {
    tableID,
    userType,
    actionType,
    teacherCode: session.userCode
  })
  return data.msg ?? ''
}
