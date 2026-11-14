/**
 * Resource content and indexing SQL used by `vfs/indexing.rs`.
 *
 * `index_unit_repo.rs` / `index_service.rs` belong to L11, whose api.ts does not
 * publish them yet; this module keeps the exact SQL required by this lane's
 * indexing service so no SQL leaks into `src/`.
 */
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { nowMs } from './index-state.ts';
import {
  vfsRecoveryOwnerWrites, vfsTableOwners, requireVfsTableOwners, type PdfResourceOwnerWrites,
} from './owners.ts';

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fallback;
}

export interface ResourceFileColumns {
  ocrPagesJson: string | null;
  extractedText: string | null;
  pageCount: number | null;
}

function fileColumns(row: Row): ResourceFileColumns {
  return {
    ocrPagesJson: nullableText(row['ocr_pages_json']),
    extractedText: nullableText(row['extracted_text']),
    pageCount: row['page_count'] === null || row['page_count'] === undefined
      ? null
      : integer(row['page_count']),
  };
}

/** Textbook extraction: `files WHERE resource_id = ?1`, then `files WHERE id = ?1`. */
export function getTextbookFileColumns(
  db: SqlExecutor,
  resourceId: string,
  textbookId: string,
): ResourceFileColumns | undefined {
  let row = db.get(
    'SELECT ocr_pages_json, extracted_text FROM files WHERE resource_id = ?1',
    [resourceId],
  );
  if (row === undefined && textbookId !== resourceId) {
    row = db.get(
      'SELECT ocr_pages_json, extracted_text FROM files WHERE id = ?1',
      [textbookId],
    );
  }
  return row === undefined
    ? undefined
    : {
      ocrPagesJson: nullableText(row['ocr_pages_json']),
      extractedText: nullableText(row['extracted_text']),
      pageCount: null,
    };
}

/** `resolve_indexable_pages` textbook branch (includes `page_count`). */
export function getTextbookPageColumns(
  db: SqlExecutor,
  resourceId: string,
  textbookId: string,
): ResourceFileColumns | undefined {
  let row = db.get(
    'SELECT ocr_pages_json, extracted_text, page_count FROM files WHERE resource_id = ?1',
    [resourceId],
  );
  if (row === undefined && textbookId !== resourceId) {
    row = db.get(
      'SELECT ocr_pages_json, extracted_text, page_count FROM files WHERE id = ?1',
      [textbookId],
    );
  }
  return row === undefined ? undefined : fileColumns(row);
}

export function getExamIdForResource(db: SqlExecutor, resourceId: string): string | null {
  const value = db.pluck<unknown>(
    'SELECT id FROM exam_sheets WHERE resource_id = ?1 AND deleted_at IS NULL',
    [resourceId],
  );
  return value === null || value === undefined ? null : text(value);
}

export function getExamPreviewJson(db: SqlExecutor, resourceId: string): string | null {
  return nullableText(db.pluck<unknown>(
    'SELECT preview_json FROM exam_sheets WHERE resource_id = ?1',
    [resourceId],
  ));
}

export function getFileExtractedTextById(db: SqlExecutor, fileId: string): string | null {
  return nullableText(db.pluck<unknown>(
    'SELECT extracted_text FROM files WHERE id = ?1',
    [fileId],
  ));
}

export function getFileExtractedTextByResource(
  db: SqlExecutor,
  resourceId: string,
): string | null {
  return nullableText(db.pluck<unknown>(
    'SELECT extracted_text FROM files WHERE resource_id = ?1',
    [resourceId],
  ));
}

/** Auto-OCR recovery probe: `WHERE id = ?1 OR resource_id = ?1 LIMIT 1`. */
export function getFileExtractedTextForRecovery(
  db: SqlExecutor,
  fileIdOrResourceId: string,
): string | null {
  return nullableText(db.pluck<unknown>(
    'SELECT extracted_text FROM files WHERE id = ?1 OR resource_id = ?1 LIMIT 1',
    [fileIdOrResourceId],
  ));
}

export function getResourceOcrValue(db: SqlExecutor, resourceId: string): string | null {
  const row = db.get('SELECT ocr_text FROM resources WHERE id = ?1', [resourceId]);
  return row === undefined ? null : nullableText(row['ocr_text']);
}

