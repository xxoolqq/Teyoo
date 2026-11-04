import type { SurveyMappingItem } from '../api/surveys'

// 「题码-题号」对的整理与查重。抽成纯函数是为了能单独跑（页面里只剩一行调用）：
// 规则与后端 SurveyController#createSurveyMapping 一一对应 —— 前端先拦一遍，
// 省一次往返，报错也能指到具体第几条、哪个值重复。

/** 题码长度上限（后端 CreateSurveyMappingArgs 的校验：trim 后 ≤ 10） */
export const MAX_EXERCISE_CODE_LENGTH = 10


/** 编辑中的一行：题码 + 题号都是字符串，提交时才转成数字 */
export interface MappingDraft {
  questionCode: string
  serial: string
}

export interface MappingValidation {
  /** 校验通过时的 items；不通过是空数组 */
  items: SurveyMappingItem[]
  /** 第一条错误（给人看的一句话）；通过时为 null */
  error: string | null
  /** 需要在界面上标红的题码（重复的那个值） */
  dupCodes: string[]
  /** 需要在界面上标红的题号（重复的那个值，原样字符串） */
  dupNos: string[]
}

/** 失败结果：把重复值一并带出去，页面据此标红 */
function failure(message: string, dupCode?: string, dupNo?: string): MappingValidation {
  return {
    items: [],
    error: message,
    dupCodes: dupCode ? [dupCode] : [],
    dupNos: dupNo ? [dupNo] : []
  }
}

/**
 * 把草稿行折成后端要的 `{ exerciseCode, sortNo }[]`，顺带查重。
 *
 * 规则：
 * - 题码、题号都空的一整行忽略；只填一半算错（别把半条存进去）；
 * - 题号是从 1 开始的整数；
 * - 题码不超过 10 个字符；
 * - **同一次提交里题号不能重复、题码不能重复** —— 两条都成立时「题码-题号」对
 *   自然也不会重复，所以在「对」这一层不用再查一遍；
 * - 至少有一条。
 */
export function validateMappingDrafts(drafts: readonly MappingDraft[]): MappingValidation {
  const items: SurveyMappingItem[] = []
  // 值 → 首次出现在第几条（1 起），报错时能指出是哪两条撞了
  const codeSeen = new Map<string, number>()
  const noSeen = new Map<number, number>()

  for (const [index, draft] of drafts.entries()) {
    const questionCode = draft.questionCode.trim()
    const serial = draft.serial.trim()
    const ordinal = `第 ${index + 1} 条子映射`

    if (!questionCode && !serial) continue
    if (!questionCode) return failure(`${ordinal}缺少题码`)
    if (!serial) return failure(`${ordinal}缺少题号`)
    if (questionCode.length > MAX_EXERCISE_CODE_LENGTH) {
      return failure(`${ordinal}的题码不能超过 ${MAX_EXERCISE_CODE_LENGTH} 个字符`)
    }
    if (!/^\d+$/.test(serial)) return failure(`${ordinal}的题号必须是整数`)
    const sortNo = Number(serial)
    if (sortNo < 1) return failure(`${ordinal}的题号从 1 开始`)

    const codeHit = codeSeen.get(questionCode)
    if (codeHit !== undefined) {
      return failure(`题码重复：${questionCode}（第 ${codeHit} 条与${ordinal}）`, questionCode)
    }
    const noHit = noSeen.get(sortNo)
    if (noHit !== undefined) {
      return failure(`题号重复：${sortNo}（第 ${noHit} 条与${ordinal}）`, undefined, serial)
    }

    codeSeen.set(questionCode, index + 1)
    noSeen.set(sortNo, index + 1)
    items.push({ exerciseCode: questionCode, sortNo })
  }

  if (items.length === 0) return failure('请至少添加一条题码-题号')
  return { items, error: null, dupCodes: [], dupNos: [] }
}
