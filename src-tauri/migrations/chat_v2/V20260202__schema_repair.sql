-- ============================================================================
-- V20260202: Schema 修复迁移
-- ============================================================================
-- 
-- 目的：确保从旧版本升级的数据库具有与新数据库相同的 Schema
--
-- 背景：旧数据库可能缺少某些在 init 脚本中定义但后来添加的表/索引
--       特别是 sleep_block 表用于工作区协作功能
--
-- @skip-check: idempotent_create
-- @skip-check: idempotent_index
-- @skip-check: fk_orphan_cleanup
-- ============================================================================

-- 确保 sleep_block 表存在
CREATE TABLE IF NOT EXISTS sleep_block (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    coordinator_session_id TEXT NOT NULL,
    awaiting_agents TEXT NOT NULL DEFAULT '[]',
    condition_description TEXT,
    timeout_seconds INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    awakened_at TEXT,
    awakened_by TEXT,
    awaken_message TEXT,
    status TEXT NOT NULL DEFAULT 'sleeping',
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (coordinator_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- 确保 sleep_block 表的索引存在
CREATE INDEX IF NOT EXISTS idx_sleep_block_status ON sleep_block(status);
CREATE INDEX IF NOT EXISTS idx_sleep_block_workspace ON sleep_block(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_sleep_block_coordinator ON sleep_block(coordinator_session_id, status);
