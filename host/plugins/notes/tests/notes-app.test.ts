import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import paths from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { configureNotesRepository, noteRepository } from '../repository/notes.ts';
import { noteRevisionRepository as revisions } from '../repository/revisions.ts';
import { notesAssetIsReferenced } from '../repository/asset-retention.ts';
import {
  finishAssetDeletionWithConn, prepareAssetDeletionWithConn,
} from '../../../platform/storage/file-deletion-queue.ts';
import { importNotes } from '../repository/exporter.ts';
import { buildZip } from './zip-fixture.ts';
import type { NoteRevision } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { VfsNote } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';


type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;
let settings: SettingsStore;

beforeAll(async () => {
  host = await createTestHost();
  const root = mkdtempSync(join(host.app.dataDir, 'notes-app-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  await storage.migrations.runAll();
  settings = createSettingsStore({
    db: () => storage.database('mistakes'),
    secureStore: () => null,
    isSensitiveKey: () => false,
  });
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', settings);
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
    DELETE FROM folder_items;
    DELETE FROM notes;
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
  return noteRepository.updateNote(note.id, {
    content, expectedUpdatedAt: note.updatedAt,
  }, db());
}

function latest(note: VfsNote): NoteRevision {
  const page = revisions.list(db(), note.id, null, 1);
  return revisions.get(db(), note.id, page.items[0]!.version_id);
}

describe('note history app tests', () => {
  it('history_trash_and_shared_asset_references_guard_journal_deletion', () => {
    const base = storage.locations.activeDir;
    const path = 'notes_assets/_global/original/image.png';
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), 'image bytes');
    const key = `active/${path}`;
    const conn = db();

    // A prepared intent from before a restore/save is cancelled during recovery.
    const prepared = prepareAssetDeletionWithConn(conn, base, key, path);
    const quarantine = join(base, `${path}.deleting-${prepared.operation_id}`);
    renameSync(join(base, path), quarantine);
    let note = create(`![img](${path})`);
    finishAssetDeletionWithConn(conn, base, prepared);
    expect(existsSync(join(base, path))).toBe(true);

    note = edit(note, 'removed image');
    // The removed image survives in the pinned baseline history.
    expect(notesAssetIsReferenced(db(), path)).toBe(true);
    expect(() => prepareAssetDeletionWithConn(conn, base, key, path))
      .toThrow(expect.objectContaining({ code: 'ReferencedNoteAsset' }));

    noteRepository.deleteNote(note.id, db());
    expect(notesAssetIsReferenced(db(), path)).toBe(true);

    const shared = create(`![shared](${path})`);
    noteRepository.purgeNote(note.id, db());
    expect(notesAssetIsReferenced(db(), path)).toBe(true);
    expect(() => prepareAssetDeletionWithConn(conn, base, key, path))
      .toThrow(expect.objectContaining({ code: 'ReferencedNoteAsset' }));

    noteRepository.purgeNote(shared.id, db());
    expect(notesAssetIsReferenced(db(), path)).toBe(false);
    const allowed = prepareAssetDeletionWithConn(conn, base, key, path);
    finishAssetDeletionWithConn(conn, base, allowed);
    expect(existsSync(join(base, path))).toBe(false);
  });

  it('zip_overwrite_captures_body_and_writes_fresh_assets_without_overwriting_history_bytes', async () => {
    const base = storage.locations.activeDir;
    const originalPath = 'notes_assets/_global/original/image.png';
    const note = create(`![original](${originalPath})`);
    const saved = latest(note);
    mkdirSync(dirname(join(base, originalPath)), { recursive: true });
    writeFileSync(join(base, originalPath), 'original image');

    const archive = join(base, 'import.zip');
    writeFileSync(archive, buildZip([
      {
        name: 'markdown/imported.md',
        bytes: new TextEncoder().encode(
          `---\nid: ${note.id}\ntitle: Imported\n---\n\n![imported](${originalPath})`),
      },
      {
        name: 'assets/_global/original/image.png',
        bytes: new TextEncoder().encode('imported image'),
      },
    ]));

    const result = await importNotes({
      conn: db(), settings, baseDir: base, filePath: archive, conflictStrategy: 'overwrite',
    });
    expect(result.overwritten_count).toBe(1);
    expect(readFileSync(join(base, originalPath))).toEqual(Buffer.from('original image'));
    expect(revisions.get(db(), note.id, saved.version_id).content_md).toBe(saved.content_md);

    const imported = latest(note);
    const asset = imported.asset_refs.find((ref) => ref.kind === 'notes_asset');
    expect(asset).toBeDefined();
    expect(asset!.value).not.toBe(originalPath);
    expect(readFileSync(join(base, asset!.value))).toEqual(Buffer.from('imported image'));
  }, 120000);
});
