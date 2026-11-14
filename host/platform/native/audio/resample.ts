// dstu-media/src/media/resample.rs. Preserve f32 multiplication and accumulation.
import type { AudioResampler } from './api.ts';

export const TARGET_RATE = 16_000;
const f = Math.fround;

export class Resampler implements AudioResampler {
  readonly inRate: number;
  private readonly m: number;
  private readonly l: number;
  private readonly phases: number;
  private readonly halfTaps: number;
  private readonly table: Float32Array;
  private bufStart = 0;
  private buf: number[] = [];
  private nextOut = 0;
  private totalIn = 0;

  constructor(inRate: number) {
    this.inRate = Math.max(inRate, 1);
    let a = this.inRate;
    let b = TARGET_RATE;
    while (b !== 0) [a, b] = [b, a % b];
    this.m = this.inRate / a;
    this.l = TARGET_RATE / a;
    this.phases = Math.min(this.l, 4096);
    const fc = 0.5 * Math.min(TARGET_RATE / this.inRate, 1) * 0.92;
    this.halfTaps = Math.max(Math.ceil(8 / (2 * fc)), 2);
    const taps = this.halfTaps * 2;
    this.table = new Float32Array(this.phases * taps);
    for (let phase = 0; phase < this.phases; phase++) {
      const frac = phase / this.phases;
      const tmp: number[] = [];
      let sum = 0;
      for (let j = 0; j < taps; j++) {
        const d = this.halfTaps - 1 - j + frac;
        const x = 2 * fc * d;
        const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const wPos = d / this.halfTaps;
        const window = Math.abs(wPos) >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * wPos));
        tmp.push(sinc * window);
        sum += sinc * window;
      }
      for (let j = 0; j < taps; j++) this.table[phase * taps + j] = Math.abs(sum) > 1e-12 ? tmp[j]! / sum : 0;
    }
  }

  inputPosition(): number { return this.totalIn; }
  outputPosition(): number { return this.nextOut; }
  push(input: Float32Array, output: number[]): void {
    for (const sample of input) this.buf.push(sample);
    this.totalIn += input.length;
    this.drain(output, false);
  }
  pushSilence(frames: number, output: number[]): void {
    const zeros = new Float32Array(4096);
    for (let left = frames; left > 0;) {
      const n = Math.min(left, zeros.length);
      this.push(zeros.subarray(0, n), output);
      left -= n;
    }
  }
  finish(output: number[]): void { this.drain(output, true); }

  private drain(output: number[], flushing: boolean): void {
    const taps = this.halfTaps * 2;
    const totalOutAtEnd = Math.ceil(this.totalIn * this.l / this.m);
    for (;;) {
      const num = this.nextOut * this.m;
      const ip = Math.floor(num / this.l);
      const rem = num % this.l;
      if (flushing ? this.nextOut >= totalOutAtEnd : ip + this.halfTaps >= this.totalIn) break;
      const phase = Math.floor(rem * this.phases / this.l);
      const first = ip - this.halfTaps + 1;
      let acc = 0;
      for (let j = 0; j < taps; j++) {
        const abs = first + j;
        const sample = abs < this.bufStart ? 0 : (this.buf[abs - this.bufStart] ?? 0);
        acc = f(acc + f(sample * this.table[phase * taps + j]!));
      }
      const scaled = f(acc * 32767);
      // Rust round is ties-away-from-zero; JS Math.round differs for negatives.
      const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
      output.push(Math.max(-32768, Math.min(32767, rounded)) || 0);
      this.nextOut++;
    }
    const nextIp = Math.floor(this.nextOut * this.m / this.l);
    const keepFrom = Math.max(0, nextIp - this.halfTaps);
    if (keepFrom > this.bufStart) {
      const n = Math.min(keepFrom - this.bufStart, this.buf.length);
      if (n > 0) {
        this.buf.splice(0, n);
        this.bufStart += n;
      }
    }
  }
}
