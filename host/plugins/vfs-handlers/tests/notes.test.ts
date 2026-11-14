import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) =>
  vfs.host.invoke(name, args) as Promise<T>;
const db = () => vfs.storage.database('vfs');
const repos = () => vfs.host.ctx.vfsRepo;

function putInFolder(folderId: string, itemType: string, itemId: string): void {
  repos().folders.addItemToFolder(db(), {
    id: `fi_${itemId}`, folderId, itemType, itemId, sortOrder: 0, createdAt: Date.now(),
  });
}

interface WireNote {
  id: string;
  resourceId: string;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

describe('vfs/handlers.rs note commands', { timeout: 120_000 }, () => {
  it('test_create_note_input_deserialization', async () => {
    const note = await invoke<WireNote>('vfs_create_note', {
      params: { title: 'Test Note', content: 'note content', tags: ['tag1', 'tag2'] },
    });
    expect(note.title).toBe('Test Note');
    expect(note.tags).toEqual(['tag1', 'tag2']);
    expect(note.id.startsWith('note_')).toBe(true);
    expect(await invoke('vfs_get_note_content', { id: note.id })).toBe('note content');

    // tags 缺省 = Vec::default()（空数组）
    const untagged = await invoke<WireNote>('vfs_create_note', {
      params: { title: 'No tags', content: 'body' },
    });
    expect(untagged.tags).toEqual([]);
  });

  it('test_update_note_params_for_versioning', async () => {
    const note = await invoke<WireNote>('vfs_create_note', {
      params: { title: '原标题', content: '旧内容', tags: ['旧标签'] },
    });

    // 仅更新内容
    const contentOnly = await invoke<WireNote>('vfs_update_note', {
      id: note.id, params: { content: '新版本内容' },
    });
    expect(contentOnly.title).toBe('原标题');
    expect(contentOnly.tags).toEqual(['旧标签']);
    expect(await invoke('vfs_get_note_content', { id: note.id })).toBe('新版本内容');
    // 内容变化会挂到新的 resource 上（versioning 依赖）
    expect(contentOnly.resourceId).not.toBe(note.resourceId);

    // 内容 + 标题
    const withTitle = await invoke<WireNote>('vfs_update_note', {
      id: note.id, params: { content: '新版本内容', title: '新标题' },
    });
    expect(withTitle.title).toBe('新标题');
    expect(withTitle.tags).toEqual(['旧标签']);

    // 完整更新
    const full = await invoke<WireNote>('vfs_update_note', {
      id: note.id, params: { content: '新版本内容', title: '新标题', tags: ['重要', '复习'] },
    });
    expect(full.title).toBe('新标题');
    expect(full.tags).toEqual(['重要', '复习']);
    // 内容哈希未变时复用同一个 resource
    expect(full.resourceId).toBe(withTitle.resourceId);
  });

  it('test_note_id_format_validation', async () => {
    const note = await invoke<WireNote>('vfs_create_note', {
      params: { title: '合法', content: 'x' },
    });
    expect(note.id.startsWith('note_')).toBe(true);
    expect(await invoke('vfs_get_note', { id: note.id })).toMatchObject({ id: note.id });

    for (const bad of ['res_abc123', 'abc123']) {
      await expect(invoke('vfs_get_note', { id: bad }))
        .rejects.toBe(`Invalid argument 'id': Invalid id format: ${bad}`);
      await expect(invoke('vfs_get_note_content', { id: bad }))
        .rejects.toBe(`Invalid argument 'id': Invalid id format: ${bad}`);
      await expect(invoke('vfs_update_note', { id: bad, params: { content: 'x' } }))
        .rejects.toBe(`Invalid argument 'id': Invalid id format: ${bad}`);
      await expect(invoke('vfs_delete_note', { id: bad }))
        .rejects.toBe(`Invalid argument 'id': Invalid id format: ${bad}`);
    }
  });

  it('vfs_list_notes filters by search and orders by updated_at', async () => {
    const first = await invoke<WireNote>('vfs_create_note', {
      params: { title: '数学笔记', content: '函数' },
    });
    await invoke('vfs_create_note', { params: { title: '英语笔记', content: '语法' } });
    const found = await invoke<WireNote[]>('vfs_list_notes', { params: { search: '数学' } });
    expect(found.map(note => note.id)).toEqual([first.id]);
    expect(await invoke('vfs_list_notes', { params: { search: '不存在' } })).toEqual([]);
  });

  it('vfs_create_note validates title and 5MB content limit', async () => {
    await expect(invoke('vfs_create_note', { params: { title: '   ', content: 'x' } }))
      .rejects.toBe("Invalid argument 'title': Title cannot be empty");
    await expect(invoke('vfs_create_note', {
      params: { title: '大笔记', content: 'x'.repeat(5 * 1024 * 1024 + 1) },
    })).rejects.toBe("Invalid argument 'content': 笔记内容大小超出限制（最大 5MB）");
  });

  it('vfs_delete_note soft deletes notes and folder items', async () => {
    const folder = { id: 'fld_l13bdelete', title: '删除测试', isExpanded: true, isFavorite: false,
      sortOrder: 0, createdAt: Date.now(), updatedAt: Date.now() };
    repos().folders.createFolder(db(), folder);
    const note = await invoke<WireNote>('vfs_create_note', {
      params: { title: '待删除', content: 'x' },
    });
    putInFolder(folder.id, 'note', note.id);
    expect(db().pluck('SELECT deleted_at FROM notes WHERE id = ?1', [note.id])).toBeNull();
    expect(await invoke('vfs_delete_note', { id: note.id })).toBeNull();
    expect(await invoke('vfs_get_note', { id: note.id })).toBeNull();
    expect(db().pluck<number>('SELECT COUNT(*) FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL', [note.id])).toBe(1);
    expect(db().pluck<number>(
      'SELECT COUNT(*) FROM folder_items WHERE item_id = ?1 AND deleted_at IS NOT NULL', [note.id],
    )).toBe(1);
  });

  it('runs note delete continuations only after the row is gone', async () => {
    const folder = { id: 'fld_l13bhook', title: '钩子测试', isExpanded: true, isFavorite: false,
      sortOrder: 0, createdAt: Date.now(), updatedAt: Date.now() };
    repos().folders.createFolder(db(), folder);
    const note = await invoke<WireNote>('vfs_create_note', {
      params: { title: '记忆笔记', content: 'x' },
    });
    const other = await invoke<WireNote>('vfs_create_note', {
      params: { title: '普通笔记', content: 'y' },
    });
    putInFolder(folder.id, 'note', note.id);
    putInFolder(folder.id, 'note', other.id);
    const hooks = vfs.host.ctx.vfsHooks;
    const seen: Array<{ noteId: string; noteDeleted: boolean; folderItemDeleted: boolean }> = [];
    const dispose = hooks.registerNoteDeleteHook({
      captureDelete(noteId: string) {
        if (noteId !== note.id) return null;
        return () => {
          seen.push({
            noteId,
            noteDeleted: db().pluck('SELECT deleted_at FROM notes WHERE id = ?1', [noteId]) !== null,
            folderItemDeleted: db().pluck('SELECT deleted_at FROM folder_items WHERE item_id = ?1', [noteId]) !== null,
          });
        };
      },
    });

    await invoke('vfs_delete_note', { id: other.id });
    expect(seen).toEqual([]);
    await invoke('vfs_delete_note', { id: note.id });
    expect(seen).toEqual([{ noteId: note.id, noteDeleted: true, folderItemDeleted: true }]);

    // Disposer 解除注册后不再执行
    dispose();
    const third = await invoke<WireNote>('vfs_create_note', { params: { title: '第三篇', content: 'z' } });
    await invoke('vfs_delete_note', { id: third.id });
    expect(seen).toHaveLength(1);
  });
});
