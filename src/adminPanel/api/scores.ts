import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'

// 成绩录入：按科目 + 班级拉学生名单（带最近成绩）、录入一次成绩、查历史成绩。
// 请求体字段名与 ctbapp 的 PutScore.vue 一字不差（user_code / stu_score 这类
// 下划线老字段不改名，后端认的就是它们）。

/** 学生名单的一行（getClsStuCourse 表格的列） */
export interface ScoreStudentRow {
  user_code: string
  real_name: string
  /** 最近一次成绩（150 分制），可能还没有 */
  stu_score: number | string
  [key: string]: unknown
}

export interface ScoreStudentPage {
  list: ScoreStudentRow[]
  total: number
}

/** 按科目 + 班级查学生名单和最近成绩。后端查无数据时回 data: null，按空列表处理 */
export async function fetchClassStudents(
  course: string,
  classCode: string,
  pageNum: number,
  pageSize = 10
): Promise<ScoreStudentPage> {
  const { data } = await client.post<ApiEnvelope<ScoreStudentPage | null>>(
    endpoints.classScores,
    {
      classCode,
      course,
      pageNum,
      pageSize
    }
  )
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/** 录入一次成绩。score 是已折算成 150 分制并四舍五入的整数（ctbapp 的算法） */
export async function addStudentScore(
  studentCode: string,
  course: string,
  score: number
): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.addScore, {
    studentCode,
    teacherCode: session.userCode,
    schoolCode: session.schoolCode,
    course,
    stu_score: score
  })
  return data.msg ?? ''
}

/** 历史成绩的一行（scanScore 返回 {id, stuScore} 数组） */
export interface HistoryScoreItem {
  id: number
  stuScore: number | string
  [key: string]: unknown
}

/** 某学生在某科目的历史成绩列表 */
export async function fetchScoreHistory(
  studentCode: string,
  course: string
): Promise<HistoryScoreItem[]> {
  const { data } = await client.post<ApiEnvelope<HistoryScoreItem[] | null>>(endpoints.scanScore, {
    studentCode,
    teacherCode: session.userCode,
    course
  })
  return data.data ?? []
}
