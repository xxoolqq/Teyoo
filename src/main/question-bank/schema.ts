// 本地题库的建表语句与版本号。
//
// v2 起本地表名、字段名与线上 MySQL 完全对齐（只差类型），同步时不需要任何字段映射。
//
//   本地 SQLite           线上 MySQL
//   subject               subject
//   class_level           class_level
//   subject_type          subject_type
//   knowledge_point       knowledge_point
//   exercise              exercise
//   exercise_knowledge_point  exercise_knowledge_point
//
// 线上多一张 subject_photo：本地图片直接落在磁盘、路径写在题干 Markdown 里，
// 不需要「题目 → 图片」的关联表。
//
// 跨表关联的两条规矩：
//   · 字典之间用 code（知识点、科目、年级、题型），两边值必须一模一样；
//   · 题目内部用各自的 id，因为本地 exercise_code 在未上传时是 NULL。
//
// 增量升级：递增 SCHEMA_VERSION，在 store 的 migrate 里加一段，已经导过题的库
// 不能被 DROP 重建。

export const SCHEMA_VERSION = 4

export const DDL_V1 = `
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  answer_markdown TEXT NOT NULL DEFAULT '',
  question_type TEXT NOT NULL,
  category_compulsory TEXT NOT NULL,
  category_chapter TEXT NOT NULL,
  category_knowledge TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL,
  source TEXT,
  image_paths TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_content_hash ON questions (content_hash);
CREATE INDEX IF NOT EXISTS idx_questions_category
  ON questions (category_compulsory, category_chapter, category_knowledge);

CREATE TABLE IF NOT EXISTS question_knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  point_code TEXT NOT NULL,
  point_name TEXT NOT NULL,
  role TEXT NOT NULL,
  position INTEGER NOT NULL,
  evidence_source TEXT,
  evidence TEXT,
  target_evidence TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  scope TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_question_knowledge_points
  ON question_knowledge_points (question_id, point_code);
CREATE INDEX IF NOT EXISTS idx_question_knowledge_points_code
  ON question_knowledge_points (point_code);
`

/**
 * v2 建表。只建新表，不碰旧表 —— 数据搬迁由 store 里的 migrateV2 负责。
 *
 * class_level / term 两列一律用空串表示「没填」，不用 NULL：
 * knowledge_point 上有 UNIQUE(subject_code, class_level, term, name)，
 * 而 NULL 在 SQLite 的唯一索引里互不冲突，用 NULL 会让同名的未归类知识点重复插入。
 *
 * exercise.exercise_code 反过来必须用 NULL：它同时是「有没有上传过」的判据
 * （IS NULL = 没传），而且确实需要多行都是 NULL。
 */
export const DDL_V2 = `
CREATE TABLE IF NOT EXISTS subject (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lock_formula INTEGER NOT NULL DEFAULT 0,
  sort_no INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS class_level (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  stage TEXT NOT NULL,
  sort_no INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_class_level_stage ON class_level (stage, sort_no);

CREATE TABLE IF NOT EXISTS subject_type (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  subject_code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_no INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_subject_type_subject
  ON subject_type (subject_code, sort_no);

CREATE TABLE IF NOT EXISTS knowledge_point (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  subject_code TEXT NOT NULL,
  class_level TEXT NOT NULL DEFAULT '',
  term TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  sort_no INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_point_name
  ON knowledge_point (subject_code, class_level, term, name);
CREATE INDEX IF NOT EXISTS idx_knowledge_point_scope
  ON knowledge_point (subject_code, class_level, enabled, sort_no);

CREATE TABLE IF NOT EXISTS exercise (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise_code TEXT UNIQUE,
  course TEXT NOT NULL DEFAULT '',
  user_code TEXT NOT NULL DEFAULT '',
  school_code TEXT NOT NULL DEFAULT '',
  class_level TEXT NOT NULL DEFAULT '',
  term TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  subject_type_code TEXT NOT NULL DEFAULT '',
  easy TEXT NOT NULL DEFAULT '3',
  subject_self TEXT NOT NULL,
  answer_self TEXT NOT NULL DEFAULT '',
  source TEXT,
  content_hash TEXT NOT NULL DEFAULT '',
  is_public TEXT,
  ack TEXT,
  uuid TEXT,
  create_time INTEGER NOT NULL,
  update_time INTEGER NOT NULL,
  sync_error TEXT,
  synced_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_exercise_create ON exercise (create_time DESC);
CREATE INDEX IF NOT EXISTS idx_exercise_hash ON exercise (content_hash);
CREATE INDEX IF NOT EXISTS idx_exercise_scope ON exercise (course, class_level);

CREATE TABLE IF NOT EXISTS exercise_knowledge_point (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exercise_id INTEGER NOT NULL REFERENCES exercise (id) ON DELETE CASCADE,
  knowledge_point_code TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_exercise_knowledge_point
  ON exercise_knowledge_point (exercise_id, knowledge_point_code);
CREATE INDEX IF NOT EXISTS idx_exercise_knowledge_point_code
  ON exercise_knowledge_point (knowledge_point_code);
`

/** 字典初始数据：科目 9 行 */
export const SEED_SUBJECT = `
INSERT OR IGNORE INTO subject (code, name, lock_formula, sort_no) VALUES
  ('0000', '语文', 0, 1),
  ('0001', '数学', 1, 2),
  ('0002', '英语', 0, 3),
  ('0003', '物理', 1, 4),
  ('0004', '化学', 1, 5),
  ('0005', '生物', 0, 6),
  ('0006', '历史', 0, 7),
  ('0007', '地理', 0, 8),
  ('0008', '政治', 0, 9);
`

/** 字典初始数据：年级 13 行 */
export const SEED_CLASS_LEVEL = `
INSERT OR IGNORE INTO class_level (code, name, stage, sort_no) VALUES
  ('01', '一年级', 'primary', 1),
  ('02', '二年级', 'primary', 2),
  ('03', '三年级', 'primary', 3),
  ('04', '四年级', 'primary', 4),
  ('05', '五年级', 'primary', 5),
  ('06', '六年级', 'primary', 6),
  ('07', '七年级（初一）', 'junior', 7),
  ('08', '八年级（初二）', 'junior', 8),
  ('09', '九年级（初三）', 'junior', 9),
  ('10', '十年级（高一）', 'senior', 10),
  ('11', '十一年级（高二）', 'senior', 11),
  ('12', '十二年级（高三）', 'senior', 12),
  ('201', '其它', 'other', 99);
`

/**
 * v3：提示词表。
 *
 * 列名与约束照抄使用者已经建好的表（列全可空、没有唯一键），不要"顺手"加
 * NOT NULL 或 UNIQUE —— 已存在的库不会重建，加了约束两边就不一致了；
 * 幂等由写入侧的 `WHERE NOT EXISTS` 保证。
 */
export const DDL_V3 = `
CREATE TABLE IF NOT EXISTS prompt_table (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "prompt" text,
  "create_time" text,
  "stage" text,
  "course" text,
  "prompt_type" text
);
`

/** 字典初始数据：题型（先只给数学，别的学科用到再加） */
export const SEED_SUBJECT_TYPE = `
INSERT OR IGNORE INTO subject_type (code, subject_code, name, sort_no) VALUES
  ('single_choice',   '0001', '单选题', 1),
  ('multi_choice',    '0001', '多选题', 2),
  ('fill_in_blank',   '0001', '填空题', 3),
  ('detailed_answer', '0001', '解答题', 4);
`
