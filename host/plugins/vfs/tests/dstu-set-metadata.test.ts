import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { DstuNode, VfsFolder } from '../api.ts';
import { parseNoteMetadataUpdate } from '../src/dstu-metadata.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';

describe('dstu_set_metadata', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-metadata-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-metadata-'));
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
  const setMetadata = (args: Record<string, unknown>) => invoke<null>('dstu_set_metadata', args);

  function resourcesHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  function insertTextbook(id: string): { resourceId: string; updatedAt: string } {
    const resourceId = `res_${id}`;
    const updatedAt = new Date(Date.now() - 10_000).toISOString();
    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data,
                              metadata_json, ref_count, created_at, updated_at)
       VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', NULL, 0, 1, 1)`,
      [resourceId, resourcesHash(id), id],
    );
    conn.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, "type", status,
                          page_count, is_favorite, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'book.pdf', 100, 'textbook', 'active', 42, 0, ?4, ?4)`,
      [id, resourceId, resourcesHash(id), updatedAt],
    );
    return { resourceId, updatedAt };
  }

  function cacheFolderItem(
    itemType: string,
    itemId: string,
    cachedPath: string,
    folderId?: string,
  ): void {
    conn.run(
      `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
       VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)`,
      [`fi_${itemId}`, folderId ?? null, itemType, itemId, Date.now(), cachedPath],
    );
  }

  function insertEssayRound(id: string, content: string): void {
    const resourceId = `res_${id}`;
    const now = new Date().toISOString();
    conn.run(
      `INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data,
                              metadata_json, ref_count, created_at, updated_at)
       VALUES (?1, ?2, 'essay', ?3, 'essays', 'inline', ?4, NULL, 0, 1, 1)`,
      [resourceId, resourcesHash(content), id, content],
    );
    conn.run(
      `INSERT INTO essays (id, resource_id, title, essay_type, grading_result_json, score,
                           session_id, round_number, grade_level, custom_prompt,
                           dimension_scores_json, is_favorite, created_at, updated_at, deleted_at)
       VALUES (?1, ?2, '旧作文', 'argument', NULL, NULL, NULL, 1, NULL, NULL, NULL, 0, ?3, ?3, NULL)`,
      [id, resourceId, now],
    );
  }

  it('test_parse_note_metadata_update_preserves_typed_fields_and_null_clears_props', () => {
    const update = parseNoteMetadataUpdate({
      title: 'renamed',
      tags: ['math', 'exam'],
      isFavorite: true,
      props: null,
    }, '2026-08-25T00:00:00.000Z');

    expect(update.title).toBe('renamed');
    expect(update.tags).toEqual(['math', 'exam']);
    expect(update.isFavorite).toBe(true);
    expect(update.props).toEqual({});
    expect(update.expectedUpdatedAt).toBe('2026-08-25T00:00:00.000Z');
  });

  it('test_parse_note_metadata_update_rejects_silent_field_drops', () => {
    expect(() => parseNoteMetadataUpdate({ status: 'done' }, undefined))
      .toThrow('不支持的笔记 metadata 字段: status；自定义字段请放入 props');
    expect(() => parseNoteMetadataUpdate({ tags: ['math', 3] }, undefined))
      .toThrow('tags 必须是字符串数组');
    expect(() => parseNoteMetadataUpdate({ props: ['not', 'an', 'object'] }, undefined))
      .toThrow('props 必须是键值对象或 null');
  });

  it('updates note metadata through the simple path and clears props with null', async () => {
    const note = await create({ type: 'note', name: '旧名', content: '正文' });
    const before = note.updatedAt;

    await expect(setMetadata({
      path: note.id,
      metadata: {
        title: '新名',
        tags: ['数学', '复习'],
        isFavorite: true,
        props: { status: 'done', score: 3, ok: true, ' padded ': 'v' },
      },
      expectedUpdatedAt: new Date(before).toISOString(),
    })).resolves.toBeNull();

    const row = conn.get<{
      title: string; tags: string; is_favorite: number; props: string | null; updated_at: string;
    }>('SELECT title, tags, is_favorite, props, updated_at FROM notes WHERE id = ?1', [note.id]);
    expect(row!.title).toBe('新名');
    expect(JSON.parse(row!.tags)).toEqual(['数学', '复习']);
    expect(row!.is_favorite).toBe(1);
    expect(JSON.parse(row!.props!)).toEqual({ status: 'done', score: 3, ok: true, padded: 'v' });
    expect(Date.parse(row!.updated_at)).toBeGreaterThan(before);

    const fetched = await invoke<DstuNode>('dstu_get', { path: note.id });
    expect(fetched).toMatchObject({
      id: note.id,
      name: '新名',
      type: 'note',
      metadata: {
        isFavorite: true,
        tags: ['数学', '复习'],
        props: { status: 'done', score: 3, ok: true, padded: 'v' },
      },
    });
    const events = host.eventsNamed('dstu:change') as Array<{ type: string; path: string }>;
    expect(events.at(-1)).toMatchObject({ type: 'updated', path: note.id });
    expect(host.eventsNamed(`dstu:change:${note.id}`)).toHaveLength(1);

    await setMetadata({ path: `/${note.id}`, metadata: { props: null } });
    expect(conn.pluck<string | null>('SELECT props FROM notes WHERE id = ?1', [note.id])).toBeNull();
  });

  it('enforces note optimistic locking and validates metadata fields', async () => {
    const note = await create({ type: 'note', name: '锁', content: 'x' });
    const updatedAt = new Date(note.updatedAt).toISOString();

    await expect(setMetadata({
      path: note.id, metadata: { title: 'x' }, expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
    })).rejects.toBe(
      'CONFLICT(notes.conflict): The note has been updated elsewhere, please refresh.',
    );
    // An empty expected value is treated as "no lock".
    await setMetadata({ path: note.id, metadata: { title: '空锁' }, expectedUpdatedAt: '  ' });

    await expect(setMetadata({ path: note.id, metadata: { title: '' } }))
      .rejects.toBe("Invalid argument 'title': 标题不能为空");
    await expect(setMetadata({ path: note.id, metadata: { title: 3 } }))
      .rejects.toBe('title 必须是字符串');
    await expect(setMetadata({ path: note.id, metadata: { isFavorite: 'yes' } }))
      .rejects.toBe('isFavorite 必须是布尔值');
    await expect(setMetadata({ path: note.id, metadata: { tags: 'math' } }))
      .rejects.toBe('tags 必须是字符串数组');
    await expect(setMetadata({ path: note.id, metadata: { props: { a: 1, A: 2 } } }))
      .rejects.toBe('Invalid argument \'props\': 属性名 "A" 与已有属性重复');
    await expect(setMetadata({ path: note.id, metadata: { props: { '': 1 } } }))
      .rejects.toBe("Invalid argument 'props': 属性名不能为空");
    await expect(setMetadata({ path: note.id, metadata: { props: { bad: { nested: true } } } }))
      .rejects.toBe("Invalid argument 'props': 属性值只支持字符串、数字或布尔");
    await expect(setMetadata({ path: note.id, metadata: null }))
      .rejects.toBe('笔记 metadata 必须是键值对象');
    expect(conn.pluck<string>('SELECT title FROM notes WHERE id = ?1', [note.id])).toBe('空锁');
    expect(conn.pluck<string>('SELECT updated_at FROM notes WHERE id = ?1', [note.id]))
      .not.toBe(updatedAt);
  });

  it('resolves cached paths and keeps the Rust item-type mapping quirks', async () => {
    const folder = await createFolder('资料');
    const note = await create({
      type: 'note', name: '缓存', content: 'x', metadata: { folderId: folder.id },
    });
    conn.run('UPDATE folder_items SET cached_path = ?1 WHERE item_id = ?2 AND item_type = ?3',
      ['/资料/缓存笔记', note.id, 'note']);

    await setMetadata({ path: '/资料/缓存笔记', metadata: { isFavorite: true } });
    expect(conn.pluck<number>('SELECT is_favorite FROM notes WHERE id = ?1', [note.id])).toBe(1);
    // The cached_path clear at the end uses the plural resource type, so it is
    // a no-op in Rust and remains readable here.
    expect(conn.pluck<string>('SELECT cached_path FROM folder_items WHERE item_id = ?1', [note.id]))
      .toBe('/资料/缓存笔记');

    const mindmap = await create({
      type: 'mindmap', name: '图', content: '{"root":{"id":"root","text":"根"}}',
    });
    conn.run('UPDATE folder_items SET cached_path = ?1 WHERE item_id = ?2',
      ['/资料/导图', mindmap.id]);
    await expect(setMetadata({ path: '/资料/导图', metadata: { isFavorite: true } }))
      .rejects.toBe('Invalid node type: mindmap');

    cacheFolderItem('qbank', 'q1', '/资料/题库');
    await expect(setMetadata({ path: '/资料/题库', metadata: {} }))
      .rejects.toBe('Invalid node type: qbank');

    await expect(setMetadata({ path: '/资料/未知', metadata: {} })).rejects.toBe('资源不存在');
    await expect(setMetadata({ path: 'zzz_1', metadata: {} })).rejects.toBe('资源不存在');
    await expect(setMetadata({ path: 'res_1', metadata: {} }))
      .rejects.toBe('Invalid node type: resources');
  });

  it('updates translation favorite, rating and merged source/translated content', async () => {
    const translation = await create({
      type: 'translation',
      name: '译',
      metadata: { sourceText: 'hello', translatedText: '你好', srcLang: 'en', tgtLang: 'zh' },
    });
    const beforeVersion = conn.pluck<number>(
      'SELECT local_version FROM translations WHERE id = ?1', [translation.id])!;

    await setMetadata({
      path: translation.id,
      metadata: { isFavorite: true, qualityRating: 4, sourceText: 'world' },
    });
    const row = conn.get<{
      is_favorite: number; quality_rating: number; local_version: number; updated_at: string;
    }>('SELECT is_favorite, quality_rating, local_version, updated_at FROM translations WHERE id = ?1',
      [translation.id]);
    expect(row!.is_favorite).toBe(1);
    expect(row!.quality_rating).toBe(4);
    expect(row!.local_version).toBe(beforeVersion + 3);

    const content = JSON.parse(conn.pluck<string>(
      'SELECT data FROM resources WHERE id = ?1', [translation.resourceId!])!);
    expect(content).toEqual({ source: 'world', translated: '你好' });

    const fetched = await invoke<DstuNode>('dstu_get', { path: translation.id });
    expect(fetched.metadata).toMatchObject({
      isFavorite: true, qualityRating: 4, sourceText: 'world', translatedText: '你好',
    });

    await expect(setMetadata({ path: translation.id, metadata: { qualityRating: 9 } }))
      .rejects.toBe("Invalid argument 'rating': Rating must be between 1 and 5");
    await expect(setMetadata({ path: translation.id, metadata: { qualityRating: 0 } }))
      .rejects.toBe("Invalid argument 'rating': Rating must be between 1 and 5");
    await expect(setMetadata({ path: 'tr_missing', metadata: { isFavorite: true } }))
      .rejects.toBe('Translation not found: tr_missing');
    // Non-string sourceText is ignored, so the stored text is preserved.
    await setMetadata({ path: translation.id, metadata: { sourceText: 7 } });
    expect(JSON.parse(conn.pluck<string>(
      'SELECT data FROM resources WHERE id = ?1', [translation.resourceId!])!))
      .toEqual({ source: 'world', translated: '你好' });
  });

  it('copy-on-write updates a translation resource shared by legacy rows', async () => {
    const first = await create({
      type: 'translation', name: '一', metadata: { sourceText: 'a', translatedText: 'A' },
    });
    const second = await create({
      type: 'translation', name: '二', metadata: { sourceText: 'b', translatedText: 'B' },
    });
    conn.run('UPDATE translations SET resource_id = ?1 WHERE id = ?2', [
      first.resourceId!, second.id,
    ]);

    await setMetadata({ path: first.id, metadata: { translatedText: 'A2' } });
    const firstResource = conn.pluck<string>(
      'SELECT resource_id FROM translations WHERE id = ?1', [first.id])!;
    expect(firstResource).not.toBe(first.resourceId);
    expect(JSON.parse(conn.pluck<string>(
      'SELECT data FROM resources WHERE id = ?1', [first.resourceId!])!))
      .toEqual({ source: 'a', translated: 'A' });
    expect(JSON.parse(conn.pluck<string>(
      'SELECT data FROM resources WHERE id = ?1', [firstResource])!))
      .toEqual({ source: 'a', translated: 'A2' });
    expect(conn.pluck<string>('SELECT resource_id FROM translations WHERE id = ?1', [second.id]))
      .toBe(first.resourceId);
  });

  it('updates essay sessions and single essay rounds through separate branches', async () => {
    const session = await create({
      type: 'essay', name: '旧会话', metadata: { essayType: 'argument' },
    });
    await setMetadata({
      path: session.id,
      metadata: {
        title: '新会话', isFavorite: true, essayType: 'narrative',
        gradeLevel: 'high', customPrompt: '写一篇',
      },
    });
    expect(conn.get<{
      title: string; is_favorite: number; essay_type: string; grade_level: string;
      custom_prompt: string;
    }>('SELECT title, is_favorite, essay_type, grade_level, custom_prompt '
      + 'FROM essay_sessions WHERE id = ?1', [session.id]))
      .toEqual({
        title: '新会话', is_favorite: 1, essay_type: 'narrative',
        grade_level: 'high', custom_prompt: '写一篇',
      });
    const sessionNode = await invoke<DstuNode>('dstu_get', { path: session.id });
    expect(sessionNode).toMatchObject({
      name: '新会话', metadata: { isFavorite: true, totalRounds: 0 },
    });

    await expect(setMetadata({ path: session.id, metadata: {} }))
      .rejects.toBe('Essay session metadata update requires at least one field');
    await expect(setMetadata({ path: 'essay_session_missing', metadata: { title: 'x' } }))
      .rejects.toBe('EssaySession not found: essay_session_missing');

    insertEssayRound('essay_round_meta', '正文');
    await setMetadata({
      path: 'essay_round_meta',
      metadata: { isFavorite: true, title: '轮次名', gradeLevel: 'middle', essayType: 'letter' },
    });
    expect(conn.get<{
      title: string; is_favorite: number; grade_level: string; essay_type: string;
    }>('SELECT title, is_favorite, grade_level, essay_type FROM essays WHERE id = ?1',
      ['essay_round_meta']))
      .toEqual({ title: '轮次名', is_favorite: 1, grade_level: 'middle', essay_type: 'letter' });
    const roundNode = await invoke<DstuNode>('dstu_get', { path: 'essay_round_meta' });
    expect(roundNode).toMatchObject({ name: '轮次名', type: 'essay' });

    await expect(setMetadata({ path: 'essay_missing', metadata: { title: 'x' } }))
      .rejects.toBe('Essay not found: essay_missing');
    // Only favorites on a missing essay never hit a checked UPDATE and fail on re-read.
    await expect(setMetadata({ path: 'essay_missing', metadata: { isFavorite: true } }))
      .rejects.toBe('操作失败');
  });

  it('updates textbook progress, bookmarks, favorites and file names with OCC', async () => {
    const folder = await createFolder('教材');
    const textbook = insertTextbook('tb_meta');
    cacheFolderItem('textbook', 'tb_meta', '/教材/book.pdf', folder.id);

    await setMetadata({
      path: '/教材/book.pdf',
      metadata: { readingProgress: { page: 12 }, isFavorite: true, title: '新书名.pdf' },
    });
    const row = conn.get<{
      last_page: number; last_opened_at: string; is_favorite: number; file_name: string;
      bookmarks_json: string | null; updated_at: string;
    }>('SELECT last_page, last_opened_at, is_favorite, file_name, bookmarks_json, updated_at '
      + 'FROM files WHERE id = ?1', ['tb_meta']);
    expect(row).toMatchObject({ last_page: 12, is_favorite: 1, file_name: '新书名.pdf' });
    expect(row!.last_opened_at).not.toBeNull();

    // Versionless explicit bookmark channel replaces the whole array.
    await setMetadata({ path: '/教材/book.pdf', metadata: { bookmarks: [{ page: 1 }] } });
    expect(JSON.parse(conn.pluck<string>(
      'SELECT bookmarks_json FROM files WHERE id = ?1', ['tb_meta'])!))
      .toEqual([{ page: 1 }]);

    // Bookmarks piggybacked on readingProgress without a version are skipped.
    await setMetadata({
      path: '/教材/book.pdf',
      metadata: { readingProgress: { page: 20 }, bookmarks: [{ page: 9 }] },
    });
    expect(JSON.parse(conn.pluck<string>(
      'SELECT bookmarks_json FROM files WHERE id = ?1', ['tb_meta'])!))
      .toEqual([{ page: 1 }]);

    const updatedAt = conn.pluck<string>(
      'SELECT updated_at FROM files WHERE id = ?1', ['tb_meta'])!;
    await setMetadata({
      path: '/教材/book.pdf',
      metadata: { bookmarks: [{ page: 2 }], title: '拒绝.pdf' },
      expectedUpdatedAt: updatedAt,
    });
    expect(JSON.parse(conn.pluck<string>(
      'SELECT bookmarks_json FROM files WHERE id = ?1', ['tb_meta'])!))
      .toEqual([{ page: 2 }]);
    // Bookmark OCC does not short-circuit the remaining metadata keys.
    expect(conn.pluck<string>('SELECT file_name FROM files WHERE id = ?1', ['tb_meta']))
      .toBe('拒绝.pdf');

    await expect(setMetadata({
      path: '/教材/book.pdf',
      metadata: { bookmarks: [] },
      expectedUpdatedAt: textbook.updatedAt,
    })).rejects.toBe(
      `CONFLICT(textbooks.annotations_conflict): The textbook annotations changed `
      + `(expected ${textbook.updatedAt}, current ${conn.pluck<string>(
        'SELECT updated_at FROM files WHERE id = ?1', ['tb_meta'])!}).`,
    );
    await expect(setMetadata({
      path: '/教材/book.pdf', metadata: { bookmarks: 'nope' },
    })).rejects.toBe('INVALID_ARGUMENT: textbook bookmarks must be an array');
    cacheFolderItem('textbook', 'tb_missing', '/教材/missing.pdf');
    await expect(setMetadata({ path: '/教材/missing.pdf', metadata: {} }))
      .rejects.toBe('操作失败');
  });

  it('round-trips ordinary PDF highlights through the same revision as textbook annotations', async () => {
    const file = insertTextbook('file_paper');
    conn.run('UPDATE files SET mime_type = ?1, ocr_pages_json = ?2 WHERE id = ?3',
      ['application/pdf', '["scanned page"]', 'file_paper']);
    const path = '/file_paper';
    const before = await invoke<DstuNode>('dstu_get', { path });
    expect(before.metadata).toMatchObject({
      annotationRevision: file.updatedAt, highlights: [], ocrPagesJson: '["scanned page"]',
    });
    const highlights = [{ id: 'reading-note', pageIndex: 1, text: 'result', comment: 'verify' }];
    await setMetadata({ path, metadata: { highlights }, expectedUpdatedAt: file.updatedAt });
    const after = await invoke<DstuNode>('dstu_get', { path });
    expect(after.metadata).toMatchObject({ highlights });
    expect(after.metadata).not.toMatchObject({ annotationRevision: file.updatedAt });
    expect(host.eventsNamed('pdf-annotations:changed')).toContainEqual(expect.objectContaining({
      textbook_id: 'file_paper', resource_path: path,
    }));
    await expect(setMetadata({ path, metadata: { highlights: [] }, expectedUpdatedAt: file.updatedAt }))
      .rejects.toMatch(/^CONFLICT\(textbooks\.annotations_conflict\)/);
  });

  it('replaces textbook highlights with an annotation revision and emits the PDF event', async () => {
    const folder = await createFolder('高亮');
    const textbook = insertTextbook('tb_hl');
    cacheFolderItem('textbook', 'tb_hl', '/高亮/book.pdf', folder.id);

    await expect(setMetadata({
      path: '/高亮/book.pdf', metadata: { highlights: [{ id: 'h1' }] },
    })).rejects.toBe(
      'CONFLICT(textbooks.annotations_conflict): expected_updated_at is required when '
      + 'replacing highlights',
    );
    await expect(setMetadata({
      path: '/高亮/book.pdf',
      metadata: { highlights: 'nope' },
      expectedUpdatedAt: textbook.updatedAt,
    })).rejects.toBe('INVALID_ARGUMENT: textbook highlights must be an array');
    await expect(setMetadata({
      path: '/高亮/book.pdf',
      metadata: { highlights: Array.from({ length: 501 }, () => ({})) },
      expectedUpdatedAt: textbook.updatedAt,
    })).rejects.toBe('INVALID_ARGUMENT: textbook highlights cannot exceed 500 items');

    await setMetadata({
      path: '/高亮/book.pdf',
      metadata: {
        highlights: [{ id: 'h1', page: 1, color: 'yellow' }],
        title: '不会生效.pdf',
        isFavorite: true,
      },
      expectedUpdatedAt: textbook.updatedAt,
    });
    const metadata = JSON.parse(conn.pluck<string>(
      'SELECT metadata_json FROM resources WHERE id = ?1', [textbook.resourceId])!);
    expect(metadata).toEqual({ extra: { highlights: [{ id: 'h1', page: 1, color: 'yellow' }] } });
    // Replacing highlights returns immediately and skips the other metadata keys.
    expect(conn.pluck<number>('SELECT is_favorite FROM files WHERE id = ?1', ['tb_hl'])).toBe(0);
    expect(conn.pluck<string>('SELECT file_name FROM files WHERE id = ?1', ['tb_hl']))
      .toBe('book.pdf');

    const events = host.eventsNamed('pdf-annotations:changed') as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      textbook_id: 'tb_hl',
      resource_path: '/高亮/book.pdf',
      kind: 'highlights',
    });
    expect(typeof events[0]!.updated_at).toBe('string');

    await expect(setMetadata({
      path: '/高亮/book.pdf',
      metadata: { highlights: [] },
      expectedUpdatedAt: textbook.updatedAt,
    })).rejects.toMatch(/^CONFLICT\(textbooks\.annotations_conflict\): The textbook annotations/);

    const currentUpdatedAt = conn.pluck<string>(
      'SELECT updated_at FROM files WHERE id = ?1', ['tb_hl'])!;
    await setMetadata({
      path: '/高亮/book.pdf',
      metadata: { highlights: [{ id: 'h1' }, { id: 'h2' }] },
      expectedUpdatedAt: currentUpdatedAt,
    });
    expect(JSON.parse(conn.pluck<string>(
      'SELECT metadata_json FROM resources WHERE id = ?1', [textbook.resourceId])!).extra.highlights)
      .toHaveLength(2);
  });

  it('updates exam, file, mindmap and folder metadata', async () => {
    const exam = await create({ type: 'exam', name: '旧卷' });
    await setMetadata({ path: exam.id, metadata: { isFavorite: true, name: '新卷' } });
    expect(conn.get<{ exam_name: string; is_favorite: number }>(
      'SELECT exam_name, is_favorite FROM exam_sheets WHERE id = ?1', [exam.id]))
      .toEqual({ exam_name: '新卷', is_favorite: 1 });
    await expect(setMetadata({ path: 'exam_missing', metadata: { isFavorite: true } }))
      .rejects.toBe('ExamSheet not found: exam_missing');

    const file = await create({
      type: 'file', name: 'old.txt', fileBase64: Buffer.from('abc').toString('base64'),
    });
    await setMetadata({
      path: file.id,
      metadata: {
        readingProgress: { page: 5 }, bookmarks: [{ page: 1 }],
        isFavorite: true, fileName: 'new.txt',
      },
    });
    expect(conn.get<{
      last_page: number; is_favorite: number; file_name: string; bookmarks_json: string;
    }>('SELECT last_page, is_favorite, file_name, bookmarks_json FROM files WHERE id = ?1',
      [file.id]))
      .toMatchObject({ last_page: 5, is_favorite: 1, file_name: 'new.txt' });
    // Bookmarks piggybacked on readingProgress are skipped without a version.
    expect(JSON.parse(conn.pluck<string>(
      'SELECT bookmarks_json FROM files WHERE id = ?1', [file.id])!)).toEqual([]);
    await setMetadata({ path: file.id, metadata: { bookmarks: [{ page: 1 }] } });
    expect(JSON.parse(conn.pluck<string>(
      'SELECT bookmarks_json FROM files WHERE id = ?1', [file.id])!)).toEqual([{ page: 1 }]);
    await expect(setMetadata({ path: file.id, metadata: { bookmarks: [1], readingProgress: { page: 2 } } }))
      .resolves.toBeNull();
    expect(JSON.parse(conn.pluck<string>(
      'SELECT bookmarks_json FROM files WHERE id = ?1', [file.id])!)).toEqual([{ page: 1 }]);
    await expect(setMetadata({ path: file.id, metadata: { bookmarks: {} } }))
      .rejects.toBe('INVALID_ARGUMENT: file bookmarks must be an array');
    await expect(setMetadata({ path: 'file_missing', metadata: { fileName: 'x' } }))
      .rejects.toBe('File not found: file_missing');

    const mindmap = await create({
      type: 'mindmap', name: '旧图',
      content: '{"root":{"id":"root","text":"根"}}',
    });
    const contentUpdatedAt = conn.pluck<string>(
      'SELECT content_updated_at FROM mindmaps WHERE id = ?1', [mindmap.id]);
    const mindmapNode = await invoke<DstuNode>('dstu_get', { path: mindmap.id });
    await setMetadata({
      path: mindmap.id, metadata: { isFavorite: true, title: '新图', description: '说明' },
    });
    expect(conn.get<{ title: string; description: string; is_favorite: number; content_updated_at: string }>(
      'SELECT title, description, is_favorite, content_updated_at FROM mindmaps WHERE id = ?1',
      [mindmap.id]))
      .toEqual({
        title: '新图', description: '说明', is_favorite: 1, content_updated_at: contentUpdatedAt,
      });
    expect(conn.pluck<string>('SELECT updated_at FROM mindmaps WHERE id = ?1', [mindmap.id]))
      .not.toBe(new Date(mindmapNode.updatedAt).toISOString());
    await expect(setMetadata({ path: 'mm_missing', metadata: { isFavorite: true } }))
      .rejects.toBe('MindMap not found: mm_missing');
    await expect(setMetadata({ path: mindmap.id, metadata: {} })).resolves.toBeNull();

    const folder = await createFolder('文件夹');
    const folderNote = await create({
      type: 'note', name: '在文件夹里', metadata: { folderId: folder.id },
    });
    conn.run('UPDATE folder_items SET cached_path = ?1 WHERE item_id = ?2', ['/缓存', folderNote.id]);
    await setMetadata({
      path: folder.id,
      metadata: { isFavorite: true, title: '改名', icon: '📚', color: 'red' },
    });
    const folderEvent = (host.eventsNamed('dstu:change') as Array<{
      type: string; path: string; node: DstuNode;
    }>).at(-1)!;
    expect(folderEvent).toMatchObject({ type: 'updated', path: folder.id });
    expect(folderEvent.node).toMatchObject({
      id: folder.id,
      name: '改名',
      type: 'folder',
      previewType: 'none',
      metadata: { isExpanded: true, isFavorite: true, icon: '📚', color: 'red' },
    });
    expect(folderEvent.node.updatedAt).toBe(folder.updatedAt);
    // Rust `update_folder_with_conn` never writes `is_favorite`, so the flag
    // only shows up in the in-memory node/event payload.
    expect(conn.get<{ title: string; icon: string; color: string; is_favorite: number }>(
      'SELECT title, icon, color, is_favorite FROM folders WHERE id = ?1', [folder.id]))
      .toEqual({ title: '改名', icon: '📚', color: 'red', is_favorite: 0 });
    expect(conn.pluck<string | null>(
      'SELECT cached_path FROM folder_items WHERE item_id = ?1', [folderNote.id])).toBeNull();

    // A non-boolean isFavorite suppresses the `favorite` alias like Rust's `.or()`.
    const other = await createFolder('别名');
    const before = conn.pluck<number>('SELECT is_favorite FROM folders WHERE id = ?1', [other.id]);
    await setMetadata({ path: other.id, metadata: { isFavorite: 'yes', favorite: true } });
    expect(conn.pluck<number>('SELECT is_favorite FROM folders WHERE id = ?1', [other.id]))
      .toBe(before);
    await setMetadata({ path: other.id, metadata: { favorite: true } });
    const aliasEvent = (host.eventsNamed('dstu:change') as Array<{ node: DstuNode }>).at(-1)!;
    expect(aliasEvent.node.metadata).toMatchObject({ isFavorite: true });
    expect(conn.pluck<number>('SELECT is_favorite FROM folders WHERE id = ?1', [other.id])).toBe(0);

    await expect(setMetadata({ path: 'fld_missing', metadata: {} }))
      .rejects.toBe('Resource not found: fld_missing');
  });
});
