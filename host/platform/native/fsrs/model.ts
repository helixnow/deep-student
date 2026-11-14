/**
 * FSRS-6 memory model, ported from fsrs-6.6.2 `model.rs` / `inference.rs`.
 * Rust uses f32 throughout; every JS arithmetic step is rounded with Math.fround
 * so state transitions match the Rust binary rather than double-precision drift.
 */
import type { FsrsItem, FsrsNextStates, MemoryState } from './api.ts';
import { effectiveParameters } from './parameters.ts';

const f = Math.fround;
const S_MIN = f(0.001);
const S_MAX = f(36500);
const D_MIN = f(1);
const D_MAX = f(10);
const INIT_S_MAX = f(100);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** parameter_clipper.rs::clip_parameters with FSRS::new's ModelConfig defaults. */
export function clipParameters(parameters: readonly number[]): number[] {
  const w = parameters.map(f);
  // FSRS::new uses ModelConfig::default: num_relearning_steps = 1 → ceiling 2.0.
  const ceiling = f(2);
  const clamps: [number, number][] = [
    [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX],
    [D_MIN, D_MAX], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8],
    [0.001, 3.5], [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1],
    [1, 6], [0, ceiling], [0, ceiling], [0, 0.8], [0.1, 0.8],
  ];
  return w.map((value, index) => clamp(value, f(clamps[index]![0]), f(clamps[index]![1])));
}

function forgettingCurve(w: readonly number[], t: number, s: number): number {
  const decay = f(-w[20]!);
  const factor = f(f(Math.exp(f(Math.log(f(0.9)) / decay))) - 1);
  return f(Math.pow(f(f(f(t / s) * factor) + 1), decay));
}
export function powerForgettingCurve(t: number, s: number, parameters: readonly number[] = []): number {
  return forgettingCurve(clipParameters(effectiveParameters(parameters)), f(t), f(s));
}

export function nextIntervalForStability(parameters: readonly number[], stability: number, desiredRetention: number): number {
  const w = clipParameters(effectiveParameters(parameters));
  stability = f(stability);
  desiredRetention = f(desiredRetention);
  const decay = f(-w[20]!);
  const factor = f(f(Math.exp(f(Math.log(f(0.9)) / decay))) - 1);
  return f(f(stability / factor) * f(f(Math.pow(f(desiredRetention), f(1 / decay))) - 1));
}

function initStability(w: readonly number[], rating: number): number {
  return w[clamp(rating, 1, 4) - 1]!;
}
function initDifficulty(w: readonly number[], rating: number): number {
  return f(f(w[4]! - f(Math.exp(f(w[5]! * f(rating - 1))))) + 1);
}
function meanReversion(w: readonly number[], newDifficulty: number): number {
  return f(f(w[7]! * f(initDifficulty(w, 4) - newDifficulty)) + newDifficulty);
}
function linearDamping(delta: number, oldDifficulty: number): number {
  return f(f(f(10 - oldDifficulty) * delta) / 9);
}
function nextDifficulty(w: readonly number[], difficulty: number, rating: number): number {
  const delta = f(-w[6]! * f(rating - 3));
  return f(difficulty + linearDamping(delta, difficulty));
}
function stabilityAfterSuccess(w: readonly number[], lastS: number, lastD: number, r: number, rating: number): number {
  const hardPenalty = rating === 2 ? w[15]! : 1;
  const easyBonus = rating === 4 ? w[16]! : 1;
  const growth = f(f(f(f(Math.exp(w[8]!)) * f(11 - lastD)) * f(Math.pow(lastS, f(-w[9]!)))) * f(f(Math.exp(f(f(1 - r) * w[10]!))) - 1));
  return f(lastS * f(f(f(growth * hardPenalty) * easyBonus) + 1));
}
function stabilityAfterFailure(w: readonly number[], lastS: number, lastD: number, r: number): number {
  const next = f(f(f(w[11]! * f(Math.pow(lastD, f(-w[12]!)))) * f(f(Math.pow(f(lastS + 1), w[13]!)) - 1)) * f(Math.exp(f(f(1 - r) * w[14]!))));
  const minimum = f(lastS / f(Math.exp(f(w[17]! * w[18]!))));
  return Math.min(next, minimum);
}
function stabilityShortTerm(w: readonly number[], lastS: number, rating: number): number {
  const sinc = f(f(Math.exp(f(w[17]! * f(f(rating - 3) + w[18]!)))) * f(Math.pow(lastS, f(-w[19]!))));
  return f(lastS * (rating >= 2 ? Math.max(sinc, 1) : sinc));
}

function step(w: readonly number[], deltaT: number, rating: number, state: MemoryState, nth: number): MemoryState {
  const lastS = clamp(f(state.stability), S_MIN, S_MAX);
  const lastD = clamp(f(state.difficulty), D_MIN, D_MAX);
  const retrievability = forgettingCurve(w, deltaT, lastS);
  const success = stabilityAfterSuccess(w, lastS, lastD, retrievability, rating);
  const failure = stabilityAfterFailure(w, lastS, lastD, retrievability);
  const shortTerm = stabilityShortTerm(w, lastS, rating);
  let newS = rating === 1 ? failure : success;
  if (deltaT === 0) newS = shortTerm;
  let newD = clamp(meanReversion(w, nextDifficulty(w, lastD, rating)), D_MIN, D_MAX);
  if (nth === 0 && state.stability === 0) {
    const initRating = clamp(rating, 1, 4);
    newS = initStability(w, initRating);
    newD = clamp(initDifficulty(w, initRating), D_MIN, D_MAX);
  }
  if (rating === 0) {
    newS = lastS;
    newD = lastD;
  }
  return { stability: clamp(newS, S_MIN, S_MAX), difficulty: newD };
}

function validate(state: MemoryState): MemoryState {
  if (!Number.isFinite(state.stability) || !Number.isFinite(state.difficulty)) {
    throw new RangeError('FSRS_INVALID_INPUT');
  }
  return state;
}

export function nextStates(
  parameters: readonly number[],
  current: MemoryState | null,
  desiredRetention: number,
  daysElapsed: number,
): FsrsNextStates {
  const w = clipParameters(effectiveParameters(parameters));
  const state = current ?? { stability: 0, difficulty: 0 };
  const nth = current === null ? 0 : 1;
  const one = (rating: number) => {
    const memory = validate(step(w, f(daysElapsed), rating, state, nth));
    return { memory, interval: nextIntervalForStability(w, memory.stability, f(desiredRetention)) };
  };
  return { again: one(1), hard: one(2), good: one(3), easy: one(4) };
}

export function memoryState(
  parameters: readonly number[],
  item: FsrsItem,
  startingState: MemoryState | null,
): MemoryState {
  const w = clipParameters(effectiveParameters(parameters));
  let state: MemoryState;
  let start = 0;
  if (startingState !== null) state = startingState;
  else if (item.reviews.length === 0) state = { stability: 0, difficulty: 0 };
  else {
    const first = item.reviews[0]!;
    state = first.rating === 0
      ? { stability: S_MIN, difficulty: D_MIN }
      : {
        stability: clamp(initStability(w, first.rating), S_MIN, S_MAX),
        difficulty: clamp(initDifficulty(w, first.rating), D_MIN, D_MAX),
      };
    start = 1;
  }
  for (let index = start; index < item.reviews.length; index++) {
    const review = item.reviews[index]!;
    state = step(w, f(review.delta_t), review.rating, state, index);
  }
  return validate(state);
}
