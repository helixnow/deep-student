import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '@deepseek-ai/cordis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsNote } from '../../notes/api.ts';
import plugin from '../index.ts';
import { newFolder, newFolderItem } from '../repository/folders.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';

let root: string;
let blobsDir: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
let noteSeq = 0;

function createNote(title: string, content: string, folderId: string | null): VfsNote {
  noteSeq += 1;
  const id = `note_test_${noteSeq}`;
  const resource = host.ctx.vfsRepo.resources.createOrReuse(db, 'note', content, id, 'notes', { title });
  const now = new Date().toISOString();
  db.run(`INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
    VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4)`, [id, resource.resourceId, title, now]);
  if (folderId !== null) {
    host.ctx.vfsRepo.folders.addItemToFolder(db, newFolderItem(folderId, 'note', id));
  }
  return { id, resourceId: resource.resourceId, title, tags: [], isFavorite: false, createdAt: now, updatedAt: now };
}

function getLiveNote(id: string): VfsNote | null {
  const row = db.get<{
    id: string; resource_id: string; title: string; tags: string; is_favorite: number;
    created_at: string; updated_at: string; deleted_at: string | null;
  }>('SELECT * FROM notes WHERE id = ?1 AND deleted_at IS NULL', [id]);
  if (row === undefined) return null;
  return {
    id: row.id, resourceId: row.resource_id, title: row.title,
    tags: JSON.parse(row.tags) as string[], isFavorite: Number(row.is_favorite) !== 0,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-folder-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
  blobsDir = join(storage.locations.activeDir, 'vfs_blobs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const repo = () => host.ctx.vfsRepo.folders;
const files = () => host.ctx.vfsRepo.files;
const blobs = () => host.ctx.vfsRepo.blobs;

function readBreadcrumbs(conn: SqlExecutor, folderId: string) {
  const folders = repo();
  if (folders.getBreadcrumbs === undefined) throw new Error('FolderRepository.getBreadcrumbs is unavailable');
  return folders.getBreadcrumbs(conn, folderId);
}

function folderWithParent(title: string, parentId: string | null = null) {
  return newFolder(title, parentId);
}

describe('folder_repo.rs', { timeout: 120_000 }, () => {
  it('test_create_folder', () => {
    const folder = newFolder('测试文件夹');
    repo().createFolder(db, folder);
    expect(repo().folderExists(db, folder.id)).toBe(true);
  });

  it('test_get_folder', () => {
    const folder = newFolder('获取测试', null, '📁', '#FF0000');
    repo().createFolder(db, folder);
    const retrieved = repo().getFolder(db, folder.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('获取测试');
    expect(retrieved!.icon).toBe('📁');
  });

  it('test_nested_folders_recursive', () => {
    const rootFolder = newFolder('根目录');
    repo().createFolder(db, rootFolder);
    const child1 = folderWithParent('子文件夹1', rootFolder.id);
    repo().createFolder(db, child1);
    const grandchild = folderWithParent('孙文件夹', child1.id);
    repo().createFolder(db, grandchild);

    const folderIds = repo().getFolderIdsRecursive(db, rootFolder.id);
    expect(folderIds).toHaveLength(3);
    expect(folderIds).toContain(rootFolder.id);
    expect(folderIds).toContain(child1.id);
    expect(folderIds).toContain(grandchild.id);
  });

  it('test_build_folder_path', () => {
    const rootFolder = newFolder('高考复习');
    repo().createFolder(db, rootFolder);
    const child = folderWithParent('函数', rootFolder.id);
    repo().createFolder(db, child);
    expect(repo().buildFolderPath(db, child.id)).toBe('高考复习/函数');
  });

  it('test_folder_depth_limit', () => {
    let parentId: string | null = null;
    for (let index = 0; index < 10; index++) {
      const folder = folderWithParent(`层级${index + 1}`, parentId);
      repo().createFolder(db, folder);
      parentId = folder.id;
    }
    const deepFolder = folderWithParent('超深层级', parentId);
    let message = '';
    try { repo().createFolder(db, deepFolder); }
    catch (error) { message = String(error); }
    expect(message).toContain('FOLDER_DEPTH_EXCEEDED');
  });

  it('test_get_all_resources_empty', () => {
    const folder = newFolder('空文件夹');
    repo().createFolder(db, folder);
    const result = repo().getAllResources(db, folder.id, false, false);
    expect(result.folderId).toBe(folder.id);
    expect(result.folderTitle).toBe('空文件夹');
    expect(result.totalCount).toBe(0);
    expect(result.resources).toHaveLength(0);
  });

  it('test_folder_item_crud', () => {
    const folder = newFolder('笔记文件夹');
    repo().createFolder(db, folder);
    const item = newFolderItem(folder.id, 'note', 'note_test123');
    repo().addItemToFolder(db, item);

    const items = repo().listItemsByFolder(db, folder.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.itemId).toBe('note_test123');

    repo().moveItemByItemId(db, 'note', 'note_test123', null);
    expect(repo().listItemsByFolder(db, folder.id)).toHaveLength(0);

    repo().removeItemByItemId(db, 'note', 'note_test123');
  });

  it('moving_item_marks_enabled_vector_routes_pending', () => {
    const now = Date.now();
    db.run(`INSERT INTO resources (
        id, hash, type, source_id, storage_mode, ref_count,
        index_state, index_hash, index_error, indexed_at,
        mm_index_state, mm_index_error, mm_indexed_at,
        created_at, updated_at
      ) VALUES (
        'res_move', 'hash_move', 'note', 'note_move', 'inline', 0,
        'indexed', 'hash_move', 'old text error', ?1,
        'indexed', 'old mm error', ?1,
        ?1, ?1
      )`, [now]);

    const source = newFolder('source');
    const target = newFolder('target');
    repo().createFolder(db, source);
    repo().createFolder(db, target);
    repo().addItemToFolder(db, newFolderItem(source.id, 'note', 'note_move'));

    repo().moveItemByItemId(db, 'note', 'note_move', target.id);

    const state = db.get<{
      index_state: string; index_hash: string | null; index_error: string | null;
      mm_index_state: string; mm_index_error: string | null; mm_indexed_at: number | null;
    }>("SELECT index_state, index_hash, index_error, mm_index_state, mm_index_error, mm_indexed_at FROM resources WHERE id = 'res_move'");
    expect(state!.index_state).toBe('pending');
    expect(state!.index_hash).toBeNull();
    expect(state!.index_error).toBeNull();
    expect(state!.mm_index_state).toBe('pending');
    expect(state!.mm_index_error).toBeNull();
    expect(state!.mm_indexed_at).toBeNull();
  });

  it('test_list_items_by_folder_handles_text_created_at', () => {
    const folder = newFolder('附件');
    repo().createFolder(db, folder);
    db.run(`INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
      VALUES (?1, ?2, 'file', 'file_legacy', 0, ?3, '/附件/file_legacy')`,
    ['fi_legacy_text_ts', folder.id, '2026-03-02T00:00:00.000Z']);

    const items = repo().listItemsByFolder(db, folder.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.itemId).toBe('file_legacy');
    expect(items[0]!.createdAt).toBeGreaterThan(0);
  });

  it('test_purge_folder_tree_handles_image_items', () => {
    const folder = newFolder('图片文件夹');
    repo().createFolder(db, folder);

    const blob = blobs().storeBlob(db, blobsDir, Buffer.from('png-bytes'), 'image/png', 'png');
    const image = files().createFileInFolder(db, 'sha256_image_purge_test', '截图.png', 9, 'image',
      'image/png', blob.hash, null, folder.id);
    db.run("UPDATE folder_items SET item_type = 'image' WHERE item_id = ?1", [image.id]);

    repo().deleteFolder(db, folder.id);
    repo().purgeFolder(db, folder.id, blobsDir);

    expect(db.pluck<number>('SELECT COUNT(*) FROM files WHERE id = ?1', [image.id])).toBe(0);
    const blobRef = db.pluck<number>('SELECT ref_count FROM blobs WHERE hash = ?1', [blob.hash]);
    expect(blobRef === undefined || blobRef === 0).toBe(true);
  });

  it('test_purge_deleted_folders_reuses_resource_purge_chain', () => {
    const rootFolder = newFolder('待清理根目录');
    repo().createFolder(db, rootFolder);
    const child = newFolder('待清理子目录', rootFolder.id);
    repo().createFolder(db, child);

    const note = createNote('待删除笔记', 'folder purge should remove note', child.id);
    const file = files().createFileInFolder(db, 'sha256_folder_purge_file', '待删除附件.txt', 12,
      'other', 'text/plain', null, null, child.id);

    repo().deleteFolder(db, rootFolder.id);
    const purged = repo().purgeDeletedFolders(db);
    expect(purged).toBe(1);

    expect(db.pluck<number>('SELECT COUNT(*) FROM folders WHERE id IN (?1, ?2)',
      [rootFolder.id, child.id])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM folder_items WHERE item_id IN (?1, ?2)',
      [note.id, file.id])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM notes WHERE id = ?1', [note.id])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM files WHERE id = ?1', [file.id])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM resources WHERE id IN (?1, ?2)',
      [note.resourceId, file.resourceId!])).toBe(0);
  });

  it('test_delete_folder_soft_deletes_owned_notes_and_restore_brings_them_back', () => {
    const folder = newFolder('级联软删');
    repo().createFolder(db, folder);
    const note = createNote('仍可见就会被误删', 'body', folder.id);

    repo().deleteFolder(db, folder.id);

    const listed = db.all<{ id: string }>('SELECT id FROM notes WHERE deleted_at IS NULL');
    expect(listed.every(item => item.id !== note.id)).toBe(true);
    const deletedAt = db.pluck<string | null>('SELECT deleted_at FROM notes WHERE id = ?1', [note.id]);
    expect(deletedAt).not.toBeNull();

    repo().restoreFolder(db, folder.id);
    const restored = getLiveNote(note.id);
    expect(restored).not.toBeNull();
    expect(restored!.title).toBe('仍可见就会被误删');
  });

  it('test_purge_folder_skips_still_active_legacy_children', () => {
    const folder = newFolder('旧数据只墓碑成员');
    repo().createFolder(db, folder);
    const note = createNote('活跃笔记', 'keep', folder.id);

    const now = new Date().toISOString();
    db.run('UPDATE folders SET deleted_at = ?1 WHERE id = ?2', [now, folder.id]);
    db.run('UPDATE folder_items SET deleted_at = ?1 WHERE item_id = ?2', [now, note.id]);

    repo().purgeFolder(db, folder.id);
    const stillLive = getLiveNote(note.id);
    expect(stillLive).not.toBeNull();
    expect(stillLive!.title).toBe('活跃笔记');
  });

  // L13 R13v-03: dstu/folder_handlers.rs:911-975 breadcrumbs query owned by the folders table owner.
  it('getBreadcrumbs returns root-to-leaf titles limited to 11 levels and logs success', () => {
    const logs: Message[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
    let parent: string | null = null;
    for (let depth = 0; depth < 13; depth += 1) {
      db.run(`INSERT INTO folders (id, parent_id, title, is_expanded, sort_order, created_at, updated_at)
        VALUES (?1, ?2, ?3, 0, 0, 0, 0)`, [`fld_crumb_${depth}`, parent, `层${depth}`]);
      parent = `fld_crumb_${depth}`;
    }
    const crumbs = readBreadcrumbs(db, 'fld_crumb_12');
    expect(crumbs).toHaveLength(11);
    expect(crumbs[0]).toEqual({ id: 'fld_crumb_2', name: '层2' });
    expect(crumbs.at(-1)).toEqual({ id: 'fld_crumb_12', name: '层12' });
    expect(readBreadcrumbs(db, 'fld_missing')).toEqual([]);
    const infos = logs.filter(message => message.type === 'info').map(message => message.args.join(' '));
    expect(infos).toContain('[DSTU::folder_handlers] dstu_folder_get_breadcrumbs: SUCCESS - folder_id=fld_crumb_12, count=11');
  });

  it('getBreadcrumbs distinguishes real prepare failures from row decoding failures', () => {
    const logs: Message[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
    const malformed = storage.openFile(join(root, 'breadcrumbs-malformed.db'));
    try {
      // No folders table: F3 tags this real SQLite error as prepare, even though iterate is lazy.
      expect(() => readBreadcrumbs(malformed, 'fld_bad')).toThrow('数据库查询失败');
      malformed.exec('CREATE TABLE folders (id TEXT, parent_id TEXT, title BLOB)');
      malformed.run('INSERT INTO folders VALUES (?1, NULL, ?2)', ['fld_bad', Buffer.from('not TEXT')]);
      expect(() => readBreadcrumbs(malformed, 'fld_bad'))
        .toThrow('Collect failed: Invalid column type Blob at index: 1, name: title');
      const errors = logs.filter(message => message.type === 'error').map(message => message.args.join(' '));
      expect(errors.some(message => message.includes('prepare FAILED - folder_id=fld_bad, error=no such table: folders')))
        .toBe(true);
      expect(errors).toContain('[DSTU::folder_handlers] dstu_folder_get_breadcrumbs: FAILED - folder_id=fld_bad, error=Collect failed: Invalid column type Blob at index: 1, name: title');
    } finally {
      storage.close(malformed);
    }
  });
});
