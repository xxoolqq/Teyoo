import client from './client'
import { endpoints } from './endpoints'
import type { ApiEnvelope } from './common'

// 题海拾贝：按名字查 ID、按条件统计、整包下载、单题取回。
// 请求体字段名与 ctbapp 的 PickShell.vue / PickShellResult.vue / Name2ID.vue
// 一字不差（后端认下划线风格的老字段，不改名）。

/** 名字查 ID 的一行结果（Name2ID 表格的列就是这三个字段） */
export interface IdNameItem {
  name: string
  codeID: string
  /** stu | cls | school | city */
  nameType: string
}

/** 统计结果的一行：题号 + 做对人数（PickShellResult 表格的列） */
export interface ShellRow {
  exerciseCode: string
  exCount: number
}

/** 统计 / 下载共用的查询条件（字段名与 ctbapp 的请求体一字不差） */
export interface ShellQuery {
  /** 两位年级码，'01'~'12' */
  class_level: string
  /** 四位科目码，'0000'~'0008' */
  course: string
  /** stu | cls | school | city */
  field: string
  /** 学生 / 班级 / 学校 / 城市 ID */
  idno: string
  lowscore: string
  highscore: string
  /** YYYY-MM-DD，留空表示不限 */
  starttime: string
  endtime: string
}

export interface ShellPage {
  list: ShellRow[]
  total: number
}

/** 第一步：按领域 + 名字查 ID（ctbapp 里这一步跳 Name2ID 页，这里直接出结果） */
export async function searchIdByName(nameType: string, name: string): Promise<IdNameItem[]> {
  const { data } = await client.post<ApiEnvelope<IdNameItem[]>>(endpoints.pickShellSearchId, {
    nameType,
    name
  })
  return data.data ?? []
}

/** 第二步：条件统计。PageHelper 分页，pageNum 从 1 起算 */
export async function pickShellStats(
  query: ShellQuery,
  pageNum: number,
  pageSize = 10
): Promise<ShellPage> {
  const { data } = await client.post<ApiEnvelope<ShellPage>>(endpoints.pickShell, {
    ...query,
    pageNum,
    pageSize
  })
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/** 整包下载：后端把统计结果拼成 markdown 文本返回，页面负责存成 .md */
export async function pickShellDownloadText(query: ShellQuery): Promise<string> {
  const { data } = await client.post<ApiEnvelope<string>>(endpoints.pickShellDownload, query)
  return data.data ?? ''
}

/**
 * 按题号从 ES 取回源文本（查看弹层与单题下载都用它）。
 * ES 那一路的回包形状与 ctbapp 的用法（response.data.data.subjectSelf）对齐。
 */
export async function fetchShellSubject(exerciseCode: string): Promise<{
  subjectSelf: string
  answerSelf: string
}> {
  const { data } = await client.post<
    ApiEnvelope<{ subjectSelf?: string; answerSelf?: string } | null>
  >(endpoints.getSubjectById, { name: 'ctbindex', _id: exerciseCode })
  return { subjectSelf: data.data?.subjectSelf ?? '', answerSelf: data.data?.answerSelf ?? '' }
}
