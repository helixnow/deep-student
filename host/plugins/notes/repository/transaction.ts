import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { notesLog } from './log.ts';

/** note_revision_repo.rs:116-134; nested callers share the same connection. */
export function noteTransaction<T>(conn: SqlExecutor, work: () => T): T {
  conn.exec('SAVEPOINT note_history_write');
  try {
    const result = work();
    conn.exec('RELEASE note_history_write');
    return result;
  } catch (error) {
    try {
      conn.exec('ROLLBACK TO note_history_write; RELEASE note_history_write');
    } catch (rollbackError) {
      // Rust deliberately returns the original failure even if rollback failed.
      notesLog.warnError('[notes] note_history_write rollback failed', rollbackError);
    }
    throw error;
  }
}
