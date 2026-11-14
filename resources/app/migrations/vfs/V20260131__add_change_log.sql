-- ============================================================================
-- V20260131_001: 添加变更日志表（用于增量备份和同步）
-- ============================================================================
-- 
-- 此迁移为 VFS 数据库添加 __change_log 表，用于：
-- 1. 增量备份：记录自上次备份以来的数据变更
-- 2. 云同步：记录需要同步的记录
--
-- 设计原则：
-- - 轻量级：仅记录变更元数据，不存储完整数据
-- - 可清理：同步完成后可安全删除旧记录
-- - 索引优化：支持高效查询未同步变更
-- ============================================================================

-- 变更日志表
CREATE TABLE IF NOT EXISTS __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 变更的表名
    table_name TEXT NOT NULL,
    -- 变更的记录 ID（通常是主键值）
    record_id TEXT NOT NULL,
    -- 操作类型：INSERT, UPDATE, DELETE
    operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
    -- 变更时间
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- 同步版本（0 表示未同步）
    sync_version INTEGER DEFAULT 0
);

-- 索引：按同步版本查询
CREATE INDEX IF NOT EXISTS idx__change_log_sync_version ON __change_log(sync_version);

-- 索引：按时间查询
CREATE INDEX IF NOT EXISTS idx__change_log_changed_at ON __change_log(changed_at);

-- 索引：按表名查询
CREATE INDEX IF NOT EXISTS idx__change_log_table_name ON __change_log(table_name);

-- 复合索引：常用查询模式
CREATE INDEX IF NOT EXISTS idx__change_log_table_sync ON __change_log(table_name, sync_version);

-- ============================================================================
-- 触发器：自动记录核心表的变更
-- ============================================================================

-- resources 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_resources_insert
AFTER INSERT ON resources
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('resources', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_resources_update
AFTER UPDATE ON resources
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('resources', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_resources_delete
AFTER DELETE ON resources
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('resources', OLD.id, 'DELETE');
END;

-- notes 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_notes_insert
AFTER INSERT ON notes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('notes', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_notes_update
AFTER UPDATE ON notes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('notes', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_notes_delete
AFTER DELETE ON notes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('notes', OLD.id, 'DELETE');
END;

-- questions 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_questions_insert
AFTER INSERT ON questions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('questions', NEW.exam_id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_questions_update
AFTER UPDATE ON questions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('questions', NEW.exam_id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_questions_delete
AFTER DELETE ON questions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('questions', OLD.exam_id, 'DELETE');
END;

-- review_plans 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_review_plans_insert
AFTER INSERT ON review_plans
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_plans', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_plans_update
AFTER UPDATE ON review_plans
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_plans', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_plans_delete
AFTER DELETE ON review_plans
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_plans', OLD.id, 'DELETE');
END;

-- folders 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_folders_insert
AFTER INSERT ON folders
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('folders', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_folders_update
AFTER UPDATE ON folders
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('folders', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_folders_delete
AFTER DELETE ON folders
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('folders', OLD.id, 'DELETE');
END;
