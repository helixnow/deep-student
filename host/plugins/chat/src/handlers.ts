import { CommandError } from '../../../kernel/api.ts';
import { StorageError, type StorageService } from '../../../platform/storage/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { ChatV2Error } from './error.ts';
import { getSession } from '../repository/sessions.ts';
import { getGoal, updateObjective } from '../repository/goals.ts';

import { rustTrim } from '../../../platform/util/index.ts';

export function commandResult<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof ChatV2Error) throw new CommandError(error.toCommandError());
    throw error;
  }
}

/** snapshot_handlers.rs maps Display directly; it does not use String::from(ChatV2Error). */
export function snapshotCommandResult<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof ChatV2Error || error instanceof StorageError) throw new CommandError(error.message);
    throw error;
  }
}

export async function asyncCommandResult<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) {
    if (error instanceof ChatV2Error) throw new CommandError(error.toCommandError());
    throw error;
  }
}

export function chatDatabase(storage: StorageService): DatabaseHandle {
  try { return storage.database('chat_v2'); } catch (error) {
    if (error instanceof StorageError) throw new ChatV2Error('Database', error.code === 'MAINTENANCE'
      ? 'Database is in maintenance mode (backup/restore in progress)' : `Failed to get connection: ${error.message}`);
    throw error;
  }
}

export function validateSessionId(id: string, label = 'session ID'): void {
  if (!['sess_', 'agent_', 'subagent_'].some(prefix => id.startsWith(prefix))) {
    throw new ChatV2Error('Validation', `Invalid ${label} format: ${id}`);
  }
}

export function ensureSessionWritable(db: SqlExecutor, id: string): void {
  const session = getSession(db, id);
  if (!session) return;
  const metadata = session.metadata as Record<string, unknown> | null | undefined;
  if (session.mode === 'subagent' || metadata?.is_subagent === true) {
    throw new ChatV2Error('Validation', 'Subagent sessions are read-only; use the workspace runtime to communicate with them.');
  }
}

export function editGoal(db: DatabaseHandle, id: string, objective: string, tokenBudget: number | null) {
  ensureSessionWritable(db, id);
  objective = rustTrim(objective);
  if (!objective) throw new ChatV2Error('Validation', 'objective 不能为空');
  if (tokenBudget !== null && tokenBudget <= 0) throw new ChatV2Error('Validation', 'token_budget 必须是正整数');
  const existing = getGoal(db, id);
  if (!existing) throw new ChatV2Error('Validation', 'cannot edit goal because this session has no goal');
  if (existing.status === 'complete') throw new ChatV2Error('Validation', 'cannot edit a completed goal; clear it first and create a new one');
  const updated = updateObjective(db, id, objective, tokenBudget);
  if (!updated) throw new ChatV2Error('Validation', 'goal was modified concurrently; please retry');
  return updated;
}
