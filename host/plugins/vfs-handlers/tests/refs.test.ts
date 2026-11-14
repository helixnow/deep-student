import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { ResolvedResource, VfsContextRefData, VfsResourceRef } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import * as repo from '../repository/refs.ts';
import { extractFileText, resolveResourceRefs, type RefDeps } from '../src/refs.ts';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
let db: DatabaseHandle;
beforeEach(async () => {
  vfs = await createVfsHost();
  db = vfs.storage.openFile(join(vfs.root, 'refs-fixture.db'));
  // Match Rust create_test_db exactly; coalesce fixtures deliberately permit NULL titles.
  db.exec(`CREATE TABLE files (id TEXT PRIMARY KEY, file_name TEXT NOT NULL,
    extracted_text TEXT, ocr_pages_json TEXT, resource_id TEXT);
    CREATE TABLE resources (id TEXT PRIMARY KEY, hash TEXT, deleted_at TEXT);
    CREATE TABLE exam_sheets (id TEXT PRIMARY KEY, exam_name TEXT, resource_id TEXT, deleted_at TEXT);
    CREATE TABLE translations (id TEXT PRIMARY KEY, title TEXT, resource_id TEXT, deleted_at TEXT);
    CREATE TABLE essays (id TEXT PRIMARY KEY, title TEXT, resource_id TEXT, deleted_at TEXT);`);
}, 120_000);
afterEach(async () => { await vfs?.dispose(); });

function file(id: string, extracted: string | null, ocr: string | null, resourceId: string | null = null) {
  db.run('INSERT INTO files VALUES (?1, ?2, ?3, ?4, ?5)', [id, 'test.pdf', extracted, ocr, resourceId]);
}
const extract = (id: string) => repo.extractFileTextWithStrategy(db, id, null, vfs.host.ctx.logger);
const invoke = <T>(name: string, args: Record<string, unknown> = {}) => vfs.host.invoke(name, args) as Promise<T>;

