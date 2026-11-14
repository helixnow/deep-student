import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { getContentByType, type DstuNode, type VfsFolder } from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';
import { notesRepository } from '../repository/services.ts';

describe('dstu_get_content, dstu_search and dstu_search_in_folder', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-content-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-content-'));
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
  const create = (title: string) => invoke<VfsFolder>('dstu_folder_create', { title });
  const iso = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;

  it('note_prop_and_folder_filters_are_applied_before_limit', async () => {
    const folder = await create('Target folder');
    const repo = notesRepository();
    const target = repo.createNote({ title: 'Old target', content: 'body', tags: [] }, conn);
    repo.setNoteProps(target.id, { status: 'done' }, conn);
    await invoke('dstu_folder_add_item', { folderId: folder.id, itemType: 'note', itemId: target.id });
    for (let index = 0; index < 55; index++) {
      const note = repo.createNote({ title: `New outside ${String(index).padStart(2, '0')}`, content: 'body', tags: [] }, conn);
      repo.setNoteProps(note.id, { status: 'done' }, conn);
    }
    conn.run("UPDATE notes SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1", [target.id]);
    const results = await invoke<DstuNode[]>('dstu_search', { query: '', options: {
      folderId: folder.id, types: ['note', 'mindmap'], propFilters: [{ key: 'status', value: 'done' }], limit: 1,
    } });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(target.id);
  });
  const seedResource = (
    id: string,
    data: string,
    options: { type?: string; sourceId?: string | null; sourceTable?: string | null } = {},
  ) => conn.run(
    `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'inline', ?6, 0, 1, 1)`,
    [id, `hash_${id}`, options.type ?? 'note', options.sourceId ?? null, options.sourceTable ?? null, data],
  );
  const seedNote = (
    id: string,
    title: string,
    options: { content?: string; updatedAt?: string; deletedAt?: string | null } = {},
  ) => {
    seedResource(`res_${id}`, options.content ?? '');
    conn.run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props)
       VALUES (?1, ?2, ?3, '[]', 0, ?4, ?4, ?5, NULL)`,
      [id, `res_${id}`, title, options.updatedAt ?? iso(1), options.deletedAt ?? null],
    );
  };
  const seedFile = (
    id: string,
    fileName: string,
    options: {
      type?: string; mime?: string | null; updatedAt?: string; extractedText?: string | null;
      ocrPages?: string | null; status?: string;
    } = {},
  ) => conn.run(
    `INSERT INTO files (id, sha256, file_name, size, type, mime_type, tags_json, bookmarks_json, status,
                        created_at, updated_at, extracted_text, ocr_pages_json)
     VALUES (?1, ?2, ?3, 4, ?4, ?5, '[]', '[]', ?6, ?7, ?7, ?8, ?9)`,
    [
      id, `sha_${id}`, fileName, options.type ?? 'document', options.mime ?? null,
      options.status ?? 'active', options.updatedAt ?? iso(1),
      options.extractedText ?? null, options.ocrPages ?? null,
    ],
  );
  const seedExam = (id: string, name: string | null, updatedAt = iso(1)) => conn.run(
    `INSERT INTO exam_sheets (id, resource_id, exam_name, status, temp_id, metadata_json, preview_json,
                              linked_mistake_ids, is_favorite, created_at, updated_at)
     VALUES (?1, NULL, ?2, 'completed', 'temp', '{}', ?3, NULL, 0, ?4, ?4)`,
    [id, name, JSON.stringify({ pages: [{ cards: [{ questionLabel: '1', ocrText: '题目一', status: 'new' }] }] }), updatedAt],
  );
  const seedTranslation = (id: string, title: string | null, content: string, updatedAt = iso(1)) => {
    seedResource(`res_${id}`, content);
    conn.run(
      `INSERT INTO translations (id, resource_id, title, src_lang, tgt_lang, engine, model, is_favorite,
                                 quality_rating, created_at, updated_at, metadata_json)
       VALUES (?1, ?2, ?3, 'en', 'zh', NULL, NULL, 0, NULL, ?4, ?4, NULL)`,
      [id, `res_${id}`, title, updatedAt],
    );
  };
  const seedSession = (id: string, title: string, updatedAt = iso(1)) => conn.run(
    `INSERT INTO essay_sessions (id, title, essay_type, grade_level, custom_prompt, total_rounds,
                                 latest_score, is_favorite, created_at, updated_at)
     VALUES (?1, ?2, 'argument', NULL, NULL, 2, NULL, 0, ?3, ?3)`,
    [id, title, updatedAt],
  );
  const seedEssay = (id: string, sessionId: string, round: number, content: string) => {
    seedResource(`res_${id}`, content, { type: 'essay' });
    conn.run(
      `INSERT INTO essays (id, resource_id, title, essay_type, grading_result_json, score, session_id,
                           round_number, grade_level, custom_prompt, dimension_scores_json, is_favorite,
                           created_at, updated_at, deleted_at)
       VALUES (?1, ?2, NULL, NULL, NULL, NULL, ?3, ?4, NULL, NULL, NULL, 0, ?5, ?5, NULL)`,
      [id, `res_${id}`, sessionId, round, iso(1)],
    );
  };
  const seedMindmap = (id: string, title: string, content: string, updatedAt = iso(1)) => {
    seedResource(`res_${id}`, content, { type: 'mindmap' });
    conn.run(
      `INSERT INTO mindmaps (id, resource_id, title, description, is_favorite, default_view, theme,
                             settings, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, 0, 'mindmap', NULL, NULL, ?4, ?4)`,
      [id, `res_${id}`, title, updatedAt],
    );
  };
  const seedMembership = (folderId: string | null, itemType: string, itemId: string) => conn.run(
    `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
     VALUES (?1, ?2, ?3, ?4, 0, 1)`,
    [`fi_${itemId}`, folderId, itemType, itemId],
  );
  const seedIndexSegment = (resourceId: string, content: string) => {
    conn.run(
      `INSERT INTO vfs_index_units (id, resource_id, unit_index, created_at, updated_at)
       VALUES (?1, ?2, 0, 1, 1)`,
      [`unit_${resourceId}`, resourceId],
    );
    conn.run(
      `INSERT INTO vfs_index_segments (id, unit_id, segment_index, modality, embedding_dim,
                                       lance_row_id, content_text, created_at, updated_at)
       VALUES (?1, ?2, 0, 'text', 3, 'row', ?3, 1, 1)`,
      [`seg_${resourceId}`, `unit_${resourceId}`, content],
    );
  };

  it('gets note, translation, mindmap, essay and exam content with Rust formatting', async () => {
    seedNote('note_1', '笔记', { content: '正文内容' });
    expect(await invoke('dstu_get_content', { path: '/note_1' })).toBe('正文内容');
    await expect(invoke('dstu_get_content', { path: '/note_missing' }))
      .rejects.toBe('Resource not found: note_missing');

    seedTranslation('tr_1', null, '{"source":"hello","translated":"你好"}');
    expect(await invoke('dstu_get_content', { path: '/tr_1' }))
      .toBe('{"source":"hello","translated":"你好"}');

    seedMindmap('mm_1', '导图', '{"root":1}');
    expect(await invoke('dstu_get_content', { path: '/mm_1' })).toBe('{"root":1}');

    seedExam('exam_1', '试卷');
    expect(await invoke('dstu_get_content', { path: '/exam_1' })).toBe(
      '# 题目集结构化摘要\n统计：页数=1，题目数=1，含 OCR 题目=1\n\n## 第 1 页（1 题）\n- 1 [new] 题目一',
    );

    seedEssay('essay_1', 'essay_session_1', 1, '单篇正文');
    expect(await invoke('dstu_get_content', { path: '/essay_1' })).toBe('单篇正文');

    seedSession('essay_session_1', '会话');
    seedEssay('essay_2', 'essay_session_1', 2, '第二篇');
    expect(await invoke('dstu_get_content', { path: '/essay_session_1' })).toBe(
      '# 作文会话: 会话\n类型: argument, 总轮次: 2\n\n## 第 1 轮\n单篇正文\n\n## 第 2 轮\n第二篇',
    );

    await expect(invoke('dstu_get_content', { path: '/@trash' }))
      .rejects.toBe('Invalid DSTU path: Path must contain a resource ID: /@trash');
  });

  it('gets file and image content through OCR, extracted text and fallbacks', async () => {
    seedFile('file_1', 'notes.txt', { extractedText: '提取的正文' });
    expect(await invoke('dstu_get_content', { path: '/file_1' })).toBe('提取的正文');

    seedFile('file_2', 'scan.pdf');
    expect(await invoke('dstu_get_content', { path: '/file_2' })).toBe('[文档: scan.pdf]');

    seedFile('file_3', 'ocr.pdf', { ocrPages: '["第一页文字",""]' });
    expect(await invoke('dstu_get_content', { path: '/file_3' })).toBe('--- 第 1 页 ---\n第一页文字');

    seedFile('img_1', '图片.png', { type: 'image' });
    seedResource('res_img_1', '', { type: 'file' });
    conn.run("UPDATE files SET resource_id = 'res_img_1' WHERE id = 'img_1'");
    conn.run("UPDATE resources SET ocr_text = '识别文字' WHERE id = 'res_img_1'");
    // `img_` is inferred as `files` by extract_resource_info, so the command uses the
    // file branch; the internal `images` branch keeps the Rust OCR-first behavior.
    expect(await invoke('dstu_get_content', { path: '/img_1' })).toBe('[文档: 图片.png]');
    expect(getContentByType({ database: host.ctx.vfsDatabase }, 'images', 'img_1'))
      .toBe('<image_ocr id="img_1">识别文字</image_ocr>');
    // Rust uses the default "document.pdf" hint when the file row is missing.
    expect(await invoke('dstu_get_content', { path: '/img_2' })).toBe('[文档: document.pdf]');
  });

  it('searches every resource type, adds snippets, filters hidden names and sorts by updatedAt', async () => {
    seedNote('note_title', '微积分笔记', { content: '导数的定义', updatedAt: iso(3) });
    seedNote('note_body', '其他标题', { content: '微积分基本定理', updatedAt: iso(2) });
    seedNote('note_hidden', '__sys__', { content: '微积分', updatedAt: iso(11) });
    seedExam('exam_1', '微积分试卷', iso(4));
    seedTranslation('tr_1', '微积分翻译', '{"source":"微积分"}', iso(5));
    seedFile('tb_1', '微积分教材.pdf', { mime: 'application/pdf', updatedAt: iso(6) });
    seedSession('essay_session_1', '微积分作文', iso(7));
    seedFile('file_1', '微积分资料.txt', { updatedAt: iso(8) });
    seedFile('img_1', '微积分图.png', { type: 'image', updatedAt: iso(9) });
    seedMindmap('mm_1', '微积分导图', '{}', iso(10));

    const results = await invoke<DstuNode[]>('dstu_search', { query: '微积分' });
    // tb_1 matches both the textbook branch and the document-file branch.
    expect(results.map(node => node.id)).toEqual([
      'mm_1', 'img_1', 'file_1', 'essay_session_1', 'tb_1', 'tb_1', 'tr_1', 'exam_1',
      'note_title', 'note_body',
    ]);
    expect(results.find(node => node.id === 'note_title')!.metadata).not.toHaveProperty('snippet');
    expect(results.find(node => node.id === 'note_body')!.metadata).toMatchObject({
      snippet: '微积分基本定理',
    });

    const notesOnly = await invoke<DstuNode[]>('dstu_search', {
      query: '微积分', options: { types: ['note'] },
    });
    expect(notesOnly.map(node => node.id).sort()).toEqual(['note_body', 'note_title']);

    const typed = await invoke<DstuNode[]>('dstu_search', {
      query: '微积分', options: { typeFilter: 'translation' },
    });
    expect(typed.map(node => node.id)).toEqual(['tr_1']);
  });

  it('recalls content matches through vfs_index_segments with snippet and matchSource', async () => {
    seedNote('note_indexed', '无关标题', { content: '普通正文' });
    seedResource('res_indexed', '索引召回的正文', {
      sourceId: 'note_indexed', sourceTable: 'notes',
    });
    seedIndexSegment('res_indexed', '这里包含索引召回的正文片段');

    const results = await invoke<DstuNode[]>('dstu_search', { query: '索引召回' });
    expect(results.map(node => node.id)).toEqual(['note_indexed']);
    expect(results[0]!.metadata).toMatchObject({
      snippet: '这里包含索引召回的正文片段', matchSource: 'index',
    });
  });

  it('searches inside a folder by title, ignores essay members and applies limit', async () => {
    const folder = await create('资料');
    seedNote('note_member', '微积分成员', { updatedAt: iso(2) });
    seedSession('essay_session_1', '微积分会话');
    seedMembership(folder.id, 'note', 'note_member');
    seedMembership(folder.id, 'essay', 'essay_session_1');
    seedNote('note_outside', '微积分外部', { updatedAt: iso(3) });

    const results = await invoke<DstuNode[]>('dstu_search_in_folder', {
      folderId: folder.id, query: '微积分',
    });
    expect(results.map(node => node.id)).toEqual(['note_member']);

    expect(await invoke<DstuNode[]>('dstu_search_in_folder', {
      folderId: folder.id, query: '微积分', options: { limit: 0 },
    })).toEqual([]);

    const global = await invoke<DstuNode[]>('dstu_search_in_folder', { query: '微积分' });
    expect(global.map(node => node.id).sort())
      .toEqual(['essay_session_1', 'note_member', 'note_outside']);

    await expect(invoke('dstu_search_in_folder', { folderId: 'fld_missing', query: 'x' }))
      .rejects.toBe('Folder not found: fld_missing');
  });

  it('restricts indexed recall to the searched folder', async () => {
    const folder = await create('索引文件夹');
    seedNote('note_member', '成员', { content: '' });
    seedNote('note_outside', '外部', { content: '' });
    seedMembership(folder.id, 'note', 'note_member');
    seedResource('res_member', '索引召回内容', {
      sourceId: 'note_member', sourceTable: 'notes',
    });
    seedResource('res_outside', '索引召回内容', {
      sourceId: 'note_outside', sourceTable: 'notes',
    });
    seedIndexSegment('res_member', '索引召回内容 A');
    seedIndexSegment('res_outside', '索引召回内容 B');

    const results = await invoke<DstuNode[]>('dstu_search_in_folder', {
      folderId: folder.id, query: '索引召回',
    });
    expect(results.map(node => node.id)).toEqual(['note_member']);
    expect(results[0]!.metadata).toMatchObject({ matchSource: 'index' });
  });
});
