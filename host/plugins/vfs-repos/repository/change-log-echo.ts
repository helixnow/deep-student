/**
 * Suppresses trigger-emitted `__change_log` UPDATE echo rows for local-only
 * derived column mutations (e.g. `index_state`, `mm_index_*`, `processing_*`).
 *
 * Mobile-portable: depends only on `SqlExecutor` and the repository logger.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { logWarn } from './logger.ts';

let savepointSeq = 0;

function hasChangeLogTable(conn: SqlExecutor): boolean {
  const row = conn.pluck<number | bigint>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__change_log')",
  );
  return Number(row ?? 0) !== 0;
}

/**
 * Executes a local-derived-only UPDATE inside an atomic transaction/savepoint
 * and deletes only the trigger-emitted `__change_log` UPDATE echo rows created
 * during `fn()`. Pre-existing pending rows (`id <= preMax`) are preserved, and
 * minimal test schemas without `__change_log` execute `fn()` directly.
 *
 * ONLY wrap statements that mutate exclusively local-derived non-synced columns
 * (consistent with `isLocalDerivedSyncColumn`).
 */
export function runWithoutChangeLogEcho<T>(
  conn: SqlExecutor,
  tableName: string,
  fn: () => T,
): T {
  if (!hasChangeLogTable(conn)) return fn();

  const executeAndSuppress = (): T => {
    const preMax = conn.pluck<number | bigint>('SELECT COALESCE(MAX(id), 0) FROM __change_log') ?? 0;
    const result = fn();
    conn.run(
      `DELETE FROM __change_log
       WHERE id > ?1 AND sync_version = 0 AND table_name = ?2 AND operation = 'UPDATE'`,
      [preMax, tableName],
    );
    return result;
  };

  if (conn.inTransaction === false) {
    conn.exec('BEGIN IMMEDIATE');
    try {
      const result = executeAndSuppress();
      conn.exec('COMMIT');
      return result;
    } catch (error) {
      try { conn.exec('ROLLBACK'); }
      catch (rollbackError) { logWarn('[VFS::ChangeLogEcho] Rollback failed:', rollbackError); }
      throw error;
    }
  }

  const sp = `sp_no_changelog_echo_${++savepointSeq}`;
  conn.exec(`SAVEPOINT ${sp}`);
  try {
    const result = executeAndSuppress();
    conn.exec(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp};`); }
    catch (rollbackError) { logWarn('[VFS::ChangeLogEcho] Savepoint rollback failed:', rollbackError); }
    throw error;
  }
}
