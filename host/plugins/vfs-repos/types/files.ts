/** File and resource contracts, including the PDF/media owner write surface. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { JsonValue } from './common.ts';

/** PdfPagePreview mirrors types.rs `PdfPagePreview` serde output. */
export interface PdfPagePreview {
  pageIndex: number; blobHash: string; width: number; height: number; mimeType: string; compressedBlobHash?: string;
}
/** PdfPreviewJson mirrors types.rs `PdfPreviewJson` serde output. */
export interface PdfPreviewJson {
  pages: PdfPagePreview[]; renderDpi: number; totalPages: number; renderedAt: string;
  isTruncated?: boolean; maxRenderedPages?: number;
}
/** VfsFile mirrors types.rs `VfsFile` serde output (camelCase, absent optional fields). */
export interface VfsFile {
  id: string; resourceId?: string; blobHash?: string; sha256: string; fileName: string;
  originalPath?: string; size: number; pageCount?: number; fileType: string; mimeType?: string;
  tags: string[]; isFavorite: boolean; lastOpenedAt?: string; lastPage?: number; bookmarks: JsonValue[];
  coverKey?: string; extractedText?: string; previewJson?: string; ocrPagesJson?: string;
  description?: string; status: string; createdAt: string; updatedAt: string; deletedAt?: string;
  processingStatus?: string; processingProgress?: string; processingError?: string;
  processingStartedAt?: number; processingCompletedAt?: number; compressedBlobHash?: string;
}
export interface FileRepository {
  createFile(conn: SqlExecutor, sha256: string, fileName: string, size: number, fileType: string,
    mimeType?: string | null, blobHash?: string | null, originalPath?: string | null): VfsFile;
  createFileInFolder(conn: SqlExecutor, sha256: string, fileName: string, size: number, fileType: string,
    mimeType: string | null, blobHash: string | null, originalPath: string | null, folderId: string | null): VfsFile;
  copyFile(conn: SqlExecutor, srcFileId: string, newFileName: string): VfsFile;
  createFileWithDocDataInFolder(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    fileType: string, mimeType: string | null, blobHash: string | null, originalPath: string | null,
    folderId: string | null, previewJson: string | null, extractedText: string | null, pageCount: number | null): VfsFile;
  createFileWithDocDataInFolderOutcome(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    fileType: string, mimeType: string | null, blobHash: string | null, originalPath: string | null,
    folderId: string | null, previewJson: string | null, extractedText: string | null, pageCount: number | null): [VfsFile, boolean];
  getFile(conn: SqlExecutor, fileId: string): VfsFile | null;
  /**
   * context_compiler.rs:634-639: `files.blob_hash` by file id, else by resource_id (id match first),
   * no deleted_at filter. null for no row or NULL hash; SQL errors propagate (Rust caller applies `.ok()`).
   */
  getBlobHashByFileOrResourceId(conn: SqlExecutor, sourceId: string): string | null;
  getBySha256(conn: SqlExecutor, sha256: string): VfsFile | null;
  listFiles(conn: SqlExecutor, limit: number, offset: number): VfsFile[];
  listFilesByFolder(conn: SqlExecutor, folderId: string | null, limit: number, offset: number): VfsFile[];
  listFilesByType(conn: SqlExecutor, fileType: string, limit: number, offset: number): VfsFile[];
  updateFileName(conn: SqlExecutor, fileId: string, newName: string): VfsFile;
  setFavorite(conn: SqlExecutor, fileId: string, favorite: boolean): void;
  deleteFile(conn: SqlExecutor, fileId: string): void;
  restoreFile(conn: SqlExecutor, fileId: string): void;
  purgeFile(conn: SqlExecutor, blobsDir: string, fileId: string): void;
  purgeFileWithConn(conn: SqlExecutor, fileId: string, blobsDir?: string): void;
  listDeletedFiles(conn: SqlExecutor, limit: number, offset: number): VfsFile[];
  getContent(conn: SqlExecutor, blobsDir: string, fileId: string): string | null;
  getOcrPages(conn: SqlExecutor, fileId: string): (string | null)[];
  getPageOcr(conn: SqlExecutor, fileId: string, pageIndex: number): string | null;
  savePageOcr(conn: SqlExecutor, fileId: string, pageIndex: number, ocrText: string): void;
  /** `pdf_processing_service.rs` text extraction: `extracted_text/page_count/updated_at`. */
  updatePdfExtractedText(conn: SqlExecutor, fileId: string, extractedText: string,
    pageCount: number | null): void;
  /** `pdf_processing_service.rs` page rendering: `preview_json/page_count/updated_at`. */
  updatePdfPreview(conn: SqlExecutor, fileId: string, previewJson: string,
    pageCount: number): void;
  /** `pdf_processing_service.rs` page compression: `preview_json/updated_at` only. */
  updatePdfPreviewOnly(conn: SqlExecutor, fileId: string, previewJson: string): void;
  /** `pdf_processing_service.rs` `update_file_ocr`: `ocr_pages_json/updated_at`. */
  updatePdfOcrPages(conn: SqlExecutor, fileId: string, ocrPagesJson: string): void;
  /**
   * handlers.rs:2528-2537 upload page-text write: only ocr_pages_json, no updated_at change.
   * Uses the caller's connection without a new transaction; missing rows are ignored.
   * SQL errors propagate unwrapped; the upload caller retains the Rust best-effort warn.
   */
  setUploadOcrPagesWithConn(conn: SqlExecutor, fileId: string, ocrPagesJson: string): void;
  /**
   * dstu-media pipeline.rs:336-339 `write_transcript_text` and bilibili.rs:1011-1014,1044-1047:
   * `UPDATE files SET extracted_text = ?1 WHERE id = ?2` only. `null` writes SQL NULL; the
   * value is stored as given (the caller decides empty → null like pipeline.rs:335).
   * No updated_at, no deleted_at filter, no index refresh. Runs on the caller's
   * connection/transaction without opening one; a missing row is a no-op; SQL errors
   * propagate unwrapped.
   */
  setMediaExtractedTextWithConn(conn: SqlExecutor, fileId: string, text: string | null): void;
  /** `pdf_processing_service.rs` image compression: `compressed_blob_hash/updated_at`. */
  updateCompressedBlobHash(conn: SqlExecutor, fileId: string, blobHash: string): void;
  /** Cancel only active media stages; returns affected rows and clears `processing_error`. */
  cancelProcessing(conn: SqlExecutor, fileId: string): number;
  /** Startup recovery: stuck media rows go back to `pending`; returns affected rows. */
  markProcessingRecovered(conn: SqlExecutor, fileId: string): number;
  /** `pdf_processing_service.rs::set_error`; does not touch `processing_progress`. */
  setProcessingError(conn: SqlExecutor, fileId: string, error: string, completedAt: number): void;
  /** Progress-only write (`pdf_processing_service.rs:2705`), no business `updated_at`. */
  updateProcessingProgress(conn: SqlExecutor, fileId: string, progressJson: string): void;
  /** `update_processing_status` branches; deliberately leaves business `updated_at` untouched. */
  applyProcessingStatus(conn: SqlExecutor, fileId: string, stage: string,
    progressJson: string | null, completedAt: number | null, now: number,
    issueSummary: string | null): void;
  /** `multimodal_service.rs` business-table state write for `files` rows. */
  applyMultimodalIndexState(conn: SqlExecutor, fileId: string, state: string,
    indexedPagesJsonOrError: string | null): void;
  purgeDeletedFiles(conn: SqlExecutor, blobsDir: string): number;
  fileExists(conn: SqlExecutor, fileId: string): boolean;
  getResourceIdByFileId(conn: SqlExecutor, fileId: string): string | null;
  /**
   * dstu-qbank question_import_service.rs:3758-3812 `ensure_vfs_file_for_blob` (connection part):
   * returns the first live (`deleted_at IS NULL`) `files.id` with this `blob_hash`; a lookup SQL
   * error counts as a miss (Rust `.optional().ok().flatten()`). Otherwise
   * `INSERT OR IGNORE` a minimal image row (`file_` + nanoid(12), no sha256/resource,
   * original_path '', size 0, tags '[]', status 'active', created_at = updated_at =
   * `%Y-%m-%dT%H:%M:%S%.3fZ`) and returns the new id even if the insert was ignored.
   * Insert SQL errors propagate unwrapped; the caller keeps Rust's
   * `[QuestionImport] ensure_vfs_file: 创建 file 条目失败: {e}` warn and `None` fallback.
   */
  ensureFileForBlobWithConn(conn: SqlExecutor, blobHash: string, fileName: string, mime: string): string;
}
export type VfsResourceType =
  | 'note' | 'textbook' | 'exam' | 'translation' | 'essay' | 'image'
  | 'file' | 'retrieval' | 'mindmap' | 'insight_card' | 'insightcard';
