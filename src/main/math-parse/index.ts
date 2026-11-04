// 试卷拆题（「导入中心 → 开始解析」）的主进程侧入口。
//
// 分层（v2 分科）：
//   prompt.ts     System / User Prompt 构造 —— 公共骨架 + 学科片段
//   lock.ts       公式锁定与还原（只有 lock_formula=1 的科目才跑）
//   parse.ts      主流程：锁 → 调模型 → 解析 JSON → 还原 → 校验 → questions[]
//   catalog.ts    知识点种子数据（只在建库时灌进 knowledge_point 表）
//
// 学科知识不在这里：题型候选与知识点词表由调用方按「科目 + 勾选年级」从 SQLite
// 查出来传进 parsePaperText。加学科不用改这个目录里的任何文件。
//
// 调用方只需要 parsePaperText 与几个类型。

export {
  extractJsonPayload,
  generateAnswerText,
  parsePaperText,
  stripEmbeddedImages
} from './parse'
export type {
  EvidenceSource,
  GenerateAnswerOptions,
  GenerateAnswerResult,
  KnowledgeRole,
  MathParseMeta,
  MathParseOptions,
  MathParseResult,
  MathParseStats,
  ParseConnection,
  ParsedKnowledgePoint,
  ParsedQuestion,
  StripImagesReport
} from './parse'

export { lockVisibleMath, restoreLockedMath, summarizeLock } from './lock'
export type { FormulaKind, LockResult, LockedFormula, RestoreResult } from './lock'

export { KNOWLEDGE_CATALOG, CATALOG_BY_CODE } from './catalog'
export type { CatalogRow, KnowledgePoint } from './catalog'

export { buildSystemPrompt, buildUserMessage } from './prompt'
export type { PromptOption, SystemPromptOptions } from './prompt'
