-- ============================================================================
-- V20260201: 添加云同步所需字段
-- ============================================================================
-- 
-- 此迁移为 Chat V2 数据库核心业务表添加云同步字段：
-- - device_id: 设备标识
-- - local_version: 本地版本号（用于冲突检测）
-- - deleted_at: 软删除时间戳（tombstone）
-- - updated_at: 更新时间戳（仅为缺少此列的表添加）
--
-- 注意：chat_v2_sessions 已有 updated_at，messages 和 blocks 需要添加。
--
-- 目标表：chat_v2_sessions, chat_v2_messages, chat_v2_blocks
-- ============================================================================

-- ============================================================================
-- chat_v2_sessions 表 (已有 updated_at)
-- ============================================================================

ALTER TABLE chat_v2_sessions ADD COLUMN device_id TEXT;
ALTER TABLE chat_v2_sessions ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE chat_v2_sessions ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_local_version ON chat_v2_sessions(local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_deleted_at ON chat_v2_sessions(deleted_at);
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_device_id ON chat_v2_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_sync_updated_at ON chat_v2_sessions(updated_at);

-- ============================================================================
-- chat_v2_messages 表 (无 updated_at，需添加)
-- ============================================================================

ALTER TABLE chat_v2_messages ADD COLUMN device_id TEXT;
ALTER TABLE chat_v2_messages ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE chat_v2_messages ADD COLUMN updated_at TEXT;
ALTER TABLE chat_v2_messages ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_local_version ON chat_v2_messages(local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_deleted_at ON chat_v2_messages(deleted_at);
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_device_id ON chat_v2_messages(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_sync_updated_at ON chat_v2_messages(updated_at);

-- ============================================================================
-- chat_v2_blocks 表 (无 updated_at，需添加)
-- ============================================================================

ALTER TABLE chat_v2_blocks ADD COLUMN device_id TEXT;
ALTER TABLE chat_v2_blocks ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE chat_v2_blocks ADD COLUMN updated_at TEXT;
ALTER TABLE chat_v2_blocks ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_local_version ON chat_v2_blocks(local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_deleted_at ON chat_v2_blocks(deleted_at);
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_device_id ON chat_v2_blocks(device_id);
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_sync_updated_at ON chat_v2_blocks(updated_at);

-- ============================================================================
-- 复合索引：支持增量同步查询
-- ============================================================================

-- 按设备和版本查询（用于设备间同步）
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_device_version ON chat_v2_sessions(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_device_version ON chat_v2_messages(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_device_version ON chat_v2_blocks(device_id, local_version);

-- 按更新时间查询未删除记录（用于云端增量拉取）
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_updated_not_deleted ON chat_v2_sessions(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_v2_messages_updated_not_deleted ON chat_v2_messages(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_v2_blocks_updated_not_deleted ON chat_v2_blocks(updated_at) WHERE deleted_at IS NULL;
