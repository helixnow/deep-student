import { expect, it } from 'vitest';
import { applyMasteryDueBias, masteryDueBiasDeltaMs, queueSortKey } from '../src/bias.ts';

const DAY = 86_400_000;
it('low_mastery_advances_due_by_assertable_fraction', () => {
  const now = 1_700_000_000_000;
  expect(applyMasteryDueBias(0, now, now + 5 * DAY)).toBe(now + 3 * DAY);
  expect(masteryDueBiasDeltaMs(0, 5 * DAY)).toBe(-2 * DAY);
});
it('high_mastery_is_not_advanced', () => {
  const now = 1_700_000_000_000, due = now + 10 * DAY;
  const delta = masteryDueBiasDeltaMs(0.9, 10 * DAY);
  expect(applyMasteryDueBias(0.9, now, due)).toBeGreaterThanOrEqual(due);
  expect(delta).toBeGreaterThan(0);
  expect(applyMasteryDueBias(0.9, now, due)).toBe(due + delta);
});
it('bias_has_hard_cap_not_unbounded', () => {
  const delta = masteryDueBiasDeltaMs(0, 100 * DAY);
  expect(delta).toBe(-3 * DAY);
  expect(Math.abs(delta)).toBeLessThan(40 * DAY);
});
it('short_learning_steps_unbiased', () => {
  expect(masteryDueBiasDeltaMs(0, 600_000)).toBe(0);
  expect(applyMasteryDueBias(0, 1000, 601_000)).toBe(601_000);
});
it('neutral_score_no_bias', () => expect(masteryDueBiasDeltaMs(0.5, 10 * DAY)).toBe(0));
const less = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
it('due_learning_cards_keep_priority_over_low_mastery_new', () => {
  const now = 1_700_000_000_000, n = queueSortKey(0, 0, now);
  expect(less(queueSortKey(1, 0.9, now), n)).toBe(true);
  expect(less(queueSortKey(3, 0.9, now), n)).toBe(true);
});
it('low_mastery_priority_still_applies_within_review_cards', () => {
  const due = 1_700_000_000_000 + DAY;
  expect(less(queueSortKey(2, 0, due), queueSortKey(2, 0.9, due))).toBe(true);
});
