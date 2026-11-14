-- ============================================================================
-- V20260722: FSRS scheduler hardening (leech flag, bury window, stats index)
-- ============================================================================
--
-- - leech: 连续/累计 lapse 达阈值后的 leech 标记（Anki 语义，默认阈值 8，
--   之后每半个阈值再次标记）。由 fsrs_review_service 在评分事务内维护。
-- - buried_until_ms: bury 到期时间（本地日切的次日零点毫秒）。到期后自动
--   恢复可调度，无需写库；评分会显式清除。
-- - idx_fsrs_logs_review_ms: 供按日聚合统计（热力图/留存率）做区间扫描，
--   避免对 fsrs_review_logs 的全表扫描。

ALTER TABLE fsrs_card_states ADD COLUMN leech INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fsrs_card_states ADD COLUMN buried_until_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_fsrs_logs_review_ms
    ON fsrs_review_logs(review_ms)
    WHERE deleted_at IS NULL;
