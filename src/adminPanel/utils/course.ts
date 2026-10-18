// 科目下拉的统一数据源（错题统计、题海拾贝等页面的 <select> 都用它，
// 不在各页里各抄一份）。value 是后端认的四位科目码，label 与 ctbapp 的
// ClassTJ.vue / PickShell.vue 下拉一字不差。
export const COURSE_OPTIONS = [
  { value: '0000', label: '语文' },
  { value: '0001', label: '数学' },
  { value: '0002', label: '英语' },
  { value: '0003', label: '物理' },
  { value: '0004', label: '化学' },
  { value: '0005', label: '生物' },
  { value: '0006', label: '历史' },
  { value: '0007', label: '地理' },
  { value: '0008', label: '政治' }
] as const