export type StorageMode = 'inline' | 'external';
/** VfsResourceMetadata mirrors types.rs `VfsResourceMetadata` (camelCase, absent optional fields). */
export interface VfsResourceMetadata {
  name?: string; title?: string; mimeType?: string; size?: number; source?: string; extra?: JsonValue;
}
/** VfsResource mirrors types.rs `VfsResource` serde output. Note the wire key is `type`. */
export interface VfsResource {
  id: string; hash: string; type: VfsResourceType; sourceId?: string; sourceTable?: string;
  storageMode: StorageMode; data?: string; externalHash?: string; metadata?: VfsResourceMetadata;
  refCount: number; createdAt: number; updatedAt: number;
}
export interface VfsCreateResourceResult { resourceId: string; hash: string; isNew: boolean }
/**
 * Read-only live-resource projection for consumers that must reject
 * soft-deleted resources (L16 `chatanki_executor.rs:10642-10653`). Kept out of
 * `ResourceRepository` so other lanes' test doubles need not implement it; the
 * production `vfsRepo.resources` exposes both interfaces.
 */
export interface ResourceLiveReader {
  /**
   * Only returns rows with `resources.deleted_at IS NULL`; missing and
   * soft-deleted resources both return null. The returned DTO stays identical
   * to `getResource` (no `deletedAt` field); source-file deletion does not
   * affect this check.
   */
  getLiveResource(conn: SqlExecutor, resourceId: string): VfsResource | null;
}

