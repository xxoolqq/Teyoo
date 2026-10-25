// 题卡上的四个操作里，除了「收藏」原版就没绑事件，其余三个的逻辑
// 「我录入的题」和「检索题目」两页一模一样，抽在这里免得两边各写一份、
// 哪天改下载格式只改了一处。
//
// 跳转仍然是面板内开新标签页（路由 + query.id=题号），不是 window.open ——
// 桌面端没有第二个浏览器窗口可开，标签页就是 ctbapp 里那个新窗口的对位物。

import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import type { TopicItem } from '../api/topics'
import { session } from '../stores/session'
import { showSuccess } from '../stores/toast'

/** 管理员账号（ctbapp 里硬编码的同一个值）：可以改任何人的题 */
const ADMIN_USER_CODE = '10028'

/** 「返回列表」能去的地方：检索页（入口页）、「我录入的题」和「我的收藏」 */
export const LIST_PAGE_SEARCH = '/home'
export const LIST_PAGE_MY_TOPIC = '/home/my_topic'
export const LIST_PAGE_MY_FAVORITES = '/home/my_favorites'

/**
 * 详情 / 纠错页的「返回列表」该回哪。
 *
 * 来源页把自己记在 query.from 里（见下面两个跳转函数）—— 从「我录入的题」
 * 点进来的就回「我录入的题」，从检索点进来的回检索。白名单校验：只认这三个，
 * 别的一律回检索页，免得 URL 里写个路径就能把人带到任意页面。
 */
export function listPathOf(route: RouteLocationNormalizedLoaded): string {
  const from = String(route.query.from ?? '')
  if (from === LIST_PAGE_MY_TOPIC) return LIST_PAGE_MY_TOPIC
  if (from === LIST_PAGE_MY_FAVORITES) return LIST_PAGE_MY_FAVORITES
  return LIST_PAGE_SEARCH
}

/** 题号，导出/下载文件名都用它 */
export function topicCode(item: TopicItem): string {
  return String(item.exerciseCode ?? '').trim()
}

/** 解析：打开题目详情标签（单例，换题只换数据）。from 是来源列表页 */
export function goTopicDetail(router: Router, item: TopicItem, from = LIST_PAGE_SEARCH): void {
  void router.push({ path: '/home/detail', query: { id: topicCode(item), from } })
}

/** 纠错：打开纠错标签。调用方若要拦权限，先问 canFixTopic */
export function goTopicFixError(router: Router, item: TopicItem, from = LIST_PAGE_SEARCH): void {
  void router.push({ path: '/home/fix_error', query: { id: topicCode(item), from } })
}

/**
 * 能不能改这道题——照 ctbapp 的规则：自己的题，或管理员。
 *
 * userCode（题目上传者，ES 文档里的字段）缺失时放行：老数据可能没这个字段，
 * 前端不该替后端做最终裁决（fixErrorSubject 那边还有一道校验）。
 */
export function canFixTopic(item: TopicItem): boolean {
  if (session.userCode === ADMIN_USER_CODE) return true
  const owner = String(item.userCode ?? '').trim()
  if (!owner) return true
  return owner === String(session.userCode ?? '').trim()
}

/**
 * 下载：把题干 + 答案拼成一个 .md 文件存到本地。
 *
 * 照 ctbapp 的 doDownload()：内容是「题号<编号>\n<题干>\n<答案>」，
 * 文件名是 <编号>.md，用 blob + <a download> 触发保存。
 */
export function downloadTopic(item: TopicItem): void {
  const no = topicCode(item)
  const subject = String(item.subjectSelf ?? '')
  const answer = String(item.answerSelf ?? '')
  const content = `题号${no}\n${subject}\n${answer}`
  const blob = new Blob([content], { type: 'text/markdown' })
  const objectURL = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectURL
  anchor.download = `${no}.md`
  anchor.click()
  URL.revokeObjectURL(objectURL)
  showSuccess('已下载')
}
