-- ============================================================================
-- V20260527: 添加本地资产删除队列（用于跨设备删除传播）
-- ============================================================================
--
-- key 使用文件级资产同步清单中的同一命名空间：
--   active/notes_assets/...
--   active/images/...
--   app_data/pdf_ocr_sessions/...
--
-- 该队列是本地状态，不参与 __change_log。
-- ============================================================================

CREATE TABLE IF NOT EXISTS __asset_deletion_queue (
    key TEXT PRIMARY KEY,
    size INTEGER,
    deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
    retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx__asset_deletion_queue_retry
    ON __asset_deletion_queue(retry_count);
