-- ============================================================================
-- 第二阶段：后端完全切到 exercise_knowledge_point 之后再执行
-- 执行前提（缺一不可）：
--   1. Java 端的 Exercise 实体已不再读写 test_points
--   2. 上传接口已改为接收 knowledge_point_codes 数组
--   3. 纠错接口已改用 test_points_json
--   4. MeiliSearch ctb_index 已用 knowledge_point_codes 重建完成
-- ============================================================================

SET NAMES utf8mb4;

-- 删列前先确认没有残留数据
-- SELECT COUNT(*) FROM exercise WHERE test_points IS NOT NULL AND test_points <> '';
-- SELECT COUNT(*) FROM subject_correction WHERE test_points IS NOT NULL AND test_points <> '';

ALTER TABLE `exercise` DROP COLUMN `test_points`;
ALTER TABLE `subject_correction` DROP COLUMN `test_points`;
