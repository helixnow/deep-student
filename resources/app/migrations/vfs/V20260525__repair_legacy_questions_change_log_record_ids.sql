-- ============================================================================
-- V20260525: 修复旧版 questions 变更日志中的 record_id
-- ============================================================================
--
-- V20260131 中 questions 的 __change_log 触发器曾误把 record_id 写成 exam_id。
-- V20260211 修复了新触发器，但已经留在 __change_log 里的未同步旧记录仍无法按
-- questions.id 读取完整行数据。
--
-- 这里把受影响 exam 下仍存在的题目重新排队为 UPDATE，并删除无法按 questions.id
-- 解析的旧 pending 记录。旧 DELETE 记录只包含 exam_id，无法可靠还原具体题目 id；
-- 删除这些坏记录可以防止后续上传损坏增量。
-- ============================================================================

INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
SELECT 'questions', repair.question_id, 'UPDATE', repair.changed_at, 0
FROM (
    SELECT q.id AS question_id, MAX(bad.changed_at) AS changed_at
    FROM __change_log AS bad
    JOIN questions AS q
      ON q.exam_id = bad.record_id
    WHERE bad.table_name = 'questions'
      AND bad.sync_version = 0
      AND NOT EXISTS (
          SELECT 1
          FROM questions AS existing
          WHERE existing.id = bad.record_id
      )
    GROUP BY q.id
) AS repair
WHERE NOT EXISTS (
    SELECT 1
    FROM __change_log AS existing_log
    WHERE existing_log.table_name = 'questions'
      AND existing_log.record_id = repair.question_id
      AND existing_log.sync_version = 0
);

DELETE FROM __change_log
WHERE table_name = 'questions'
  AND sync_version = 0
  AND NOT EXISTS (
      SELECT 1
      FROM questions
      WHERE questions.id = __change_log.record_id
  );
