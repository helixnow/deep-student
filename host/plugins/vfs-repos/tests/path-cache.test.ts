import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { PathCacheEntry } from '../api.ts';
import plugin from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
const entry = (itemType: string, itemId: string, fullPath: string, folderPath: string): PathCacheEntry => ({
  itemType, itemId, fullPath, folderPath, updatedAt: '2024-01-01T00:00:00.000Z',
});
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'l11-path-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
  db.exec(`CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL,
    icon TEXT, color TEXT, is_expanded INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE folder_items (id TEXT PRIMARY KEY, folder_id TEXT, item_type TEXT NOT NULL,
      item_id TEXT NOT NULL, sort_order INTEGER DEFAULT 0, created_at INTEGER NOT NULL, cached_path TEXT);
    CREATE TABLE notes (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT NOT NULL,
      tags TEXT, is_favorite INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);`);
});
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
});
const repo = () => host.ctx.vfsRepo.pathCache;
describe('path_cache_repo.rs', () => {
  it('test_ensure_table_exists', () => {
    repo().ensureTableExists(db);
    expect(db.pluck("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='path_cache'")).toBe(1);
  });
  it('test_set_and_get_path', () => {
    repo().setPath(db, entry('note', 'note_abc123', '/高考复习/函数/note_abc123', '/高考复习/函数'));
    const cached = repo().getPath(db, 'note', 'note_abc123');
    expect(cached).not.toBeNull();
    expect(cached?.fullPath).toBe('/高考复习/函数/note_abc123');
    expect(cached?.folderPath).toBe('/高考复习/函数');
  });
  it('test_invalidate', () => {
    repo().setPath(db, entry('note', 'note_xyz', '/test/note_xyz', '/test'));
    expect(repo().getPath(db, 'note', 'note_xyz')).not.toBeNull();
    expect(repo().invalidate(db, 'note', 'note_xyz')).toBe(true);
    expect(repo().getPath(db, 'note', 'note_xyz')).toBeNull();
  });
  it('test_cache_miss', () => {
    expect(repo().getPath(db, 'note', 'nonexistent')).toBeNull();
  });
  it('test_get_by_full_path', () => {
    repo().setPath(db, entry('textbook', 'tb_123', '/教材/数学/tb_123', '/教材/数学'));
    const cached = repo().getByFullPath(db, '/教材/数学/tb_123');
    expect(cached).not.toBeNull();
    expect(cached?.itemType).toBe('textbook');
    expect(cached?.itemId).toBe('tb_123');
  });
  it('test_batch_set', () => {
    expect(repo().setPathsBatch(db, [entry('note', 'note_1', '/test/note_1', '/test'), entry('note', 'note_2', '/test/note_2', '/test')])).toBe(2);
    expect(repo().getPath(db, 'note', 'note_1')).not.toBeNull();
    expect(repo().getPath(db, 'note', 'note_2')).not.toBeNull();
  });
  it('test_stats', () => {
    repo().setPathsBatch(db, [entry('folder', 'fld_1', '/test', '/'), entry('note', 'note_1', '/test/note_1', '/test'), entry('textbook', 'tb_1', '/test/tb_1', '/test')]);
    expect(repo().getStats(db)).toEqual({ totalCount: 3, folderCount: 1, resourceCount: 2 });
  });
  it('keeps textbook write keys literal but canonicalizes read and invalidation keys', () => {
    repo().setPath(db, entry('textbook', 'tb', '/tb', '/'));
    expect(repo().getPath(db, 'textbook', 'tb')).toBeNull();
    expect(repo().invalidate(db, 'textbook', 'tb')).toBe(false);
    repo().setPath(db, entry('file', 'tb', '/canonical', '/'));
    expect(repo().getPath(db, 'textbook', 'tb')?.fullPath).toBe('/canonical');
    expect(repo().invalidate(db, 'textbook', 'tb')).toBe(true);
  });
  it('uses UTF-8 byte length; batch skips long paths and rolls back on failure', () => {
    expect(() => repo().setPath(db, entry('note', 'long', `/${'中'.repeat(334)}`, '/'))).toThrow("Invalid argument 'full_path': Path too long: 1003 chars (max 1000)");
    expect(repo().setPathsBatch(db, [entry('note', 'long', `/${'中'.repeat(334)}`, '/'), entry('note', 'ok', '/ok', '/')])).toBe(1);
    db.exec("CREATE TRIGGER reject_bad BEFORE INSERT ON path_cache WHEN NEW.item_id='bad' BEGIN SELECT RAISE(ABORT, 'bad entry'); END;");
    expect(() => repo().setPathsBatch(db, [entry('note', 'rollback', '/rollback', '/'), entry('note', 'bad', '/bad', '/')])).toThrow('bad entry');
    expect(repo().getPath(db, 'note', 'rollback')).toBeNull();
  });
  it('path prefix preserves SQL LIKE wildcards and folder recursion excludes deleted nodes', () => {
    db.exec("ALTER TABLE folder_items ADD COLUMN deleted_at TEXT;");
    db.exec("INSERT INTO folders VALUES ('root',NULL,'Root',NULL,NULL,1,0,'now','now',NULL), ('child','root','Child',NULL,NULL,1,0,'now','now',NULL), ('deleted','root','Deleted',NULL,NULL,1,0,'now','now','gone');");
    repo().setPathsBatch(db, [entry('folder', 'root', '/Root', '/'), entry('folder', 'child', '/Root/Child', '/Root'), entry('folder', 'deleted', '/Root/Deleted', '/Root')]);
    expect(repo().invalidateByFolder(db, 'root')).toBe(2);
    expect(repo().getPath(db, 'folder', 'deleted')).not.toBeNull();
    expect(repo().invalidateByPathPrefix(db, '/R_ot%')).toBe(1);
  });
  it('computes unknown folders and non-existent resources as Rust does', () => {
    db.exec('ALTER TABLE folder_items ADD COLUMN deleted_at TEXT;');
    expect(repo().getOrComputePath(db, 'folder', 'missing')).toMatchObject({ fullPath: '/', folderPath: '/' });
    expect(repo().getOrComputePath(db, 'note', 'missing')).toMatchObject({ fullPath: '/missing', folderPath: '/' });
  });
  it('rebuilds live resources only; full rebuild rolls back when a required table is absent', () => {
    db.exec(`ALTER TABLE folders ADD COLUMN is_favorite INTEGER DEFAULT 0;
      ALTER TABLE folder_items ADD COLUMN deleted_at TEXT;
      CREATE TABLE files(id TEXT PRIMARY KEY,file_name TEXT,deleted_at TEXT);
      CREATE TABLE exam_sheets(id TEXT PRIMARY KEY,exam_name TEXT,deleted_at TEXT);
      CREATE TABLE translations(id TEXT PRIMARY KEY,title TEXT,deleted_at TEXT);
      CREATE TABLE essays(id TEXT PRIMARY KEY,title TEXT,deleted_at TEXT);
      INSERT INTO folders VALUES ('f',NULL,'Folder',NULL,NULL,1,0,1000,1000,NULL,0);
      INSERT INTO notes VALUES ('live','r1','Live',NULL,0,'now','now',NULL), ('dead','r2','Dead',NULL,0,'now','now','gone');
      INSERT INTO folder_items VALUES ('i1','f','note','live',0,0,NULL,NULL), ('i2','f','note','dead',0,0,NULL,NULL);`);
    expect(repo().rebuildAll(db)).toBe(2);
    expect(repo().getPath(db, 'folder', 'f')).toMatchObject({ fullPath: '/Folder', folderPath: '/' });
    expect(repo().getPath(db, 'note', 'live')).toMatchObject({ fullPath: '/Folder/live', folderPath: '/Folder' });
    expect(repo().getPath(db, 'note', 'dead')).toBeNull();
    expect(repo().rebuildFolder(db, 'f')).toBe(2);
    db.exec('DROP TABLE essays');
    expect(() => repo().rebuildAll(db)).toThrow('no such table: essays');
    expect(repo().getStats(db).totalCount).toBe(2);
  });
  it('resolves persisted aliases scoped by table and reports read failures with Rust prefixes', () => {
    const aliases = host.ctx.vfsRepo.idAlias;
    expect(aliases.resolvePersistedIdAlias(db, 'files', 'a')).toBe('a');
    db.exec(`CREATE TABLE __sync_id_aliases(table_name TEXT,remote_id TEXT,canonical_id TEXT);
      INSERT INTO __sync_id_aliases VALUES ('files','a','b'), ('files','b','c'), ('notes','a','n');`);
    expect(aliases.resolvePersistedIdAlias(db, 'files', 'a')).toBe('c');
    expect(aliases.resolvePersistedIdAlias(db, 'notes', 'a')).toBe('n');
    db.exec("INSERT INTO __sync_id_aliases VALUES ('files','c','b')");
    expect(aliases.resolvePersistedIdAlias(db, 'files', 'a')).toBe('a');
    db.exec('ALTER TABLE __sync_id_aliases RENAME COLUMN canonical_id TO broken');
    expect(() => aliases.resolvePersistedIdAlias(db, 'files', 'a')).toThrow('读取 ID 别名失败:');
  });
});
