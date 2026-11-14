/**
 * `dstu-media/src/media/asr.rs`: the AIMD scheduling loop (`run_asr_jobs` /
 * `run_asr_jobs_with`) shared by the transcription pipeline.
 *
 * The loop is transport-agnostic: callers provide the backend, PCM spool and sink.
 * Decoding/VAD/spool production and VFS persistence remain native work, so the
 * pipeline command is not registered; this module is the reusable scheduler with
 * retry/backoff, rate-limit cooldown, cancellation and consecutive-failure abort.
 */
import {
  Aimd, classifyFailure, formatAsrHttpError, type AsrClipResult, type AsrHttpError,
} from './asr.ts';
import { MediaError } from './errors.ts';
import { encodeWavMono16k } from './wav.ts';

export const CLIP_PAD_MS = 100;
export const MAX_ATTEMPTS = 3;
export const MAX_RATE_LIMIT_ATTEMPTS = 8;
export const MAX_CONSECUTIVE_SEGMENT_FAILURES = 5;

export interface AsrJob {
  idx: number;
  startMs: number;
  endMs: number;
}

export interface AsrSpoolLike {
  durationMs(): number;
  readMs(startMs: number, endMs: number): Int16Array;
}

export interface AsrBackendLike {
  transcribe(wav: Uint8Array): Promise<AsrClipResult>;
  modelLabel(): string;
}

export interface AsrSink {
  onDone(job: AsrJob, text: string, bounds: [number, number] | null): void;
  onFailed(job: AsrJob, message: string): void;
}

export interface AsrRunSummary {
  done: number;
  failed: number;
  peakConcurrency: number;
}

/** `tokio_util::sync::CancellationToken` 的等价物。 */
export class Cancellation {
  private cancelledFlag = false;
  private readonly listeners: Array<() => void> = [];

  get isCancelled(): boolean { return this.cancelledFlag; }

  cancel(): void {
    if (this.cancelledFlag) return;
    this.cancelledFlag = true;
    for (const listener of this.listeners.splice(0)) listener();
  }

  /** 取消时 resolve 的 future（对应 `cancel.cancelled()`）。 */
  whenCancelled(): Promise<'cancelled'> {
    if (this.cancelledFlag) return Promise.resolve('cancelled');
    return new Promise(resolve => {
      this.listeners.push(() => resolve('cancelled'));
    });
  }
}

interface Queued {
  job: AsrJob;
  attempts: number;
  rateLimitedAttempts: number;
  notBefore: number | null;
}

