import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'

// 成绩录入：按班级拉学生名单、录入一次成绩、查历史成绩。
// 名单走 getClassChildInfo（只认班级），录分 / 历史都按 childCode（孩子）走。

/**
 * 成绩录入页面的学生行：后端 getClassChildInfo 返回的 PageInfo<UserClass>。
 * 注意这里是「家长账号 + 孩子」的组合行：
 *   userCode   → 家长账号
 *   childCode  → 真正入班的孩子（录成绩、查历史都要用这个）
 *   realName   → 联表 child.student_name 得到的孩子姓名
 */
export interface ScoreStudentRow {
  id: number
  classCode: string
  userCode: string
  realName: string
  childCode: string
  userType: string
  applyStatus: string
  [key: string]: unknown
}

export interface ScoreStudentPage {
  list: ScoreStudentRow[]
  total: number
}

/**
 * 按班级查学生名单（成绩录入页「确定」调用 getClassChildInfo）。
 * 后端查不到学生时回 2001「班级内没有学生」，由拦截器抛 ApiError。
 */
export async function fetchClassStudents(
  classCode: string,
  pageNum: number,
  pageSize = 10
): Promise<ScoreStudentPage> {
  const { data } = await client.post<ApiEnvelope<ScoreStudentPage | null>>(
    endpoints.classChildInfo,
    {
      classCode,
      pageNum,
      pageSize
    }
  )
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/** 录入一次成绩。score 是已折算成 150 分制并四舍五入的整数（ctbapp 的算法） */
export async function addStudentScore(
  childCode: string,
  course: string,
  score: number
): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.addScore, {
    childCode,
    userCode: session.userCode,
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
  childCode: string,
  course: string
): Promise<HistoryScoreItem[]> {
  const { data } = await client.post<ApiEnvelope<HistoryScoreItem[] | null>>(endpoints.scanScore, {
    childCode,
    userCode: session.userCode,
    course
  })
  return data.data ?? []
}
