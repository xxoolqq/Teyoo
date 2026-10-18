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