describe('ref_handlers.rs::tests', { timeout: 120_000 }, () => {
  it('test_extract_file_text_ocr_priority', () => {
    file('file_001', '短文本', JSON.stringify(['这是第一页的OCR文本，内容很长'.repeat(5), '这是第二页的OCR文本'.repeat(5)]));
    const text = extract('file_001');
    expect(text).toContain('--- 第 1 页 ---');
    expect(text).toContain('--- 第 2 页 ---');
    expect(text).toContain('这是第一页的OCR文本');
  });
  it('test_extract_file_text_extracted_fallback', () => {
    const text = '这是从文档中提取的文本内容，比较长，足够使用。包含很多字符以确保测试有效。';
    file('file_002', text, null);
    expect(extract('file_002')).toBe(text);
  });
  it('test_extract_file_text_empty_ocr', () => {
    file('file_003', '提取的文本内容', '[null,"",null]');
    expect(extract('file_003')).toBe('提取的文本内容');
  });
  it('test_extract_file_text_no_content', () => {
    file('file_004', null, null);
    expect(extract('file_004')).toBeNull();
  });
  it('test_extract_file_text_nonexistent_file', () => { expect(extract('file_nonexistent')).toBeNull(); });
  it('test_extract_file_text_by_resource_id', () => {
    file('file_010', 'resource id extracted text', '["resource id OCR text"]', 'res_010');
    expect(extract('res_010')).toContain('resource id');
  });
  it('test_extract_file_text_longer_wins', () => {
    file('file_005', '这是一段非常非常非常非常非常非常非常非常非常非常非常非常非常长的提取文本，远远超过OCR的长度', '["短OCR"]');
    expect(extract('file_005')).toContain('非常非常非常');
    expect(extract('file_005')).not.toContain('--- 第');
  });
  it('test_extract_file_text_whitespace_only_extracted', () => {
    file('file_006', '   \n\t  ', '["有效的OCR文本内容"]');
    expect(extract('file_006')).toContain('有效的OCR文本内容');
  });
  it('test_get_ocr_pages_text_valid', () => {
    file('file_ocr_1', null, '["第一页内容","第二页内容","第三页内容"]');
    const text = repo.getOcrPagesText(db, 'file_ocr_1', vfs.host.ctx.logger);
    for (const [i, word] of ['一', '二', '三'].entries()) {
      expect(text).toContain(`--- 第 ${i + 1} 页 ---`);
      expect(text).toContain(`第${word}页内容`);
    }
  });
  it('test_get_ocr_pages_text_with_nulls', () => {
    file('file_ocr_2', null, '["第一页",null,"第三页",null]');
    const text = repo.getOcrPagesText(db, 'file_ocr_2', vfs.host.ctx.logger);
    expect(text).toContain('--- 第 1 页 ---\n第一页');
    expect(text).toContain('--- 第 3 页 ---\n第三页');
    expect(text).not.toContain('--- 第 2 页 ---');
    expect(text).not.toContain('--- 第 4 页 ---');
  });
  it('test_get_ocr_pages_text_empty_array', () => {
    file('file_ocr_3', null, '[]');
    expect(repo.getOcrPagesText(db, 'file_ocr_3', vfs.host.ctx.logger)).toBeNull();
  });
  it('test_get_ocr_pages_text_all_empty', () => {
    file('file_ocr_4', null, '["","  ",null]');
    expect(repo.getOcrPagesText(db, 'file_ocr_4', vfs.host.ctx.logger)).toBeNull();
  });
  it('test_get_ocr_pages_text_invalid_json', () => {
    file('file_ocr_5', null, 'not a valid json');
    expect(repo.getOcrPagesText(db, 'file_ocr_5', vfs.host.ctx.logger)).toBeNull();
  });
  it('test_get_extracted_text_valid', () => {
    file('file_ext_1', '提取的文本内容', null);
    expect(repo.getExtractedText(db, 'file_ext_1')).toBe('提取的文本内容');
  });
  it('test_get_extracted_text_empty', () => {
    file('file_ext_2', '', null);
    expect(repo.getExtractedText(db, 'file_ext_2')).toBeNull();
  });
  it('test_get_extracted_text_whitespace_only', () => {
    file('file_ext_3', '   \n\t  ', null);
    expect(repo.getExtractedText(db, 'file_ext_3')).toBeNull();
  });
  it('test_get_extracted_text_none', () => {
    file('file_ext_4', null, null);
    expect(repo.getExtractedText(db, 'file_ext_4')).toBeNull();
  });
  it('test_get_source_id_type', () => {
    expect(repo.getSourceIdType('note_abc123')).toEqual({ type: 'note', table: 'notes', titleColumn: 'title' });
    expect(repo.getSourceIdType('tb_xyz789')).toEqual({ type: 'textbook', table: 'files', titleColumn: 'file_name' });
    expect(repo.getSourceIdType('exam_def456')).toMatchObject({ type: 'exam', table: 'exam_sheets' });
    expect(repo.getSourceIdType('tr_ghi789')).toEqual({ type: 'translation', table: 'translations', titleColumn: 'COALESCE(title, id)' });
    expect(repo.getSourceIdType('essay_jkl012')).toMatchObject({ type: 'essay', table: 'essays' });
    expect(repo.getSourceIdType('att_mno345')).toMatchObject({ type: 'file', table: 'files' });
    expect(repo.getSourceIdType('file_pqr678')).toMatchObject({ type: 'file', table: 'files' });
    expect(repo.getSourceIdType('mm_stu901')).toMatchObject({ type: 'mindmap', table: 'mindmaps' });
    for (const id of ['unknown_123', 'fld_abc', '']) expect(repo.getSourceIdType(id)).toBeNull();
  });
  it('test_get_source_id_type_essay_session_priority', () => {
    for (const id of ['essay_session_abc', 'essay_session_XyZ_123']) {
      expect(repo.getSourceIdType(id)).toEqual({ type: 'essay', table: 'essay_sessions', titleColumn: 'COALESCE(title, id)' });
    }
    expect(repo.getSourceIdType('essay_abc')).toMatchObject({ type: 'essay', table: 'essays' });
  });
  it('test_get_resource_ref_with_conn_exam_coalesce_title', () => {
    db.run("INSERT INTO resources VALUES ('res_exam_1','hash_exam_1',NULL)");
    db.run("INSERT INTO exam_sheets VALUES ('exam_test_1',NULL,'res_exam_1',NULL)");
    expect(repo.getResourceRef(db, 'exam_test_1')).toEqual({ sourceId: 'exam_test_1', name: 'exam_test_1', resourceHash: 'hash_exam_1', type: 'exam' });
  });
  it('test_get_resource_ref_with_conn_translation_coalesce_title', () => {
    db.run("INSERT INTO resources VALUES ('res_tr_1','hash_tr_1',NULL)");
    db.run("INSERT INTO translations VALUES ('tr_test_1',NULL,'res_tr_1',NULL)");
    expect(repo.getResourceRef(db, 'tr_test_1')).toEqual({ sourceId: 'tr_test_1', name: 'tr_test_1', resourceHash: 'hash_tr_1', type: 'translation' });
  });
  it('test_get_resource_ref_with_conn_essay_coalesce_title', () => {
    db.run("INSERT INTO resources VALUES ('res_essay_1','hash_essay_1',NULL)");
    db.run("INSERT INTO essays VALUES ('essay_test_1',NULL,'res_essay_1',NULL)");
    expect(repo.getResourceRef(db, 'essay_test_1')).toEqual({ sourceId: 'essay_test_1', name: 'essay_test_1', resourceHash: 'hash_essay_1', type: 'essay' });
  });
  it('test_vfs_context_ref_data_default', async () => {
    expect(await invoke('vfs_get_resource_refs', { params: { sourceIds: [] } })).toEqual({ refs: [], truncated: false, totalCount: 0 });
  });
  it('test_vfs_resource_ref_serialization', () => {
    db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY,title TEXT,resource_id TEXT,deleted_at TEXT)');
    db.run("INSERT INTO resources VALUES ('res_note','sha256hash',NULL)");
    db.run("INSERT INTO notes VALUES ('note_abc123','Test Note','res_note',NULL)");
    const value = repo.getResourceRef(db, 'note_abc123');
    expect(JSON.stringify(value)).toBe('{"sourceId":"note_abc123","resourceHash":"sha256hash","type":"note","name":"Test Note"}');
  });
  it('test_resolved_resource_serialization', async () => {
    const note = await invoke<{ id: string }>('vfs_create_note', { params: { title: 'Test Note', content: 'note content' } });
    const refs = (await invoke<VfsContextRefData>('vfs_get_resource_refs', { params: { sourceIds: [note.id] } })).refs;
    const [value] = await invoke<ResolvedResource[]>('vfs_resolve_resource_refs', { refs });
    expect(JSON.stringify(value)).toContain(`"sourceId":"${note.id}"`);
    expect(JSON.stringify(value)).toContain(`"path":"${note.id}"`);
    expect(JSON.stringify(value)).toContain('"found":true');
    expect(value!.content).toBe('note content');
  });
  it('test_get_resource_refs_input_deserialization', async () => {
    const direct = await invoke<{ id: string }>('vfs_create_note', { params: { title: 'Direct', content: 'direct' } });
    const nested = await invoke<{ id: string }>('vfs_create_note', { params: { title: 'Nested', content: 'nested' } });
    const conn = vfs.storage.database('vfs');
    vfs.host.ctx.vfsRepo.folders.createFolder(conn, { id: 'fld_refs', title: 'Refs', isExpanded: true,
      isFavorite: false, sortOrder: 0, createdAt: 1, updatedAt: 1 });
    vfs.host.ctx.vfsRepo.folders.addItemToFolder(conn, { id: 'fi_refs', folderId: 'fld_refs', itemType: 'note', itemId: nested.id, sortOrder: 0, createdAt: 1 });
    const params = { sourceIds: ['fld_refs', ...Array<string>(31).fill(direct.id)], includeFolderContents: true, maxItems: 30 };
    const result = await invoke<VfsContextRefData>('vfs_get_resource_refs', { params });
    expect(result.refs).toHaveLength(30);
    expect(result.refs[0]!.sourceId).toBe(nested.id); // includeFolderContents was consumed.
    expect(result.refs.slice(1).every(ref => ref.sourceId === direct.id)).toBe(true);
    expect(result.truncated).toBe(true); // maxItems was consumed, not the default 50.
  });
  it('test_get_resource_refs_input_defaults', async () => {
    const note = await invoke<{ id: string }>('vfs_create_note', { params: { title: 'Test', content: 'body' } });
    const result = await invoke<VfsContextRefData>('vfs_get_resource_refs', { params: { sourceIds: Array(51).fill(note.id) } });
    expect(result.refs).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.totalCount).toBe(50);
  });
});

