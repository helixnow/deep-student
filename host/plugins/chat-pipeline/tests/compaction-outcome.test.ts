import { describe, expect, it } from 'vitest';
import {
  cooldownSecondsForOutcome, compactionDidCompact, compactionIsFailed,
  compactionReasonCode, compactionStatus, compactionTokenEstimates,
  runSummaryCommitPost, validatedCompactionModelId,
  type CompactionOutcome, type CompactionSkipReason, type SummaryCommitResult,
} from '../src/compaction-outcome.ts';

function failed<T, E>(error: E): SummaryCommitResult<T, E> {
  return { ok: false, error };
}

describe('chat_v2/pipeline/compaction.rs::tests', () => {
  it('missing_model_is_rejected_before_compaction_effects', () => {
    expect(validatedCompactionModelId(null)).toBeNull();
    expect(validatedCompactionModelId('')).toBeNull();
    expect(validatedCompactionModelId('   ')).toBeNull();
    expect(validatedCompactionModelId('  cfg_1  ')).toBe('cfg_1');
    expect(validatedCompactionModelId('\u0085')).toBeNull();
    expect(validatedCompactionModelId('\uFEFF')).toBe('\uFEFF');
  });

  it('summary_failure_prevents_transaction_and_memory_flush', async () => {
    let persistCalls = 0;
    let postCalls = 0;

    const result = await runSummaryCommitPost<string, string>(
      async () => ({ ok: true, value: null }),
      () => {
        persistCalls += 1;
        return { ok: true, value: true };
      },
      async () => {
        postCalls += 1;
      },
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(persistCalls).toBe(0);
    expect(postCalls).toBe(0);
  });

  it('transaction_failure_prevents_memory_flush', async () => {
    let persistCalls = 0;
    let postCalls = 0;

    const result = await runSummaryCommitPost<string, string>(
      async () => ({ ok: true, value: 'summary' }),
      () => {
        persistCalls += 1;
        return failed('transaction failed');
      },
      async () => {
        postCalls += 1;
      },
    );

    expect(result).toEqual({ ok: false, error: 'transaction failed' });
    expect(persistCalls).toBe(1);
    expect(postCalls).toBe(0);
  });

  it('compaction_outcome_status_and_reason_codes', () => {
    const compacted: CompactionOutcome = {
      kind: 'compacted', tokensBefore: 100, tokensAfter: 40,
    };
    expect(compactionStatus(compacted)).toBe('compacted');
    expect(compactionReasonCode(compacted)).toBeNull();
    expect(compactionDidCompact(compacted)).toBe(true);
    expect(compactionTokenEstimates(compacted)).toEqual([100, 40]);

    const notNeeded: CompactionOutcome = { kind: 'notNeeded', reason: 'sessionTooShort' };
    expect(compactionStatus(notNeeded)).toBe('notNeeded');
    expect(compactionReasonCode(notNeeded)).toBe('sessionTooShort');
    expect(compactionDidCompact(notNeeded)).toBe(false);
    expect(compactionIsFailed(notNeeded)).toBe(false);

    const skipped: CompactionOutcome = { kind: 'skipped', reason: 'lockBusy' };
    expect(compactionStatus(skipped)).toBe('skipped');
    expect(compactionReasonCode(skipped)).toBe('lockBusy');

    const failedOutcome: CompactionOutcome = { kind: 'failed', reason: 'summaryFailed' };
    expect(compactionStatus(failedOutcome)).toBe('failed');
    expect(compactionReasonCode(failedOutcome)).toBe('summaryFailed');
    expect(compactionIsFailed(failedOutcome)).toBe(true);

    // Every reason code is the camelCase wire contract.
    const codes: Record<CompactionSkipReason, string> = {
      notTriggered: 'notTriggered',
      sessionTooShort: 'sessionTooShort',
      noCompactibleRange: 'noCompactibleRange',
      usableTooSmall: 'usableTooSmall',
      lockBusy: 'lockBusy',
      noModel: 'noModel',
      summaryFailed: 'summaryFailed',
      cancelled: 'cancelled',
      staleLineage: 'staleLineage',
      internalError: 'internalError',
      cooldown: 'cooldown',
    };
    for (const [reason, code] of Object.entries(codes) as Array<[CompactionSkipReason, string]>) {
      expect(compactionReasonCode({ kind: 'skipped', reason })).toBe(code);
    }
  });

  it('cooldown_duration_mapping', () => {
    expect(cooldownSecondsForOutcome({ kind: 'failed', reason: 'summaryFailed' })).toBe(120);
    expect(cooldownSecondsForOutcome({ kind: 'notNeeded', reason: 'noCompactibleRange' }))
      .toBe(60);
    expect(cooldownSecondsForOutcome({ kind: 'compacted', tokensBefore: null, tokensAfter: null }))
      .toBeNull();
    expect(cooldownSecondsForOutcome({ kind: 'skipped', reason: 'lockBusy' })).toBeNull();
    expect(cooldownSecondsForOutcome({ kind: 'notNeeded', reason: 'sessionTooShort' })).toBe(60);
  });
});
