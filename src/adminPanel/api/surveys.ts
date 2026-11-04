import client from './client'
import { endpoints } from './endpoints'
import { session } from '../stores/session'
import type { ApiEnvelope } from './common'

// 编码映射（后端按「问卷 Survey」存，见 SurveyController#createSurveyMapping）。
// 一条映射 = 映射名 + 所属班级 + 若干「题码-题号」对；每一对在 App 里就是一个
// 是非题（后端固定写 type=3 / isRequired=1）。

/** 一对 题码-题号（后端 CreateSurveyMappingArgs.MappingItem） */
export interface SurveyMappingItem {
  /** 题码，对应 exercise.exercise_code，后端限制 10 个字符以内 */
  exerciseCode: string
  /** 题号，从 1 开始的整数 */
  sortNo: number
}

export interface CreateSurveyMappingInput {
  /** 所属班级编码列表（至少一个，后端字段名是 classCodes） */
  classCodes: string[]
  /** 映射名（后端字段名是 title） */
  title: string
  items: SurveyMappingItem[]
}

/**
 * 列表的一行（后端 SurveyMappingVo）：映射信息 + 所属班级 + 题码-题号对数量。
 * 一行只带一个班级 —— 一份映射发给了几个班，列表里就有几行（同一个 surveyId）。
 * items 是后端顺带查出来的明细（按题号升序），面板右侧的「修改」表单靠它预填。
 */
export interface SurveyMappingRow {
  surveyId: number
  /** 映射名 */
  title: string
  /** 所属班级编码（来自 survey_scope，scope_type=1） */
  classCode?: string
  /** 所属班级名（后端 join class_table，班级被删了会是空） */
  className?: string
  /** 题码-题号对数量 */
  itemCount?: number
  /** 题码-题号明细（旧版后端不带这个字段，前端要能降级） */
  items?: SurveyMappingItem[]
  /** 0 草稿 / 1 已发布 / 2 已停止收集（App 端的问卷状态，面板只读） */
  status?: number
  /** 创建时间：后端是 Date，序列化出来可能是时间戳或日期串，展示前统一格式化 */
  createdAt?: string | number | null
}

export interface SurveyMappingPage {
  list: SurveyMappingRow[]
  total: number
}

/**
 * 新建编码映射。成功返回后端生成的 surveyId（后端没给就是 null）。
 *
 * 后端会自己再查一遍重（题号重复 / 题码重复）、题码是否存在、每个班是否都是当前老师
 * 执教且审核通过的班，失败时 body.code 非 2000，由 client 拦截器抛成 ApiError，msg 直接可读。
 */
export async function createSurveyMapping(input: CreateSurveyMappingInput): Promise<number | null> {
  const { data } = await client.post<ApiEnvelope<{ surveyId?: number } | null>>(
    endpoints.createSurveyMapping,
    {
      // 身份以请求头 token 为准，body 的 userCode 必须与 token 属于同一个人
      userCode: session.userCode,
      classCodes: input.classCodes,
      title: input.title,
      items: input.items
    }
  )
  return data.data?.surveyId ?? null
}

/**
 * 修改编码映射（后端 SurveyController.updateSurveyMapping）：全量提交，不是增量补丁。
 *
 * 入参 UpdateSurveyMappingArgs{ userCode, surveyId, title, classCodes, items }，后端按状态分流：
 * - 草稿：标题 + 班级列表整体替换 + 题对全删重插；
 * - 已发布：只允许改标题，班级列表与题对必须与现值完全一致，改了会被拒绝；
 * - 已停止收集：一律拒绝。
 *
 * 注意：列表接口一「班」一行，同一份映射的班级要由调用方归组后传全，
 * 少传班会被后端判成「班级不可变更」，少传题对等于把原来那几对删了。
 */
export async function updateSurveyMapping(
  surveyId: number,
  input: CreateSurveyMappingInput
): Promise<void> {
  await client.post<ApiEnvelope<null>>(endpoints.updateSurveyMapping, {
    userCode: session.userCode,
    surveyId,
    title: input.title,
    classCodes: input.classCodes,
    items: input.items
  })
}

