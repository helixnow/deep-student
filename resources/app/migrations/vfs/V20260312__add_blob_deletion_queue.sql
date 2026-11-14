-- ============================================================================
-- V20260312: 添加本地 blob 删除队列（用于跨设备删除传播）
-- ============================================================================
--
-- 当 VFS 物理删除一个 blob（ref_count 归零）时，在本表记录一条"待传播"的删除意图。
-- 下次执行云同步时，后端读取这张表，调用 mark_blob_deleted 把删除传播到云端
-- 和其他设备（tombstone 机制）。成功后删除本地这条记录。
--
-- 这个队列是**本地状态**，不参与 __change_log 和云同步的通用机制。
-- ============================================================================

CREATE TABLE IF NOT EXISTS __blob_deletion_queue (
    hash TEXT PRIMARY KEY,
    relative_path TEXT,
    size INTEGER,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- 重试计数：传播失败时递增，超过阈值可放弃
    retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx__blob_deletion_queue_retry
    ON __blob_deletion_queue(retry_count);
