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

-- 确保 sleep_block 表存在（与 V20260130__init.sql 保持一致）
CREATE TABLE IF NOT EXISTS sleep_block (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    coordinator_session_id TEXT NOT NULL,
    awaiting_agents TEXT NOT NULL DEFAULT '[]',
    wake_condition TEXT NOT NULL DEFAULT '{"type":"result_message"}',
    status TEXT NOT NULL DEFAULT 'sleeping',
    timeout_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    awakened_at TEXT,
    awakened_by TEXT,
    awaken_message TEXT,
    message_id TEXT,
    block_id TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspace_index(workspace_id) ON DELETE CASCADE
);

-- 确保 sleep_block 表的索引存在
CREATE INDEX IF NOT EXISTS idx_sleep_block_status ON sleep_block(status);
CREATE INDEX IF NOT EXISTS idx_sleep_block_workspace ON sleep_block(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_sleep_block_coordinator ON sleep_block(coordinator_session_id, status);
