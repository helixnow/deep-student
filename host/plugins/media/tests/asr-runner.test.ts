import { expect, it, vi } from 'vitest';
import {
  Aimd, type AsrClipResult, type AsrHttpError,
} from '../src/asr.ts';
import {
  Cancellation, MAX_CONSECUTIVE_SEGMENT_FAILURES, runAsrJobsWith,
  type AsrBackendLike, type AsrJob, type AsrRunSummary, type AsrSink,
} from '../src/asr-runner.ts';
import { MediaError } from '../src/errors.ts';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface ScriptedResult {
  ok?: AsrClipResult;
  error?: AsrHttpError;
}

class ScriptedBackend implements AsrBackendLike {
  private readonly script: ScriptedResult[];
  private readonly fallback: ScriptedResult;
  calls = 0;
  inflight = 0;
  peak = 0;
  delay = 5;

  constructor(script: ScriptedResult[], fallback: ScriptedResult) {
    this.script = [...script];
    this.fallback = fallback;
  }

  async transcribe(wav: Uint8Array): Promise<AsrClipResult> {
    expect(Buffer.from(wav.subarray(0, 4)).toString('latin1')).toBe('RIFF');
    this.calls += 1;
    this.inflight += 1;
    this.peak = Math.max(this.peak, this.inflight);
    await sleep(this.delay);
    this.inflight -= 1;
    const next = this.script.shift() ?? this.fallback;
    if (next.error !== undefined) throw next.error;
    return next.ok!;
  }

  modelLabel(): string { return 'scripted'; }
}

class RecordingSink implements AsrSink {
  readonly done: Array<{ idx: number; text: string; bounds: [number, number] | null }> = [];
  readonly failed: number[] = [];
  onDone(job: AsrJob, text: string, bounds: [number, number] | null): void {
    this.done.push({ idx: job.idx, text, bounds });
  }
  onFailed(job: AsrJob): void { this.failed.push(job.idx); }
}

function spool(seconds: number): { durationMs(): number; readMs(startMs: number, endMs: number): Int16Array } {
  const samples = seconds * 16_000;
  return {
    durationMs: () => Math.trunc(samples * 1000 / 16_000),
    readMs: (startMs, endMs) => {
      const start = Math.trunc(Math.max(startMs, 0) * 16_000 / 1000);
      const end = Math.min(Math.trunc(Math.max(endMs, 0) * 16_000 / 1000), samples);
      return new Int16Array(Math.max(end - start, 0)).fill(100);
    },
  };
}

function jobs(count: number): AsrJob[] {
  return Array.from({ length: count }, (_, index) => ({
    idx: index,
    startMs: index * 1000,
    endMs: index * 1000 + 800,
  }));
}

function ok(text: string): ScriptedResult {
  return { ok: { text, speechBoundsMs: null } };
}

function status(code: number, retryAfterSeconds: number | null = null): ScriptedResult {
  return { error: { kind: 'status', status: code, retryAfterSeconds, body: '' } };
}

async function settle(
  start: () => Promise<AsrRunSummary>,
  milliseconds = 600_000,
): Promise<{ ok: true; value: AsrRunSummary } | { ok: false; error: unknown }> {
  vi.useFakeTimers();
  try {
    const settled = start().then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(milliseconds);
    return await settled;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

it('runner_completes_and_grows_concurrency', async () => {
  const backend = new ScriptedBackend([], ok('x'));
  const sink = new RecordingSink();
  const result = await settle(() => runAsrJobsWith(
    backend, spool(30), jobs(24), new Cancellation(), sink, new Aimd(1, 1, 6)));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.done).toBe(24);
  expect(sink.done).toHaveLength(24);
  expect(result.value.peakConcurrency).toBeGreaterThan(1);
  expect(backend.peak).toBeLessThanOrEqual(6);
});

it('runner_backs_off_on_429_and_skips_400', async () => {
  const backend = new ScriptedBackend(
    [status(429, 1), status(400), status(503)], ok('y'));
  const sink = new RecordingSink();
  const result = await settle(() => runAsrJobsWith(
    backend, spool(10), jobs(6), new Cancellation(), sink, new Aimd(1, 1, 4)));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // 400 的段失败不重试；429/503 的段重试成功
  expect(result.value.failed).toBe(1);
  expect(result.value.done).toBe(5);
  expect(backend.calls).toBe(8);
});

it('runner_aborts_on_auth_failure', async () => {
  const unauthorized: AsrHttpError = {
    kind: 'status', status: 401, retryAfterSeconds: null, body: 'unauthorized',
  };
  const backend = new ScriptedBackend([ok('a')], { error: unauthorized });
  const sink = new RecordingSink();
  const result = await settle(() => runAsrJobsWith(
    backend, spool(10), jobs(5), new Cancellation(), sink, new Aimd(1, 1, 1)));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const error = result.error as MediaError;
  expect(error).toBeInstanceOf(MediaError);
  expect(error.code).toBe('auth-failed');
  expect(sink.done).toHaveLength(1);
});

it('runner_stops_after_consecutive_failures', async () => {
  const backend = new ScriptedBackend([], status(400));
  const sink = new RecordingSink();
  const result = await settle(() => runAsrJobsWith(
    backend, spool(20), jobs(12), new Cancellation(), sink, new Aimd(1, 1, 1)));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const error = result.error as MediaError;
  expect(error.code).toBe('transcription-failed');
  expect(sink.failed).toHaveLength(MAX_CONSECUTIVE_SEGMENT_FAILURES);
});

it('runner_cancellation_keeps_completed_segments', async () => {
  const backend = new ScriptedBackend([], ok('z'));
  backend.delay = 1000;
  const cancel = new Cancellation();
  const sink = new RecordingSink();
  const result = await settle(() => {
    setTimeout(() => cancel.cancel(), 2500);
    return runAsrJobsWith(
      backend, spool(20), jobs(10), cancel, sink, new Aimd(1, 1, 1));
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(MediaError);
  expect((result.error as MediaError).code).toBe('cancelled');
  expect(sink.done).toHaveLength(2);
});
