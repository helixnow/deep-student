/**
 * Eval runner.
 *
 * 设计：纯函数 + 真实 rAF，绕过 React DOM。
 * - 评估的是 smoothing 算法本身在不同输入节奏下的表现
 * - 不引入 DOM render 成本，让信号更纯净
 * - 单次运行通常 < 2s，矩阵跑 (10 cases × 4 presets) 约 60–80s
 */

import {
  computeNextSmoothedContentByTime,
  getStreamingSmoothingConfig,
  type StreamingSmoothingPreset,
} from '@/features/chat/components/renderers/streamingSmoothing';
import {
  createStreamingMarkdownProfiler,
} from '@/features/chat/components/renderers/streamingProfiler';
import {
  deriveMetrics,
  eventsToTimeSeries,
} from '@/features/chat/components/renderers/streamingMetrics';
import { planChunks } from './rhythm';
import { computeScores } from './scoring';
import type {
  EvalCase,
  EvalCaseResult,
  EvalConfig,
  EvalReport,
  RhythmStrategy,
} from './types';

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, Math.round(ms))));

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const requestFrame = (cb: (ts: number) => void): number => {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(cb);
  }
  return setTimeout(() => cb(now()), 16) as unknown as number;
};

const cancelFrame = (id: number) => {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id);
  } else {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
};

interface RunnerOptions {
  preset: StreamingSmoothingPreset;
  source: string;
  rhythm: RhythmStrategy;
  caseTimeoutMs?: number;
  signal?: AbortSignal;
}

interface RunnerOutput {
  events: ReturnType<ReturnType<typeof createStreamingMarkdownProfiler>['getSnapshot']>['events'];
  durationMs: number;
  failed: boolean;
  failReason?: string;
}

async function runOneCase(opts: RunnerOptions): Promise<RunnerOutput> {
  const { preset, source, rhythm, caseTimeoutMs = 30000, signal } = opts;
  const config = getStreamingSmoothingConfig(preset);
  const profiler = createStreamingMarkdownProfiler({
    enabled: true,
    label: `eval-${preset}`,
    maxEvents: 5000,
  });

  const start = now();
  let target = '';
  let displayed = '';
  let lastTickTs = 0;
  let rafId: number | null = null;
  let stopped = false;

  const tick = (ts: number) => {
    if (stopped) return;
    rafId = null;
    const dt = lastTickTs === 0 ? 16 : ts - lastTickTs;
    lastTickTs = ts;

    if (displayed.length < target.length) {
      const step = computeNextSmoothedContentByTime(displayed, target, config, dt);
      if (step.reason !== 'noop') {
        displayed = step.content;
        profiler.record({
          type: 'display',
          preset,
          targetLength: target.length,
          displayedLength: displayed.length,
          delta: step.delta,
          remaining: step.remaining,
          reason: step.reason,
        });
      }
    }

    // 继续 tick 直到达到目标且 feeder 完成
    if (!stopped) {
      rafId = requestFrame(tick);
    }
  };

  const startTickLoop = () => {
    if (rafId === null && !stopped) {
      rafId = requestFrame(tick);
    }
  };

  const stopTickLoop = () => {
    stopped = true;
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
  };

  // Plan chunks
  const plan = planChunks(rhythm, source.length);

  // Timeout guard
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    stopTickLoop();
  }, caseTimeoutMs);

  // Abort guard
  const onAbort = () => {
    stopTickLoop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // Start ticking
    startTickLoop();

    // Feeder: push chunks at the planned cadence
    let pos = 0;
    for (const step of plan) {
      if (stopped || timedOut || signal?.aborted) break;
      if (step.chunkChars > 0) {
        pos = Math.min(source.length, pos + step.chunkChars);
        target = source.slice(0, pos);
        profiler.record({
          type: 'target',
          preset,
          targetLength: target.length,
          displayedLength: displayed.length,
        });
      }
      if (step.sleepMs > 0) {
        await sleep(step.sleepMs);
      }
    }

    // Drain: wait until displayed catches up to target (or timeout)
    const drainStart = now();
    while (!stopped && !timedOut && !signal?.aborted) {
      if (displayed.length >= target.length) break;
      if (now() - drainStart > caseTimeoutMs) {
        timedOut = true;
        break;
      }
      await sleep(16);
    }

    // Force flush at end
    if (displayed !== target) {
      profiler.record({
        type: 'flush',
        preset,
        targetLength: target.length,
        displayedLength: target.length,
      });
    }
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
    stopTickLoop();
  }

  const events = profiler.getSnapshot().events;
  return {
    events,
    durationMs: now() - start,
    failed: timedOut || (signal?.aborted ?? false),
    failReason: timedOut ? 'timeout' : signal?.aborted ? 'aborted' : undefined,
  };
}

export interface RunEvalProgress {
  current: number;
  total: number;
  caseId: string;
  preset: StreamingSmoothingPreset;
}

export interface RunEvalOptions extends EvalConfig {
  signal?: AbortSignal;
  onProgress?: (p: RunEvalProgress) => void;
}

export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const { cases, presets, rhythm, caseTimeoutMs = 30000, signal, onProgress } = options;
  const startedAt = new Date().toISOString();
  const startMs = now();

  const results: EvalCaseResult[] = [];
  const total = cases.length * presets.length;
  let current = 0;

  const presetSums: Record<string, number> = {};
  const presetCounts: Record<string, number> = {};

  for (const c of cases) {
    for (const preset of presets) {
      if (signal?.aborted) break;
      current += 1;
      onProgress?.({ current, total, caseId: c.id, preset });

      const out = await runOneCase({
        preset,
        source: c.source,
        rhythm,
        caseTimeoutMs,
        signal,
      });

      const metrics = deriveMetrics(out.events);
      const series = eventsToTimeSeries(out.events, 600);
      const targetCps = c.targetCps ?? 480;
      const { sub, total: scoreTotal } = computeScores(metrics, targetCps);

      const result: EvalCaseResult = {
        caseId: c.id,
        caseLabel: c.label,
        preset,
        metrics,
        series,
        scores: sub,
        total: scoreTotal,
        failed: out.failed,
        failReason: out.failReason,
        durationMs: Math.round(out.durationMs),
      };
      results.push(result);

      presetSums[preset] = (presetSums[preset] ?? 0) + scoreTotal;
      presetCounts[preset] = (presetCounts[preset] ?? 0) + 1;
    }
    if (signal?.aborted) break;
  }

  const presetAverages: Record<string, number> = {};
  for (const k of Object.keys(presetSums)) {
    presetAverages[k] = Math.round((presetSums[k] / Math.max(1, presetCounts[k])) * 10) / 10;
  }

  const finishedAt = new Date().toISOString();
  return {
    startedAt,
    finishedAt,
    totalMs: Math.round(now() - startMs),
    rhythm,
    results,
    presetAverages,
  };
}

/**
 * 运行单个 case（用于轻量调试）。
 */
export async function runSingleCase(
  c: EvalCase,
  preset: StreamingSmoothingPreset,
  rhythm: RhythmStrategy,
  signal?: AbortSignal,
): Promise<EvalCaseResult> {
  const out = await runOneCase({ preset, source: c.source, rhythm, signal });
  const metrics = deriveMetrics(out.events);
  const series = eventsToTimeSeries(out.events, 600);
  const targetCps = c.targetCps ?? 480;
  const { sub, total } = computeScores(metrics, targetCps);
  return {
    caseId: c.id,
    caseLabel: c.label,
    preset,
    metrics,
    series,
    scores: sub,
    total,
    failed: out.failed,
    failReason: out.failReason,
    durationMs: Math.round(out.durationMs),
  };
}
