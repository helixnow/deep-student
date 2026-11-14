-- ============================================================================
-- V20260201: 添加云同步所需字段
-- ============================================================================
-- 
-- 此迁移为 LLM Usage 数据库核心业务表添加云同步字段：
-- - device_id: 设备标识
-- - local_version: 本地版本号（用于冲突检测）
-- - deleted_at: 软删除时间戳（tombstone）
--
-- 注意：llm_usage_daily 已有 updated_at，llm_usage_logs 需要添加。
--
-- 目标表：llm_usage_logs, llm_usage_daily
-- ============================================================================

-- ============================================================================
-- llm_usage_logs 表
-- ============================================================================

ALTER TABLE llm_usage_logs ADD COLUMN device_id TEXT;
ALTER TABLE llm_usage_logs ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE llm_usage_logs ADD COLUMN updated_at TEXT;
ALTER TABLE llm_usage_logs ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_local_version ON llm_usage_logs(local_version);
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_deleted_at ON llm_usage_logs(deleted_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_device_id ON llm_usage_logs(device_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_updated_at ON llm_usage_logs(updated_at);

-- ============================================================================
-- llm_usage_daily 表
-- ============================================================================

ALTER TABLE llm_usage_daily ADD COLUMN device_id TEXT;
ALTER TABLE llm_usage_daily ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE llm_usage_daily ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_local_version ON llm_usage_daily(local_version);
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_deleted_at ON llm_usage_daily(deleted_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_device_id ON llm_usage_daily(device_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_updated_at ON llm_usage_daily(updated_at);

-- ============================================================================
-- 复合索引：支持增量同步查询
-- ============================================================================

-- 按设备和版本查询（用于设备间同步）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_device_version ON llm_usage_logs(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_device_version ON llm_usage_daily(device_id, local_version);

-- 按更新时间查询未删除记录（用于云端增量拉取）
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_updated_not_deleted ON llm_usage_logs(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_updated_not_deleted ON llm_usage_daily(updated_at) WHERE deleted_at IS NULL;
