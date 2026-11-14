import { expect, it } from 'vitest';
import { Resampler, TARGET_RATE } from '../src/resample.ts';

function sine(rate: number, freq: number, secs: number, amp: number): number[] {
  const n = Math.trunc(rate * secs);
  return Array.from({ length: n }, (_, i) => Math.fround(amp * Math.sin((2 * Math.PI * freq * i) / rate)));
}

function run(rate: number, input: number[], chunk: number): number[] {
  const r = new Resampler(rate);
  const out: number[] = [];
  for (let i = 0; i < input.length; i += chunk) r.push(input.slice(i, i + chunk), out);
  r.finish(out);
  return out;
}

it('output_length_tracks_global_grid_without_drift', () => {
  for (const rate of [44_100, 48_000, 22_050, 8_000, 16_000, 11_025, 32_000]) {
    const secs = 3.37;
    const nIn = Math.trunc(rate * secs);
    const out = run(rate, new Array<number>(nIn).fill(0.1), 777);
    const expected = Math.ceil((nIn * TARGET_RATE) / rate);
    expect(out.length, `rate ${rate}`).toBe(expected);
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
  const rate = 44_100;
  const input = new Array<number>(rate * 4).fill(0);
  input[Math.trunc(rate * 2.5)] = 1;
  const out = run(rate, input, 1000);
  let peak = 0;
  for (let i = 1; i < out.length; i++) if (Math.abs(out[i]!) > Math.abs(out[peak]!)) peak = i;
  expect(Math.abs(peak - 40_000)).toBeLessThanOrEqual(1);
});

it('silence_fill_keeps_timeline', () => {
  const rate = 48_000;
  const r = new Resampler(rate);
  const out: number[] = [];
  r.push(new Array<number>(48_000).fill(0.2), out);
  r.pushSilence(96_000, out);
  r.push(new Array<number>(48_000).fill(0.2), out);
  r.finish(out);
  expect(out.length).toBe(64_000);
  expect(out.slice(24_000, 40_000).every(v => Math.abs(v) < 50)).toBe(true);
  expect(Math.abs(out[8_000]! - Math.trunc(0.2 * 32767))).toBeLessThan(200);
  expect(Math.abs(out[56_000]! - Math.trunc(0.2 * 32767))).toBeLessThan(200);
});

it('passband_preserved_and_alias_suppressed', () => {
  const rms = (values: number[]): number => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
  const pass = run(48_000, sine(48_000, 1_000, 1, 0.5), 960);
  const passRms = rms(pass.slice(2000, 14_000));
  const stop = run(48_000, sine(48_000, 12_000, 1, 0.5), 960);
  const stopRms = rms(stop.slice(2000, 14_000));
  expect(passRms).toBeGreaterThan(10_000);
  expect(stopRms).toBeLessThan(passRms * 0.05);
});
