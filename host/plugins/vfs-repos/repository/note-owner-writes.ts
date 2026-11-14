/** L11 table-owner handoff for note_repo.rs; L10 retains the surrounding transaction/order/logs. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { NoteOwnerWrites } from '../api.ts';
import { databaseResult } from './errors.ts';

export class NoteOwnerWritesRepo implements NoteOwnerWrites {
  bindNoteSourceIdWithConn(conn: SqlExecutor, resourceId: string, noteId: string): void {
    databaseResult(() => {
      conn.run('UPDATE resources SET source_id = ?1 WHERE id = ?2', [noteId, resourceId]);
    });
  }

  purgeNoteResourceRowWithConn(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]).changes);
  }

  softDeleteNoteMembershipsWithConn(conn: SqlExecutor, noteId: string,
    deletedAt: string, updatedAtMs: number | bigint): number {
    return databaseResult(() => conn.run(`UPDATE folder_items SET deleted_at = ?1, updated_at = ?2
      WHERE item_type = 'note' AND item_id = ?3 AND deleted_at IS NULL`,
    [deletedAt, updatedAtMs, noteId]).changes);
  }

  restoreLatestDeletedNoteMembershipWithConn(conn: SqlExecutor, noteId: string,
    updatedAtMs: number | bigint): number {
    return databaseResult(() => {
      const row = conn.get<{ id: string }>(`SELECT id FROM folder_items
        WHERE item_type = 'note' AND item_id = ?1 AND deleted_at IS NOT NULL
        ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC LIMIT 1`, [noteId]);
      if (row === undefined) return 0;
      return conn.run('UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2',
        [updatedAtMs, row.id]).changes;
    });
  }

  disableNoteUnitsWithConn(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => conn.run(`UPDATE vfs_index_units
      SET text_state = 'disabled', mm_state = 'disabled' WHERE resource_id = ?1`, [resourceId]).changes);
  }

  markNoteLinksBackfillDoneWithConn(conn: SqlExecutor, updatedAtMs: number | bigint): void {
    databaseResult(() => {
      conn.run(`INSERT OR REPLACE INTO vfs_indexing_config (key, value, updated_at)
        VALUES ('maintenance.note_links_backfill_done', 'true', ?1)`, [updatedAtMs]);
    });
  }
}
