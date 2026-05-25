-- ============================================================================
-- V20260523: 为剩余 Mistakes 表添加云同步字段和变更日志触发器
-- ============================================================================
--
-- 此迁移为 Mistakes 数据库中尚未配备同步设施的表补充：
-- - device_id / local_version 字段
-- - updated_at / deleted_at 字段（仅为缺少的表添加）
-- - __change_log 触发器（INSERT / UPDATE / DELETE）
-- - 增量同步复合索引与部分索引
--
-- 已在前续迁移中覆盖的表（无需重复处理）：
--   mistakes, anki_cards, review_analyses
--
-- 目标表：chat_messages, review_chat_messages, review_sessions,
--         review_session_mistakes
--
-- 注意：chat_messages / review_chat_messages 使用 AUTOINCREMENT 主键，
-- 触发器写入 __change_log 时会将其转为 TEXT（SQLite 自动转换），
-- 回放时 replay 使用该值作为字符串键查找，不会产生跨设备冲突。
-- ============================================================================

-- ============================================================================
-- 1. chat_messages 表 (无 updated_at / deleted_at / device_id / local_version)
-- ============================================================================
-- PK 类型：INTEGER AUTOINCREMENT；触发器写入 TEXT 格式的 record_id。

ALTER TABLE chat_messages ADD COLUMN device_id TEXT;
ALTER TABLE chat_messages ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN updated_at TEXT;
ALTER TABLE chat_messages ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_chat_messages_local_version ON chat_messages(local_version);
CREATE INDEX IF NOT EXISTS idx_chat_messages_deleted_at ON chat_messages(deleted_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_device_id ON chat_messages(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sync_updated_at ON chat_messages(updated_at);

-- ============================================================================
-- 2. review_chat_messages 表 (无 updated_at / deleted_at / device_id / local_version)
-- ============================================================================

ALTER TABLE review_chat_messages ADD COLUMN device_id TEXT;
ALTER TABLE review_chat_messages ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE review_chat_messages ADD COLUMN updated_at TEXT;
ALTER TABLE review_chat_messages ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_review_chat_messages_local_version ON review_chat_messages(local_version);
CREATE INDEX IF NOT EXISTS idx_review_chat_messages_deleted_at ON review_chat_messages(deleted_at);
CREATE INDEX IF NOT EXISTS idx_review_chat_messages_device_id ON review_chat_messages(device_id);
CREATE INDEX IF NOT EXISTS idx_review_chat_messages_sync_updated_at ON review_chat_messages(updated_at);

-- ============================================================================
-- 3. review_sessions 表 (已有 updated_at, 无 deleted_at / device_id / local_version)
-- ============================================================================

ALTER TABLE review_sessions ADD COLUMN device_id TEXT;
ALTER TABLE review_sessions ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE review_sessions ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_review_sessions_local_version ON review_sessions(local_version);
CREATE INDEX IF NOT EXISTS idx_review_sessions_deleted_at ON review_sessions(deleted_at);
CREATE INDEX IF NOT EXISTS idx_review_sessions_device_id ON review_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_review_sessions_sync_updated_at ON review_sessions(updated_at);

-- ============================================================================
-- 4. review_session_mistakes 表 (无 updated_at / deleted_at / device_id / local_version)
-- ============================================================================
-- 复合主键 (session_id, mistake_id)

ALTER TABLE review_session_mistakes ADD COLUMN device_id TEXT;
ALTER TABLE review_session_mistakes ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE review_session_mistakes ADD COLUMN updated_at TEXT;
ALTER TABLE review_session_mistakes ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_local_version ON review_session_mistakes(local_version);
CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_deleted_at ON review_session_mistakes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_device_id ON review_session_mistakes(device_id);
CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_sync_updated_at ON review_session_mistakes(updated_at);

-- ============================================================================
-- 变更日志触发器
-- ============================================================================

-- chat_messages 表触发器（AUTOINCREMENT PK → record_id 写入为 TEXT）
CREATE TRIGGER IF NOT EXISTS trg__change_log_chat_messages_insert
AFTER INSERT ON chat_messages
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_messages', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_chat_messages_update
AFTER UPDATE ON chat_messages
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_messages', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_chat_messages_delete
AFTER DELETE ON chat_messages
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_messages', OLD.id, 'DELETE');
END;

-- review_chat_messages 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_review_chat_messages_insert
AFTER INSERT ON review_chat_messages
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_chat_messages', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_chat_messages_update
AFTER UPDATE ON review_chat_messages
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_chat_messages', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_chat_messages_delete
AFTER DELETE ON review_chat_messages
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_chat_messages', OLD.id, 'DELETE');
END;

-- review_sessions 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_review_sessions_insert
AFTER INSERT ON review_sessions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_sessions', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_sessions_update
AFTER UPDATE ON review_sessions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_sessions', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_sessions_delete
AFTER DELETE ON review_sessions
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_sessions', OLD.id, 'DELETE');
END;

-- review_session_mistakes 表触发器（复合主键，record_id 为 "session_id:mistake_id"）
CREATE TRIGGER IF NOT EXISTS trg__change_log_review_session_mistakes_insert
AFTER INSERT ON review_session_mistakes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_session_mistakes', NEW.session_id || ':' || NEW.mistake_id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_session_mistakes_update
AFTER UPDATE ON review_session_mistakes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_session_mistakes', NEW.session_id || ':' || NEW.mistake_id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_review_session_mistakes_delete
AFTER DELETE ON review_session_mistakes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('review_session_mistakes', OLD.session_id || ':' || OLD.mistake_id, 'DELETE');
END;

-- ============================================================================
-- 复合索引：支持增量同步查询
-- ============================================================================

-- 按设备和版本查询（用于设备间同步）
CREATE INDEX IF NOT EXISTS idx_chat_messages_device_version ON chat_messages(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_review_chat_messages_device_version ON review_chat_messages(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_review_sessions_device_version ON review_sessions(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_device_version ON review_session_mistakes(device_id, local_version);

-- 按更新时间查询未删除记录（用于云端增量拉取）
CREATE INDEX IF NOT EXISTS idx_chat_messages_updated_not_deleted ON chat_messages(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_chat_messages_updated_not_deleted ON review_chat_messages(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_sessions_updated_not_deleted ON review_sessions(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_session_mistakes_updated_not_deleted ON review_session_mistakes(updated_at) WHERE deleted_at IS NULL;
