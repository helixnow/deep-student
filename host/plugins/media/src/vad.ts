/**
 * `dstu-media/src/media/vad.rs`: energy + zero-crossing-rate VAD, 30 ms frames.
 * Local noise floor = 10th percentile over a ~20 s window; adaptive threshold;
 * high-ZCR low-energy frames count as unvoiced speech. Segment merging per the
 * media design contract (0.4 s gap, 15 s max, 0.5 s minimum).
 */
import { TARGET_RATE } from './resample.ts';

export const FRAME_MS = 30;
export const FRAME_SAMPLES = Math.trunc((TARGET_RATE * FRAME_MS) / 1000);

export interface VadParams {
  merge_gap_ms: number;
  max_segment_ms: number;
  min_segment_ms: number;
  min_blip_ms: number;
  pad_before_ms: number;
  pad_after_ms: number;
}

export function defaultVadParams(): VadParams {
  return { merge_gap_ms: 400, max_segment_ms: 15_000, min_segment_ms: 500,
    min_blip_ms: 120, pad_before_ms: 100, pad_after_ms: 150 };
}

export interface FrameFeature { energy_db: number; zcr: number; }
export interface VadFrames { frames: FrameFeature[]; total_ms: number; }

function frameFeature(frame: ArrayLike<number>): FrameFeature {
  if (frame.length === 0) return { energy_db: -100, zcr: 0 };
  let sum = 0;
  let crossings = 0;
  let prev = frame[0]!;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]!;
    const v = s / 32768;
    sum += v * v;
    if ((s >= 0) !== (prev >= 0)) crossings += 1;
    prev = s;
  }
  const mean = sum / frame.length;
  return {
    energy_db: Math.fround(10 * Math.log10(mean + 1e-10)),
    zcr: Math.fround(crossings / frame.length),
  };
}

export class VadAnalyzer {
  _frames: FrameFeature[] = [];
  _pending: number[] = [];
  _totalSamples = 0;

  push(samples: ArrayLike<number>): void {
    this._totalSamples += samples.length;
    let offset = 0;
    if (this._pending.length > 0) {
      const need = FRAME_SAMPLES - this._pending.length;
      const take = Math.min(need, samples.length);
      for (let i = 0; i < take; i++) this._pending.push(samples[i]!);
      offset = take;
      if (this._pending.length === FRAME_SAMPLES) {
        const frame = this._pending;
        this._pending = [];
        this._frames.push(frameFeature(frame));
      }
    }
    const rest = samples.length - offset;
    const whole = Math.floor(rest / FRAME_SAMPLES);
    for (let f = 0; f < whole; f++) {
      const start = offset + f * FRAME_SAMPLES;
      this._frames.push(frameFeature(Array.prototype.slice.call(samples, start, start + FRAME_SAMPLES) as number[]));
    }
    offset += whole * FRAME_SAMPLES;
    for (let i = offset; i < samples.length; i++) this._pending.push(samples[i]!);
  }

  finish(): VadFrames {
    if (this._pending.length > 0) {
      const frame = this._pending;
      this._pending = [];
      this._frames.push(frameFeature(frame));
    }
    return { frames: this._frames, total_ms: Math.trunc((this._totalSamples * 1000) / TARGET_RATE) };
  }
}

function roundHalfAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -100;
  values.sort((a, b) => a - b);
  const idx = roundHalfAway(Math.fround(Math.fround(values.length - 1) * p));
  return values[Math.min(idx, values.length - 1)]!;
}

const ABS_FLOOR_DB = -55;
const NOISE_WINDOW_FRAMES = Math.trunc(20_000 / FRAME_MS);
const NOISE_BLOCK_FRAMES = Math.trunc(2_000 / FRAME_MS);