/** `multimodal_service.rs::process_pending_batch` resource-type lookup (defaults to `file`). */
export function getResourceType(db: SqlExecutor, resourceId: string): string {
  const value = db.pluck<unknown>('SELECT type FROM resources WHERE id = ?1', [resourceId]);
  return value === null || value === undefined ? 'file' : text(value);
}

/** `multimodal_service.rs::resolve_resource_folder_id`. */
export function resolveResourceFolderId(
  db: SqlExecutor,
  resourceId: string,
): string | null {
  try {
    const value = db.pluck<unknown>(
      `SELECT fi.folder_id
       FROM folder_items fi
       WHERE fi.deleted_at IS NULL
         AND (
           fi.item_id = ?1
           OR EXISTS (SELECT 1 FROM files f WHERE f.id = fi.item_id AND f.resource_id = ?1)
           OR EXISTS (SELECT 1 FROM exam_sheets e WHERE e.id = fi.item_id AND e.resource_id = ?1)
         )
       ORDER BY fi.updated_at DESC, fi.created_at DESC
       LIMIT 1`,
      [resourceId],
    );
    return value === null || value === undefined ? null : nullableText(value);
  } catch {
    // Rust `.optional()?` propagates errors; a missing join table means no folder.
    return null;
  }
}

/**
 * `resources.ocr_text` cache write. The table owner is required. The Rust
 * conditional cache (`indexing.rs:1082/3485`) stays atomic and does not touch
 * `updated_at`; it is delegated to L11 `resources.saveOcrTextIfEmptyWithConn`.
 * Without that exact owner method the cache attempt fails explicitly (callers
 * warn and continue) instead of using a differently-behaving setter. The
 * generic unconditional path retains the published millisecond `saveOcrText`
 * setter. The indexing recovery SQL timestamp path is separate below.
 */
export function saveResourceOcrText(
  db: SqlExecutor,
  resourceId: string,
  value: string,
  onlyIfEmpty: boolean,
  repositories?: VfsReposService,
): void {
  const owner = repositories ?? vfsTableOwners(db);
  if (owner === undefined) throw new Error('L11 vfsRepo service is not available');
  if (onlyIfEmpty) {
    const resources = owner.resources as unknown as Partial<PdfResourceOwnerWrites>;
    if (typeof resources.saveOcrTextIfEmptyWithConn !== 'function') {
      throw new Error('L11 vfsRepo.resources.saveOcrTextIfEmptyWithConn 未集成');
    }
    resources.saveOcrTextIfEmptyWithConn(db, resourceId, value);
    return;
  }
  owner.resources.saveOcrText(db, resourceId, value);
}

export function updateResourceOcrTextIfEmpty(
  db: SqlExecutor,
  resourceId: string,
  extractedText: string,
  repositories?: VfsReposService,
): void {
  saveResourceOcrText(db, resourceId, extractedText, true, repositories);
}

/**
 * Exact `indexing.rs:3354/3949` image-OCR cache: unconditional write without
 * `updated_at`. Uses the owner method of the same behavior when published and
   * otherwise reports the missing capability; `saveOcrText` is not a substitute
 * because it mutates `updated_at`.
 */
export function updateResourceOcrTextWithoutTimestamp(
  db: SqlExecutor,
  resourceId: string,
  ocrText: string,
  repositories?: VfsReposService,
): void {
  const owner = repositories ?? vfsTableOwners(db);
  if (owner === undefined) throw new Error('L11 vfsRepo service is not available');
  const resources = owner.resources as unknown as Partial<PdfResourceOwnerWrites>;
  if (typeof resources.saveOcrTextWithoutTimestampWithConn !== 'function') {
    throw new Error('L11 vfsRepo.resources.saveOcrTextWithoutTimestampWithConn 未集成');
  }
  resources.saveOcrTextWithoutTimestampWithConn(db, resourceId, ocrText);
}

export function updateResourceOcrTextRow(
  db: SqlExecutor,
  resourceId: string,
  ocrText: string,
  repositories?: VfsReposService,
): void {
  const owner = repositories ?? vfsTableOwners(db);
  if (owner === undefined) throw new Error('L11 vfsRepo service is not available');
  owner.resources.saveOcrTextWithSqlTimestampWithConn(db, resourceId, ocrText);
}

