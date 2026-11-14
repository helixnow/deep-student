import type {} from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../platform/storage/api.ts';
import type { NoteLeaseAuth, VfsNote } from '../../../contracts/ipc/generated/_shared.ts';
import type { ResourceLocation } from '../../../contracts/ipc/generated/L13-vfs-api.ts';
import type {
  NoteFormat, NoteHistoryPage, NoteRevision, NoteRevisionSummary,
  NoteState, NoteStateDelete, NoteStateKey, NoteStateList, NoteStatePut,
  NoteRelation, NoteRelationPut,
} from '../../../contracts/ipc/generated/L10-notes.ts';
import type { CanvasToolExecutor } from './src/canvas-tool.ts';
import type { NotesImportExecutor } from './src/notes-import-tool.ts';
import type { UserTodoExecutor } from './src/user-todo-tool.ts';
import type { StableBlock } from './src/structure.ts';
import {
  isOperatorSearchableKey, malformedPropsTotal, parsePropsCell, snippet,
} from './repository/props.ts';

export type {
  VfsNote, ResourceLocation, NoteFormat, NoteState,
  NoteHistoryPage, NoteRevision, NoteRevisionSummary, StableBlock,
};

/** Read-side note props diagnostics shared with L13's VFS API. */
export { isOperatorSearchableKey, malformedPropsTotal, parsePropsCell, snippet };

/** Rust VfsCreateNoteParams; service arguments use the wire camelCase spelling. */
export interface CreateNoteParams {
  title: string;
  content: string;
  tags?: string[];
}

export interface UpdateNoteParams {
  title?: string | null;
  content?: string | null;
  tags?: string[] | null;
  expectedUpdatedAt?: string | null;
}

export interface NoteMetadataUpdate {
  title?: string | null;
  tags?: string[] | null;
  isFavorite?: boolean | null;
  props?: unknown;
  expectedUpdatedAt?: string | null;
}

/** VfsNoteRepo entry points consumed by L11/L12/L13/L14/L17/L18/L20. */
export interface NoteRepository {
  getNote(id: string, conn?: SqlExecutor): VfsNote | null;
  getNoteContent(id: string, conn?: SqlExecutor): string | null;
  getNoteWithContent(id: string, conn?: SqlExecutor): [VfsNote, string] | null;
  createNote(params: CreateNoteParams, conn?: SqlExecutor): VfsNote;
  createNoteInFolder(params: CreateNoteParams, folderId: string | null, conn?: SqlExecutor): VfsNote;
  updateNote(id: string, params: UpdateNoteParams, conn?: SqlExecutor): VfsNote;
  updateNoteMetadata(id: string, params: NoteMetadataUpdate, conn?: SqlExecutor): VfsNote;
  listNotes(search: string | null, limit: number, offset: number, conn?: SqlExecutor): VfsNote[];
  listNotesByFolder(folderId: string | null, limit: number, offset: number, conn?: SqlExecutor): VfsNote[];
  listDeletedNotes(limit: number, offset: number, conn?: SqlExecutor): VfsNote[];
  deleteNote(id: string, conn?: SqlExecutor): void;
  deleteNoteWithFolderItem(id: string, conn?: SqlExecutor): void;
  restoreNote(id: string, conn?: SqlExecutor): void;
  purgeNote(id: string, conn?: SqlExecutor): void;
  /**
   * D1 seam: purge one note on the caller's transaction/executor. Optional only
   * so existing other-lane test doubles keep typechecking; the production
   * `notes` service always implements it.
   */
  purgeNoteWithConn?(conn: SqlExecutor, id: string): void;
  purgeDeletedNotes(conn?: SqlExecutor): number;
  /** D1 seam: purge every trashed note on the caller's transaction/executor. */
  purgeDeletedNotesWithConn?(conn: SqlExecutor): number;
  /**
   * D1 seam for L17 memory tag hygiene (`dstu-memory` service.rs:3518-3521,
   * 4416-4419 etc.): exactly `UPDATE notes SET tags=?1 WHERE id=?2` on the
   * caller's executor. No updated_at/resource/CAS change, no deleted_at filter,
   * no transaction of its own; SQLite errors propagate unchanged. Optional only
   * for other lanes' existing test doubles; the production service implements it.
   */
  rewriteTagsWithoutTouchingUpdatedAtWithConn?(conn: SqlExecutor, noteId: string, tagsJson: string): void;
  setFavorite(id: string, favorite: boolean, conn?: SqlExecutor): void;
  setNoteProps(id: string, props: unknown, conn?: SqlExecutor): VfsNote;
  getNoteLocation(id: string, conn?: SqlExecutor): ResourceLocation | null;
  backfillNoteLinksOnce(batchSize: number): boolean;
}

