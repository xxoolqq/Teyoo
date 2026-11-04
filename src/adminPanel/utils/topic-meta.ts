// 「录入题目」与「纠错」两个页面共用的题单元信息：取值项 + 校验。
//
// 取值全部照 ctbapp 的 CommitExercise.vue：科目就是九个中文名（后端不用码）、
// 难易程度是 '1'~'5'、年级名称在 utils/class-level.ts（提交前翻成两位码）。

export const COURSES = ['语文', '数学', '英语', '物理', '化学', '生物', '地理', '政治', '历史']

// ctbapp 的难易程度就是五个光秃秃的数字，界面上没有任何文字说明可抄，
// 所以这里也不替后端发明「1 最易」这类解释 —— 等确认语义再补文案。
export const EASY_LEVELS = ['1', '2', '3', '4', '5']

export interface TopicMeta {
  course: string
  /**
   * 学段码（primary / junior / senior / other）。
   *
   * ctbapp 的提交表单里没有这一项 —— 它只管「从哪个学段的考点树里挑知识点」：
   * key_points 按 (course_code, class_level) 两列筛，不先定学段就不知道该展开哪一支。
   * 因此它参与校验，但**不进提交 payload**（后端要的是 classLevelName 翻出来的年级码）。
   */
  stage: string
  classLevelName: string
  easy: string
  knowledgePoints: string
}

/** 四个选项都不给默认值：填错了比没填更麻烦（ctbapp 也是从空开始） */
export function createMeta(): TopicMeta {
  return { course: '', stage: '', classLevelName: '', easy: '', knowledgePoints: '' }
}

/**
 * 空白检查：'' 与「全是空白」都算没填，一句报错。
 *
 * ctbapp 把这两种情况分成两句（「为空」/「不能全部为空格」）—— 用户要的修正是
 * 「这儿得填东西」，分两句只是换个说法，所以合成一句。
 */
export function blankProblem(value: string, label: string): string | null {
  return value.trim() ? null : `${label}为空`
}

/**
 * 元信息逐项校验，返回第一条问题，全通过返回 null。
 *
 * 顺序与文案照 ctbapp 的 submit()：科目 → 难易程度 → 适用年级 → 知识点。
 * 题目 / 答案两项由页面先查（ctbapp 也是先查习题、答案，再查这几个下拉）。
 *
 * 「学段」是本页新增的一项（ctbapp 没有）：它决定知识点候选从哪一支取，
 * 所以排在适用年级前面 —— 层级由大到小，先学段再年级。
 */
export function firstMetaProblem(meta: TopicMeta): string | null {
  if (!meta.course) return '科目未选择'
  if (!meta.easy) return '难易程度未选择'
  if (!meta.stage) return '学段未选择'
  if (!meta.classLevelName) return '适用年级未选择'
  return blankProblem(meta.knowledgePoints, '知识点')
}