/**
 * 把自己的班级追加到某份编码映射（后端 SurveyController.addSurveyClass）。
 *
 * 只有已发布（status=1）的映射能加：草稿期创建者还要整体替换班级列表，追加进来会被覆盖。
 * 当前老师必须是该班审核通过的老师；班级已在映射里时后端回「该班级已关联此编码映射」。
 * 加入后的班级归追加的老师管：创建者的列表与统计里不会出现它。
 */
export async function addSurveyMappingClass(surveyId: number, classCode: string): Promise<void> {
  await client.post<ApiEnvelope<null>>(endpoints.addSurveyClass, {
    userCode: session.userCode,
    surveyId,
    classCode
  })
}

/**
 * 分页查自己创建的编码映射（后端 scanSurveyMapping）。
 *
 * 分页口径与 PageHelper 一致（pageNum 从 1 起算，回 { list, total }），
 * 与「我的收藏」「班级管理」用的是同一套 Pagination 组件。
 * 只能查当前登录账号创建的：后端拿 header token 解出 userCode 再比对请求体里的，
 * 不一致直接回业务错误。
 *
 * 一行一个班级：自己关联了几个班，同一份映射就返回几行，total / pages 也按行数计；
 * 别的老师追加的班不会出现在这里。页面展示时要按 surveyId 归组。
 */
