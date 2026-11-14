-- ============================================================================
-- V20260724: 笔记全文检索 notes_fts（FTS5）
-- ============================================================================
--
-- 背景（审计报告 04-backend.md P1-1）：
--   笔记搜索此前只有 `title/resources.data LIKE %q%`，无相关度排序，
--   snippet 生成还带 N+1 查询。VFS 中没有 notes 专属 FTS（库内仅 questions_fts）。
--
-- 设计决策：
--   1. 笔记正文存放在 resources.data（notes.resource_id 指向），标题在 notes.title，
--      内容跨两张表，FTS5 external content（content='单表'）无法直接表达。
--      为避免正文数据双份膨胀，采用 contentless 表（content=''）+
--      contentless_delete=1（SQLite >= 3.43，本项目 bundled SQLite >= 3.51）：
--      - 索引只存倒排数据，不复制 title/body 文本；
--      - contentless_delete=1 允许按 rowid 直接 DELETE，触发器无需携带
--        与索引完全一致的旧值（questions_fts 曾因旧值漂移腐化，见 V20260610）。
--      - 代价：snippet() 不可用 —— Rust 侧通过一次 JOIN resources 取正文
--        自行生成摘要（单查询，无 N+1），见 VfsNoteRepo::search_notes_fts_*。
--   2. tokenizer 采用 trigram（而非 questions_fts 的 unicode61）：
--      unicode61 将连续 CJK 字符切成一整个长 token，中文子串查询会漏检；
--      trigram 对 >=3 字符的查询给出与 LIKE '%q%' 等价的子串匹配语义 + bm25 排序，
--      中英文统一。<3 字符的查询 MATCH 返回空，由 Rust 侧回退到 LIKE 路径兜底。
--   3. rowid 对齐 notes.rowid；软删除（deleted_at IS NOT NULL）不进索引，
--      恢复时由 UPDATE 触发器重新写入。
--   4. 与 questions_fts 完全隔离（独立虚表、独立触发器）。
--
-- 幂等性：虚表 CREATE IF NOT EXISTS；触发器先 DROP IF EXISTS 再建；
--         回填前先 'delete-all' 清空索引。
-- ============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title,
    body,
    content='',
    contentless_delete=1,
    tokenize='trigram'
);

-- ----------------------------------------------------------------------------
-- notes 表触发器：INSERT / UPDATE / DELETE
--
-- 时序依赖（与 VfsNoteRepo 写路径一致）：
--   - create_note：先 INSERT resources 再 INSERT notes → INSERT 触发器可读到正文；
--   - update_note（内容变更）：先 INSERT 新 resource，再 UPDATE notes.resource_id，
--     最后 DELETE 旧 resource → UPDATE 触发器按 NEW.resource_id 取新正文；
--   - purge_note：先 DELETE notes 再 DELETE resources → DELETE 触发器只需删 rowid。
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_notes_fts_insert;
CREATE TRIGGER trg_notes_fts_insert
AFTER INSERT ON notes
WHEN NEW.deleted_at IS NULL
BEGIN
    INSERT INTO notes_fts(rowid, title, body)
    VALUES (
        NEW.rowid,
        NEW.title,
        COALESCE((SELECT r.data FROM resources r WHERE r.id = NEW.resource_id), '')
    );
END;

-- UPDATE 覆盖：标题变更 / resource_id 切换 / 软删除（移出索引）/ 恢复（重新写入）。
-- 仅当旧行曾被索引（OLD.deleted_at IS NULL）才执行 DELETE，避免为软删除行
-- 反复写入无意义的删除标记。
DROP TRIGGER IF EXISTS trg_notes_fts_update;
CREATE TRIGGER trg_notes_fts_update
AFTER UPDATE ON notes
BEGIN
    DELETE FROM notes_fts
    WHERE rowid = OLD.rowid AND OLD.deleted_at IS NULL;

    INSERT INTO notes_fts(rowid, title, body)
    SELECT
        NEW.rowid,
        NEW.title,
        COALESCE((SELECT r.data FROM resources r WHERE r.id = NEW.resource_id), '')
    WHERE NEW.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS trg_notes_fts_delete;
CREATE TRIGGER trg_notes_fts_delete
AFTER DELETE ON notes
BEGIN
    DELETE FROM notes_fts
    WHERE rowid = OLD.rowid AND OLD.deleted_at IS NULL;
END;

-- ----------------------------------------------------------------------------
-- resources 表触发器：正文原地更新（防御性）
--
-- 常规写路径内容变更是"新建 resource + 切换指针"，不会命中此触发器；
-- 但云同步 / 数据修复可能原地 UPDATE resources.data，此处兜底重建关联笔记的索引。
-- `UPDATE OF data` 限定只有 SET 了 data 列的语句才触发（source_id 等更新不触发）。
-- ----------------------------------------------------------------------------

-- 资源后到（防御性）：云同步/恢复可能先写 notes 行、后写 resources 行，
-- 此时 notes 的 INSERT 触发器只索引到了标题。资源行补齐时重建关联索引。
-- 常规 create/update 流程中 resource 先于 notes 写入，本触发器为无操作。
DROP TRIGGER IF EXISTS trg_notes_fts_resource_insert;
CREATE TRIGGER trg_notes_fts_resource_insert
AFTER INSERT ON resources
WHEN NEW.type = 'note'
BEGIN
    DELETE FROM notes_fts
    WHERE rowid IN (
        SELECT n.rowid FROM notes n
        WHERE n.resource_id = NEW.id AND n.deleted_at IS NULL
    );

    INSERT INTO notes_fts(rowid, title, body)
    SELECT n.rowid, n.title, COALESCE(NEW.data, '')
    FROM notes n
    WHERE n.resource_id = NEW.id AND n.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS trg_notes_fts_resource_data_update;
CREATE TRIGGER trg_notes_fts_resource_data_update
AFTER UPDATE OF data ON resources
WHEN NEW.type = 'note'
BEGIN
    DELETE FROM notes_fts
    WHERE rowid IN (
        SELECT n.rowid FROM notes n
        WHERE n.resource_id = NEW.id AND n.deleted_at IS NULL
    );

    INSERT INTO notes_fts(rowid, title, body)
    SELECT n.rowid, n.title, COALESCE(NEW.data, '')
    FROM notes n
    WHERE n.resource_id = NEW.id AND n.deleted_at IS NULL;
END;

-- ----------------------------------------------------------------------------
-- 回填存量数据（幂等：先清空再重建，只索引未软删除的笔记）
-- ----------------------------------------------------------------------------

INSERT INTO notes_fts(notes_fts) VALUES('delete-all');

INSERT INTO notes_fts(rowid, title, body)
SELECT n.rowid, n.title, COALESCE(r.data, '')
FROM notes n
LEFT JOIN resources r ON r.id = n.resource_id
WHERE n.deleted_at IS NULL;
