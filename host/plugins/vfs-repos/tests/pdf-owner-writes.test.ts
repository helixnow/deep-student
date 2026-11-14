import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { VfsFile } from '../api.ts';
import { DEFAULT_PDF_PREVIEW_CONFIG } from '../api.ts';
import { DEFAULT_PDF_PREVIEW_CONFIG as rendererDefaults } from '../repository/pdf-preview.ts';
import plugin from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-pdf-owner-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const files = () => host.ctx.vfsRepo.files;
const resources = () => host.ctx.vfsRepo.resources;
const exams = () => host.ctx.vfsRepo.exams;

const SQL_NOW = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const RUST_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function newFile(sha: string): VfsFile {
  return files().createFile(db, sha, `${sha}.png`, 10, 'image', 'image/png', null, null);
}

function fileRow(fileId: string): Record<string, unknown> {
  return db.get<Record<string, unknown>>('SELECT * FROM files WHERE id = ?1', [fileId])!;
}

function resetUpdatedAt(fileId: string): void {
  db.run("UPDATE files SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1", [fileId]);
}

describe('PDF/media table-owner writes', { timeout: 120_000 }, () => {
  it('publishes the renderer defaults and keeps upload page-text writes timestamp-neutral', () => {
    expect(DEFAULT_PDF_PREVIEW_CONFIG).toBe(rendererDefaults);
    const file = newFile('upload-paged-text');
    resetUpdatedAt(file.id);
    const before = fileRow(file.id);
    const pages = JSON.stringify(['第一页', '', '第三页']);
    files().setUploadOcrPagesWithConn(db, file.id, pages);
    expect(fileRow(file.id)).toEqual({ ...before, ocr_pages_json: pages });
    expect(() => files().setUploadOcrPagesWithConn(db, 'file_missing', pages)).not.toThrow();

    // Same connection/transaction: an outer rollback must undo this write, with no extra commit.
    expect(() => db.transaction(conn => {
      files().setUploadOcrPagesWithConn(conn, file.id, '["temporary"]');
      expect(fileRow(file.id).ocr_pages_json).toBe('["temporary"]');
      throw new Error('rollback upload fixture');
    })).toThrow('rollback upload fixture');
    expect(fileRow(file.id)).toEqual({ ...before, ocr_pages_json: pages });
  });

  it('writes extracted text, preview json, OCR pages and compressed blob hash with SQL now', () => {
    const file = newFile('pdf-owner-payload');

    resetUpdatedAt(file.id);
    files().updatePdfExtractedText(db, file.id, 'page text', 3);
    let row = fileRow(file.id);
    expect(row.extracted_text).toBe('page text');
    expect(row.page_count).toBe(3);
    expect(row.updated_at).toMatch(SQL_NOW);

    resetUpdatedAt(file.id);
    files().updatePdfPreview(db, file.id, '{"pages":[]}', 4);
    row = fileRow(file.id);
    expect(row.preview_json).toBe('{"pages":[]}');
    expect(row.page_count).toBe(4);
    expect(row.updated_at).toMatch(SQL_NOW);

    resetUpdatedAt(file.id);
    files().updatePdfPreviewOnly(db, file.id, '{"pages":[1]}');
    row = fileRow(file.id);
    expect(row.preview_json).toBe('{"pages":[1]}');
    expect(row.updated_at).toMatch(SQL_NOW);

    resetUpdatedAt(file.id);
    files().updatePdfOcrPages(db, file.id, '{"pages":[]}');
    row = fileRow(file.id);
    expect(row.ocr_pages_json).toBe('{"pages":[]}');
    expect(row.updated_at).toMatch(SQL_NOW);

    resetUpdatedAt(file.id);
    files().updateCompressedBlobHash(db, file.id, 'blob-compressed');
    row = fileRow(file.id);
    expect(row.compressed_blob_hash).toBe('blob-compressed');
    expect(row.updated_at).toMatch(SQL_NOW);
  });

  it('keeps the compressed hash write inside the caller transaction', () => {
    const file = newFile('pdf-owner-transaction');
    db.exec('BEGIN');
    try {
      files().updateCompressedBlobHash(db, file.id, 'blob-inside-transaction');
      expect(fileRow(file.id).compressed_blob_hash).toBe('blob-inside-transaction');
      db.exec('ROLLBACK');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    expect(fileRow(file.id).compressed_blob_hash).toBeNull();
  });

  it('never touches business updated_at for processing status writes', () => {
    const file = newFile('pdf-owner-processing');
    const before = fileRow(file.id).updated_at;
    db.run(`UPDATE files SET processing_error = 'old error' WHERE id = ?1`, [file.id]);

    files().applyProcessingStatus(db, file.id, 'page_rendering',
      '{"stage":"page_rendering","percent":10}', null, 123456, null);
    let row = fileRow(file.id);
    expect(row.processing_status).toBe('page_rendering');
    expect(row.processing_progress).toBe('{"stage":"page_rendering","percent":10}');
    expect(row.processing_started_at).toBe(123456);
    expect(row.updated_at).toBe(before);

    files().applyProcessingStatus(db, file.id, 'completed_with_issues',
      '{"stage":"completed_with_issues"}', null, 654321, 'ocr: page 2 failed');
    row = fileRow(file.id);
    expect(row.processing_completed_at).toBe(654321);
    expect(row.processing_error).toBe('ocr: page 2 failed');
    expect(row.updated_at).toBe(before);

    files().applyProcessingStatus(db, file.id, 'completed_with_issues',
      '{"stage":"completed_with_issues"}', null, 654321, null);
    expect(fileRow(file.id).processing_error).toBe('ocr: page 2 failed');

    files().applyProcessingStatus(db, file.id, 'completed',
      '{"stage":"completed"}', null, 777777, null);
    row = fileRow(file.id);
    expect(row.processing_status).toBe('completed');
    expect(row.processing_completed_at).toBe(777777);
    expect(row.processing_error).toBeNull();
    expect(row.updated_at).toBe(before);

    files().applyProcessingStatus(db, file.id, 'error',
      '{"stage":"error"}', null, 888888, null);
    row = fileRow(file.id);
    expect(row.processing_status).toBe('error');
    expect(row.processing_completed_at).toBe(777777);
    expect(row.processing_progress).toBe('{"stage":"error"}');
    expect(row.updated_at).toBe(before);

    files().updateProcessingProgress(db, file.id, '{"stage":"error","percent":99}');
    expect(fileRow(file.id).processing_progress).toBe('{"stage":"error","percent":99}');
    expect(fileRow(file.id).updated_at).toBe(before);
  });

  it('sets errors, cancels only active stages, and marks stuck rows recovered', () => {
    const file = newFile('pdf-owner-lifecycle');
    db.run(`UPDATE files SET processing_status = 'ocr_processing', processing_progress = '{"stage":"ocr"}'
            WHERE id = ?1`, [file.id]);

    files().setProcessingError(db, file.id, 'pdfium failed', 111);
    let row = fileRow(file.id);
    expect(row.processing_status).toBe('error');
    expect(row.processing_error).toBe('pdfium failed');
    expect(row.processing_completed_at).toBe(111);
    expect(row.processing_progress).toBe('{"stage":"ocr"}');

    db.run(`UPDATE files SET processing_status = 'queued', processing_error = 'stale' WHERE id = ?1`, [file.id]);
    expect(files().cancelProcessing(db, file.id)).toBe(1);
    row = fileRow(file.id);
    expect(row.processing_status).toBe('cancelled');
    expect(row.processing_error).toBeNull();
    expect(files().cancelProcessing(db, file.id)).toBe(0);

    db.run(`UPDATE files SET processing_status = 'vector_indexing' WHERE id = ?1`, [file.id]);
    expect(files().markProcessingRecovered(db, file.id)).toBe(1);
    row = fileRow(file.id);
    expect(row.processing_status).toBe('pending');
    expect(row.processing_error).toBe('recovered: interrupted by app restart');
    expect(files().markProcessingRecovered(db, 'file_missing')).toBe(0);
  });

  it('updates resource OCR by file id and reports affected rows', () => {
    const file = newFile('pdf-owner-resource-ocr');
    expect(file.resourceId).toBeDefined();
    db.run("UPDATE resources SET updated_at = 1 WHERE id = ?1", [file.resourceId!]);

    expect(resources().saveOcrTextForFile(db, file.id, 'recognized text')).toBe(1);
    const resource = db.get<{ ocr_text: string; updated_at: string }>(
      'SELECT ocr_text, updated_at FROM resources WHERE id = ?1', [file.resourceId!])!;
    expect(resource.ocr_text).toBe('recognized text');
    expect(resource.updated_at).toMatch(SQL_NOW);

    expect(resources().saveOcrTextForFile(db, 'file_missing', 'ignored')).toBe(0);
  });

  it('writes file multimodal state with the Rust branch semantics', () => {
    const file = newFile('pdf-owner-mm-file');
    db.run(`UPDATE files SET mm_index_state = 'pending', mm_index_error = 'old',
            mm_indexed_pages_json = NULL WHERE id = ?1`, [file.id]);

    files().applyMultimodalIndexState(db, file.id, 'indexed', '[{"page_index":0}]');
    let row = fileRow(file.id);
    expect(row.mm_index_state).toBe('indexed');
    expect(row.mm_indexed_pages_json).toBe('[{"page_index":0}]');
    expect(row.mm_index_error).toBe('old');
    expect(row.updated_at).toMatch(RUST_NOW);

    files().applyMultimodalIndexState(db, file.id, 'failed', 'ocr unavailable');
    row = fileRow(file.id);
    expect(row.mm_index_state).toBe('failed');
    expect(row.mm_index_error).toBe('ocr unavailable');
    expect(row.mm_indexed_pages_json).toBe('[{"page_index":0}]');
    expect(row.updated_at).toMatch(RUST_NOW);

    files().applyMultimodalIndexState(db, file.id, 'pending', null);
    row = fileRow(file.id);
    expect(row.mm_index_state).toBe('pending');
    expect(row.mm_index_error).toBe('ocr unavailable');
    expect(row.updated_at).toMatch(RUST_NOW);
  });

  it('writes exam-sheet multimodal state with embedding metadata', () => {
    const examId = 'exam-pdf-owner-mm';
    db.run(`INSERT INTO exam_sheets(id, exam_name, status, temp_id, metadata_json, preview_json,
              created_at, updated_at)
            VALUES (?1, 'pdf owner exam', 'completed', 'temp-pdf-owner', '{}', '{}',
                    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`, [examId]);

    exams().applyMultimodalIndexState(db, examId, 'indexed', '[{"page_index":1}]', 1024);
    let row = db.get<Record<string, unknown>>('SELECT * FROM exam_sheets WHERE id = ?1', [examId])!;
    expect(row.mm_index_state).toBe('indexed');
    expect(row.mm_indexed_pages_json).toBe('[{"page_index":1}]');
    expect(row.mm_embedding_dim).toBe(1024);
    expect(row.mm_indexed_at).toMatch(RUST_NOW);
    expect(row.updated_at).toBe(row.mm_indexed_at);

    exams().applyMultimodalIndexState(db, examId, 'failed', 'dimension mismatch', 1024);
    row = db.get<Record<string, unknown>>('SELECT * FROM exam_sheets WHERE id = ?1', [examId])!;
    expect(row.mm_index_state).toBe('failed');
    expect(row.mm_index_error).toBe('dimension mismatch');
    expect(row.updated_at).toMatch(RUST_NOW);

    exams().applyMultimodalIndexState(db, examId, 'indexing', null, 1024);
    row = db.get<Record<string, unknown>>('SELECT * FROM exam_sheets WHERE id = ?1', [examId])!;
    expect(row.mm_index_state).toBe('indexing');
    expect(row.mm_index_error).toBe('dimension mismatch');
    expect(row.updated_at).toMatch(RUST_NOW);
  });
});
