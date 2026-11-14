-- ============================================================================
-- V20260527: 添加本地工作区数据库删除队列（用于跨设备删除传播）
-- ============================================================================
--
-- 当本机删除 ws_*.db 后，在此记录待传播的工作区删除 tombstone。
-- 该队列是本地状态，不参与 __change_log。
-- ============================================================================

CREATE TABLE IF NOT EXISTS __workspace_deletion_queue (
    workspace_id TEXT PRIMARY KEY,
    size INTEGER,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
    retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx__workspace_deletion_queue_retry
    ON __workspace_deletion_queue(retry_count);
