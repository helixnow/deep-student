import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteRevisionRepository as revisions, extractAssetRefs } from '../repository/revisions.ts';
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
    DELETE FROM note_document_revisions;
    DELETE FROM note_document_formats;
    DELETE FROM note_learning_relations;
    DELETE FROM note_links;
    DELETE FROM note_tags;
    DELETE FROM folder_items;
    DELETE FROM notes;
    DELETE FROM __lance_orphan_queue;
    DELETE FROM __change_log;
    DELETE FROM resources;
    PRAGMA foreign_keys=ON;`);
}, 30000);

function db(): SqlExecutor {
  return storage.database('vfs');
}

function create(content: string): VfsNote {
  return noteRepository.createNote({ title: '历史测试', content, tags: ['tag'] }, db());
}

function edit(note: VfsNote, content: string): VfsNote {
  return noteRepository.updateNote(note.id, { content, expectedUpdatedAt: note.updatedAt }, db());
}

function latest(note: VfsNote): NoteRevision {
  const page = revisions.list(db(), note.id, null, 1);
  return revisions.get(db(), note.id, page.items[0]!.version_id);
}

describe('note_revision_repo', () => {
  it('full_body_survives_resource_cleanup_and_copy_preserves_metadata', () => {
    const original = '# 完整\r\n\r\n![图](notes_assets/_global/old/image.png)\n\n未加载后缀\n\n';
    let note = create(original);
    note = noteRepository.updateNoteMetadata(note.id, {
      props: { 课程: '数学', done: false },
    }, db());
    const saved = latest(note);
    const originalResource = note.resourceId;
    const changed = edit(note, 'new');
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM resources WHERE id=?1', [originalResource])?.count)).toBe(0);
    const history = revisions.get(db(), note.id, saved.version_id);
    expect(history.content_md).toBe(original);
    expect(revisions.assetIsReferenced(db(), 'notes_assets/_global/old/image.png')).toBe(true);
    const copy = revisions.restoreCopy(db(), note.id, saved.version_id);
    expect(copy.id).not.toBe(note.id);
    expect(copy.tags).toEqual(note.tags);
    expect(copy.props).toEqual(note.props);
    expect(copy.title.startsWith(note.title)).toBe(true);
    expect(noteRepository.getNoteContent(copy.id, db())).toBe(original);
    expect(noteRepository.getNote(note.id, db())!.updatedAt).toBe(changed.updatedAt);
    const restored = latest(copy);
    expect(restored.restored_from_version_id).toBe(saved.version_id);
    expect(restored.source).toBe('restore_copy');
    expect(Number(db().get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM folder_items WHERE item_id=?1 AND deleted_at IS NULL", [copy.id])?.count)).toBe(1);
    expect(() => noteRepository.purgeNote(note.id, db())).toThrow();
  });

  it('noop_structural_props_empty_body_and_a_b_a_have_correct_identity', () => {
    let note = create('A');
    const a1 = latest(note);
    note = edit(note, 'A');
    expect(latest(note).version_id).toBe(a1.version_id);
    note = edit(note, 'B');
    const b = latest(note);
    revisions.getAndPin(db(), note.id, b.version_id);
    note = edit(note, 'A');
    expect(latest(note).version_id).not.toBe(a1.version_id);
    expect(revisions.get(db(), note.id, b.version_id).content_md).toBe('B');
    note = edit(note, '');
    expect(latest(note).content_md).toBe('');
    note = noteRepository.setNoteProps(note.id, { a: 1, b: false }, db());
    const id = latest(note).version_id;
    noteRepository.setNoteProps(note.id, { b: false, a: 1 }, db());
    expect(latest(note).version_id).toBe(id);
  });

  it('occ_and_history_failure_roll_back_body_metadata_and_resources', () => {
    const old = create('old');
    const current = edit(old, 'current');
    const version = latest(current).version_id;
    expect(() => noteRepository.updateNote(old.id, {
      content: 'stale', expectedUpdatedAt: old.updatedAt,
    }, db())).toThrow();
    db().exec("CREATE TRIGGER fail_history BEFORE INSERT ON note_document_revisions BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    try {
      expect(() => noteRepository.updateNote(current.id, { content: 'failed' }, db())).toThrow();
      expect(() => noteRepository.updateNoteMetadata(current.id, {
        title: 'failed title', props: { a: 2 },
      }, db())).toThrow();
      const actual = noteRepository.getNote(current.id, db())!;
      expect(actual.updatedAt).toBe(current.updatedAt);
      expect(actual.title).toBe(current.title);
      expect(actual.resourceId).toBe(current.resourceId);
      expect(latest(current).version_id).toBe(version);
      expect(noteRepository.getNoteContent(current.id, db())).toBe('current');
    } finally {
      db().exec('DROP TRIGGER fail_history');
    }
  });

  it('legacy_baseline_is_captured_before_first_write_and_pagination_is_stable', () => {
    const note = create('legacy');
    db().run('DELETE FROM note_document_revisions WHERE note_id=?1', [note.id]);
    const edited = edit(note, 'updated');
    const first = revisions.list(db(), edited.id, null, 1);
    expect(first.items[0]!.source).toBe('edit');
    const second = revisions.list(db(), edited.id, first.next_cursor, 1);
    expect(second.items[0]!.source).toBe('baseline');
    expect(revisions.get(db(), edited.id, second.items[0]!.version_id).content_md).toBe('legacy');
    expect(second.next_cursor).toBeNull();
    const other = create('other');
    expect(() => revisions.restoreCopy(db(), other.id, first.items[0]!.version_id)).toThrow();
  });

  it('edits_coalesce_without_mutation_and_budget_preserves_pins', () => {
    let note = create('0');
    note = edit(note, '1');
    const first = latest(note);
    revisions.getAndPin(db(), note.id, first.version_id);
    for (let index = 2; index < 107; index += 1) {
      db().run('UPDATE note_document_revisions SET edit_bucket=-1 WHERE note_id=?1', [note.id]);
      note = edit(note, String(index));
    }
    const count = () => Number(db().get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM note_document_revisions WHERE note_id=?1 AND source='edit' AND pinned=0",
      [note.id])?.count ?? 0);
    expect(count()).toBe(100);
    expect(revisions.get(db(), note.id, first.version_id).content_md).toBe('1');
    note = edit(note, 'next');
    expect(latest(note).content_md).toBe('next');
    expect(count()).toBe(100);
  });

  it('full_sqlite_backup_restores_history_and_local_classification', async () => {
    const note = create('persist across reopen\n\n');
    const revision = latest(note);
    const backup = join(host.app.dataDir, 'history-backup.db');
    await storage.database('vfs').backupTo(backup);
    const restored = storage.openFile(backup, { profile: 'vfs' });
    try {
      expect(revisions.get(restored, note.id, revision.version_id).content_md).toBe('persist across reopen\n\n');
    } finally {
      storage.close(restored);
    }
  });

  it('asset_manifest_distinguishes_owned_and_external_references', () => {
    const refs = extractAssetRefs(
      '![x](notes_assets/_global/n/a%20b.png) <img src="notes_assets/_global/n/a b.png"> [pdf](pdfref://file_123?page=4) [web](https://example.test/x)');
    expect(refs.some((ref) => ref.kind === 'notes_asset' && ref.value === 'notes_assets/_global/n/a b.png')).toBe(true);
    expect(refs.some((ref) => ref.kind === 'external_resource' && ref.value === 'pdfref://file_123?page=4')).toBe(true);
    expect(refs.some((ref) => ref.kind === 'remote_url')).toBe(true);
  });

  it('preview_is_read_only_and_a_pruned_restore_target_never_falls_back', () => {
    let note = create('initial');
    note = edit(note, 'previewed edit');
    const preview = latest(note);
    expect(preview.pinned).toBe(false);
    expect(revisions.listFiltered(db(), note.id, null, 30, true).items).toHaveLength(0);
    db().run('DELETE FROM note_document_revisions WHERE version_id=?1', [preview.version_id]);
    expect(() => revisions.restoreCopy(db(), note.id, preview.version_id)).toThrow();
    expect(() => revisions.setPinned(db(), note.id, preview.version_id, true)).toThrow();
    expect(Number(db().get<{ count: number }>('SELECT COUNT(*) AS count FROM notes')?.count)).toBe(1);
    expect(noteRepository.getNoteContent(note.id, db())).toBe('previewed edit');
    noteRepository.purgeNote(note.id, db());
  });

  it('explicit_release_preserves_body_assets_and_restore_protection_until_user_releases_it', () => {
    const path = 'notes_assets/_global/original/retained.png';
    let note = create(`![image](${path})`);
    const target = latest(note);
    revisions.getAndPin(db(), note.id, target.version_id);
    note = edit(note, 'current body');
    const current = latest(note);
    const released = revisions.setPinned(db(), note.id, target.version_id, false);
    expect(released.pinned).toBe(false);
    expect(revisions.get(db(), note.id, target.version_id).content_md).toBe(target.content_md);
    expect(revisions.assetIsReferenced(db(), path)).toBe(true);
    const copy = revisions.restoreCopy(db(), note.id, target.version_id);
    expect(revisions.get(db(), note.id, target.version_id).pinned).toBe(true);
    expect(revisions.get(db(), note.id, current.version_id).pinned).toBe(true);
    revisions.setPinned(db(), note.id, target.version_id, false);
    expect(() => noteRepository.purgeNote(note.id, db())).toThrow();
    noteRepository.deleteNote(note.id, db());
    revisions.setPinned(db(), note.id, current.version_id, false);
    expect(revisions.listFiltered(db(), note.id, null, 30, true).items).toHaveLength(0);
    noteRepository.purgeNote(note.id, db());
    expect(noteRepository.getNoteContent(copy.id, db())).toBe(target.content_md);
    expect(revisions.assetIsReferenced(db(), path)).toBe(true);
  });

  it('retained_filter_finds_older_pins_and_release_is_scoped_to_the_note', () => {
    let note = create('first');
    const first = latest(note);
    revisions.setPinned(db(), note.id, first.version_id, true);
    note = edit(note, 'second');
    const second = latest(note);
    revisions.setPinned(db(), note.id, second.version_id, true);
    for (let index = 0; index < 35; index += 1) {
      note = noteRepository.updateNoteMetadata(note.id, { title: `title ${index}` }, db());
    }
    expect(revisions.list(db(), note.id, null, 30).items.every((item) => !item.pinned)).toBe(true);
    let page = revisions.listFiltered(db(), note.id, null, 1, true);
    expect(page.items[0]!.version_id).toBe(second.version_id);
    page = revisions.listFiltered(db(), note.id, page.next_cursor, 1, true);
    expect(page.items[0]!.version_id).toBe(first.version_id);
    expect(page.next_cursor).toBeNull();
    const other = create('other');
    expect(() => revisions.setPinned(db(), other.id, first.version_id, false)).toThrow();
    expect(revisions.get(db(), note.id, first.version_id).pinned).toBe(true);
  });
});
