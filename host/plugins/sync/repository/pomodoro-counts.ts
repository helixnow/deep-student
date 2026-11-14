/** TD-02 owner boundary. SQL belongs to L11; the caller's transaction is passed unchanged. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { PomodoroRepository } from '../../vfs-repos/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { SyncError } from '../src/errors.ts';

type Owner = Pick<PomodoroRepository, 'recomputeCompletedPomodorosForSyncBatch'>;
let owner: (() => Owner) | null = null;
export function setPomodoroCountsOwner(resolve: (() => Owner) | null): void { owner = resolve; }
export function changesAffectTodoPomodoroCounts(changes: readonly EngineChange[]): boolean {
  return changes.some(change => change.table_name === 'pomodoro_records' || change.table_name === 'todo_items');
}
export function recomputeTodoCompletedPomodorosIfRelevant(db: SqlExecutor, changes: readonly EngineChange[]): void {
  if (!changesAffectTodoPomodoroCounts(changes)) return;
  recompute(db, [...new Set(changes.map(change => change.table_name))]);
}
export function recomputeTodoCompletedPomodoros(db: SqlExecutor): void { recompute(db, ['pomodoro_records', 'todo_items']); }
function recompute(db: SqlExecutor, tables: readonly string[]): void {
  if (owner === null) throw new SyncError('Database error: vfsRepo.pomodoros sync batch owner is unavailable');
  try { owner().recomputeCompletedPomodorosForSyncBatch(db, tables); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SyncError(detail.startsWith('Database error: ') ? detail : `Database error: ${detail}`);
  }
}
export function currentSyncVersion(): number { return Math.floor(Date.now() / 1000); }
