import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  folderErrors,
  MAX_FOLDER_DEPTH,
  MAX_FOLDERS_COUNT,
  MAX_FOLDER_TITLE_LENGTH,
  type VfsFolder,
  type VfsFolderItem,
} from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';
import {
  createFolderItemRecord,
  createFolderRecord,
  generateFolderId,
  generateFolderItemId,
  renameFolderIfVersionWithConn,
} from '../repository/folders.ts';

const nowIso = () => new Date().toISOString();

describe('dstu folder commands', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-folders-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-folders-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
    conn = host.ctx.vfsDatabase.getConn();
  }, 60_000);
  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const invoke = <T>(cmd: string, args: Record<string, unknown> = {}) => host.invoke<T>(cmd, args);
  const create = (title: string, extra: Record<string, unknown> = {}) => invoke<VfsFolder>('dstu_folder_create', { title, ...extra });
  const seedResource = (id: string, hash: string, data: string | null, type = 'note') => conn.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, index_state, index_hash, index_error, indexed_at,
       mm_index_state, mm_index_error, mm_indexed_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'inline', ?4, 0, 'indexed', ?2, 'old error', 1, 'indexed', 'old mm error', 1, 1, 1)`,
    [id, hash, type, data],
  );
  const seedNote = (id: string, resourceId: string, title: string) => {
    conn.run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
       VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4)`,
      [id, resourceId, title, nowIso()],
    );
  };
  const seedFile = (id: string, resourceId: string, name: string) => {
    conn.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, 'active', ?5, ?5)`,
      [id, resourceId, `sha-${id}`, name, nowIso()],
    );
  };

  it('test_valid_item_types', async () => {
    const folder = await create('类型');
    const validTypes = ['note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'mindmap'];
    for (const itemType of validTypes) {
      const item = await invoke<VfsFolderItem>('dstu_folder_add_item', {
        folderId: folder.id, itemType, itemId: `${itemType}_1`,
      });
      expect(item.itemType).toBe(itemType);
    }
    await expect(invoke('dstu_folder_add_item', { folderId: folder.id, itemType: 'invalid', itemId: 'x' }))
      .rejects.toBe('参数格式错误');
  });

  it('test_folder_id_format', () => {
    const id = generateFolderId();
    expect(id.startsWith('fld_')).toBe(true);
    expect(id).toHaveLength(14);
  });

  it('test_folder_item_id_format', () => {
    const id = generateFolderItemId();
    expect(id.startsWith('fi_')).toBe(true);
    expect(id).toHaveLength(13);
  });

  it('test_title_validation', async () => {
    await expect(create('')).rejects.toBe('文件夹标题不能为空');
    await expect(create('   ')).rejects.toBe('文件夹标题不能为空');
    await expect(create('a'.repeat(MAX_FOLDER_TITLE_LENGTH + 1))).rejects.toBe('文件夹标题 长度超过限制');
    expect('a'.repeat(MAX_FOLDER_TITLE_LENGTH + 1).length).toBeGreaterThan(MAX_FOLDER_TITLE_LENGTH);
  });

  it('test_folder_constraints', () => {
    expect(MAX_FOLDER_DEPTH).toBe(10);
    expect(MAX_FOLDERS_COUNT).toBe(500);
    expect(MAX_FOLDER_TITLE_LENGTH).toBe(100);
  });

  it('test_folder_error_codes', () => {
    expect(folderErrors.NOT_FOUND).toBe('FOLDER_NOT_FOUND');
    expect(folderErrors.DEPTH_EXCEEDED).toBe('FOLDER_DEPTH_EXCEEDED');
    expect(folderErrors.INVALID_PARENT).toBe('INVALID_PARENT');
    expect(folderErrors.COUNT_EXCEEDED).toBe('FOLDER_COUNT_EXCEEDED');
  });

  it('test_vfs_folder_new', () => {
    const folder = createFolderRecord('高考复习', undefined, 'folder', '#FF0000');
    expect(folder.id.startsWith('fld_')).toBe(true);
    expect(folder.title).toBe('高考复习');
    expect(folder.parentId).toBeUndefined();
    expect(folder.icon).toBe('folder');
    expect(folder.color).toBe('#FF0000');
    expect(folder.isExpanded).toBe(true);
    expect(folder.isFavorite).toBe(false);
    expect(folder.sortOrder).toBe(0);
    expect(folder.createdAt).toBeGreaterThan(0);
    expect(folder.updatedAt).toBe(folder.createdAt);
  });

  it('test_vfs_folder_item_new', () => {
    const item = createFolderItemRecord('fld_abc123', 'note', 'note_xyz789');
    expect(item.id.startsWith('fi_')).toBe(true);
    expect(item.folderId).toBe('fld_abc123');
    expect(item.itemType).toBe('note');
    expect(item.itemId).toBe('note_xyz789');
    expect(item.sortOrder).toBe(0);
    expect(item.createdAt).toBeGreaterThan(0);
  });

  it('test_vfs_folder_serialization', () => {
    const json = JSON.stringify(createFolderRecord('测试文件夹'));
    expect(json).toContain('"isExpanded"');
    expect(json).toContain('"isFavorite"');
    expect(json).toContain('"sortOrder"');
    expect(json).toContain('"createdAt"');
    expect(json).toContain('"updatedAt"');
    expect(json).not.toContain('"parentId"');
    expect(json).not.toContain('"icon"');
    expect(json).not.toContain('"color"');
  });

  it('test_vfs_folder_item_serialization', () => {
    const json = JSON.stringify(createFolderItemRecord(undefined, 'textbook', 'tb_abc123'));
    expect(json).toContain('"itemType"');
    expect(json).toContain('"itemId"');
    expect(json).toContain('"sortOrder"');
    expect(json).toContain('"createdAt"');
    expect(json).not.toContain('"folderId"');
  });

  it('creates roots for root and empty parent ids and validates colors', async () => {
    const byRoot = await create('根一', { parentId: 'root', color: 'blue' });
    const byEmpty = await create('根二', { parentId: '', color: '#00ff00' });
    expect(byRoot.parentId).toBeUndefined();
    expect(byEmpty.parentId).toBeUndefined();
    await expect(create('坏颜色', { color: '#GGGGGG' })).rejects.toBe('颜色格式错误，请使用 #RRGGBB 格式或预定义颜色名称');
    await expect(create('全角颜色', { color: '#ＦＦ００００' })).rejects.toBe('颜色格式错误，请使用 #RRGGBB 格式或预定义颜色名称');
  });

  it('rejects dangerous titles and icon inputs', async () => {
    await expect(create('a/b')).rejects.toBe('文件夹标题 不能包含路径分隔符');
    await expect(create('a\u0000b')).rejects.toBe('文件夹标题 包含非法字符');
    await expect(create('a\u200Bb')).rejects.toBe('文件夹标题 包含非法Unicode字符');
    await expect(create('四十个汉字'.repeat(34))).rejects.toBe('文件夹标题 长度超过限制');
    await expect(create('图标', { icon: 'a/b' })).rejects.toBe('图标 不能包含路径分隔符');
  });

  it('gets, lists and reads folders including a soft-deleted folder', async () => {
    const first = await create('第一');
    const second = await create('第二', { icon: 'folder', color: 'red' });
    const listed = await invoke<VfsFolder[]>('dstu_folder_list');
    expect(listed.map(folder => folder.id)).toEqual([first.id, second.id]);
    expect(await invoke<VfsFolder | null>('dstu_folder_get', { folderId: first.id })).toMatchObject({ title: '第一' });
    expect(await invoke('dstu_folder_get', { folderId: 'fld_missing' })).toBeNull();
    await invoke('dstu_folder_delete', { folderId: first.id });
    expect((await invoke<VfsFolder | null>('dstu_folder_get', { folderId: first.id }))?.title).toBe('第一');
    expect((await invoke<VfsFolder[]>('dstu_folder_list')).map(folder => folder.id)).toEqual([second.id]);
  });

  it('enforces parent existence, depth and folder count constraints', async () => {
    await expect(create('孤儿', { parentId: 'fld_missing' })).rejects.toBe('INVALID_PARENT: fld_missing - Parent folder does not exist');

    let parentId: string | undefined;
    for (let depth = 1; depth <= MAX_FOLDER_DEPTH; depth += 1) {
      parentId = (await create(`层级${depth}`, parentId === undefined ? {} : { parentId })).id;
    }
    await expect(create('第十一层', { parentId })).rejects.toContain('FOLDER_DEPTH_EXCEEDED');

    conn.run('DELETE FROM folders');
    for (let index = 0; index < MAX_FOLDERS_COUNT; index += 1) {
      conn.run(
        `INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
         VALUES (?1, NULL, ?2, 1, 0, 1, 1)`,
        [`fld_seed_${index}`, `种子${index}`],
      );
    }
    await expect(create('超量')).rejects.toBe('FOLDER_COUNT_EXCEEDED: 500 folders (max 500)');
  });

  it('renames folders with optimistic concurrency and invalidates cached paths', async () => {
    const rootFolder = await create('旧名');
    const child = await create('子', { parentId: rootFolder.id });
    conn.run(
      "INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path) VALUES ('fi_cache', ?1, 'note', 'note_cache', 0, 1, '/旧名/子/笔记')",
      [child.id],
    );
    conn.run("INSERT INTO path_cache (item_type, item_id, full_path, folder_path, updated_at) VALUES ('folder', ?1, '/旧名', '/旧名', 'x')", [child.id]);
    conn.run("INSERT INTO path_cache (item_type, item_id, full_path, folder_path, updated_at) VALUES ('note', 'note_cache', '/旧名/子/笔记', '/旧名/子', 'x')");

    await invoke('dstu_folder_rename', { folderId: rootFolder.id, title: '新名' });

    expect(conn.pluck('SELECT title FROM folders WHERE id = ?1', [rootFolder.id])).toBe('新名');
    expect(conn.pluck('SELECT cached_path FROM folder_items WHERE id = ?1', ['fi_cache'])).toBeNull();
    expect(conn.pluck('SELECT COUNT(*) FROM path_cache')).toBe(0);
    await expect(invoke('dstu_folder_rename', { folderId: 'fld_missing', title: 'x' })).rejects.toBe('资源不存在');
    await expect(invoke('dstu_folder_rename', { folderId: rootFolder.id, title: '  ' })).rejects.toBe('文件夹标题不能为空');

    const before = conn.pluck<number>('SELECT updated_at FROM folders WHERE id = ?1', [rootFolder.id])!;
    conn.run('UPDATE folders SET updated_at = ?1 WHERE id = ?2', [before + 10, rootFolder.id]);
    expect(() => renameFolderIfVersionWithConn(conn, rootFolder.id, '冲突', before))
      .toThrow('CONFLICT(folders.conflict): Folder');
  });

  it('expands folders and rejects unknown ids', async () => {
    const folder = await create('展开');
    await invoke('dstu_folder_set_expanded', { folderId: folder.id, isExpanded: false });
    expect(conn.pluck('SELECT is_expanded FROM folders WHERE id = ?1', [folder.id])).toBe(0);
    await expect(invoke('dstu_folder_set_expanded', { folderId: 'fld_missing', isExpanded: true }))
      .rejects.toBe('FOLDER_NOT_FOUND: fld_missing');
  });

  it('moves folders while rejecting self, descendant and missing parents', async () => {
    const first = await create('一');
    const second = await create('二');
    const child = await create('子', { parentId: first.id });
    await invoke('dstu_folder_move', { folderId: second.id, newParentId: first.id });
    expect(conn.pluck('SELECT parent_id FROM folders WHERE id = ?1', [second.id])).toBe(first.id);
    await expect(invoke('dstu_folder_move', { folderId: first.id, newParentId: first.id })).rejects.toBe('INVALID_PARENT');
    await expect(invoke('dstu_folder_move', { folderId: first.id, newParentId: child.id }))
      .rejects.toBe(`INVALID_PARENT: ${child.id} - Cannot move folder to its own descendant`);
    await expect(invoke('dstu_folder_move', { folderId: first.id, newParentId: 'fld_missing' }))
      .rejects.toBe('INVALID_PARENT: fld_missing - Target parent folder does not exist');
    await expect(invoke('dstu_folder_move', { folderId: 'fld_missing', newParentId: null }))
      .rejects.toBe('FOLDER_NOT_FOUND: fld_missing');
    await invoke('dstu_folder_move', { folderId: second.id, newParentId: null });
    expect(conn.pluck('SELECT parent_id FROM folders WHERE id = ?1', [second.id])).toBeNull();
  });

  it('enforces the depth limit when moving a subtree', async () => {
    let parentId: string | undefined;
    for (let depth = 1; depth <= 8; depth += 1) {
      parentId = (await create(`深${depth}`, parentId === undefined ? {} : { parentId })).id;
    }
    const movingRoot = await create('移动树');
    await create('移动子', { parentId: movingRoot.id });
    await expect(invoke('dstu_folder_move', { folderId: movingRoot.id, newParentId: parentId }))
      .rejects.toContain('FOLDER_DEPTH_EXCEEDED');
  });

  it('adds, moves and removes folder items with canonical file types', async () => {
    const source = await create('来源');
    const target = await create('目标');
    const item = await invoke<VfsFolderItem>('dstu_folder_add_item', {
      folderId: source.id, itemType: 'textbook', itemId: 'tb_1',
    });
    expect(item.itemType).toBe('textbook');
    expect(conn.pluck("SELECT item_type FROM folder_items WHERE item_id = 'tb_1'")).toBe('file');

    await invoke('dstu_folder_remove_item', { itemType: 'textbook', itemId: 'tb_1' });
    expect(conn.pluck("SELECT COUNT(*) FROM folder_items WHERE item_id = 'tb_1'")).toBe(0);

    await invoke('dstu_folder_move_item', { itemType: 'note', itemId: 'note_missing', newFolderId: target.id });
    expect(conn.pluck("SELECT folder_id FROM folder_items WHERE item_id = 'note_missing' AND item_type = 'note'")).toBe(target.id);
    await expect(invoke('dstu_folder_move_item', { itemType: 'note', itemId: 'note_missing', newFolderId: 'fld_missing' }))
      .rejects.toBe('FOLDER_NOT_FOUND: fld_missing');

    await expect(invoke('dstu_folder_add_item', { folderId: 'fld_missing', itemType: 'note', itemId: 'note_x' }))
      .rejects.toBe('目标文件夹不存在');
  });

  it('keeps one membership per item and returns canonical items', async () => {
    const first = await create('甲');
    const second = await create('乙');
    await invoke('dstu_folder_add_item', { folderId: first.id, itemType: 'note', itemId: 'note_same' });
    await invoke('dstu_folder_add_item', { folderId: second.id, itemType: 'note', itemId: 'note_same' });
    expect(conn.pluck("SELECT COUNT(*) FROM folder_items WHERE item_id = 'note_same'")).toBe(1);
    expect(conn.pluck("SELECT folder_id FROM folder_items WHERE item_id = 'note_same'")).toBe(second.id);
  });

  it('moving an enabled item marks both vector routes pending', async () => {
    seedResource('res_move', 'hash_move', null);
    const folder = await create('索引');
    await invoke('dstu_folder_add_item', { folderId: folder.id, itemType: 'note', itemId: 'res_move' });
    await invoke('dstu_folder_move_item', { itemType: 'note', itemId: 'res_move', newFolderId: null });
    const state = conn.one<{
      index_state: string; index_hash: string | null; index_error: string | null;
      mm_index_state: string; mm_index_error: string | null; mm_indexed_at: number | null;
    }>('SELECT index_state, index_hash, index_error, mm_index_state, mm_index_error, mm_indexed_at FROM resources WHERE id = ?1', ['res_move']);
    expect(state).toEqual({
      index_state: 'pending', index_hash: null, index_error: null,
      mm_index_state: 'pending', mm_index_error: null, mm_indexed_at: null,
    });
  });

  it('lists folder items in sort order and reads legacy text timestamps', async () => {
    const folder = await create('列表');
    conn.run(
      `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
       VALUES ('fi_second', ?1, 'file', 'file_legacy', 2, '2026-03-02T00:00:00.000Z', '/列表/file_legacy')`,
      [folder.id],
    );
    conn.run(
      `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
       VALUES ('fi_first', ?1, 'note', 'note_1', 1, 0, NULL)`,
      [folder.id],
    );
    const items = await invoke<VfsFolderItem[]>('dstu_folder_get_items', { folderId: folder.id });
    expect(items.map(item => item.id)).toEqual(['fi_first', 'fi_second']);
    expect(items[1]!.createdAt).toBe(Date.parse('2026-03-02T00:00:00.000Z'));
  });

  it('builds the folder tree with nested children and items', async () => {
    const rootFolder = await create('根');
    const child = await create('子', { parentId: rootFolder.id });
    await invoke('dstu_folder_add_item', { folderId: child.id, itemType: 'note', itemId: 'note_child' });
    const tree = await invoke<Array<{ folder: VfsFolder; children: Array<{ folder: VfsFolder; items: VfsFolderItem[] }>; items: VfsFolderItem[] }>>('dstu_folder_get_tree');
    expect(tree).toHaveLength(1);
    expect(tree[0]!.folder.id).toBe(rootFolder.id);
    expect(tree[0]!.children[0]!.folder.id).toBe(child.id);
    expect(tree[0]!.children[0]!.items[0]!.itemId).toBe('note_child');
  });

  it('reorders folders and folder items', async () => {
    const first = await create('一');
    const second = await create('二');
    const third = await create('三');
    await invoke('dstu_folder_reorder', { folderIds: [third.id, first.id, second.id] });
    const listed = await invoke<VfsFolder[]>('dstu_folder_list');
    expect(listed.map(folder => folder.id)).toEqual([third.id, first.id, second.id]);

    const folder = await create('项');
    for (const [index, id] of ['fi_a', 'fi_b', 'fi_c'].entries()) {
      conn.run(
        `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
         VALUES (?1, ?2, 'note', ?3, ?4, 0)`,
        [id, folder.id, `note_${id}`, index],
      );
    }
    await invoke('dstu_folder_reorder_items', { folderId: folder.id, itemIds: ['fi_c', 'fi_a', 'fi_b'] });
    expect(conn.all<{ id: string }>('SELECT id FROM folder_items WHERE folder_id = ?1 ORDER BY sort_order', [folder.id]).map(row => row.id))
      .toEqual(['fi_c', 'fi_a', 'fi_b']);
  });

  it('returns breadcrumbs from root to the requested folder', async () => {
    const rootFolder = await create('根');
    const child = await create('子', { parentId: rootFolder.id });
    const grandchild = await create('孙', { parentId: child.id });
    expect(await invoke('dstu_folder_get_breadcrumbs', { folderId: grandchild.id })).toEqual([
      { id: rootFolder.id, name: '根' },
      { id: child.id, name: '子' },
      { id: grandchild.id, name: '孙' },
    ]);
    expect(await invoke('dstu_folder_get_breadcrumbs', { folderId: 'fld_missing' })).toEqual([]);
  });

  it('aggregates all folder resources recursively and loads content on demand', async () => {
    const rootFolder = await create('注入');
    const child = await create('子', { parentId: rootFolder.id });
    seedResource('res_note', 'hash_note', 'hello note');
    seedNote('note_1', 'res_note', '笔记标题');
    seedResource('res_file', 'hash_file', null, 'file');
    seedFile('file_1', 'res_file', '附件.txt');
    await invoke('dstu_folder_add_item', { folderId: rootFolder.id, itemType: 'note', itemId: 'note_1' });
    await invoke('dstu_folder_add_item', { folderId: child.id, itemType: 'file', itemId: 'file_1' });

    const withChildren = await invoke<{
      folderId: string; folderTitle: string; path: string; totalCount: number;
      resources: Array<{ itemType: string; itemId: string; resourceId?: string; title: string; path: string; content?: string }>;
    }>('dstu_folder_get_all_resources', { folderId: rootFolder.id, includeSubfolders: true, includeContent: true });
    expect(withChildren.folderId).toBe(rootFolder.id);
    expect(withChildren.folderTitle).toBe('注入');
    expect(withChildren.path).toBe('注入');
    expect(withChildren.totalCount).toBe(2);
    expect(withChildren.resources).toEqual(expect.arrayContaining([
      { itemType: 'note', itemId: 'note_1', resourceId: 'res_note', title: '笔记标题', path: '注入/笔记标题', content: 'hello note' },
      { itemType: 'file', itemId: 'file_1', resourceId: 'res_file', title: '附件.txt', path: '注入/子/附件.txt', content: '附件.txt (file)' },
    ]));

    const rootOnly = await invoke<{ totalCount: number }>('dstu_folder_get_all_resources', {
      folderId: rootFolder.id, includeSubfolders: false, includeContent: false,
    });
    expect(rootOnly.totalCount).toBe(1);
    await expect(invoke('dstu_folder_get_all_resources', { folderId: 'fld_missing', includeSubfolders: false, includeContent: false }))
      .rejects.toBe('Folder not found: fld_missing');
  });

  it('soft deletes the folder tree, memberships and owned entities idempotently', async () => {
    const rootFolder = await create('待删');
    const child = await create('子', { parentId: rootFolder.id });
    seedResource('res_owned', 'hash_owned', 'owned');
    seedNote('note_owned', 'res_owned', '待删笔记');
    await invoke('dstu_folder_add_item', { folderId: child.id, itemType: 'note', itemId: 'note_owned' });

    await invoke('dstu_folder_delete', { folderId: rootFolder.id });
    expect(conn.pluck('SELECT deleted_at IS NOT NULL FROM folders WHERE id = ?1', [rootFolder.id])).toBe(1);
    expect(conn.pluck('SELECT deleted_at IS NOT NULL FROM folders WHERE id = ?1', [child.id])).toBe(1);
    expect(conn.pluck('SELECT deleted_at IS NOT NULL FROM folder_items WHERE item_id = ?1', ['note_owned'])).toBe(1);
    expect(conn.pluck('SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1', ['note_owned'])).toBe(1);
    await expect(invoke('dstu_folder_delete', { folderId: rootFolder.id })).resolves.toBeNull();
    await expect(invoke('dstu_folder_delete', { folderId: 'fld_missing' })).rejects.toBe('FOLDER_NOT_FOUND: fld_missing');
  });

  it('does not soft delete an entity that still has a live membership outside the tree', async () => {
    const deletedTree = await create('树');
    const outside = await create('外部');
    seedResource('res_shared', 'hash_shared', 'shared');
    seedNote('note_shared', 'res_shared', '共享笔记');
    await invoke('dstu_folder_add_item', { folderId: deletedTree.id, itemType: 'note', itemId: 'note_shared' });
    conn.exec('DROP INDEX idx_folder_items_item_active_unique');
    conn.exec('DROP INDEX idx_folder_items_note_active_unique');
    conn.run(
      `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
       VALUES ('fi_outside', ?1, 'note', 'note_shared', 0, 1)`,
      [outside.id],
    );
    await invoke('dstu_folder_delete', { folderId: deletedTree.id });
    expect(conn.pluck('SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1', ['note_shared'])).toBe(0);
  });

  it('R13v-01 rolls back the whole owner folder cascade when a child entity write fails', async () => {
    const parent = await create('级联回滚');
    const child = await create('子目录', { parentId: parent.id });
    seedResource('res_cascade_note', 'cascade_note', '正文');
    seedNote('note_cascade', 'res_cascade_note', '笔记');
    seedResource('res_cascade_file', 'cascade_file', null, 'file');
    seedFile('file_cascade', 'res_cascade_file', '文件.txt');
    await invoke('dstu_folder_add_item', { folderId: parent.id, itemType: 'note', itemId: 'note_cascade' });
    await invoke('dstu_folder_add_item', { folderId: child.id, itemType: 'file', itemId: 'file_cascade' });
    const eventCount = host.eventsNamed('dstu:change').length;
    conn.exec(`CREATE TRIGGER reject_cascade_file BEFORE UPDATE OF deleted_at ON files
      WHEN NEW.id = 'file_cascade' BEGIN SELECT RAISE(ABORT, 'cascade rejected'); END;`);
    await expect(invoke('dstu_folder_delete', { folderId: parent.id }))
      .rejects.toBe('Database error: cascade rejected');
    for (const folderId of [parent.id, child.id]) {
      expect(conn.pluck('SELECT deleted_at FROM folders WHERE id = ?1', [folderId])).toBeNull();
    }
    expect(conn.pluck('SELECT deleted_at FROM notes WHERE id = ?1', ['note_cascade'])).toBeNull();
    expect(conn.get('SELECT deleted_at, status FROM files WHERE id = ?1', ['file_cascade']))
      .toEqual({ deleted_at: null, status: 'active' });
    expect(conn.pluck('SELECT COUNT(*) FROM folder_items WHERE deleted_at IS NOT NULL')).toBe(0);
    expect(host.eventsNamed('dstu:change')).toHaveLength(eventCount);
    conn.exec('DROP TRIGGER reject_cascade_file');
    await expect(invoke('dstu_folder_delete', { folderId: parent.id })).resolves.toBeNull();
    expect(conn.pluck('SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1', ['note_cascade'])).toBe(1);
    expect(conn.pluck('SELECT status FROM files WHERE id = ?1', ['file_cascade'])).toBe('deleted');
  });

  it('R13v-03 records the Rust validation warning before rejecting folder input', async () => {
    const logs: Array<{ type: string; level: number; args: unknown[] }> = [];
    host.ctx.logger.exporter({ levels: { default: 3 }, export: message => { logs.push(message); } });
    const cases: Array<{ title: string; extra: Record<string, unknown>; error: string; args: unknown[] }> = [
      { title: 'a\nb', extra: { color: 'invalid' }, error: '文件夹标题 包含非法字符',
        args: ['[DSTU::folder_handlers] validate_string_input: %s contains invalid control characters', '文件夹标题'] },
      { title: 'a\u200bb', extra: {}, error: '文件夹标题 包含非法Unicode字符',
        args: ['[DSTU::folder_handlers] validate_string_input: %s contains Unicode bypass characters', '文件夹标题'] },
      { title: 'a/b', extra: {}, error: '文件夹标题 不能包含路径分隔符',
        args: ['[DSTU::folder_handlers] validate_string_input: %s contains path separators', '文件夹标题'] },
      { title: 'a'.repeat(MAX_FOLDER_TITLE_LENGTH + 1), extra: {}, error: '文件夹标题 长度超过限制',
        args: ['[DSTU::folder_handlers] validate_string_input: %s exceeds max length %d', '文件夹标题', MAX_FOLDER_TITLE_LENGTH] },
      { title: 'valid', extra: { icon: 'a/b' }, error: '图标 不能包含路径分隔符',
        args: ['[DSTU::folder_handlers] validate_string_input: %s contains path separators', '图标'] },
      { title: 'valid', extra: { color: 'rgb(0,0,0)' }, error: '颜色格式错误，请使用 #RRGGBB 格式或预定义颜色名称',
        args: ['[DSTU::folder_handlers] dstu_folder_create: invalid color format: %s', 'rgb(0,0,0)'] },
    ];
    for (const input of cases) {
      const start = logs.length;
      await expect(create(input.title, input.extra)).rejects.toBe(input.error);
      expect(logs.slice(start).filter(message => message.type === 'warn')).toEqual([
        expect.objectContaining({ type: 'warn', level: 2, args: input.args }),
      ]);
    }
    const beforeRename = logs.length;
    await expect(invoke('dstu_folder_rename', { folderId: 'fld_unused', title: 'a\nb' }))
      .rejects.toBe('文件夹标题 包含非法字符');
    expect(logs.slice(beforeRename)).toContainEqual(expect.objectContaining({ type: 'warn', level: 2, args: cases[0]!.args }));
    const beforeEmpty = logs.length;
    await expect(create('  ')).rejects.toBe('文件夹标题不能为空');
    expect(logs.slice(beforeEmpty).filter(message => message.type === 'warn')).toEqual([]);
    expect(conn.pluck('SELECT COUNT(*) FROM folders')).toBe(0);
  });
});