export async function fetchSurveyMappings(
  pageNum: number,
  pageSize = 10
): Promise<SurveyMappingPage> {
  const { data } = await client.post<ApiEnvelope<SurveyMappingPage | null>>(
    endpoints.scanSurveyMapping,
    {
      userCode: session.userCode,
      pageNum,
      pageSize
    }
  )
  // 一条都没有时后端回 data: null，按空页处理
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/**
 * 家长提交错题页：分页查孩子所在班级里已发布（status=1）的编码映射。
 *
 * 入参 ScanChildSurveyArgs{ userCode, childCode, pageNum, pageSize }：后端拿 header token
 * 校验 userCode、校验孩子归属，再用孩子已加入的班级去查 survey_scope，所以家长账号只看得到
 * 自己孩子班上的映射；没加入班级或班上没有已发布的映射时回 data:null，按空页处理。
 * 每行都带 items（题码 + 题号，按题号升序），右侧题目列表直接渲染它。
 */
export async function fetchChildPublishedMappings(
  childCode: string,
  pageNum: number,
  pageSize = 10
): Promise<SurveyMappingPage> {
  const { data } = await client.post<ApiEnvelope<SurveyMappingPage | null>>(
    endpoints.childPublishedSurveys,
    {
      userCode: session.userCode,
      childCode,
      pageNum,
      pageSize
    }
  )
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/**
 * 发布编码映射（后端 SurveyController.publishSurveyMapping）：草稿 → 已发布。
 *
 * 入参 PublishSurveyMappingArgs{ userCode, surveyId }，身份以 header token 为准。
 * 后端只放行自己创建的、status=0 的映射：已发布 / 已停止收集 / 别人的都会回业务错误，
 * msg 可直接示人。发布后学生可作答、映射不可再改，调用前该让用户确认过。
 */
export async function publishSurveyMapping(surveyId: number): Promise<void> {
  await client.post<ApiEnvelope<null>>(endpoints.publishSurveyMapping, {
    userCode: session.userCode,
    surveyId
  })
}

/**
 * 统计的一行（后端 SurveyClassStatVo）：一个题码一行。
 * rightRate / wrongRate 是百分数值（如 66.67），分母为已作答数（正确 + 错误），空白不计。
 */
export interface SurveyClassStatRow {
  /** 题号（映射里这一对的位置，从 1 开始） */
  sortNo?: number | null
  /** 题码 */
  exerciseCode?: string
  /** 正确数（bool_value = 1） */
  cntRight?: number
  /** 错误数（bool_value = 0） */
  cntWrong?: number
  /** 空白数（提交了答卷但没答这题） */
  cntBlank?: number
  /** 正确率，百分数值 */
  rightRate?: number
  /** 错误率，百分数值 */
  wrongRate?: number
}

export interface SurveyClassStatPage {
  list: SurveyClassStatRow[]
  total: number
}

/**
 * 按班级统计某份映射每道题的对错（后端 SurveyController.statSurveyByClass）。
 *
 * 入参 StatSurveyByClassArgs{ userCode, surveyId, classCodes[], pageNum, pageSize }：
 * classCodes 不能为空，且每个班都必须是当前老师审核通过的班（user_class 里 user_type=teacher
 * 且 apply_status=agree），否则回「只有该班级的老师才能查看题目统计：xxx」。
 * 不看 survey_scope.added_by：谁把班加进映射只是审计痕迹，同班老师都能统计本班
 * （与班级映射列表 scan/class/survey.do 同口径）。
 * 只统计这些班里审核通过的孩子，没有作答的题码也会列出来（计数 0）。
 * 按题号排序，分页由后端的 PageHelper 处理。
 */
export async function fetchSurveyClassStat(
  surveyId: number,
  classCodes: string[],
  pageNum: number,
  pageSize = 10
): Promise<SurveyClassStatPage> {
  const { data } = await client.post<ApiEnvelope<SurveyClassStatPage | null>>(
    endpoints.statSurveyByClass,
    {
      userCode: session.userCode,
      surveyId,
      classCodes,
      pageNum,
      pageSize
    }
  )
  // 一个题码都没有时后端回 data: null，按空页处理
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}

/**
 * 班级视角的列表一行（后端 ClassSurveyMappingVo）：某个班级关联的一份映射。
 *
 * 与 SurveyMappingRow 的区别：这里没有 classCode / className（班级由查询参数决定）、
 * 也没有题码明细（只有对数 itemCount），但多了「谁创建」「谁把这个班加进来」。
 * 不按创建者过滤：别的老师创建、本班老师按 ID 加入的映射也会出现在这里。
 */
export interface ClassSurveyMappingRow {
  surveyId: number
  /** 映射名 */
  title: string
  /** 0 草稿 / 1 已发布 / 2 已停止收集 */
  status?: number
  /** 题码-题号对数量 */
  itemCount?: number
  /** 创建者编码 */
  creatorUserCode?: string
  /** 创建者姓名（后端 join common_user） */
  creatorRealName?: string
  /** 把本班加进映射的老师编码 */
  addedByUserCode?: string
  /** 把本班加进映射的老师姓名 */
  addedByRealName?: string
  /** 创建时间：可能是日期串 / 10 位秒戳 / 13 位毫秒戳，展示前统一格式化 */
  createdAt?: string | number | null
}

export interface ClassSurveyMappingPage {
  list: ClassSurveyMappingRow[]
  total: number
}

/**
 * 分页查某个班级关联的全部编码映射（后端 scanClassMappings）。
 *
 * 入参 ScanClassSurveyArgs{ userCode, classCode, pageNum, pageSize }，身份以 header token 为准；
 * 当前老师必须是该班审核通过的老师，否则后端回「只有该班级的老师才能查看班级的编码映射」。
 * 一行一份映射（本班在 survey_scope 里只占一行），含草稿 / 已发布 / 已停止 —— 页面按状态置灰动作。
 */
export async function fetchClassSurveyMappings(
  classCode: string,
  pageNum: number,
  pageSize = 10
): Promise<ClassSurveyMappingPage> {
  const { data } = await client.post<ApiEnvelope<ClassSurveyMappingPage | null>>(
    endpoints.scanClassSurvey,
    {
      userCode: session.userCode,
      classCode,
      pageNum,
      pageSize
    }
  )
  // 一份映射都没有时后端回 data: null，按空页处理
  return { list: data.data?.list ?? [], total: data.data?.total ?? 0 }
}
