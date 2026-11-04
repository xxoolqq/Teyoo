// 本地题库（userData/question-bank.db）的主进程入口。
//
// 分层：
//   schema.ts  建表语句、字典种子数据与版本号（迁移靠 PRAGMA user_version）
//   store.ts   校验、查重、事务写入 + 分页读取 + 字典读取
//
// 调用方：
//   写 —— 导入中心的审查卡（「导入此题」/「导入选中」）
//   读 —— 「本地题库」页（分页浏览、关键词检索、按科目/学段/年级/题型/难度筛选）
//   读 —— 拆题流程（按科目 + 年级范围取知识点词表、判断是否锁公式）

export {
  EASY_LEVELS,
  EASY_OPTIONS,
  importExercise,
  importExercises,
  listDictionaries,
  listExercises,
  listKeyPoints,
  listKnowledgePoints,
  resolveParsePrompts,
  resolveParseSubject,
  shouldLockFormula
} from './store'
export { saveQuestionImage } from './images'
export type { SaveQuestionImageInput, SaveQuestionImageResult } from './images'
export type {
  Dictionaries,
  DictionaryOption,
  ExerciseBatchItem,
  ExerciseBatchResult,
  ExerciseDuplicate,
  ExerciseInput,
  ExerciseKnowledgePointBrief,
  ExerciseListItem,
  ExerciseListQuery,
  ExerciseListResult,
  ExerciseSaveOptions,
  ExerciseSaveResult,
  KnowledgePointOption,
  ParsePromptBlocks,
  ParsePromptResult,
  ParsePromptType,
  ParseSubjectConfig,
  Stage
} from './store'
export { SCHEMA_VERSION } from './schema'
