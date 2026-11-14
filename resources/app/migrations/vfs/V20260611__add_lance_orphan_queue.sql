-- ============================================================================
-- V20260611: 添加 Lance 孤立向量清理队列（审阅问题 F5）
-- ============================================================================
--
-- 背景：
--   sync_resource_units 在增量同步中删除不再存在的 Units 时，其关联的
--   vfs_index_segments 会被 CASCADE 删除，但对应的 LanceDB 向量
--   （lance_row_id / embedding_id）只打了一条 warn 日志，从未被清理，
--   导致 LanceDB 中累积孤立向量：已删内容仍可被 RAG 检索命中。
--
-- 方案：
--   同步删除 Units 时，把孤立的 lance_row_id 写入本队列（与业务变更同事务）。
--   后台索引循环（process_pending_batch）每轮先排空队列，调用
--   LanceDB delete_by_embedding_ids 真正删除向量。失败递增 retry_count，
--   超过阈值放弃并告警。
--
-- 这个队列是**本地状态**，不参与 __change_log 和云同步机制。
-- ============================================================================

CREATE TABLE IF NOT EXISTS __lance_orphan_queue (
    lance_row_id TEXT PRIMARY KEY,
    resource_id TEXT,
    enqueued_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx__lance_orphan_queue_retry
    ON __lance_orphan_queue(retry_count);
