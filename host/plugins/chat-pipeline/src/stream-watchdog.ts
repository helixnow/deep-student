/**
 * chat_v2/pipeline/helpers.rs — stream watchdog idle bookkeeping.
 *
 * The adapter measures idle time with a monotonic clock. That clock keeps
 * running while the process is merely frozen (device suspend / background
 * freezer), so the first watchdog tick after resume would otherwise see a huge
 * idle value and abort a healthy stream. A stalled tick re-bases idle time so
 * the stream gets a fresh window measured from resume.
 */
import type { StreamEventSink } from '../../llm/api.ts';

/** Watchdog tick interval. */
export const STREAM_WATCHDOG_TICK_MS = 10_000;
/** A tick gap this long means the process was not scheduled at all. */
export const STREAM_WATCHDOG_STALL_GAP_MS = 30_000;

export class StreamIdleTracker {
  private frozenBaselineMs = 0;

  /**
   * Returns effective idle time in milliseconds, or null for a stalled tick
   * whose idle value must not be judged (the process just resumed).
   */
  observe(rawIdleMs: number, tickGapMs: number): number | null {
    if (rawIdleMs < this.frozenBaselineMs) this.frozenBaselineMs = 0;
    if (tickGapMs >= STREAM_WATCHDOG_STALL_GAP_MS) {
      this.frozenBaselineMs = rawIdleMs;
      return null;
    }
    return Math.max(0, rawIdleMs - this.frozenBaselineMs);
  }
}

/** Log surface matching helpers.rs watchdog logs. */
export interface StreamWatchdogLog {
  info(message: string): void;
  warn(message: string): void;
}

let watchdogLogger: StreamWatchdogLog = { info() {}, warn() {} };

export function configureStreamWatchdogLogger(logger: StreamWatchdogLog): void {
  watchdogLogger = logger;
}

/** helpers.rs `LlmStreamWaitOutcome`. */
export type LlmStreamWaitOutcome<T> =
  | { kind: 'completed'; outcome: { ok: true; value: T } | { ok: false; error: unknown } }
  | { kind: 'idleTimeout'; idleSecs: number }
  | { kind: 'totalTimeout'; totalSecs: number };

/**
 * helpers.rs `wait_llm_stream_with_idle_timeout`: wait for the provider future
 * while a 10s watchdog tick enforces an idle limit and an absolute cap.
 *
 * `now` is injectable so tests can model a suspended process: the clock jumps
 * but no tick runs, and the first tick after resume re-bases the idle window.
 */
export async function waitLlmStreamWithIdleTimeout<T>(
  future: Promise<T>,
  idleLimitMs: number,
  totalLimitMs: number,
  cancelOnIdle: boolean,
  idleElapsed: () => number,
  now: () => number = () => performance.now(),
  abort?: AbortController,
): Promise<LlmStreamWaitOutcome<T>> {
  const started = now();
  let lastTick = started;
  const tracker = new StreamIdleTracker();
  let idleWarned = false;

  return new Promise<LlmStreamWaitOutcome<T>>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: LlmStreamWaitOutcome<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Rust drops the pinned future on timeout, cancelling the provider call.
      if (outcome.kind !== 'completed') abort?.abort();
      resolve(outcome);
    };

    future.then(
      value => finish({ kind: 'completed', outcome: { ok: true, value } }),
      error => finish({ kind: 'completed', outcome: { ok: false, error } }),
    );

    const schedule = (): void => {
      timer = setTimeout(onTick, STREAM_WATCHDOG_TICK_MS);
    };

    const onTick = (): void => {
      if (settled) return;
      const current = now();
      const tickGap = Math.max(0, current - lastTick);
      lastTick = current;
      const effective = tracker.observe(idleElapsed(), tickGap);
      if (effective === null) {
        idleWarned = false;
        watchdogLogger.info('[ChatV2::pipeline] LLM stream watchdog resumed after a '
          + `${Math.floor(tickGap / 1000)}s scheduling gap (process frozen/suspended); `
          + 'idle window restarted');
      } else if (effective >= idleLimitMs) {
        if (cancelOnIdle) {
          finish({ kind: 'idleTimeout', idleSecs: Math.floor(effective / 1000) });
          return;
        }
        if (!idleWarned) {
          idleWarned = true;
          watchdogLogger.warn(`[ChatV2::pipeline] LLM stream idle for `
            + `${Math.floor(effective / 1000)}s (limit ${Math.floor(idleLimitMs / 1000)}s); `
            + `auto_cancel_on_timeout=false, keep waiting until absolute limit `
            + `${Math.floor(totalLimitMs / 1000)}s`);
        }
      } else {
        idleWarned = false;
      }
      const total = current - started;
      if (total >= totalLimitMs) {
        finish({ kind: 'totalTimeout', totalSecs: Math.floor(total / 1000) });
        return;
      }
      schedule();
    };

    schedule();
  });
}

