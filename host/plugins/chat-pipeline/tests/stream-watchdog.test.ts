import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STREAM_WATCHDOG_STALL_GAP_MS, STREAM_WATCHDOG_TICK_MS, StreamIdleTracker,
  runStreamWithWatchdog, sinkUntilAbandoned, waitLlmStreamWithIdleTimeout,
} from '../src/stream-watchdog.ts';

afterEach(() => vi.useRealTimers());

describe('chat_v2/pipeline/helpers.rs::tests', () => {
  it('stream_idle_tracker_restarts_idle_window_after_stall', () => {
    const tick = STREAM_WATCHDOG_TICK_MS;
    const tracker = new StreamIdleTracker();
    expect(tracker.observe(20_000, tick)).toBe(20_000);
    // Process frozen for ~15 min: the resume tick is not judged.
    expect(tracker.observe(920_000, 900_000)).toBeNull();
    // Still silent afterwards: idle counts from resume only.
    expect(tracker.observe(930_000, tick)).toBe(10_000);
    // Data arrived: raw idle restarts and the baseline is dropped.
    expect(tracker.observe(3_000, tick)).toBe(3_000);
    expect(tracker.observe(13_000, tick)).toBe(13_000);
    expect(STREAM_WATCHDOG_STALL_GAP_MS).toBe(30_000);
  });
});

