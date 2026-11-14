/** Only transient transaction/connection loss qualifies; constraints and cancellation do not. */
export function isLostBackingTransactionError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const matches = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    try {
      const detail = value as { name?: string; message?: string; failures?: unknown[];
        inner?: unknown; cause?: unknown };
      if (detail.name === 'BulkError' && detail.failures?.length) {
        return detail.failures.every(matches);
      }
      const message = detail.message ?? '';
      // Do not classify arbitrary AbortError (e.g. explicit user cancellation).
      return detail.name === 'TransactionInactiveError'
        || (detail.name === 'InvalidStateError' && /transaction|database|connection/i.test(message))
        || (detail.name === 'AbortError' && /transaction (?:was |has been )?aborted/i.test(message))
        || /database connection is closing|backing transaction|without an in-progress transaction/i.test(message)
        || matches(detail.inner) || matches(detail.cause);
    } finally {
      seen.delete(value);
    }
  };
  return matches(error);
}

export interface TransactionRecoveryOptions {
  reopenConnection: () => void | Promise<void>;
  /** Number of retries after the first attempt; defaults to two. */
  maxRetries?: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Replay only atomic local DB work, never network calls or external side effects.
 * operation must create a fresh transaction on every invocation. */
export async function runWithTransactionRecovery<T>(
  operation: () => T | Promise<T>, options: TransactionRecoveryOptions,
): Promise<T> {
  const retries = options.maxRetries ?? 2;
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError('maxRetries must be a nonnegative integer');
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isLostBackingTransactionError(error)) throw error;
      await sleep((options.initialDelayMs ?? 100) * (options.backoffMultiplier ?? 4) ** attempt);
      if (attempt === retries - 1) await options.reopenConnection();
    }
  }
}
