-- ============================================================================
-- V20260719: FTS 触发器覆盖 block_type 变更 + 会话列表复合索引
-- ============================================================================
--
-- 1) FTS 触发器缺口（审计 2.4）：
--    V20260301 的 UPDATE 触发器只监听 `UPDATE OF content`，块的 block_type
--    从/向 content|thinking 变更时不会同步 FTS —— 产生幽灵索引（不可见块仍可
--    被搜到）或漏索引（改型后的正文搜不到）。本迁移重建 UPDATE/DELETE 触发器，
--    统一监听 content 与 block_type 两列，并按「NEW 是否可索引」二选一：
--    可索引 -> 删旧插新；不可索引 -> 删除。DELETE 触发器去掉 WHEN 条件，
--    无条件清理 rowid（对不存在的 rowid 删除是无害 no-op），彻底防幽灵。
--
-- 2) 全量重建 FTS：修复触发器缺口期间累积的幽灵/漏索引，回填口径与
--    trg_blocks_fts_ai / repo.rs::rebuild_content_fts 完全一致。
--
-- 3) 复合索引：会话列表高频查询形如
--    `WHERE persist_status = ? ... ORDER BY updated_at DESC LIMIT ?`，
--    单列索引需回表排序；(persist_status, updated_at DESC) 可直接走索引序。
--
-- 幂等性：DROP IF EXISTS + CREATE IF NOT EXISTS + 先清后填，可安全重放。
-- ============================================================================

-- 1. 重建 UPDATE / DELETE 触发器（INSERT 触发器 trg_blocks_fts_ai 语义不变，保留）
DROP TRIGGER IF EXISTS trg_blocks_fts_au;
DROP TRIGGER IF EXISTS trg_blocks_fts_au_clear;
DROP TRIGGER IF EXISTS trg_blocks_fts_ad;

-- 更新后仍可索引（content 非空且类型为 content/thinking）：删旧插新
CREATE TRIGGER IF NOT EXISTS trg_blocks_fts_au
AFTER UPDATE OF content, block_type ON chat_v2_blocks
WHEN NEW.content IS NOT NULL AND NEW.content != '' AND NEW.block_type IN ('content', 'thinking')
BEGIN
    DELETE FROM chat_v2_content_fts WHERE rowid = OLD.rowid;
    INSERT INTO chat_v2_content_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- 更新后不再可索引（内容被清空 或 类型改出 content/thinking）：清理索引
CREATE TRIGGER IF NOT EXISTS trg_blocks_fts_au_clear
AFTER UPDATE OF content, block_type ON chat_v2_blocks
WHEN NEW.content IS NULL OR NEW.content = '' OR NEW.block_type NOT IN ('content', 'thinking')
BEGIN
    DELETE FROM chat_v2_content_fts WHERE rowid = OLD.rowid;
END;

-- 删除块：无条件清理（防历史幽灵条目）
CREATE TRIGGER IF NOT EXISTS trg_blocks_fts_ad
AFTER DELETE ON chat_v2_blocks
BEGIN
    DELETE FROM chat_v2_content_fts WHERE rowid = OLD.rowid;
END;

-- 2. 全量重建 FTS 索引（修复触发器缺口期间的漂移）
DELETE FROM chat_v2_content_fts;
INSERT INTO chat_v2_content_fts(rowid, content)
SELECT b.rowid, b.content
FROM chat_v2_blocks b
WHERE b.content IS NOT NULL AND b.content != ''
  AND b.block_type IN ('content', 'thinking');

-- 3. 会话列表复合索引（persist_status 过滤 + updated_at 排序一步到位）
CREATE INDEX IF NOT EXISTS idx_chat_v2_sessions_status_updated
ON chat_v2_sessions(persist_status, updated_at DESC);
