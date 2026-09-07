-- ============================================================================
-- V20260911: insight_fts UPDATE 触发器收窄——计数器累加不再重建索引
-- ============================================================================
--
-- 问题（自查发现）：V20260908 的 trg_insight_fts_update 是裸 AFTER UPDATE，
-- 召回路径每轮 bump shown_count/recall_count 都会触发"删旧行 + 插新行"的
-- FTS 索引重建。用户每条消息至少一次召回，等于每轮白写一次倒排索引。
--
-- 修复：收窄为 UPDATE OF title, current_revision_id, deleted_at——
-- 只有这三列真正影响索引内容（标题/正文来源/软删除可见性）。
-- 计数列（recall_count/shown_count/useful_count/last_recalled_at）与
-- 同步列（local_version/updated_at/device_id）变更不再触碰索引。
--
-- 幂等性：DROP IF EXISTS + CREATE，天然幂等。
-- ============================================================================

DROP TRIGGER IF EXISTS trg_insight_fts_update;
CREATE TRIGGER trg_insight_fts_update
AFTER UPDATE OF title, current_revision_id, deleted_at ON insights
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
