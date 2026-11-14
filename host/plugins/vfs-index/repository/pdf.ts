/**
 * `files` processing-status SQL for `vfs/pdf_processing_service.rs`.
 *
 * SQL lives only in `repository/`; the service keeps generation/event logic.
 */
import { defineQuery } from '../../../platform/storage/query.ts';
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import {
  pdfFileOwnerWrites, pdfResourceOwnerWrites, requirePdfFileOwnerMethod,
} from './owners.ts';

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export interface ProcessingRow {
  status: string | null;
  progressJson: string | null;
  error: string | null;
  startedAt: number | bigint | null;
  completedAt: number | bigint | null;
}

function nullableStatusTime(value: unknown): number | bigint | null {
  if (typeof value === 'bigint' && (value < BigInt(Number.MIN_SAFE_INTEGER)
    || value > BigInt(Number.MAX_SAFE_INTEGER))) return value;
  return nullableInteger(value);
}

export function getProcessingRow(db: SqlExecutor, fileId: string): ProcessingRow | null {
  const row = db.get(defineQuery<[string], Row>(
    `SELECT processing_status, processing_progress, processing_error,
            processing_started_at, processing_completed_at
     FROM files WHERE id = ?1`,
    { options: { safeIntegers: true } },
  ), [fileId]);
  if (row === undefined) return null;
  return {
    status: nullableText(row['processing_status']),
    progressJson: nullableText(row['processing_progress']),
    error: nullableText(row['processing_error']),
    startedAt: nullableStatusTime(row['processing_started_at']),
    completedAt: nullableStatusTime(row['processing_completed_at']),
  };
}

export interface MediaMetadata {
  mimeType: string;
  fileName: string | null;
}

export function getMediaMetadata(db: SqlExecutor, fileId: string): MediaMetadata | null {
  const row = db.get('SELECT mime_type, file_name FROM files WHERE id = ?1', [fileId]);
  if (row === undefined) return null;
  return {
    mimeType: text(row['mime_type']),
    fileName: nullableText(row['file_name']),
  };
}

export function cancelMediaRow(db: SqlExecutor, fileId: string): number {
  return requirePdfFileOwnerMethod(pdfFileOwnerWrites(db), 'cancelProcessing')(db, fileId);
}

export function listFilesWithStatuses(db: SqlExecutor, stages: readonly string[]): string[] {
  const placeholders = stages.map((_, index) => `?${index + 1}`).join(',');
  return db.all<Row>(
    `SELECT id FROM files WHERE processing_status IN (${placeholders})`,
    [...stages],
  ).map((row) => text(row['id']));
}

export function markRecoveredPendingRow(db: SqlExecutor, fileId: string): number {
  return recoveredPendingWriter(db)(fileId);
}

/** Resolves the L11 owner once, so a missing owner fails the whole recovery instead of every row. */
export function recoveredPendingWriter(db: SqlExecutor): (fileId: string) => number {
  const mark = requirePdfFileOwnerMethod(pdfFileOwnerWrites(db), 'markProcessingRecovered');
  return (fileId) => mark(db, fileId);
}

export function setProcessingErrorRow(
  db: SqlExecutor,
  fileId: string,
  error: string,
  completedAt: number,
): void {
  requirePdfFileOwnerMethod(
    pdfFileOwnerWrites(db), 'setProcessingError',
  )(db, fileId, error, completedAt);
}

export interface PdfRuntimeFileRow {
  id: string;
  resourceId: string | null;
  blobHash: string | null;
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  pageCount: number | null;
  extractedText: string | null;
  previewJson: string | null;
  ocrPagesJson: string | null;
  compressedBlobHash: string | null;
}

export function getPdfRuntimeFileRow(db: SqlExecutor, fileId: string): PdfRuntimeFileRow | null {
  const row = db.get(
    `SELECT id, resource_id, blob_hash, mime_type, file_name, size, page_count,
            extracted_text, preview_json, ocr_pages_json, compressed_blob_hash
     FROM files WHERE id = ?1`,
    [fileId],
  );
  if (row === undefined) return null;
  return {
    id: String(row['id']),
    resourceId: nullableText(row['resource_id']),
    blobHash: nullableText(row['blob_hash']),
    mimeType: nullableText(row['mime_type']),
    fileName: nullableText(row['file_name']),
    size: nullableInteger(row['size']),
    pageCount: nullableInteger(row['page_count']),
    extractedText: nullableText(row['extracted_text']),
    previewJson: nullableText(row['preview_json']),
    ocrPagesJson: nullableText(row['ocr_pages_json']),
    compressedBlobHash: nullableText(row['compressed_blob_hash']),
  };
}

export function updateExtractedTextRow(
  db: SqlExecutor,
  fileId: string,
  extractedText: string,
  pageCount: number | null,
): void {
  requirePdfFileOwnerMethod(
    pdfFileOwnerWrites(db), 'updatePdfExtractedText',
  )(db, fileId, extractedText, pageCount);
}

