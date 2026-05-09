import { describe, expect, it } from 'vitest';
import {
  computeNextSmoothedContent,
  getStreamingSmoothingConfig,
  resolveStreamingSmoothingPreset,
} from '../streamingSmoothing';
import { createStreamingMarkdownProfiler } from '../streamingProfiler';

describe('streaming smoothing presets', () => {
  it('falls back to balanced when the preset is unknown', () => {
    expect(resolveStreamingSmoothingPreset('silky')).toBe('silky');
    expect(resolveStreamingSmoothingPreset('experimental')).toBe('balanced');
    expect(resolveStreamingSmoothingPreset(undefined)).toBe('balanced');
  });

  it('reveals long incoming content incrementally instead of snapping to the full target', () => {
    const config = getStreamingSmoothingConfig('silky');
    const target = 'DeepStudent streaming output should feel calm and continuous.';

    const result = computeNextSmoothedContent('', target, config);

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content.length).toBeLessThan(target.length);
    expect(result.reason).toBe('append');
  });

  it('snaps immediately when the incoming content is not an append-only continuation', () => {
    const config = getStreamingSmoothingConfig('balanced');

    const result = computeNextSmoothedContent('old answer', 'new answer', config);

    expect(result.content).toBe('new answer');
    expect(result.reason).toBe('reset');
  });

  it('accelerates within the preset cap when the backlog is large', () => {
    const config = getStreamingSmoothingConfig('balanced');
    const target = 'x'.repeat(config.backlogBoostThreshold + 120);

    const result = computeNextSmoothedContent('', target, config);

    expect(result.delta).toBeGreaterThan(config.minChunkChars);
    expect(result.delta).toBeLessThanOrEqual(config.maxChunkChars);
  });
});

describe('streaming markdown profiler', () => {
  it('keeps a bounded event buffer and reports dropped events', () => {
    const profiler = createStreamingMarkdownProfiler({ enabled: true, label: 'test', maxEvents: 2 });

    profiler.record({ type: 'target', preset: 'balanced', targetLength: 10 });
    profiler.record({ type: 'display', displayedLength: 4, delta: 4, preset: 'balanced' });
    profiler.record({ type: 'display', displayedLength: 8, delta: 4, preset: 'balanced' });

    const snapshot = profiler.getSnapshot();
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.droppedEvents).toBe(1);
    expect(snapshot.events[0].type).toBe('display');
  });

  it('notifies subscribers when profiler events are recorded', () => {
    const profiler = createStreamingMarkdownProfiler({ enabled: true, label: 'test' });
    let calls = 0;
    const unsubscribe = profiler.subscribe(() => {
      calls += 1;
    });

    profiler.record({ type: 'target', preset: 'realtime', targetLength: 12 });
    unsubscribe();
    profiler.record({ type: 'target', preset: 'realtime', targetLength: 24 });

    expect(calls).toBe(1);
  });
});
