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

describe('dstu_list and dstu_list_deleted', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-list-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-list-'));
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
  const seedResource = (id: string, data: string, type = 'note') => conn.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'inline', ?4, 0, 1, 1)`,
    [id, `hash_${id}`, type, data],
  );
  const seedNote = (
    id: string,
    title: string,
    options: { tags?: string[]; favorite?: boolean; updatedAt?: string; deletedAt?: string | null; body?: string } = {},
  ) => {
    seedResource(`res_${id}`, options.body ?? '');
    conn.run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, NULL)`,
      [
        id, `res_${id}`, title, JSON.stringify(options.tags ?? []),
        options.favorite === true ? 1 : 0,
        options.updatedAt ?? '2026-01-01T00:00:00.000Z',
        options.deletedAt ?? null,
      ],
    );
  };
  const seedFile = (
    id: string,
    fileName: string,
    options: { type?: string; mime?: string | null; status?: string; deletedAt?: string | null; updatedAt?: string; favorite?: boolean } = {},
  ) => conn.run(
    `INSERT INTO files (id, sha256, file_name, size, type, mime_type, tags_json, bookmarks_json, status,
                        is_favorite, created_at, updated_at, deleted_at, page_count)
     VALUES (?1, ?2, ?3, 12, ?4, ?5, '[]', '[]', ?6, ?7, ?8, ?8, ?9, 3)`,
    [
      id, `sha_${id}`, fileName, options.type ?? 'document', options.mime ?? null,
      options.status ?? 'active', options.favorite === true ? 1 : 0,
      options.updatedAt ?? '2026-01-01T00:00:00.000Z', options.deletedAt ?? null,
    ],
  );
  const seedExam = (
    id: string,
    name: string | null,
    options: { deletedAt?: string | null; updatedAt?: string } = {},
  ) => conn.run(
    `INSERT INTO exam_sheets (id, resource_id, exam_name, status, temp_id, metadata_json, preview_json,
                              linked_mistake_ids, is_favorite, created_at, updated_at, deleted_at)
     VALUES (?1, NULL, ?2, 'completed', 'temp', '{}', '{}', '["q_1"]', 0, ?3, ?3, ?4)`,
    [id, name, options.updatedAt ?? '2026-01-01T00:00:00.000Z', options.deletedAt ?? null],
  );
  const seedTranslation = (
    id: string,
    options: { deletedAt?: string | null; createdAt?: string } = {},
  ) => {
    seedResource(`res_${id}`, '{"source":"hello"}');
    conn.run(
      `INSERT INTO translations (id, resource_id, title, src_lang, tgt_lang, engine, model, is_favorite,
                                 quality_rating, created_at, updated_at, metadata_json, deleted_at)
       VALUES (?1, ?2, NULL, 'en', 'zh', 'engine', 'model', 1, 4, ?3, ?3, '{}', ?4)`,
      [id, `res_${id}`, options.createdAt ?? '2026-01-01T00:00:00.000Z', options.deletedAt ?? null],
    );
  };
  const seedSession = (
    id: string,
    title: string,
    options: { deletedAt?: string | null; updatedAt?: string } = {},
  ) => conn.run(
    `INSERT INTO essay_sessions (id, title, essay_type, grade_level, custom_prompt, total_rounds,
                                 latest_score, is_favorite, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, 'argument', 'high_school', NULL, 2, 90, 1, ?3, ?3, ?4)`,
    [id, title, options.updatedAt ?? '2026-01-01T00:00:00.000Z', options.deletedAt ?? null],
  );
  const seedMindmap = (id: string, title: string) => {
    seedResource(`res_${id}`, '{}', 'mindmap');
    conn.run(
      `INSERT INTO mindmaps (id, resource_id, title, description, is_favorite, default_view, theme,
                             settings, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, 0, 'mindmap', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [id, `res_${id}`, title],
    );
  };
  const seedMembership = (folderId: string | null, itemType: string, itemId: string) => conn.run(
    `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at)
     VALUES (?1, ?2, ?3, ?4, 0, 1)`,
    [`fi_${itemId}`, folderId, itemType, itemId],
  );

  it('lists a smart folder by type, rewrites folder paths, hides memory folders and honors search/tags', async () => {
    const folder = await create('数学');
    seedNote('note_in', '导数', { tags: ['math', 'exam'], updatedAt: '2026-01-02T00:00:00.000Z' });
    seedMembership(folder.id, 'note', 'note_in');
    seedNote('note_root', '积分', { tags: ['math'], updatedAt: '2026-01-03T00:00:00.000Z' });
    seedNote('note_hidden', '__cat_math__', { updatedAt: '2026-01-04T00:00:00.000Z' });
    seedNote('note_body', '正文命中', { body: '微积分基本定理', updatedAt: '2026-01-01T00:00:00.000Z' });

    const all = await invoke<DstuNode[]>('dstu_list', { path: '/', options: { typeFilter: 'note' } });
    expect(all.map(node => node.id)).toEqual(['note_root', 'note_in', 'note_body']);
    expect(all[0]!.path).toBe('note_root');
    expect(all[1]!.path).toBe('数学/note_in');

    const searched = await invoke<DstuNode[]>('dstu_list', {
      path: '/', options: { typeFilter: 'note', search: '微积分' },
    });
    expect(searched.map(node => node.id)).toEqual(['note_body']);

    const titled = await invoke<DstuNode[]>('dstu_list', {
      path: '/', options: { typeFilter: 'note', search: '导数' },
    });
    expect(titled.map(node => node.id)).toEqual(['note_in']);

    expect((await invoke<DstuNode[]>('dstu_list', {
      path: '/', options: { typeFilter: 'note', tags: ['MATH', ' exam '], limit: 1 },
    })).map(node => node.id)).toEqual(['note_in']);
    expect((await invoke<DstuNode[]>('dstu_list', {
      path: '/', options: { typeFilter: 'note', tags: ['MATH', ' exam '], limit: 1, offset: 1 },
    })).map(node => node.id)).toEqual([]);
  });

  it('lists every smart-folder type with the Rust query order', async () => {
    seedFile('tb_1', 'book.pdf', { updatedAt: '2026-01-02T00:00:00.000Z' });
    seedFile('file_1', 'notes.txt', { updatedAt: '2026-01-03T00:00:00.000Z' });
    seedFile('img_1', 'photo.png', { type: 'image', updatedAt: '2026-01-04T00:00:00.000Z' });
    seedExam('exam_1', '期中', { updatedAt: '2026-01-05T00:00:00.000Z' });
    seedExam('exam_2', '期末', { updatedAt: '2026-01-06T00:00:00.000Z' });
    seedTranslation('tr_1', { createdAt: '2026-01-07T00:00:00.000Z' });
    seedSession('essay_session_1', '作文会话', { updatedAt: '2026-01-08T00:00:00.000Z' });
    seedMindmap('mm_1', '导图');

    // VfsTextbookRepo::list_textbooks lists every active file, not just tb_ prefixed rows.
    expect((await invoke<DstuNode[]>('dstu_list', { path: '/', options: { typeFilter: 'textbook' } }))
      .map(node => node.id)).toEqual(['img_1', 'file_1', 'tb_1']);
    expect((await invoke<DstuNode[]>('dstu_list', { path: '/', options: { typeFilter: 'file' } }))
      .map(node => node.id)).toEqual(['file_1', 'tb_1']);
    expect((await invoke<DstuNode[]>('dstu_list', { path: '/', options: { typeFilter: 'image' } }))
      .map(node => node.id)).toEqual(['img_1']);
    expect((await invoke<DstuNode[]>('dstu_list', {
      path: '/', options: { typeFilter: 'exam', search: '期末' },
    })).map(node => node.id)).toEqual(['exam_2']);
    expect((await invoke<DstuNode[]>('dstu_list', {
      path: '/', options: { typeFilter: 'translation', search: 'hello' },
    })).map(node => node.id)).toEqual(['tr_1']);
    expect((await invoke<DstuNode[]>('dstu_list', { path: '/', options: { typeFilter: 'essay' } }))
      .map(node => node.id)).toEqual(['essay_session_1']);
    expect((await invoke<DstuNode[]>('dstu_list', { path: '/', options: { typeFilter: 'mindmap' } }))
      .map(node => node.id)).toEqual(['mm_1']);
    expect(await invoke<DstuNode[]>('dstu_list', { path: '/', options: { typeFilter: 'folder' } })).toEqual([]);
  });

  it('lists the root with folders, root memberships and unassigned resources', async () => {
    const parent = await create('高考复习');
    const child = await create('函数', parent.id);
    seedNote('note_assigned', '已分配', { updatedAt: '2026-01-05T00:00:00.000Z' });
    seedMembership(child.id, 'note', 'note_assigned');
    seedNote('note_root_member', '根成员', { updatedAt: '2026-01-06T00:00:00.000Z' });
    seedMembership(null, 'note', 'note_root_member');
    seedNote('note_unassigned', '未分配', { updatedAt: '2026-01-07T00:00:00.000Z' });
    seedFile('tb_root', 'root.pdf', { updatedAt: '2026-01-08T00:00:00.000Z' });

    const nodes = await invoke<DstuNode[]>('dstu_list', { path: '/', options: { folderId: 'root' } });
    expect(nodes.map(node => node.id)).toEqual([
      parent.id, 'note_root_member', 'note_unassigned', 'tb_root',
    ]);
    expect(nodes[0]).toMatchObject({ path: '高考复习', name: '高考复习', type: 'folder' });
    expect(nodes[1]!.path).toBe('/note_root_member');

    const defaultRoot = await invoke<DstuNode[]>('dstu_list', { path: '/' });
    expect(defaultRoot.map(node => node.id)).toEqual([
      parent.id, 'note_root_member', 'note_unassigned', 'tb_root',
    ]);
  });

  it('lists folders with subfolder paths, type filters, hidden names, sorting and pagination', async () => {
    const parent = await create('父');
    const child = await create('子', parent.id);
    await create('__hidden__', parent.id);
    seedNote('note_b', 'B', { updatedAt: '2026-01-02T00:00:00.000Z' });
    seedNote('note_a', 'A', { updatedAt: '2026-01-03T00:00:00.000Z' });
    seedNote('note_hidden', '__system__', { updatedAt: '2026-01-04T00:00:00.000Z' });
    seedExam('exam_c', 'C', { updatedAt: '2026-01-05T00:00:00.000Z' });
    seedMembership(parent.id, 'note', 'note_b');
    seedMembership(parent.id, 'note', 'note_a');
    seedMembership(parent.id, 'note', 'note_hidden');
    seedMembership(parent.id, 'exam', 'exam_c');

    const nodes = await invoke<DstuNode[]>('dstu_list', { path: '/父', options: { folderId: parent.id } });
    expect(nodes.map(node => node.id)).toEqual([child.id, 'exam_c', 'note_a', 'note_b']);
    expect(nodes[0]).toMatchObject({ path: '父/子', name: '子' });

    const notesOnly = await invoke<DstuNode[]>('dstu_list', {
      path: '/父', options: { folderId: parent.id, typeFilter: 'note' },
    });
    expect(notesOnly.map(node => node.id)).toEqual([child.id, 'note_a', 'note_b']);

    const paged = await invoke<DstuNode[]>('dstu_list', {
      path: '/父',
      options: { folderId: parent.id, sortBy: 'name', sortOrder: 'asc', limit: 1, offset: 1 },
    });
    expect(paged.map(node => node.id)).toEqual(['note_b']);

    await expect(invoke('dstu_list', { path: '/x', options: { folderId: 'fld_missing' } }))
      .rejects.toBe('文件夹不存在');
  });

  it('favorite mode loads all types, filters hidden names and sorts without pagination', async () => {
    seedNote('note_fav', '收藏笔记', { favorite: true, updatedAt: '2026-01-02T00:00:00.000Z' });
    seedNote('note_plain', '普通笔记', { updatedAt: '2026-01-03T00:00:00.000Z' });
    seedNote('note_hidden', '__user_profile__', { favorite: true, updatedAt: '2026-01-04T00:00:00.000Z' });
    seedFile('tb_fav', 'fav.pdf', { favorite: true, updatedAt: '2026-01-05T00:00:00.000Z' });
    seedExam('exam_fav', '收藏题', {});
    seedMembership(null, 'exam', 'exam_fav');

    const favorites = await invoke<DstuNode[]>('dstu_list', {
      path: '/', options: { isFavorite: true, limit: 1 },
    });
    // limit/offset apply per resource type before the favorite filter, so the newest
    // note is the hidden one and gets dropped; `file` also lists the document tb_fav.
    expect(favorites.map(node => node.id)).toEqual(['tb_fav', 'tb_fav']);
    expect((await invoke<DstuNode[]>('dstu_list', { path: '/', options: { isFavorite: true } }))
      .map(node => node.id)).toEqual(['tb_fav', 'tb_fav', 'note_fav']);
  });

  it('lists deleted notes, textbooks, exams, translations and essay sessions with Rust node shapes', async () => {
    seedNote('note_del', '删除笔记', {
      tags: ['math'], favorite: true, deletedAt: '2026-02-01T00:00:00.000Z',
    });
    seedNote('note_live', '活跃笔记', {});
    const notes = await invoke<DstuNode[]>('dstu_list_deleted', { resourceType: 'notes' });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: 'note_del', sourceId: 'note_del', name: '删除笔记', path: '/note_del', type: 'note',
      createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
      updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      resourceId: 'res_note_del', previewType: 'markdown',
      metadata: { tags: ['math'], is_favorite: true, deleted_at: '2026-02-01T00:00:00.000Z' },
    });

    seedFile('tb_del', '书.pdf', { status: 'deleted', deletedAt: '2026-02-02T00:00:00.000Z' });
    seedFile('file_del', '附件.txt', { status: 'deleted', deletedAt: '2026-02-03T00:00:00.000Z' });
    const textbooks = await invoke<DstuNode[]>('dstu_list_deleted', { resourceType: 'textbooks' });
    expect(textbooks.map(node => node.id)).toEqual(['tb_del']);
    expect(textbooks[0]).toMatchObject({
      name: '书.pdf', type: 'textbook', size: 12, previewType: 'pdf',
      metadata: { file_name: '书.pdf', page_count: 3, isFavorite: false },
    });
    expect((textbooks[0] as DstuNode).resourceId).toBeUndefined();

    seedExam('exam_del', null, { deletedAt: '2026-02-04T00:00:00.000Z' });
    const exams = await invoke<DstuNode[]>('dstu_list_deleted', { resourceType: 'exams' });
    expect(exams[0]).toMatchObject({
      id: 'exam_del', name: '未命名题目集', type: 'exam', resourceId: 'res_exam_del',
      previewType: 'exam',
      metadata: { status: 'completed', temp_id: 'temp', linked_mistake_ids: ['q_1'] },
    });

    seedTranslation('tr_del', { deletedAt: '2026-02-05T00:00:00.000Z' });
    const translations = await invoke<DstuNode[]>('dstu_list_deleted', { resourceType: 'translations' });
    expect(translations[0]).toMatchObject({
      id: 'tr_del', name: 'en → zh', type: 'translation', previewType: 'translation',
      createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
      updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      metadata: {
        src_lang: 'en', tgt_lang: 'zh', engine: 'engine', model: 'model',
        is_favorite: true, quality_rating: 4,
      },
    });

    seedSession('essay_session_del', '删除会话', { deletedAt: '2026-02-06T00:00:00.000Z' });
    const essays = await invoke<DstuNode[]>('dstu_list_deleted', { resourceType: 'essays' });
    expect(essays[0]).toMatchObject({
      id: 'essay_session_del', name: '删除会话', type: 'essay', resourceId: 'essay_session_del',
      previewType: 'essay',
      metadata: {
        essay_type: 'argument', grade_level: 'high_school', total_rounds: 2,
        latest_score: 90, is_favorite: true, is_session: true,
      },
    });

    await expect(invoke('dstu_list_deleted', { resourceType: 'files' }))
      .rejects.toBe("Resource type 'files' does not support list_deleted operation");
  });

  it('dstu_list_deleted paginates with Rust defaults and maps malformed timestamps to zero', async () => {
    seedResource('res_bad', '');
    conn.run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props)
       VALUES ('note_bad', 'res_bad', '坏时间', '[]', 0, 'not-a-date', 'not-a-date',
               '2026-03-01T00:00:00.000Z', NULL)`,
    );
    seedNote('note_older', '较旧', { deletedAt: '2026-02-01T00:00:00.000Z' });
    seedNote('note_newer', '较新', { deletedAt: '2026-03-02T00:00:00.000Z' });

    const page = await invoke<DstuNode[]>('dstu_list_deleted', {
      resourceType: 'notes', limit: 1, offset: 1,
    });
    expect(page.map(node => node.id)).toEqual(['note_bad']);

    const all = await invoke<DstuNode[]>('dstu_list_deleted', { resourceType: 'notes', limit: 10 });
    expect(all[0]).toMatchObject({ id: 'note_newer', createdAt: Date.parse('2026-01-01T00:00:00.000Z') });
    expect(all[1]).toMatchObject({ id: 'note_bad', createdAt: 0, updatedAt: 0 });
  });
});