export function updatePreviewJsonRow(
  db: SqlExecutor,
  fileId: string,
  previewJson: string,
  pageCount: number,
): void {
  requirePdfFileOwnerMethod(
    pdfFileOwnerWrites(db), 'updatePdfPreview',
  )(db, fileId, previewJson, pageCount);
}

export function updatePreviewJsonOnlyRow(
  db: SqlExecutor,
  fileId: string,
  previewJson: string,
): void {
  requirePdfFileOwnerMethod(
    pdfFileOwnerWrites(db), 'updatePdfPreviewOnly',
  )(db, fileId, previewJson);
}

export function updateOcrPagesJsonRow(
  db: SqlExecutor,
  fileId: string,
  ocrPagesJson: string,
): void {
  requirePdfFileOwnerMethod(
    pdfFileOwnerWrites(db), 'updatePdfOcrPages',
  )(db, fileId, ocrPagesJson);
}

/**
 * `pdf_ocr_service.rs` OCR write-back. Production must use L11
 * `resources.saveOcrTextForFile` (same `datetime('now')` semantics and
 * `rows_affected`), not `saveOcrText` and not a local SQL fallback.
 */
export function updateResourceOcrTextForFileRow(
  db: SqlExecutor,
  fileId: string,
  ocrText: string,
  repositories: VfsReposService,
): number {
  const owner = pdfResourceOwnerWrites(repositories);
  if (owner.saveOcrTextForFile === undefined) {
    throw new Error(
      'L11 vfsRepo.resources.saveOcrTextForFile 未集成（待 ds-mig/L11-vfs-repos 合入）',
    );
  }
  return owner.saveOcrTextForFile(db, fileId, ocrText);
}

export function updateCompressedBlobHashRow(
  db: SqlExecutor,
  fileId: string,
  blobHash: string,
): void {
  requirePdfFileOwnerMethod(
    pdfFileOwnerWrites(db), 'updateCompressedBlobHash',
  )(db, fileId, blobHash);
}

export function listPdfIdsMissingPreview(db: SqlExecutor, limit: number): string[] {
  return db.all<Row>(
    `SELECT id FROM files
     WHERE mime_type = 'application/pdf'
       AND preview_json IS NULL
       AND page_count > 0
     LIMIT ?1`,
    [limit],
  ).map((row) => text(row['id']));
}

export interface FileOcrSourceRow {
  id: string;
  resourceId: string | null;
  previewJson: string | null;
  mimeType: string | null;
  ocrPagesJson: string | null;
}

/** `find_file` lookup used by indexing-time OCR recovery. */
export function getFileOcrSourceRow(db: SqlExecutor, fileId: string): FileOcrSourceRow | null {
  const row = db.get(
    `SELECT id, resource_id, preview_json, mime_type, ocr_pages_json
     FROM files WHERE id = ?1`,
    [fileId],
  );
  if (row === undefined) return null;
  return {
    id: text(row['id']),
    resourceId: nullableText(row['resource_id']),
    previewJson: nullableText(row['preview_json']),
    mimeType: nullableText(row['mime_type']),
    ocrPagesJson: nullableText(row['ocr_pages_json']),
  };
}

export function fileExistsRow(db: SqlExecutor, fileId: string): boolean {
  return Number(db.pluck<number>(
    'SELECT COUNT(*) FROM files WHERE id = ?1', [fileId],
  ) ?? 0) > 0;
}

export function getFileIdByResourceRow(db: SqlExecutor, resourceId: string): string | null {
  const row = db.get('SELECT id FROM files WHERE resource_id = ?1', [resourceId]);
  return row === undefined ? null : text(row['id']);
}

export function getFileBlobHashRow(db: SqlExecutor, fileId: string): string | null {
  return nullableText(db.pluck<unknown>(
    'SELECT blob_hash FROM files WHERE id = ?1', [fileId],
  ));
}

export function getProcessingProgressJson(db: SqlExecutor, fileId: string): string | null {
  return nullableText(db.pluck<unknown>(
    'SELECT processing_progress FROM files WHERE id = ?1', [fileId],
  ));
}

export function setProcessingProgressJson(
  db: SqlExecutor,
  fileId: string,
  progressJson: string,
): void {
  requirePdfFileOwnerMethod(
    pdfFileOwnerWrites(db), 'updateProcessingProgress',
  )(db, fileId, progressJson);
}

export function updateProcessingStatusRow(
  db: SqlExecutor,
  fileId: string,
  stage: string,
  progressJson: string | null,
  completedAt: number | null,
  now: number,
  issueSummary: string | null,
): void {
  requirePdfFileOwnerMethod(
    pdfFileOwnerWrites(db), 'applyProcessingStatus',
  )(db, fileId, stage, progressJson, completedAt, now, issueSummary);
}
