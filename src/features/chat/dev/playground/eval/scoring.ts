/**
 * Scoring functions for streaming eval.
 *
 * 权重决策：smoothness 50% / responsiveness 30% / throughput 20% - jankPenalty
 *
 * - smoothness:    100 - clamp(frameP95 - 16ms, 0, 84)
 * - responsiveness:100 - clamp((ttftMs - 80) / 8, 0, 100)
 * - throughput:    100 - abs(avgTps - target) / target * 100
 * - jankPenalty:   min(jankCount * 5, 30)
 *
 * total = smoothness*0.5 + responsiveness*0.3 + throughput*0.2 - jankPenalty
 */

import type { StreamingMetricsSnapshot } from '@/features/chat/components/renderers/streamingMetrics';
import type { EvalSubScores } from './types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function scoreSmoothness(metrics: StreamingMetricsSnapshot): number {
  // frameP95 = 16ms (60fps) → 100; 100ms → 16
  return clamp(100 - clamp(metrics.frameP95 - 16, 0, 84), 0, 100);
}

export function scoreResponsiveness(metrics: StreamingMetricsSnapshot): number {
  if (metrics.ttftMs == null) return 0;
  return clamp(100 - clamp((metrics.ttftMs - 80) / 8, 0, 100), 0, 100);
}

export function scoreThroughput(metrics: StreamingMetricsSnapshot, targetCps: number): number {
  if (targetCps <= 0) return 100;
  if (metrics.avgTps <= 0) return 0;
  const diff = Math.abs(metrics.avgTps - targetCps);
  return clamp(100 - (diff / targetCps) * 100, 0, 100);
}

export function jankPenalty(metrics: StreamingMetricsSnapshot): number {
  return Math.min(metrics.jankCount * 5, 30);
}

export function computeScores(
  metrics: StreamingMetricsSnapshot,
  targetCps: number,
): { sub: EvalSubScores; total: number } {
  const smoothness = scoreSmoothness(metrics);
  const responsiveness = scoreResponsiveness(metrics);
  const throughput = scoreThroughput(metrics, targetCps);
  const penalty = jankPenalty(metrics);

  const total =
    smoothness * 0.5 + responsiveness * 0.3 + throughput * 0.2 - penalty;

  return {
    sub: {
      smoothness: Math.round(smoothness * 10) / 10,
      responsiveness: Math.round(responsiveness * 10) / 10,
      throughput: Math.round(throughput * 10) / 10,
      jankPenalty: Math.round(penalty * 10) / 10,
    },
    total: Math.max(0, Math.round(total * 10) / 10),
  };
}

/**
 * 0–100 总分到颜色（用于热图）。
 */
export function scoreToColor(total: number): string {
  // hsl(120, 60%, 45%) = green; hsl(0, 70%, 50%) = red
  const hue = clamp((total / 100) * 120, 0, 120);
  return `hsl(${hue.toFixed(0)}, 65%, 45%)`;
}
