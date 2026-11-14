import { describe, expect, it } from 'vitest';
import { BindingMemoryState, FSRSBinding } from '@open-spaced-repetition/binding';
import { createTestHost } from '../../../kernel/testing.ts';
import { memoryState, nextStates } from '../fsrs/model.ts';
import native from '../index.ts';

// fsrs-6.6.2 inference.rs::tests::PARAMETERS
const FSRS_TEST_PARAMETERS = [
  0.6845422, 1.6790825, 4.7349424, 10.042885, 7.4410233, 0.64219797, 1.071918,
  0.0025195254, 1.432437, 0.1544, 0.8692766, 2.0696752, 0.0953, 0.2975,
  2.4691248, 0.19542035, 3.201072, 0.18046261, 0.121442534,
];

describe('nativeFsrs engine service', () => {
  it('matches the Rust binary through the FSRS-6 binding', () => {
    const state = memoryState(FSRS_TEST_PARAMETERS, { reviews: [
      { rating: 1, delta_t: 0 }, { rating: 3, delta_t: 1 },
      { rating: 3, delta_t: 3 }, { rating: 3, delta_t: 8 },
    ] }, null);
    const ours = nextStates(FSRS_TEST_PARAMETERS, state, 0.9, 21);
    const rust = new FSRSBinding(FSRS_TEST_PARAMETERS)
      .nextStates(new BindingMemoryState(state.stability, state.difficulty), 0.9, 21);
    for (const key of ['again', 'hard', 'good', 'easy'] as const) {
      expect(ours[key].memory.stability, `${key} stability`).toBe(rust[key].memory.stability);
      expect(ours[key].memory.difficulty, `${key} difficulty`).toBe(rust[key].memory.difficulty);
      expect(ours[key].interval, `${key} interval`).toBe(rust[key].interval);
    }
  });

  it('is registered with the fsrs 6.6.2 crate optimizer/evaluator (not the npm binding)', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const state = host.ctx.nativeFsrs.nextStates([], null, 0.9, 0);
      expect(state.good.memory.stability).toBe(Math.fround(2.3065));
      // binding 0.6.0 (fsrs-rs d7f337b) trains with f32 Adam (0.70/0.98) and a 0.5 L2 weight, so
      // optimize/evaluate run the fsrs =6.6.2 crate in the WASI engine instead (fsrs-optimizer.test.ts).
      expect(typeof host.ctx.nativeFsrs.optimize).toBe('function');
      expect(typeof host.ctx.nativeFsrs.evaluate).toBe('function');
    } finally { await host.dispose(); }
  });
});
