-- ============================================================================
-- cuotiben 多学科改造 v2 —— 改现有表
-- 前提：先执行 mysql-v2-schema.sql
-- ============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1. exercise 加列 + 补索引
-- ---------------------------------------------------------------------------
ALTER TABLE `exercise`
  ADD COLUMN `term`              VARCHAR(2)  NOT NULL DEFAULT ''  COMMENT '学期：1上 2下，空串=未填' AFTER `class_level`,
  ADD COLUMN `stage`             VARCHAR(8)  NOT NULL DEFAULT ''  COMMENT '学段：primary/junior/senior/other' AFTER `term`,
  ADD COLUMN `subject_type_code` VARCHAR(32) NOT NULL DEFAULT ''  COMMENT '题型代码，指向 subject_type.code' AFTER `stage`,
  ADD COLUMN `source`            VARCHAR(255)         DEFAULT NULL COMMENT '出处' AFTER `answer_self`,
  ADD COLUMN `content_hash`      CHAR(64)    NOT NULL DEFAULT ''  COMMENT '题干归一化哈希，查重用' AFTER `source`,
  ADD COLUMN `update_time`       TIMESTAMP            DEFAULT NULL COMMENT '更新时间' AFTER `create_time`;

-- 补索引：exercise_code 之前居然没有唯一约束
ALTER TABLE `exercise`
  ADD UNIQUE KEY `uk_exercise_code` (`exercise_code`),
  ADD KEY `idx_exercise_course_level` (`course`, `class_level`),
  ADD KEY `idx_exercise_hash` (`content_hash`),
  ADD KEY `idx_exercise_create` (`create_time`);

-- 修正 course 的注释：实际存的是代码，不是「英语数学」这种名字
ALTER TABLE `exercise`
  MODIFY COLUMN `course` VARCHAR(8) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
    DEFAULT NULL COMMENT '科目代码，0001=数学（不是科目名）';

-- ---------------------------------------------------------------------------
-- 2. exercise.test_points 暂不删除
--    原因：Java 后端仍在读写这一列，先删会让线上立刻报错。
--    后端切到 exercise_knowledge_point 之后，再执行 mysql-v2-drop-test-points.sql
-- ---------------------------------------------------------------------------
ALTER TABLE `exercise`
  MODIFY COLUMN `test_points` VARCHAR(255) DEFAULT NULL
    COMMENT '【已废弃】知识点，改用 exercise_knowledge_point；后端切换完成后删除';

-- ---------------------------------------------------------------------------
-- 3. subject_correction 知识点改 JSON
--    纠错工单是待审快照，不需要 join 检索，JSON 足够
-- ---------------------------------------------------------------------------
ALTER TABLE `subject_correction`
  ADD COLUMN `test_points_json` JSON DEFAULT NULL COMMENT '修改后的知识点数组' AFTER `test_points`;

ALTER TABLE `subject_correction`
  MODIFY COLUMN `test_points` VARCHAR(255) DEFAULT NULL
    COMMENT '【已废弃】知识点，改用 test_points_json；后端切换完成后删除';
