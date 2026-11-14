-- ============================================================================
-- Chat V2: 内容全文搜索 + 会话标签系统
-- ============================================================================

-- ============================================================================
-- 1. 内容全文搜索（FTS5）
-- ============================================================================

-- 消息内容全文搜索虚拟表（独立 FTS5 表，通过触发器与 chat_v2_blocks 同步 rowid）
CREATE VIRTUAL TABLE IF NOT EXISTS chat_v2_content_fts USING fts5(
    content,
    tokenize='unicode61'
);

-- 同步触发器：插入块时自动索引
CREATE TRIGGER IF NOT EXISTS trg_blocks_fts_ai
AFTER INSERT ON chat_v2_blocks
WHEN NEW.content IS NOT NULL AND NEW.content != '' AND NEW.block_type IN ('content', 'thinking')
BEGIN
    INSERT INTO chat_v2_content_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- 同步触发器：更新块内容时重建索引（新内容非空）
CREATE TRIGGER IF NOT EXISTS trg_blocks_fts_au
AFTER UPDATE OF content ON chat_v2_blocks
WHEN NEW.content IS NOT NULL AND NEW.content != '' AND NEW.block_type IN ('content', 'thinking')
BEGIN
    DELETE FROM chat_v2_content_fts WHERE rowid = OLD.rowid;
    INSERT INTO chat_v2_content_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

-- 同步触发器：内容被清空时清理 FTS 索引（防幽灵结果）
CREATE TRIGGER IF NOT EXISTS trg_blocks_fts_au_clear
AFTER UPDATE OF content ON chat_v2_blocks
WHEN (NEW.content IS NULL OR NEW.content = '') AND OLD.block_type IN ('content', 'thinking')
BEGIN
    DELETE FROM chat_v2_content_fts WHERE rowid = OLD.rowid;
END;

-- 同步触发器：删除块时清理索引
CREATE TRIGGER IF NOT EXISTS trg_blocks_fts_ad
AFTER DELETE ON chat_v2_blocks
WHEN OLD.block_type IN ('content', 'thinking')
BEGIN
    DELETE FROM chat_v2_content_fts WHERE rowid = OLD.rowid;
END;

-- 回填已有数据
INSERT OR IGNORE INTO chat_v2_content_fts(rowid, content)
SELECT b.rowid, b.content
FROM chat_v2_blocks b
WHERE b.content IS NOT NULL AND b.content != ''
  AND b.block_type IN ('content', 'thinking');

-- ============================================================================
-- 2. 会话标签系统
-- ============================================================================

CREATE TABLE IF NOT EXISTS chat_v2_session_tags (
    session_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    tag_type TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, tag),
    FOREIGN KEY (session_id) REFERENCES chat_v2_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON chat_v2_session_tags(tag);
CREATE INDEX IF NOT EXISTS idx_session_tags_type ON chat_v2_session_tags(tag_type);

-- 会话表新增 tags_hash 字段（用于防重复提取）
ALTER TABLE chat_v2_sessions ADD COLUMN tags_hash TEXT;
