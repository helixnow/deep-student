/**
 * fsrs =6.6.2. Values crossing the engine boundary are f32.
 *
 * Scheduling (learning steps, fuzz, logical days, card phases) is owned by L15
 * (`dstu-learning/src/fsrs_scheduler.rs` -> `host/plugins/review`); this lane
 * only publishes the crate-level model. `nextStates`/`memoryState` are the
 * synchronous f32 port (checked against the crate in tests); `optimize` and
 * `evaluate` run the crate itself in the prebuilt F7 WASI engine (`fsrs` engine).
 */
export interface MemoryState { stability: number; difficulty: number }
export interface FsrsItem { reviews: { rating: number; delta_t: number }[] }
export interface FsrsNextState { memory: MemoryState; interval: number }
export interface FsrsNextStates {
  again: FsrsNextState; hard: FsrsNextState; good: FsrsNextState; easy: FsrsNextState;
}
/**
 * `fsrs::ComputeParametersInput` as the Rust caller fills it
 * (`fsrs_review_service.rs::optimize_parameters`): `progress` and `training_config` stay
 * `None` (the crate defaults). `cardIds` is `Option<Vec<i64>>` aligned with `trainSet`.
 */
export interface FsrsComputeParametersInput {
  trainSet: readonly FsrsItem[];
  cardIds?: readonly (number | bigint)[] | null;
  /** Crate default `true`. */
  enableShortTerm?: boolean;
  numRelearningSteps?: number | null;
}
/** `fsrs::ModelEvaluation`. */
export interface FsrsModelEvaluation { logLoss: number; rmseBins: number }
/** `fsrs::FSRSError` variants. */
export type FsrsErrorKind = 'NotEnoughData' | 'Interrupted' | 'InvalidParameters' | 'OptimalNotFound' | 'InvalidInput' | 'InvalidDeckSize';
/** An `FSRSError`; `message` is its `{:?}` text (the variant name), as the Rust callers format it. */
export class FsrsError extends Error {
  readonly kind: FsrsErrorKind;
  constructor(kind: FsrsErrorKind) {
    super(kind);
    this.name = 'FsrsError';
    this.kind = kind;
  }
}
export interface NativeFsrs {
  nextStates(parameters: readonly number[], memory: MemoryState | null,
    desiredRetention: number, daysElapsed: number): FsrsNextStates;
  memoryState(parameters: readonly number[], item: FsrsItem,
    startingState: MemoryState | null): MemoryState;
  /**
   * `fsrs::compute_parameters(input)`: the 21 trained parameters, or `FsrsError`.
   * `signal` terminates the engine (the Rust command itself has no cancel path).
   */
  optimize(input: FsrsComputeParametersInput, options?: { signal?: AbortSignal }): Promise<number[]>;
  /** `FSRS::new(parameters)?.evaluate(items, |_| true)`; `FsrsError` from either step. */
  evaluate(parameters: readonly number[], items: readonly FsrsItem[],
    options?: { signal?: AbortSignal }): Promise<FsrsModelEvaluation>;
}
export {
  DEFAULT_PARAMETERS, effectiveParameters, forgettingCurveConstants, retrievability,
} from './parameters.ts';
export { clipParameters, nextStates as fsrsNextStates, memoryState as fsrsMemoryState,
  nextIntervalForStability, powerForgettingCurve } from './model.ts';
declare module '@deepseek-ai/cordis' {
  interface Context { nativeFsrs: NativeFsrs }
}
