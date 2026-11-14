-- ============================================================================
-- V20260131_001: 添加变更日志表（用于增量备份和同步）
-- ============================================================================
-- 
-- 此迁移为 Mistakes 数据库添加 __change_log 表。
-- ============================================================================

-- 变更日志表
CREATE TABLE IF NOT EXISTS __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx__change_log_sync_version ON __change_log(sync_version);
CREATE INDEX IF NOT EXISTS idx__change_log_changed_at ON __change_log(changed_at);
CREATE INDEX IF NOT EXISTS idx__change_log_table_name ON __change_log(table_name);
CREATE INDEX IF NOT EXISTS idx__change_log_table_sync ON __change_log(table_name, sync_version);

-- ============================================================================
-- 触发器：自动记录核心表的变更
-- ============================================================================

-- mistakes 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_mistakes_insert
AFTER INSERT ON mistakes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('mistakes', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_mistakes_update
AFTER UPDATE ON mistakes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('mistakes', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_mistakes_delete
AFTER DELETE ON mistakes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('mistakes', OLD.id, 'DELETE');
END;

-- anki_cards 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_anki_cards_insert
AFTER INSERT ON anki_cards
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('anki_cards', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_anki_cards_update
AFTER UPDATE ON anki_cards
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('anki_cards', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_anki_cards_delete
AFTER DELETE ON anki_cards
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('anki_cards', OLD.id, 'DELETE');
END;

-- review_analyses 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_review_analyses_insert
AFTER INSERT ON review_analyses
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_analyses', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_analyses_update
AFTER UPDATE ON review_analyses
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_analyses', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_analyses_delete
AFTER DELETE ON review_analyses
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_analyses', OLD.id, 'DELETE');
END;
