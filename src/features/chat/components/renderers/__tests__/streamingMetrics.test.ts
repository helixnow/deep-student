import { describe, expect, it } from 'vitest';
import { createStreamingMarkdownProfiler } from '../streamingProfiler';
import { deriveMetrics, eventsToTimeSeries } from '../streamingMetrics';

describe('streamingMetrics.deriveMetrics', () => {
  it('returns zeros for empty events', () => {
    const m = deriveMetrics([]);
    expect(m.ttftMs).toBeNull();
    expect(m.tps).toBe(0);
    expect(m.totalChars).toBe(0);
    expect(m.eventCount).toBe(0);
  });

  it('computes TTFT from first target to first display', () => {
    const profiler = createStreamingMarkdownProfiler({ enabled: true, label: 'test' });
    profiler.record({ type: 'target', preset: 'balanced', targetLength: 100 });
    // simulate time passing by recording another event later via manual mocking
    profiler.record({ type: 'display', preset: 'balanced', displayedLength: 10, targetLength: 100, delta: 10 });

    const events = profiler.getSnapshot().events;
    const m = deriveMetrics(events);
    expect(m.ttftMs).not.toBeNull();
    expect(m.ttftMs!).toBeGreaterThanOrEqual(0);
    expect(m.totalChars).toBe(10);
    expect(m.preset).toBe('balanced');
  });

  it('counts jank when frame interval > 100ms', () => {
    const events = [
      { id: 1, timestamp: 0, type: 'target' as const, preset: 'balanced' as const, targetLength: 100 },
      { id: 2, timestamp: 10, type: 'display' as const, preset: 'balanced' as const, displayedLength: 10, targetLength: 100, delta: 10 },
      { id: 3, timestamp: 200, type: 'display' as const, preset: 'balanced' as const, displayedLength: 50, targetLength: 100, delta: 40 },
      { id: 4, timestamp: 250, type: 'display' as const, preset: 'balanced' as const, displayedLength: 100, targetLength: 100, delta: 50 },
    ];
    const m = deriveMetrics(events);
    expect(m.jankCount).toBe(1);
    expect(m.totalChars).toBe(100);
    expect(m.ttftMs).toBe(10);
  });

  it('produces a time series with backlog points', () => {
    const events = [
      { id: 1, timestamp: 0, type: 'target' as const, preset: 'balanced' as const, targetLength: 100, displayedLength: 0 },
      { id: 2, timestamp: 16, type: 'display' as const, preset: 'balanced' as const, displayedLength: 20, targetLength: 100, delta: 20 },
      { id: 3, timestamp: 32, type: 'display' as const, preset: 'balanced' as const, displayedLength: 60, targetLength: 100, delta: 40 },
      { id: 4, timestamp: 48, type: 'display' as const, preset: 'balanced' as const, displayedLength: 100, targetLength: 100, delta: 40 },
    ];
    const series = eventsToTimeSeries(events);
    expect(series.length).toBe(3);
    expect(series[0].backlog).toBe(80);
    expect(series[2].backlog).toBe(0);
    expect(series[2].displayed).toBe(100);
  });

  it('resets derived state on reset event', () => {
    const events = [
      { id: 1, timestamp: 0, type: 'target' as const, preset: 'balanced' as const, targetLength: 50 },
      { id: 2, timestamp: 16, type: 'display' as const, preset: 'balanced' as const, displayedLength: 50, targetLength: 50, delta: 50 },
      { id: 3, timestamp: 100, type: 'reset' as const, reason: 'test' },
      { id: 4, timestamp: 200, type: 'target' as const, preset: 'silky' as const, targetLength: 200 },
      { id: 5, timestamp: 220, type: 'display' as const, preset: 'silky' as const, displayedLength: 30, targetLength: 200, delta: 30 },
    ];
    const m = deriveMetrics(events);
    expect(m.totalChars).toBe(30);
    expect(m.preset).toBe('balanced'); // first preset wins
    expect(m.ttftMs).toBe(20);
  });
});
