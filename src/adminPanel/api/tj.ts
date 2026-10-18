import client from './client'
import { endpoints } from './endpoints'
import type { ApiEnvelope } from './common'

// 错题统计：按科目 + 班级 + 时间段统计每道题的错误人数，以及整包导出 markdown。
// 请求体字段名与 ctbapp 的 ClassTJ.vue 一字不差（course / classCode /
// starttime / endtime），后端拿空串当「不限」。

/** 统计结果的一行：题号 + 错误人数（ClassTJ 表格的列） */
export interface ErrorStatRow {
  exerciseCode: string
  exCount: number
}

export interface ErrorStatPage {
  list: ErrorStatRow[]
  total: number
}

/** 统计 / 导出共用的查询条件（字段名与 ctbapp 的请求体一字不差） */
export interface ErrorStatQuery {
  /** 四位科目码，'0000'~'0008'，留空表示不限 */
  course: string
  /** 班级数字代码，留空表示不限 */
  classCode: string
  /** YYYY-MM-DD，留空表示不限 */
  starttime: string
  endtime: string
}

/** 条件统计。PageHelper 分页，pageNum 从 1 起算；后端查无数据时回 data: null，按空列表处理 */
export async function fetchErrorStats(
  query: ErrorStatQuery,
  pageNum: number,
  pageSize = 10
): Promise<ErrorStatPage> {
  const { data } = await client.post<ApiEnvelope<ErrorStatPage | null>>(endpoints.errorSubjectTJ, {
    ...query,
    pageNum,
    pageSize
  })
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/** 导出 markdown：后端把统计结果拼成 markdown 文本返回，页面负责存成 .md */
export async function fetchErrorStatsMd(query: ErrorStatQuery): Promise<string> {
  const { data } = await client.post<ApiEnvelope<string>>(endpoints.exportMdFile, query)
  return data.data ?? ''
}