describe('reference command integration', { timeout: 120_000 }, () => {
  it('preserves PDF image-only content, compressed image preference and escaped OCR blocks', async () => {
    const conn = vfs.storage.database('vfs');
    const repos = vfs.host.ctx.vfsRepo;
    const blobsDir = vfs.host.ctx.vfsDatabase.blobsDir();
    const original = repos.blobs.storeBlob(conn, blobsDir, Buffer.from('original'), 'image/png', 'png');
    const compressed = repos.blobs.storeBlob(conn, blobsDir, Buffer.from('compressed'), 'image/jpeg', 'jpg');
    const file = repos.files.createFileWithDocDataInFolder(conn, 'refs-pdf', 'A&B.pdf', 10, 'document', 'application/pdf', null, null, null,
      JSON.stringify({ pages: [{ blobHash: original.hash, compressedBlobHash: compressed.hash }] }), null, 1);
    conn.run('UPDATE files SET ocr_pages_json=?1 WHERE id=?2', ['["<ocr>"]', file.id]);
    const ref = { sourceId: file.id, resourceHash: 'old', type: 'file', name: 'old', injectModes: { pdf: ['image'] } };
    const [resolved] = await invoke<ResolvedResource[]>('vfs_resolve_resource_refs', { refs: [ref] });
    expect(resolved).toMatchObject({ found: true, name: 'A&B.pdf', content: '[文档: A&B.pdf]' });
    expect(resolved).not.toHaveProperty('warning');
    expect(resolved!.multimodalBlocks).toEqual([
      { type: 'text', text: `<pdf_page name="A&amp;B.pdf" source_id="${file.id}" page="1">[PDF@${file.id}:1] A&amp;B.pdf 第1页</pdf_page>` },
      { type: 'image', mediaType: 'image/jpeg', base64: Buffer.from('compressed').toString('base64') },
      { type: 'text', text: '<page number="1">&lt;ocr&gt;</page>' },
    ]);
  });
  it('uses the pending canonical qbank interface without replacing its document with a text approximation', async () => {
    const conn = vfs.storage.database('vfs');
    const repos = vfs.host.ctx.vfsRepo;
    const exam = repos.exams.createExamSheet(conn, { examName: 'Exam', tempId: 'refs-exam', metadataJson: {}, previewJson: {} });
    const document = { schema_version: 2, exam_id: exam.id, materials: [], groups: [], questions: [{ id: 'q_1', content: 'question', images: [{ id: 'img_1', hash: 'missing', mime: 'image/png' }] }] };
    const calls: string[] = [];
    const deps: RefDeps = { conn: () => conn, repos, readBytes: readFile, blobsDir: () => vfs.host.ctx.vfsDatabase.blobsDir(), log: vfs.host.ctx.logger,
      qbank: { contextForRefs(id) { calls.push(id); return document; } } };
    const [result] = await resolveResourceRefs(deps, [{ sourceId: exam.id, resourceHash: 'h', type: 'exam', name: 'Exam' }]);
    expect(calls).toEqual([exam.id]);
    expect(result!.content).toBe(JSON.stringify(document));
    expect(result!.multimodalBlocks).toEqual([{ type: 'text', text: JSON.stringify(document) }, { type: 'text', text: '[REQUIRED_QUESTION_IMAGE_UNAVAILABLE: "img_1"]' }]);
  });
  it('resolves live notes and tracks ref counts; deleted notes resolve as missing', async () => {
    const note = await invoke<{ id: string; resourceId: string }>('vfs_create_note', { params: { title: 'Title', content: 'note content' } });
    const refs = (await invoke<VfsContextRefData>('vfs_get_resource_refs', { params: { sourceIds: [note.id] } })).refs;
    expect(refs).toHaveLength(1);
    expect(await invoke('vfs_resolve_resource_refs', { refs })).toEqual([{ ...refs[0], path: note.id, content: 'note content', found: true }]);
    const conn = vfs.storage.database('vfs');
    conn.run('UPDATE resources SET ref_count=7 WHERE id=?1', [note.resourceId]);
    expect(await invoke('vfs_get_resource_ref_count', { sourceId: note.id })).toBe(7);
    await invoke('vfs_delete_note', { id: note.id });
    expect(await invoke('vfs_resolve_resource_refs', { refs })).toEqual([{ ...refs[0], path: '', found: false }]);
  });
  it('enforces the resolve cap and supports retrieval snippet fallback', async () => {
    const ref = { sourceId: 'unresolved', resourceHash: 'h', type: 'retrieval', name: 'Title', snippet: '  snippet  ' };
    expect(await invoke('vfs_resolve_resource_refs', { refs: [ref] })).toEqual([{ sourceId: ref.sourceId, resourceHash: 'h', type: 'retrieval', name: 'Title', path: '', found: true, content: 'snippet', warning: 'retrieval snippet fallback' }]);
    await expect(invoke('vfs_resolve_resource_refs', { refs: Array(51).fill(ref) })).rejects.toBe('Too many refs to resolve: 51 (max: 50)');
  });
  it('uses sparse OCR indices, blocks and UTF-8 byte lengths', () => {
    expect(repo.parseOcrPagesJson(JSON.stringify({ pages: [{ pageIndex: 2, text: 'a', blocks: [{ text: ' 中文 ' }] }] }), vfs.host.ctx.logger))
      .toEqual([null, null, '中文']);
    file('file_bytes', '中文'.repeat(20), '["abcdefghijklmnopqrstuvwxyz"]');
    expect(extract('file_bytes')).toBe('中文'.repeat(20));
  });
  it('calls the docs parser only below the Rust byte threshold and selects the longer text', async () => {
    file('file_parser', 'tiny', null);
    const calls: string[] = [];
    const deps: RefDeps = { conn: () => db, readBytes: readFile, blobsDir: () => '', repos: vfs.host.ctx.vfsRepo, log: vfs.host.ctx.logger,
      docs: { async extractTextFromBase64(name, data) { calls.push(`${name}:${data}`); return 'parsed document'; } } };
    expect(await extractFileText(deps, 'file_parser', 'test.pdf', 'AAAA')).toBe('parsed document');
    expect(calls).toEqual(['test.pdf:AAAA']);
    db.run('UPDATE files SET extracted_text=?1 WHERE id=?2', ['中'.repeat(334), 'file_parser']);
    expect(await extractFileText(deps, 'file_parser', 'test.pdf', 'AAAA')).toBe('中'.repeat(334));
    expect(calls).toHaveLength(1);
  });
});
