import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { defineQuery, type DatabaseHandle, type Row, type SqlParams } from '../../../platform/storage/api.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-note-owner-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble() } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

function writes() {
  const capability = host.ctx.vfsRepo.noteOwnerWrites;
  if (capability === undefined) throw new Error('vfsRepo.noteOwnerWrites is unavailable');
  return capability;
}
function row(sql: string, params: SqlParams): Row | undefined {
  return db.get(defineQuery<SqlParams, Row>(sql, { options: { safeIntegers: true } }), params);
}
function resource(label: string): string {
  return host.ctx.vfsRepo.resources.createOrReuse(db, 'note', label, 'note_original', 'notes', null).resourceId;
}
function membership(id: string, noteId: string, created: number, updated: number | null,
  deleted: string | null, type = 'note'): void {
  db.run(`INSERT INTO folder_items (id, item_type, item_id, created_at, updated_at, deleted_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`, [id, type, noteId, created, updated, deleted]);
}
const BACKFILL_KEY = 'maintenance.note_links_backfill_done';

describe('N5 / L10-V2-01 L11 owner writes via the production service', { timeout: 120_000 }, () => {
  it('binds only source_id and deletes only the requested resource row', () => {
    const rid = resource('note-bind');
    const other = resource('note-other');
    const before = row('SELECT * FROM resources WHERE id = ?1', [rid])!;
    writes().bindNoteSourceIdWithConn(db, rid, 'note_new');
    expect(row('SELECT * FROM resources WHERE id = ?1', [rid])).toEqual({ ...before, source_id: 'note_new' });
    expect(() => writes().bindNoteSourceIdWithConn(db, 'res_missing', 'note_new')).not.toThrow();

    // The caller, not this narrow delete, owns the preceding index-artifact cleanup.
    db.run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, created_at, updated_at)
      VALUES ('unit_no_cleanup', ?1, 0, 1, 1)`, [rid]);
    expect(writes().purgeNoteResourceRowWithConn(db, rid)).toBe(1);
    expect(writes().purgeNoteResourceRowWithConn(db, rid)).toBe(0);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = ?1', [rid])).toBe(1);
    expect(row('SELECT id FROM resources WHERE id = ?1', [other])?.id).toBe(other);
  });

  it('soft-deletes active note memberships only, preserving supplied i64 timestamps', () => {
    membership('fi_live', 'note_target', 10, 20, null);
    membership('fi_old', 'note_target', 5, 15, 'old deletion');
    membership('fi_other', 'note_other', 10, 20, null);
    const before = row('SELECT * FROM folder_items WHERE id = ?1', ['fi_live'])!;
    const old = row('SELECT * FROM folder_items WHERE id = ?1', ['fi_old']);
    const other = row('SELECT * FROM folder_items WHERE id = ?1', ['fi_other']);
    const now = 9007199254740993n;
    expect(writes().softDeleteNoteMembershipsWithConn(db, 'note_target', 'caller timestamp', now)).toBe(1);
    expect(row('SELECT * FROM folder_items WHERE id = ?1', ['fi_live']))
      .toEqual({ ...before, deleted_at: 'caller timestamp', updated_at: now });
    expect(row('SELECT * FROM folder_items WHERE id = ?1', ['fi_old'])).toEqual(old);
    expect(row('SELECT * FROM folder_items WHERE id = ?1', ['fi_other'])).toEqual(other);
    // An active non-note mount with the same item id is not a note membership.
    membership('fi_file', 'note_target', 30, 30, null, 'file');
    expect(writes().softDeleteNoteMembershipsWithConn(db, 'note_target', 'ignored', now)).toBe(0);
    expect(row('SELECT deleted_at FROM folder_items WHERE id = ?1', ['fi_file'])?.deleted_at).toBeNull();
  });

  it('restores only the latest deleted note mount with the exact Rust ordering', () => {
    membership('fi_old', 'note_coalesce', 10, 100, 'deleted');
    membership('fi_null_updated', 'note_coalesce', 200, null, 'deleted');
    membership('fi_wrong_type', 'note_coalesce', 999, 999, 'deleted', 'file');
    membership('fi_tie_old', 'note_tie', 10, 100, 'deleted');
    membership('fi_tie_new', 'note_tie', 20, 100, 'deleted');
    membership('fi_active', 'note_active', 10, 10, null);
    const selected = row('SELECT * FROM folder_items WHERE id = ?1', ['fi_null_updated'])!;
    const now = 9223372036854775807n;
    expect(writes().restoreLatestDeletedNoteMembershipWithConn(db, 'note_coalesce', now)).toBe(1);
    expect(row('SELECT * FROM folder_items WHERE id = ?1', ['fi_null_updated']))
      .toEqual({ ...selected, deleted_at: null, updated_at: now });
    expect(writes().restoreLatestDeletedNoteMembershipWithConn(db, 'note_tie', now)).toBe(1);
    expect(row('SELECT deleted_at FROM folder_items WHERE id = ?1', ['fi_tie_new'])?.deleted_at).toBeNull();
    for (const id of ['fi_old', 'fi_wrong_type', 'fi_tie_old']) {
      expect(row('SELECT deleted_at FROM folder_items WHERE id = ?1', [id])?.deleted_at).toBe('deleted');
    }
    expect(writes().restoreLatestDeletedNoteMembershipWithConn(db, 'note_active', now)).toBe(0);
    expect(writes().restoreLatestDeletedNoteMembershipWithConn(db, 'note_missing', now)).toBe(0);
  });

  it('disables only the two state columns of units for the requested resource', () => {
    const rid = resource('note-units');
    const other = resource('other-units');
    for (const [id, resourceId] of [['unit_a', rid], ['unit_b', rid], ['unit_other', other]] as const) {
      db.run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_required, mm_required,
        text_state, mm_state, text_error, mm_error, created_at, updated_at)
        VALUES (?1, ?2, ?3, 1, 1, 'failed', 'indexed', 'keep text error', 'keep mm error', 4, 5)`,
      [id, resourceId, id === 'unit_b' ? 1 : 0]);
    }
    const before = row('SELECT * FROM vfs_index_units WHERE id = ?1', ['unit_a'])!;
    const untouched = row('SELECT * FROM vfs_index_units WHERE id = ?1', ['unit_other']);
    expect(writes().disableNoteUnitsWithConn(db, rid)).toBe(2);
    expect(row('SELECT * FROM vfs_index_units WHERE id = ?1', ['unit_a']))
      .toEqual({ ...before, text_state: 'disabled', mm_state: 'disabled' });
    expect(row('SELECT * FROM vfs_index_units WHERE id = ?1', ['unit_other'])).toEqual(untouched);
    expect(writes().disableNoteUnitsWithConn(db, 'res_missing')).toBe(0);
  });

  it('writes only the fixed backfill flag without widening the public config whitelist', () => {
    const config = host.ctx.vfsRepo.indexingConfig;
    expect(() => config.setConfig(db, BACKFILL_KEY, 'true')).toThrow();
    db.run(`INSERT OR REPLACE INTO vfs_indexing_config (key, value, updated_at) VALUES (?1, 'false', 1)`, [BACKFILL_KEY]);
    writes().markNoteLinksBackfillDoneWithConn(db, 9223372036854775807n);
    expect(row('SELECT * FROM vfs_indexing_config WHERE key = ?1', [BACKFILL_KEY]))
      .toEqual({ key: BACKFILL_KEY, value: 'true', updated_at: 9223372036854775807n });
    expect(() => config.setConfig(db, BACKFILL_KEY, 'false')).toThrow();
  });

  it('keeps all six writes inside the caller transaction and preserves VFS SQL errors', () => {
    const rid = resource('note-transaction');
    const toDelete = resource('note-delete-transaction');
    membership('fi_tx_live', 'note_tx', 1, 1, null);
    membership('fi_tx_deleted', 'note_restore_tx', 1, 1, 'deleted');
    db.run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_state, mm_state, created_at, updated_at)
      VALUES ('unit_tx', ?1, 0, 'indexed', 'indexed', 1, 1)`, [rid]);
    const before = row('SELECT * FROM resources WHERE id = ?1', [rid]);
    db.exec(`CREATE TRIGGER reject_note_backfill BEFORE INSERT ON vfs_indexing_config
      WHEN NEW.key = 'maintenance.note_links_backfill_done'
      BEGIN SELECT RAISE(ABORT, 'note backfill rejected'); END`);
    expect(() => db.transaction(conn => {
      const owner = writes();
      owner.bindNoteSourceIdWithConn(conn, rid, 'note_changed');
      owner.softDeleteNoteMembershipsWithConn(conn, 'note_tx', 'deleted', 2n);
      owner.restoreLatestDeletedNoteMembershipWithConn(conn, 'note_restore_tx', 2n);
      owner.disableNoteUnitsWithConn(conn, rid);
      owner.purgeNoteResourceRowWithConn(conn, toDelete);
      owner.markNoteLinksBackfillDoneWithConn(conn, 2n);
    })).toThrow('Database error: note backfill rejected');
    expect(row('SELECT * FROM resources WHERE id = ?1', [rid])).toEqual(before);
    expect(row('SELECT id FROM resources WHERE id = ?1', [toDelete])?.id).toBe(toDelete);
    expect(row('SELECT deleted_at FROM folder_items WHERE id = ?1', ['fi_tx_live'])?.deleted_at).toBeNull();
    expect(row('SELECT deleted_at FROM folder_items WHERE id = ?1', ['fi_tx_deleted'])?.deleted_at).toBe('deleted');
    expect(row('SELECT text_state, mm_state FROM vfs_index_units WHERE id = ?1', ['unit_tx']))
      .toEqual({ text_state: 'indexed', mm_state: 'indexed' });
    expect(row('SELECT key FROM vfs_indexing_config WHERE key = ?1', [BACKFILL_KEY])).toBeUndefined();
  });
});
