-- ============================================================================
-- V20260207: 统一 resources.deleted_at 值为 TEXT（ISO 8601）
-- ============================================================================
--
-- 背景：resources.deleted_at 声明为 INTEGER（毫秒时间戳），
-- 其他表（notes/questions/folders）声明为 TEXT（ISO 8601）。
--
-- SQLite 是动态类型：列声明只是 affinity hint，实际可存任意类型。
-- 直接 UPDATE 现有 INTEGER 值为 TEXT 格式即可统一，
-- 无需 CREATE-COPY-SWAP（那会触发 FK constraint failed）。

UPDATE resources
SET deleted_at = datetime(deleted_at / 1000, 'unixepoch') || 'Z'
WHERE deleted_at IS NOT NULL
  AND typeof(deleted_at) != 'text';
