-- ============================================================================
-- V20261115: 题目集复习（review_plans）改用 FSRS 调度（UX 审计决议 D2）
-- ============================================================================
--
-- 记忆模型与调度规则复用闪卡同一套实现（host/plugins/review/src/review-scheduling.ts
-- 的 scheduleAllRatings → fsrs-scheduler.ts 的 Anki 语义 FSRS-6），这里只加状态列：
--   fsrs_stability / fsrs_difficulty  FSRS 记忆状态（NULL = 还没被 FSRS 调度过）
--   fsrs_phase                         new | learning | review | relearning（NULL = SM-2 遗留行）
--   fsrs_learning_step                 学习步下标（1 分钟 / 10 分钟……）
--   fsrs_lapses                        遗忘次数
--   fsrs_due_at                        精确到期时刻（毫秒；分钟级学习步用，next_review_date 仍是按日的到期口径）
--   fsrs_last_review_at                上次评分时刻（毫秒，用于计算 elapsed days）
--
-- 已有 SM-2 数据不在这里改写（迁移只加列，可安全重放到同步来的旧行上）：
-- fsrs_phase 为 NULL 的行在下一次评分时由 ReviewPlanService 惰性换算——
-- repetitions>0 → review 态，稳定度≈interval_days、难度由 ease_factor 线性映射；
-- 做过但最近一次答错 → relearning；从没复习过 → new。next_review_date 原样保留，
-- 所以每日练习 / 错题复习 / 桌面简报的到期口径（next_review_date <= 今天）不受影响。
-- ============================================================================

ALTER TABLE review_plans ADD COLUMN fsrs_stability REAL;
ALTER TABLE review_plans ADD COLUMN fsrs_difficulty REAL;
ALTER TABLE review_plans ADD COLUMN fsrs_phase TEXT;
ALTER TABLE review_plans ADD COLUMN fsrs_learning_step INTEGER DEFAULT 0;
ALTER TABLE review_plans ADD COLUMN fsrs_lapses INTEGER DEFAULT 0;
ALTER TABLE review_plans ADD COLUMN fsrs_due_at INTEGER;
ALTER TABLE review_plans ADD COLUMN fsrs_last_review_at INTEGER;
