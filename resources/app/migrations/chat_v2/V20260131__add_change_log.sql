-- ============================================================================
-- V20260131_001: 添加变更日志表（用于增量备份和同步）
-- ============================================================================
-- 
-- 此迁移为 Chat V2 数据库添加 __change_log 表。
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

-- chat_v2_sessions 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_sessions_insert
AFTER INSERT ON chat_v2_sessions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_sessions', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_sessions_update
AFTER UPDATE ON chat_v2_sessions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_sessions', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_sessions_delete
AFTER DELETE ON chat_v2_sessions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_sessions', OLD.id, 'DELETE');
END;

-- chat_v2_messages 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_messages_insert
AFTER INSERT ON chat_v2_messages
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_messages', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_messages_update
AFTER UPDATE ON chat_v2_messages
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_messages', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_messages_delete
AFTER DELETE ON chat_v2_messages
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_messages', OLD.id, 'DELETE');
END;

-- chat_v2_blocks 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_blocks_insert
AFTER INSERT ON chat_v2_blocks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_blocks', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_blocks_update
AFTER UPDATE ON chat_v2_blocks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_blocks', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_blocks_delete
AFTER DELETE ON chat_v2_blocks
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_blocks', OLD.id, 'DELETE');
END;
