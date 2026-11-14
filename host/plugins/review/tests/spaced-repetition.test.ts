/**
 * SM-2 单元测试。Rust 源：`src-tauri/crates/dstu-core/src/spaced_repetition.rs`
 * 的 `mod tests`，逐条保留原测试名与断言。
 */
import { expect, it } from 'vitest';
import {
  DEFAULT_EASE_FACTOR, FIRST_INTERVAL, MAX_INTERVAL, MIN_EASE_FACTOR, PASSING_GRADE,
  SECOND_INTERVAL, ReviewQuality, calculateEaseFactor, calculateNextReview,
  calculateNextReviewAdvanced, calculateNextReviewDate, calculateNextReviewDateFromLast,
  calculateNextReviewTimestamp, daysOverdue, isDueForReview,
} from '../api.ts';
import { addLocalDays, localDateKey } from '../src/local-date.ts';

it('test_review_quality_from_u8 maps 0/3/5 and rejects 6', () => {
  expect(ReviewQuality.fromU8(0)).toBe(ReviewQuality.Blackout);
  expect(ReviewQuality.fromU8(3)).toBe(ReviewQuality.Difficult);
  expect(ReviewQuality.fromU8(5)).toBe(ReviewQuality.Perfect);
  expect(ReviewQuality.fromU8(6)).toBeNull();
});

it('test_review_quality_is_passing uses PASSING_GRADE as the boundary', () => {
  expect(PASSING_GRADE).toBe(3);
  expect(ReviewQuality.isPassing(ReviewQuality.Blackout)).toBe(false);
  expect(ReviewQuality.isPassing(ReviewQuality.WrongButFamiliar)).toBe(false);
  expect(ReviewQuality.isPassing(ReviewQuality.WrongButEasy)).toBe(false);
  expect(ReviewQuality.isPassing(ReviewQuality.Difficult)).toBe(true);
  expect(ReviewQuality.isPassing(ReviewQuality.Good)).toBe(true);
  expect(ReviewQuality.isPassing(ReviewQuality.Perfect)).toBe(true);
});

it('test_first_review_passed returns FIRST_INTERVAL and one repetition', () => {
  const [interval, ef, reps] = calculateNextReview(4, 0, DEFAULT_EASE_FACTOR, 0);

  expect(interval).toBe(FIRST_INTERVAL);
  expect(reps).toBe(1);
  expect(ef).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
});

it('test_second_review_passed returns SECOND_INTERVAL and two repetitions', () => {
  const [interval, ef, reps] = calculateNextReview(4, 1, DEFAULT_EASE_FACTOR, FIRST_INTERVAL);

  expect(interval).toBe(SECOND_INTERVAL);
  expect(reps).toBe(2);
  expect(ef).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
});

it('test_third_review_passed multiplies the previous interval by the new ease factor', () => {
  const [interval, ef, reps] = calculateNextReview(5, 2, DEFAULT_EASE_FACTOR, SECOND_INTERVAL);

  // 间隔应该是 6 * 2.6 ≈ 15.6 -> 16
  expect(interval).toBeGreaterThan(SECOND_INTERVAL);
  expect(reps).toBe(3);
  expect(ef).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
});

it('test_review_failed resets interval and repetitions but preserves ease factor', () => {
  const [interval, ef, reps] = calculateNextReview(2, 5, 2.0, 30);

  expect(interval).toBe(FIRST_INTERVAL);
  expect(reps).toBe(0);
  expect(ef).toBe(2.0);
  expect(ef).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
});

it('test_ease_factor_decrease lowers the ease factor on repeated difficult reviews', () => {
  const [, ef1] = calculateNextReview(3, 0, DEFAULT_EASE_FACTOR, 0);
  const [, ef2] = calculateNextReview(3, 1, ef1, 1);

  expect(ef1).toBeLessThan(DEFAULT_EASE_FACTOR);
  expect(ef2).toBeLessThan(ef1);
});

it('test_ease_factor_increase raises the ease factor on a perfect review', () => {
  const [, ef1] = calculateNextReview(5, 0, DEFAULT_EASE_FACTOR, 0);

  expect(ef1).toBeGreaterThan(DEFAULT_EASE_FACTOR);
});

it('test_ease_factor_minimum keeps the ease factor at or above 1.3', () => {
  let ef = 1.5;
  for (let index = 0; index < 10; index += 1) {
    const [, newEf] = calculateNextReview(0, 0, ef, 1);
    ef = newEf;
  }
  expect(ef).toBeGreaterThanOrEqual(MIN_EASE_FACTOR);
});

it('test_interval_maximum caps the interval at MAX_INTERVAL', () => {
  const [interval] = calculateNextReview(5, 100, 3.0, 500);

  expect(interval).toBeLessThanOrEqual(MAX_INTERVAL);
});

it('test_calculate_next_review_date returns a YYYY-MM-DD date', () => {
  const date = calculateNextReviewDate(1);

  expect(date).toHaveLength(10);
  expect(date).toContain('-');
});

it('test_is_due_for_review treats yesterday/today as due and tomorrow as not due', () => {
  const today = localDateKey();
  expect(isDueForReview(addLocalDays(today, -1))).toBe(true);
  expect(isDueForReview(today)).toBe(true);
  expect(isDueForReview(addLocalDays(today, 1))).toBe(false);
});

it('test_days_overdue reports positive overdue and negative remaining days', () => {
  const today = localDateKey();
  expect(daysOverdue(addLocalDays(today, -3))).toBe(3);
  expect(daysOverdue(addLocalDays(today, 2))).toBe(-2);
});

it('test_advanced_api returns SM2Result with a passing verdict', () => {
  const result = calculateNextReviewAdvanced(ReviewQuality.Good, 0, DEFAULT_EASE_FACTOR, 0);

  expect(result.passed).toBe(true);
  expect(result.new_interval).toBe(FIRST_INTERVAL);
  expect(result.new_repetitions).toBe(1);
});

it('test_calculate_ease_factor follows the standard SM-2 delta', () => {
  const ef5 = calculateEaseFactor(2.5, 5.0);
  expect(ef5).toBeGreaterThan(2.5);

  // 标准 SM-2 公式下质量 4 的 ΔEF = 0.1 - 1*(0.08+0.02) = 0，EF 保持不变
  const ef4 = calculateEaseFactor(2.5, 4.0);
  expect(Math.abs(ef4 - 2.5)).toBeLessThan(1e-9);

  const ef3 = calculateEaseFactor(2.5, 3.0);
  expect(ef3).toBeLessThan(2.5);

  const ef0 = calculateEaseFactor(2.5, 0.0);
  expect(ef0).toBeLessThan(2.0);
});

it('test_calculate_next_review_timestamp and date_from_last expose the pure date helpers', () => {
  const now = Date.now();
  const timestamp = calculateNextReviewTimestamp(1);
  expect(timestamp).toBeGreaterThanOrEqual(now + 86_400_000 - 1_000);
  expect(timestamp).toBeLessThanOrEqual(now + 86_400_000 + 1_000);

  expect(calculateNextReviewDateFromLast('2026-01-30', 2)).toBe('2026-02-01');
  expect(calculateNextReviewDateFromLast('2026-01-01', 0)).toBe('2026-01-01');
  expect(calculateNextReviewDateFromLast('not-a-date', 2)).toBeNull();
});
