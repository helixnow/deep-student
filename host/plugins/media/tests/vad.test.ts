import { expect, it } from 'vitest';
import { TARGET_RATE } from '../src/resample.ts';
import { VadAnalyzer, defaultVadParams, planSegments, type VadFrames } from '../src/vad.ts';

const SR = TARGET_RATE;

function synth(layout: Array<[number, boolean]>): Int16Array {
  const out: number[] = [];
  let seed = 12345;
  let t = 0;
  for (const [secs, voiced] of layout) {
    const n = Math.trunc(secs * SR);
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      const noise = ((seed >>> 16) / 65536 - 0.5) * 0.002;
      const x = t / SR;
      const v = voiced ? 0.3 * Math.sin(2 * Math.PI * 200 * x) + 0.1 * Math.sin(2 * Math.PI * 600 * x) : 0;
      out.push(Math.trunc((v + noise) * 32767));
      t += 1;
    }
  }
  return Int16Array.from(out);
}

function analyze(samples: Int16Array, chunk: number): VadFrames {
  const a = new VadAnalyzer();
  for (let i = 0; i < samples.length; i += chunk) a.push(samples.subarray(i, i + chunk));
  return a.finish();
}

it('detects_speech_regions_with_padding', () => {
  const audio = synth([[1, false], [2, true], [2, false], [3, true], [1, false]]);
  const vad = analyze(audio, 1000);
  expect(vad.total_ms).toBe(9000);
  const segs = planSegments(vad);
  expect(segs.length).toBe(2);
  expect(Math.abs(segs[0]![0] - 900)).toBeLessThanOrEqual(60);
  expect(Math.abs(segs[0]![1] - 3150)).toBeLessThanOrEqual(60);
  expect(Math.abs(segs[1]![0] - 4900)).toBeLessThanOrEqual(60);
  expect(Math.abs(segs[1]![1] - 8150)).toBeLessThanOrEqual(60);
});

it('frame_features_independent_of_chunking', () => {
  const audio = synth([[0.5, true], [0.5, false]]);
  expect(analyze(audio, 7).frames).toEqual(analyze(audio, 4800).frames);
});

it('short_gaps_merge', () => {
  const merged = planSegments(analyze(synth([[1, false], [1, true], [0.3, false], [1, true], [1, false]]), 960));
  expect(merged.length).toBe(1);
  const split = planSegments(analyze(synth([[1, false], [1, true], [1.2, false], [1, true], [1, false]]), 960));
  expect(split.length).toBe(2);
});

it('long_speech_is_split_at_most_max', () => {
  const params = defaultVadParams();
  const segs = planSegments(analyze(synth([[0.5, false], [20, true], [0.15, false], [20, true], [0.5, false]]), 4096), params);
  expect(segs.length).toBeGreaterThanOrEqual(3);
  for (const [s, e] of segs) {
    expect(e - s).toBeLessThanOrEqual(params.max_segment_ms);
    expect(e).toBeGreaterThan(s);
  }
  for (let i = 1; i < segs.length; i++) expect(segs[i - 1]![1]).toBeLessThanOrEqual(segs[i]![0]);
  expect(segs.reduce((sum, [s, e]) => sum + (e - s), 0)).toBeGreaterThanOrEqual(40_000);
});

it('short_segment_absorbed_into_previous', () => {
  const segs = planSegments(analyze(synth([[1, false], [2, true], [0.8, false], [0.2, true], [2, false]]), 960));
  expect(segs.length).toBe(1);
  expect(segs[0]![1]).toBeGreaterThanOrEqual(4_100);
});

it('isolated_click_is_dropped_and_silence_yields_nothing', () => {
  expect(planSegments(analyze(synth([[2, false], [0.06, true], [2, false]]), 960))).toEqual([]);
  expect(planSegments(analyze(new Int16Array(SR * 3), 960))).toEqual([]);
});

it('continuous_speech_without_dynamics_is_still_speech', () => {
  const segs = planSegments(analyze(synth([[6, true]]), 960));
  expect(segs.length).toBe(1);
  expect(segs[0]![1] - segs[0]![0]).toBeGreaterThanOrEqual(5_900);
});
