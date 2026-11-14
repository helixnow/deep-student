-- ============================================================================
-- V20260523: 为剩余 Chat V2 表添加云同步字段和变更日志触发器
-- ============================================================================
--
-- 此迁移为 Chat V2 数据库中尚未配备同步设施的表补充：
-- - device_id / local_version 字段
-- - updated_at / deleted_at 字段（仅为缺少的表添加）
-- - __change_log 触发器（INSERT / UPDATE / DELETE）
-- - 增量同步复合索引与部分索引
--
-- 已在前续迁移中覆盖的表（无需重复处理）：
--   chat_v2_sessions, chat_v2_messages, chat_v2_blocks
--
-- 目标表：chat_v2_attachments, resources, chat_v2_session_mistakes,
--         chat_v2_session_groups, workspace_index
-- ============================================================================

-- ============================================================================
-- 1. chat_v2_attachments 表 (已有 created_at, 无 updated_at / deleted_at)
-- ============================================================================

ALTER TABLE chat_v2_attachments ADD COLUMN device_id TEXT;
ALTER TABLE chat_v2_attachments ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE chat_v2_attachments ADD COLUMN updated_at TEXT;
ALTER TABLE chat_v2_attachments ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_local_version ON chat_v2_attachments(local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_deleted_at ON chat_v2_attachments(deleted_at);
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_device_id ON chat_v2_attachments(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_sync_updated_at ON chat_v2_attachments(updated_at);

-- ============================================================================
-- 2. resources 表 (已有 created_at INTEGER, 无 updated_at / deleted_at)
-- ============================================================================
-- 注意：此表是 chat_v2 数据库自有的 resources 表，与 vfs.resources 无关。

ALTER TABLE resources ADD COLUMN device_id TEXT;
ALTER TABLE resources ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE resources ADD COLUMN updated_at TEXT;
ALTER TABLE resources ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_resources_local_version ON resources(local_version);
CREATE INDEX IF NOT EXISTS idx_resources_deleted_at ON resources(deleted_at);
CREATE INDEX IF NOT EXISTS idx_resources_device_id ON resources(device_id);
CREATE INDEX IF NOT EXISTS idx_resources_sync_updated_at ON resources(updated_at);

-- ============================================================================
-- 3. chat_v2_session_mistakes 表 (已有 created_at, 无 updated_at / deleted_at)
-- ============================================================================

ALTER TABLE chat_v2_session_mistakes ADD COLUMN device_id TEXT;
ALTER TABLE chat_v2_session_mistakes ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE chat_v2_session_mistakes ADD COLUMN updated_at TEXT;
ALTER TABLE chat_v2_session_mistakes ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_mistakes_local_version ON chat_v2_session_mistakes(local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_mistakes_deleted_at ON chat_v2_session_mistakes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_mistakes_device_id ON chat_v2_session_mistakes(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_mistakes_sync_updated_at ON chat_v2_session_mistakes(updated_at);

-- ============================================================================
-- 4. chat_v2_session_groups 表 (已有 updated_at, 无 deleted_at)
-- ============================================================================

ALTER TABLE chat_v2_session_groups ADD COLUMN device_id TEXT;
ALTER TABLE chat_v2_session_groups ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE chat_v2_session_groups ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_local_version ON chat_v2_session_groups(local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_deleted_at ON chat_v2_session_groups(deleted_at);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_device_id ON chat_v2_session_groups(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_sync_updated_at ON chat_v2_session_groups(updated_at);

-- ============================================================================
-- 5. workspace_index 表 (已有 updated_at, 无 deleted_at; PK 为 workspace_id)
-- ============================================================================

ALTER TABLE workspace_index ADD COLUMN device_id TEXT;
ALTER TABLE workspace_index ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE workspace_index ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_workspace_index_local_version ON workspace_index(local_version);
CREATE INDEX IF NOT EXISTS idx_workspace_index_deleted_at ON workspace_index(deleted_at);
CREATE INDEX IF NOT EXISTS idx_workspace_index_device_id ON workspace_index(device_id);
CREATE INDEX IF NOT EXISTS idx_workspace_index_sync_updated_at ON workspace_index(updated_at);

-- ============================================================================
-- 变更日志触发器
-- ============================================================================

-- chat_v2_attachments 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_attachments_insert
AFTER INSERT ON chat_v2_attachments
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_attachments', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_attachments_update
AFTER UPDATE ON chat_v2_attachments
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_attachments', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_attachments_delete
AFTER DELETE ON chat_v2_attachments
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_attachments', OLD.id, 'DELETE');
END;

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

-- chat_v2_session_mistakes 表触发器（复合主键，record_id 为 "session_id:mistake_id"）
CREATE TRIGGER IF NOT EXISTS trg__change_log_session_mistakes_insert
AFTER INSERT ON chat_v2_session_mistakes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_session_mistakes', NEW.session_id || ':' || NEW.mistake_id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_session_mistakes_update
AFTER UPDATE ON chat_v2_session_mistakes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_session_mistakes', NEW.session_id || ':' || NEW.mistake_id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_session_mistakes_delete
AFTER DELETE ON chat_v2_session_mistakes
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_session_mistakes', OLD.session_id || ':' || OLD.mistake_id, 'DELETE');
END;

-- chat_v2_session_groups 表触发器
CREATE TRIGGER IF NOT EXISTS trg__change_log_session_groups_insert
AFTER INSERT ON chat_v2_session_groups
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_session_groups', NEW.id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_session_groups_update
AFTER UPDATE ON chat_v2_session_groups
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_session_groups', NEW.id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_session_groups_delete
AFTER DELETE ON chat_v2_session_groups
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('chat_v2_session_groups', OLD.id, 'DELETE');
END;

-- workspace_index 表触发器（PK 列名为 workspace_id）
CREATE TRIGGER IF NOT EXISTS trg__change_log_workspace_index_insert
AFTER INSERT ON workspace_index
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('workspace_index', NEW.workspace_id, 'INSERT');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_workspace_index_update
AFTER UPDATE ON workspace_index
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('workspace_index', NEW.workspace_id, 'UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS trg__change_log_workspace_index_delete
AFTER DELETE ON workspace_index
BEGIN
    INSERT INTO __change_log (table_name, record_id, operation)
    VALUES ('workspace_index', OLD.workspace_id, 'DELETE');
END;

-- ============================================================================
-- 复合索引：支持增量同步查询
-- ============================================================================

-- 按设备和版本查询（用于设备间同步）
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_device_version ON chat_v2_attachments(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_resources_device_version ON resources(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_mistakes_device_version ON chat_v2_session_mistakes(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_device_version ON chat_v2_session_groups(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_workspace_index_device_version ON workspace_index(device_id, local_version);

-- 按更新时间查询未删除记录（用于云端增量拉取）
CREATE INDEX IF NOT EXISTS idx_chat_v2_attachments_updated_not_deleted ON chat_v2_attachments(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_resources_updated_not_deleted ON resources(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_mistakes_updated_not_deleted ON chat_v2_session_mistakes(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_v2_session_groups_updated_not_deleted ON chat_v2_session_groups(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_index_updated_not_deleted ON workspace_index(updated_at) WHERE deleted_at IS NULL;
