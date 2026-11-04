import client from './client'
import { endpoints } from './endpoints'
import { clearSession, session } from '../stores/session'
import { API_OK, ApiError, type ApiEnvelope } from './common'

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
  /** 上传者账号（老师或录题员工） */
  userCode: string
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
 * 「题库管理」列表（我录入的题）。
 *
 * 后端是 Spring PageHelper：pageNum 从 1 起算，返回 { list, total }。
 * 这个接口要求把 token 同时放在请求头（client 已统一加）和请求体里。
 */
export async function fetchMyTopics(pageNum: number, pageSize = 10): Promise<TopicPage> {
  const { data } = await client.post<ApiEnvelope<TopicPage>>(endpoints.myTopic, {
    token: session.token,
    userCode: session.userCode,
    pageNum,
    pageSize
  })
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/**
 * 检索能查的字段（MeiliSearchController.matchQuery 的 field）。
 *
 * 后端只接受**单个 field**：内部用 MeiliSearch 的 attributesToSearchOn([field])
 * 把搜索限定在这一个字段上。
 *   - text 字段：subjectSelf / answerSelf —— 分词匹配
 *   - keyword 字段：exerciseCode / course / classLevel / easy / …
 *     取值唯一的字段（科目码、年级码、难度）界面上必须给值域下拉，
 *     不能让用户凭记忆敲 "0001"（数学）或 "07"（七年级）
 * 索引名只有 ctb_index 一个（后端按配置项白名单校验，dev/prod 都是这个名字）。
 */
export type SearchField = 'subjectSelf' | 'answerSelf' | 'exerciseCode' | 'course' | 'classLevel' | 'easy'

export interface SearchParams {
  field: SearchField
  keyphrase: string
  pageNum: number
  pageSize: number
}

export interface SearchResult {
  list: TopicItem[]
  /** 后端不返回 total，只能按「本页取满了」推断还有下一页 */
  hasMore: boolean
}

/**
 * 按关键词检索题目（MeiliSearchController#matchQuery）。
 *
 * 两个和常规接口不一样的地方：
 *   1. data 直接是题目数组，没有 total —— 分页只能靠「本页条数 == pageSize」
 *      推断是否还有下一页；
 *   2. **查不到结果是 code=2001「没有查询到结果」，不是空数组**。这在语义上
 *      是「搜索没有命中」，不该当失败弹红条，所以在这里就地翻成空结果。
 *      MeiliSearch 挂了、字段写错也走同一个 2001（后端统一兜底），错误提示照 msg 原样抛。
 *
 * name 传的是 MeiliSearch 的索引名 ctb_index（后端按 conf.meilisearch.index-name
 * 白名单校验），和 ES 版的 ctbindex 不是一个名字。
 */
export async function searchTopics(params: SearchParams): Promise<SearchResult> {
  try {
    const { data } = await client.post<ApiEnvelope<TopicItem[] | null>>(endpoints.search, {
      name: 'ctb_index',
      field: params.field,
      keyphrase: params.keyphrase,
      pageNum: params.pageNum,
      pageSize: params.pageSize,
      token: session.token
    })
    const list = Array.isArray(data.data) ? data.data : []
    return { list, hasMore: list.length >= params.pageSize }
  } catch (err) {
    // 「没有查询到结果」= 空结果，不是错误（见上面的第 2 点）
    if (err instanceof ApiError && err.code === 2001 && err.message.includes('没有查询到结果')) {
      return { list: [], hasMore: false }
    }
    throw err
  }
}

/**
 * 按题目编号取一道完整题目（详情页 / 纠错页用）。
 *
 * 与 ctbapp 的 FixError.vue mounted() 同一条路：POST 时 body 里的键是
 * exercise_code（下划线），不是 exerciseCode —— 后端 SubjectNeedArgs
 * 就是这么个字段名。
 *
 * 列表接口返回的已经是完整 Exercise（含 subjectHtml / answerSelf 等），
 * 所以只有直接从链接进来、列表缓存里没有时才需要这一步。
 */
export async function fetchTopicByCode(exerciseCode: string): Promise<TopicItem | null> {
  const { data } = await client.post<ApiEnvelope<TopicItem>>(endpoints.getSubjectByExerciseCode, {
    token: session.token,
    exercise_code: exerciseCode
  })
  return data.data ?? null
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

/**
 * 纠错：改一道已经录入的题（后端 fixErrorSubject）。
 *
 * 与新增同一套字段，只是 subjectID 必填（题目编号，后端靠它定位要改哪条）、
 * id 要带上 MySQL 主键 —— 同样是 ctbapp FixError.vue submit() 的原样。
 */
export async function fixErrorSubject(payload: SubmitSubjectPayload & { id: number | null }): Promise<string> {
  const { data } = await client.post<ApiEnvelope<unknown>>(endpoints.fixErrorSubject, payload)
  return data.msg ?? ''
}

/**
 * 提交带图片的题目（后端 MeiliSearchController#addSubjectWithImages）。
 * multipart/form-data：
 *   - args part：application/json 包一份 SubmitSubjectPayload（subjectSelf /
 *     subjectAnswer 里的 base64 图已换成 ctbimg://<图片id> 占位符）
 *   - photos part：每个文件一个 part，文件名必须是 <图片id>.<扩展名>，
 *     图片 id 与 markdown 占位符一一对应（见 utils/topic-images.ts）
 *
 * 不走 axios 实例：实例默认 Content-Type 是 application/json，会盖掉 multipart
 * 的 boundary，Spring 端直接「MediaType 不支持」。fetch + FormData 让浏览器自己
 * 生成 boundary。token 有两道：请求头那道是全局 AuthorizationInterceptor 要的
 * （漏了直接 HTTP 401），args 里的 token 是 Controller 自己校验的第二道。
 */
export async function submitSubjectWithImages(
  payload: SubmitSubjectPayload,
  photos: File[]
): Promise<string> {
  const fd = new FormData()
  fd.append('args', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
  for (const photo of photos) fd.append('photos', photo, photo.name)
  const resp = await fetch(endpoints.submitSubjectWithImages, {
    method: 'POST',
    // 必须带 token 请求头：后端 AuthorizationInterceptor 拦截 /**（只有 sq.do 结尾
    // 的接口豁免），请求头缺 token 直接 HTTP 401，body 里的 args.token 是过了
    // 拦截器之后 Controller 自己校验的第二道。
    headers: { token: payload.token },
    body: fd
  })
  // 拦截器/网关出错时也可能带 JSON body（{code,msg}），尽量按回包解析，拿不到再退回状态码
  let body: ApiEnvelope<unknown>
  try {
    body = (await resp.json()) as ApiEnvelope<unknown>
  } catch {
    throw new Error(`HTTP ${resp.status}`)
  }
  if (body.code === 401) {
    // token 缺失/过期：清掉本地登录态，下一次路由跳转会被门禁送回 /login
    clearSession()
    throw new ApiError(401, '登录已过期，请重新登录')
  }
  if (body.code !== API_OK) throw new ApiError(body.code, body.msg || `请求失败（code ${body.code}）`)
  return body.msg ?? ''
}
