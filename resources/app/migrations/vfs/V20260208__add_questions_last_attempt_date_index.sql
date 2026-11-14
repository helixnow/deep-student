-- ============================================================================
-- V20260208: 为 questions.last_attempt_at 添加日期表达式索引
-- ============================================================================
--
-- 问题（M-040）：多处统计查询使用 DATE(last_attempt_at) 进行过滤和分组，
-- 但缺少对应的索引，大数据量下统计查询慢。
--
-- 影响的查询模式：
--   WHERE DATE(last_attempt_at) >= ? AND DATE(last_attempt_at) <= ?
--   GROUP BY DATE(last_attempt_at)
--
-- 解决方案：创建表达式索引（SQLite 3.9.0+ 支持），直接覆盖 DATE() 表达式。
-- 同时添加 last_attempt_at 的普通索引，加速 IS NOT NULL 过滤。

-- 表达式索引：覆盖 DATE(last_attempt_at) 的范围查询和 GROUP BY
CREATE INDEX IF NOT EXISTS idx_questions_last_attempt_date
    ON questions(DATE(last_attempt_at))
    WHERE last_attempt_at IS NOT NULL AND deleted_at IS NULL;

-- 普通索引：加速 last_attempt_at IS NOT NULL 过滤及排序
CREATE INDEX IF NOT EXISTS idx_questions_last_attempt_at
    ON questions(last_attempt_at)
    WHERE deleted_at IS NULL;
