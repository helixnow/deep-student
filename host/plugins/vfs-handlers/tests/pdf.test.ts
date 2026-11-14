import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVfsHost, type VfsHost } from './harness.ts';
import { getPdfPageImage, type PdfDeps } from '../src/pdf.ts';
import { readPdfPageImageBytes } from '../api.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) =>
  vfs.host.invoke(name, args) as Promise<T>;
const repos = () => vfs.host.ctx.vfsRepo;
const db = () => vfs.storage.database('vfs');
const blobsDir = () => vfs.host.ctx.vfsDatabase.blobsDir();
const hostFiles = () => vfs.host.ctx.files;

function storeBlob(text: string, mimeType: string, extension: string): string {
  return repos().blobs.storeBlob(db(), blobsDir(), Buffer.from(text, 'utf8'), mimeType, extension).hash;
}

function previewJson(blobHash: string): string {
  return JSON.stringify({
    pages: [{ pageIndex: 0, blobHash, width: 100, height: 200, mimeType: 'image/png' }],
    renderDpi: 150, totalPages: 1, renderedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('vfs/handlers.rs PDF processing commands', { timeout: 120_000 }, () => {
  it('rejects Unicode-changing IDs before any PDF operation and skips them in batches', async () => {
    const service = vfs.host.ctx.vfsIndex.pdf;
    const status = vi.spyOn(service, 'getStatus');
    const cancel = vi.spyOn(service, 'cancel');
    const retry = vi.spyOn(service, 'retry');
    const start = vi.spyOn(service, 'startPipeline');
    const warn = vi.spyOn(vfs.host.ctx.logger, 'warn');
    try {
      for (const id of ['file_abc\u200b', 'tb_abc／x', 'att_abc\ufeff', 'bad\u200b']) {
        for (const command of ['vfs_get_pdf_processing_status', 'vfs_cancel_pdf_processing', 'vfs_retry_pdf_processing', 'vfs_start_pdf_processing']) {
          await expect(invoke(command, { fileId: id })).rejects.toBe("Invalid argument 'file_id': ID contains invalid Unicode characters");
        }
      }
      expect(status).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(await invoke('vfs_get_batch_pdf_processing_status', { fileIds: ['file_abc\u200b', 'file_missing'] })).toEqual({});
      expect(status.mock.calls).toEqual([['file_missing']]);
      expect(warn).toHaveBeenCalledWith('[VFS::handlers] Invalid file_id in batch: %s - %s', 'file_abc\u200b', expect.any(Error));
    } finally { vi.restoreAllMocks(); }
  });
  it('vfs_get_pdf_processing_status validates ids and reports missing rows as null', async () => {
    expect(await invoke('vfs_get_pdf_processing_status', { fileId: 'file_missing' })).toBeNull();
    for (const bad of ['res_abc', 'note_abc']) {
      await expect(invoke('vfs_get_pdf_processing_status', { fileId: bad }))
        .rejects.toBe(`Invalid argument 'file_id': Invalid file_id format: ${bad}`);
    }
  });

  it('vfs_cancel_pdf_processing returns false when nothing runs', async () => {
    expect(await invoke('vfs_cancel_pdf_processing', { fileId: 'file_idle' })).toBe(false);
    await expect(invoke('vfs_cancel_pdf_processing', { fileId: 'note_abc' }))
      .rejects.toBe("Invalid argument 'file_id': Invalid file_id format: note_abc");
  });

  it('vfs_retry_pdf_processing surfaces missing files', async () => {
    await expect(invoke('vfs_retry_pdf_processing', { fileId: 'file_missing' }))
      .rejects.toBe('File not found: file_missing');
  });

  it('vfs_get_batch_pdf_processing_status skips invalid and unknown ids', async () => {
    expect(await invoke('vfs_get_batch_pdf_processing_status', {
      fileIds: ['file_a', 'note_bad', 'tb_c'],
    })).toEqual({});
  });

  it('vfs_list_pending_pdf_processing selects active pending PDFs only', async () => {
    // processing_status IS NULL 的 PDF 也属于待处理（Rust 查询条件）。
    repos().files.createFile(
      db(), 'sha_pdf_pending', 'pending.pdf', 10, 'document', 'application/pdf', null, null,
    );
    repos().files.createFileWithDocDataInFolder(
      db(), 'sha_pdf_done', 'done.pdf', 10, 'document', 'application/pdf', null, null,
      null, null, null, 1,
    );
    repos().files.createFile(db(), 'sha_img', 'pic.png', 5, 'image', 'image/png', null, null);
    // createFileWithDocDataInFolder defaults to status active; processing_status NULL 也视为待处理。
    const files = await invoke<Array<{ fileName: string; mimeType?: string }>>(
      'vfs_list_pending_pdf_processing', { limit: 10 },
    );
    expect(files.map(file => file.fileName)).toContain('pending.pdf');
    expect(files.every(file => file.mimeType === 'application/pdf')).toBe(true);
  });

  it('vfs_get_pdf_page_image prefers compressed preview blobs', async () => {
    const original = storeBlob('original-page', 'image/png', 'png');
    const compressed = storeBlob('compressed-page', 'image/jpeg', 'jpg');
    const file = repos().files.createFileWithDocDataInFolder(
      db(), 'sha_preview', 'doc.pdf', 10, 'document', 'application/pdf', null, null, null,
      JSON.stringify({
        pages: [
          { pageIndex: 0, blobHash: original, width: 100, height: 200, mimeType: 'image/png', compressedBlobHash: compressed },
          { pageIndex: 1, blobHash: original, width: 100, height: 200, mimeType: 'image/png' },
        ],
        renderDpi: 150, totalPages: 2, renderedAt: '2026-01-01T00:00:00.000Z',
      }), null, 2,
    );
    expect(file.resourceId).toBeDefined();

    expect(await invoke('vfs_get_pdf_page_image', { resourceId: file.resourceId, pageIndex: 0 }))
      .toEqual({
        base64: Buffer.from('compressed-page').toString('base64'),
        mimeType: 'image/jpeg',
        size: 15,
      });
    expect(await invoke('vfs_get_pdf_page_image', { resourceId: file.resourceId, pageIndex: 1 }))
      .toEqual({
        base64: Buffer.from('original-page').toString('base64'),
        mimeType: 'image/png',
        size: 13,
      });
    await expect(invoke('vfs_get_pdf_page_image', { resourceId: file.resourceId, pageIndex: 2 }))
      .rejects.toBe('页码越界: page_index=2, total_pages=2');
    await expect(invoke('vfs_get_pdf_page_image', { resourceId: 'res_missing', pageIndex: 0 }))
      .rejects.toBe('资源不存在: res_missing');
  });

  it('readPdfPageImageBytes (api.ts) bounds the source like read_pdf_page_image_bytes(max_bytes)', async () => {
    const original = storeBlob('original-page', 'image/png', 'png');
    const compressed = storeBlob('compressed-page', 'image/jpeg', 'jpg');
    const file = repos().files.createFileWithDocDataInFolder(
      db(), 'sha_bounded', 'bounded.pdf', 10, 'document', 'application/pdf', null, null, null,
      JSON.stringify({
        pages: [{ pageIndex: 0, blobHash: original, width: 1, height: 1, mimeType: 'image/png', compressedBlobHash: compressed }],
        renderDpi: 150, totalPages: 1, renderedAt: '2026-01-01T00:00:00.000Z',
      }), null, 1,
    );
    const source = { conn: db, resources: repos().resources, blobs: repos().blobs, blobsDir, hostFiles };
    const page = await readPdfPageImageBytes(source, file.resourceId!, 0, 15);
    expect([Buffer.from(page.bytes).toString(), page.mimeType, page.storedSize]).toEqual(['compressed-page', 'image/jpeg', 15]);
    await expect(readPdfPageImageBytes(source, file.resourceId!, 0, 14))
      .rejects.toThrow(new Error('PDF page image exceeds source limit: 15 > 14 bytes'));
    await expect(readPdfPageImageBytes(source, file.resourceId!, 1, null))
      .rejects.toThrow(new Error('页码越界: page_index=1, total_pages=1'));
  });

  it('vfs_get_pdf_page_image supports exam sheet previews', async () => {
    const examBlob = storeBlob('exam-page', 'image/png', 'png');
    const exam = repos().exams.createExamSheet(db(), {
      examName: '卷', tempId: 'temp_pdf', metadataJson: {}, previewJson: { pages: [] },
      status: 'completed', folderId: null,
    });
    repos().exams.updatePreviewJson(db(), exam.id, {
      temp_id: 'temp_pdf', exam_name: '卷',
      pages: [{ page_index: 0, blob_hash: examBlob, cards: [] }],
    });
    expect(await invoke('vfs_get_pdf_page_image', { resourceId: exam.resourceId, pageIndex: 0 }))
      .toEqual({
        base64: Buffer.from('exam-page').toString('base64'),
        mimeType: 'image/png',
        size: 9,
      });
  });
  it('deserializes the full PDF preview before selecting a page', async () => {
    const hash = storeBlob('page', 'image/png', 'png');
    const file = repos().files.createFileWithDocDataInFolder(db(), 'serde_preview', 'serde.pdf', 4,
      'document', 'application/pdf', null, null, null, previewJson(hash), null, 1);
    const call = () => invoke('vfs_get_pdf_page_image', { resourceId: file.resourceId, pageIndex: 0 });
    const valid = JSON.parse(previewJson(hash));
    for (const field of ['pages', 'renderDpi', 'totalPages', 'renderedAt']) {
      const malformed = { ...valid }; delete malformed[field];
      db().run('UPDATE files SET preview_json=?1 WHERE id=?2', [JSON.stringify(malformed), file.id]);
      await expect(call()).rejects.toEqual(expect.stringContaining(`解析 preview_json 失败: missing field \`${field}\``));
    }
    for (const field of ['pageIndex', 'blobHash', 'width', 'height', 'mimeType']) {
      const malformed = structuredClone(valid); delete malformed.pages[0][field];
      db().run('UPDATE files SET preview_json=?1 WHERE id=?2', [JSON.stringify(malformed), file.id]);
      await expect(call()).rejects.toEqual(expect.stringContaining(`missing field \`${field}\``));
    }
    for (const invalid of [null, -1, 4294967296, '100']) {
      const malformed = structuredClone(valid); malformed.pages[0].width = invalid;
      db().run('UPDATE files SET preview_json=?1 WHERE id=?2', [JSON.stringify(malformed), file.id]);
      await expect(call()).rejects.toEqual(expect.stringContaining('解析 preview_json 失败: invalid'));
    }
    const malformed = { pages: [], renderDpi: 150, totalPages: 0 };
    const raw = JSON.stringify(malformed);
    db().run('UPDATE files SET preview_json=?1 WHERE id=?2', [raw, file.id]);
    await expect(call()).rejects.toBe(`解析 preview_json 失败: missing field \`renderedAt\` at line 1 column ${raw.length}`);
  });

  it('reports serde EOF at the actual persisted-preview parse position through invoke', async () => {
    const file = repos().files.createFileWithDocDataInFolder(db(), 'eof_preview', 'eof.pdf', 4,
      'document', 'application/pdf', null, null, null, previewJson('unused'), null, 1);
    const exam = repos().exams.createExamSheet(db(), { tempId: 'eof_exam', metadataJson: {}, previewJson: {} });
    // serde_json 1.0.149 de.rs: deserialize_seq/number, MapAccess and SeqAccess.
    // Expected byte columns are explicit, independent of the implementation.
    const cases: Array<[string, string, number, number]> = [
      ['{"pages":', 'a value', 1, 9],
      ['{"pages":[],"renderDpi":', 'a value', 1, 24],
      ['{"pages":[]', 'an object', 1, 11],
      ['{"pages"', 'an object', 1, 8],
      ['{"pages":[', 'a list', 1, 10],
      ['{"pages":[{', 'an object', 1, 11],
      ['{"pages":[],', 'a value', 1, 12],
      ['{"pages":[],"renderDpi":1e+', 'a value', 1, 27],
      ['{"renderedAt":"unfinished', 'a string', 1, 25],
      ['{"renderedAt":"中文",\n"pages":  ', 'a value', 2, 10],
      ['{"renderedAt":"中文","pages":', 'a value', 1, 31],
      ['{\n"pages":[]\n', 'an object', 3, 0],
    ];
    for (const [raw, kind, line, column] of cases) {
      db().run('UPDATE files SET preview_json=?1 WHERE id=?2', [raw, file.id]);
      await expect(invoke('vfs_get_pdf_page_image', { resourceId: file.resourceId, pageIndex: 0 }))
        .rejects.toBe(`解析 preview_json 失败: EOF while parsing ${kind} at line ${line} column ${column}`);
    }
    db().run('UPDATE exam_sheets SET preview_json=?1 WHERE id=?2', ['{"pages":', exam.id]);
    await expect(invoke('vfs_get_pdf_page_image', { resourceId: exam.resourceId, pageIndex: 0 }))
      .rejects.toBe('解析 exam preview_json 失败: EOF while parsing a value at line 1 column 9');
  });

  it('retains exam defaults, snake-case fields, optional hashes and the exam parse prefix', async () => {
    const exam = repos().exams.createExamSheet(db(), { tempId: 'serde_exam', metadataJson: {}, previewJson: {} });
    const call = () => invoke('vfs_get_pdf_page_image', { resourceId: exam.resourceId, pageIndex: 0 });
    await expect(call()).rejects.toBe('页码越界: page_index=0, total_pages=0');
    repos().exams.updatePreviewJson(db(), exam.id, { pages: [{ page_index: 0, cards: [] }] });
    await expect(call()).rejects.toBe('页面 0 无 blob_hash（可能是旧数据）');
    repos().exams.updatePreviewJson(db(), exam.id, { pages: [{ page_index: 0, cards: [], blob_hash: '' }] });
    await expect(call()).rejects.toBe('Blob 不存在: ');
    repos().exams.updatePreviewJson(db(), exam.id, { pages: [{ pageIndex: 0, cards: [] }] });
    await expect(call()).rejects.toEqual(expect.stringContaining('解析 exam preview_json 失败: missing field `page_index`'));
    repos().exams.updatePreviewJson(db(), exam.id, { pages: [{ page_index: 0 }] });
    await expect(call()).rejects.toEqual(expect.stringContaining('解析 exam preview_json 失败: missing field `cards`'));
    db().run('UPDATE exam_sheets SET preview_json=?1 WHERE id=?2', ['{', exam.id]);
    await expect(call()).rejects.toBe('解析 exam preview_json 失败: EOF while parsing an object at line 1 column 1');
  });

  it('preserves source-query and resource/connection step prefixes', async () => {
    const resource = repos().resources.createOrReuse(db(), 'file', 'unlinked', null, null, null);
    await expect(invoke('vfs_get_pdf_page_image', { resourceId: resource.resourceId, pageIndex: 0 }))
      .rejects.toBe(`资源无 PDF 预渲染数据: ${resource.resourceId} (source_table: None)`);
    const deps: PdfDeps = { conn: db, files: repos().files, blobs: repos().blobs, resources: repos().resources,
      pdf: vfs.host.ctx.vfsIndex.pdf, blobsDir, hostFiles, log: vfs.host.ctx.logger };
    await expect(getPdfPageImage({ ...deps, conn: () => { throw new Error('connection failure'); } }, resource.resourceId, 0))
      .rejects.toThrow('获取数据库连接失败: connection failure');
    const get = vi.spyOn(repos().resources, 'getResource').mockImplementationOnce(() => { throw new Error('resource failure'); });
    await expect(getPdfPageImage(deps, resource.resourceId, 0)).rejects.toThrow('获取资源失败: resource failure');
    get.mockRestore();
    for (const source of ['files', 'textbooks', 'exam_sheets']) {
      db().run('UPDATE resources SET source_table=?1 WHERE id=?2', [source, resource.resourceId]);
      await expect(invoke('vfs_get_pdf_page_image', { resourceId: resource.resourceId, pageIndex: 0 }))
        .rejects.toBe(`资源无 PDF 预渲染数据: ${resource.resourceId} (source_table: Some("${source}"))`);
      const originalGet = db().get.bind(db());
      const query = vi.spyOn(db(), 'get').mockImplementationOnce(originalGet)
        .mockImplementationOnce(() => { throw new Error('query failure'); });
      await expect(getPdfPageImage(deps, resource.resourceId, 0)).rejects.toThrow(
        `查询${source === 'files' ? '附件' : source === 'textbooks' ? '教材' : '题目集'} preview_json 失败: query failure`);
      query.mockRestore();
    }
  });
});
