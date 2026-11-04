// 年级名称 → 后端用的两位数字码。
//
// 后端（以及 ctbapp 的 ArgsTool.getClassLevel）认的是码，界面认的是名称，
// 所以提交前必须翻译一次。映射表与 ArgsTool.getClassLevel 一字不差。

const CODE_BY_NAME: Record<string, string> = {
  一年级: '01',
  二年级: '02',
  三年级: '03',
  四年级: '04',
  五年级: '05',
  六年级: '06',
  七年级_初一: '07',
  八年级: '08',
  九年级: '09',
  十年级_高一: '10',
  十一年级: '11',
  十二年级: '12'
}

/** 后端下拉里年级的写法就是这 12 项（七年级_初一 这种是后端自己起的名字） */
export const CLASS_LEVEL_NAMES = Object.keys(CODE_BY_NAME)

/**
 * 两位码 → 年级名称，classLevelCode 的反向。
 *
 * 「纠错」页要把已有题目回显到元信息表单上，而后端给的是码（Exercise.classLevel），
 * 表单用的是 name —— 得先翻回 name，否则提交时又会掉到 '201' 兜底值上。
 */
const NAME_BY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(CODE_BY_NAME).map(([name, code]) => [code, name])
)

/** 认不出来的一律返回空串（调用方按「没选」处理），不猜 */
export function classLevelName(code: string): string {
  return NAME_BY_CODE[String(code ?? '').trim()] ?? ''
}

// ── 跨年级：学段码直接当年级值 ────────────────────────────────────────────────
//
// 本地题库里，class_level 除了年级码还接受学段码：
//   senior → 跨年级，整个高中；junior → 整个初中；primary → 整个小学
// 导入中心选了哪个学段，审查卡的「跨年级」就写哪个值。空串保留给「未指定学段」
// 的历史数据 —— 两种都要能显示成人话。

export const STAGE_CODES = ['primary', 'junior', 'senior', 'other'] as const

/**
 * 学段下拉的选项（录入弹窗用）。值就是库里 key_points.class_level 的取值，
 * 与导入中心的学段选择同一口径；「其它」= other。
 */
export const STAGE_OPTIONS = [
  { value: 'primary', label: '小学' },
  { value: 'junior', label: '初中' },
  { value: 'senior', label: '高中' },
  { value: 'other', label: '其它' }
] as const

const STAGE_LABELS: Record<string, string> = {
  primary: '小学',
  junior: '初中',
  senior: '高中',
  other: '其它'
}

/** 这个年级值是不是学段码（= 跨年级写法） */
export function isStageCode(value: string): boolean {
  return (STAGE_CODES as readonly string[]).includes(String(value ?? '').trim())
}

/**
 * 年级值 → 界面文字：年级码给年级名，学段码给「跨年级（高中）」，
 * 其余原样返回（不认识的码别吞掉，否则界面看着像没填）。
 */
export function classLevelLabel(code: string): string {
  const value = String(code ?? '').trim()
  if (!value) return ''
  if (isStageCode(value)) return `跨年级（${STAGE_LABELS[value] ?? value}）`
  return NAME_BY_CODE[value] ?? value
}

/** 学段码 → 「高中」这类短标签（给下拉选项文案拼「跨年级（高中）」用） */
export function stageLabelOf(code: string): string {
  return STAGE_LABELS[String(code ?? '').trim()] ?? ''
}

/**
 * 年级名称 → 学段码。
 *
 * 「纠错」页回显历史题目时只有年级（甚至只有年级码），没有学段；而知识点候选
 * 必须按学段取，回显后得先补一个，否则一打开抽屉就是「请先选学段」。
 * 认不出来返回空串（调用方按「没选」处理，让人自己选，不猜）。
 */
export function stageByClassName(name: string): string {
  const index = CLASS_LEVEL_NAMES.indexOf(String(name ?? '').trim())
  if (index < 0) return ''
  if (index <= 5) return 'primary'
  if (index <= 8) return 'junior'
  return 'senior'
}

/**
 * 年级下拉的统一数据源（题海拾贝、创建班级等页面的 <select> 都用它，
 * 不在各页里各抄一份）。value 是两位码，label 是界面写法「七年级（初一）」，
 * 与 ctbapp 页面下拉一字不差。
 */
export const CLASS_LEVEL_OPTIONS = [
  { value: '01', label: '一年级' },
  { value: '02', label: '二年级' },
  { value: '03', label: '三年级' },
  { value: '04', label: '四年级' },
  { value: '05', label: '五年级' },
  { value: '06', label: '六年级' },
  { value: '07', label: '七年级（初一）' },
  { value: '08', label: '八年级（初二）' },
  { value: '09', label: '九年级（初三）' },
  { value: '10', label: '十年级（高一）' },
  { value: '11', label: '十一年级（高二）' },
  { value: '12', label: '十二年级（高三）' }
] as const

/** 认不出来的一律落到 '201' —— 与 ctbapp 的兜底值保持一致，别自己发明新值 */
export function classLevelCode(name: string): string {
  return CODE_BY_NAME[name] ?? '201'
}
