import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeVisualObservation, runPreprocessStage, UNAVAILABLE_IMAGE_OBSERVATION } from '../src/preprocess.ts';

afterEach(() => vi.useRealTimers());
describe('context_compiler/preprocess.rs::tests', () => {
  it('unavailable_visual_placeholder_is_never_a_reusable_artifact', () => {
    expect(finalizeVisualObservation(null)).toEqual([UNAVAILABLE_IMAGE_OBSERVATION, false]);
    expect(finalizeVisualObservation('actual observation')).toEqual(['actual observation', true]);
  });
  it('auxiliary_timeout_advances_to_ocr_within_the_turn_budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const deadline = performance.now() + 100;
    const auxiliary = runPreprocessStage(null, deadline, 5, () => new Promise<string>(() => {}));
    await vi.advanceTimersByTimeAsync(5);
    expect(await auxiliary).toEqual({ ok: false, error: { kind: 'timedOut' } });
    expect(await runPreprocessStage(null, deadline, 50, async () => 'recognized')).toEqual({ ok: true, value: 'recognized' });
  });
  it('preprocessing_turn_budget_caps_a_long_stage_and_cancels_its_work', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let observed = false;
    const work = runPreprocessStage(null, performance.now() + 5, 1000, signal => {
      signal.addEventListener('abort', () => { observed = true; }, { once: true });
      return new Promise<void>(() => {});
    });
    await vi.advanceTimersByTimeAsync(5);
    expect(await work).toEqual({ ok: false, error: { kind: 'timedOut' } });
    expect(observed).toBe(true);
  });
  it('parent_cancellation_stops_preprocessing_before_fallback', async () => {
    const cancellation = new AbortController(); cancellation.abort();
    let polled = false;
    const work = await runPreprocessStage(cancellation.signal, performance.now() + 1000, 1000, async () => { polled = true; });
    expect(work).toEqual({ ok: false, error: { kind: 'cancelled' } });
    expect(polled).toBe(false);
  });
  it('completed and failed stages cancel child work without cancelling the parent', async () => {
    const parent = new AbortController();
    let child: AbortSignal | undefined;
    const error = new Error('provider failed');
    expect(await runPreprocessStage(parent.signal, performance.now() + 1000, 1000, async signal => {
      child = signal; throw error;
    })).toEqual({ ok: false, error: { kind: 'failed', error } });
    expect(child!.aborted).toBe(true); expect(parent.signal.aborted).toBe(false);
  });
});
