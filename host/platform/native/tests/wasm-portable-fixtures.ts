/**
 * Shared inputs and golden outputs for the portable WASM tests. The jsdom file
 * checks the web path against these values and the Node file checks the
 * desktop path (`node:wasi` worker, CJS `tiktoken`, `@node-rs/argon2`) against
 * the same ones, so both platforms are pinned to identical results.
 */
import type { FsrsItem } from '../fsrs/api.ts';

export function fsrsCards(): FsrsItem[] {
  const items: FsrsItem[] = [];
  for (let card = 0; card < 40; card += 1) {
    const reviews = [{ rating: 3, delta_t: 0 }];
    let interval = 1;
    for (let step = 0; step < 4 + (card % 3); step += 1) {
      reviews.push({ rating: (card + step) % 5 === 0 ? 1 : 3 + ((card + step) % 2), delta_t: interval });
      interval = Math.max(1, Math.round(interval * (1.5 + (card % 4) * 0.5)));
      items.push({ reviews: reviews.map(review => ({ ...review })) });
    }
  }
  return items;
}

/**
 * `FSRS::evaluate(DEFAULT_PARAMETERS, fsrsCards())` from fsrs 6.6.2 in the F7 engine.
 * The crate's f32 bin aggregation varies in the last digits between runs on
 * every runner (the guest seeds its hash maps from `random_get`), so compare
 * with {@link FSRS_TOLERANCE}.
 */
export const FSRS_EVALUATION = { logLoss: 0.75737625, rmseBins: 0.2673556 };
export const FSRS_TOLERANCE = 1e-6;

export function fsrsEvaluationMatches(actual: { logLoss: number; rmseBins: number }): boolean {
  return Math.abs(actual.logLoss - FSRS_EVALUATION.logLoss) <= FSRS_TOLERANCE
    && Math.abs(actual.rmseBins - FSRS_EVALUATION.rmseBins) <= FSRS_TOLERANCE;
}

export const TOKEN_TEXT = 'hello world 你好';
export const TOKENS_CL100K = [15339, 1917, 220, 57668, 53901];
export const TOKENS_O200K = [24912, 2375, 220, 177519];

export const ARGON2_PASSWORD = 'password';
export const ARGON2_SALT = 'somesalt-16bytes';
/** `[memoryKiB, iterations, parallelism, length, hex]`. */
export const ARGON2_VECTORS: readonly [number, number, number, number, string][] = [
  [1024, 2, 1, 32, 'be83b1db264fc96b59e7908088c80db582679659f8a070ebc03bf4c6942bee2f'],
  [64, 3, 4, 16, 'd61133347d337006cc35cb8d74f98382'],
];
