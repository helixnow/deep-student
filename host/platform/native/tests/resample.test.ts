// Ported from dstu-media/src/media/resample.rs (all five Rust tests).
import { describe, expect, it } from 'vitest';
import { Resampler, TARGET_RATE } from '../audio/resample.ts';

const f = Math.fround;
function sine(rate: number, freq: number, secs: number, amp: number): Float32Array {
  return Float32Array.from({ length: Math.trunc(rate * secs) }, (_, i) =>
    f(f(amp) * f(Math.sin(2 * Math.PI * freq * i / rate))));
}
function run(rate: number, input: Float32Array, chunk: number): number[] {
  const r = new Resampler(rate);
  const out: number[] = [];
  for (let i = 0; i < input.length; i += chunk) r.push(input.subarray(i, i + chunk), out);
  r.finish(out);
  return out;
}
describe('Rust resample', () => {
  it('output_length_tracks_global_grid_without_drift', () => {
    for (const rate of [44_100, 48_000, 22_050, 8_000, 16_000, 11_025, 32_000]) {
      const n = Math.trunc(rate * 3.37);
      const out = run(rate, new Float32Array(n).fill(0.1), 777);
      expect(out.length).toBe(Math.ceil(n * TARGET_RATE / rate));
    }
  });
  it('chunking_does_not_change_output', () => {
    const input = sine(44_100, 440, 0.5, 0.5);
    const a = run(44_100, input, 1);
    const b = run(44_100, input, 4096);
    const c = run(44_100, input, input.length);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
  it('impulse_lands_on_the_global_grid', () => {
    const input = new Float32Array(44_100 * 4);
    input[44_100 * 2.5] = 1;
    const out = run(44_100, input, 1000);
    let peak = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]!) >= Math.abs(out[peak]!)) peak = i;
    expect(Math.abs(peak - 40_000)).toBeLessThanOrEqual(1);
  });
  it('silence_fill_keeps_timeline', () => {
    const r = new Resampler(48_000);
    const out: number[] = [];
    r.push(new Float32Array(48_000).fill(0.2), out);
    r.pushSilence(96_000, out);
    r.push(new Float32Array(48_000).fill(0.2), out);
    r.finish(out);
    expect(out).toHaveLength(64_000);
    expect(out.slice(24_000, 40_000).every(v => Math.abs(v) < 50)).toBe(true);
    expect(Math.abs(out[8_000]! - Math.trunc(0.2 * 32767))).toBeLessThan(200);
    expect(Math.abs(out[56_000]! - Math.trunc(0.2 * 32767))).toBeLessThan(200);
  });
  it('passband_preserved_and_alias_suppressed', () => {
    const rms = (out: number[]) => Math.sqrt(out.slice(2000, 14000).reduce((a, v) => a + v ** 2, 0) / 12000);
    const pass = rms(run(48_000, sine(48_000, 1000, 1, 0.5), 960));
    const stop = rms(run(48_000, sine(48_000, 12000, 1, 0.5), 960));
    expect(pass).toBeGreaterThan(10_000);
    expect(stop).toBeLessThan(pass * 0.05);
  });
});
