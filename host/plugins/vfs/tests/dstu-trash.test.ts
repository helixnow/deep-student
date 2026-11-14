import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { DstuNode } from '../api.ts';
import plugin from '../index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';

describe('dstu trash commands', { timeout: 60_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;
  const vectorDeletes: Array<[string, string]> = [];
  let assertPurged = false;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-trash-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);

  beforeEach(async () => {
    vectorDeletes.length = 0;
    assertPurged = false;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-trash-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({
      plugins: [pathsPlugin, notesPlugin, reposPlugin, plugin],
      provide: { storage, vfsIndex: {
        indexing: { async deleteResourceIndex() {}, markResourcePending() {} },
        lance: { async deleteByResource(modality: string, id: string) {
          if (assertPurged) expect(conn.get('SELECT id FROM notes WHERE resource_id = ?1', [id])).toBeUndefined();
          vectorDeletes.push([modality, id]);
          return 0;
        } },
      } },
      app: { dataDir: root },
    });
    conn = host.ctx.vfsDatabase.getConn();
  }, 60_000);
  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const invoke = <T>(cmd: string, args: Record<string, unknown> = {}) => host.invoke<T>(cmd, args);
  const create = (options: Record<string, unknown>) => invoke<DstuNode>('dstu_create', {
    path: '/',
    options,
  });

  async function createNote(name = '笔记', content = '正文'): Promise<DstuNode> {
    return create({ type: 'note', name, content });
  }

  it('soft deletes, lists and restores a note with the Rust trash paths', async () => {
    const note = await createNote('回收站笔记');
    await expect(invoke('dstu_soft_delete', { id: note.id, itemType: 'note' })).resolves.toBeNull();
    expect(conn.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM notes WHERE id = ?1', [note.id])!.deleted_at).not.toBeNull();

    const trash = await invoke<DstuNode[]>('dstu_list_trash', {});
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({
      id: note.id,
      path: `/_trash/${note.id}`,
      name: '回收站笔记',
      type: 'note',
      resourceId: note.resourceId,
      previewType: 'markdown',
    });
    expect(trash[0]!.createdAt).toBeGreaterThan(0);

    await expect(invoke('dstu_trash_restore', { id: note.id, itemType: 'note' }))
      .resolves.toBeNull();
    expect(conn.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM notes WHERE id = ?1', [note.id])!.deleted_at).toBeNull();
    await expect(invoke<DstuNode[]>('dstu_list_trash')).resolves.toEqual([]);

    const events = host.eventsNamed('dstu:change') as Array<{ type: string; path: string }>;
    expect(events.filter(event => event.type === 'deleted').at(-1))
      .toMatchObject({ path: `/notes/${note.id}` });
    expect(events.filter(event => event.type === 'restored').at(-1))
      .toMatchObject({ path: `/_trash/${note.id}` });
  });

  it('filters trash by type and applies global limit/offset after descending updated_at', async () => {
    const note = await createNote('一');
    const translation = await create({ type: 'translation', name: '译' });
    const mindmap = await create({
      type: 'mindmap',
      name: '图',
      content: '{"root":{"id":"root","text":"根"}}',
    });
    await invoke('dstu_soft_delete', { id: note.id, itemType: 'note' });
    await invoke('dstu_soft_delete', { id: translation.id, itemType: 'translation' });
    await invoke('dstu_soft_delete', { id: mindmap.id, itemType: 'mindmap' });

    const all = await invoke<DstuNode[]>('dstu_list_trash', { limit: 10 });
    expect(all.map(node => node.id)).toEqual([mindmap.id, translation.id, note.id]);
    for (const node of all) expect(node.path).toBe(`/_trash/${node.id}`);

    const filtered = await invoke<DstuNode[]>('dstu_list_trash', { itemTypes: ['NOTES'] });
    expect(filtered.map(node => node.id)).toEqual([note.id]);

    const page = await invoke<DstuNode[]>('dstu_list_trash', { limit: 1, offset: 1 });
    expect(page.map(node => node.id)).toEqual([translation.id]);
  });

  it('restores many paths atomically and keeps the transaction on failure', async () => {
    const first = await createNote('甲');
    const second = await createNote('乙');
    await invoke('dstu_soft_delete', { id: first.id, itemType: 'note' });
    await invoke('dstu_soft_delete', { id: second.id, itemType: 'note' });

    await expect(invoke('dstu_restore_many', { paths: [first.id, second.id] })).resolves.toBe(2);
    expect(conn.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM notes WHERE id = ?1', [first.id])!.deleted_at).toBeNull();
    expect(conn.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM notes WHERE id = ?1', [second.id])!.deleted_at).toBeNull();

    await invoke('dstu_soft_delete', { id: first.id, itemType: 'note' });
    await expect(invoke('dstu_restore_many', { paths: [first.id, 'broken_path'] }))
      .rejects.toContain('路径解析失败');
    expect(conn.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM notes WHERE id = ?1', [first.id])!.deleted_at).not.toBeNull();
  });

  it('permanently deletes only trashed resources, removes note assets and emits purged', async () => {
    const note = await createNote('永久删除');
    await expect(invoke('dstu_permanently_delete', { id: note.id, itemType: 'note' }))
      .rejects.toMatchObject({
        type: 'VfsError',
        message: expect.stringContaining('不在回收站中'),
      });

    const assets = path.join(host.ctx.vfsDatabase.appDataDir(), 'notes_assets', '数学', note.id);
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, 'a.png'), 'x');

    await invoke('dstu_soft_delete', { id: note.id, itemType: 'note' });
    await expect(invoke('dstu_permanently_delete', { id: note.id, itemType: 'note' }))
      .resolves.toBeNull();
    expect(conn.get('SELECT id FROM notes WHERE id = ?1', [note.id])).toBeUndefined();
    expect(fs.existsSync(assets)).toBe(false);
    expect((host.eventsNamed('dstu:change') as Array<{ type: string; path: string }>)
      .filter(event => event.type === 'purged').at(-1))
      .toMatchObject({ path: `/_trash/${note.id}` });
  });

  it('empties only the requested trash types and returns the deleted count', async () => {
    const note = await createNote('清空');
    const mindmap = await create({
      type: 'mindmap',
      name: '保留',
      content: '{"root":{"id":"root","text":"根"}}',
    });
    await invoke('dstu_soft_delete', { id: note.id, itemType: 'note' });
    await invoke('dstu_soft_delete', { id: mindmap.id, itemType: 'mindmap' });

    await expect(invoke('dstu_empty_trash', { itemTypes: ['note'] })).resolves.toBe(1);
    expect(conn.get('SELECT id FROM notes WHERE id = ?1', [note.id])).toBeUndefined();
    expect(conn.get('SELECT id FROM mindmaps WHERE id = ?1', [mindmap.id])).toBeDefined();

    await expect(invoke('dstu_empty_trash', { itemTypes: ['mindmap'] })).resolves.toBe(1);
    expect(conn.get('SELECT id FROM mindmaps WHERE id = ?1', [mindmap.id])).toBeUndefined();
  });

  it('purge_all supports notes and textbooks only and purges the right rows', async () => {
    const note = await createNote('批量清理');
    await invoke('dstu_soft_delete', { id: note.id, itemType: 'note' });
    await expect(invoke('dstu_purge_all', { resourceType: 'notes' })).resolves.toBe(1);
    expect(conn.get('SELECT id FROM notes WHERE id = ?1', [note.id])).toBeUndefined();
    await expect(invoke('dstu_purge_all', { resourceType: 'mindmaps' }))
      .rejects.toContain("Resource type 'mindmaps' does not support purge_all operation");
  });

  it('rejects unknown soft-delete item types with the DstuError envelope', async () => {
    await expect(invoke('dstu_soft_delete', { id: 'note_x', itemType: 'widget' }))
      .rejects.toEqual({ type: 'InvalidPath', message: 'Unknown item type: widget' });
  });

  it('purges by path only after the resource is in the trash', async () => {
    const note = await createNote('路径清除');
    await expect(invoke('dstu_purge', { path: note.id }))
      .rejects.toContain('不在回收站中');
    await invoke('dstu_soft_delete', { id: note.id, itemType: 'note' });
    vectorDeletes.length = 0;
    assertPurged = true;
    await expect(invoke('dstu_purge', { path: `/数学/notes/${note.id}` })).resolves.toBeNull();
    expect(vectorDeletes).toEqual([['text', note.resourceId], ['multimodal', note.resourceId]]);
    expect(conn.get('SELECT id FROM notes WHERE id = ?1', [note.id])).toBeUndefined();
    expect((host.eventsNamed('dstu:change') as Array<{ type: string; path: string }>)
      .filter(event => event.type === 'purged').at(-1))
      .toMatchObject({ path: `/数学/notes/${note.id}` });
  });

  it('deletes many paths atomically and rolls the whole batch back on a bad path', async () => {
    const first = await createNote('批量甲');
    const second = await createNote('批量乙');
    await expect(invoke('dstu_delete_many', { paths: [first.id, second.id] })).resolves.toBe(2);
    for (const note of [first, second]) {
      expect(conn.get<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM notes WHERE id = ?1', [note.id])!.deleted_at).not.toBeNull();
    }

    const third = await createNote('批量丙');
    await expect(invoke('dstu_delete_many', { paths: [third.id, 'broken_path'] }))
      .rejects.toContain("无效的资源路径 'broken_path'");
    expect(conn.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM notes WHERE id = ?1', [third.id])!.deleted_at).toBeNull();

    // Unlike an invalid path, a missing parsed resource fails after the first mutation.
    await expect(invoke('dstu_delete_many', { paths: [third.id, 'note_missing'] })).rejects.toContain('note_missing');
    expect(conn.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM notes WHERE id = ?1', [third.id])!.deleted_at).toBeNull();

    await expect(invoke('dstu_delete_many', { paths: Array.from({ length: 101 }, () => third.id) }))
      .rejects.toContain('批量操作数量超出限制：最多允许 100 个，实际 101 个');
  });

  it('moves many resources into a folder, skipping unparsable paths', async () => {
    const folder = await invoke<{ id: string }>('dstu_folder_create', { title: '批量目标' });
    const first = await createNote('移动甲');
    const second = await createNote('移动乙');

    await expect(invoke('dstu_move_many', {
      paths: [first.id, second.id, 'broken_path'],
      destFolder: folder.id,
    })).resolves.toBe(2);
    for (const note of [first, second]) {
      expect(conn.get<{ folder_id: string | null }>(
        "SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = 'note' AND deleted_at IS NULL",
        [note.id])!.folder_id).toBe(folder.id);
    }
    const moved = (host.eventsNamed('dstu:change') as Array<{ type: string }>)
      .filter(event => event.type === 'moved');
    expect(moved).toHaveLength(2);

    await expect(invoke('dstu_move_many', { paths: [first.id], destFolder: first.id }))
      .rejects.toContain('Destination must be a folder');
  });

  it('restores canonical resource nodes while preserving the original event path', async () => {
    const translation = await create({ type: 'translation', name: '恢复译稿',
      metadata: { sourceText: 'hello', translatedText: '你好', srcLang: 'en', tgtLang: 'zh' } });
    await invoke('dstu_soft_delete', { id: translation.id, itemType: 'translation' });
    const path = `/课程/${translation.id}`;
    const restored = await invoke<DstuNode>('dstu_restore', { path });
    expect(restored).toMatchObject({ name: '恢复译稿', path: `/${translation.id}`,
      metadata: { srcLang: 'en', tgtLang: 'zh' } });
    expect(host.eventsNamed('dstu:change').at(-1)).toMatchObject({ type: 'restored', path, node: restored });
  });
});
