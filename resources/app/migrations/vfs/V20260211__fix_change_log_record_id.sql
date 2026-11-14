-- ============================================================================
-- V20260210: 修复 questions 表变更日志 record_id
-- ============================================================================
--
-- 旧触发器误将 questions.record_id 写为 exam_id，导致同步回放按主键匹配失败。
-- 本迁移统一改为 questions.id（真实主键）。

DROP TRIGGER IF EXISTS trg__change_log_questions_insert;
DROP TRIGGER IF EXISTS trg__change_log_questions_update;
DROP TRIGGER IF EXISTS trg__change_log_questions_delete;

CREATE TRIGGER IF NOT EXISTS trg__change_log_questions_insert
AFTER INSERT ON questions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('questions', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_questions_update
AFTER UPDATE ON questions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('questions', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_questions_delete
AFTER DELETE ON questions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('questions', OLD.id, 'DELETE');
END;

