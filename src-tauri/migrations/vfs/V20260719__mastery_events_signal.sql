-- ============================================================================
-- V20260719: mastery_events.signal — FSRS rating 目标信号强度（A-P1）
-- 可选列；旧行 NULL，由应用层按 outcome 回退（rating→0.35 / correct→1 / wrong→0）
-- ============================================================================

ALTER TABLE mastery_events ADD COLUMN signal REAL;
