import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { CURRENT_SCHEMA_VERSION, type VfsDatabase } from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';

describe('vfs/database.rs', { timeout: 60_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let db: VfsDatabase;
  let conn: DatabaseHandle;
  let template: string;
  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-database-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
    db = host.ctx.vfsDatabase;
    conn = db.getConn();
  }, 60_000);
  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);
  const folder = (id: string, parent: string | null, title: string) => conn.run(
    'INSERT INTO folders (id,parent_id,title,is_expanded,sort_order,created_at,updated_at) VALUES (?1,?2,?3,1,0,?4,?4)',
    [id, parent, title, Date.now()],
  );
  const item = (id: string, folderId: string | null, itemId: string, type = 'note', sort = 0, cached: string | null = null) => conn.run(
    'INSERT INTO folder_items (id,folder_id,item_type,item_id,sort_order,created_at,cached_path) VALUES (?1,?2,?3,?4,?5,?6,?7)',
    [id, folderId, type, itemId, sort, Date.now(), cached],
  );
  const exists = (type: string, name: string) => conn.pluck<number>('SELECT COUNT(*) FROM sqlite_master WHERE type=?1 AND name=?2', [type, name]);
  it('test_database_creation', () => {
    const file = path.join(storage.locations.activeDir, 'databases', 'vfs.db');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(storage.locations.activeDir, 'vfs_blobs'))).toBe(true);
    expect(db.dbPath()).toBe(file);
  });
  it('test_current_schema_version_in_sync', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(Math.max(...fs.readdirSync('resources/app/migrations/vfs').map(f => Number(/^V(\d+)__/.exec(f)?.[1] ?? 0))));
  });
  it('test_migrations_idempotent', async () => {
    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    await db.reinitialize();
    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });
  it('test_foreign_keys_enabled', () => expect(db.isForeignKeysEnabled()).toBe(true));
  it('test_get_connection', () => {
    expect(db.getConn().pluck('SELECT 1')).toBe(1);
    expect(db.getConn().pluck('SELECT 1')).toBe(1);
  });
  it('test_get_statistics', () => expect(db.getStatistics()).toEqual({
    resource_count: 0, note_count: 0, textbook_count: 0, exam_count: 0,
    translation_count: 0, essay_count: 0, blob_count: 0, schema_version: CURRENT_SCHEMA_VERSION,
  }));
  it('test_tables_created', () => {
    for (const table of ['resources', 'notes', 'files', 'exam_sheets', 'translations', 'essays', 'blobs', 'folders', 'folder_items']) {
      expect(exists('table', table), table).toBe(1);
    }
  });
  it('test_folders_table_created', () => {
    folder('fld_root1', null, '数学笔记');
    expect(conn.pluck('SELECT COUNT(*) FROM folders')).toBe(1);
    expect(conn.pluck("SELECT title FROM folders WHERE id = 'fld_root1'")).toBe('数学笔记');
  });
  it('test_folder_items_table_created', () => {
    folder('fld_test', null, '测试文件夹');
    item('fi_1', 'fld_test', 'note_abc123');
    expect(conn.pluck('SELECT COUNT(*) FROM folder_items')).toBe(1);
  });
  it('test_folders_parent_cascade_delete', () => {
    folder('fld_parent', null, '父文件夹');
    folder('fld_child', 'fld_parent', '子文件夹');
    folder('fld_grandchild', 'fld_child', '孙文件夹');
    expect(conn.pluck('SELECT COUNT(*) FROM folders')).toBe(3);
    conn.run("DELETE FROM folders WHERE id = 'fld_parent'");
    expect(conn.pluck('SELECT COUNT(*) FROM folders')).toBe(0);
  });
  it('test_folder_items_folder_set_null', () => {
    folder('fld_test', null, '测试文件夹');
    item('fi_1', 'fld_test', 'note_abc');
    expect(conn.pluck("SELECT folder_id FROM folder_items WHERE id = 'fi_1'")).toBe('fld_test');
    conn.run("DELETE FROM folders WHERE id = 'fld_test'");
    expect(conn.pluck("SELECT folder_id FROM folder_items WHERE id = 'fi_1'")).toBeNull();
    expect(conn.pluck('SELECT COUNT(*) FROM folder_items')).toBe(1);
  });
  it('test_folder_items_unique_constraint', () => {
    item('fi_1', null, 'note_abc');
    expect(() => item('fi_2', null, 'note_abc', 'note', 1)).toThrow();
  });
  it('test_folders_indexes_created', () => {
    for (const idx of ['idx_folders_parent', 'idx_folders_sort', 'idx_folders_deleted', 'idx_folder_items_item_active_unique', 'idx_folder_items_folder', 'idx_folder_items_type_id']) expect(exists('index', idx), idx).toBe(1);
  });
  it('test_hash_unique_constraint', () => {
    conn.run("INSERT INTO resources (id,hash,type,storage_mode,data,ref_count,created_at,updated_at) VALUES ('res_1','hash_123','note','inline','content',0,1234567890,1234567890)");
    expect(() => conn.run("INSERT INTO resources (id,hash,type,storage_mode,data,ref_count,created_at,updated_at) VALUES ('res_2','hash_123','note','inline','content2',0,1234567890,1234567890)")).toThrow();
  });
  it('test_resources_no_subject', () => {
    for (const [id, hash, type, content] of [['res_1', 'hash_1', 'note', 'math content'], ['res_2', 'hash_2', 'note', 'physics content'], ['res_3', 'hash_3', 'translation', 'translation content']] as const) {
      conn.run("INSERT INTO resources (id,hash,type,storage_mode,data,ref_count,created_at,updated_at) VALUES (?1,?2,?3,'inline',?4,0,1234567890,1234567890)", [id, hash, type, content]);
    }
    expect(conn.pluck('SELECT COUNT(*) FROM resources')).toBe(3);
  });
  it('test_migration_005_cached_path_column', () => {
    expect(conn.pluck("SELECT COUNT(*) FROM pragma_table_info('folder_items') WHERE name = 'cached_path'")).toBe(1);
    expect(exists('index', 'idx_folder_items_path')).toBe(1);
  });
  it('test_migration_005_cached_path_nullable', () => {
    folder('fld_test', null, '测试文件夹');
    item('fi_1', 'fld_test', 'note_abc123');
    expect(conn.pluck("SELECT cached_path FROM folder_items WHERE id = 'fi_1'")).toBeNull();
    conn.run("UPDATE folder_items SET cached_path = '/测试文件夹/笔记标题' WHERE id = 'fi_1'");
    expect(conn.pluck("SELECT cached_path FROM folder_items WHERE id = 'fi_1'")).toBe('/测试文件夹/笔记标题');
  });
  it('test_migration_005_path_index_query', () => {
    folder('fld_root', null, '根文件夹');
    item('fi_1', 'fld_root', 'note_1', 'note', 0, '/根文件夹/笔记1');
    item('fi_2', 'fld_root', 'note_2', 'note', 1, '/根文件夹/笔记2');
    item('fi_3', 'fld_root', 'tb_1', 'textbook', 2, '/根文件夹/教材');
    expect(conn.pluck("SELECT COUNT(*) FROM folder_items WHERE cached_path LIKE '/根文件夹/%'")).toBe(3);
    expect(conn.pluck("SELECT item_id FROM folder_items WHERE cached_path = '/根文件夹/笔记1'")).toBe('note_1');
  });
  it('test_migration_011_subject_columns_removed', () => {
    for (const table of ['folders', 'folder_items', 'resources']) expect(conn.pluck(`SELECT COUNT(*) FROM pragma_table_info('${table}') WHERE name = 'subject'`)).toBe(0);
  });
  it('test_migration_009_path_cache_table', () => {
    expect(exists('table', 'path_cache')).toBe(1);
    const columns = conn.all<{ name: string }>("SELECT name FROM pragma_table_info('path_cache')").map(c => c.name);
    for (const name of ['item_type', 'item_id', 'full_path', 'folder_path', 'updated_at']) expect(columns).toContain(name);
    expect(exists('index', 'idx_path_cache_path')).toBe(1);
    expect(exists('index', 'idx_path_cache_folder')).toBe(1);
  });
  it('test_migration_011_indexes', () => {
    for (const idx of ['idx_folders_parent', 'idx_folders_sort', 'idx_folders_deleted', 'idx_folder_items_folder', 'idx_folder_items_type_id']) expect(exists('index', idx)).toBe(1);
    for (const idx of ['idx_folders_subject', 'idx_folder_items_subject', 'idx_folder_items_unique_v2']) expect(exists('index', idx)).toBe(0);
  });
  it('test_migration_011_folders_without_subject', () => {
    folder('fld_test', null, '测试文件夹');
    expect(conn.pluck("SELECT title FROM folders WHERE id = 'fld_test'")).toBe('测试文件夹');
  });
  it('test_migration_009_path_cache_crud', () => {
    conn.run("INSERT INTO path_cache (item_type,item_id,full_path,folder_path,updated_at) VALUES ('note','note_abc123','/高考复习/函数/note_abc123','/高考复习/函数',datetime('now'))");
    expect(conn.pluck("SELECT full_path FROM path_cache WHERE item_type='note' AND item_id='note_abc123'")).toBe('/高考复习/函数/note_abc123');
    conn.run("UPDATE path_cache SET full_path='/新位置/note_abc123',folder_path='/新位置' WHERE item_type='note' AND item_id='note_abc123'");
    expect(conn.pluck("SELECT full_path FROM path_cache WHERE item_type='note' AND item_id='note_abc123'")).toBe('/新位置/note_abc123');
    conn.run("DELETE FROM path_cache WHERE item_type='note' AND item_id='note_abc123'");
    expect(conn.pluck("SELECT COUNT(*) FROM path_cache WHERE item_type='note' AND item_id='note_abc123'")).toBe(0);
  });
  it('test_migration_011_folder_items_unique_constraint', () => {
    item('fi_1', null, 'note_abc');
    expect(() => item('fi_2', null, 'note_abc', 'note', 1)).toThrow();
  });
  it('test_migration_011_idempotent', async () => {
    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    await db.reinitialize();
    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.getConn().pluck("SELECT COUNT(*) FROM pragma_table_info('folders') WHERE name = 'subject'")).toBe(0);
  });
  it('maintenance blocks borrowing and preserves data after reopening', async () => {
    folder('fld_keep', null, '保留');
    await db.enterMaintenanceMode();
    expect(db.isInMaintenanceMode()).toBe(true);
    expect(() => db.getConn()).toThrow('MAINTENANCE_MODE: vfs is temporarily unavailable');
    expect(() => db.getConnSafe()).toThrow('MAINTENANCE_MODE: vfs is temporarily unavailable');
    await expect(db.enterMaintenanceMode()).rejects.toThrow('VFS 已处于数据治理维护模式');
    await expect(db.reinitialize()).rejects.toThrow('MAINTENANCE_MODE');
    await db.exitMaintenanceMode();
    expect(db.getConn().pluck("SELECT title FROM folders WHERE id='fld_keep'")).toBe('保留');
  });
  it('dstu_parse_path preserves the command-specific inference and null fields', async () => {
    await expect(host.invoke('dstu_parse_path', { path: '' })).resolves.toEqual({ fullPath: '/', folderPath: null, resourceId: null, resourceType: null, isRoot: true, isVirtual: false });
    for (const id of ['tb_book', 'att_file', 'file_doc']) {
      await expect(host.invoke('dstu_parse_path', { path: `资料/${id}///` })).resolves.toEqual({
        fullPath: `/资料/${id}`, folderPath: '/资料', resourceId: id, resourceType: 'file', isRoot: false, isVirtual: false,
      });
    }
    await expect(host.invoke('dstu_parse_path', { path: '/@unknown/sub' })).resolves.toMatchObject({ isVirtual: true, resourceType: null });
    await expect(host.invoke('dstu_parse_path', { path: '/img_a' })).resolves.toMatchObject({ folderPath: '/img_a', resourceId: null });
    await expect(host.invoke('dstu_parse_path', { path: `/note_${'a'.repeat(500)}` })).resolves.toMatchObject({ resourceType: 'note' });
    await expect(host.invoke('dstu_parse_path', { path: ' /数学/ ' })).resolves.toMatchObject({ fullPath: '/ /数学/ ' });
    await expect(host.invoke('dstu_parse_path', {})).rejects.toBe('invalid args `path` for command `dstu_parse_path`: command dstu_parse_path missing required key path');
  });
  it('dstu_watch and dstu_unwatch mirror Rust log-only handlers', async () => {
    await expect(host.invoke('dstu_watch', { path: '/数学' })).resolves.toBeNull();
    await expect(host.invoke('dstu_unwatch', { path: '/数学' })).resolves.toBeNull();
    expect(host.events).toEqual([]);
  });
});
