import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';
import { configureNotesRepository } from '../repository/notes.ts';
import { listNotesReferencing } from '../repository/relations.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';


type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;
let host: Host;
let storage: Storage;

beforeAll(async () => {
  host = await createTestHost();
  const root = mkdtempSync(join(host.app.dataDir, 'notes-referencing-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
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
  database.exec(`DELETE FROM note_learning_relations; DELETE FROM notes; DELETE FROM resources;`);
}, 30000);

function db(): SqlExecutor {
  return storage.database('vfs');
}

describe('referencing resource tests', () => {
  it('finds_notes_by_origin_and_relation_without_prefix_collisions', () => {
    db().exec(`
      INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at) VALUES
        ('res_n1','hash_n1','note','inline','a',1,0,0),
        ('res_n2','hash_n2','note','inline','b',1,0,0),
        ('res_n3','hash_n3','note','inline','c',1,0,0),
        ('res_n4','hash_n4','note','inline','d',1,0,0);
      INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props) VALUES
        ('n1','res_n1','摘录','[]',0,'2026-10-02','2026-10-02',NULL,'{"_origin":"{\\"kind\\":\\"resource\\",\\"resourceId\\":\\"file_a\\",\\"page\\":3}"}'),
        ('n2','res_n2','关联','[]',0,'2026-10-01','2026-10-01',NULL,NULL),
        ('n3','res_n3','已删','[]',0,'2026-10-03','2026-10-03','2026-10-03','{"_origin":"{\\"kind\\":\\"resource\\",\\"resourceId\\":\\"file_a\\"}"}'),
        ('n4','res_n4','别的','[]',0,'2026-10-04','2026-10-04',NULL,'{"_origin":"{\\"kind\\":\\"resource\\",\\"resourceId\\":\\"file_ab\\"}"}');
      INSERT INTO note_learning_relations (id, note_id, relation_type, resource_id, locator_json, revision, created_at, updated_at)
        VALUES ('r1','n2','source','res_a','{"type":"whole"}',1,'2026-10-01','2026-10-01');
    `);
    const notes = listNotesReferencing(db(), ['file_a', 'res_a']);
    expect(notes.map((note) => [note.noteId, note.via])).toEqual([
      ['n1', 'origin'],
      ['n2', 'relation'],
    ]);
  });
});
