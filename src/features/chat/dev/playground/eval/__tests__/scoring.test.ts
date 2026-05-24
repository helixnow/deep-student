import { describe, expect, it } from 'vitest';
import {
  computeScores,
  jankPenalty,
  scoreResponsiveness,
  scoreSmoothness,
  scoreThroughput,
  scoreToColor,
} from '../scoring';
import type { StreamingMetricsSnapshot } from '@/features/chat/components/renderers/streamingMetrics';

const baseMetrics = (over: Partial<StreamingMetricsSnapshot> = {}): StreamingMetricsSnapshot => ({
  ttftMs: 80,
  tps: 480,
  avgTps: 480,
  frameP50: 16,
  frameP95: 16,
  backlogCurrent: 0,
  backlogMax: 0,
  backlogMean: 0,
  jankCount: 0,
  totalChars: 1000,
  totalDurationMs: 2000,
  preset: 'balanced',
  eventCount: 100,
  ...over,
});

describe('eval/scoring', () => {
  it('returns full smoothness at 16ms p95 and degrades to ~16 at 100ms', () => {
    expect(scoreSmoothness(baseMetrics({ frameP95: 16 }))).toBe(100);
    expect(scoreSmoothness(baseMetrics({ frameP95: 100 }))).toBe(16);
    expect(scoreSmoothness(baseMetrics({ frameP95: 200 }))).toBe(16);
  });

  it('returns full responsiveness at TTFT <= 80ms', () => {
    expect(scoreResponsiveness(baseMetrics({ ttftMs: 50 }))).toBe(100);
    expect(scoreResponsiveness(baseMetrics({ ttftMs: 80 }))).toBe(100);
    expect(scoreResponsiveness(baseMetrics({ ttftMs: 880 }))).toBe(0);
    expect(scoreResponsiveness(baseMetrics({ ttftMs: null }))).toBe(0);
  });

  it('throughput peaks at target and decays linearly', () => {
    expect(scoreThroughput(baseMetrics({ avgTps: 480 }), 480)).toBe(100);
    expect(scoreThroughput(baseMetrics({ avgTps: 240 }), 480)).toBe(50);
    expect(scoreThroughput(baseMetrics({ avgTps: 0 }), 480)).toBe(0);
  });

  it('jank penalty caps at 30', () => {
    expect(jankPenalty(baseMetrics({ jankCount: 0 }))).toBe(0);
    expect(jankPenalty(baseMetrics({ jankCount: 3 }))).toBe(15);
    expect(jankPenalty(baseMetrics({ jankCount: 100 }))).toBe(30);
  });

  it('total combines weighted subscores minus jank penalty', () => {
    const { total, sub } = computeScores(baseMetrics(), 480);
    // 100*0.5 + 100*0.3 + 100*0.2 - 0 = 100
    expect(total).toBe(100);
    expect(sub.smoothness).toBe(100);
    expect(sub.responsiveness).toBe(100);
    expect(sub.throughput).toBe(100);
    expect(sub.jankPenalty).toBe(0);
  });

  it('total never goes negative', () => {
    const { total } = computeScores(
      baseMetrics({
        ttftMs: 5000,
        frameP95: 500,
        avgTps: 0,
        jankCount: 50,
      }),
      480,
    );
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it('scoreToColor returns hsl with hue scaled to score', () => {
    expect(scoreToColor(0)).toContain('hsl(0,');
    expect(scoreToColor(100)).toContain('hsl(120,');
    expect(scoreToColor(50)).toContain('hsl(60,');
  });
});
