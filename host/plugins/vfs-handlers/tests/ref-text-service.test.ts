/**
 * `vfsRefText` 生产入口：ref_handlers.rs:340-412 `extract_file_text_with_strategy`，
 * 经插件 provide 的服务调用（L14 qbank reference.rs `library_source` 的消费面）。
 * 断言逐条对应 ref_handlers.rs::tests 的 test_extract_file_text_*。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { VfsRefTextService } from '../api.ts';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
let db: DatabaseHandle;
let service: VfsRefTextService;
beforeEach(async () => {
  vfs = await createVfsHost();
  service = vfs.host.ctx.vfsRefText;
  db = vfs.storage.openFile(join(vfs.root, 'ref-text-fixture.db'));
  // ref_handlers.rs create_test_db（files 表）。
  db.exec(`CREATE TABLE files (id TEXT PRIMARY KEY, file_name TEXT NOT NULL,
    extracted_text TEXT, ocr_pages_json TEXT, resource_id TEXT);`);
}, 120_000);
afterEach(async () => { await vfs?.dispose(); });

function file(id: string, extracted: string | null, ocr: string | null, resourceId: string | null = null) {
  db.run('INSERT INTO files VALUES (?1, ?2, ?3, ?4, ?5)', [id, 'test.pdf', extracted, ocr, resourceId]);
}
const extract = (id: string) => service.extractFileTextWithStrategy(db, id, 'test.pdf', null);
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('vfsRefText.extractFileTextWithStrategy (ref_handlers.rs::tests)', { timeout: 120_000 }, () => {
  it('is published with version 1', () => {
    expect(service.version).toBe(1);
  });
  it('test_extract_file_text_ocr_priority', async () => {
    file('file_001', '短文本', JSON.stringify(['这是第一页的OCR文本，内容很长'.repeat(5), '这是第二页的OCR文本'.repeat(5)]));
    const text = await extract('file_001');
    expect(text).toContain('--- 第 1 页 ---');
    expect(text).toContain('--- 第 2 页 ---');
    expect(text).toContain('这是第一页的OCR文本');
  });
  it('test_extract_file_text_extracted_fallback', async () => {
    const text = '这是从文档中提取的文本内容，比较长，足够使用。包含很多字符以确保测试有效。';
    file('file_002', text, null);
    expect(await extract('file_002')).toBe(text);
  });
  it('test_extract_file_text_empty_ocr', async () => {
    file('file_003', '提取的文本内容', '[null,"",null]');
    expect(await extract('file_003')).toBe('提取的文本内容');
  });
  it('test_extract_file_text_no_content', async () => {
    file('file_004', null, null);
    expect(await extract('file_004')).toBeNull();
  });
  it('test_extract_file_text_nonexistent_file', async () => {
    expect(await extract('file_nonexistent')).toBeNull();
  });
  it('test_extract_file_text_by_resource_id', async () => {
    file('file_010', 'resource id extracted text', '["resource id OCR text"]', 'res_010');
    expect(await extract('res_010')).toContain('resource id');
  });
  it('test_extract_file_text_longer_wins', async () => {
    file('file_005', '这是一段非常非常非常非常非常非常非常非常非常非常非常非常非常长的提取文本，远远超过OCR的长度', '["短OCR"]');
    const text = await extract('file_005');
    expect(text).toContain('非常非常非常');
    expect(text).not.toContain('--- 第');
  });
  it('test_extract_file_text_whitespace_only_extracted', async () => {
    file('file_006', '   \n\t  ', '["有效的OCR文本内容"]');
    expect(await extract('file_006')).toContain('有效的OCR文本内容');
  });
  it('compares UTF-8 byte lengths, not chars', async () => {
    // OCR ≈ "--- 第 1 页 ---\n" + 50 ASCII = 68 bytes / 64 chars; extracted = 30 × "中" = 90 bytes / 30 chars.
    file('file_bytes', '中'.repeat(30), JSON.stringify(['a'.repeat(50)]));
    expect(await extract('file_bytes')).toBe('中'.repeat(30));
  });

  it('falls back to the real L18 DocumentParser when extracted_text is short and base64 is given', async () => {
    const body = '实时解析得到的较长正文。'.repeat(20);
    file('file_parse', 'tiny', null);
    expect(await service.extractFileTextWithStrategy(db, 'file_parse', 'notes.txt', b64(body))).toBe(body);
  });
  it('skips the parser when base64 is null/empty or extracted_text reaches 1000 bytes', async () => {
    file('file_skip', 'tiny', null);
    expect(await service.extractFileTextWithStrategy(db, 'file_skip', 'notes.txt', null)).toBe('tiny');
    expect(await service.extractFileTextWithStrategy(db, 'file_skip', 'notes.txt', '')).toBe('tiny');
    const long = '中'.repeat(334); // 1002 bytes ≥ TEXT_THRESHOLD
    file('file_long', long, null);
    expect(await service.extractFileTextWithStrategy(db, 'file_long', 'notes.txt', b64('x'.repeat(5000)))).toBe(long);
  });
  it('keeps the stored text when the parser result is not longer', async () => {
    file('file_short_parse', 'stored text', null);
    expect(await service.extractFileTextWithStrategy(db, 'file_short_parse', 'notes.txt', b64('abc'))).toBe('stored text');
  });
  it('drops parser errors silently (Rust if-let-Ok) and keeps OCR/extracted selection', async () => {
    file('file_bad', null, '["OCR 兜底"]');
    const text = await service.extractFileTextWithStrategy(db, 'file_bad', 'broken.docx', b64('not a zip archive'));
    expect(text).toContain('OCR 兜底');
  });
  it('works on the production VFS connection', async () => {
    const conn = vfs.host.ctx.vfsDatabase.getConnSafe();
    conn.run(`INSERT INTO files (id, sha256, file_name, size, type, mime_type, tags_json, bookmarks_json, status, created_at, updated_at, extracted_text)
      VALUES ('file_prod_1', 'sha_prod_1', '讲义.pdf', 10, 'document', 'application/pdf', '[]', '[]', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '生产库里的解析文本')`);
    expect(await service.extractFileTextWithStrategy(conn, 'file_prod_1', '讲义.pdf', null)).toBe('生产库里的解析文本');
  });
});
