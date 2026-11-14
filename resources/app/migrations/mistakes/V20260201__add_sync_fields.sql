-- ============================================================================
-- V20260201: 添加云同步所需字段
-- ============================================================================
-- 
-- 此迁移为 Mistakes 数据库核心业务表添加云同步字段：
-- - device_id: 设备标识
-- - local_version: 本地版本号（用于冲突检测）
-- - deleted_at: 软删除时间戳（tombstone）
--
-- 注意：updated_at 已在 V20260130 初始化迁移中创建，此处只添加新字段。
--
-- 目标表：mistakes, anki_cards, review_analyses
-- ============================================================================

-- ============================================================================
-- mistakes 表
-- ============================================================================

ALTER TABLE mistakes ADD COLUMN device_id TEXT;
ALTER TABLE mistakes ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE mistakes ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_mistakes_local_version ON mistakes(local_version);
CREATE INDEX IF NOT EXISTS idx_mistakes_deleted_at ON mistakes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_mistakes_device_id ON mistakes(device_id);
CREATE INDEX IF NOT EXISTS idx_mistakes_updated_at ON mistakes(updated_at);

-- ============================================================================
-- anki_cards 表
-- ============================================================================

ALTER TABLE anki_cards ADD COLUMN device_id TEXT;
ALTER TABLE anki_cards ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE anki_cards ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_anki_cards_local_version ON anki_cards(local_version);
CREATE INDEX IF NOT EXISTS idx_anki_cards_deleted_at ON anki_cards(deleted_at);
CREATE INDEX IF NOT EXISTS idx_anki_cards_device_id ON anki_cards(device_id);
CREATE INDEX IF NOT EXISTS idx_anki_cards_updated_at ON anki_cards(updated_at);

-- ============================================================================
-- review_analyses 表
-- ============================================================================

ALTER TABLE review_analyses ADD COLUMN device_id TEXT;
ALTER TABLE review_analyses ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE review_analyses ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_review_analyses_local_version ON review_analyses(local_version);
CREATE INDEX IF NOT EXISTS idx_review_analyses_deleted_at ON review_analyses(deleted_at);
CREATE INDEX IF NOT EXISTS idx_review_analyses_device_id ON review_analyses(device_id);
CREATE INDEX IF NOT EXISTS idx_review_analyses_updated_at ON review_analyses(updated_at);

-- ============================================================================
-- 复合索引：支持增量同步查询
-- ============================================================================

-- 按设备和版本查询（用于设备间同步）
CREATE INDEX IF NOT EXISTS idx_mistakes_device_version ON mistakes(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_anki_cards_device_version ON anki_cards(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_review_analyses_device_version ON review_analyses(device_id, local_version);

-- 按更新时间查询未删除记录（用于云端增量拉取）
CREATE INDEX IF NOT EXISTS idx_mistakes_updated_not_deleted ON mistakes(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anki_cards_updated_not_deleted ON anki_cards(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_analyses_updated_not_deleted ON review_analyses(updated_at) WHERE deleted_at IS NULL;
