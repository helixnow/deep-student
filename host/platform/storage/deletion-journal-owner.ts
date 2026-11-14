import { Slot, type Disposer } from '../../kernel/api.ts';
import type { SqlExecutor } from './api.ts';

export type DeletionJournalTargetKind = 'asset' | 'workspace';
/** Exact internal u64 representation; the owner handles Rust's as-i64/try_from SQL rules. */
export interface DeletionJournalIntent {
  operation_id: string;
  entity_key: string;
  local_path: string;
  expected_hash: string | null;
  size: bigint | null;
}
export interface PrepareDeletionJournalIntent {
  operationId: string;
  targetKind: DeletionJournalTargetKind;
  entityKey: string;
  localPath: string;
  expectedHash: string | null;
  size: bigint | null;
}

/** L10 owns SQL. F3 owns filesystem operations and error classification. */
export interface DeletionJournalRepository {
  insertPreparedIntent(conn: SqlExecutor, input: PrepareDeletionJournalIntent): DeletionJournalIntent | null;
  listPreparedIntents(conn: SqlExecutor, targetKind: DeletionJournalTargetKind): DeletionJournalIntent[];
  cancelRetainedIntent(conn: SqlExecutor, operationId: string): void;
  cancelConflictIntent(conn: SqlExecutor, operationId: string, message: string): void;
  markReady(conn: SqlExecutor, targetKind: DeletionJournalTargetKind, intent: DeletionJournalIntent): boolean;
  cancelReadyWorkspaceDeletion(conn: SqlExecutor, workspaceId: string): void;
}

const journalOwner = new Slot<DeletionJournalRepository>();
export function registerDeletionJournal(repo: DeletionJournalRepository): Disposer {
  return journalOwner.provide(repo);
}

/** F3 will consume the owner after L10's actual repository is integrated. No SQL fallback here. */
export function deletionJournalRepository(): DeletionJournalRepository {
  const owner = journalOwner.get();
  if (!owner) throw new Error('deletion journal owner is not registered');
  return owner;
}
