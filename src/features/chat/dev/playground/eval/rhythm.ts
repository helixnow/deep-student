/**
 * Rhythm strategies for simulating streaming chunks.
 * 用于评测和 Mock LLM 输出节奏。
 */

import type { RhythmStrategy } from './types';

/**
 * 简单的可重现 PRNG（mulberry32），用于 poisson 节奏的可重复测试。
 */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generator-style：返回每次推进的 (chunkChars, sleepMs)。
 * 调用方负责把 chunk slice 出来 append 到 store。
 */
export interface ChunkPlan {
  chunkChars: number;
  sleepMs: number;
}

export function planChunks(strategy: RhythmStrategy, totalLen: number): ChunkPlan[] {
  if (totalLen <= 0) return [];

  switch (strategy.type) {
    case 'fixed': {
      const out: ChunkPlan[] = [];
      let pos = 0;
      while (pos < totalLen) {
        const remaining = totalLen - pos;
        const chunk = Math.min(strategy.chunkSize, remaining);
        out.push({ chunkChars: chunk, sleepMs: strategy.delayMs });
        pos += chunk;
      }
      return out;
    }

    case 'poisson': {
      const rng = mulberry32(strategy.seed ?? 42);
      const out: ChunkPlan[] = [];
      let pos = 0;
      const meanCharsPerEvent = Math.max(1, Math.round(strategy.meanCps / 30)); // 30 events/s
      const baseDelayMs = 1000 / 30;
      while (pos < totalLen) {
        // Exponential distribution for inter-arrival
        const u = Math.max(rng(), 1e-6);
        const delay = -Math.log(u) * baseDelayMs;
        const jittered = delay * (1 + (rng() - 0.5) * 2 * strategy.jitter);
        const sleep = Math.max(0, jittered);

        // chunk size: poisson-ish (uniform around mean)
        const chunk = Math.max(
          1,
          Math.min(totalLen - pos, Math.round(meanCharsPerEvent * (0.5 + rng()))),
        );
        out.push({ chunkChars: chunk, sleepMs: sleep });
        pos += chunk;
      }
      return out;
    }

    case 'burst': {
      const out: ChunkPlan[] = [];
      let pos = 0;
      let inBurst = true;
      while (pos < totalLen) {
        if (inBurst) {
          const remaining = totalLen - pos;
          const chunk = Math.min(strategy.burstSize, remaining);
          out.push({ chunkChars: chunk, sleepMs: strategy.burstGapMs });
          pos += chunk;
          inBurst = false;
        } else {
          // idle gap with no content advance, simulated as zero-char chunk
          out.push({ chunkChars: 0, sleepMs: strategy.idleMs });
          inBurst = true;
        }
      }
      return out;
    }

    case 'replay': {
      // From event trace, reconstruct chunk plan.
      const out: ChunkPlan[] = [];
      let lastDisplayed = 0;
      let lastTs = 0;
      for (const ev of strategy.events) {
        if (ev.type !== 'display' && ev.type !== 'flush') continue;
        const dl = ev.displayedLength ?? 0;
        const sleep = lastTs === 0 ? 0 : ev.timestamp - lastTs;
        const chunk = Math.max(0, dl - lastDisplayed);
        if (chunk > 0 || sleep > 0) {
          out.push({ chunkChars: chunk, sleepMs: sleep });
        }
        lastDisplayed = dl;
        lastTs = ev.timestamp;
      }
      return out;
    }

    default:
      return [];
  }
}

export const DEFAULT_RHYTHM: RhythmStrategy = {
  type: 'fixed',
  chunkSize: 8,
  delayMs: 20,
};

export const RHYTHM_PRESETS: Array<{ id: string; label: string; rhythm: RhythmStrategy }> = [
  {
    id: 'fixed-fast',
    label: 'Fixed · fast (8/20ms)',
    rhythm: { type: 'fixed', chunkSize: 8, delayMs: 20 },
  },
  {
    id: 'fixed-slow',
    label: 'Fixed · slow (4/40ms)',
    rhythm: { type: 'fixed', chunkSize: 4, delayMs: 40 },
  },
  {
    id: 'poisson-realistic',
    label: 'Poisson · realistic (~480cps)',
    rhythm: { type: 'poisson', meanCps: 480, jitter: 0.4, seed: 42 },
  },
  {
    id: 'poisson-jittery',
    label: 'Poisson · jittery (~300cps)',
    rhythm: { type: 'poisson', meanCps: 300, jitter: 0.7, seed: 7 },
  },
  {
    id: 'burst-thinking',
    label: 'Burst · thinking (60ch / 200ms idle)',
    rhythm: { type: 'burst', burstSize: 60, burstGapMs: 30, idleMs: 200 },
  },
];