export function classifyFrames(frames: readonly FrameFeature[]): boolean[] {
  if (frames.length === 0) return [];
  const globalP90 = percentile(frames.map(f => f.energy_db), 0.9);
  const nBlocks = Math.ceil(frames.length / NOISE_BLOCK_FRAMES);
  const halfWindowBlocks = Math.max(1, Math.trunc(NOISE_WINDOW_FRAMES / NOISE_BLOCK_FRAMES / 2));
  const blockNoise: number[] = [];
  for (let b = 0; b < nBlocks; b++) {
    const lo = Math.max(0, b - halfWindowBlocks) * NOISE_BLOCK_FRAMES;
    const hi = Math.min((b + halfWindowBlocks + 1) * NOISE_BLOCK_FRAMES, frames.length);
    blockNoise.push(percentile(frames.slice(lo, hi).map(f => f.energy_db), 0.1));
  }
  return frames.map((f, i) => {
    const noise = blockNoise[Math.trunc(i / NOISE_BLOCK_FRAMES)]!;
    const dynamic = Math.max(globalP90 - noise, 0);
    if (dynamic < 6) return f.energy_db > ABS_FLOOR_DB + 10;
    const thr = Math.max(noise + Math.max(0.3 * dynamic, 6), ABS_FLOOR_DB);
    if (f.energy_db > thr) return true;
    return f.energy_db > Math.max(noise + 4, ABS_FLOOR_DB) && f.zcr > 0.3;
  });
}

export function planSegments(vad: VadFrames, params: VadParams = defaultVadParams()): Array<[number, number]> {
  const speech = classifyFrames(vad.frames);
  const frameMs = FRAME_MS;
  const totalMs = Math.max(vad.total_ms, 0);

  const raw: Array<[number, number]> = [];
  let start: number | null = null;
  speech.forEach((s, i) => {
    if (s && start === null) start = i;
    else if (!s && start !== null) { raw.push([start * frameMs, i * frameMs]); start = null; }
  });
  if (start !== null) raw.push([start * frameMs, speech.length * frameMs]);

  const kept = raw.filter(([s, e], i) => {
    if (e - s >= params.min_blip_ms) return true;
    const prev = i > 0 ? raw[i - 1] : undefined;
    const next = raw[i + 1];
    const nearPrev = prev !== undefined && s - prev[1] < params.merge_gap_ms;
    const nearNext = next !== undefined && next[0] - e < params.merge_gap_ms;
    return nearPrev || nearNext;
  });

  const padded: Array<[number, number]> = kept.map(([s, e]) => [
    Math.max(s - params.pad_before_ms, 0),
    Math.min(e + params.pad_after_ms, Math.max(totalMs, e)),
  ]);

  const merged: Array<[number, number]> = [];
  for (const [s, e] of padded) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s - last[1] < params.merge_gap_ms) {
      last[1] = Math.max(last[1], e);
      continue;
    }
    merged.push([s, e]);
  }

  const split: Array<[number, number]> = [];
  for (const [s, e] of merged) {
    let cur = s;
    while (e - cur > params.max_segment_ms) {
      const cut = findCut(vad.frames, cur, params.max_segment_ms);
      split.push([cur, cut]);
      cur = cut;
    }
    split.push([cur, e]);
  }

  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < split.length) {
    const [s, e] = split[i]!;
    if (e - s < params.min_segment_ms) {
      const last = out[out.length - 1];
      if (last !== undefined && e - last[0] <= params.max_segment_ms) {
        last[1] = e; i += 1; continue;
      }
      const next = split[i + 1];
      if (next !== undefined && next[1] - s <= params.max_segment_ms) {
        next[0] = s; i += 1; continue;
      }
    }
    out.push([s, e]);
    i += 1;
  }
  return out;
}

function findCut(frames: readonly FrameFeature[], startMs: number, maxMs: number): number {
  const frameMs = FRAME_MS;
  const lo = Math.trunc((startMs + Math.trunc(maxMs / 2)) / frameMs);
  let hi = Math.trunc((startMs + maxMs) / frameMs);
  hi = Math.min(hi, frames.length);
  if (lo >= hi) return startMs + maxMs;
  let best = hi - 1;
  let bestEnergy = Infinity;
  for (let i = hi - 1; i >= lo; i--) {
    if (frames[i]!.energy_db < bestEnergy - 0.5) {
      bestEnergy = frames[i]!.energy_db;
      best = i;
    }
  }
  const cut = best * frameMs;
  return Math.min(Math.max(cut, startMs + frameMs), startMs + maxMs);
}
