import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) =>
  vfs.host.invoke(name, args) as Promise<T>;
const repos = () => vfs.host.ctx.vfsRepo;
const db = () => vfs.storage.database('vfs');

let folderSeq = 0;
function makeFolder(title: string, parentId: string | null = null): string {
  folderSeq += 1;
  const id = `fld_l13b${folderSeq}`;
  const folder = {
    id, title, isExpanded: true, isFavorite: false, sortOrder: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  } as { id: string; parentId?: string; title: string; isExpanded: boolean; isFavorite: boolean;
    sortOrder: number; createdAt: number; updatedAt: number };
  if (parentId !== null) folder.parentId = parentId;
  repos().folders.createFolder(db(), folder);
  return id;
}

function putInFolder(folderId: string, itemType: string, itemId: string): void {
  repos().folders.addItemToFolder(db(), {
    id: `fi_${itemId}`, folderId, itemType, itemId, sortOrder: 0, createdAt: Date.now(),
  });
}

async function makeNote(title: string, folderId: string | null): Promise<string> {
  const note = await invoke<{ id: string }>('vfs_create_note', {
    params: { title, content: `content of ${title}` },
  });
  if (folderId !== null) putInFolder(folderId, 'note', note.id);
  return note.id;
}

const cachedPath = (itemId: string): string | null =>
  db().pluck<string | null>('SELECT cached_path FROM folder_items WHERE item_id = ?1', [itemId]) ?? null;

