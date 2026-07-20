-- ============================================================================
-- V20260722: 笔记规范化标签表 note_tags
-- ============================================================================
--
-- 背景（审计报告 04-backend.md P1-3）：
--   笔记标签存在 notes.tags（JSON 数组），list_tags 需要全表扫描 + 逐行解析 JSON，
--   标签过滤使用 `tags LIKE %"tag"%` 有假阳性。本迁移引入规范化映射表。
--
-- 注意：主库（非 VFS）存在同名 legacy note_tags 表，但两者位于不同的数据库文件
-- （主库 db vs vfs.db），互不冲突；legacy 表仅剩非 VFS 死路径在写。
--
-- 维护方式：触发器（而非 Rust 写路径），确保覆盖所有写入者
-- （VfsNoteRepo create/update/restore、云同步、数据修复），且与 notes 行变更同事务。
--
-- json_each 对非法 JSON 会直接报错并中断事务，因此统一用
-- CASE WHEN json_valid(...) 守卫（历史数据可能存在非法 tags JSON）。
--
-- 语义：
--   - 每条 (note_id, tag) 唯一（同一笔记内重复标签去重）；
--   - tag 两侧空白去除，空标签忽略；
--   - 软删除笔记的标签移出映射表（list_tags 只统计活跃笔记），恢复时触发器重建。
--
-- 幂等性：CREATE TABLE IF NOT EXISTS；触发器 DROP IF EXISTS 后重建；
--         回填前 DELETE 全表。
-- ============================================================================

CREATE TABLE IF NOT EXISTS note_tags (
    note_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (note_id, tag)
);

-- 标签维度查询（list_tags 按频次聚合、按标签过滤笔记）
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag, note_id);

-- ----------------------------------------------------------------------------
-- 触发器
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_note_tags_insert;
CREATE TRIGGER trg_note_tags_insert
AFTER INSERT ON notes
WHEN NEW.deleted_at IS NULL
BEGIN
    INSERT OR IGNORE INTO note_tags(note_id, tag)
    SELECT NEW.id, TRIM(je.value)
    FROM json_each(
        CASE WHEN json_valid(COALESCE(NEW.tags, '[]'))
             THEN COALESCE(NEW.tags, '[]')
             ELSE '[]'
        END
    ) AS je
    WHERE je.type = 'text' AND TRIM(je.value) <> '';
END;

-- UPDATE 覆盖：标签变更 / 软删除（清空映射）/ 恢复（重建映射）
DROP TRIGGER IF EXISTS trg_note_tags_update;
CREATE TRIGGER trg_note_tags_update
AFTER UPDATE ON notes
BEGIN
    DELETE FROM note_tags WHERE note_id = OLD.id;

    INSERT OR IGNORE INTO note_tags(note_id, tag)
    SELECT NEW.id, TRIM(je.value)
    FROM json_each(
        CASE WHEN json_valid(COALESCE(NEW.tags, '[]'))
             THEN COALESCE(NEW.tags, '[]')
             ELSE '[]'
        END
    ) AS je
    WHERE NEW.deleted_at IS NULL
      AND je.type = 'text'
      AND TRIM(je.value) <> '';
END;

DROP TRIGGER IF EXISTS trg_note_tags_delete;
CREATE TRIGGER trg_note_tags_delete
AFTER DELETE ON notes
BEGIN
    DELETE FROM note_tags WHERE note_id = OLD.id;
END;

-- ----------------------------------------------------------------------------
-- 回填存量数据（幂等：先清空再重建，只回填未软删除的笔记）
-- ----------------------------------------------------------------------------

-- @danger-ack: delete_without_where reason="note_tags 是由 notes.tags JSON 派生的映射表，本迁移刚创建它；无 WHERE 清空后立即从 notes 全量重建，属幂等重建，无数据丢失风险"
DELETE FROM note_tags;

INSERT OR IGNORE INTO note_tags(note_id, tag)
SELECT n.id, TRIM(je.value)
FROM notes n,
     json_each(
        CASE WHEN json_valid(COALESCE(n.tags, '[]'))
             THEN COALESCE(n.tags, '[]')
             ELSE '[]'
        END
     ) AS je
WHERE n.deleted_at IS NULL
  AND je.type = 'text'
  AND TRIM(je.value) <> '';
