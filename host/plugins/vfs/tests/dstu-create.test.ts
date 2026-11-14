import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { append, beginIn, STAGED_UPLOAD_MAX_BYTES, stagingDir } from '../../../platform/storage/staged-upload.ts';
import type { DstuNode, VfsFolder } from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';

describe('dstu_create', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-create-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-create-'));
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
  const createFolder = (title: string) => invoke<VfsFolder>('dstu_folder_create', { title });

  it('creates notes with tags, folder membership, resources and a created event', async () => {
    const folder = await createFolder('数学');
    const before = Date.now();
    const node = await create({
      type: 'note',
      name: '导数笔记',
      content: '导数的定义',
      metadata: { tags: ['数学', '复习'], folderId: folder.id },
    }, '/');

    expect(node).toMatchObject({
      name: '导数笔记',
      type: 'note',
      previewType: 'markdown',
      metadata: { isFavorite: false, tags: ['数学', '复习'], props: {} },
    });
    expect(node.path).toBe(`/${node.id}`);
    expect(node.id).toMatch(/^note_[A-Za-z0-9_-]{10}$/);
    expect(node.createdAt).toBeGreaterThanOrEqual(before - 1000);

    const stored = conn.get<{ title: string; tags: string; resource_id: string }>(
      'SELECT title, tags, resource_id FROM notes WHERE id = ?1', [node.id]);
    expect(stored).toMatchObject({
      title: '导数笔记', tags: JSON.stringify(['数学', '复习']), resource_id: node.resourceId,
    });
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [node.resourceId!]))
      .toBe('导数的定义');
    expect(conn.get<{ folder_id: string }>(
      'SELECT folder_id FROM folder_items WHERE item_id = ?1 AND item_type = ?2 AND deleted_at IS NULL',
      [node.id, 'note']))
      .toMatchObject({ folder_id: folder.id });

    const events = host.eventsNamed('dstu:change') as Array<{ type: string; path: string }>;
    expect(events.at(-1)).toMatchObject({ type: 'created', path: node.path });
    expect(host.eventsNamed(`dstu:change:${node.path}`)).toHaveLength(1);
  });

  it('falls back to Untitled, validates tags and resolves folderId from the path', async () => {
    const folder = await createFolder('语文');
    const node = await create({ type: 'note', name: '   ' }, `/${folder.id}`);
    expect(node.name).toBe('Untitled');

    await expect(create({ type: 'note', name: 'x', metadata: { tags: ['ok', 1] } }))
      .rejects.toBe('INVALID_ARGUMENT: metadata.tags 必须是字符串数组');
    await expect(create({ type: 'note', name: 'x', metadata: { tags: 'nope' } }))
      .rejects.toBe('INVALID_ARGUMENT: metadata.tags 必须是字符串数组');
    await expect(create({ type: 'note', name: 'x', metadata: { tags: ['a\nb'] } }))
      .rejects.toBe("Invalid argument 'tags': 标签不能包含控制字符");
    await expect(create({ type: 'note', name: 'bad\nname' }))
      .rejects.toBe("Invalid argument 'title': 标题不能包含换行等控制字符");
  });

  it('enforces name, content and metadata limits before touching the database', async () => {
    await expect(create({ type: 'note', name: 'a'.repeat(257) }))
      .rejects.toBe('名称长度超出限制: 257 字符 (最大允许: 256 字符)');
    await expect(create({ type: 'note', name: 'n', content: 'x'.repeat(1024 * 1024 + 1) }))
      .rejects.toBe(
        '内容大小超出限制: 1048577 字节 (1.00 MB) (最大允许: 1048576 字节 (1 MB))',
      );
    await expect(create({ type: 'note', name: 'n', metadata: { blob: 'x'.repeat(70_000) } }))
      .rejects.toBe(
        `元数据大小超出限制: ${JSON.stringify({ blob: 'x'.repeat(70_000) }).length} 字节 `
        + `(68.37 KB) (最大允许: 65536 字节 (64 KB))`,
      );
    expect(conn.pluck<number>('SELECT COUNT(*) FROM notes')).toBe(0);
  });

  it('creates translations, essays, exams and mindmaps with Rust metadata shapes', async () => {
    const folder = await createFolder('学习');
    const translation = await create({
      type: 'translation',
      name: '翻译标题',
      metadata: {
        sourceText: 'hello', translatedText: '你好', srcLang: 'en', tgtLang: 'zh',
        isFavorite: true, qualityRating: 4, folderId: folder.id,
      },
    });
    expect(translation).toMatchObject({
      name: '翻译标题', type: 'translation', previewType: 'markdown',
      metadata: {
        srcLang: 'en', tgtLang: 'zh', isFavorite: false, qualityRating: null,
      },
    });
    expect(conn.get<{ is_favorite: number; quality_rating: number }>(
      'SELECT is_favorite, quality_rating FROM translations WHERE id = ?1', [translation.id]))
      .toMatchObject({ is_favorite: 1, quality_rating: 4 });
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [translation.resourceId!]))
      .toBe('{"source":"hello","translated":"你好"}');

    const essay = await create({
      type: 'essay', name: '我的作文',
      metadata: { essayType: 'argument', gradeLevel: 'high_school', customPrompt: 'prompt' },
    });
    expect(essay).toMatchObject({
      name: '我的作文', type: 'essay', resourceId: essay.id,
      metadata: {
        essayType: 'argument', gradeLevel: 'high_school', totalRounds: 0, isFavorite: false,
      },
    });
    expect(essay.id).toMatch(/^essay_session_[A-Za-z0-9_-]{10}$/);
    expect(essay.path).toBe(`/${essay.id}`);

    const exam = await create({ type: 'exam', name: '' , metadata: { examName: '期中卷' } });
    expect(exam).toMatchObject({ name: '期中卷', type: 'exam', previewType: 'exam' });
    expect(exam.metadata).toMatchObject({
      status: 'empty',
      tempId: expect.stringMatching(/^temp_[0-9a-f-]{36}$/),
      linkedMistakeIds: null,
      isFavorite: false,
    });
    const examRow = conn.get<{ metadata_json: string; preview_json: string; status: string; resource_id: string }>(
      'SELECT metadata_json, preview_json, status, resource_id FROM exam_sheets WHERE id = ?1', [exam.id]);
    expect(JSON.parse(examRow!.metadata_json)).toEqual({
      status: 'empty', pageCount: 0, questionCount: 0,
    });
    expect(JSON.parse(examRow!.preview_json)).toEqual({
      temp_id: (exam.metadata as { tempId: string }).tempId, exam_name: '', pages: [],
    });
    expect(conn.pluck<string>('SELECT data FROM resources WHERE id = ?1', [examRow!.resource_id]))
      .toBe(examRow!.preview_json);

    const mindmap = await create({
      type: 'mindmap', name: '',
      content: JSON.stringify({ text: '根', children: [{ label: '子节点' }] }),
      metadata: { theme: 'dark', defaultView: 'mindmap', description: '导图' },
    });
    expect(mindmap).toMatchObject({
      name: '无标题导图', type: 'mindmap',
      metadata: { description: '导图', defaultView: 'mindmap', theme: 'dark', isFavorite: false },
    });
    const normalized = JSON.parse(conn.pluck<string>(
      'SELECT data FROM resources WHERE id = ?1', [mindmap.resourceId!])!);
    expect(normalized).toMatchObject({
      version: '1.0', root: { id: 'root', text: '根' },
    });
    expect(normalized.meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(normalized.root.children[0]).toMatchObject({ text: '子节点', children: [] });
    expect(normalized.root.children[0].id).toHaveLength(10);
  });

  it('stores base64 and staged files and images as blobs with folder membership', async () => {
    const folder = await createFolder('附件');
    const base64 = Buffer.from('hello world').toString('base64');
    const file = await create({
      type: 'file', name: '', fileBase64: base64,
      metadata: { mimeType: 'text/plain', folderId: folder.id },
    });
    expect(file).toMatchObject({
      name: 'unnamed.txt', type: 'file', size: 11, previewType: 'text',
    });
    const fileRow = conn.get<{
      file_name: string; sha256: string; blob_hash: string; mime_type: string; size: number;
    }>('SELECT file_name, sha256, blob_hash, mime_type, size FROM files WHERE id = ?1', [file.id]);
    expect(fileRow).toMatchObject({
      file_name: 'unnamed.txt', mime_type: 'text/plain', size: 11,
    });
    expect(fileRow!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fileRow!.blob_hash).toBe(fileRow!.sha256);
    expect(conn.get<{ ref_count: number }>('SELECT ref_count FROM blobs WHERE hash = ?1', [fileRow!.sha256]))
      .toMatchObject({ ref_count: 1 });
    expect(conn.get<{ folder_id: string; item_type: string }>(
      'SELECT folder_id, item_type FROM folder_items WHERE item_id = ?1 AND deleted_at IS NULL',
      [file.id])).toMatchObject({ folder_id: folder.id, item_type: 'file' });

    const image = await create({
      type: 'image', name: '照片', fileBase64: Buffer.from('img').toString('base64'),
      metadata: { mimeType: 'text/plain' },
    });
    expect(image).toMatchObject({ name: '照片', type: 'image' });
    expect(conn.pluck<string>('SELECT mime_type FROM files WHERE id = ?1', [image.id]))
      .toBe('image/jpeg');

    const uploadId = beginIn(stagingDir(root), 'staged.txt', 6, STAGED_UPLOAD_MAX_BYTES);
    append(uploadId, 0, Buffer.from('staged'));
    const staged = await create({
      type: 'file', name: 'staged.txt', stagedUploadId: uploadId,
    });
    expect(staged).toMatchObject({ name: 'staged.txt', size: 6 });

    await expect(create({ type: 'file', name: 'x.txt' }))
      .rejects.toBe('file_base64 is required for images/files creation');
    await expect(create({ type: 'file', name: 'x.txt', fileBase64: '!!!!' }))
      .rejects.toBe('Invalid base64 data: Invalid symbol 33, offset 0.');
  });

  it('rolls back owner mindmap, resource and membership writes before emitting created', async () => {
    const folder = await createFolder('原子创建');
    const eventCount = host.eventsNamed('dstu:change').length;
    const resourcesBefore = conn.pluck<number>('SELECT COUNT(*) FROM resources');
    conn.exec(`CREATE TRIGGER reject_mindmap_membership BEFORE INSERT ON folder_items
      WHEN NEW.item_type = 'mindmap' BEGIN SELECT RAISE(ABORT, 'membership rejected'); END;`);
    const options = { type: 'mindmap', name: '回滚导图', content: '{"root":{"id":"root","text":"原子"}}',
      metadata: { folderId: folder.id } };
    await expect(create(options)).rejects.toBe('Database error: membership rejected');
    expect(conn.pluck<number>('SELECT COUNT(*) FROM mindmaps')).toBe(0);
    expect(conn.pluck<number>('SELECT COUNT(*) FROM resources')).toBe(resourcesBefore);
    expect(conn.pluck<number>("SELECT COUNT(*) FROM folder_items WHERE item_type = 'mindmap'")).toBe(0);
    expect(host.eventsNamed('dstu:change')).toHaveLength(eventCount);

    conn.exec('DROP TRIGGER reject_mindmap_membership');
    const node = await create(options);
    expect(conn.get('SELECT resource_id FROM mindmaps WHERE id = ?1', [node.id]))
      .toEqual({ resource_id: node.resourceId });
    expect(conn.get('SELECT folder_id FROM folder_items WHERE item_id = ?1', [node.id]))
      .toEqual({ folder_id: folder.id });
    expect(host.eventsNamed('dstu:change')).toHaveLength(eventCount + 1);
  });

  it('reports unsupported types, textbook uploads and missing folders', async () => {
    await expect(create({ type: 'textbook', name: 'book.pdf' }))
      .rejects.toBe(
        'Textbook creation requires file upload, use textbooks_add or vfs_upload_file instead',
      );
    await expect(create({ type: 'retrieval', name: 'r' }))
      .rejects.toBe('Unsupported resource type: Retrieval');
    await expect(create({ type: 'folder', name: 'f' }))
      .rejects.toBe('Invalid node type: folders');
    await expect(create({ type: 'note', name: 'n', metadata: { folderId: 'fld_missing' } }))
      .rejects.toBe('Folder not found: fld_missing');
    expect(conn.pluck<number>('SELECT COUNT(*) FROM folder_items')).toBe(0);
  });
});
