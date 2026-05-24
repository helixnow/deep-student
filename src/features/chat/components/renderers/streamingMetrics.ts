/**
 * streamingMetrics.ts
 *
 * 在 streamingProfiler 的事件流之上派生体感指标：
 * - TTFT (Time To First Token): 首个 display 与首个 target 的时间差
 * - TPS (Tokens/Chars Per Second): 30 帧滑窗 chars/s
 * - frameP50 / frameP95: 帧间隔分位数（基于 display 事件）
 * - backlog: target.length - displayed.length 的当前/最大/均值
 * - jankCount: 帧间隔 > 100ms 或 backlog 暴涨 (>2x median) 的次数
 * - totalChars / totalDurationMs: 整段流式过程的总量与耗时
 *
 * 与 profiler 的关系：metrics 是 profiler 事件的派生视图，
 * 不修改 profiler 本身，可被多个面板独立订阅。
 */

import {
  streamingMarkdownProfiler,
  type StreamingMarkdownProfiler,
  type StreamingMarkdownProfilerEvent,
  type StreamingMarkdownProfilerSnapshot,
} from './streamingProfiler';
import type { StreamingSmoothingPreset } from './streamingSmoothing';

export interface StreamingMetricsSnapshot {
  /** 首字时间 (ms)，未采集到则为 null */
  ttftMs: number | null;
  /** 当前 TPS（chars/s），最近 30 个 display 事件的滑窗 */
  tps: number;
  /** 平均 TPS（整段流式期间） */
  avgTps: number;
  /** 帧间隔分位数（display 事件之间的 dt） */
  frameP50: number;
  frameP95: number;
  /** Backlog 字符数 */
  backlogCurrent: number;
  backlogMax: number;
  backlogMean: number;
  /** Jank 次数（帧 >100ms 或 backlog 暴涨） */
  jankCount: number;
  /** 总字符数（最大 displayedLength） */
  totalChars: number;
  /** 总耗时 (ms)，从首个 target 到最近一次 display */
  totalDurationMs: number;
  /** 当前 preset */
  preset: StreamingSmoothingPreset | null;
  /** 事件总数 */
  eventCount: number;
}

const EMPTY_METRICS: StreamingMetricsSnapshot = {
  ttftMs: null,
  tps: 0,
  avgTps: 0,
  frameP50: 0,
  frameP95: 0,
  backlogCurrent: 0,
  backlogMax: 0,
  backlogMean: 0,
  jankCount: 0,
  totalChars: 0,
  totalDurationMs: 0,
  preset: null,
  eventCount: 0,
};

/**
 * 计算分位数（线性插值），输入数组会被原地排序。
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  values.sort((a, b) => a - b);
  const idx = (values.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return values[lo];
  return values[lo] + (values[hi] - values[lo]) * (idx - lo);
}

/**
 * 从 profiler 事件流派生 metrics。
 */
export function deriveMetrics(events: StreamingMarkdownProfilerEvent[]): StreamingMetricsSnapshot {
  if (events.length === 0) return { ...EMPTY_METRICS };

  let firstTarget: StreamingMarkdownProfilerEvent | null = null;
  let firstDisplay: StreamingMarkdownProfilerEvent | null = null;
  let lastDisplay: StreamingMarkdownProfilerEvent | null = null;
  let lastTarget: StreamingMarkdownProfilerEvent | null = null;
  let preset: StreamingSmoothingPreset | null = null;

  let totalChars = 0;
  const backlogs: number[] = [];
  let backlogMax = 0;

  // 帧间隔（display 事件之间的 dt）
  const frameDeltas: number[] = [];
  let prevDisplayTs = 0;

  // TPS 滑窗（最近 30 个 display 事件的 charsPerSec 估计）
  const recent: { ts: number; displayed: number }[] = [];

  let jankCount = 0;
  const RECENT_WINDOW = 30;
  const FRAME_JANK_THRESHOLD_MS = 100;

  for (const ev of events) {
    if (ev.preset && !preset) preset = ev.preset;

    if (ev.type === 'reset') {
      // reset 重置派生状态：从 reset 之后重新开始统计
      firstTarget = null;
      firstDisplay = null;
      lastDisplay = null;
      lastTarget = null;
      totalChars = 0;
      backlogs.length = 0;
      backlogMax = 0;
      frameDeltas.length = 0;
      prevDisplayTs = 0;
      recent.length = 0;
      jankCount = 0;
      continue;
    }

    if (ev.type === 'target') {
      if (!firstTarget) firstTarget = ev;
      lastTarget = ev;
    }

    if (ev.type === 'display' || ev.type === 'flush') {
      if (!firstDisplay) firstDisplay = ev;
      lastDisplay = ev;

      const displayed = ev.displayedLength ?? 0;
      if (displayed > totalChars) totalChars = displayed;

      // 帧间隔
      if (prevDisplayTs > 0) {
        const dt = ev.timestamp - prevDisplayTs;
        frameDeltas.push(dt);
        if (dt > FRAME_JANK_THRESHOLD_MS) jankCount += 1;
      }
      prevDisplayTs = ev.timestamp;

      // backlog
      const target = ev.targetLength ?? 0;
      const backlog = Math.max(0, target - displayed);
      backlogs.push(backlog);
      if (backlog > backlogMax) backlogMax = backlog;

      // TPS 滑窗
      recent.push({ ts: ev.timestamp, displayed });
      if (recent.length > RECENT_WINDOW) recent.shift();
    }
  }

  const ttftMs =
    firstTarget && firstDisplay ? Math.max(0, firstDisplay.timestamp - firstTarget.timestamp) : null;

  // TPS（最近窗口）
  let tps = 0;
  if (recent.length >= 2) {
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dtMs = last.ts - first.ts;
    if (dtMs > 0) {
      tps = ((last.displayed - first.displayed) * 1000) / dtMs;
    }
  }

  // 平均 TPS
  let avgTps = 0;
  if (firstTarget && lastDisplay) {
    const totalMs = lastDisplay.timestamp - firstTarget.timestamp;
    if (totalMs > 0) avgTps = (totalChars * 1000) / totalMs;
  }

  // frame p50 / p95
  const frameP50 = percentile([...frameDeltas], 0.5);
  const frameP95 = percentile([...frameDeltas], 0.95);

  // backlog 均值
  const backlogMean =
    backlogs.length === 0 ? 0 : backlogs.reduce((s, b) => s + b, 0) / backlogs.length;
  const backlogCurrent =
    lastDisplay && lastTarget
      ? Math.max(0, (lastTarget.targetLength ?? 0) - (lastDisplay.displayedLength ?? 0))
      : 0;

  // 总耗时
  const totalDurationMs =
    firstTarget && lastDisplay ? Math.max(0, lastDisplay.timestamp - firstTarget.timestamp) : 0;

  return {
    ttftMs,
    tps: Math.max(0, Math.round(tps)),
    avgTps: Math.max(0, Math.round(avgTps)),
    frameP50: Math.round(frameP50 * 10) / 10,
    frameP95: Math.round(frameP95 * 10) / 10,
    backlogCurrent,
    backlogMax,
    backlogMean: Math.round(backlogMean * 10) / 10,
    jankCount,
    totalChars,
    totalDurationMs: Math.round(totalDurationMs),
    preset,
    eventCount: events.length,
  };
}

