-- ============================================================================
-- V20260131_001: 添加变更日志表（用于增量备份和同步）
-- ============================================================================
-- 
-- 此迁移为 LLM Usage 数据库添加 __change_log 表。
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

-- llm_usage_logs 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_usage_logs_insert
AFTER INSERT ON llm_usage_logs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('llm_usage_logs', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_usage_logs_update
AFTER UPDATE ON llm_usage_logs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('llm_usage_logs', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_usage_logs_delete
AFTER DELETE ON llm_usage_logs
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('llm_usage_logs', OLD.id, 'DELETE');
END;

-- llm_usage_daily 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_usage_daily_insert
AFTER INSERT ON llm_usage_daily
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('llm_usage_daily', NEW.date || '_' || NEW.caller_type || '_' || NEW.model || '_' || NEW.provider, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_usage_daily_update
AFTER UPDATE ON llm_usage_daily
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('llm_usage_daily', NEW.date || '_' || NEW.caller_type || '_' || NEW.model || '_' || NEW.provider, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_usage_daily_delete
AFTER DELETE ON llm_usage_daily
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('llm_usage_daily', OLD.date || '_' || OLD.caller_type || '_' || OLD.model || '_' || OLD.provider, 'DELETE');
END;
