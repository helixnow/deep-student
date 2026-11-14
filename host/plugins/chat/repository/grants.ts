/** revocation_epochs SQL (Rust `chat_v2/grants.rs` persistence helpers); callers wrap errors with the Rust text. */
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';

export interface RevocationEpochRow { kind: unknown; task_id: unknown; epoch: unknown }

const SELECT_EPOCHS = 'SELECT kind, task_id, epoch FROM revocation_epochs';
const selectEpochs = defineQuery<void, RevocationEpochRow>(SELECT_EPOCHS, { options: { safeIntegers: true } });

/** `persist_revocation_epoch` upsert. */
export function upsertRevocationEpoch(conn: SqlExecutor, kind: string, taskId: string, epoch: bigint, updatedAt: string): void {
  conn.run(`INSERT INTO revocation_epochs (kind, task_id, epoch, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(kind, task_id) DO UPDATE SET
           epoch = excluded.epoch,
           updated_at = excluded.updated_at`, [kind, taskId, epoch, updatedAt]);
}

/** sqlite_master probe; a failing probe reads as "absent". */
export function revocationEpochsTableExists(conn: SqlExecutor): boolean {
  try {
    return conn.pluck<number | bigint>(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='revocation_epochs')") == 1;
  } catch { return false; }
}

/** `conn.prepare(SELECT ...)`: surfaces prepare errors separately from query errors. */
export function prepareRevocationEpochs(conn: SqlExecutor): void {
  conn.all(`EXPLAIN ${SELECT_EPOCHS}`);
}

export function selectRevocationEpochRows(conn: SqlExecutor): RevocationEpochRow[] {
  return conn.all(selectEpochs);
}
