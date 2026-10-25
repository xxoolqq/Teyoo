import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'

// 纠错审核（对应后端 SubjectCorrectionController）：待审列表、工单详情、审核动作。
// 与 classes.ts 同一套写法：教师码从 session 取；业务失败在 client 拦截器里翻成
// ApiError，页面只管 try/catch。

/** 纠错工单一行（后端 SubjectCorrection 实体原样返回）。时间字段是 JSON 序列化的 Date */
export interface CorrectionItem {
  id: number
  /** 题目编号 */
  exerciseCode: string
  submitterCode: string
  /** teacher / student */
  submitterType: string
  /** 修改后的题干 md；null 表示提交人没改这一项 */
  subjectSelf: string | null
  /** 修改后的答案 md；null 表示没改 */
  answerSelf: string | null
  /** 修改后的知识点；null 表示没改 */
  testPoints: string | null
  /** 纠错原因说明 */
  reason: string
  status: string
  reviewerCode: string | null
  reviewComment: string | null
  reviewTime: string | null
  createTime: string
}

export interface CorrectionPage {
  list: CorrectionItem[]
  total: number
}

/** 待审核工单列表。submitterCode 传当前教师码，后端校验 is_reviewer */
export async function fetchCorrectionPendingList(
  pageNum: number,
  pageSize = 10
): Promise<CorrectionPage> {
  const { data } = await client.post<ApiEnvelope<CorrectionPage>>(endpoints.correctionPendingList, {
    token: session.token,
    submitterCode: session.userCode,
    pageNum,
    pageSize
  })
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/** 工单详情 */
export async function fetchCorrectionDetail(correctionId: number): Promise<CorrectionItem> {
  const { data } = await client.post<ApiEnvelope<CorrectionItem>>(endpoints.correctionDetail, {
    token: session.token,
    correctionId
  })
  return data.data as CorrectionItem
}

/**
 * 审核一条工单。action：'approve' 通过 / 'reject' 驳回；comment 为审核意见。
 * 返回后端 msg 当提示文案（通过时可能带"冲突已阻断"等失败信息 —— 那种情况
 * 后端回 2001，在拦截器里直接抛 ApiError，走不到 return）。
 */
export async function reviewCorrection(
  correctionId: number,
  action: 'approve' | 'reject',
  comment: string
): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.correctionReview, {
    token: session.token,
    reviewerCode: session.userCode,
    correctionId,
    action,
    comment
  })
  return data.msg ?? ''
}