export function getFileOcrPagesById(db: SqlExecutor, fileId: string): string | null {
  return nullableText(db.pluck<unknown>(
    'SELECT ocr_pages_json FROM files WHERE id = ?1',
    [fileId],
  ));
}

export function getFileOcrPagesByResource(
  db: SqlExecutor,
  resourceId: string,
): string | null {
  return nullableText(db.pluck<unknown>(
    'SELECT ocr_pages_json FROM files WHERE resource_id = ?1',
    [resourceId],
  ));
}

// ---------------------------------------------------------------- unit / index SQL

export function contentHashChanged(db: SqlExecutor, resourceId: string): boolean {
  return Number(db.pluck<unknown>(
    "SELECT COALESCE(index_hash, '') <> hash FROM resources WHERE id = ?1",
    [resourceId],
  ) ?? 0) !== 0;
}

export function hasLegacyUnpagedPdf(db: SqlExecutor, resourceId: string): boolean {
  return Number(db.pluck<unknown>(
    `SELECT COUNT(*) > 0 FROM files
     WHERE resource_id = ?1 AND COALESCE(page_count, 0) > 1
       AND extracted_text IS NOT NULL AND instr(extracted_text, char(12)) = 0`,
    [resourceId],
  ) ?? 0) !== 0;
}

export function hasMediaTranscript(db: SqlExecutor, resourceId: string): boolean {
  return Number(db.pluck<unknown>(
    `SELECT EXISTS(SELECT 1 FROM files f JOIN media_transcript_segments m
       ON m.resource_id = f.id
     WHERE f.resource_id = ?1 AND m.status = 1)`,
    [resourceId],
  ) ?? 0) !== 0;
}

/** `SELECT id FROM vfs_index_units WHERE resource_id = ?1 AND unit_index = 0`. */
export function getUnitIdAt(db: SqlExecutor, resourceId: string, unitIndex: number): string | null {
  const row = db.get(
    'SELECT id FROM vfs_index_units WHERE resource_id = ?1 AND unit_index = ?2',
    [resourceId, unitIndex],
  );
  return row === undefined ? null : text(row['id']);
}

export function insertIndexingUnitRow(
  db: SqlExecutor,
  unitId: string,
  resourceId: string,
  at: number,
): void {
  db.run(
    `INSERT INTO vfs_index_units
       (id, resource_id, unit_index, text_content, text_required, text_state,
        mm_required, mm_state, created_at, updated_at)
     VALUES (?1, ?2, 0, '', 1, 'indexing', 0, 'disabled', ?3, ?3)`,
    [unitId, resourceId, at],
  );
}

export interface PlaceholderSegmentInput {
  id: string;
  unitId: string;
  segmentIndex: number;
  modality: string;
  embeddingDim: number;
  lanceRowId: string;
  contentText: string;
  startPos: number;
  endPos: number;
}

export function insertPlaceholderSegmentRow(
  db: SqlExecutor,
  input: PlaceholderSegmentInput,
  at: number,
): void {
  db.run(
    `INSERT INTO vfs_index_segments
       (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text,
        start_pos, end_pos, metadata_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?10)`,
    [
      input.id, input.unitId, input.segmentIndex, input.modality, input.embeddingDim,
      input.lanceRowId, input.contentText, input.startPos, input.endPos, at,
    ],
  );
}

export function markUnitIndexedRow(
  db: SqlExecutor,
  unitId: string,
  at: number,
  chunkCount: number,
  dimension: number,
): void {
  db.run(
    `UPDATE vfs_index_units
     SET text_state = 'indexed', text_indexed_at = ?1, text_chunk_count = ?2,
         text_embedding_dim = ?3, updated_at = ?1
     WHERE id = ?4`,
    [at, chunkCount, dimension, unitId],
  );
}

export function incrementEmbeddingDimCountRow(
  db: SqlExecutor,
  dimension: number,
  modality: string,
  count: number,
  _at: number,
): void {
  requireVfsTableOwners(db).embeddingDims.incrementCount(db, dimension, modality, count);
}

