-- ============================================================================
-- V20260725: 笔记链接图 note_links（wikilink / note:// 双链）
-- ============================================================================
--
-- 背景：
--   前端 Crepe 编辑器支持 [[target|label]]、[[target#heading]] 与 note://id
--   链接语法，但 VFS 侧没有链接表：反链（backlinks）、未解析链接、
--   未链接提及（unlinked mentions）都无法查询。旧的链接重建逻辑只写
--   legacy notes.db，与 VFS 数据脱节。
--
-- 设计决策：
--   1. note_links 是**派生数据**（可由笔记正文全量重建，见
--      VfsNoteRepo::rebuild_note_links / notes_rebuild_links 命令），
--      因此不进 __change_log 同步覆盖，也不需要 LWW 字段。
--   2. target_id 可空：目标笔记不存在（尚未创建）时保留 target_title，
--      即"未解析链接"。新建/重命名笔记时由触发器自动补解析。
--   3. target_title_norm 是 Rust 侧写入的小写归一化标题（Unicode 感知），
--      用于大小写不敏感匹配；触发器侧用 SQLite LOWER(TRIM(...))（ASCII），
--      非 ASCII 大小写差异的极端情况由全量重建兜底。
--   4. position 为链接在正文中的 UTF-8 字节偏移，(source_id, position)
--      唯一标识一次出现。
--   5. 回填：SQL 无法解析 Markdown，本迁移不回填数据；存量链接由
--      notes_rebuild_links 命令（前端触发或维护任务）全量重建。
--
-- 幂等性：CREATE TABLE/INDEX IF NOT EXISTS；触发器 DROP IF EXISTS 后重建。
-- ============================================================================

CREATE TABLE IF NOT EXISTS note_links (
    -- 链接来源笔记 ID（notes.id）
    source_id TEXT NOT NULL,
    -- 链接在来源正文中的 UTF-8 字节偏移
    position INTEGER NOT NULL,
    -- 解析成功时的目标笔记 ID（notes.id）；未解析为 NULL
    target_id TEXT,
    -- 链接书写时的目标文本（笔记标题或原始 id 串），用于展示与再解析
    target_title TEXT NOT NULL DEFAULT '',
    -- 小写归一化标题（Rust 侧 to_lowercase），用于大小写不敏感匹配
    target_title_norm TEXT NOT NULL DEFAULT '',
    -- [[target#heading]] 的锚点部分
    heading TEXT,
    -- [[target|alias]] 的显示别名
    alias TEXT,
    -- 链接类型：wikilink（[[...]]）或 noteref（note://id）
    link_type TEXT NOT NULL DEFAULT 'wikilink',
    PRIMARY KEY (source_id, position)
);

-- 反链查询：按目标笔记找来源
CREATE INDEX IF NOT EXISTS idx_note_links_target_id
    ON note_links(target_id) WHERE target_id IS NOT NULL;

-- 未解析链接查询 + 新建/重命名笔记时的自动解析
CREATE INDEX IF NOT EXISTS idx_note_links_unresolved
    ON note_links(target_title_norm) WHERE target_id IS NULL;

-- 标题解析辅助：按标题（大小写不敏感，ASCII 范围）找目标笔记
CREATE INDEX IF NOT EXISTS idx_notes_title_nocase
    ON notes(title COLLATE NOCASE);

-- ----------------------------------------------------------------------------
-- 触发器
-- ----------------------------------------------------------------------------

-- 笔记硬删除：清除其出链；指向它的链接降级为未解析（保留标题以便再解析）
DROP TRIGGER IF EXISTS trg_note_links_on_note_delete;
CREATE TRIGGER trg_note_links_on_note_delete
AFTER DELETE ON notes
BEGIN
    DELETE FROM note_links WHERE source_id = OLD.id;
    UPDATE note_links SET target_id = NULL WHERE target_id = OLD.id;
END;

-- 新建笔记：自动解析此前指向该标题的未解析链接
DROP TRIGGER IF EXISTS trg_note_links_resolve_on_insert;
CREATE TRIGGER trg_note_links_resolve_on_insert
AFTER INSERT ON notes
WHEN NEW.deleted_at IS NULL
BEGIN
    UPDATE note_links SET target_id = NEW.id
    WHERE target_id IS NULL
      AND target_title_norm = LOWER(TRIM(NEW.title));
END;

-- 重命名/恢复笔记：同样尝试解析悬空链接。
-- 注意：不主动把旧 target_id 断开 —— 按 id 建立的链接在重命名后依旧有效
-- （wikilink 语义），标题型链接的全量一致性由 notes_rebuild_links 保证。
DROP TRIGGER IF EXISTS trg_note_links_resolve_on_update;
CREATE TRIGGER trg_note_links_resolve_on_update
AFTER UPDATE OF title, deleted_at ON notes
WHEN NEW.deleted_at IS NULL
BEGIN
    UPDATE note_links SET target_id = NEW.id
    WHERE target_id IS NULL
      AND target_title_norm = LOWER(TRIM(NEW.title));
END;
