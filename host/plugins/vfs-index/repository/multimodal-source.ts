/**
 * Business-table reads/writes for `index_resource_by_source`
 * (multimodal_service.rs:1283-1665). The `files`/`exam_sheets` mm_* columns are
 * not published on the L11 repositories yet, so this module keeps the exact
 * SQL until the table owner exposes setters; resource rows go through
 * `vfsRepo.indexStates` when available.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import {
  pdfExamOwnerFromRepositories, pdfFileOwnerFromRepositories,
  requirePdfExamOwnerMethod, requirePdfFileOwnerMethod,
} from './owners.ts';

export interface SourcePreviewRow {
  previewJson: string | null;
  resourceId: string | null;
}

export interface ImageFileInfo {
  blobHash: string | null;
  mimeType: string | null;
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function getSourcePreview(
  db: SqlExecutor,
  sourceType: string,
  sourceId: string,
): SourcePreviewRow {
  const table = sourceType === 'exam' ? 'exam_sheets' : 'files';
  const supported = sourceType === 'exam' || sourceType === 'textbook'
    || sourceType === 'attachment' || sourceType === 'image' || sourceType === 'file';
  if (!supported) return { previewJson: null, resourceId: null };
  const row = db.get<Record<string, unknown>>(
    `SELECT preview_json, resource_id FROM ${table} WHERE id = ?1`, [sourceId],
  );
  if (row === undefined) return { previewJson: null, resourceId: null };
  return {
    previewJson: nullable(row['preview_json']),
    resourceId: nullable(row['resource_id']),
  };
}

export function getImageFileInfo(db: SqlExecutor, fileId: string): ImageFileInfo | null {
  const row = db.get<Record<string, unknown>>(
    'SELECT blob_hash, mime_type FROM files WHERE id = ?1', [fileId],
  );
  if (row === undefined) return null;
  return {
    blobHash: nullable(row['blob_hash']),
    mimeType: nullable(row['mime_type']),
  };
}

/**
 * `update_mm_index_state_in_business_table`: only `exam_sheets` carries
 * `mm_embedding_dim` / `mm_indexed_at`; `files` (including textbooks and
 * attachments) does not.
 */
export function updateBusinessMmState(
  db: SqlExecutor,
  sourceType: string,
  sourceId: string,
  state: string,
  jsonOrError: string | null,
  embeddingDim: number,
  indexedCount: number,
  repositories: VfsReposService,
): void {
  if (!['exam', 'textbook', 'attachment', 'image', 'file'].includes(sourceType)) return;

  if (sourceType === 'exam') {
    requirePdfExamOwnerMethod(
      pdfExamOwnerFromRepositories(repositories), 'applyMultimodalIndexState',
    )(db, sourceId, state, jsonOrError, embeddingDim);
  } else {
    requirePdfFileOwnerMethod(
      pdfFileOwnerFromRepositories(repositories), 'applyMultimodalIndexState',
    )(db, sourceId, state, jsonOrError);
  }

  const resourceId = db.pluck<unknown>(
    `SELECT resource_id FROM ${sourceType === 'exam' ? 'exam_sheets' : 'files'} WHERE id = ?1`,
    [sourceId],
  );
  if (resourceId === null || resourceId === undefined) return;
  const id = String(resourceId);
  if (state === 'failed') {
    repositories.indexStates.markMmFailed(db, id, jsonOrError ?? 'multimodal indexing failed');
  } else {
    repositories.indexStates.setMmIndexState(db, id, state, null);
  }
}