export interface NoteFormatRepository {
  get(conn: SqlExecutor, id: string): NoteFormat;
  /** note_format_repo.rs::blocks; parser errors propagate unchanged. */
  blocks?(content: string): StableBlock[];
  detect(id: string, content: string): NoteFormat;
  insert(conn: SqlExecutor, format: NoteFormat): void;
  ensureSupported(format: NoteFormat): void;
  serializer(stable: boolean, columns: boolean): string;
  requiredCapabilities(format: NoteFormat): string[];
}

/** D3: preserve Rust i64 sequence values until the kernel makes its wire copy. */
export type NoteHistorySequence = number | bigint;
export type ExactNoteHistoryPage = Omit<NoteHistoryPage, 'next_cursor'> & {
  next_cursor: NoteHistorySequence | null;
};

export interface NoteRevisionRepository {
  snapshot(conn: SqlExecutor, id: string, source: string): string;
  get(conn: SqlExecutor, id: string, versionId: string): NoteRevision;
  list(conn: SqlExecutor, id: string, cursor: NoteHistorySequence | null, limit: number): ExactNoteHistoryPage;
  setPinned(conn: SqlExecutor, id: string, versionId: string, pinned: boolean): NoteRevisionSummary;
  restoreCopy(conn: SqlExecutor, id: string, versionId: string): VfsNote;
}

/** L20-owned sync flow entry points; every write runs on the caller's SqlExecutor. */
export interface NoteSyncRepository {
  /** note_history.rs::prepare_relation; mutates `data.revision` to the local CAS value. */
  prepareRelation(conn: SqlExecutor, id: string, data: Record<string, unknown>): void;
  /** note_history.rs::retarget_note_relations; retargets non-card relations and invalidates missing blocks. */
  retargetNoteRelations(conn: SqlExecutor, noteId: string, previousResourceId: string): void;
  /** note_history.rs::apply_revision; immutable compare, pin upgrade only, then insert. */
  applyRevision(conn: SqlExecutor, id: string, data: unknown): void;
  /** note_history.rs::snapshot_notes inferred format; clears updated_at when metadata is inferred. */
  updateInferredFormat(conn: SqlExecutor, noteId: string): NoteFormat;
}

/** D3: Rust i64 revision. Number inside the two-sided safe range, bigint outside it. */
export type NoteStateRevision = number | bigint;

/** NoteState with an exact revision; `value` keeps integers beyond 2^53 as bigint. */
export type ExactNoteState = Omit<NoteState, 'revision'> & { revision: NoteStateRevision };

export interface NoteStateRepository {
  get(conn: SqlExecutor, request: NoteStateKey): ExactNoteState | null;
  list(conn: SqlExecutor, request: NoteStateList): ExactNoteState[];
  put(
    conn: SqlExecutor,
    request: Omit<NoteStatePut, 'expected_revision'> & { expected_revision?: NoteStateRevision | null },
  ): ExactNoteState;
  delete(
    conn: SqlExecutor,
    request: Omit<NoteStateDelete, 'expected_revision'> & { expected_revision: NoteStateRevision },
  ): ExactNoteState;
}

/** D3: relation CAS remains exact internally; the kernel emits JSON numbers on the wire. */
export type NoteRelationRevision = number | bigint;
export type ExactNoteRelation = Omit<NoteRelation, 'revision'> & { revision: NoteRelationRevision };
export type ExactNoteRelationPut = Omit<NoteRelationPut, 'expected_revision'> & {
  expected_revision?: NoteRelationRevision | null;
};

/** note_lease_repo.rs write fence; both run on the caller's SqlExecutor. */
export interface NoteLeaseRepository {
  /**
   * NoteLeaseRepo::authorized (note_lease_repo.rs:307-361). Runs in the
   * note_history_write savepoint: insert grant, check participant/lease/ready,
   * check frozen drafts when `commit`, run `work`, refresh drafts when `commit`,
   * then drop the grant. Errors (notes.* conflict keys) roll back and propagate unchanged.
   */
  authorized<T>(
    conn: SqlExecutor, auth: NoteLeaseAuth, webview: string, now: number, commit: boolean, work: () => T,
  ): T;
  /** NoteLeaseRepo::check_write: notes.lease_conflict when a lease without a live grant covers the note. */
  checkWrite(conn: SqlExecutor, noteId: string): void;
  /** Rust epoch seconds used as `now`. */
  now(): number;
}

export type DeletionTargetKind = 'asset' | 'workspace';

/** file_deletion_queue.rs PreparedDeletionIntent; `size` is the exact u64 (D3). */
export interface DeletionJournalIntent {
  operation_id: string;
  entity_key: string;
  local_path: string;
  expected_hash: string | null;
  size: bigint | null;
}

