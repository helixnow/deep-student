import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
// boundary-allow cross-plugin-impl: 安装真实 L14 qbank 插件，exam_sheets 级联经其正式 examCascade 服务
import qbankPlugin from '../../qbank/index.ts';

describe('dstu_copy', { timeout: 60_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-copy-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-copy-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({
      plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, qbankPlugin, plugin],
      provide: { storage },
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
  const createFolder = async (title: string, parentId?: string): Promise<VfsFolder> =>
    invoke<VfsFolder>('dstu_folder_create', {
      title,
      ...(parentId === undefined ? {} : { parentId }),
    });
  const copy = (src: string, dst: string) => invoke<DstuNode>('dstu_copy', { src, dst });

  it('copies a note into a destination folder with the Rust suffix and tags', async () => {
    const folder = await createFolder('目标');
    const source = await create({
      type: 'note', name: '原笔记', content: '正文', metadata: { tags: ['数学'] },
    });

    const copied = await copy(source.id, folder.id);
    expect(copied.id).not.toBe(source.id);
    expect(copied).toMatchObject({
      name: '原笔记 (副本)',
      type: 'note',
      path: `/${copied.id}`,
      previewType: 'markdown',
    });
    expect(copied.metadata).toMatchObject({ tags: ['数学'] });
    expect(conn.pluck<string>(
      'SELECT r.data FROM resources r JOIN notes n ON n.resource_id = r.id WHERE n.id = ?1',
      [copied.id],
    )).toBe('正文');
    expect(conn.get<{ folder_id: string | null; item_type: string }>(
      `SELECT folder_id, item_type FROM folder_items
        WHERE item_id = ?1 AND deleted_at IS NULL`, [copied.id]))
      .toMatchObject({ folder_id: folder.id, item_type: 'note' });

    const created = (host.eventsNamed('dstu:change') as Array<{ type: string; path: string; node?: DstuNode }>)
      .filter(event => event.type === 'created' && event.node?.id === copied.id);
    expect(created.at(-1)).toMatchObject({ path: `/${copied.id}` });
    // The source row is untouched.
    expect(conn.pluck<string>('SELECT title FROM notes WHERE id = ?1', [source.id])).toBe('原笔记');
  });

  it('copies translations, mindmaps, essays, exams and textbooks with their content', async () => {
    const folder = await createFolder('混合');
    const translation = await create({
      type: 'translation',
      name: '译稿',
      metadata: { sourceText: 'hello', translatedText: '你好', srcLang: 'en', tgtLang: 'zh' },
    });
    const translationCopy = await copy(translation.id, folder.id);
    expect(translationCopy).toMatchObject({ name: '译稿 (副本)', type: 'translation' });
    expect(conn.pluck<string>(
      'SELECT r.data FROM resources r JOIN translations t ON t.resource_id = r.id WHERE t.id = ?1',
      [translationCopy.id],
    )).toBe('{"source":"hello","translated":"你好"}');

    const mindmap = await create({
      type: 'mindmap',
      name: '导图',
      content: '{"root":{"id":"root","text":"根","children":[]}}',
      metadata: { description: '说明', theme: 'dark' },
    });
    const mindmapCopy = await copy(mindmap.id, folder.id);
    expect(mindmapCopy).toMatchObject({ name: '导图 (副本)', type: 'mindmap' });
    expect(conn.pluck<string>(
      'SELECT r.data FROM resources r JOIN mindmaps m ON m.resource_id = r.id WHERE m.id = ?1',
      [mindmapCopy.id],
    )).toBe(conn.pluck<string>(
      'SELECT r.data FROM resources r JOIN mindmaps m ON m.resource_id = r.id WHERE m.id = ?1',
      [mindmap.id],
    ));
    expect(conn.get<{ description: string; theme: string }>(
      'SELECT description, theme FROM mindmaps WHERE id = ?1', [mindmapCopy.id]))
      .toMatchObject({ description: '说明', theme: 'dark' });

    const essay = await create({
      type: 'essay',
      name: '作文',
      metadata: { essayType: 'argument', gradeLevel: 'high_school', customPrompt: 'prompt' },
    });
    const essayCopy = await copy(essay.id, folder.id);
    expect(essayCopy).toMatchObject({ name: '作文 (副本)', type: 'essay' });
    expect(conn.get<{ essay_type: string; grade_level: string; custom_prompt: string; total_rounds: number }>(
      'SELECT essay_type, grade_level, custom_prompt, total_rounds FROM essay_sessions WHERE id = ?1',
      [essayCopy.id]))
      .toMatchObject({
        essay_type: 'argument', grade_level: 'high_school', custom_prompt: 'prompt', total_rounds: 0,
      });

    const exam = await create({ type: 'exam', name: '试卷' });
    const examCopy = await copy(exam.id, folder.id);
    expect(examCopy).toMatchObject({ name: '试卷 (副本)', type: 'exam' });
    expect(conn.get<{ folder_id: string | null }>(
      `SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = 'exam' AND deleted_at IS NULL`,
      [examCopy.id])).toMatchObject({ folder_id: folder.id });

    // Rust infers `tb_*` ids as "files" (handler_utils/path_utils.rs:90-98), so
    // the textbook is copied through VfsFileRepo::copy_file_with_conn.
    conn.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, "type", mime_type, tags_json,
                          is_favorite, status, created_at, updated_at)
       VALUES ('tb_copyfixture', NULL, 'sha_tb_fixture', '书.pdf', 12, 'textbook', 'application/pdf',
               '[]', 0, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    const textbookCopy = await copy('tb_copyfixture', folder.id);
    expect(textbookCopy).toMatchObject({ name: '书.pdf (副本)', type: 'textbook', size: 12 });
    expect(conn.pluck<string>('SELECT sha256 FROM files WHERE id = ?1', [textbookCopy.id]))
      .toContain('sha_tb_fixture_copy_');
    expect(conn.get<{ folder_id: string | null; item_type: string }>(
      `SELECT folder_id, item_type FROM folder_items
        WHERE item_id = ?1 AND deleted_at IS NULL`, [textbookCopy.id]))
      .toMatchObject({ folder_id: folder.id, item_type: 'file' });
  });

  it('copies files and images into folders preserving the item type', async () => {
    const folder = await createFolder('附件');
    const file = await create({
      type: 'file', name: 'a.txt', fileBase64: Buffer.from('abc').toString('base64'),
    });
    const image = await create({
      type: 'image', name: '照片.png', fileBase64: Buffer.from('img').toString('base64'),
    });

    const fileCopy = await copy(file.id, folder.id);
    expect(fileCopy).toMatchObject({ name: 'a.txt (副本)', type: 'file' });
    expect(conn.get<{ folder_id: string | null; item_type: string }>(
      'SELECT folder_id, item_type FROM folder_items WHERE item_id = ?1 AND deleted_at IS NULL',
      [fileCopy.id])).toMatchObject({ folder_id: folder.id, item_type: 'file' });

    const imageCopy = await copy(image.id, folder.id);
    expect(imageCopy).toMatchObject({ name: '照片.png (副本)', type: 'image' });
    // `img_*` ids are inferred as "files" too, so the folder item stays "file".
    expect(conn.get<{ folder_id: string | null; item_type: string }>(
      'SELECT folder_id, item_type FROM folder_items WHERE item_id = ?1 AND deleted_at IS NULL',
      [imageCopy.id])).toMatchObject({ folder_id: folder.id, item_type: 'file' });
  });

  it('recursively copies folders, their subfolders and notes', async () => {
    const parent = await createFolder('原目录');
    const child = await createFolder('子目录', parent.id);
    const note = await create({
      type: 'note', name: '目录笔记', content: 'x', metadata: { folderId: parent.id },
    });
    const childNote = await create({
      type: 'note', name: '子笔记', content: 'y', metadata: { folderId: child.id },
    });
    const destination = await createFolder('归档');

    const copiedFolder = await copy(parent.id, destination.id);
    expect(copiedFolder).toMatchObject({ name: '原目录 (副本)', type: 'folder', path: `/${copiedFolder.id}` });
    expect(conn.get<{ parent_id: string }>('SELECT parent_id FROM folders WHERE id = ?1', [copiedFolder.id]))
      .toMatchObject({ parent_id: destination.id });

    const copiedChild = conn.get<{ id: string; parent_id: string; title: string }>(
      "SELECT id, parent_id, title FROM folders WHERE parent_id = ?1 AND title = '子目录'",
      [copiedFolder.id]);
    expect(copiedChild).toMatchObject({ parent_id: copiedFolder.id, title: '子目录' });

    const copiedNotes = conn.all<{ id: string; title: string; folder_id: string | null }>(
      `SELECT n.id, n.title, fi.folder_id FROM notes n
        JOIN folder_items fi ON fi.item_id = n.id AND fi.item_type = 'note' AND fi.deleted_at IS NULL
        WHERE n.title IN ('目录笔记', '子笔记') AND n.id NOT IN (?1, ?2)`, [note.id, childNote.id]);
    expect(copiedNotes).toHaveLength(2);
    expect(copiedNotes.find(row => row.title === '目录笔记')?.folder_id).toBe(copiedFolder.id);
    expect(copiedNotes.find(row => row.title === '子笔记')?.folder_id).toBe(copiedChild!.id);
  });

  it('rejects folder cycles, non-folder destinations and unknown sources', async () => {
    const parent = await createFolder('父');
    const child = await createFolder('子', parent.id);
    const note = await create({ type: 'note', name: '源', content: 'c' });

    await expect(copy(parent.id, parent.id))
      .rejects.toContain('Cannot copy a folder into itself or its subfolder');
    await expect(copy(parent.id, child.id))
      .rejects.toContain('Cannot copy a folder into itself or its subfolder');
    await expect(copy(note.id, note.id)).rejects.toContain('Destination must be a folder');
    await expect(copy(note.id, 'zzz_1'))
      .rejects.toContain('Invalid destination path: Invalid DSTU path: Path must contain a resource ID: zzz_1');
    await expect(copy('note_missing', '/')).rejects.toContain('Resource not found: note_missing');
    await expect(copy('res_1', '/')).rejects.toContain('Invalid node type: resources');
  });

  it('copies mindmaps atomically with their folder item, including root membership', async () => {
    const source = await create({ type: 'mindmap', name: '原图', content: '{"root":{"id":"root","text":"根"}}' });
    const count = conn.pluck<number>('SELECT COUNT(*) FROM mindmaps');
    await expect(copy(source.id, 'fld_missing')).rejects.toContain('fld_missing');
    expect(conn.pluck<number>('SELECT COUNT(*) FROM mindmaps')).toBe(count);
    const copied = await copy(source.id, '/');
    expect(conn.get('SELECT folder_id, item_type FROM folder_items WHERE item_id = ?1', [copied.id]))
      .toEqual({ folder_id: null, item_type: 'mindmap' });
  });
});
