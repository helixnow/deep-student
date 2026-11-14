import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { DstuNode, VfsFolder } from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';

describe('dstu_move and dstu_rename', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-move-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-move-'));
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
  const create = (options: Record<string, unknown>, target = '/') => invoke<DstuNode>('dstu_create', {
    path: target,
    options,
  });
  const createFolder = (title: string, parentId?: string) => invoke<VfsFolder>(
    'dstu_folder_create', { title, ...(parentId === undefined ? {} : { parentId }) });
  const move = (src: string, dst: string) => invoke<DstuNode>('dstu_move', { src, dst });
  const rename = (target: string, newName: string) => invoke<DstuNode>('dstu_rename', {
    path: target,
    newName,
  });

  function insertFile(id: string, fileName: string, fileType: string): void {
    const now = new Date().toISOString();
    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data,
                              metadata_json, ref_count, created_at, updated_at)
       VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', NULL, 0, 1, 1)`,
      [`res_${id}`, createHash('sha256').update(id).digest('hex'), id],
    );
    conn.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, "type", mime_type, tags_json,
                          is_favorite, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 10, ?5, NULL, '[]', 0, 'active', ?6, ?6)`,
      [id, `res_${id}`, createHash('sha256').update(id).digest('hex'), fileName, fileType, now],
    );
  }

  it('moves notes between folders, to the root and reports the moved event', async () => {
    const source = await createFolder('源');
    const target = await createFolder('目标');
    const note = await create({
      type: 'note', name: '移动', content: 'x', metadata: { folderId: source.id },
    });
    conn.run("UPDATE resources SET index_state = 'indexed' WHERE id = ?1", [note.resourceId!]);

    const moved = await move(`/${note.id}`, `/${target.id}`);
    expect(moved.id).toBe(note.id);
    expect(moved.path).toBe(`/${note.id}`);
    const row = conn.get<{ folder_id: string; cached_path: string | null; deleted_at: string | null }>(
      'SELECT folder_id, cached_path, deleted_at FROM folder_items WHERE item_id = ?1 AND item_type = ?2',
      [note.id, 'note']);
    expect(row).toMatchObject({ folder_id: target.id, cached_path: null, deleted_at: null });
    expect(conn.pluck<string>('SELECT index_state FROM resources WHERE id = ?1', [note.resourceId!]))
      .toBe('pending');

    const events = host.eventsNamed('dstu:change') as Array<{ type: string; path: string; oldPath?: string }>;
    expect(events.at(-1)).toMatchObject({
      type: 'moved', path: `/${note.id}`, oldPath: `/${note.id}`,
    });

    const rooted = await move(note.id, '/');
    expect(rooted.path).toBe(`/${note.id}`);
    expect(conn.pluck<string | null>(
      'SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = ?2', [note.id, 'note']))
      .toBeNull();

    await expect(move(note.id, `/${note.id}`)).rejects.toBe('Destination must be a folder');
    await expect(move('zzz_1', '/')).rejects.toBe(
      'Invalid DSTU path: Path must contain a resource ID: zzz_1',
    );
    await expect(move('res_1', '/')).rejects.toBe('Invalid node type: resources');
  });

  it('moves essay sessions, mindmaps and files by their canonical item type', async () => {
    const folder = await createFolder('统一');
    const session = await create({ type: 'essay', name: '会话' });
    const mindmap = await create({
      type: 'mindmap', name: '导图', content: '{"root":{"id":"root","text":"根"}}',
    });
    const file = await create({
      type: 'file', name: 'f.txt', fileBase64: Buffer.from('x').toString('base64'),
    });

    await move(session.id, folder.id);
    expect(conn.pluck<string>(
      'SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = ?2',
      [session.id, 'essay'])).toBe(folder.id);

    await move(mindmap.id, folder.id);
    expect(conn.pluck<string>(
      'SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = ?2',
      [mindmap.id, 'mindmap'])).toBe(folder.id);

    await move(file.id, folder.id);
    expect(conn.pluck<string>(
      'SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = ?2',
      [file.id, 'file'])).toBe(folder.id);
  });

  it('renames notes and validates the title exactly like the note repository', async () => {
    const folder = await createFolder('数学');
    const note = await create({
      type: 'note', name: '旧名', content: 'x', metadata: { folderId: folder.id },
    });
    conn.run('UPDATE folder_items SET cached_path = ?1 WHERE item_id = ?2', ['/缓存', note.id]);

    const renamed = await rename(`/fld_x/notes/${note.id}`, '新名');
    expect(renamed).toMatchObject({
      id: note.id, name: '新名', type: 'note', previewType: 'markdown',
      metadata: { isFavorite: false, tags: [], props: {} },
    });
    expect(renamed.updatedAt).toBeGreaterThan(note.updatedAt);
    expect(conn.get<{ title: string; updated_at: string }>(
      'SELECT title, updated_at FROM notes WHERE id = ?1', [note.id]))
      .toEqual({ title: '新名', updated_at: new Date(renamed.updatedAt).toISOString() });
    const events = host.eventsNamed('dstu:change') as Array<{ type: string; path: string }>;
    expect(events.at(-1)).toMatchObject({ type: 'updated', path: `/fld_x/notes/${note.id}` });
    expect(host.eventsNamed(`dstu:change:/fld_x/notes/${note.id}`)).toHaveLength(1);

    await expect(rename(note.id, '')).rejects.toBe("Invalid argument 'title': 标题不能为空");
    await expect(rename('note_missing', 'x')).rejects.toBe('Note not found: note_missing');
    await expect(rename('res_1', 'x')).rejects.toBe('Invalid node type: resources');
  });

  it('renames exams, translations, essay sessions and mindmaps with their repository shapes', async () => {
    const exam = await create({ type: 'exam', name: '旧卷' });
    const renamedExam = await rename(exam.id, '新卷');
    expect(renamedExam).toMatchObject({
      id: exam.id, name: '新卷', type: 'exam', previewType: 'exam',
      metadata: { status: 'empty', isFavorite: false },
    });

    const translation = await create({
      type: 'translation', name: '旧译', metadata: { sourceText: 'a', translatedText: 'b' },
    });
    const beforeVersion = conn.pluck<number>(
      'SELECT local_version FROM translations WHERE id = ?1', [translation.id])!;
    const renamedTranslation = await rename(translation.id, '新译');
    expect(renamedTranslation).toMatchObject({ id: translation.id, name: '新译', type: 'translation' });
    expect(conn.pluck<number>('SELECT local_version FROM translations WHERE id = ?1', [translation.id]))
      .toBe(beforeVersion + 1);

    const session = await create({
      type: 'essay', name: '旧作文', metadata: { essayType: 'argument', gradeLevel: 'high' },
    });
    const renamedSession = await rename(session.id, '新作文');
    expect(renamedSession).toMatchObject({
      id: session.id, name: '新作文', type: 'essay', resourceId: session.id,
      metadata: { totalRounds: 0, isFavorite: false },
    });
    expect(Object.keys(renamedSession.metadata as Record<string, unknown>).sort())
      .toEqual(['isFavorite', 'totalRounds']);

    const mindmap = await create({
      type: 'mindmap', name: '旧图', content: '{"root":{"id":"root","text":"根"}}',
    });
    const before = conn.get<{ content_updated_at: string }>(
      'SELECT content_updated_at FROM mindmaps WHERE id = ?1', [mindmap.id]);
    const renamedMindmap = await rename(mindmap.id, '新图');
    expect(renamedMindmap).toMatchObject({ id: mindmap.id, name: '新图', type: 'mindmap' });
    expect(conn.get<{ title: string; content_updated_at: string }>(
      'SELECT title, content_updated_at FROM mindmaps WHERE id = ?1', [mindmap.id]))
      .toEqual({ title: '新图', content_updated_at: before!.content_updated_at });
  });

  it('renames files, textbooks and folders with cached path invalidation', async () => {
    const file = await create({
      type: 'file', name: 'old.txt', fileBase64: Buffer.from('x').toString('base64'),
    });
    const renamedFile = await rename(file.id, 'new.txt');
    expect(renamedFile).toMatchObject({ id: file.id, name: 'new.txt', type: 'file' });
    expect(conn.pluck<string>('SELECT file_name FROM files WHERE id = ?1', [file.id]))
      .toBe('new.txt');

    insertFile('tb_book', 'book.pdf', 'textbook');
    const renamedTextbook = await rename('tb_book', 'renamed.pdf');
    expect(renamedTextbook).toMatchObject({
      id: 'tb_book', name: 'renamed.pdf', type: 'textbook', previewType: 'pdf',
    });
    await expect(rename('tb_missing', 'x')).rejects.toBe('File not found: tb_missing');

    const folder = await createFolder('旧文件夹');
    const child = await createFolder('子', folder.id);
    const note = await create({ type: 'note', name: 'n', metadata: { folderId: child.id } });
    conn.run("UPDATE folder_items SET cached_path = '/旧' WHERE item_id = ?1", [note.id]);
    const renamedFolder = await rename(folder.id, '新文件夹');
    expect(renamedFolder).toMatchObject({
      id: folder.id,
      name: '新文件夹',
      type: 'folder',
      previewType: 'none',
      metadata: {
        isExpanded: true, isFavorite: false, icon: null, color: null,
      },
    });
    expect(conn.pluck<string>('SELECT title FROM folders WHERE id = ?1', [folder.id]))
      .toBe('新文件夹');
    expect(conn.pluck<string | null>('SELECT cached_path FROM folder_items WHERE item_id = ?1', [note.id]))
      .toBeNull();
    await expect(rename('fld_missing', 'x')).rejects.toBe('Resource not found: fld_missing');
  });
});
