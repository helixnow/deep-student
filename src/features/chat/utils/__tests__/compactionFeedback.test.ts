import { describe, expect, it } from 'vitest';
import {
  CONTEXT_TRIM_NOTIFY_WINDOW_MS,
  compactionReasonI18nKey,
  createContextTrimThrottle,
  normalizeCompactSessionResponse,
  parseCompactionFailedReason,
  parseContextTrimmedPayload,
} from '../compactionFeedback';

describe('normalizeCompactSessionResponse', () => {
  it('passes through the new structured contract', () => {
    expect(normalizeCompactSessionResponse({ status: 'compacted' })).toEqual({
      status: 'compacted',
    });
    expect(normalizeCompactSessionResponse({ status: 'skipped', reason: 'streaming' })).toEqual({
      status: 'skipped',
      reason: 'streaming',
    });
    expect(normalizeCompactSessionResponse({ status: 'failed', reason: 'summaryFailed' })).toEqual({
      status: 'failed',
      reason: 'summaryFailed',
    });
    expect(normalizeCompactSessionResponse({ status: 'notNeeded' })).toEqual({
      status: 'notNeeded',
    });
  });

  it('downgrades legacy boolean responses (联调兼容)', () => {
    expect(normalizeCompactSessionResponse(true)).toEqual({ status: 'compacted' });
    expect(normalizeCompactSessionResponse(false)).toEqual({ status: 'notNeeded' });
  });

  it('treats unrecognized shapes as failed', () => {
    expect(normalizeCompactSessionResponse(undefined)).toEqual({
      status: 'failed',
      reason: 'invalidResponse',
    });
    expect(normalizeCompactSessionResponse('yes')).toEqual({
      status: 'failed',
      reason: 'invalidResponse',
    });
    expect(normalizeCompactSessionResponse({ status: 'weird' })).toEqual({
      status: 'failed',
      reason: 'invalidResponse',
    });
  });

  it('drops empty reason strings', () => {
    expect(normalizeCompactSessionResponse({ status: 'skipped', reason: '' })).toEqual({
      status: 'skipped',
    });
  });
});

describe('compactionReasonI18nKey', () => {
  it('maps known reason codes to their i18n keys', () => {
    expect(compactionReasonI18nKey('streaming')).toBe('compaction.reason.streaming');
    expect(compactionReasonI18nKey('lockBusy')).toBe('compaction.reason.lockBusy');
    expect(compactionReasonI18nKey('staleLineage')).toBe('compaction.reason.staleLineage');
  });

  it('falls back to unknown for missing or unrecognized reasons', () => {
    expect(compactionReasonI18nKey(undefined)).toBe('compaction.reason.unknown');
    expect(compactionReasonI18nKey('somethingNew')).toBe('compaction.reason.unknown');
  });
});

describe('parseContextTrimmedPayload', () => {
  it('parses camelCase payloads', () => {
    expect(
      parseContextTrimmedPayload({ droppedMessages: 3, estimatedDroppedTokens: 1200 }),
    ).toEqual({ droppedMessages: 3, estimatedDroppedTokens: 1200 });
    expect(parseContextTrimmedPayload({ droppedMessages: 2 })).toEqual({ droppedMessages: 2 });
  });

  it('rejects invalid payloads', () => {
    expect(parseContextTrimmedPayload(undefined)).toBeNull();
    expect(parseContextTrimmedPayload({})).toBeNull();
    expect(parseContextTrimmedPayload({ droppedMessages: 0 })).toBeNull();
    expect(parseContextTrimmedPayload({ droppedMessages: 'many' })).toBeNull();
  });
});

describe('parseCompactionFailedReason', () => {
  it('extracts the reason string', () => {
    expect(parseCompactionFailedReason({ reason: 'summaryFailed' })).toBe('summaryFailed');
  });

  it('returns undefined for missing reason', () => {
    expect(parseCompactionFailedReason({})).toBeUndefined();
    expect(parseCompactionFailedReason(null)).toBeUndefined();
  });
});

describe('createContextTrimThrottle', () => {
  it('notifies immediately for the first event of a session', () => {
    const throttle = createContextTrimThrottle();
    const decision = throttle.record('s1', { droppedMessages: 2 }, 1_000);
    expect(decision).toEqual({ notify: true, droppedMessages: 2 });
  });

  it('suppresses and merges events within the 30s window', () => {
    const throttle = createContextTrimThrottle();
    throttle.record('s1', { droppedMessages: 2, estimatedDroppedTokens: 100 }, 1_000);

    const suppressed = throttle.record('s1', { droppedMessages: 3, estimatedDroppedTokens: 200 }, 5_000);
    expect(suppressed.notify).toBe(false);

    // 窗口过后，被合并的丢弃数一并计入下一次提示
    const merged = throttle.record(
      's1',
      { droppedMessages: 1, estimatedDroppedTokens: 50 },
      1_000 + CONTEXT_TRIM_NOTIFY_WINDOW_MS,
    );
    expect(merged).toEqual({
      notify: true,
      droppedMessages: 4,
      estimatedDroppedTokens: 250,
    });
  });

  it('tracks sessions independently', () => {
    const throttle = createContextTrimThrottle();
    throttle.record('s1', { droppedMessages: 2 }, 1_000);
    const other = throttle.record('s2', { droppedMessages: 5 }, 2_000);
    expect(other).toEqual({ notify: true, droppedMessages: 5 });
  });

  it('omits estimated tokens when no event carried them', () => {
    const throttle = createContextTrimThrottle();
    const decision = throttle.record('s1', { droppedMessages: 2 }, 1_000);
    expect(decision.estimatedDroppedTokens).toBeUndefined();
  });

  it('clears per-session state', () => {
    const throttle = createContextTrimThrottle();
    throttle.record('s1', { droppedMessages: 2 }, 1_000);
    throttle.clear('s1');
    const decision = throttle.record('s1', { droppedMessages: 1 }, 2_000);
    expect(decision).toEqual({ notify: true, droppedMessages: 1 });
  });
});
