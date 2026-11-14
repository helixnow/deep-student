-- ============================================================================
-- 修复 questions_fts 外部内容表触发器（审阅问题 A1）
--
-- 背景：
--   questions_fts 是 content='questions' 的 FTS5 外部内容表。
--   旧触发器在 AFTER UPDATE / AFTER DELETE 中使用普通
--   `DELETE FROM questions_fts WHERE rowid = ...`，
--   这不是 FTS5 外部内容表的合法维护方式——AFTER 触发时内容行已变更/删除，
--   FTS5 反查内容表拿到的是 NEW 值或空值，导致倒排索引逐渐腐化
--   （幽灵结果 / 漏检）。
--
-- 正确模式（SQLite 官方文档）：
--   INSERT INTO fts(fts, rowid, <cols...>) VALUES('delete', OLD.rowid, OLD.<cols...>);
--
-- 本迁移：
--   1. 重建三个触发器为 'delete' 命令模式（携带 OLD 值）；
--   2. 执行 rebuild 一次性修复存量索引；
--   3. rebuild 会索引全部内容行（含软删除），随后将软删除行从索引中移除，
--      恢复"软删除不可搜索"的语义。
-- ============================================================================

DROP TRIGGER IF EXISTS trg_questions_fts_insert;
DROP TRIGGER IF EXISTS trg_questions_fts_update;
DROP TRIGGER IF EXISTS trg_questions_fts_delete;

CREATE TRIGGER trg_questions_fts_insert
AFTER INSERT ON questions
WHEN NEW.deleted_at IS NULL
BEGIN
    INSERT INTO questions_fts(rowid, content, answer, explanation, tags)
    VALUES (NEW.rowid, NEW.content, COALESCE(NEW.answer, ''), COALESCE(NEW.explanation, ''), COALESCE(NEW.tags, '[]'));
END;

-- UPDATE：先用 'delete' 命令携带 OLD 值移除旧文档（仅当旧行曾被索引），
-- 再按 NEW.deleted_at 决定是否重新写入（软删除→移除；恢复→重新索引）。
CREATE TRIGGER trg_questions_fts_update
AFTER UPDATE ON questions
BEGIN
    INSERT INTO questions_fts(questions_fts, rowid, content, answer, explanation, tags)
    SELECT 'delete', OLD.rowid, OLD.content, COALESCE(OLD.answer, ''), COALESCE(OLD.explanation, ''), COALESCE(OLD.tags, '[]')
    WHERE OLD.deleted_at IS NULL;

    INSERT INTO questions_fts(rowid, content, answer, explanation, tags)
    SELECT NEW.rowid, NEW.content, COALESCE(NEW.answer, ''), COALESCE(NEW.explanation, ''), COALESCE(NEW.tags, '[]')
    WHERE NEW.deleted_at IS NULL;
END;

CREATE TRIGGER trg_questions_fts_delete
AFTER DELETE ON questions
BEGIN
    INSERT INTO questions_fts(questions_fts, rowid, content, answer, explanation, tags)
    SELECT 'delete', OLD.rowid, OLD.content, COALESCE(OLD.answer, ''), COALESCE(OLD.explanation, ''), COALESCE(OLD.tags, '[]')
    WHERE OLD.deleted_at IS NULL;
END;

-- 一次性修复存量索引：rebuild 后移除软删除行
INSERT INTO questions_fts(questions_fts) VALUES('rebuild');

INSERT INTO questions_fts(questions_fts, rowid, content, answer, explanation, tags)
SELECT 'delete', rowid, content, COALESCE(answer, ''), COALESCE(explanation, ''), COALESCE(tags, '[]')
FROM questions
WHERE deleted_at IS NOT NULL;
