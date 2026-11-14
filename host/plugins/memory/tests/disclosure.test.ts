import { expect, it } from 'vitest';
import { decideEscalation, decidePassive, defaultDisclosurePolicy, filterContent, internalizationDiscount } from '../src/disclosure.ts';

it('passive_silence_when_disabled', () => {
  expect(decidePassive({ ...defaultDisclosurePolicy(), enabled: false }, [{ confidence: 0.9 }]))
    .toEqual([{ kind: 'silence', reason: 'user_disabled' }]);
});
it('passive_low_confidence_silence', () => {
  expect(decidePassive(defaultDisclosurePolicy(), [{ confidence: 0.1 }]))
    .toEqual([{ kind: 'silence', reason: 'low_confidence' }]);
});
it('passive_budget_enforced', () => {
  const out = decidePassive({ ...defaultDisclosurePolicy(), max_per_turn: 1 }, [{ confidence: 0.9 }, { confidence: 0.8 }]);
  expect(out[0]).toEqual({ kind: 'disclose', level: 'existence' });
  expect(out[1]).toEqual({ kind: 'silence', reason: 'budget' });
});
it('existence_never_exposes_method', () => {
  const [t, s, r] = filterContent('existence', '换元法', '积分题', '识别导数结构');
  expect(t).toBe('换元法');
  expect(s).toBeNull();
  expect(r).toBeNull();
  const [, s2, r2] = filterContent('recall_prompt', 't', 's', 'r');
  expect(s2).not.toBeNull();
  expect(r2).toBeNull();
  expect(filterContent('hint', 't', 's', 'r')[2]).not.toBeNull();
});
it('escalation_one_rung_at_a_time', () => {
  const policy = defaultDisclosurePolicy();
  expect(decideEscalation(policy, 'existence', 'full')).toEqual({ kind: 'disclose', level: 'recall_prompt' });
  expect(decideEscalation(policy, 'hint', 'direct_answer')).toEqual({ kind: 'disclose', level: 'direct_answer' });
  expect(decideEscalation(policy, 'full', 'hint')).toEqual({ kind: 'disclose', level: 'full' });
});
it('test_internalization_discount_bounds', () => {
  const d = internalizationDiscount;
  expect(d(0, 0, 0)).toBe(1);
  expect(d(4, 10, 10)).toBe(1);
  expect(d(10, 10, 2)).toBe(1);
  const f5 = d(5, 10, 9);
  const f15 = d(15, 20, 18);
  expect(f5).toBeLessThan(1);
  expect(f5).toBeGreaterThan(f15);
  expect(f15).toBeGreaterThanOrEqual(0.3);
});
