import { toRfc3339Opts } from '../../../platform/time/index.ts';

export const REASON_POLICY_OVERRIDE = 'policy_override';
export const REASON_CONFLICT_RESOLVE = 'conflict_resolve';
export const REASON_ROLLBACK_UNDO = 'rollback_undo';
export const DEFAULT_MAX_BATCHES = 50;

/** history.rs:63-69: UTC `%Y%m%dT%H%M%S%3fZ` plus 8 hex chars. */
export function newBatchId(now = new Date()): string {
  const stamp = toRfc3339Opts(BigInt(now.getTime()) * 1_000_000n, 'Millis', true)
    .replace(/[-:]/g, '').replace(/\.(\d{3})Z$/u, '$1Z');
  return `${stamp}-${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

export interface SnapshotBatchSummary {
  batch_id: string;
  reason: string;
  created_at: string;
  record_count: number;
  rolled_back_at: string | null;
}

/** history.rs:244-255. */
export interface RollbackOutcome {
  batch_id: string;
  restored: number;
  deleted: number;
  skipped: number;
  undo_batch_id: string;
}