/**
 * `VfsFullIndexingService::recover_stuck_indexing` (`indexing.rs:1978-2046`).
 *
 * The reset tables (`vfs_index_units`, `resources`) are owned by L11 after the
 * C2 disposition; L12 only schedules the startup call through the published
 * `maintenance.recoverStuckIndexingWithConn`. There is no second local reset
 * SQL: an unbound owner is reported as an error to the startup caller.
 */
export function recoverStuckIndexingRows(db: SqlExecutor, at: number): number {
  const owner = vfsRecoveryOwnerWrites(db);
  if (typeof owner?.recoverStuckIndexingWithConn !== 'function') {
    throw new Error('L11 vfsRepo.maintenance.recoverStuckIndexingWithConn 未集成');
  }
  return owner.recoverStuckIndexingWithConn(db, at);
}

/**
 * `clear_empty_text_index` SQL: enqueue text segments, delete them, disable the
 * units (keeping non-primary required units pending).
 */
export function clearTextIndexRowsForResource(
  db: SqlExecutor,
  resourceId: string,
  modality: string,
): void {
  db.run(
    `INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
     SELECT s.lance_row_id, u.resource_id
     FROM vfs_index_segments s
     JOIN vfs_index_units u ON u.id = s.unit_id
     WHERE u.resource_id = ?1 AND s.modality = ?2
     ON CONFLICT(lance_row_id) DO UPDATE SET
       resource_id = excluded.resource_id,
       enqueued_at = excluded.enqueued_at,
       next_retry_at = 0,
       last_error = NULL`,
    [resourceId, modality],
  );
  db.run(
    `DELETE FROM vfs_index_segments
     WHERE modality = ?2
       AND unit_id IN (SELECT id FROM vfs_index_units WHERE resource_id = ?1)`,
    [resourceId, modality],
  );
  db.run(
    `UPDATE vfs_index_units SET
       text_state = CASE
         WHEN unit_index <> 0 AND text_required = 1
              AND TRIM(COALESCE(text_content, '')) <> '' THEN 'pending'
         ELSE 'disabled'
       END,
       text_error = NULL, text_indexed_at = NULL, text_chunk_count = 0,
       text_embedding_dim = NULL, text_profile_id = NULL, text_generation = 0,
       updated_at = ?2
     WHERE resource_id = ?1`,
    [resourceId, nowMs()],
  );
}

/** `prepare_units_without_embedding` candidate scan (limit * 4). */
export function listPrepareCandidates(db: SqlExecutor, limit: number): string[] {
  return db.all<Row>(
    `SELECT r.id FROM resources r
     WHERE r.deleted_at IS NULL
       AND COALESCE(r.index_state, 'pending') = 'pending'
       AND NOT EXISTS (SELECT 1 FROM vfs_index_units u WHERE u.resource_id = r.id)
     ORDER BY r.updated_at DESC
     LIMIT ?1`,
    [limit * 4],
  ).map((row) => text(row['id']));
}

export interface OrphanQueueEntry {
  lance_row_id: string;
  retry_count: number;
}

export function listOrphanQueueEntries(
  db: SqlExecutor,
  at: number,
  limit: number,
): OrphanQueueEntry[] {
  return db.all<Row>(
    `SELECT lance_row_id, retry_count FROM __lance_orphan_queue
     WHERE next_retry_at <= ?1 ORDER BY next_retry_at, enqueued_at LIMIT ?2`,
    [at, limit],
  ).map((row) => ({
    lance_row_id: text(row['lance_row_id']),
    retry_count: integer(row['retry_count']),
  }));
}

export function updateOrphanRetry(
  db: SqlExecutor,
  lanceRowId: string,
  nextRetryAt: number,
  lastError: string,
): void {
  db.run(
    `UPDATE __lance_orphan_queue
     SET retry_count = retry_count + 1, next_retry_at = ?2, last_error = ?3
     WHERE lance_row_id = ?1`,
    [lanceRowId, nextRetryAt, lastError],
  );
}

export function countSegments(db: SqlExecutor): number {
  return integer(db.pluck<unknown>('SELECT COUNT(*) FROM vfs_index_segments'));
}

export function countIndexedResources(db: SqlExecutor): number {
  return integer(db.pluck<unknown>(
    `SELECT COUNT(DISTINCT u.resource_id)
     FROM vfs_index_segments s JOIN vfs_index_units u ON s.unit_id = u.id`,
  ));
}
