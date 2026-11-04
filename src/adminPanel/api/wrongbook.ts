import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'

// 错题本：家长账号替名下的孩子批量提交错题。
//
// 后端 CTBRedisPutController.submitSubjects 的入参是 SubmitSubjectsArgs：
//   token 放在 body 里（它读 args.token 校验，不只看请求头）；
//   subjectCodes 是空格分隔的 6 位题码，单次最多 10 个；
//   schoolCode / classLevel / city 的格式各校验一遍，错一项整批拒绝；
//   不存在的题码静默跳过，同一孩子重复提交同一题只把次数 +1。

/** 单次提交上限：后端 set.size() > 10 直接返回业务错误 */
export const SUBMIT_MAX_COUNT = 10

/** 提交错题的入参，字段名与后端 SubmitSubjectsArgs 一一对应 */
export interface SubmitSubjectsPayload {
  childCode: string
  /** 空格分隔的 6 位题码 */
  subjectCodes: string
  /** 班级代码；孩子还没加入班级时传空串，后端只用它落库 */
  classCode: string
  /** 学校代码，4~6 位数字 */
  schoolCode: string
  /** 两位年级码 */
  classLevel: string
  /** 6 位城市码 */
  city: string
}

/**
 * 批量提交错题（POST /background/submit/subjects/sq.do）。
 * 成功时后端不返回数据（code=2000 即成功），失败由拦截器抛 ApiError。
 */
export async function submitSubjects(payload: SubmitSubjectsPayload): Promise<void> {
  await client.post<ApiEnvelope<null>>(endpoints.submitSubjects, {
    token: session.token,
    ...payload
  })
}