/**
 * 时间序列点（用于绘图）
 */
export interface MetricsTimePoint {
  /** 相对起点的时间 (ms) */
  t: number;
  /** Backlog 字符数 */
  backlog: number;
  /** 已显示字符数 */
  displayed: number;
  /** 目标字符数 */
  target: number;
  /** 帧间隔 dt (ms)，首个点为 0 */
  frameMs: number;
  /** 瞬时 TPS（基于上一点） */
  tps: number;
}

/**
 * 将 events 转为时间序列（用于实时折线图）。
 * 仅采样 display/flush 事件。
 */
export function eventsToTimeSeries(
  events: StreamingMarkdownProfilerEvent[],
  maxPoints = 600,
): MetricsTimePoint[] {
  const filtered = events.filter((e) => e.type === 'display' || e.type === 'flush');
  if (filtered.length === 0) return [];

  const start = filtered[0].timestamp;
  const points: MetricsTimePoint[] = [];
  let prev = filtered[0];

  for (let i = 0; i < filtered.length; i++) {
    const ev = filtered[i];
    const displayed = ev.displayedLength ?? 0;
    const target = ev.targetLength ?? 0;
    const dtMs = i === 0 ? 0 : ev.timestamp - prev.timestamp;
    const deltaChars = i === 0 ? 0 : displayed - (prev.displayedLength ?? 0);
    const tps = dtMs > 0 ? Math.round((deltaChars * 1000) / dtMs) : 0;

    points.push({
      t: Math.round(ev.timestamp - start),
      backlog: Math.max(0, target - displayed),
      displayed,
      target,
      frameMs: Math.round(dtMs * 10) / 10,
      tps,
    });

    prev = ev;
  }

  // 抽稀到 maxPoints
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out: MetricsTimePoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.floor(i * step)]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// ─── React-friendly subscription ──────────────────────────────────────────────

export interface StreamingMetricsBundle {
  metrics: StreamingMetricsSnapshot;
  series: MetricsTimePoint[];
  rawEvents: StreamingMarkdownProfilerEvent[];
}

export type StreamingMetricsListener = (bundle: StreamingMetricsBundle) => void;

/**
 * 订阅 profiler 并派发派生 metrics。
 */
export function subscribeMetrics(
  listener: StreamingMetricsListener,
  profiler: StreamingMarkdownProfiler = streamingMarkdownProfiler,
  seriesMaxPoints = 600,
): () => void {
  const compute = (snapshot: StreamingMarkdownProfilerSnapshot) => {
    const metrics = deriveMetrics(snapshot.events);
    const series = eventsToTimeSeries(snapshot.events, seriesMaxPoints);
    listener({ metrics, series, rawEvents: snapshot.events });
  };

  // 初次推送
  compute(profiler.getSnapshot());
  return profiler.subscribe(compute);
}

/**
 * 同步获取一次 metrics（不订阅）。
 */
export function getMetricsSnapshot(
  profiler: StreamingMarkdownProfiler = streamingMarkdownProfiler,
  seriesMaxPoints = 600,
): StreamingMetricsBundle {
  const snapshot = profiler.getSnapshot();
  return {
    metrics: deriveMetrics(snapshot.events),
    series: eventsToTimeSeries(snapshot.events, seriesMaxPoints),
    rawEvents: snapshot.events,
  };
}
