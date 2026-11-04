-- ============================================================================
-- cuotiben 多学科改造 v2 —— 线上 MySQL 侧
-- 执行顺序：本文件 → mysql-v2-alter.sql
-- 前提：exercise / subject_photo / subject_correction 均已备份（见 .backup-*.sql）
-- ============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1. subject 科目字典
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `subject` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`         VARCHAR(4)      NOT NULL                COMMENT '科目代码，0000=语文 … 0008=政治',
  `name`         VARCHAR(16)     NOT NULL                COMMENT '科目名',
  `lock_formula` TINYINT         NOT NULL DEFAULT 0      COMMENT '拆题时是否锁定公式：1=锁',
  `sort_no`      INT             NOT NULL DEFAULT 0      COMMENT '排序',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_subject_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='科目字典';

INSERT INTO `subject` (`code`, `name`, `lock_formula`, `sort_no`) VALUES
  ('0000', '语文', 0, 1),
  ('0001', '数学', 1, 2),
  ('0002', '英语', 0, 3),
  ('0003', '物理', 1, 4),
  ('0004', '化学', 1, 5),
  ('0005', '生物', 0, 6),
  ('0006', '历史', 0, 7),
  ('0007', '地理', 0, 8),
  ('0008', '政治', 0, 9)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `lock_formula` = VALUES(`lock_formula`), `sort_no` = VALUES(`sort_no`);

-- ---------------------------------------------------------------------------
-- 2. class_level 年级字典
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `class_level` (
  `id`       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`     VARCHAR(3)      NOT NULL              COMMENT '年级代码，01~12，201=其它',
  `name`     VARCHAR(16)     NOT NULL              COMMENT '年级名',
  `stage`    VARCHAR(8)      NOT NULL              COMMENT 'primary/junior/senior/other',
  `sort_no`  INT             NOT NULL DEFAULT 0    COMMENT '排序',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_class_level_code` (`code`),
  KEY `idx_class_level_stage` (`stage`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='年级字典';

INSERT INTO `class_level` (`code`, `name`, `stage`, `sort_no`) VALUES
  ('01', '一年级',     'primary', 1),
  ('02', '二年级',     'primary', 2),
  ('03', '三年级',     'primary', 3),
  ('04', '四年级',     'primary', 4),
  ('05', '五年级',     'primary', 5),
  ('06', '六年级',     'primary', 6),
  ('07', '七年级（初一）', 'junior', 7),
  ('08', '八年级（初二）', 'junior', 8),
  ('09', '九年级（初三）', 'junior', 9),
  ('10', '十年级（高一）', 'senior', 10),
  ('11', '十一年级（高二）', 'senior', 11),
  ('12', '十二年级（高三）', 'senior', 12),
  ('201', '其它',      'other',  99)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `stage` = VALUES(`stage`), `sort_no` = VALUES(`sort_no`);

-- ---------------------------------------------------------------------------
-- 3. subject_type 题型字典
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `subject_type` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`         VARCHAR(32)     NOT NULL            COMMENT '题型代码，全局唯一',
  `subject_code` VARCHAR(4)      NOT NULL            COMMENT '所属科目',
  `name`         VARCHAR(32)     NOT NULL            COMMENT '题型名',
  `sort_no`      INT             NOT NULL DEFAULT 0  COMMENT '排序',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_subject_type_code` (`code`),
  KEY `idx_subject_type_subject` (`subject_code`, `sort_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='题型字典';

INSERT INTO `subject_type` (`code`, `subject_code`, `name`, `sort_no`) VALUES
  ('single_choice',   '0001', '单选题', 1),
  ('multi_choice',    '0001', '多选题', 2),
  ('fill_in_blank',   '0001', '填空题', 3),
  ('detailed_answer', '0001', '解答题', 4)
ON DUPLICATE KEY UPDATE `subject_code` = VALUES(`subject_code`), `name` = VALUES(`name`), `sort_no` = VALUES(`sort_no`);

-- ---------------------------------------------------------------------------
-- 4. knowledge_point 知识点
--    code 规则：{科目码}_{4位序号}，不含年级（知识点会挪年级，编号不能跟着变）
--    class_level / term 用空串而非 NULL：NULL 在唯一索引里互不冲突，会导致重名
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `knowledge_point` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`         VARCHAR(32)     NOT NULL              COMMENT '稳定业务键，0001_0012',
  `subject_code` VARCHAR(4)      NOT NULL              COMMENT '所属科目',
  `class_level`  VARCHAR(3)      NOT NULL DEFAULT ''   COMMENT '年级，空串=未归类',
  `term`         VARCHAR(2)      NOT NULL DEFAULT ''   COMMENT '1=上学期 2=下学期，空串=未归类',
  `name`         VARCHAR(64)     NOT NULL              COMMENT '知识点名',
  `sort_no`      INT             NOT NULL DEFAULT 0    COMMENT '排序',
  `enabled`      TINYINT         NOT NULL DEFAULT 1    COMMENT '是否启用',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_knowledge_point_code` (`code`),
  UNIQUE KEY `uk_knowledge_point_name` (`subject_code`, `class_level`, `term`, `name`),
  KEY `idx_knowledge_point_scope` (`subject_code`, `class_level`, `enabled`, `sort_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识点';

-- ---------------------------------------------------------------------------
-- 5. exercise_knowledge_point 题目 ↔ 知识点
--    用 exercise_id 关联（本地 code 可空），知识点用 code 关联（两边唯一）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `exercise_knowledge_point` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `exercise_id`          BIGINT UNSIGNED NOT NULL           COMMENT '题目本地/线上自增 id',
  `knowledge_point_code` VARCHAR(32)     NOT NULL           COMMENT '知识点业务键',
  `position`             INT             NOT NULL DEFAULT 0 COMMENT '顺序，0 为主知识点',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_exercise_kp` (`exercise_id`, `knowledge_point_code`),
  KEY `idx_exercise_kp_code` (`knowledge_point_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='题目与知识点关联';