/**
 * D1 deletion journal owned by L10 (`dstu-storage/src/file_deletion_queue.rs`).
 * F3 keeps the file orchestration and calls these on the caller's SqlExecutor;
 * none opens its own connection or transaction beyond the SAVEPOINT Rust keeps
 * inside the same SQL group. SQL errors propagate unchanged.
 */
export interface DeletionJournalRepository {
  /** :348-422. `null` when the operation id exists with a different tuple (DuplicateOperation). */
  insertPreparedIntent(conn: SqlExecutor, input: {
    operationId: string; targetKind: DeletionTargetKind; entityKey: string; localPath: string;
    expectedHash: string | null; size: bigint | null;
  }): DeletionJournalIntent | null;
  /** :430-447, ordered by prepared_at, operation_id. */
  listPreparedIntents(conn: SqlExecutor, targetKind: DeletionTargetKind): DeletionJournalIntent[];
  /** :479-484. */
  cancelRetainedIntent(conn: SqlExecutor, operationId: string): void;
  /** :688-697. */
  cancelConflictIntent(conn: SqlExecutor, operationId: string, message: string): void;
  /** :603-675 inside SAVEPOINT file_deletion_ready. `false` when the journal row cannot become ready (InvalidState). */
  markReady(conn: SqlExecutor, targetKind: DeletionTargetKind, intent: DeletionJournalIntent): boolean;
  /** :305-338 inside SAVEPOINT workspace_deletion_recreated. */
  cancelReadyWorkspaceDeletion(conn: SqlExecutor, workspaceId: string): void;
}

/** D1 blob journal SQL from blob_repo.rs; all fields are already prepared by L11. */
export interface PreparedBlobDeletion {
  operationId: string;
  hash: string;
  relativePath: string;
  expectedHash: string | null;
  /** blob_repo.rs BlobDeletionIntent.size is Option<i64>, not the asset intent's u64. */
  size: bigint | null;
  preparedAt: string;
}

/**
 * Pure writes to vfs.__file_deletion_journal, not chat_v2's same-named table.
 * No transaction, file I/O, scanning, clock read or blob/outbox write. L11 owns
 * that orchestration and passes the same SqlExecutor and timestamps. SQL errors
 * propagate unchanged; in particular INSERT does not suppress duplicate ids.
 */
export interface BlobDeletionJournalRepository {
  /** blob_repo.rs:372-379, only matching blob/hash rows in prepared or ready. */
  cancelBlobDeletionsForRecreatedBlob(conn: SqlExecutor, hash: string, cancelledAt: string): void;
  /** blob_repo.rs:656-667, the original eight-column INSERT. */
  insertPreparedBlobDeletion(conn: SqlExecutor, input: PreparedBlobDeletion): void;
  /** blob_repo.rs:822-831, matching operation id in prepared state only. */
  cancelPreparedBlobDeletion(conn: SqlExecutor, operationId: string, cancelledAt: string, lastError: string): void;
  /** blob_repo.rs:861-868, affected rows; L11 retains the !=1 error judgment. */
  markBlobDeletionReady(conn: SqlExecutor, operationId: string, readyAt: string): number;
}

/**
 * Agent tool executors owned by L10 (`chat_v2/tools/{canvas,user_todo,notes_import}_executor.rs`).
 * L04 registers these in the chat tool runtime; until that registry is published
 * they are reachable through the `notes` service.
 */
export interface NotesToolExecutors {
  readonly canvas: CanvasToolExecutor;
  readonly userTodo: UserTodoExecutor;
  readonly notesImport: NotesImportExecutor;
}

/** `notes` (ARCHITECTURE.md 附录 A). Repository calls are synchronous, as in Rust *_with_conn. */
export interface NotesService {
  readonly version: 1;
  readonly repository: NoteRepository;
  readonly format: NoteFormatRepository;
  readonly revisions: NoteRevisionRepository;
  readonly sync?: NoteSyncRepository;
  readonly state: NoteStateRepository;
  readonly leases?: NoteLeaseRepository;
  readonly deletionJournal?: DeletionJournalRepository;
  /** Separate optional capability so existing six-method asset/workspace providers remain valid. */
  readonly blobDeletionJournal?: BlobDeletionJournalRepository;
  /** Optional for consumers/tests that only need repositories. */
  readonly tools?: NotesToolExecutors;
}

/** ARCHITECTURE.md service descriptor; consumers resolve `ctx.notes`. */
export const notesService = { name: 'notes', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    notes: NotesService;
    /**
     * @deprecated Transitional type-only alias for lanes that still declare the
     * pre-ARCHITECTURE.md key. Production provides `notes` only; remove once
     * every consumer has migrated (see LANE.md 待接线).
     */
    'notes@1': NotesService;
  }
}
