/** L10 N5 / L10-V2-01: exact L11-owned writes formerly embedded in Rust note_repo.rs. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

/**
 * All methods use the caller's connection, without beginning/releasing a transaction.
 * The notes owner keeps reference checks, index cleanup, snapshots, logs and their original order.
 * SQLite failures retain VFS_STORAGE / `Database error: …` semantics.
 */
export interface NoteOwnerWrites {
  /** note_repo.rs:538: source_id only, no source_table/updated_at/ref_count change. */
  bindNoteSourceIdWithConn(conn: SqlExecutor, resourceId: string, noteId: string): void;
  /** :837/:1878: delete one resource row only; no reference scan or cleanup. */
  purgeNoteResourceRowWithConn(conn: SqlExecutor, resourceId: string): number;
  /** :2383: soft-delete active note memberships only, using the supplied timestamps verbatim. */
  softDeleteNoteMembershipsWithConn(conn: SqlExecutor, noteId: string,
    deletedAt: string, updatedAtMs: number | bigint): number;
  /**
   * :1618-1637: select latest deleted note membership by COALESCE(updated_at,created_at) DESC,
   * created_at DESC, then restore that id only. No matching row → 0.
   */
  restoreLatestDeletedNoteMembershipWithConn(conn: SqlExecutor, noteId: string,
    updatedAtMs: number | bigint): number;
  /** :2397: set text_state/mm_state='disabled' only, no error/required/updated_at change. */
  disableNoteUnitsWithConn(conn: SqlExecutor, resourceId: string): number;
  /**
   * :3111-3118: INSERT OR REPLACE the fixed maintenance.note_links_backfill_done='true' key.
   * Call only after every rebuild batch succeeds. This does not broaden setConfig's whitelist.
   */
  markNoteLinksBackfillDoneWithConn(conn: SqlExecutor, updatedAtMs: number | bigint): void;
}
