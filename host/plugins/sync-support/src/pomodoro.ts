/** pomodoro_counts.rs: invoke L11's single-writer batch operation on the apply connection. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { PomodoroRepository } from '../../vfs-repos/api.ts';
import type { PomodoroCountsSupport, SyncChangeWithData } from '../api.ts';
import { databaseError } from './errors.ts';

export function changesAffectTodoPomodoroCounts(changes: readonly SyncChangeWithData[]): boolean {
  return changes.some(change => change.table_name === 'pomodoro_records' || change.table_name === 'todo_items');
}

export function createPomodoroCountsSupport(
  owner: () => Pick<PomodoroRepository, 'recomputeCompletedPomodorosForSyncBatch'> | undefined,
): PomodoroCountsSupport {
  const run = (db: SqlExecutor, tables: readonly string[]): void => {
    const repo = owner();
    if (repo === undefined) databaseError('pomodoro sync service unavailable (L11 vfsRepo.pomodoros)');
    try {
      repo.recomputeCompletedPomodorosForSyncBatch(db, tables);
    } catch (error) {
      // The owner's message already contains the Rust 重算/清零 context.
      databaseError(error instanceof Error ? error.message : String(error));
    }
  };
  return {
    changesAffectTodoPomodoroCounts,
    recomputeIfRelevant(db, changes) {
      if (changesAffectTodoPomodoroCounts(changes)) run(db, changes.map(change => change.table_name));
    },
    recompute: db => run(db, ['pomodoro_records', 'todo_items']),
  };
}
