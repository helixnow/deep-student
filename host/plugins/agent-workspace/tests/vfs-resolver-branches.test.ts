import { afterEach, expect, it, vi } from 'vitest';
import { inMemoryVfsDb, type VfsTestDb } from './vfs-support.ts';
import { createVfsResolver, resolveContextRefDataToContent, extractMindmapOutline,
  type VfsResourceRef, type VfsResolverServices } from '../src/vfs-resolver.ts';
import type { VfsService } from '../../vfs/api.ts';

const opened: VfsTestDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function fixture() {
  const db = inMemoryVfsDb();
  opened.push(db);
  db.db.exec(`
    CREATE TABLE resources (id TEXT PRIMARY KEY, data TEXT, ocr_text TEXT);
    CREATE TABLE notes (id TEXT PRIMARY KEY, resource_id TEXT, title TEXT);
    CREATE TABLE essays (id TEXT PRIMARY KEY, resource_id TEXT, title TEXT, session_id TEXT,
      round_number INTEGER, created_at TEXT, deleted_at TEXT);
    CREATE TABLE essay_sessions (id TEXT PRIMARY KEY, title TEXT, essay_type TEXT, total_rounds INTEGER, deleted_at TEXT);
    CREATE TABLE translations (id TEXT PRIMARY KEY, resource_id TEXT, title TEXT);
    CREATE TABLE mindmaps (id TEXT PRIMARY KEY, resource_id TEXT, title TEXT, description TEXT, deleted_at TEXT);
    CREATE TABLE insights (id TEXT PRIMARY KEY, current_revision_id TEXT, title TEXT, deleted_at TEXT);
    CREATE TABLE insight_revisions (id TEXT PRIMARY KEY, resource_id TEXT);
    CREATE TABLE files (id TEXT PRIMARY KEY, resource_id TEXT, extracted_text TEXT, preview_json TEXT,
      page_count INTEGER, ocr_pages_json TEXT);
  `);
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const getContent = vi.fn((): string | null => 'Ym9keQ==');
  const parse = vi.fn(async () => '<parsed>');
  const services = {
    vfsRepo: { files: { getContent, getFile: vi.fn(() => ({ blobHash: 'original', compressedBlobHash: 'compressed' })) },
      blobs: { getBlobPath: vi.fn(() => '/compressed.jpg') } },
    docs: { extractTextFromBase64: parse },
  } as unknown as VfsResolverServices;
  const ref = (type: VfsResourceRef['type'], sourceId = 'id', name = 'A"&'): VfsResourceRef =>
    ({ type, sourceId, name, resourceHash: 'hash' });
  const vfs = { version: 1, database: { getConnSafe: () => db.executor, blobsDir: () => '.' } } as unknown as VfsService;
  const resolver = createVfsResolver(vfs, services, logger);
  const resolve = (r: VfsResourceRef, multimodal = true) => resolver.resolveVfsRefToBlocks(r, multimodal);
  return { db, logger, services, getContent, parse, ref, resolve };
}

it('resolves joined note, essay, translation and current insight revision with Rust XML escaping', async () => {
  const f = fixture();
  f.db.db.exec(`INSERT INTO resources VALUES ('r', '<正文>&', NULL);
    INSERT INTO notes VALUES ('id', 'r', NULL);
    INSERT INTO essays VALUES ('id', 'r', 'essay', NULL, 1, 'now', NULL);
    INSERT INTO resources VALUES ('tr', '{"source":"<原文>","translated":"译文&"}', NULL);
    INSERT INTO translations VALUES ('id', 'tr', 'translation');
    INSERT INTO insight_revisions VALUES ('rev', 'r');
    INSERT INTO insights VALUES ('id', 'rev', 'insight', NULL);`);
  expect(await f.resolve(f.ref('note'))).toEqual([{ type: 'text', text: '<note title="A&quot;&amp;">&lt;正文&gt;&amp;</note>' }]);
  expect(await f.resolve(f.ref('essay'))).toEqual([{ type: 'text', text: '<essay title="essay">&lt;正文&gt;&amp;</essay>' }]);
  expect(await f.resolve(f.ref('translation'))).toEqual([{ type: 'text', text: '<translation title="translation">\n<original>\n&lt;原文&gt;\n</original>\n<translated>\n译文&amp;\n</translated>\n</translation>' }]);
  expect(await f.resolve(f.ref('insightcard'))).toEqual([{ type: 'text', text: '<insight_card title="insight">&lt;正文&gt;&amp;</insight_card>' }]);
  f.db.db.exec("UPDATE insights SET deleted_at = 'now'");
  expect(await f.resolve(f.ref('insightcard'))).toEqual([]);
  f.db.db.exec("UPDATE resources SET data = '<invalid>' WHERE id = 'tr'");
  expect(await f.resolve(f.ref('translation'))).toEqual([{ type: 'text', text: '<translation title="translation">&lt;invalid&gt;</translation>' }]);
  expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse translation JSON'));
});

