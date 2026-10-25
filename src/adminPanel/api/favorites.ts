import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'
import type { TopicItem, TopicPage } from './topics'

// 我的收藏。后端 FavoriteController 三个接口里的两个（status 批量查询是
// 移动端列表标星用的，面板的收藏页本身就是「已收藏」列表，用不上）。

/** 收藏条目：题目全字段（同 TopicItem）+ 收藏时间 */
export interface FavoriteItem extends TopicItem {
  /** 收藏时间（后端 favorite_exercise.create_time，ISO 时间戳或日期字符串） */
  favoriteTime?: string
}

/**
 * 我的收藏分页（后端 favorite/list.do）。
 *
 * 后端按 (user_code, user_type, exercise_code) 唯一约束保证一条题只有一条
 * 收藏记录；分页同 PageHelper 口径（pageNum 从 1 起算，返回 { list, total }）。
 * 面板是教师端，userType 固定 'teacher'。
 */
export async function fetchFavorites(pageNum: number, pageSize = 10): Promise<TopicPage> {
  const { data } = await client.post<ApiEnvelope<TopicPage>>(endpoints.favoriteList, {
    token: session.token,
    userCode: session.userCode,
    userType: 'teacher',
    pageNum,
    pageSize
  })
  return { list: (data.data?.list ?? []) as TopicItem[], total: data.data?.total ?? 0 }
}

/**
 * 收藏 / 取消收藏（后端 favorite/toggle.do）。
 *
 * 返回值就是后端的 data：true = 本次收藏上了，false = 本次取消掉了。
 * 超 200 条上限时后端返回 2001（走 axios 拦截器抛 ApiError，由页面提示）。
 */
export async function toggleFavorite(exerciseCode: string): Promise<boolean> {
  const { data } = await client.post<ApiEnvelope<boolean>>(endpoints.favoriteToggle, {
    token: session.token,
    userCode: session.userCode,
    userType: 'teacher',
    exerciseCode
  })
  return data.data === true
}

/**
 * 批量查询收藏状态（后端 favorite/status.do）。
 *
 * 返回这批题号里已收藏的那部分（data=字符串数组）。列表页加载后调一次，
 * 就能把「收藏」按钮摆到正确的初始状态（已收藏的显示「已收藏」）。
 * 空列表直接短路：后端对空 exerciseCodes 返回 2001，没必要打这一趟。
 */
export async function fetchFavoriteStatus(exerciseCodes: string[]): Promise<Set<string>> {
  if (exerciseCodes.length === 0) return new Set()
  const { data } = await client.post<ApiEnvelope<string[]>>(endpoints.favoriteStatus, {
    token: session.token,
    userCode: session.userCode,
    userType: 'teacher',
    exerciseCodes
  })
  return new Set(Array.isArray(data.data) ? data.data : [])
}