/** {@link runStreamWithWatchdog} outcome: the watchdog result, or the caller's cancel token winning the race. */
export type StreamWatchdogOutcome<T> = LlmStreamWaitOutcome<T> | { kind: 'cancelled' };

export interface StreamWatchdogRun<T> {
  /**
   * Starts the provider call. `abandoned` aborts once the call is given up (caller cancel or watchdog
   * timeout); from then on the call stands for Rust's dropped future and must not reach the frontend.
   */
  start(abandoned: AbortSignal): Promise<T>;
  /** Stops the upstream stream (revoke hooks, then `requestCancelStream`). Runs once, when the call is abandoned. */
  cancelUpstream(): void | Promise<void>;
  /** Caller cancel token; wins the race like Rust `select!` on `cancel_token.cancelled()`. */
  cancellation?: AbortSignal | null;
  idleLimitMs: number;
  totalLimitMs: number;
  cancelOnIdle: boolean;
  idleElapsed(): number;
  now?: () => number;
}

/**
 * The provider-call race shared by the chat pipelines (tool_loop.rs:1258/1400, multi_variant.rs:1495).
 *
 * Rust drops the provider future on cancel or timeout, which closes the HTTP stream before the caller moves
 * on. A promise cannot be dropped, so an abandoned call wakes the transport via `cancelUpstream` and is then
 * drained: on return the socket is released and the transport has cleared the stream's cancel artifacts, so
 * the same stream key can be retried or cleaned up without racing the old call.
 */
export async function runStreamWithWatchdog<T>(run: StreamWatchdogRun<T>): Promise<StreamWatchdogOutcome<T>> {
  const cancellation = run.cancellation ?? null;
  if (cancellation?.aborted) return { kind: 'cancelled' };
  const abandon = new AbortController();
  let upstream: Promise<void> | undefined;
  abandon.signal.addEventListener('abort', () => {
    upstream = (async () => { await run.cancelUpstream(); })().catch((error: unknown) => {
      watchdogLogger.warn(`[ChatV2::pipeline] LLM stream cancel request failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, { once: true });
  let removeCancel = (): void => {};
  const cancelled = new Promise<{ kind: 'cancelled' }>(resolve => {
    if (cancellation === null) return;
    const onCancel = (): void => { abandon.abort(); resolve({ kind: 'cancelled' }); };
    cancellation.addEventListener('abort', onCancel, { once: true });
    removeCancel = () => cancellation.removeEventListener('abort', onCancel);
  });
  let future: Promise<T>;
  try { future = run.start(abandon.signal); } catch (error) { future = Promise.reject(error); }
  try {
    const outcome = await Promise.race([waitLlmStreamWithIdleTimeout(future, run.idleLimitMs, run.totalLimitMs,
      run.cancelOnIdle, run.idleElapsed, run.now, abandon), cancelled]);
    if (outcome.kind !== 'completed') {
      abandon.abort();
      await future.then(() => undefined, () => undefined);
    }
    return outcome;
  } finally {
    removeCancel();
    await upstream;
  }
}

/** Sink of an abandoned provider call: forwards nothing once `abandoned` aborts (Rust's dropped future is silent). */
export function sinkUntilAbandoned(sink: StreamEventSink, abandoned: AbortSignal): StreamEventSink {
  return { emit: (channel, payload) => { if (!abandoned.aborted) sink.emit(channel, payload); } };
}
