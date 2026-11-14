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

describe('dstu_get and dstu_get_resource_by_path', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-get-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-get-'));
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
  const iso = '2026-01-15T10:30:00.000Z';
  const seedResource = (id: string, data: string | null) => conn.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
     VALUES (?1, ?2, 'note', 'inline', ?3, 0, 1, 1)`,
    [id, `hash_${id}`, data],
  );
  const seedNote = (id: string, props: string | null, deleted: string | null = null) => {
    seedResource(`res_${id}`, null);
    conn.run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props)
       VALUES (?1, ?2, ?3, '["math"]', 1, ?4, ?4, ?5, ?6)`,
      [id, `res_${id}`, `笔记 ${id}`, iso, deleted, props],
    );
  };
  const seedFile = (id: string, fileName: string, type: string, mime: string | null, deleted: string | null = null) => conn.run(
    `INSERT INTO files (id, sha256, file_name, size, type, mime_type, tags_json, bookmarks_json, status, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, 9, ?4, ?5, '[]', '[]', 'active', ?6, ?6, ?7)`,
    [id, `sha_${id}`, fileName, type, mime, iso, deleted],
  );
  const seedExam = (id: string, name: string | null, deleted: string | null = null) => conn.run(
    `INSERT INTO exam_sheets (id, resource_id, exam_name, status, temp_id, metadata_json, preview_json, linked_mistake_ids, is_favorite, created_at, updated_at, deleted_at)
     VALUES (?1, NULL, ?2, 'completed', 'temp', '{"pages":1}', '{"cards":[]}', '["q_1"]', 0, ?3, ?3, ?4)`,
    [id, name, iso, deleted],
  );
  const seedTranslation = (id: string, data: string | null) => {
    seedResource(`res_${id}`, data);
    conn.run(
      `INSERT INTO translations (id, resource_id, title, src_lang, tgt_lang, engine, model, is_favorite, quality_rating, created_at, updated_at, metadata_json)
       VALUES (?1, ?2, NULL, 'en', 'zh', 'engine', 'model', 1, 4, ?3, ?3, '{"k":1}')`,
      [id, `res_${id}`, iso],
    );
  };
  const seedEssay = (id: string, deleted: string | null = null) => {
    seedResource(`res_${id}`, 'essay body');
    conn.run(
      `INSERT INTO essays (id, resource_id, title, essay_type, grading_result_json, score, round_number, is_favorite, created_at, updated_at, deleted_at)
       VALUES (?1, ?2, ?3, 'argument', '{"grade":"A"}', 88, 2, 1, ?4, ?4, ?5)`,
      [id, `res_${id}`, `作文 ${id}`, iso, deleted],
    );
  };
  const seedSession = (id: string) => conn.run(
    `INSERT INTO essay_sessions (id, title, essay_type, grade_level, custom_prompt, total_rounds, latest_score, is_favorite, created_at, updated_at)
     VALUES (?1, '会话', 'argument', 'high_school', NULL, 2, 90, 1, ?2, ?2)`,
    [id, iso],
  );
  const seedMindmap = (id: string) => {
    seedResource(`res_${id}`, '{}');
    conn.run(
      `INSERT INTO mindmaps (id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at)
       VALUES (?1, ?2, '导图', '描述', 1, 'mindmap', 'dark', '{"node":1}', ?3, ?3)`,
      [id, `res_${id}`, iso],
    );
  };

  it('dstu_get resolves every supported resource type through extract_resource_info', async () => {
    seedNote('note_1', '{"a":1}');
    const note = await invoke<DstuNode>('dstu_get', { path: '/note_1' });
    expect(note).toMatchObject({
      id: 'note_1', path: '/note_1', name: '笔记 note_1', type: 'note',
      resourceId: 'res_note_1', previewType: 'markdown',
      metadata: { isFavorite: true, tags: ['math'], props: { a: 1 } },
    });
    expect((await invoke<DstuNode>('dstu_get', { path: 'note_1' }))!.id).toBe('note_1');
    expect((await invoke<DstuNode>('dstu_get', { path: '/文件夹/note_1' }))!.id).toBe('note_1');

    seedFile('file_1', 'notes.txt', 'document', null);
    expect(await invoke<DstuNode>('dstu_get', { path: '/file_1' })).toMatchObject({
      id: 'file_1', type: 'file', previewType: 'text', resourceId: 'sha_file_1',
      metadata: { fileType: 'document', mimeType: null, size: 9 },
    });

    seedExam('exam_1', '期中');
    expect(await invoke<DstuNode>('dstu_get', { path: '/exam_1' })).toMatchObject({
      id: 'exam_1', name: '期中', type: 'exam',
      metadata: { status: 'completed', linkedMistakeIds: ['q_1'], isFavorite: false },
    });

    seedTranslation('tr_1', '{"source":"hello","translated":"你好"}');
    expect(await invoke<DstuNode>('dstu_get', { path: '/tr_1' })).toMatchObject({
      id: 'tr_1', name: 'tr_1', type: 'translation',
      metadata: { srcLang: 'en', tgtLang: 'zh', title: null, sourceText: 'hello', translatedText: '你好' },
    });

    seedEssay('essay_1');
    expect(await invoke<DstuNode>('dstu_get', { path: '/essay_1' })).toMatchObject({
      id: 'essay_1', name: '作文 essay_1', type: 'essay',
      metadata: { essayType: 'argument', score: 88, gradingResult: { grade: 'A' } },
    });

    seedSession('essay_session_1');
    expect(await invoke<DstuNode>('dstu_get', { path: '/essay_session_1' })).toMatchObject({
      id: 'essay_session_1', name: '会话', type: 'essay', resourceId: 'essay_session_1',
      metadata: { totalRounds: 2, latestScore: 90 },
    });

    const folder = await invoke<VfsFolder>('dstu_folder_create', { title: '资料' });
    expect(await invoke<DstuNode>('dstu_get', { path: `/${folder.id}` })).toMatchObject({
      id: folder.id, path: `/${folder.id}`, name: '资料', type: 'folder', createdAt: folder.createdAt,
    });

    seedMindmap('mm_1');
    expect(await invoke<DstuNode>('dstu_get', { path: '/mm_1' })).toMatchObject({
      id: 'mm_1', name: '导图', type: 'mindmap',
      metadata: { description: '描述', defaultView: 'mindmap', theme: 'dark' },
    });
  });

  it('dstu_get keeps Rust visibility rules and errors for unknown or folder-only paths', async () => {
    seedNote('note_deleted', null, iso);
    expect(await invoke('dstu_get', { path: '/note_deleted' })).toBeNull();

    seedFile('file_deleted', 'gone.txt', 'document', null, iso);
    expect(await invoke<DstuNode>('dstu_get', { path: '/file_deleted' })).toMatchObject({ id: 'file_deleted' });

    seedExam('exam_deleted', null, iso);
    expect(await invoke('dstu_get', { path: '/exam_deleted' })).toBeNull();
    expect(await invoke('dstu_get', { path: '/note_missing' })).toBeNull();

    await expect(invoke('dstu_get', { path: '/zzz_1' })).rejects.toBe('Invalid DSTU path: Path must contain a resource ID: /zzz_1');
    await expect(invoke('dstu_get', { path: '/文件夹' })).rejects.toBe('Invalid DSTU path: Path must contain a resource ID: /文件夹');
  });

  it('dstu_get falls back to other tables for UUID ids whose folder is missing', async () => {
    const uuid = 'b11cf4a3-9ef0-4580-8fca-f9f8d09dffbf';
    seedFile(uuid, 'legacy.pdf', 'document', 'application/pdf');
    const node = await invoke<DstuNode>('dstu_get', { path: `/${uuid}` });
    expect(node).toMatchObject({ id: uuid, type: 'textbook', previewType: 'pdf' });
  });

  it('dstu_get_resource_by_path handles roots, virtual paths, sessions and folder-only paths', async () => {
    expect(await invoke<DstuNode>('dstu_get_resource_by_path', { path: '/' })).toMatchObject({
      id: 'root', path: '/', name: '根目录', type: 'folder',
    });
    expect(await invoke<DstuNode>('dstu_get_resource_by_path', { path: '/@trash' })).toMatchObject({
      id: '@trash', path: '/@trash', name: 'trash', type: 'folder',
    });
    expect(await invoke('dstu_get_resource_by_path', { path: '/文件夹' })).toBeNull();

    seedNote('note_1', null);
    expect(await invoke<DstuNode>('dstu_get_resource_by_path', { path: '/note_1' })).toMatchObject({
      id: 'note_1', type: 'note', metadata: { props: {} },
    });

    seedFile('tb_1', 'book.pdf', 'document', 'application/pdf');
    expect(await invoke<DstuNode>('dstu_get_resource_by_path', { path: '/tb_1' })).toMatchObject({
      id: 'tb_1', type: 'textbook', previewType: 'pdf',
    });

    seedSession('essay_session_1');
    expect(await invoke<DstuNode>('dstu_get_resource_by_path', { path: '/essay_session_1' })).toMatchObject({
      id: 'essay_session_1', type: 'essay', name: '会话',
    });

    seedEssay('essay_1');
    expect(await invoke('dstu_get_resource_by_path', { path: '/essay_1' })).toBeNull();

    const folder = await invoke<VfsFolder>('dstu_folder_create', { title: '路径' });
    expect(await invoke<DstuNode>('dstu_get_resource_by_path', { path: `/路径/${folder.id}` })).toMatchObject({
      id: folder.id, path: `/路径/${folder.id}`, name: '路径', type: 'folder',
    });
  });
});
