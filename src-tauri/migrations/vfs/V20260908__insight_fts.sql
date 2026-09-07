-- ============================================================================
-- V20260908: Insight Recall v2 阶段二——灵感卡全文检索 insight_fts
-- ============================================================================
--
-- 设计决策（对齐 notes_fts / V20260724 的既有结论）：
--   1. tokenizer 用 trigram（非 unicode61）：unicode61 把连续 CJK 切成长 token，
--      中文子串查询漏检；trigram 对 >=3 字符查询等价 LIKE '%q%' 子串语义 + bm25
--      排序。<3 字符查询由 Rust 侧回退 LIKE（见 insight/recall.rs）。
--   2. contentless（content='' + contentless_delete=1）：索引不复制正文，
--      可按 rowid 直接 DELETE；snippet 由 Rust 侧 JOIN 自行生成。
--   3. rowid 对齐 insights.rowid；软删除（deleted_at IS NOT NULL）不进索引。
--   4. 索引内容 = insights.title + 当前修订（current_revision_id 指向的
--      insight_revisions 行）五字段拼接。修订不可变，换修订 = UPDATE insights，
--      由 UPDATE 触发器重建索引。
--
-- 写路径时序（与 insight/repo.rs 一致）：
--   capture_draft：INSERT insights（current_revision_id 为 NULL）
--     → INSERT insight_revisions → UPDATE insights SET current_revision_id
--   故 INSERT 触发器只能索引到标题，正文靠 UPDATE 触发器补齐；
--   insight_revisions 的 INSERT 触发器是防御性的（资源后到/同步乱序）。
--
-- 幂等性：虚表 CREATE IF NOT EXISTS；触发器先 DROP IF EXISTS 再建；
--         回填前先 'delete-all' 清空索引。
-- ============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS insight_fts USING fts5(
    title,
    body,
    content='',
    contentless_delete=1,
    tokenize='trigram'
);

-- ----------------------------------------------------------------------------
-- insights 表触发器：INSERT / UPDATE / DELETE
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_insight_fts_insert;
CREATE TRIGGER trg_insight_fts_insert
AFTER INSERT ON insights
WHEN NEW.deleted_at IS NULL
BEGIN
    INSERT INTO insight_fts(rowid, title, body)
    VALUES (
        NEW.rowid,
        NEW.title,
        COALESCE((
            SELECT rev.situation || ' ' || rev.stuck_point || ' ' || rev.turning_point
                   || ' ' || rev.rule || ' ' || rev.validity_conditions
            FROM insight_revisions rev
            WHERE rev.id = NEW.current_revision_id
        ), '')
    );
END;

-- UPDATE 覆盖：标题变更 / current_revision_id 切换 / 软删除（移出索引）/ 恢复（重新写入）。
DROP TRIGGER IF EXISTS trg_insight_fts_update;
CREATE TRIGGER trg_insight_fts_update
AFTER UPDATE ON insights
BEGIN
    DELETE FROM insight_fts
    WHERE rowid = OLD.rowid AND OLD.deleted_at IS NULL;

    INSERT INTO insight_fts(rowid, title, body)
    SELECT
        NEW.rowid,
        NEW.title,
        COALESCE((
            SELECT rev.situation || ' ' || rev.stuck_point || ' ' || rev.turning_point
                   || ' ' || rev.rule || ' ' || rev.validity_conditions
            FROM insight_revisions rev
            WHERE rev.id = NEW.current_revision_id
        ), '')
    WHERE NEW.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS trg_insight_fts_delete;
CREATE TRIGGER trg_insight_fts_delete
AFTER DELETE ON insights
BEGIN
    DELETE FROM insight_fts
    WHERE rowid = OLD.rowid AND OLD.deleted_at IS NULL;
END;

-- ----------------------------------------------------------------------------
-- insight_revisions 表触发器（防御性）：云同步/恢复可能先写 insights 行、
-- 后写 revisions 行，此时 insights 的触发器只索引到标题。修订行补齐时
-- 若它正是某卡的当前修订，重建该卡索引。
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_insight_fts_revision_insert;
CREATE TRIGGER trg_insight_fts_revision_insert
AFTER INSERT ON insight_revisions
BEGIN
    DELETE FROM insight_fts
    WHERE rowid IN (
        SELECT i.rowid FROM insights i
        WHERE i.current_revision_id = NEW.id AND i.deleted_at IS NULL
    );

    INSERT INTO insight_fts(rowid, title, body)
    SELECT
        i.rowid,
        i.title,
        NEW.situation || ' ' || NEW.stuck_point || ' ' || NEW.turning_point
            || ' ' || NEW.rule || ' ' || NEW.validity_conditions
    FROM insights i
    WHERE i.current_revision_id = NEW.id AND i.deleted_at IS NULL;
END;

-- ----------------------------------------------------------------------------
-- 回填存量数据（幂等：先清空再重建，只索引未软删除的卡）
-- ----------------------------------------------------------------------------

INSERT INTO insight_fts(insight_fts) VALUES('delete-all');

INSERT INTO insight_fts(rowid, title, body)
SELECT
    i.rowid,
    i.title,
    COALESCE(
        rev.situation || ' ' || rev.stuck_point || ' ' || rev.turning_point
            || ' ' || rev.rule || ' ' || rev.validity_conditions,
        ''
    )
FROM insights i
LEFT JOIN insight_revisions rev ON rev.id = i.current_revision_id
WHERE i.deleted_at IS NULL;
