// 列表页 → 详情页 / 纠错页的题面传递。
//
// 为什么要这么一层：列表接口返回的每一条本身就是完整的 Exercise（含
// subjectHtml / answerSelf / course / classLevel / easy / testPoints / id），
// 列表已经拿过一遍了，点进去再看一遍纯属浪费 —— 这里按题目编号把它们
// 记下来，详情 / 纠错页按 query 里的 id 直接取。
//
// 取不到（比如直接进了链接、列表没加载过）时，页面自己回退到
// api/topics.fetchTopicByCode 去拉一次，两条路都通。
//
// 这份缓存只在内存里，窗口关掉就没了 —— 与 ctbapp 用 sessionStorage 传数据
// 的生命周期一致（那边刷新也就没了）。

import type { TopicItem } from '../api/topics'

const cache = new Map<string, TopicItem>()

/** 列表加载完顺手记一批，后续详情页直接取 */
export function rememberTopics(items: TopicItem[]): void {
  for (const item of items) {
    const code = String(item.exerciseCode ?? '').trim()
    if (code) cache.set(code, item)
  }
}

/** 按题目编号取之前记下的题；没有返回 null */
export function getCachedTopic(code: string): TopicItem | null {
  return cache.get(String(code ?? '').trim()) ?? null
}
