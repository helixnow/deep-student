import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { ResourceLocation, VfsFolder } from '../api.ts';
import type { DstuWatchEvent } from '../src/dstu-types.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';

describe('dstu location commands', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-locations-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-locations-'));
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
  const create = (title: string, parentId?: string) => invoke<VfsFolder>('dstu_folder_create', {
    title,
    ...(parentId === undefined ? {} : { parentId }),
  });
  const seedMembership = (folderId: string | null, itemType: string, itemId: string, cachedPath: string | null) =>
    conn.run(
      `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
       VALUES (?1, ?2, ?3, ?4, 0, 1, ?5)`,
      [`fi_${itemId}`, folderId, itemType, itemId, cachedPath],
    );

  it('dstu_build_path joins folder titles without a leading slash and falls back to root', async () => {
    const parent = await create('高考复习');
    const child = await create('函数', parent.id);
    expect(await invoke('dstu_build_path', { resourceId: 'note_root' })).toBe('/note_root');
    expect(await invoke('dstu_build_path', { folderId: null, resourceId: 'note_root' })).toBe('/note_root');
    expect(await invoke('dstu_build_path', { folderId: child.id, resourceId: 'note_x' })).toBe('高考复习/函数/note_x');
    expect(await invoke('dstu_build_path', { folderId: 'fld_missing', resourceId: 'note_x' })).toBe('/note_x');
  });

  it('dstu_get_resource_location uses cached paths, folder titles and unknown types', async () => {
    const folder = await create('资料');
    seedMembership(folder.id, 'note', 'note_cached', '缓存/路径/note_cached');
    expect(await invoke<ResourceLocation>('dstu_get_resource_location', { resourceId: 'note_cached' })).toEqual({
      id: 'note_cached', resourceType: 'note', folderId: folder.id,
      folderPath: '资料', fullPath: '缓存/路径/note_cached', hash: null,
    });

    seedMembership(folder.id, 'file', 'tb_1', null);
    expect(await invoke<ResourceLocation>('dstu_get_resource_location', { resourceId: 'tb_1' })).toEqual({
      id: 'tb_1', resourceType: 'file', folderId: folder.id,
      folderPath: '资料', fullPath: '资料/tb_1', hash: null,
    });

    expect(await invoke<ResourceLocation>('dstu_get_resource_location', { resourceId: 'note_missing' })).toEqual({
      id: 'note_missing', resourceType: 'note', folderId: null,
      folderPath: '', fullPath: '/note_missing', hash: null,
    });
    expect(await invoke<ResourceLocation>('dstu_get_resource_location', { resourceId: 'zzz_1' })).toEqual({
      id: 'zzz_1', resourceType: 'unknown', folderId: null,
      folderPath: '', fullPath: '/zzz_1', hash: null,
    });
  });

  it('dstu_build_path only acquires the database in the Some folder branch (L13-BUILD-PATH-01)', async () => {
    const connection = vi.spyOn(host.ctx.vfsDatabase, 'getConnSafe').mockImplementation(() => {
      throw new Error('VFS connection unavailable');
    });
    try {
      expect(await invoke('dstu_build_path', { resourceId: 'note_root' })).toBe('/note_root');
      expect(await invoke('dstu_build_path', { folderId: null, resourceId: ' note_raw ' })).toBe('/ note_raw ');
      expect(connection).not.toHaveBeenCalled();
      await expect(invoke('dstu_build_path', { folderId: 'fld_x', resourceId: 'note_root' }))
        .rejects.toBe('VFS connection unavailable');
      expect(connection).toHaveBeenCalledTimes(1);
      await expect(invoke('dstu_build_path', { resourceId: 1 })).rejects.toContain('invalid args `resourceId`');
      await expect(invoke('dstu_build_path', { folderId: 1, resourceId: 'note_root' }))
        .rejects.toContain('invalid args `folderId`');
      expect(connection).toHaveBeenCalledTimes(1);
    } finally { connection.mockRestore(); }
  });

  it('dstu_get_path_by_id mirrors get_resource_path_internal including bare root ids', async () => {
    const folder = await create('路径');
    seedMembership(folder.id, 'note', 'note_in', null);
    expect(await invoke('dstu_get_path_by_id', { resourceId: 'note_in' })).toBe('路径/note_in');
    expect(await invoke('dstu_get_path_by_id', { resourceId: 'note_root' })).toBe('note_root');
    expect(await invoke('dstu_get_path_by_id', { resourceId: 'zzz_1' })).toBe('zzz_1');
  });

  it('dstu_move_to_folder inserts and updates memberships and emits moved events', async () => {
    const parent = await create('父');
    const child = await create('子', parent.id);
    const events: Array<{ name: string; payload: DstuWatchEvent }> = [];
    host.ctx.backendEvents.listen('dstu:change', (payload) => {
      events.push({ name: 'dstu:change', payload: payload as DstuWatchEvent });
    });

    const created = await invoke<ResourceLocation>('dstu_move_to_folder', {
      resourceId: 'tb_moved', targetFolderId: child.id,
    });
    expect(created).toEqual({
      id: 'tb_moved', resourceType: 'file', folderId: child.id,
      folderPath: '父/子', fullPath: '父/子/tb_moved', hash: null,
    });
    expect(conn.one<{ item_type: string; folder_id: string; cached_path: string }>(
      "SELECT item_type, folder_id, cached_path FROM folder_items WHERE item_id = 'tb_moved'",
    )).toEqual({ item_type: 'file', folder_id: child.id, cached_path: '父/子/tb_moved' });
    expect(events[0]!.payload).toMatchObject({
      type: 'moved', path: '父/子/tb_moved', oldPath: '/tb_moved',
    });

    const moved = await invoke<ResourceLocation>('dstu_move_to_folder', {
      resourceId: 'tb_moved', targetFolderId: null,
    });
    expect(moved).toEqual({
      id: 'tb_moved', resourceType: 'file', folderId: null,
      folderPath: '', fullPath: '/tb_moved', hash: null,
    });
    expect(conn.one<{ folder_id: string | null; cached_path: string }>(
      "SELECT folder_id, cached_path FROM folder_items WHERE item_id = 'tb_moved'",
    )).toEqual({ folder_id: null, cached_path: '/tb_moved' });
    expect(events[1]!.payload).toMatchObject({
      type: 'moved', path: '/tb_moved', oldPath: '父/子/tb_moved',
    });
  });

  it('dstu_batch_move returns successes and per-item failures', async () => {
    const folder = await create('批量');
    const result = await invoke<{
      successes: ResourceLocation[]; failedItems: Array<{ itemId: string; error: string }>; totalCount: number;
    }>('dstu_batch_move', { request: { itemIds: ['note_a', 'exam_b'], targetFolderId: folder.id } });
    expect(result.totalCount).toBe(2);
    expect(result.failedItems).toEqual([]);
    expect(result.successes.map(item => item.fullPath)).toEqual(['批量/note_a', '批量/exam_b']);
    expect(conn.all<{ item_id: string }>("SELECT item_id FROM folder_items WHERE folder_id = ?1 ORDER BY item_id", [folder.id])
      .map(row => row.item_id)).toEqual(['exam_b', 'note_a']);

    expect(await invoke('dstu_batch_move', { request: { itemIds: [] } })).toEqual({
      successes: [], failedItems: [], totalCount: 0,
    });

    conn.exec('DROP TABLE folder_items');
    const failed = await invoke<{
      successes: ResourceLocation[]; failedItems: Array<{ itemId: string; error: string }>; totalCount: number;
    }>('dstu_batch_move', { request: { itemIds: ['note_a', 'note_b'], targetFolderId: folder.id } });
    expect(failed.totalCount).toBe(2);
    expect(failed.successes).toEqual([]);
    expect(failed.failedItems.map(item => item.itemId)).toEqual(['note_a', 'note_b']);
    expect(failed.failedItems[0]!.error).toContain('查询旧路径失败 (note_a):');
  });

  it('dstu_refresh_path_cache refreshes one item or every item', async () => {
    const parent = await create('缓存根');
    const child = await create('缓存子', parent.id);
    seedMembership(child.id, 'note', 'note_one', null);
    seedMembership(null, 'exam', 'exam_two', null);
    expect(await invoke('dstu_refresh_path_cache', { resourceId: 'note_one' })).toBe(1);
    expect(conn.pluck("SELECT cached_path FROM folder_items WHERE item_id = 'note_one'")).toBe('缓存根/缓存子/note_one');
    expect(conn.pluck("SELECT cached_path FROM folder_items WHERE item_id = 'exam_two'")).toBeNull();
    expect(await invoke('dstu_refresh_path_cache', {})).toBe(2);
    expect(conn.pluck("SELECT cached_path FROM folder_items WHERE item_id = 'exam_two'")).toBe('/exam_two');
  });
});
