import { describe, expect, it } from 'vitest';
import {
  computeNextSmoothedContent,
  computeNextSmoothedContentByTime,
  getStreamingSmoothingConfig,
  resolveStreamingSmoothingPreset,
} from '../streamingSmoothing';
import { createStreamingMarkdownProfiler } from '../streamingProfiler';

describe('streaming smoothing presets', () => {
  it('falls back to the balanced preset when the input is unknown or undefined', () => {
    // 行业最优解（2026）：默认 preset 为 'balanced'。
    // 让内容既保持流式即时感，又把碎 chunk 合并得更自然。
    expect(resolveStreamingSmoothingPreset('silky')).toBe('silky');
    expect(resolveStreamingSmoothingPreset('experimental')).toBe('balanced');
    expect(resolveStreamingSmoothingPreset(undefined)).toBe('balanced');
  });

  it('recognises the natural preset', () => {
    expect(resolveStreamingSmoothingPreset('natural')).toBe('natural');
  });

  it('exposes commit gate fields per preset', () => {
    const balanced = getStreamingSmoothingConfig('balanced');
    expect(balanced.commitIntervalMs).toBeGreaterThan(0);
    expect(balanced.commitOnWordBoundary).toBe(true);

    const natural = getStreamingSmoothingConfig('natural');
    expect(natural.commitIntervalMs).toBe(0);
    expect(natural.commitOnWordBoundary).toBe(false);
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

  it('keeps CJK streaming chunks from collapsing to single characters', () => {
    const config = getStreamingSmoothingConfig('balanced');
    const target = '渐渐出来而不是打字机。';

    const result = computeNextSmoothedContentByTime('', target, config, 32);

    expect(result.content.length).toBeGreaterThan(1);
    expect(result.reason).toBe('append');
  });
});

describe('computeNextSmoothedContentByTime', () => {
  it('advances proportionally to dt and preset cps', () => {
    const config = getStreamingSmoothingConfig('balanced');
    const target = 'a'.repeat(500);

    const slow = computeNextSmoothedContentByTime('', target, config, 16);
    const fast = computeNextSmoothedContentByTime('', target, config, 64);

    // Faster dt => bigger advance, but capped by maxChunkChars.
    expect(fast.delta).toBeGreaterThanOrEqual(slow.delta);
    expect(fast.delta).toBeLessThanOrEqual(config.maxChunkChars);
  });

  it('flushes the entire tail when remaining is below tailFlushChars', () => {
    const config = getStreamingSmoothingConfig('silky');
    const tail = config.tailFlushChars;
    const target = 'x'.repeat(tail);
    const result = computeNextSmoothedContentByTime('', target, config, 16);
    expect(result.content).toBe(target);
    expect(result.reason).toBe('complete');
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