interface Completion {
  kind: 'completion';
  seq: number;
  queued: Queued;
  result: AsrClipResult | null;
  error: AsrHttpError | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 按 AIMD 并发跑完全部段；取消时立即停止调度（已完成段已通过 sink 落库）。
 */
export async function runAsrJobsWith(
  backend: AsrBackendLike,
  spool: AsrSpoolLike,
  jobs: readonly AsrJob[],
  cancel: Cancellation,
  sink: AsrSink,
  aimd: Aimd,
): Promise<AsrRunSummary> {
  const totalMs = spool.durationMs();
  const queue: Queued[] = jobs.map(job => ({
    job, attempts: 0, rateLimitedAttempts: 0, notBefore: null,
  }));
  const inflight = new Map<number, Promise<Completion>>();
  const summary: AsrRunSummary = { done: 0, failed: 0, peakConcurrency: 0 };
  let consecutiveFailures = 0;
  let sequence = 0;

  const cancelled = cancel.whenCancelled();

  for (;;) {
    if (cancel.isCancelled) throw new MediaError('Cancelled', '');
    const now = performance.now();
    const cooling = aimd.coolingUntil(now);

    if (cooling === null) {
      while (inflight.size < aimd.limit()) {
        const position = queue.findIndex(
          queued => queued.notBefore === null || queued.notBefore <= now);
        if (position < 0) break;
        const queued = queue.splice(position, 1)[0]!;
        const clipStart = Math.max(queued.job.startMs - CLIP_PAD_MS, 0);
        const clipEnd = Math.min(
          queued.job.endMs + CLIP_PAD_MS, Math.max(totalMs, queued.job.endMs));
        const pcm = spool.readMs(clipStart, clipEnd);
        const wav = encodeWavMono16k(pcm);
        const seq = sequence;
        sequence += 1;
        inflight.set(seq, backend.transcribe(wav).then(
          result => ({ kind: 'completion' as const, seq, queued, result, error: null }),
          (error: AsrHttpError) => ({ kind: 'completion' as const, seq, queued, result: null, error }),
        ));
        summary.peakConcurrency = Math.max(summary.peakConcurrency, inflight.size);
      }
    }

    if (inflight.size === 0 && queue.length === 0) break;

    // 下次需要醒来的时刻：冷却中 → 冷却结束；否则最早的退避到期。
    let wake: number | null = null;
    if (cooling !== null) {
      if (queue.length > 0) wake = cooling;
    } else {
      const deadlines = queue
        .map(queued => queued.notBefore)
        .filter((value): value is number => value !== null);
      if (deadlines.length > 0) wake = Math.min(...deadlines);
    }

    const waits: Array<Promise<Completion | 'cancelled' | undefined>> = [
      ...inflight.values(),
      cancelled,
    ];
    if (wake !== null) waits.push(sleep(Math.max(wake - performance.now(), 0)).then(() => undefined));

    const raced = await Promise.race(waits);
    if (raced === 'cancelled' || cancel.isCancelled) throw new MediaError('Cancelled', '');
    if (raced === undefined) continue; // 只是退避/冷却到期，回到分发阶段

    inflight.delete(raced.seq);
    const queued = raced.queued;
    if (raced.error === null) {
      aimd.onSuccess();
      consecutiveFailures = 0;
      const clipStart = Math.max(queued.job.startMs - CLIP_PAD_MS, 0);
      const bounds = raced.result!.speechBoundsMs === null
        ? null
        : [clipStart + raced.result!.speechBoundsMs[0],
          clipStart + raced.result!.speechBoundsMs[1]] as [number, number];
      sink.onDone(queued.job, raced.result!.text, bounds);
      summary.done += 1;
      continue;
    }

    const error = raced.error;
    const failure = classifyFailure(error);
    switch (failure.kind) {
      case 'rate_limited': {
        aimd.onRateLimited(performance.now(), failure.retryAfterSeconds);
        queued.rateLimitedAttempts += 1;
        if (queued.rateLimitedAttempts > MAX_RATE_LIMIT_ATTEMPTS) {
          sink.onFailed(queued.job, formatAsrHttpError(error));
          summary.failed += 1;
          consecutiveFailures += 1;
        } else {
          queued.notBefore = aimd.coolingUntil(performance.now());
          queue.unshift(queued);
        }
        break;
      }
      case 'retryable': {
        aimd.onFailure();
        queued.attempts += 1;
        if (queued.attempts >= MAX_ATTEMPTS) {
          sink.onFailed(queued.job, formatAsrHttpError(error));
          summary.failed += 1;
          consecutiveFailures += 1;
        } else {
          const backoff = 1000 * (1 << Math.min(queued.attempts, 5));
          queued.notBefore = performance.now() + backoff;
          queue.push(queued);
        }
        break;
      }
      case 'segment_fatal': {
        aimd.onFailure();
        sink.onFailed(queued.job, formatAsrHttpError(error));
        summary.failed += 1;
        consecutiveFailures += 1;
        break;
      }
      case 'job_fatal': {
        throw new MediaError('AsrFatal',
          failure.code === 'auth-failed'
            ? `ASR 鉴权失败，请检查语音识别 API Key（${formatAsrHttpError(error)}）`
            : `ASR 模型不可用（${backend.modelLabel()}）：${formatAsrHttpError(error)}`,
          failure.code);
      }
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_SEGMENT_FAILURES) {
      throw new MediaError('AsrFatal',
        `连续 ${consecutiveFailures} 段转写失败，已暂停（已完成的段已保存，剩余 `
        + `${queue.length + inflight.size} 段可稍后继续）`,
        'transcription-failed');
    }
  }

  return summary;
}
