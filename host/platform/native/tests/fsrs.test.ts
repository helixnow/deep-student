import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMETERS, effectiveParameters, forgettingCurveConstants, retrievability,
} from '../fsrs/parameters.ts';
import { nextStates as fsrsNextStates, memoryState as fsrsMemoryState, nextIntervalForStability, powerForgettingCurve } from '../fsrs/model.ts';

// fsrs-6.6.2 inference.rs::tests::PARAMETERS
const FSRS_TEST_PARAMETERS = [
  0.6845422, 1.6790825, 4.7349424, 10.042885, 7.4410233, 0.64219797, 1.071918,
  0.0025195254, 1.432437, 0.1544, 0.8692766, 2.0696752, 0.0953, 0.2975,
  2.4691248, 0.19542035, 3.201072, 0.18046261, 0.121442534,
];
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(1e-5);

describe('fsrs-6.6.2 numeric vectors', () => {
  it('test_next_states', () => {
    const state = fsrsMemoryState(FSRS_TEST_PARAMETERS, { reviews: [
      { rating: 1, delta_t: 0 }, { rating: 3, delta_t: 1 },
      { rating: 3, delta_t: 3 }, { rating: 3, delta_t: 8 },
    ] }, null);
    close(state.stability, 13.53767);
    close(state.difficulty, 7.396796);

    const next = fsrsNextStates(FSRS_TEST_PARAMETERS, state, 0.9, 21);
    const expected = [
      [next.again, 2.9691455, 8.000659],
      [next.hard, 17.091452, 7.6913934],
      [next.good, 31.722992, 7.382128],
      [next.easy, 71.7502, 7.0728626],
    ] as const;
    for (const [item, stability, difficulty] of expected) {
      close(item.memory.stability, stability);
      close(item.memory.difficulty, difficulty);
      expect(item.interval).toBe(item.memory.stability);
    }
    // Rust asserts `fsrs.next_interval(Some(121.01552), 0.9, 1) == 121.01551`
    // bit-for-bit; f32 rounding of the f32 inputs must match.
    expect(nextIntervalForStability(FSRS_TEST_PARAMETERS, 121.01552, 0.9)).toBe(Math.fround(121.01551));
  });

  it('next_states_doc_example_for_a_new_card', () => {
    const next = fsrsNextStates([], null, 0.9, 0);
    close(next.again.memory.stability, 0.212);
    close(next.again.memory.difficulty, 6.4133);
    close(next.hard.memory.stability, 1.2931);
    close(next.hard.memory.difficulty, 5.1121707);
    close(next.good.memory.stability, 2.3065);
    close(next.good.memory.difficulty, 2.118104);
    close(next.easy.memory.stability, 8.2956);
    expect(next.easy.memory.difficulty).toBe(1);
  });

  it('test_power_forgetting_curve', () => {
    const expected = [1, 0.9403443, 0.9253786, 0.9185229, 0.9, 0.8261359];
    [0, 1, 2, 3, 4, 5].forEach((days, index) => {
      close(powerForgettingCurve(days, [1, 2, 3, 4, 4, 2][index]!, [...DEFAULT_PARAMETERS]), expected[index]!);
    });
  });

  it('rejects non-finite memory states like validate_state', () => {
    expect(() => fsrsMemoryState([], { reviews: [{ rating: 5, delta_t: 0 }] }, null)).not.toThrow();
    expect(() => fsrsNextStates([], { stability: NaN, difficulty: 5 }, 0.9, 0)).toThrow('FSRS_INVALID_INPUT');
  });
});

describe('fsrs 6.6.2 static vectors', () => {
  it('test_convert_parameters', () => {
    const old = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61];
    expect(effectiveParameters(old)).toEqual([
      0.4, 0.6, 2.4, 5.8, 6.81, 0.44675013, 1.36, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05,
      0.34, 1.26, 0.29, 2.61, 0, 0, 0, 0.5,
    ].map(Math.fround));
  });
  it('forgetting_curve_constants_follow_fsrs6_decay', () => {
    const [decay, factor] = forgettingCurveConstants([]);
    expect(Math.abs(decay + 0.1542)).toBeLessThan(1e-6);
    expect(Math.abs(retrievability(7, 7, decay, factor) - 0.9)).toBeLessThan(1e-9);
    const [decay5] = forgettingCurveConstants(DEFAULT_PARAMETERS.slice(0, 19));
    expect(Math.abs(decay5 + 0.5)).toBeLessThan(1e-6);
  });
  it('falls back on invalid length or non-finite f32 parameters', () => {
    expect(effectiveParameters([1])).toEqual(DEFAULT_PARAMETERS);
    expect(effectiveParameters([...DEFAULT_PARAMETERS.slice(0, 20), Infinity])).toEqual(DEFAULT_PARAMETERS);
    expect(effectiveParameters([...DEFAULT_PARAMETERS.slice(0, 20), 1e100])).toEqual(DEFAULT_PARAMETERS);
  });
});
