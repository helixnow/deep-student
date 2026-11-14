-- ============================================================================
-- V20261005: FSRS learning step index
-- ============================================================================
--
-- 可配置学习步 / 重学步（Anki 语义）需要记录卡片当前所处的步序号（0 起）。
-- 仅对 Learning / Relearning 状态有意义；存量卡默认 0（旧调度器的学习步写死，
-- 下次评分时按新的步配置继续推进）。

-- @danger-ack: add_not_null_column reason="DEFAULT 0 is the correct step index for every existing row"
ALTER TABLE fsrs_card_states ADD COLUMN learning_step INTEGER NOT NULL DEFAULT 0;