it('aggregates essay sessions in round order and applies the Rust Unicode character budget', async () => {
  const f = fixture();
  f.db.db.exec(`INSERT INTO essay_sessions VALUES ('essay_session_1', '', NULL, 2, NULL);
    INSERT INTO resources VALUES ('a', 'second', NULL);
    INSERT INTO resources VALUES ('b', 'first', NULL);
    INSERT INTO essays VALUES ('a', 'a', NULL, 'essay_session_1', 2, '0', NULL);
    INSERT INTO essays VALUES ('b', 'b', NULL, 'essay_session_1', 1, '1', NULL);`);
  const ref = f.ref('essay', 'essay_session_1', '会话');
  const result = await f.resolve(ref);
  expect(result).toEqual([{ type: 'text', text: '<essay title="会话"># 作文会话: 会话\n类型: 未知, 总轮次: 2\n\n## 第 1 轮\nfirst\n\n## 第 2 轮\nsecond</essay>' }]);
  f.db.executor.run('UPDATE resources SET data = ? WHERE id = ?', ['😀'.repeat(20000), 'b']);
  const long = JSON.stringify(await f.resolve(ref));
  expect(long).toContain('[内容过长，已截断]');
  expect(long).not.toContain('second');
  expect(long).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
});

it('renders mindmap outlines and distinguishes NULL content, missing resources and raw JSON fallback', async () => {
  const f = fixture();
  f.db.db.exec(`INSERT INTO resources VALUES ('r', '{"root":{"text":"root","children":[{"text":"child"}]}}', NULL);
    INSERT INTO mindmaps VALUES ('id', 'r', 'map', 'desc&', NULL);`);
  expect(await f.resolve(f.ref('mindmap'))).toEqual([{ type: 'text', text: '<mindmap title="map">\n<description>desc&amp;</description>\n<outline>\n# root\n  - child\n</outline>\n</mindmap>' }]);
  f.db.db.exec("UPDATE resources SET data = 'null'");
  expect(JSON.stringify(await f.resolve(f.ref('mindmap')))).toContain('null');
  f.db.db.exec('UPDATE resources SET data = NULL');
  expect(await f.resolve(f.ref('mindmap'))).toEqual([]);
  expect(await f.resolve(f.ref('mindmap', 'missing', 'map'))).toEqual([{ type: 'text', text: '[知识导图未找到: map]' }]);
  let root: unknown = { text: 'leaf' };
  for (let i = 0; i < 101; i++) root = { text: 'branch', children: [root] };
  expect(extractMindmapOutline(root)).toContain('[outline truncated]');
});

it('uses vfsRepo compressed image MIME and adds only OCR when the model cannot consume images', async () => {
  const f = fixture();
  f.db.db.exec(`INSERT INTO resources VALUES ('r', NULL, 'ocr<&'); INSERT INTO files VALUES ('id', 'r', NULL, NULL, NULL, NULL);`);
  expect(await f.resolve(f.ref('image'))).toEqual([{ type: 'image', mediaType: 'image/jpeg', base64: 'Ym9keQ==' }]);
  f.getContent.mockClear();
  const downgraded = await f.resolve(f.ref('image'), false);
  expect(downgraded).toHaveLength(2);
  expect(downgraded[1]).toEqual({ type: 'text', text: '<image_ocr name="A&quot;&amp;">ocr&lt;&amp;</image_ocr>' });
  expect(f.getContent).not.toHaveBeenCalled();
});

it('awaits docs fallback and keeps explicit PDF selections authoritative', async () => {
  const f = fixture();
  const ref = f.ref('file', 'id', 'book.pdf');
  f.db.db.exec(`INSERT INTO files VALUES ('id', NULL, 'one\ftwo', NULL, 2, '["ocr"]');`);
  const text = JSON.stringify(await f.resolve(ref));
  expect(text).toContain('[PDF@id:2]');
  expect(text).not.toContain('pdf_ocr');
  expect(f.parse).not.toHaveBeenCalled();
  expect(await f.resolve({ ...ref, injectModes: { pdf: [] } })).toHaveLength(1);
  expect(f.parse).not.toHaveBeenCalled();
  f.db.db.exec(`UPDATE files SET preview_json = '{"pages":[null],"totalPages":2,"renderDpi":72,"renderedAt":"now"}'`);
  expect(await f.resolve({ ...ref, injectModes: { pdf: ['image'] } })).toHaveLength(1);
  f.db.db.exec('UPDATE files SET extracted_text = NULL');
  expect(JSON.stringify(await f.resolve(ref))).toContain('&lt;parsed&gt;');
  expect(f.parse).toHaveBeenCalledWith('book.pdf', 'Ym9keQ==');
  f.parse.mockRejectedValueOnce(new Error('parse failed'));
  expect(JSON.stringify(await f.resolve(ref))).toContain('[PDF 解析失败]');
  const history = await resolveContextRefDataToContent(f.db.executor, '.', { refs: [f.ref('image'), f.ref('file', 'id', 'readme.txt')] }, true, f.logger, f.services);
  expect(history.imageBase64List).toEqual(['Ym9keQ==']);
  expect(history.textContents.join('')).toContain('&lt;parsed&gt;');
});
