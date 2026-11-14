-- ============================================================================
-- V20260201: 添加云同步所需字段
-- ============================================================================
-- 
-- 此迁移为 VFS 数据库核心业务表添加云同步字段：
-- - device_id: 设备标识
-- - local_version: 本地版本号（用于冲突检测）
-- - deleted_at: 仅为缺少该列的表添加（review_plans）
--
-- 注意：updated_at 和大部分表的 deleted_at 已在 V20260130 初始化迁移中创建。
--
-- 目标表：resources, notes, questions, review_plans, folders
-- ============================================================================

-- ============================================================================
-- resources 表 (已有 updated_at INTEGER, deleted_at INTEGER)
-- ============================================================================

ALTER TABLE resources ADD COLUMN device_id TEXT;
ALTER TABLE resources ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_resources_local_version ON resources(local_version);
CREATE INDEX IF NOT EXISTS idx_resources_device_id ON resources(device_id);
CREATE INDEX IF NOT EXISTS idx_resources_updated_at ON resources(updated_at);

-- ============================================================================
-- notes 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE notes ADD COLUMN device_id TEXT;
ALTER TABLE notes ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_notes_local_version ON notes(local_version);
CREATE INDEX IF NOT EXISTS idx_notes_deleted_at_sync ON notes(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_device_id ON notes(device_id);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);

-- ============================================================================
-- questions 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE questions ADD COLUMN device_id TEXT;
ALTER TABLE questions ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_questions_local_version ON questions(local_version);
CREATE INDEX IF NOT EXISTS idx_questions_device_id ON questions(device_id);
CREATE INDEX IF NOT EXISTS idx_questions_updated_at ON questions(updated_at);

-- ============================================================================
-- review_plans 表 (已有 updated_at TEXT, 需添加 deleted_at)
-- ============================================================================

ALTER TABLE review_plans ADD COLUMN device_id TEXT;
ALTER TABLE review_plans ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE review_plans ADD COLUMN deleted_at TEXT;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_review_plans_local_version ON review_plans(local_version);
CREATE INDEX IF NOT EXISTS idx_review_plans_deleted_at ON review_plans(deleted_at);
CREATE INDEX IF NOT EXISTS idx_review_plans_device_id ON review_plans(device_id);
CREATE INDEX IF NOT EXISTS idx_review_plans_updated_at ON review_plans(updated_at);

-- ============================================================================
-- folders 表 (已有 updated_at TEXT, deleted_at TEXT)
-- ============================================================================

ALTER TABLE folders ADD COLUMN device_id TEXT;
ALTER TABLE folders ADD COLUMN local_version INTEGER DEFAULT 0;

-- 同步查询索引
CREATE INDEX IF NOT EXISTS idx_folders_local_version ON folders(local_version);
CREATE INDEX IF NOT EXISTS idx_folders_device_id ON folders(device_id);
CREATE INDEX IF NOT EXISTS idx_folders_updated_at ON folders(updated_at);

-- ============================================================================
-- 复合索引：支持增量同步查询
-- ============================================================================

-- 按设备和版本查询（用于设备间同步）
CREATE INDEX IF NOT EXISTS idx_resources_device_version ON resources(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_notes_device_version ON notes(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_questions_device_version ON questions(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_review_plans_device_version ON review_plans(device_id, local_version);
CREATE INDEX IF NOT EXISTS idx_folders_device_version ON folders(device_id, local_version);

-- 按更新时间查询未删除记录（用于云端增量拉取）
CREATE INDEX IF NOT EXISTS idx_resources_updated_not_deleted ON resources(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_updated_not_deleted ON notes(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_questions_updated_not_deleted ON questions(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_plans_updated_not_deleted ON review_plans(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_folders_updated_not_deleted ON folders(updated_at) WHERE deleted_at IS NULL;