/**
 * Caller-connection `resources` metadata write. Kept out of `ResourceRepository` so other
 * lanes' test doubles need not implement it; the production `vfsRepo.resources` exposes it.
 */
export interface ResourceMetadataOwner {
  /**
   * index_webpage_executor.rs:720-729 (`builtin-webpage_save`):
   * `UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3`. Takes the
   * caller's already serialized JSON and millisecond timestamp, stored verbatim. Does not
   * touch data/hash/ref_count/ocr_text or index state, checks no existence and emits
   * nothing. Runs on the caller's connection/transaction without opening one; a missing
   * row is a no-op; SQL errors propagate unwrapped (the caller keeps `WEBPAGE_SAVE_FAILED`).
   */
  updateResourceMetadataWithConn(conn: SqlExecutor, resourceId: string, metadataJson: string,
    updatedAtMs: number): void;
}

export interface ResourceRepository {
  createOrReuse(conn: SqlExecutor, resourceType: VfsResourceType, data: string,
    sourceId: string | null, sourceTable: string | null, metadata: VfsResourceMetadata | null): VfsCreateResourceResult;
  createOrReuseWithHash(conn: SqlExecutor, resourceType: VfsResourceType, data: string, hash: string,
    sourceId: string | null, sourceTable: string | null, metadata: VfsResourceMetadata | null): VfsCreateResourceResult;
  createOrReuseExternal(conn: SqlExecutor, resourceType: VfsResourceType, contentHash: string,
    externalHash: string, sourceId: string | null, sourceTable: string | null,
    metadata: VfsResourceMetadata | null): VfsCreateResourceResult;
  getResource(conn: SqlExecutor, resourceId: string): VfsResource | null;
  getByHash(conn: SqlExecutor, hash: string): VfsResource | null;
  exists(conn: SqlExecutor, resourceId: string): boolean;
  incrementRef(conn: SqlExecutor, resourceId: string): number;
  decrementRef(conn: SqlExecutor, resourceId: string): number;
  decrementRefs(conn: SqlExecutor, resourceIds: readonly string[]): void;
  cleanupUnreferencedRetrievals(conn: SqlExecutor, gracePeriodMs: number): number;
  cleanupOrphanNoteMindmapResources(conn: SqlExecutor, gracePeriodMs: number): number;
  getBySourceId(conn: SqlExecutor, sourceId: string): VfsResource | null;
  listByType(conn: SqlExecutor, resourceType: VfsResourceType | null, limit: number, offset: number): VfsResource[];
  search(conn: SqlExecutor, query: string, types: readonly VfsResourceType[] | null, limit: number, offset: number): VfsResource[];
  updateResourceData(conn: SqlExecutor, resourceId: string, newData: string): boolean;
  computeHash(data: string): string;
  computeHashWithSalt(data: string, salt: string): string;
  saveOcrText(conn: SqlExecutor, resourceId: string, ocrText: string): void;
  getOcrText(conn: SqlExecutor, resourceId: string): string | null;
  hasOcrText(conn: SqlExecutor, resourceId: string): boolean;
  getOcrTextBySource(conn: SqlExecutor, sourceId: string, sourceTable: string): string | null;
}
/**
 * Pipeline-specific `resources` writes for the PDF/media owner handoff.
 * Kept separate from generic resource CRUD; `VfsReposService.resources` always
 * exposes the intersection of both surfaces.
 */
export interface PdfResourceOwner {
  /** indexing.rs:1082/3485: only NULL/empty OCR; no updated_at. SQL errors propagate to the caller's warn. */
  saveOcrTextIfEmptyWithConn(conn: SqlExecutor, resourceId: string, ocrText: string): void;
  /** indexing.rs:3354/3949: unconditional OCR; no updated_at. SQL errors propagate to the caller's warn. */
  saveOcrTextWithoutTimestampWithConn(conn: SqlExecutor, resourceId: string, ocrText: string): void;
  /**
   * indexing.rs:3777-3785: OCR recovery cache by resource id; only ocr_text and
   * updated_at=datetime('now'). Uses the supplied connection/transaction, opens none;
   * missing rows succeed. SQL errors propagate unwrapped to the caller's warning.
   */
  saveOcrTextWithSqlTimestampWithConn(conn: SqlExecutor, resourceId: string, ocrText: string): void;
  /**
   * `pdf_processing_service.rs:2663` OCR write by file id. Resolves
   * `files.resource_id` in the same statement and returns affected rows so the
   * caller can keep the Rust `rows_affected == 0` failure.
   */
  saveOcrTextForFile(conn: SqlExecutor, fileId: string, ocrText: string): number;
}