describe('chat_v2/pipeline/helpers.rs::tests (idle watchdog)', () => {
  it('idle_watchdog_does_not_fire_on_resume_after_process_freeze', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveProvider!: () => void;
    const provider = new Promise<void>((resolve) => { resolveProvider = resolve; });
    const task = waitLlmStreamWithIdleTimeout(
      provider, 600_000, 7_200_000, true, () => Date.now(), () => Date.now(),
    );

    // Simulate a 700s freeze: the clock jumps but no watchdog tick runs.
    vi.setSystemTime(700_000);
    await vi.advanceTimersByTimeAsync(STREAM_WATCHDOG_TICK_MS);

    // Provider finishes after resume: the stall must not be judged as idle.
    vi.setSystemTime(1_000_000);
    resolveProvider();
    expect(await task).toEqual({ kind: 'completed', outcome: { ok: true, value: undefined } });
  });

  it('idle_watchdog_still_fires_for_genuine_idle_after_resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const task = waitLlmStreamWithIdleTimeout(
      new Promise<never>(() => {}), 600_000, 7_200_000, true,
      () => Date.now(), () => Date.now(),
    );

    vi.setSystemTime(700_000);
    await vi.advanceTimersByTimeAsync(STREAM_WATCHDOG_TICK_MS);
    // Resume tick re-based the window; 600s of true silence still times out.
    await vi.advanceTimersByTimeAsync(610_000);

    const outcome = await task;
    expect(outcome.kind).toBe('idleTimeout');
    if (outcome.kind === 'idleTimeout') {
      expect(outcome.idleSecs).toBeGreaterThanOrEqual(600);
      expect(outcome.idleSecs).toBeLessThanOrEqual(620);
    }
    expect(Date.now()).toBeGreaterThanOrEqual(1_300_000);
  });

  it('idle_watchdog_fires_without_freeze', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const abort = new AbortController();
    const task = waitLlmStreamWithIdleTimeout(
      new Promise<never>(() => {}), 600_000, 7_200_000, true,
      () => Date.now(), () => Date.now(), abort,
    );

    await vi.advanceTimersByTimeAsync(600_000);
    expect(await task).toEqual({ kind: 'idleTimeout', idleSecs: 600 });
    expect(abort.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** A provider that, like the L02 transport, only settles after its cancel request has been observed. */
function cancellableProvider() {
  const steps: string[] = [];
  let abandoned!: AbortSignal;
  let settle!: () => void;
  const run = {
    start: vi.fn((signal: AbortSignal) => {
      abandoned = signal;
      return new Promise<string>(resolve => {
        settle = () => { steps.push('provider settled'); resolve('late'); };
        signal.addEventListener('abort', () => steps.push('provider saw abandon'), { once: true });
      });
    }),
    cancelUpstream: vi.fn(async () => { steps.push('cancelUpstream'); }),
    idleElapsed: () => Date.now(),
    now: () => Date.now(),
  };
  return { run, steps, signal: () => abandoned, settle: () => settle() };
}

describe('runStreamWithWatchdog (shared provider-call race)', () => {
  it('idle timeout abandons the call once, cancels upstream and drains the provider before returning', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const p = cancellableProvider();
    let returned = false;
    const task = runStreamWithWatchdog({ ...p.run, idleLimitMs: 5_000, totalLimitMs: 7_200_000, cancelOnIdle: true })
      .then(outcome => { returned = true; return outcome; });
    await vi.advanceTimersByTimeAsync(STREAM_WATCHDOG_TICK_MS);
    expect(p.signal().aborted).toBe(true);
    expect(p.run.cancelUpstream).toHaveBeenCalledTimes(1);
    // The provider promise has not settled yet: Rust's dropped future is only emulated once it is drained.
    expect(returned).toBe(false);
    p.settle();
    expect(await task).toEqual({ kind: 'idleTimeout', idleSecs: 10 });
    expect(p.steps).toEqual(['cancelUpstream', 'provider saw abandon', 'provider settled']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('absolute limit is enforced even when idle auto-cancel is disabled', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const p = cancellableProvider();
    const task = runStreamWithWatchdog({ ...p.run, idleElapsed: () => 0, idleLimitMs: 5_000, totalLimitMs: 20_000, cancelOnIdle: false });
    await vi.advanceTimersByTimeAsync(20_000);
    p.settle();
    expect(await task).toEqual({ kind: 'totalTimeout', totalSecs: 20 });
    expect(p.run.cancelUpstream).toHaveBeenCalledTimes(1);
  });

  it('caller cancellation wins the race immediately, cancels upstream once and drains the provider', async () => {
    const p = cancellableProvider();
    const cancel = new AbortController();
    const task = runStreamWithWatchdog({ ...p.run, cancellation: cancel.signal, idleLimitMs: 600_000,
      totalLimitMs: 7_200_000, cancelOnIdle: true });
    cancel.abort();
    expect(p.signal().aborted).toBe(true);
    expect(p.run.cancelUpstream).toHaveBeenCalledTimes(1);
    p.settle();
    expect(await task).toEqual({ kind: 'cancelled' });
    expect(p.steps).toEqual(['cancelUpstream', 'provider saw abandon', 'provider settled']);
    expect(p.run.cancelUpstream).toHaveBeenCalledTimes(1);
  });

  it('an already-cancelled token never starts the provider', async () => {
    const p = cancellableProvider();
    const cancel = new AbortController(); cancel.abort();
    expect(await runStreamWithWatchdog({ ...p.run, cancellation: cancel.signal, idleLimitMs: 1, totalLimitMs: 1, cancelOnIdle: true }))
      .toEqual({ kind: 'cancelled' });
    expect(p.run.start).not.toHaveBeenCalled();
    expect(p.run.cancelUpstream).not.toHaveBeenCalled();
  });

  it('a completed call is never abandoned; provider errors (sync or async) are reported as completed outcomes', async () => {
    const cancelUpstream = vi.fn();
    const cancel = new AbortController();
    let signal!: AbortSignal;
    const base = { cancelUpstream, cancellation: cancel.signal, idleElapsed: () => 0, idleLimitMs: 600_000, totalLimitMs: 7_200_000, cancelOnIdle: true };
    expect(await runStreamWithWatchdog({ ...base, start: abandoned => { signal = abandoned; return Promise.resolve('ok'); } }))
      .toEqual({ kind: 'completed', outcome: { ok: true, value: 'ok' } });
    expect(signal.aborted).toBe(false);
    const failure = new Error('connection reset');
    expect(await runStreamWithWatchdog({ ...base, start: () => Promise.reject(failure) }))
      .toEqual({ kind: 'completed', outcome: { ok: false, error: failure } });
    expect(await runStreamWithWatchdog({ ...base, start: () => { throw failure; } }))
      .toEqual({ kind: 'completed', outcome: { ok: false, error: failure } });
    cancel.abort();
    expect(cancelUpstream).not.toHaveBeenCalled();
  });

  it('a failing cancel request is logged, not thrown over the outcome', async () => {
    const p = cancellableProvider();
    p.run.cancelUpstream.mockImplementationOnce(async () => { throw new Error('registry gone'); });
    const cancel = new AbortController();
    const task = runStreamWithWatchdog({ ...p.run, cancellation: cancel.signal, idleLimitMs: 600_000, totalLimitMs: 7_200_000, cancelOnIdle: true });
    cancel.abort(); p.settle();
    expect(await task).toEqual({ kind: 'cancelled' });
  });

  it('sinkUntilAbandoned forwards until the call is abandoned, then drops everything', () => {
    const seen: string[] = [];
    const abandon = new AbortController();
    const sink = sinkUntilAbandoned({ emit: channel => seen.push(channel) }, abandon.signal);
    sink.emit('stream_start', {});
    abandon.abort();
    sink.emit('stream_cancelled', {});
    expect(seen).toEqual(['stream_start']);
  });
});
