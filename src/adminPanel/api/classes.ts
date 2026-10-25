import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'

// 班级管理：我的班级列表（分页）、创建班级、修改班级信息、申请加入。
// 请求体字段与 ctbapp 的 NewClass.vue 一字不差；教师码 / 学校码 / userType
// 从 session 取（ctbapp 里是从 localStorage 读的同一批值，session 就是它们的镜像）。

/**
 * 班级列表的一行（后端 TeacherClassVo：ClassTable + applyStatus + memberRole）。
 * 列表同时包含「自己创建的」和「自己申请过的」班级，后者可能还在审核中。
 */
export interface ClassItem {
  id: number
  classCode: string
  className: string
  classLevel?: string
  createTime?: string
  /** 当前登录老师在该班的状态：agree 已通过 / applying 审核中 / refused 已拒绝 */
  applyStatus?: string
  /** 1 = 成员，2 = 管理员（自己创建的班级是 2） */
  memberRole?: number
  [key: string]: unknown
}

export interface ClassPage {
  list: ClassItem[]
  total: number
}

/**
 * 我的班级列表（ClassController.scanListClass，分页）。
 * 后端已换成 TeacherClassVo：自己创建的 + 自己以教师身份申请过的（含 applying），
 * 所以每行都带 applyStatus，页面据此区分「已加入」和「审核中」。
 */
export async function fetchMyClasses(pageNum: number, pageSize = 10): Promise<ClassPage> {
  const { data } = await client.post<ApiEnvelope<ClassPage | null>>(endpoints.scanClassList, {
    token: session.token,
    userCode: session.userCode,
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
    userCode: session.userCode,
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
    userCode: session.userCode
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

/**
 * 家长把孩子加入班级（ClassController.joinClassStep02，App 的 step2）。
 * 与上面的教师申请不同：必须带上孩子的 childCode，后端会校验这个孩子属于当前账号，
 * 然后以家长账号 + childCode 往 user_class 插一条 apply_status='applying' 的记录。
 * token 后端要从 body 里读，所以除了请求头之外再放一份。
 */
export async function joinChildToClass(classCode: string, childCode: string): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.joinClassStep2, {
    token: session.token,
    classCode,
    childCode
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
 * 班级下拉（成绩录入 / 错题统计 / 审核加入 / 提交错题任务共用的那一份）。
 * 后端 scanListClass 已经改成分页回 PageInfo，不再是「一次给全」的数组：
 * 这里用一个大 pageSize 一次取完（老师名下班级不会有几十上百个），
 * 并剔掉还在审核中的班级——那会儿老师还没进班，录成绩 / 审核都用不上。
 */
export async function fetchClassOptions(): Promise<ClassItem[]> {
  const { data } = await client.post<ApiEnvelope<ClassPage | null>>(endpoints.scanClassList, {
    token: session.token,
    userCode: session.userCode,
    pageNum: 1,
    pageSize: 200
  })
  const list = data.data?.list ?? []
  return list.filter((item) => item.applyStatus !== 'applying')
}

/** 某班级的加入申请列表。后端在「还没人申请」时回 data: null，按空列表处理 */
export async function fetchJoinApplyList(
  classCode: string,
  pageNum: number,
  pageSize = 10
): Promise<ApplyPage> {
  const { data } = await client.post<ApiEnvelope<ApplyPage | null>>(endpoints.checkJoinList, {
    userCode: session.userCode,
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
    userCode: session.userCode
  })
  return data.msg ?? ''
}
