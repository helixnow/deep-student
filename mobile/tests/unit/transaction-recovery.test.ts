import { describe, expect, it, vi } from 'vitest';
import { isLostBackingTransactionError, runWithTransactionRecovery } from '../../src/worker/transaction-recovery.ts';

const lost = { name: 'UnknownError', message: 'Attempt to get records without an in-progress transaction' };

describe('WebKit transaction recovery', () => {
  it.each([
    lost,
    { name: 'InvalidStateError', message: 'The database connection is closing.' },
    { name: 'TransactionInactiveError', message: 'Transaction is inactive' },
    { name: 'AbortError', message: 'The transaction was aborted' },
    { name: 'Error', message: 'SQLite worker lost its backing transaction' },
    { cause: { inner: lost } },
    { name: 'BulkError', failures: [lost, { cause: lost }] },
  ])('recognizes transient database errors: %j', error => {
    expect(isLostBackingTransactionError(error)).toBe(true);
  });

  it.each([
    { name: 'AbortError', message: 'User cancelled operation' },
    { name: 'InvalidStateError', message: 'Media decoder not ready' },
    { name: 'ConstraintError', message: 'duplicate key' },
    { name: 'BulkError', failures: [lost, { name: 'ConstraintError' }] },
    new Error('network offline'), null, 'backing transaction',
  ])('does not replay unrelated failures: %j', error => {
    expect(isLostBackingTransactionError(error)).toBe(false);
  });

  it('handles circular causes without losing valid siblings', () => {
    const cycle: { cause?: unknown; inner?: unknown } = {};
    cycle.cause = cycle;
    expect(isLostBackingTransactionError(cycle)).toBe(false);
    cycle.inner = lost;
    expect(isLostBackingTransactionError(cycle)).toBe(true);
  });

  it('waits exponentially outside the transaction and reopens before the final attempt', async () => {
    const events: string[] = [];
    let attempt = 0;
    const result = await runWithTransactionRecovery(async () => {
      events.push(`attempt:${attempt}`);
      if (attempt++ < 2) throw lost;
      return 'recovered';
    }, {
      sleep: async ms => { events.push(`wait:${ms}`); },
      reopenConnection: async () => { events.push('reopen'); },
    });
    expect(result).toBe('recovered');
    expect(events).toEqual(['attempt:0', 'wait:100', 'attempt:1', 'wait:400', 'reopen', 'attempt:2']);
  });

  it('does not reopen if a fresh transaction recovers on the first retry', async () => {
    const operation = vi.fn().mockRejectedValueOnce(lost).mockResolvedValue(42);
    const reopenConnection = vi.fn();
    expect(await runWithTransactionRecovery(operation, { reopenConnection, sleep: async () => undefined })).toBe(42);
    expect(reopenConnection).not.toHaveBeenCalled();
  });

  it('surfaces final failure without an infinite loop and supports custom backoff', async () => {
    const operation = vi.fn().mockRejectedValue(lost);
    const reopenConnection = vi.fn();
    const sleep = vi.fn(async (_ms: number) => undefined);
    await expect(runWithTransactionRecovery(operation, {
      reopenConnection, sleep, maxRetries: 3, initialDelayMs: 5, backoffMultiplier: 2,
    })).rejects.toBe(lost);
    expect(operation).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5, 10, 20]);
    expect(reopenConnection).toHaveBeenCalledTimes(1);
  });

  it('never retries cancellation or other nontransaction failures', async () => {
    const error = new Error('validation failed');
    const operation = vi.fn().mockRejectedValue(error);
    const reopenConnection = vi.fn();
    const sleep = vi.fn();
    await expect(runWithTransactionRecovery(operation, { reopenConnection, sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(reopenConnection).not.toHaveBeenCalled();
  });

  it('honors zero retries and propagates reopen failures', async () => {
    const operation = vi.fn().mockRejectedValue(lost);
    const reopenConnection = vi.fn().mockRejectedValue(new Error('open failed'));
    await expect(runWithTransactionRecovery(operation, { maxRetries: 0, reopenConnection })).rejects.toBe(lost);
    expect(reopenConnection).not.toHaveBeenCalled();
    await expect(runWithTransactionRecovery(operation, {
      maxRetries: 1, reopenConnection, sleep: async () => undefined,
    })).rejects.toThrow('open failed');
  });
});
