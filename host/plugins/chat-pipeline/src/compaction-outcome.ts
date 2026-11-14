/**
 * pipeline/compaction.rs — structured compaction outcome and the summary /
 * commit / post-commit ordering guarantee.
 *
 * `statusCode`/`reasonCode` strings are a contract with the frontend (manual
 * compaction response and the `compaction_failed` event payload).
 */

import { rustTrim } from '../../../platform/util/index.ts';

export type CompactionSkipReason =
  | 'notTriggered'
  | 'sessionTooShort'
  | 'noCompactibleRange'
  | 'usableTooSmall'
  | 'lockBusy'
  | 'noModel'
  | 'summaryFailed'
  | 'cancelled'
  | 'staleLineage'
  | 'internalError'
  | 'cooldown';

export type CompactionOutcome =
  | { kind: 'compacted'; tokensBefore: number | null; tokensAfter: number | null }
  | { kind: 'notNeeded'; reason: CompactionSkipReason }
  | { kind: 'skipped'; reason: CompactionSkipReason }
  | { kind: 'failed'; reason: CompactionSkipReason };

export function compactionStatus(outcome: CompactionOutcome): 'compacted' | 'notNeeded'
  | 'skipped' | 'failed' {
  return outcome.kind;
}

export function compactionReasonCode(outcome: CompactionOutcome): CompactionSkipReason | null {
  return outcome.kind === 'compacted' ? null : outcome.reason;
}

export function compactionDidCompact(outcome: CompactionOutcome): boolean {
  return outcome.kind === 'compacted';
}

export function compactionTokenEstimates(outcome: CompactionOutcome):
  [number | null, number | null] {
  return outcome.kind === 'compacted'
    ? [outcome.tokensBefore, outcome.tokensAfter]
    : [null, null];
}

export function compactionIsFailed(outcome: CompactionOutcome): boolean {
  return outcome.kind === 'failed';
}

/**
 * Anti-flapping cooldown: failures wait 120s, an uncompactible or too-short
 * session waits 60s, success and other skips clear the cooldown.
 */
export function cooldownSecondsForOutcome(outcome: CompactionOutcome): number | null {
  switch (outcome.kind) {
    case 'failed': return 120;
    case 'notNeeded':
      return outcome.reason === 'noCompactibleRange' || outcome.reason === 'sessionTooShort'
        ? 60
        : null;
    default: return null;
  }
}

/** A compaction model id is usable only when it is not blank after trimming. */
export function validatedCompactionModelId(modelId: string | null | undefined): string | null {
  if (modelId === null || modelId === undefined) return null;
  const trimmed = rustTrim(modelId);
  return trimmed === '' ? null : trimmed;
}

export type SummaryCommitResult<T, E> =
  | { ok: true; value: T | null }
  | { ok: false; error: E };

/**
 * Enforces the only valid side-effect order: summary -> transaction ->
 * memory flush. A failed or empty summary never persists; a failed persist
 * never runs the post-commit work.
 */
export async function runSummaryCommitPost<T, E>(
  summarize: () => Promise<SummaryCommitResult<T, E>>,
  persist: (prepared: T) => SummaryCommitResult<boolean, E>,
  postCommit: (prepared: T) => Promise<void>,
): Promise<SummaryCommitResult<T, E>> {
  const summary = await summarize();
  if (!summary.ok) return summary;
  if (summary.value === null) return { ok: true, value: null };
  const prepared = summary.value;

  const persisted = persist(prepared);
  if (persisted.ok === false) return persisted;
  if (!persisted.value) return { ok: true, value: null };

  await postCommit(prepared);
  return { ok: true, value: prepared };
}
