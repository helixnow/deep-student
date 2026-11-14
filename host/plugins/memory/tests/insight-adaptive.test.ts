import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import { calibratePolicyFromLedger, defaultDisclosurePolicy } from '../src/disclosure.ts';
import { recordInsightEventIdempotent } from '../repository/insight.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

describe('insight adaptive policy', () => {
  it('test_calibrate_policy_from_ledger', async () => {
    current = await setupMemoryHost();
    const db = current.db;
    const policy = defaultDisclosurePolicy();

    // Insufficient sample: leave the static policy untouched.
    const unchanged = calibratePolicyFromLedger(db, policy);
    expect(Math.abs(unchanged.min_confidence - policy.min_confidence)).toBeLessThan(1e-9);

    // 20 shown / 16 useful -> a high usefulness rate lowers the threshold.
    for (let index = 0; index < 20; index += 1) {
      recordInsightEventIdempotent(db, 'sess_cal', `msg_${index}`, null,
        'shown_existence', 'existence');
    }
    for (let index = 0; index < 16; index += 1) {
      recordInsightEventIdempotent(db, 'sess_cal', `fb_${index}`, null,
        'feedback_useful', 'none');
    }

    const calibrated = calibratePolicyFromLedger(db, policy);
    expect(calibrated.min_confidence).toBeLessThan(policy.min_confidence);
    expect(calibrated.min_confidence).toBeGreaterThanOrEqual(0.15);
  });
});