describe('vfs/handlers.rs path cache commands', { timeout: 120_000 }, () => {
  it('test_path_format', async () => {
    const root = makeFolder('高考复习');
    const child = makeFolder('函数', root);
    const nested = await makeNote('笔记标题', child);
    const rootNote = await makeNote('根笔记', null);

    expect(await invoke('vfs_get_resource_path', { sourceId: nested })).toBe('/高考复习/函数/笔记标题');
    expect(await invoke('vfs_get_resource_path', { sourceId: rootNote })).toBe('/根笔记');
    // 首次查询写入缓存
    expect(cachedPath(nested)).toBe('/高考复习/函数/笔记标题');
  });

  it('test_source_id_prefix_parsing', async () => {
    // Prefix parsing now belongs to L11. Exercise its observable title/fallback
    // behavior through the command rather than retaining a test-only parser.
    for (const sourceId of ['note_abc123', 'tb_def456', 'exam_ghi789', 'tr_jkl012', 'essay_mno345', 'noseparator']) {
      expect(await invoke('vfs_get_resource_path', { sourceId })).toBe(`/${sourceId}`);
    }

    // 未分配到文件夹的资源：按前缀解析标题，缺失时回退到 source_id
    const note = await makeNote('笔记标题', null);
    expect(await invoke('vfs_get_resource_path', { sourceId: note })).toBe('/笔记标题');

    // Legacy textbook row with the Rust test's tb_def456 id: handlers.rs:1268-1275 reads files.file_name.
    db().run(`INSERT INTO files (id, sha256, file_name, size, type, mime_type, tags_json, bookmarks_json, status, created_at, updated_at)
      VALUES ('tb_def456', 'sha_legacy_tb', '教材.pdf', 10, 'textbook', 'application/pdf', '[]', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    expect(await invoke('vfs_get_resource_path', { sourceId: 'tb_def456' })).toBe('/教材.pdf');

    // textbook_repo.rs:136-137 creates modern `file_` ids (Migration032); handlers.rs:1259-1303
    // has no `file` arm, so `_ => None` falls back to the id.
    const textbook = repos().textbooks.createTextbook(db(), 'sha_path', '教材.pdf', 10, null, null);
    expect(textbook.id).toMatch(/^file_/);
    expect(await invoke('vfs_get_resource_path', { sourceId: textbook.id })).toBe(`/${textbook.id}`);

    const exam = repos().exams.createExamSheet(db(), {
      examName: null, tempId: 'temp_path', metadataJson: {}, previewJson: { pages: [] },
      status: 'completed', folderId: null,
    });
    expect(await invoke('vfs_get_resource_path', { sourceId: exam.id })).toBe(`/${exam.id}`);

    const translation = repos().translations.createTranslation(db(), {
      source: 's', translated: 't', srcLang: 'zh', tgtLang: 'en',
    });
    expect(await invoke('vfs_get_resource_path', { sourceId: translation.id })).toBe(`/${translation.id}`);

    const essay = repos().essays.createEssay(db(), { content: '正文' });
    expect(await invoke('vfs_get_resource_path', { sourceId: essay.id })).toBe(`/${essay.id}`);

    expect(await invoke('vfs_get_resource_path', { sourceId: 'note_missing' })).toBe('/note_missing');
  });

  it('test_folder_id_format_validation', async () => {
    const root = makeFolder('合法文件夹');
    expect(await invoke('vfs_update_path_cache', { folderId: root })).toBe(0);
    for (const bad of ['note_abc123', 'folder_abc123', 'abc123']) {
      await expect(invoke('vfs_update_path_cache', { folderId: bad }))
        .rejects.toBe(`Invalid argument 'folder_id': Invalid folder ID format: ${bad}`);
    }
  });

  it('test_path_length_constraint', async () => {
    // 契约 D：最大 1000 字符（UTF-8 字节）
    const maxPathLength = 1000;
    expect(Buffer.byteLength('/文件夹/笔记', 'utf8')).toBeLessThanOrEqual(maxPathLength);

    const root = makeFolder('长路径');
    const child = makeFolder('子目录', root);
    const longNote = await makeNote('笔'.repeat(400), child);
    const longPath = await invoke<string>('vfs_get_resource_path', { sourceId: longNote });
    expect(longPath.startsWith('/')).toBe(true);
    expect(Buffer.byteLength(longPath, 'utf8')).toBeGreaterThan(maxPathLength);
    // 超长路径不写缓存
    expect(cachedPath(longNote)).toBeNull();

    const shortNote = await makeNote('短笔记', child);
    const shortPath = await invoke<string>('vfs_get_resource_path', { sourceId: shortNote });
    expect(Buffer.byteLength(shortPath, 'utf8')).toBeLessThanOrEqual(maxPathLength);
    expect(cachedPath(shortNote)).toBe(shortPath);
    // 批量更新时跳过超长项，只统计写入的项
    expect(await invoke('vfs_update_path_cache', { folderId: root })).toBe(1);
    expect(cachedPath(longNote)).toBeNull();
  });

  it('vfs_get_resource_path returns the cached path and recomputes on update', async () => {
    const root = makeFolder('项目');
    const child = makeFolder('阶段一', root);
    const note = await makeNote('初稿', child);
    expect(await invoke('vfs_get_resource_path', { sourceId: note })).toBe('/项目/阶段一/初稿');

    // 标题变化后仍返回旧缓存（Rust 只在缓存缺失或批量更新时重算）
    await invoke('vfs_update_note', { id: note, params: { content: 'new', title: '定稿' } });
    expect(await invoke('vfs_get_resource_path', { sourceId: note })).toBe('/项目/阶段一/初稿');

    expect(await invoke('vfs_update_path_cache', { folderId: child })).toBe(1);
    expect(cachedPath(note)).toBe('/项目/阶段一/定稿');
    expect(await invoke('vfs_get_resource_path', { sourceId: note })).toBe('/项目/阶段一/定稿');
  });

  it('vfs_update_path_cache follows folder moves for the whole subtree', async () => {
    const from = makeFolder('旧根');
    const moved = makeFolder('移动中', from);
    const nested = makeFolder('子级', moved);
    const noteA = await makeNote('甲', moved);
    const noteB = await makeNote('乙', nested);
    expect(await invoke('vfs_update_path_cache', { folderId: from })).toBe(2);
    expect(cachedPath(noteA)).toBe('/旧根/移动中/甲');
    expect(cachedPath(noteB)).toBe('/旧根/移动中/子级/乙');

    const target = makeFolder('新根');
    repos().folders.moveFolder(db(), moved, target);
    expect(await invoke('vfs_update_path_cache', { folderId: moved })).toBe(2);
    expect(cachedPath(noteA)).toBe('/新根/移动中/甲');
    expect(cachedPath(noteB)).toBe('/新根/移动中/子级/乙');
    expect(await invoke('vfs_get_resource_path', { sourceId: noteB })).toBe('/新根/移动中/子级/乙');
  });

  it('rolls back the whole subtree when a later path-cache write fails', async () => {
    const root = makeFolder('回滚');
    const first = await makeNote('甲', root);
    const second = await makeNote('乙', root);
    db().exec(`CREATE TRIGGER reject_second_cache BEFORE UPDATE OF cached_path ON folder_items
      WHEN NEW.item_id = '${second}' BEGIN SELECT RAISE(ABORT, 'cache write rejected'); END;`);
    await expect(invoke('vfs_update_path_cache', { folderId: root })).rejects.toBe('Update cached_path failed: cache write rejected');
    expect(cachedPath(first)).toBeNull();
    expect(cachedPath(second)).toBeNull();
    db().exec('DROP TRIGGER reject_second_cache');
    expect(await invoke('vfs_update_path_cache', { folderId: root })).toBe(2);
    expect(cachedPath(first)).toBe('/回滚/甲');
    expect(cachedPath(second)).toBe('/回滚/乙');
  });

  it('uses the real eight-method provider without advertising L17 attachment configuration', async () => {
    expect(vfs.host.ctx.vfsMaintenance).toBeDefined();
    expect(vfs.host.ctx.vfsMaintenance).not.toHaveProperty('getOrCreateAttachmentRootFolder');
    await expect(invoke('vfs_get_or_create_attachment_root_folder')).rejects.toBe('memoryConfig is required for attachment configuration');
  });
});
