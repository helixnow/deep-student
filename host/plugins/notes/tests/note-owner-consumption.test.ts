import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import paths from '../../../platform/paths/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let storage: ReturnType<typeof createStorageService>;
beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  await host.install(paths, vfsRepos, notes);
}, 120000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await host.dispose(); storage.dispose(); });

describe('N5 / L10-V2-01 notes consumes the real L11 owner on the caller connection', () => {
  it('test_create_note / test_update_note_reclaims_old_resources delegate binding and cleanup atomically', () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.repository;
    const owner = host.ctx.vfsRepo.noteOwnerWrites!;
    const bind = vi.spyOn(owner, 'bindNoteSourceIdWithConn');
    const purge = vi.spyOn(owner, 'purgeNoteResourceRowWithConn');
    const index = vi.spyOn(host.ctx.vfsRepo.embeddingUnits, 'purgeIndexArtifactsByResource');
    const note = repo.createNote({ title: 'owner binding', content: 'before' }, db);
    expect(bind).toHaveBeenCalledWith(db, note.resourceId, note.id);
    expect(db.pluck('SELECT source_id FROM resources WHERE id=?1', [note.resourceId])).toBe(note.id);
    const rollback = new Error('caller rollback');
    expect(() => db.transaction(conn => {
      const changed = repo.updateNote(note.id, { content: 'after' }, conn);
      expect(changed.resourceId).not.toBe(note.resourceId);
      expect(purge).toHaveBeenCalledWith(conn, note.resourceId);
      expect(index.mock.invocationCallOrder[0]).toBeLessThan(purge.mock.invocationCallOrder[0]!);
      expect(db.pluck('SELECT id FROM resources WHERE id=?1', [note.resourceId])).toBeUndefined();
      throw rollback;
    })).toThrow(rollback);
    expect(repo.getNoteContent(note.id, db)).toBe('before');
    expect(db.pluck('SELECT id FROM resources WHERE id=?1', [note.resourceId])).toBe(note.resourceId);
  });

  it('test_soft_delete_and_restore delegates memberships and units, restoring only the latest mount', () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.repository;
    const owner = host.ctx.vfsRepo.noteOwnerWrites!;
    const soft = vi.spyOn(owner, 'softDeleteNoteMembershipsWithConn');
    const disable = vi.spyOn(owner, 'disableNoteUnitsWithConn');
    const restore = vi.spyOn(owner, 'restoreLatestDeletedNoteMembershipWithConn');
    const note = repo.createNoteInFolder({ title: 'owner memberships', content: 'body' }, null, db);
    db.run(`INSERT INTO folder_items (id,item_type,item_id,created_at,updated_at,deleted_at)
      VALUES ('fi_owner_old','note',?1,1,2,'old deletion')`, [note.id]);
    db.run(`INSERT INTO vfs_index_units (id,resource_id,unit_index,text_state,mm_state,created_at,updated_at)
      VALUES ('unit_owner',?1,0,'indexed','failed',1,2)`, [note.resourceId]);
    repo.deleteNoteWithFolderItem(note.id, db);
    expect(soft).toHaveBeenCalledWith(db, note.id, expect.any(String), expect.any(Number));
    expect(disable).toHaveBeenCalledWith(db, note.resourceId);
    expect(soft.mock.invocationCallOrder[0]).toBeLessThan(disable.mock.invocationCallOrder[0]!);
    expect(db.get('SELECT text_state,mm_state,updated_at FROM vfs_index_units WHERE id=\'unit_owner\''))
      .toEqual({ text_state: 'disabled', mm_state: 'disabled', updated_at: 2 });
    repo.restoreNote(note.id, db);
    expect(restore).toHaveBeenCalledWith(expect.anything(), note.id, expect.any(Number));
    expect(db.pluck("SELECT COUNT(*) FROM folder_items WHERE item_id=?1 AND deleted_at IS NULL", [note.id])).toBe(1);
    expect(db.pluck("SELECT deleted_at FROM folder_items WHERE id='fi_owner_old'")).toBe('old deletion');
  });

  it('test_purge_note_removes_all_owned_resources rolls back a real owner SQL failure and permits retry', () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.repository;
    const purge = vi.spyOn(host.ctx.vfsRepo.noteOwnerWrites!, 'purgeNoteResourceRowWithConn');
    const note = repo.createNoteInFolder({ title: 'owner purge failure', content: 'body' }, null, db);
    db.exec(`CREATE TRIGGER reject_owner_resource_delete BEFORE DELETE ON resources
      WHEN OLD.id='${note.resourceId}' BEGIN SELECT RAISE(ABORT,'owner resource delete rejected'); END`);
    try {
      expect(() => repo.purgeNoteWithConn!(db, note.id)).toThrow('Database error: owner resource delete rejected');
      expect(purge).toHaveBeenCalledWith(db, note.resourceId);
      expect(repo.getNote(note.id, db)?.resourceId).toBe(note.resourceId);
      expect(db.pluck('SELECT COUNT(*) FROM folder_items WHERE item_id=?1', [note.id])).toBe(1);
    } finally { db.exec('DROP TRIGGER reject_owner_resource_delete'); }
    repo.purgeNoteWithConn!(db, note.id);
    expect(repo.getNote(note.id, db)).toBeNull();
    expect(db.pluck('SELECT id FROM resources WHERE id=?1', [note.resourceId])).toBeUndefined();
  });

  it('test_backfill_note_links_once_flag_and_retry_semantics writes the owner flag only after successful batches', () => {
    const db = storage.database('vfs');
    const repo = host.ctx.notes.repository;
    const mark = vi.spyOn(host.ctx.vfsRepo.noteOwnerWrites!, 'markNoteLinksBackfillDoneWithConn');
    repo.createNote({ title: 'owner backfill', content: '[[owner binding]]' }, db);
    db.exec(`CREATE TRIGGER reject_owner_links BEFORE INSERT ON note_links
      BEGIN SELECT RAISE(ABORT,'owner rebuild rejected'); END`);
    try {
      expect(() => repo.backfillNoteLinksOnce(1)).toThrow('owner rebuild rejected');
      expect(mark).not.toHaveBeenCalled();
      expect(db.pluck("SELECT value FROM vfs_indexing_config WHERE key='maintenance.note_links_backfill_done'"))
        .toBeUndefined();
    } finally { db.exec('DROP TRIGGER reject_owner_links'); }
    expect(repo.backfillNoteLinksOnce(1)).toBe(true);
    expect(mark).toHaveBeenCalledWith(db, expect.any(Number));
    expect(db.pluck("SELECT value FROM vfs_indexing_config WHERE key='maintenance.note_links_backfill_done'")).toBe('true');
    expect(repo.backfillNoteLinksOnce(1)).toBe(false);
    expect(mark).toHaveBeenCalledTimes(1);
  });
});
