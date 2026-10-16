import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'

// 题目的正文是后端渲染好的 HTML（下面的 subjectHtml），前端只负责显示 ——
// 公式、表格、图片到这一步都已经成型。也就绕开了本地 Markdown 渲染这件事：
// 后端给什么就显示什么，这里一行解析都不做。

export interface TopicItem {
  /** 题目编号，列表和详情页都靠它取题 */
  exerciseCode: string
  /** 后端渲染好的题干 HTML */
  subjectHtml?: string
  // 后端返回的字段比这多（ctime、难度、知识点…），留个口子，
  // 免得它哪天加个字段就编译不过
  [key: string]: unknown
}

export interface TopicPage {
  list: TopicItem[]
  total: number
}

/** 提交题目的请求体（后端 add/subject.do） */
export interface SubmitSubjectPayload {
  /** 题干，本地编辑器的 markdown 原文 */
  subjectSelf: string
  /** 答案，同上 */
  subjectAnswer: string
  /** 九个中文科目名之一 */
  course: string
  teacherCode: string
  schoolCode: string
  /** 两位年级码，见 utils/class-level.ts */
  classLevel: string
  /** '1'~'5' */
  easy: string
  knowledgePoints: string
  token: string
  /** 新增时留空 */
  subjectID: string
}

/**
 * 我录入的题。
 *
 * 后端是 Spring PageHelper：pageNum 从 1 起算，返回 { list, total }。
 * 这个接口要求把 token 同时放在请求头（client 已统一加）和请求体里。
 */
export async function fetchMyTopics(pageNum: number, pageSize = 10): Promise<TopicPage> {
  const { data } = await client.post<ApiEnvelope<TopicPage>>(endpoints.myTopic, {
    token: session.token,
    teacherCode: session.userCode,
    pageNum,
    pageSize
  })
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/**
 * 按关键词检索题目。
 *
 * 走的是 8088 那个独立的 ES 服务：GET，关键词放在 keyphrase 查询参数里
 * （endpoints.search 自身已经带了 name=ctbindex&field=subjectSelf），返回的
 * data 直接就是题目数组 —— 没有分页，有多少显示多少。
 *
 * 回包形状按 ctbapp 的用法（response.data.data）写，同时容忍它直接返回数组：
 * 这个服务和 7088 不是同一套程序，我没法凭猜测断言它一定套了 { code, msg, data }。
 */
export async function searchTopics(keyphrase: string): Promise<TopicItem[]> {
  const url = `${endpoints.search}&keyphrase=${encodeURIComponent(keyphrase)}`
  const { data } = await client.get<ApiEnvelope<TopicItem[]>>(url, { skipEnvelopeCheck: true })
  const body = data as unknown
  if (Array.isArray(body)) return body as TopicItem[]
  const list = (body as ApiEnvelope<TopicItem[]> | undefined)?.data
  return Array.isArray(list) ? list : []
}

/**
 * 提交一道题。字段与 ctbapp 的 CommitExercise.vue 一字不差，
 * 含那个提交时固定留空的 subjectID（后端靠它判断是新增而不是修改）。
 *
 * 成功判定的规矩与全站一致（拦截器认 code === 2000），所以这里只负责拿回
 * 后端给的 msg 当作页面上的提示文案；失败会以 ApiError 抛出来，由页面提示。
 */
export async function submitSubject(payload: SubmitSubjectPayload): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.submitSubject, payload)
  return data.msg ?? ''
}
