import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import notes from '../index.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';

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
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterAll(async () => {
  await host.dispose();
  storage.dispose();
});

beforeEach(() => {
  const database = storage.database('vfs');
  database.exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions;
    DELETE FROM note_document_formats;
    DELETE FROM note_state;
    DELETE FROM note_learning_relations;
    DELETE FROM note_transfer_operations;
    DELETE FROM note_review_save_receipts;
    DELETE FROM note_review_save_operations;
    DELETE FROM note_links;
    DELETE FROM note_tags;
    DELETE FROM note_editor_lease_acks;
    DELETE FROM note_editor_write_grants;
    DELETE FROM note_editor_lease_notes;
    DELETE FROM note_editor_leases;
    DELETE FROM note_editor_participants;
    DELETE FROM folder_items;
    DELETE FROM notes;
    DELETE FROM vfs_index_segments;
    DELETE FROM vfs_index_units;
    DELETE FROM __lance_orphan_queue;
    DELETE FROM __change_log;
    DELETE FROM vfs_indexing_config;
    DELETE FROM resources;
    PRAGMA foreign_keys=ON;
    INSERT INTO notes_fts(notes_fts) VALUES('delete-all');`);
  host.events.length = 0;
}, 30000);

interface NoteItem {
  id: string;
  title: string;
  content_md: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
}

async function create(title = '测试笔记', content_md = '正文', tags: string[] = []): Promise<NoteItem> {
  return host.invoke<NoteItem>('notes_create', { note: { title, content_md, tags } });
}

describe('cmd/notes.rs command layer', () => {
  it('notes_create/get/update/set_favorite/delete/restore round-trip', async () => {
    const created = await create('原始标题', '# 一级标题\n\n正文内容', ['数学', '复习']);
    expect(created.id).toMatch(/^note_/);
    expect(created).toMatchObject({
      title: '原始标题', content_md: '# 一级标题\n\n正文内容', tags: ['数学', '复习'],
      is_favorite: false,
    });
    expect(created.created_at).toBe(created.updated_at);
    expect(Number.isFinite(Date.parse(created.created_at))).toBe(true);

    expect(await host.invoke('notes_get', { id: created.id })).toEqual(created);

    const updated = await host.invoke<NoteItem>('notes_update', {
      note: {
        id: created.id, title: '新标题', content_md: '新正文', tags: ['物理'],
        expected_updated_at: created.updated_at,
      },
    });
    expect(updated).toMatchObject({
      id: created.id, title: '新标题', content_md: '新正文', tags: ['物理'],
      created_at: created.created_at, is_favorite: false,
    });
    expect(updated.updated_at > created.updated_at).toBe(true);

    const favorite = await host.invoke<NoteItem>('notes_set_favorite', {
      id: created.id, favorite: true,
    });
    expect(favorite.is_favorite).toBe(true);
    expect(favorite.content_md).toBe('新正文');

    expect(await host.invoke('notes_delete', { id: created.id })).toBe(true);
    await expect(host.invoke('notes_get', { id: created.id })).rejects.toEqual({
      error_type: 'NotFound', message: '笔记不存在或已被删除', details: null,
    });
    expect((await host.invoke<NoteItem[]>('notes_list', {})).map((note) => note.id)).not.toContain(created.id);
    expect(await host.invoke<boolean>('notes_restore', { id: created.id })).toBe(true);
    expect((await host.invoke<NoteItem>('notes_get', { id: created.id })).title).toBe('新标题');
  });

  it('maps validation, missing-note and optimistic-lock errors to the Rust envelopes', async () => {
    await expect(host.invoke('notes_create', { note: { title: '   ', content_md: 'x' } })).rejects.toEqual({
      error_type: 'Database',
      message: "VFS 创建笔记失败: Invalid argument 'title': 标题不能为空",
      details: null,
    });
    await expect(host.invoke('notes_create', { note: { title: 'x'.repeat(501), content_md: 'x' } })).rejects.toEqual({
      error_type: 'Database',
      message: "VFS 创建笔记失败: Invalid argument 'title': 标题过长（最多 500 个字符）",
      details: null,
    });
    await expect(host.invoke('notes_get', { id: 'note_missing' })).rejects.toEqual({
      error_type: 'NotFound', message: '笔记不存在或已被删除', details: null,
    });
    await expect(host.invoke('notes_update', { note: { id: 'note_missing', title: 'x' } })).rejects.toEqual({
      error_type: 'Database', message: 'VFS 更新笔记失败: Note not found: note_missing', details: null,
    });
    await expect(host.invoke('notes_delete', { id: 'note_missing' })).rejects.toEqual({
      error_type: 'Database', message: 'VFS 删除笔记失败: Note not found: note_missing', details: null,
    });
    await expect(host.invoke('notes_restore', { id: 'note_missing' })).rejects.toEqual({
      error_type: 'Database', message: 'VFS 恢复笔记失败: Note not found: note_missing', details: null,
    });
    await expect(host.invoke('notes_set_favorite', { id: 'note_missing', favorite: true })).rejects.toEqual({
      error_type: 'NotFound', message: '笔记不存在或已被删除', details: null,
    });

    const created = await create('冲突测试', 'v1');
    await host.invoke('notes_update', { note: { id: created.id, content_md: 'v2' } });
    await expect(host.invoke('notes_update', {
      note: { id: created.id, content_md: 'v3', expected_updated_at: created.updated_at },
    })).rejects.toEqual({
      error_type: 'Conflict',
      message: 'CONFLICT(notes.conflict): The note has been updated elsewhere, please refresh.',
      details: null,
    });

    await expect(host.invoke('notes_update', {
      note: { id: created.id, content_md: 'v4', capabilities: [] },
    })).rejects.toEqual({
      error_type: 'Validation',
      message: 'Capability-aware saves require expected_updated_at',
      details: null,
    });
    const current = await host.invoke<NoteItem>('notes_get', { id: created.id });
    const capable = await host.invoke<NoteItem>('notes_update', {
      note: { id: created.id, content_md: 'v5', capabilities: [], expected_updated_at: current.updated_at },
    });
    expect(capable.content_md).toBe('v5');
  });

  it('notes_list, notes_list_meta and notes_list_tags keep list semantics', async () => {
    const first = await create('数学', 'a', ['数学', '复习']);
    const second = await create('物理', 'b', ['物理']);
    const third = await create('数学二', 'c', ['数学']);

    const list = await host.invoke<NoteItem[]>('notes_list', {});
    expect(list).toHaveLength(3);
    expect(list.every((note) => note.content_md === '')).toBe(true);
    expect(list[0]!.id).toBe(third.id);
    expect(await host.invoke<NoteItem[]>('notes_list', { limit: 1, offset: 1 })).toHaveLength(1);

    const meta = await host.invoke<NoteItem[]>('notes_list_meta', {});
    expect(meta.map((note) => note.id).sort()).toEqual([first.id, second.id, third.id].sort());
    expect(meta.every((note) => note.content_md === '')).toBe(true);

    const tags = await host.invoke<string[]>('notes_list_tags', {});
    expect(tags).toEqual(['数学', '复习', '物理']);
    expect(tags[0]).toBe('数学');

    await host.invoke('notes_delete', { id: third.id });
    expect((await host.invoke<NoteItem[]>('notes_list', {})).map((note) => note.id))
      .toEqual([second.id, first.id]);
  });

  it('notes_list_advanced supports FTS/LIKE keywords, tags, dates, assets, sort and pagination', async () => {
    const calculus = await create('Calculus Notes', 'The derivative measures instantaneous change.', ['math', 'study']);
    const algebra = await create('Algebra', 'linear equations and matrices', ['math']);
    const assets = await create('Asset Note', '![img](notes_assets/main/n1/pic.png)', ['assets']);
    const deletedNote = await create('Deleted', 'derivative in trash', ['math']);
    expect(await host.invoke<NoteItem[]>('notes_list', {})).toHaveLength(4);

    const advanced = await host.invoke('notes_list_advanced', {
      options: { keyword: 'derivative', page: 0, page_size: 10 },
    }) as { items: NoteItem[]; total: number; page: number; page_size: number };
    expect(advanced.items.map((note) => note.id)).toContain(calculus.id);
    expect(advanced.total).toBeGreaterThanOrEqual(1);
    expect(advanced.page).toBe(0);
    expect(advanced.page_size).toBe(10);

    const shortKeyword = await host.invoke('notes_list_advanced', {
      options: { keyword: 'mat', page_size: 10 },
    }) as { items: NoteItem[]; total: number };
    expect(shortKeyword.items.map((note) => note.id)).toContain(algebra.id);

    const tagged = await host.invoke('notes_list_advanced', {
      options: { tags: ['math', 'study'], page_size: 10 },
    }) as { items: NoteItem[]; total: number };
    expect(tagged.items.map((note) => note.id)).toEqual([calculus.id]);
    expect(tagged.total).toBe(1);

    const withAssets = await host.invoke('notes_list_advanced', {
      options: { has_assets: true, page_size: 10 },
    }) as { items: NoteItem[] };
    expect(withAssets.items.map((note) => note.id)).toEqual([assets.id]);

    const sorted = await host.invoke('notes_list_advanced', {
      options: { sort_by: 'title', sort_dir: 'asc', page_size: 2, page: 0 },
    }) as { items: NoteItem[]; total: number; page: number; page_size: number };
    expect(sorted.items.map((note) => note.title)).toEqual(['Algebra', 'Asset Note']);
    expect(sorted.total).toBe(4);
    expect(sorted.page_size).toBe(2);
    const secondPage = await host.invoke('notes_list_advanced', {
      options: { sort_by: 'title', sort_dir: 'asc', page_size: 2, page: 1 },
    }) as { items: NoteItem[] };
    expect(secondPage.items).toHaveLength(2);

    const dated = await host.invoke('notes_list_advanced', {
      options: { date_start: '2000-01-01', date_end: '2999-01-01', page_size: 10 },
    }) as { items: NoteItem[] };
    expect(dated.items).toHaveLength(4);

    await host.invoke('notes_delete', { id: deletedNote.id });
    const active = await host.invoke('notes_list_advanced', {
      options: { tags: ['math'], page_size: 10 },
    }) as { items: NoteItem[] };
    expect(active.items).toHaveLength(2);
    const deleted = await host.invoke('notes_list_advanced', {
      options: { only_deleted: true, keyword: 'derivative', page_size: 10 },
    }) as { items: NoteItem[]; total: number };
    expect(deleted.items).toHaveLength(1);
    expect(deleted.items[0]!.id).toBe(deletedNote.id);
    expect(deleted.total).toBe(1);
  });

  it('notes_list_deleted pages emptied-trash semantics', async () => {
    const first = await create('回收一', 'a');
    const second = await create('回收二', 'b');
    await host.invoke('notes_delete', { id: first.id });
    await host.invoke('notes_delete', { id: second.id });

    const page = await host.invoke('notes_list_deleted', { page: 0, pageSize: 1 }) as {
      items: NoteItem[]; total: number; page: number; page_size: number;
    };
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.page).toBe(0);
    expect(page.page_size).toBe(1);
    expect(page.items[0]!.content_md).toBe('');
    expect((await host.invoke('notes_list_deleted', { page: 1, pageSize: 1 }) as { items: NoteItem[] }).items).toHaveLength(1);
  });

  it('notes_search splits tag filters and returns snippet hits', async () => {
    const target = await create('微积分基础', '导数是瞬时变化率 derivative', ['math']);
    await create('无关', 'nothing to see', ['other']);
    const hits = await host.invoke('notes_search', { keyword: 'derivative', limit: 10 }) as Array<{
      id: string; title: string; snippet: string | null;
    }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(target.id);
    expect(hits[0]!.snippet).toContain('derivative');

    const byTag = await host.invoke('notes_search', { keyword: 'tag:math', limit: 10 }) as Array<{ id: string }>;
    expect(byTag.map((hit) => hit.id)).toEqual([target.id]);
    expect(await host.invoke('notes_search', { keyword: '   ', limit: 10 })).toEqual([]);
    expect(await host.invoke('notes_search', { keyword: 'derivative', limit: 0 })).toHaveLength(1);
  });

  it('notes_get_backlinks/get_outgoing_links/rebuild_links/unlinked_mentions share the link graph', async () => {
    const target = await create('知识中枢', 'hub');
    const linked = await create('来源笔记', '参考 [[知识中枢]] 与 note://' + target.id);
    const mention = await create('只提及', '正文提到知识中枢但没有链接');

    const outgoing = await host.invoke('notes_get_outgoing_links', { noteId: linked.id }) as Array<{
      targetId: string | null; targetTitle: string; linkType: string; resolved: boolean; position: number;
    }>;
    expect(outgoing).toHaveLength(2);
    expect(outgoing.every((link) => link.resolved && link.targetId === target.id)).toBe(true);

    const backlinks = await host.invoke('notes_get_backlinks', { noteId: target.id }) as Array<{
      sourceId: string; sourceTitle: string; position: number;
    }>;
    expect(backlinks).toHaveLength(2);
    expect(backlinks.every((link) => link.sourceId === linked.id)).toBe(true);

    const rebuilt = await host.invoke('notes_rebuild_links', { batchSize: 2 }) as {
      noteCount: number; linkCount: number;
    };
    expect(rebuilt.noteCount).toBe(3);
    expect(rebuilt.linkCount).toBeGreaterThanOrEqual(2);

    const mentions = await host.invoke('notes_unlinked_mentions', { noteId: target.id, limit: 10 }) as Array<{
      id: string;
    }>;
    expect(mentions.map((hit) => hit.id)).toContain(mention.id);
    expect(mentions.map((hit) => hit.id)).not.toContain(linked.id);
    expect(mentions.map((hit) => hit.id)).not.toContain(target.id);

    await expect(host.invoke('notes_get_backlinks', { noteId: 'note_missing' })).rejects.toEqual({
      error_type: 'NotFound', message: '查询反链失败: Note not found: note_missing', details: null,
    });
  });

  it('notes_db_stats reports the VFS path, counts and asset bytes; notes_db_vacuum succeeds', async () => {
    const created = await create('统计笔记', 'a');
    await host.invoke('notes_delete', { id: created.id });
    const assetsDir = join(storage.locations.activeDir, 'notes_assets', 'main', 'note');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'a.png'), Buffer.alloc(7));

    const stats = await host.invoke('notes_db_stats', {}) as {
      db_path: string; file_size_bytes: number; total_notes: number;
      total_versions: number; total_assets: number; total_asset_bytes: number;
    };
    expect(stats.db_path).toBe(storage.pathOf('vfs'));
    expect(stats.file_size_bytes).toBeGreaterThan(0);
    expect(stats.total_notes).toBe(1);
    expect(stats.total_versions).toBeGreaterThan(0);
    expect(stats.total_assets).toBe(1);
    expect(stats.total_asset_bytes).toBe(7);

    expect(await host.invoke('notes_db_vacuum', {})).toBe(true);
  });
});
