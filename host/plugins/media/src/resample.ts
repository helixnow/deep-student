/**
 * `dstu-media/src/media/resample.rs`: streaming resample to 16 kHz on a global grid.
 * The output index n is placed at input position n*M/L with integer arithmetic, so
 * multi-hour streams do not accumulate drift. Kernel = Hann-windowed sinc, 92% of
 * output Nyquist, precomputed per phase and normalized to unit DC gain.
 */
export const TARGET_RATE = 16_000;
const ZERO_CROSSINGS = 8;
const CUTOFF_RATIO = 0.92;
const MAX_PHASES = 4096;

function gcd(a: number, b: number): number {
  while (b !== 0) { const t = a % b; a = b; b = t; }
  return a;
}

function divCeil(a: number, b: number): number { return Math.floor(a / b) + (a % b === 0 ? 0 : 1); }

export class Resampler {
  readonly inRate: number;
  _m: number;
  _l: number;
  _tablePhases: number;
  _halfTaps: number;
  _table: Float32Array;
  _buf: Float32Array;
  _bufStart = 0;
  _bufLen = 0;
  _nextOut = 0;
  _totalIn = 0;

  constructor(inRate: number) {
    this.inRate = Math.max(1, Math.trunc(inRate));
    const g = gcd(this.inRate, TARGET_RATE);
    this._m = this.inRate / g;
    this._l = TARGET_RATE / g;
    this._tablePhases = Math.min(this._l, MAX_PHASES);
    const ratio = Math.min(TARGET_RATE / this.inRate, 1);
    const fc = 0.5 * ratio * CUTOFF_RATIO;
    this._halfTaps = Math.max(2, Math.ceil(ZERO_CROSSINGS / (2 * fc)));
    const taps = this._halfTaps * 2;
    this._table = new Float32Array(this._tablePhases * taps);
    for (let phase = 0; phase < this._tablePhases; phase++) {
      const frac = phase / this._tablePhases;
      const tmp = new Float64Array(taps);
      let sum = 0;
      for (let j = 0; j < taps; j++) {
        const d = (this._halfTaps - 1 - j) + frac;
        const x = 2 * fc * d;
        const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const wPos = d / this._halfTaps;
        const window = Math.abs(wPos) >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * wPos));
        tmp[j] = sinc * window;
        sum += tmp[j]!;
      }
      for (let j = 0; j < taps; j++) {
        this._table[phase * taps + j] = Math.abs(sum) > 1e-12 ? Math.fround(tmp[j]! / sum) : 0;
      }
    }
    this._buf = new Float32Array(8192);
  }

  inputPosition(): number { return this._totalIn; }
  outputPosition(): number { return this._nextOut; }

  pushSilence(frames: number, out: number[]): void {
    const zeros = new Float32Array(Math.min(frames, 4096));
    let left = frames;
    while (left > 0) {
      const n = Math.min(left, zeros.length);
      this.push(zeros.subarray(0, n), out);
      left -= n;
    }
  }

  push(input: ArrayLike<number>, out: number[]): void {
    this._ensure(this._bufLen + input.length);
    for (let i = 0; i < input.length; i++) this._buf[this._bufLen + i] = Math.fround(input[i]!);
    this._bufLen += input.length;
    this._totalIn += input.length;
    this._drain(out, false);
  }

  finish(out: number[]): void { this._drain(out, true); }

  _ensure(needed: number): void {
    if (needed <= this._buf.length) return;
    let size = this._buf.length;
    while (size < needed) size *= 2;
    const next = new Float32Array(size);
    next.set(this._buf.subarray(0, this._bufLen));
    this._buf = next;
  }

  _sampleAt(abs: number): number {
    if (abs < this._bufStart) return 0;
    const rel = abs - this._bufStart;
    return rel < this._bufLen ? this._buf[rel]! : 0;
  }

  _drain(out: number[], flushing: boolean): void {
    const taps = this._halfTaps * 2;
    const totalOutAtEnd = divCeil(this._totalIn * this._l, this._m);
    for (;;) {
      const num = this._nextOut * this._m;
      const ip = Math.floor(num / this._l);
      const rem = num % this._l;
      if (flushing) {
        if (this._nextOut >= totalOutAtEnd) break;
      } else if (ip + this._halfTaps >= this._totalIn) break;
      const phase = Math.floor((rem * this._tablePhases) / this._l);
      const row = phase * taps;
      const first = ip - this._halfTaps + 1;
      let acc = 0;
      for (let j = 0; j < taps; j++) {
        acc = Math.fround(acc + Math.fround(this._sampleAt(first + j) * this._table[row + j]!));
      }
      const scaled = Math.fround(acc * 32767);
      // Rust f32::round = half away from zero.
      const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
      const clamped = Math.min(32767, Math.max(-32768, rounded));
      out.push(clamped | 0);
      this._nextOut += 1;
    }

    const nextIp = Math.floor((this._nextOut * this._m) / this._l);
    const keepFrom = Math.max(0, nextIp - this._halfTaps);
    if (keepFrom > this._bufStart) {
      const drop = Math.min(keepFrom - this._bufStart, this._bufLen);
      if (drop > 0) {
        this._buf.copyWithin(0, drop, this._bufLen);
        this._bufLen -= drop;
        this._bufStart += drop;
      }
    }
  }
}
