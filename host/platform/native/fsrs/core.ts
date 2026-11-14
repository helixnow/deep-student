/**
 * Portable FSRS service over any F7 runner: request encoding and error
 * mapping for `optimize`/`evaluate`, plus the synchronous f32 model.
 * `index.ts` binds it to the desktop loader, `web.ts` to the in-memory engine.
 */
import { FsrsError, type FsrsErrorKind, type FsrsItem, type NativeFsrs } from './api.ts';
import { memoryState, nextStates } from './model.ts';

/** Runs one `{ engine: 'fsrs', ... }` request and returns the raw response object. */
export type FsrsEngineCall = (request: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<Record<string, unknown>>;

const KINDS = new Set<FsrsErrorKind>(['NotEnoughData', 'Interrupted', 'InvalidParameters', 'OptimalNotFound', 'InvalidInput', 'InvalidDeckSize']);
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** Send review values as given; u32 checks are done by serde-equivalent parsing in the engine. */
function wireItems(items: readonly FsrsItem[]): unknown[] {
  return items.map(item => ({ reviews: item.reviews.map(review => ({ rating: review.rating, delta_t: review.delta_t })) }));
}

/** i64 card ids travel as decimal strings so values beyond 2^53 survive JSON. */
function wireCardId(id: number | bigint): string {
  const value = typeof id === 'bigint' ? id : Number.isSafeInteger(id) ? BigInt(id) : null;
  if (value === null || value < I64_MIN || value > I64_MAX) throw new TypeError(`card id is not an i64: ${String(id)}`);
  return value.toString();
}

/** Crate-level FSRS-6 engine; scheduling is owned by L15. */
export function createFsrs(call: FsrsEngineCall): NativeFsrs {
  async function invoke(request: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
    const response = await call({ engine: 'fsrs', ...request }, signal);
    if (response.ok === true) return response;
    if (typeof response.kind === 'string' && KINDS.has(response.kind as FsrsErrorKind)) throw new FsrsError(response.kind as FsrsErrorKind);
    throw new TypeError(`fsrs engine rejected the request: ${String(response.message ?? JSON.stringify(response))}`);
  }
  return {
    nextStates,
    memoryState,
    async optimize(input, options = {}) {
      const response = await invoke({
        op: 'optimize',
        items: wireItems(input.trainSet),
        card_ids: input.cardIds === undefined || input.cardIds === null ? null : input.cardIds.map(wireCardId),
        enable_short_term: input.enableShortTerm ?? true,
        num_relearning_steps: input.numRelearningSteps ?? null,
      }, options.signal);
      const parameters = response.parameters;
      if (!Array.isArray(parameters)) throw new Error('fsrs engine returned no parameters');
      // serde_json writes a non-finite f32 as null.
      return parameters.map(value => (value === null ? Number.NaN : Number(value)));
    },
    async evaluate(parameters, items, options = {}) {
      const response = await invoke({ op: 'evaluate', parameters: [...parameters], items: wireItems(items) }, options.signal);
      const finite = (value: unknown): number => (value === null ? Number.NaN : Number(value));
      return { logLoss: finite(response.log_loss), rmseBins: finite(response.rmse_bins) };
    },
  };
}
