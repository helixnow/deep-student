import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteRevisionRepository as revisions } from '../repository/revisions.ts';
import type { NoteRevision, VfsNote } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';


type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;

beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  }));
  // R5 N4: real L11 vfsRepo wired by the production notes plugin, not a test copy of L11 SQL.
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

beforeEach(() => {
  const database = storage.database('vfs');
  database.exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions; DELETE FROM note_document_formats;
    DELETE FROM note_learning_relations; DELETE FROM note_links; DELETE FROM note_tags;
    DELETE FROM folder_items; DELETE FROM notes; DELETE FROM __lance_orphan_queue;
    DELETE FROM __change_log; DELETE FROM resources; PRAGMA foreign_keys=ON;`);
  database.run("UPDATE note_history_retention SET edit_bucket_seconds=300, max_edit_versions=100, updated_at='' WHERE id=1");
}, 30000);

function db(): SqlExecutor { return storage.database('vfs'); }
function create(content: string): VfsNote {
  return noteRepository.createNote({ title: 'History integration', content, tags: ['original'] }, db());
}
function head(id: string): NoteRevision {
  const page = revisions.list(db(), id, null, 1);
  return revisions.get(db(), id, page.items[0]!.version_id);
}
function edit(note: VfsNote, content: string): VfsNote {
  return noteRepository.updateNote(note.id, { content, expectedUpdatedAt: note.updatedAt }, db());
}

describe('note_history_integration_tests', () => {
  it('current_restore_cas_preserves_live_and_source_and_restores_full_envelope', () => {
    const original = create('# Before\n\nOriginal\n');
    const source = head(original.id);
    let current = edit(original, 'Current ![](notes_assets/_global/current/a.png)');
    const live = head(current.id);
    current = noteRepository.updateNoteMetadata(current.id, { props: { a: 'changed' } }, db());
    const stored = revisions.current(db(), current.id);
    expect(stored.updated_at).toBe(current.updatedAt);
    expect(stored.title).toBe(current.title);
    expect(stored.content_md.startsWith('Current')).toBe(true);
    expect(() => revisions.restoreCurrent(db(), current.id, source.version_id, original.updatedAt, null)).toThrow();
    expect(revisions.get(db(), current.id, source.version_id).pinned).toBe(false);

    const restored = revisions.restoreCurrent(db(), current.id, source.version_id, current.updatedAt, null);
    expect(restored.updatedAt).not.toBe(current.updatedAt);
    expect(restored.props).toBeNull();
    expect(revisions.current(db(), current.id).content_md).toBe(source.content_md);
    expect(revisions.get(db(), current.id, source.version_id).pinned).toBe(true);
    expect(revisions.listFiltered(db(), current.id, null, 100, true).items
      .some((row) => row.version_id !== source.version_id)).toBe(true);
    expect(head(current.id).restored_from_version_id).toBe(source.version_id);
    expect(revisions.assetIsReferenced(db(), 'notes_assets/_global/current/a.png')).toBe(true);
    expect(revisions.get(db(), current.id, live.version_id).restored_from_version_id).toBeNull();
  });

  it('selection_rejects_partial_code_list_and_markers_and_copies_complete_nodes', () => {
    const note = create('# Heading\n\n```rust\nlet x = 1;\n```\n\n- one\n- two\n');
    const version = head(note.id);
    for (const [start, end] of [[4, 4], [7, 7]] as const) {
      expect(() => revisions.restoreSelectionCopy(db(), note.id, version.version_id, { start_line: start, end_line: end })).toThrow();
    }
    const copy = revisions.restoreSelectionCopy(db(), note.id, version.version_id, { start_line: 3, end_line: 5 });
    expect(revisions.current(db(), copy.id).content_md).toBe('```rust\nlet x = 1;\n```');
    expect(revisions.current(db(), note.id).content_md).toBe(version.content_md);

    const stable = create('<!-- ds:block-id=a -->\n\nParagraph\n');
    const stableVersion = head(stable.id);
    expect(() => revisions.selectedContent(stableVersion, { start_line: 3, end_line: 3 })).toThrow();
    expect(revisions.selectedContent(stableVersion, { start_line: 1, end_line: 3 }))
      .toBe('<!-- ds:block-id=a -->\n\nParagraph');
  });

  it('selected_restore_replaces_whole_current_body_and_failed_history_rolls_back_everything', () => {
    const note = create('First\n\nSecond\n');
    const source = head(note.id);
    const current = edit(note, 'Live');
    const result = revisions.restoreCurrent(db(), note.id, source.version_id, current.updatedAt, {
      start_line: 3, end_line: 3,
    });
    expect(revisions.current(db(), note.id).content_md).toBe('Second');
    const count = Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_document_revisions')?.count);
    db().exec("CREATE TRIGGER fail_restore BEFORE INSERT ON note_document_revisions WHEN NEW.source='restore_current' BEGIN SELECT RAISE(ABORT,'restore failed'); END");
    try {
      expect(() => revisions.restoreCurrent(db(), note.id, source.version_id, result.updatedAt, null)).toThrow();
      const actual = revisions.current(db(), note.id);
      expect(actual.content_md).toBe('Second');
      expect(actual.updated_at).toBe(result.updatedAt);
      expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM note_document_revisions')?.count)).toBe(count);
    } finally {
      db().exec('DROP TRIGGER fail_restore');
    }
  });

  it('v20260923_backfills_existing_versions_by_identity_and_logs_only_immutable_inserts', () => {
    const database = storage.openFile(':memory:', { profile: 'plain' });
    try {
      database.exec(`CREATE TABLE note_document_revisions(seq INTEGER PRIMARY KEY,version_id TEXT,note_id TEXT,pinned INTEGER);
        CREATE TABLE note_document_formats(note_id TEXT PRIMARY KEY,updated_at TEXT);
        CREATE TABLE __change_log(id INTEGER PRIMARY KEY,table_name TEXT,record_id TEXT,operation TEXT,sync_version INTEGER DEFAULT 0);
        INSERT INTO note_document_revisions VALUES(1,'nrev_old','note_a',0);
        INSERT INTO note_document_formats VALUES('note_a','old');`);
      const sql = readFileSync(new URL('../../../../resources/app/migrations/vfs/V20260923__note_history_integration.sql', import.meta.url), 'utf8');
      database.exec(sql);
      database.exec(sql);
      expect(Number(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM __change_log WHERE record_id='nrev_old'")?.count)).toBe(1);
      database.run("INSERT INTO note_document_revisions VALUES(2,'nrev_new','note_a',0)");
      database.run("UPDATE note_document_revisions SET pinned=1 WHERE version_id='nrev_new'");
      database.run("DELETE FROM note_document_revisions WHERE version_id='nrev_new'");
      expect(Number(database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM __change_log WHERE table_name='note_document_revisions' AND record_id='nrev_new' AND operation='INSERT'")?.count)).toBe(1);
      expect(Number(database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM __change_log WHERE table_name='note_document_revisions' AND operation!='INSERT'")?.count)).toBe(0);
      database.run("UPDATE note_document_formats SET updated_at='new' WHERE note_id='note_a'");
      expect(Number(database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM __change_log WHERE table_name='note_document_formats' AND operation='UPDATE'")?.count)).toBe(1);
    } finally {
      storage.close(database);
    }
  });

  it('retention_is_persistent_deferred_and_controls_coalescing_and_budget', () => {
    expect(revisions.getRetention(db())).toEqual({ edit_bucket_seconds: 300, max_edit_versions: 100 });
    const policy = { edit_bucket_seconds: 0, max_edit_versions: null };
    revisions.setRetention(db(), policy);
    const other = storage.database('vfs');
    expect(revisions.getRetention(other)).toEqual(policy);
    let note = create('zero');
    for (let index = 1; index < 5; index += 1) note = edit(note, `body ${index}`);
    expect(revisions.list(db(), note.id, null, 100).items).toHaveLength(5);
    const keep = head(note.id).version_id;
    revisions.setPinned(db(), note.id, keep, true);
    revisions.setRetention(db(), { edit_bucket_seconds: 0, max_edit_versions: 1 });
    expect(revisions.list(db(), note.id, null, 100).items).toHaveLength(5);
    note = edit(note, 'next');
    expect(revisions.list(db(), note.id, null, 100).items).toHaveLength(3);
    revisions.setRetention(db(), { edit_bucket_seconds: 86400, max_edit_versions: null });
    note = edit(note, 'coalesced one');
    const first = head(note.id).version_id;
    note = edit(note, 'coalesced two');
    expect(() => revisions.get(db(), note.id, first)).toThrow();
    expect(Number(db().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM __change_log c WHERE c.table_name='note_document_revisions'
       AND COALESCE(c.sync_version,0)=0 AND NOT EXISTS(SELECT 1 FROM note_document_revisions r WHERE r.version_id=c.record_id)`)?.count)).toBe(0);
    expect(revisions.get(db(), note.id, keep).pinned).toBe(true);
  });
});
