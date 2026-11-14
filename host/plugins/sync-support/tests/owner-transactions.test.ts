import { describe, expect, it, vi } from 'vitest';
import { serviceHost } from './service-host.ts';
import { MINIMAL_NOTES_SCHEMA, seedNote } from './note-fixtures.ts';

const revision = {
  version_id: 'v', note_id: 'n', title: 't', content_md: 'body', tags_json: '[]',
  asset_refs_json: '[]', source: 'remote_sync', created_at: '2026-11-04T00:00:00Z',
  content_format: 'markdown-legacy', format_version: 1, serializer_version: 'markdown-v1',
};

describe('S04 real owner writes share the sync apply transaction', () => {
  it('notes and pomodoro owners use the passed transaction once and roll back with its later failure', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(MINIMAL_NOTES_SCHEMA);
      seedNote(h.db, 'n', 'resource', 'body');
      h.db.exec(`CREATE TABLE todo_items(id TEXT PRIMARY KEY, completed_pomodoros INTEGER);
        CREATE TABLE pomodoro_records(todo_item_id TEXT, status TEXT, type TEXT, deleted_at TEXT);
        CREATE TABLE __change_log(id INTEGER PRIMARY KEY, table_name TEXT, sync_version INTEGER);
        INSERT INTO todo_items VALUES ('t', 0);
        INSERT INTO pomodoro_records VALUES ('t', 'completed', 'work', NULL);
        INSERT INTO note_learning_relations(id,note_id,relation_type,resource_id,locator_json)
        VALUES ('r','n','source','old','{"type":"whole"}');`);
      const apply = vi.spyOn(h.notes.sync!, 'applyRevision');
      const retarget = vi.spyOn(h.notes.sync!, 'retargetNoteRelations');
      const counts = vi.spyOn(h.vfsRepo.pomodoros, 'recomputeCompletedPomodorosForSyncBatch');
      const failure = new Error('later apply failure');
      expect(() => h.db.transaction(tx => {
        tx.savepoint(() => h.service.noteHistory.applyRevision(tx, 'v', revision));
        h.service.noteHistory.retargetNoteRelations(tx, 'n', 'old');
        h.service.pomodoroCounts.recomputeIfRelevant(tx, [
          { table_name: 'todo_items', record_id: 't', operation: 'Update', data: null, changed_at: 'now' },
          { table_name: 'pomodoro_records', record_id: 'p', operation: 'Update', data: null, changed_at: 'now' },
        ]);
        expect(apply).toHaveBeenCalledWith(tx, 'v', revision);
        expect(retarget).toHaveBeenCalledWith(tx, 'n', 'old');
        expect(counts).toHaveBeenCalledExactlyOnceWith(tx, ['todo_items', 'pomodoro_records']);
        expect(tx.pluck('SELECT completed_pomodoros FROM todo_items')).toBe(1);
        expect(tx.pluck('SELECT resource_id FROM note_learning_relations')).toBe('resource');
        expect(tx.pluck('SELECT COUNT(*) FROM note_document_revisions')).toBe(1);
        throw failure;
      }, { behavior: 'immediate' })).toThrow(failure);
      expect(h.db.pluck('SELECT completed_pomodoros FROM todo_items')).toBe(0);
      expect(h.db.pluck('SELECT resource_id FROM note_learning_relations')).toBe('old');
      expect(h.db.pluck('SELECT COUNT(*) FROM note_document_revisions')).toBe(0);
    } finally { vi.restoreAllMocks(); await h.dispose(); }
  });

  it('maps the owner recompute failure to the original single Database error prefix', async () => {
    const h = await serviceHost();
    try {
      h.db.exec(`CREATE TABLE todo_items(id TEXT PRIMARY KEY, completed_pomodoros INTEGER);
        CREATE TABLE pomodoro_records(todo_item_id TEXT, status TEXT, type TEXT, deleted_at TEXT);
        INSERT INTO todo_items VALUES ('t', 0);
        INSERT INTO pomodoro_records VALUES ('t', 'completed', 'work', NULL);
        CREATE TRIGGER forbid_count BEFORE UPDATE ON todo_items
        BEGIN SELECT RAISE(ABORT, 'count blocked'); END;`);
      expect(() => h.service.pomodoroCounts.recompute(h.db)).toThrow(
        'Database error: 重算 todo_items.completed_pomodoros 失败: count blocked',
      );
      expect(h.db.pluck('SELECT completed_pomodoros FROM todo_items')).toBe(0);
    } finally { await h.dispose(); }
  });

  it.each([false, true])('inferred format and remote snapshot share the caller transaction and roll back together (soft-deleted=%s)', async (softDeleted) => {
    const h = await serviceHost();
    try {
      h.db.exec(MINIMAL_NOTES_SCHEMA);
      seedNote(h.db, 'n', 'resource', 'body');
      const deletedAt = softDeleted ? '2026-11-04T00:00:00Z' : null;
      h.db.run('UPDATE notes SET deleted_at=? WHERE id=?', [deletedAt, 'n']);
      h.db.run(`UPDATE note_document_formats SET content_format='markdown-blocks', serializer_version='blocks-v1',
        baseline_version_id='baseline', updated_at='original' WHERE note_id='n'`);
      const infer = vi.spyOn(h.notes.sync!, 'updateInferredFormat');
      const failure = new Error('rollback snapshot');
      expect(() => h.db.transaction(tx => {
        h.service.noteHistory.snapshotNotes(tx, ['n'], 'remote_sync');
        expect(infer).toHaveBeenCalledExactlyOnceWith(tx, 'n');
        expect(tx.get('SELECT content_format,baseline_version_id,updated_at FROM note_document_formats')).toEqual({
          content_format: 'markdown-legacy', baseline_version_id: 'baseline', updated_at: '',
        });
        expect(tx.pluck('SELECT COUNT(*) FROM note_document_revisions')).toBe(1);
        expect(tx.get('SELECT note_id,content_md,source FROM note_document_revisions')).toEqual({
          note_id: 'n', content_md: 'body', source: 'remote_sync',
        });
        expect(tx.pluck('SELECT deleted_at FROM notes WHERE id=?', ['n'])).toBe(deletedAt);
        throw failure;
      }, { behavior: 'immediate' })).toThrow(failure);
      expect(h.db.pluck('SELECT updated_at FROM note_document_formats')).toBe('original');
      expect(h.db.pluck('SELECT COUNT(*) FROM note_document_revisions')).toBe(0);
      expect(h.db.pluck('SELECT deleted_at FROM notes WHERE id=?', ['n'])).toBe(deletedAt);
    } finally { vi.restoreAllMocks(); await h.dispose(); }
  });
});
