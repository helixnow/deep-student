/** Port of dstu-vfs textbook_repo.rs. All functions take the caller's connection. */
import { logError, logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type JsonValue,
  type PageIndexMeta,
  type ResourceLocation,
  type TextbookRepository,
  type VfsFolderItem,
  type VfsTextbook,
} from '../api.ts';
import { BlobRepo } from './blobs.ts';
import { databaseResult } from './errors.ts';
import { FolderRepo } from './folders.ts';
import { parsePdfPreviewJson } from './pdf-preview-json.ts';
import { purgeIndexArtifactsByResource } from './index-artifacts.ts';
import { parseOcrPagesJson, serializeOcrPages } from './ocr-utils.ts';
import { utcTimestamp } from './timestamps.ts';

const TEXTBOOK_COLUMNS = `f.id, f.resource_id, f.blob_hash, f.sha256, f.file_name,
  f.original_path, f.size, f.page_count, f.tags_json, f.is_favorite, f.last_opened_at,
  f.last_page, f.bookmarks_json, f.cover_key, f.status, f.created_at, f.updated_at,
  r.metadata_json`;
const MAX_ANNOTATION_METADATA_BYTES = 512 * 1024;

function nowMillis(): number { return Date.now(); }

function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}
function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
function conflict(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_CONFLICT',
    `CONFLICT(textbooks.annotations_conflict): ${message}`, { key: 'textbooks.annotations_conflict' });
}
function invalidState(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_OPERATION', `INVALID_STATE: ${message}`);
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function databaseMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}
function serializationMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_SERIALIZATION', `Serialization error: ${message}`);
}

function valueKind(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'string') return 'Text';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'bigint') return 'Integer';
  return 'Blob';
}
function columnError(index: number, name: string, value: SqlValue | undefined): VfsRepositoryError {
  return databaseMessage(`Invalid column type ${valueKind(value)} at index: ${index}, name: ${name}`);
}
function readText(row: Row, name: string, index: number): string {
  const value = row[name];
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
function readInteger(row: Row, name: string, index: number): number {
  const value = row[name];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) throw columnError(index, name, value);
  return number;
}
function optionalText(value: SqlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function optionalInteger(value: SqlValue | undefined): number | undefined {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) ? number : undefined;
}

function parseJsonArray(raw: string): JsonValue[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value as JsonValue[] : [];
  } catch { return []; }
}
function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) return [];
    return value as string[];
  } catch { return []; }
}
function parseHighlights(metadataJson: string | undefined): JsonValue[] {
  if (metadataJson === undefined) return [];
  try {
    const metadata = JSON.parse(metadataJson) as unknown;
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
    const extra = (metadata as Record<string, unknown>).extra;
    if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return [];
    const highlights = (extra as Record<string, unknown>).highlights;
    return Array.isArray(highlights) ? highlights as JsonValue[] : [];
  } catch { return []; }
}

function rowToTextbook(row: Row): VfsTextbook {
  const resourceId = optionalText(row.resource_id);
  const blobHash = optionalText(row.blob_hash);
  const originalPath = optionalText(row.original_path);
  const pageCount = optionalInteger(row.page_count);
  const lastOpenedAt = optionalText(row.last_opened_at);
  const lastPage = optionalInteger(row.last_page);
  const coverKey = optionalText(row.cover_key);
  return {
    id: readText(row, 'id', 0),
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(blobHash === undefined ? {} : { blobHash }),
    sha256: readText(row, 'sha256', 3),
    fileName: readText(row, 'file_name', 4),
    ...(originalPath === undefined ? {} : { originalPath }),
    size: readInteger(row, 'size', 6),
    ...(pageCount === undefined ? {} : { pageCount }),
    tags: parseStringArray(readText(row, 'tags_json', 8)),
    isFavorite: readInteger(row, 'is_favorite', 9) !== 0,
    ...(lastOpenedAt === undefined ? {} : { lastOpenedAt }),
    ...(lastPage === undefined ? {} : { lastPage }),
    bookmarks: parseJsonArray(readText(row, 'bookmarks_json', 12)),
    highlights: parseHighlights(optionalText(row.metadata_json)),
    ...(coverKey === undefined ? {} : { coverKey }),
    status: readText(row, 'status', 14),
    createdAt: readText(row, 'created_at', 15),
    updatedAt: readText(row, 'updated_at', 16),
  };
}

function mapTextbooks(rows: readonly Row[]): VfsTextbook[] {
  const textbooks: VfsTextbook[] = [];
  for (const row of rows) {
    try { textbooks.push(rowToTextbook(row)); }
    catch (error) { logWarn('[VFS::TextbookRepo] Row parse error (skipped):', error); }
  }
  return textbooks;
}

function escapeLikePattern(query: string): string {
  return query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function fileTypeAndMime(fileName: string): { fileType: string; mimeType: string } {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  switch (extension) {
    case 'pdf': return { fileType: 'pdf', mimeType: 'application/pdf' };
    case 'pptx': return { fileType: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
    case 'ppt': return { fileType: 'ppt', mimeType: 'application/vnd.ms-powerpoint' };
    case 'docx': return { fileType: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    case 'doc': return { fileType: 'doc', mimeType: 'application/msword' };
    case 'epub': return { fileType: 'epub', mimeType: 'application/epub+zip' };
    case 'jpg':
    case 'jpeg': return { fileType: 'image', mimeType: 'image/jpeg' };
    case 'png': return { fileType: 'image', mimeType: 'image/png' };
    default: return { fileType: 'other', mimeType: 'application/octet-stream' };
  }
}

function ensureAnnotationRevision(textbook: VfsTextbook, expectedUpdatedAt: string): void {
  if (textbook.updatedAt === expectedUpdatedAt) return;
  throw conflict(`The textbook annotations changed (expected ${expectedUpdatedAt}, current ${textbook.updatedAt}).`);
}

function nextAnnotationRevision(current: string): string {
  const now = Date.now();
  const parsed = Date.parse(current);
  const minimum = Number.isNaN(parsed) ? now : parsed + 1;
  return new Date(Math.max(now, minimum)).toISOString();
}

export class TextbookRepo implements TextbookRepository {
  private readonly blobs = new BlobRepo();
  private readonly folders = new FolderRepo();

  createTextbook(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    blobHash: string | null, originalPath: string | null): VfsTextbook {
    return this.createTextbookWithPreview(conn, sha256, fileName, size, blobHash,
      originalPath, null, null, null);
  }

  createTextbookWithPreview(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    blobHash: string | null, originalPath: string | null, previewJson: string | null,
    extractedText: string | null, pageCount: number | null): VfsTextbook {
    return databaseResult(() => {
      const existing = this.getBySha256(conn, sha256);
      if (existing !== null) {
        if (existing.status !== 'active') {
          conn.run("UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            [utcTimestamp(), existing.id]);
          const restored = this.getTextbook(conn, existing.id);
          if (restored === null) throw databaseMessage(`Textbook ${existing.id} not found after restore`);
          return restored;
        }
        return existing;
      }

      const textbookId = `file_${nanoid(10)}`;
      const now = utcTimestamp();
      const nowMs = nowMillis();
      try { conn.exec('SAVEPOINT create_textbook'); }
      catch (error) {
        logError('[VFS::TextbookRepo] Failed to create savepoint for create_textbook:', error);
        throw databaseMessage(`Failed to create savepoint: ${messageOf(error)}`);
      }
      let created: VfsTextbook;
      try {
        const resourceId = `res_${nanoid(10)}`;
        conn.run(`INSERT INTO resources
            (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
          VALUES (?1, ?2, 'file', ?3, 'files', 'inline', ?4, 0, ?5, ?6)`,
        [resourceId, sha256, textbookId, extractedText ?? '', nowMs, nowMs]);

        const isPdf = fileName.toLowerCase().endsWith('.pdf');
        let processingStatus: string | null = null;
        let processingProgress: string | null = null;
        let processingStartedAt: number | null = null;
        if (isPdf) {
          const readyModes: string[] = [];
          if (extractedText !== null) readyModes.push('text');
          processingStatus = 'page_rendering';
          processingProgress = `{"stage":"page_rendering","percent":25.0,"readyModes":${JSON.stringify(readyModes)}}`;
          processingStartedAt = nowMs;
        }

        const { fileType, mimeType } = fileTypeAndMime(fileName);
        conn.run(`INSERT INTO files
            (id, resource_id, blob_hash, sha256, file_name, original_path, size, "type", mime_type,
             page_count, tags_json, is_favorite, status, created_at, updated_at, preview_json,
             extracted_text, processing_status, processing_progress, processing_started_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '[]', 0, 'active', ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
        [textbookId, resourceId, blobHash, sha256, fileName, originalPath, size, fileType,
          mimeType, pageCount, now, now, previewJson, extractedText, processingStatus,
          processingProgress, processingStartedAt]);

        created = {
          id: textbookId,
          resourceId,
          ...(blobHash === null ? {} : { blobHash }),
          sha256,
          fileName,
          ...(originalPath === null ? {} : { originalPath }),
          size,
          ...(pageCount === null ? {} : { pageCount }),
          tags: [],
          isFavorite: false,
          bookmarks: [],
          highlights: [],
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
      } catch (error) {
        try { conn.exec('ROLLBACK TO create_textbook'); }
        catch (rollbackError) { logWarn('[VFS::TextbookRepo] create rollback failed:', rollbackError); }
        try { conn.exec('RELEASE create_textbook'); }
        catch (releaseError) { logWarn('[VFS::TextbookRepo] create release failed:', releaseError); }
        throw error;
      }
      // Rust: RELEASE failure is logged and returned without ROLLBACK TO.
      try { conn.exec('RELEASE create_textbook'); }
      catch (error) {
        logError('[VFS::TextbookRepo] Failed to release savepoint create_textbook:', error);
        throw databaseMessage(`Failed to release savepoint: ${messageOf(error)}`);
      }
      return created;
    });
  }

  copyTextbook(conn: SqlExecutor, srcTextbookId: string, newFileName: string): VfsTextbook {
    return databaseResult(() => {
      const src = this.getTextbook(conn, srcTextbookId);
      if (src === null) throw notFound('Textbook', srcTextbookId);

      const sourceRow = conn.get<Row>(
        'SELECT preview_json, extracted_text FROM files WHERE id = ?1', [srcTextbookId]);
      const previewJson = sourceRow === undefined ? undefined : optionalText(sourceRow.preview_json);
      const extractedText = sourceRow === undefined ? undefined : optionalText(sourceRow.extracted_text);

      const sharedHashes: string[] = [];
      if (src.blobHash !== undefined) sharedHashes.push(src.blobHash);
      if (previewJson !== undefined) {
        const preview = parsePdfPreviewJson(previewJson);
        if (preview !== null) {
          for (const page of preview.pages) {
            sharedHashes.push(page.blobHash);
            if (page.compressedBlobHash !== undefined && page.compressedBlobHash !== page.blobHash) {
              sharedHashes.push(page.compressedBlobHash);
            }
          }
        }
      }

      const newSha256 = `${src.sha256}_copy_${nanoid(8)}`;
      conn.exec('SAVEPOINT copy_textbook');
      let copy: VfsTextbook;
      try {
        for (const hash of sharedHashes) this.blobs.incrementRef(conn, hash);
        copy = this.createTextbookWithPreview(conn, newSha256, newFileName, src.size,
          src.blobHash ?? null, src.originalPath ?? null, previewJson ?? null,
          extractedText ?? null, src.pageCount ?? null);
      } catch (error) {
        try { conn.exec('ROLLBACK TO copy_textbook'); }
        catch (rollbackError) { logWarn('[VFS::TextbookRepo] copy rollback failed:', rollbackError); }
        try { conn.exec('RELEASE copy_textbook'); }
        catch (releaseError) { logWarn('[VFS::TextbookRepo] copy release failed:', releaseError); }
        logError(`[VFS::TextbookRepo] Failed to copy textbook ${srcTextbookId}:`, error);
        throw error;
      }
      // Rust `conn.execute("RELEASE copy_textbook")?`: propagated without rollback or log.
      conn.exec('RELEASE copy_textbook');
      return copy;
    });
  }

  getTextbook(conn: SqlExecutor, textbookId: string): VfsTextbook | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${TEXTBOOK_COLUMNS} FROM files f
        LEFT JOIN resources r ON r.id = f.resource_id
        WHERE f.id = ?1`, [textbookId]);
      return row === undefined ? null : rowToTextbook(row);
    });
  }

  getBySha256(conn: SqlExecutor, sha256: string): VfsTextbook | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${TEXTBOOK_COLUMNS} FROM files f
        LEFT JOIN resources r ON r.id = f.resource_id
        WHERE f.sha256 = ?1`, [sha256]);
      return row === undefined ? null : rowToTextbook(row);
    });
  }

  listTextbooks(conn: SqlExecutor, limit: number, offset: number): VfsTextbook[] {
    return databaseResult(() => mapTextbooks(conn.all<Row>(`SELECT ${TEXTBOOK_COLUMNS}
      FROM files f
      LEFT JOIN resources r ON r.id = f.resource_id
      WHERE f.status = 'active'
      ORDER BY f.updated_at DESC
      LIMIT ?1 OFFSET ?2`, [limit, offset])));
  }

  searchTextbooks(conn: SqlExecutor, search: string, limit: number, offset: number): VfsTextbook[] {
    return databaseResult(() => {
      const pattern = `%${escapeLikePattern(search.trim())}%`;
      return mapTextbooks(conn.all<Row>(`SELECT ${TEXTBOOK_COLUMNS}
        FROM files f
        LEFT JOIN resources r ON r.id = f.resource_id
        WHERE f.status = 'active'
          AND (f.file_name LIKE ?1 ESCAPE '\\' OR COALESCE(f.original_path, '') LIKE ?1 ESCAPE '\\')
        ORDER BY f.updated_at DESC
        LIMIT ?2 OFFSET ?3`, [pattern, limit, offset]));
    });
  }

  updateReadingProgress(conn: SqlExecutor, textbookId: string, lastPage: number): void {
    databaseResult(() => {
      const now = utcTimestamp();
      conn.run('UPDATE files SET last_page = ?1, last_opened_at = ?2, updated_at = ?2 WHERE id = ?3',
        [lastPage, now, textbookId]);
    });
  }

  updatePageCount(conn: SqlExecutor, textbookId: string, pageCount: number): void {
    databaseResult(() => {
      conn.run('UPDATE files SET page_count = ?1, updated_at = ?2 WHERE id = ?3',
        [pageCount, utcTimestamp(), textbookId]);
    });
  }

  updateFileName(conn: SqlExecutor, textbookId: string, newName: string): VfsTextbook {
    return databaseResult(() => {
      const updated = conn.run('UPDATE files SET file_name = ?1, updated_at = ?2 WHERE id = ?3',
        [newName, utcTimestamp(), textbookId]).changes;
      if (updated === 0) throw notFound('Textbook', textbookId);
      const textbook = this.getTextbook(conn, textbookId);
      if (textbook === null) throw notFound('Textbook', textbookId);
      return textbook;
    });
  }

  setFavorite(conn: SqlExecutor, textbookId: string, favorite: boolean): void {
    databaseResult(() => {
      conn.run('UPDATE files SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
        [favorite ? 1 : 0, utcTimestamp(), textbookId]);
    });
  }

  updateBookmarks(conn: SqlExecutor, textbookId: string, bookmarks: readonly JsonValue[]): void {
    databaseResult(() => {
      const bookmarksJson = JSON.stringify(bookmarks);
      conn.run('UPDATE files SET bookmarks_json = ?1, updated_at = ?2 WHERE id = ?3',
        [bookmarksJson, utcTimestamp(), textbookId]);
    });
  }

  replaceBookmarksIfVersion(conn: SqlExecutor, textbookId: string,
    bookmarks: readonly JsonValue[], expectedUpdatedAt: string): VfsTextbook {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const current = this.getTextbook(conn, textbookId);
        if (current === null) throw notFound('Textbook', textbookId);
        ensureAnnotationRevision(current, expectedUpdatedAt);
        const bookmarksJson = JSON.stringify(bookmarks);
        const nextUpdatedAt = nextAnnotationRevision(current.updatedAt);
        const changed = conn.run(
          'UPDATE files SET bookmarks_json = ?1, updated_at = ?2 WHERE id = ?3 AND updated_at = ?4',
          [bookmarksJson, nextUpdatedAt, textbookId, current.updatedAt]).changes;
        if (changed !== 1) {
          throw conflict('The textbook annotations changed before the bookmark update committed.');
        }
        const updated = this.getTextbook(conn, textbookId);
        if (updated === null) throw notFound('Textbook', textbookId);
        conn.exec('COMMIT');
        return updated;
      } catch (error) {
        try { conn.exec('ROLLBACK'); }
        catch (rollbackError) { logWarn('[VFS::TextbookRepo] bookmarks rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  replaceHighlightsIfVersion(conn: SqlExecutor, textbookId: string,
    highlights: readonly JsonValue[], expectedUpdatedAt: string): VfsTextbook {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const current = this.getTextbook(conn, textbookId);
        if (current === null) throw notFound('Textbook', textbookId);
        ensureAnnotationRevision(current, expectedUpdatedAt);
        const resourceId = current.resourceId;
        if (resourceId === undefined) {
          throw invalidState(`Textbook ${textbookId} has no associated VFS resource`);
        }

        const metadataRow = conn.get<Row>(
          'SELECT metadata_json FROM resources WHERE id = ?1', [resourceId]);
        if (metadataRow === undefined) throw notFound('Resource', resourceId);
        const rawMetadata = optionalText(metadataRow.metadata_json);
        let metadata: JsonValue;
        if (rawMetadata === undefined) metadata = {};
        else {
          try { metadata = JSON.parse(rawMetadata) as JsonValue; }
          catch (error) {
            throw serializationMessage(error instanceof Error ? error.message : String(error));
          }
        }
        if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
          throw serializationMessage('Textbook resource metadata must be a JSON object');
        }
        const metadataObject = metadata as Record<string, JsonValue>;
        let extra = metadataObject.extra;
        if (extra === undefined) {
          extra = {};
          metadataObject.extra = extra;
        }
        if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
          throw serializationMessage('Textbook resource metadata.extra must be a JSON object');
        }
        (extra as Record<string, JsonValue>).highlights = highlights as JsonValue[];

        const serialized = JSON.stringify(metadata);
        if (utf8ByteLength(serialized) > MAX_ANNOTATION_METADATA_BYTES) {
          throw invalidArgument('highlights',
            `serialized annotation metadata exceeds ${MAX_ANNOTATION_METADATA_BYTES} bytes`);
        }

        const nextUpdatedAt = nextAnnotationRevision(current.updatedAt);
        const parsedNext = Date.parse(nextUpdatedAt);
        const nowMs = Number.isNaN(parsedNext) ? nowMillis() : parsedNext;
        const resourceChanged = conn.run(
          'UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3',
          [serialized, nowMs, resourceId]).changes;
        if (resourceChanged !== 1) throw notFound('Resource', resourceId);
        const fileChanged = conn.run(
          'UPDATE files SET updated_at = ?1 WHERE id = ?2 AND updated_at = ?3',
          [nextUpdatedAt, textbookId, current.updatedAt]).changes;
        if (fileChanged !== 1) {
          throw conflict('The textbook annotations changed before the highlight update committed.');
        }
        const updated = this.getTextbook(conn, textbookId);
        if (updated === null) throw notFound('Textbook', textbookId);
        conn.exec('COMMIT');
        return updated;
      } catch (error) {
        try { conn.exec('ROLLBACK'); }
        catch (rollbackError) { logWarn('[VFS::TextbookRepo] highlights rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  deleteTextbook(conn: SqlExecutor, textbookId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const updated = conn.run(
        "UPDATE files SET status = 'deleted', deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'active'",
        [now, textbookId]).changes;
      if (updated === 0) {
        const alreadyDeleted = Number(conn.pluck<number>(
          "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1 AND status = 'deleted')",
          [textbookId]) ?? 0) !== 0;
        if (!alreadyDeleted) throw notFound('Textbook', textbookId);
      }
    });
  }

  restoreTextbook(conn: SqlExecutor, textbookId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const nowMs = nowMillis();
      const updated = conn.run(
        "UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'deleted'",
        [now, textbookId]).changes;
      if (updated === 0) throw notFound('Textbook', textbookId);
      conn.run(`UPDATE folder_items SET deleted_at = NULL, updated_at = ?1
        WHERE item_type = 'file' AND item_id = ?2 AND deleted_at IS NOT NULL`, [nowMs, textbookId]);
    });
  }

  renameTextbook(conn: SqlExecutor, textbookId: string, newFileName: string): boolean {
    return databaseResult(() => {
      const trimmed = newFileName.trim();
      if (trimmed === '') return false;
      return conn.run(`UPDATE files SET file_name = ?1, name = ?1, updated_at = ?2
        WHERE id = ?3 AND file_name != ?1`, [trimmed, utcTimestamp(), textbookId]).changes > 0;
    });
  }

  setOriginalPathWithConn(conn: SqlExecutor, textbookId: string, originalPath: string): number {
    return conn.run('UPDATE files SET original_path = ?1, updated_at = ?2 WHERE id = ?3',
      [originalPath, utcTimestamp(), textbookId]).changes;
  }

  updateTextbookOcrPagesJson(conn: SqlExecutor, textbookId: string, pagesJson: string): void {
    conn.run('UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2', [pagesJson, textbookId]);
  }

  markTextbookRenderError(conn: SqlExecutor, textbookId: string, renderError: string): void {
    conn.run("UPDATE files SET processing_status = 'error', processing_error = ?1 WHERE id = ?2",
      [renderError, textbookId]);
  }

  attachBlobIfMissing(conn: SqlExecutor, blobsDir: string, textbookId: string,
    data: Uint8Array, mimeType: string | null, extension: string | null): boolean {
    return databaseResult(() => {
      const row = conn.get<Row>('SELECT blob_hash FROM files WHERE id = ?1', [textbookId]);
      if (row === undefined) throw notFound('Textbook', textbookId);
      const current = optionalText(row.blob_hash);
      if (current !== undefined) return false;
      const blob = this.blobs.storeBlob(conn, blobsDir, data, mimeType, extension);
      conn.run('UPDATE files SET blob_hash = ?1, updated_at = ?2 WHERE id = ?3',
        [blob.hash, utcTimestamp(), textbookId]);
      return true;
    });
  }

  purgeTextbook(conn: SqlExecutor, blobsDir: string, textbookId: string): void {
    databaseResult(() => {
      this.purgeTextbookWithConn(conn, textbookId, blobsDir);
      try { this.blobs.cleanupUnreferenced(conn, blobsDir); }
      catch (error) {
        logWarn('[VFS::TextbookRepo] Post-purge blob sweep failed (will retry on next sweep):', error);
      }
    });
  }

  purgeTextbookWithConn(conn: SqlExecutor, textbookId: string, blobsDir: string): void {
    databaseResult(() => {
      try { conn.exec('SAVEPOINT vfs_textbook_purge_tx'); }
      catch (error) {
        logError('[VFS::TextbookRepo] Failed to begin savepoint for purge:', error);
        throw databaseMessage(`Failed to begin savepoint: ${messageOf(error)}`);
      }
      try {
        const row = conn.get<Row>(
          'SELECT blob_hash, preview_json, resource_id, compressed_blob_hash FROM files WHERE id = ?1',
          [textbookId]);
        if (row === undefined) throw notFound('Textbook', textbookId);
        const blobHash = optionalText(row.blob_hash);
        const previewJson = optionalText(row.preview_json);
        const resourceId = optionalText(row.resource_id);
        const compressedBlobHash = optionalText(row.compressed_blob_hash);

        if (blobHash !== undefined) {
          try { this.blobs.decrementRef(conn, blobHash); }
          catch (error) { logWarn(`[VFS::TextbookRepo] Failed to decrement blob ref ${blobHash}:`, error); }
        }
        if (compressedBlobHash !== undefined && compressedBlobHash !== blobHash) {
          try { this.blobs.decrementRef(conn, compressedBlobHash); }
          catch (error) {
            logWarn(`[VFS::TextbookRepo] Failed to decrement compressed blob ref ${compressedBlobHash}:`, error);
          }
        }
        if (previewJson !== undefined) {
          const preview = parsePdfPreviewJson(previewJson);
          if (preview !== null) {
            for (const page of preview.pages) {
              try { this.blobs.decrementRef(conn, page.blobHash); }
              catch (error) { logWarn(`[VFS::TextbookRepo] Failed to decrement PDF page blob ${page.blobHash}:`, error); }
              if (page.compressedBlobHash !== undefined && page.compressedBlobHash !== page.blobHash) {
                try { this.blobs.decrementRef(conn, page.compressedBlobHash); }
                catch (error) {
                  logWarn(`[VFS::TextbookRepo] Failed to decrement PDF compressed page blob ${page.compressedBlobHash}:`, error);
                }
              }
            }
          }
        }

        conn.run('DELETE FROM folder_items WHERE item_id = ?1', [textbookId]);
        const deleted = conn.run('DELETE FROM files WHERE id = ?1', [textbookId]).changes;
        if (deleted === 0) throw notFound('Textbook', textbookId);
        if (resourceId !== undefined) {
          purgeIndexArtifactsByResource(conn, resourceId);
          conn.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
        }
      } catch (error) {
        try { conn.exec('ROLLBACK TO SAVEPOINT vfs_textbook_purge_tx; RELEASE SAVEPOINT vfs_textbook_purge_tx;'); }
        catch (rollbackError) { logWarn('[VFS::TextbookRepo] purge rollback failed:', rollbackError); }
        logError('[VFS::TextbookRepo] Purge failed, rolled back:', error);
        throw error;
      }
      try { conn.exec('RELEASE SAVEPOINT vfs_textbook_purge_tx'); }
      catch (error) {
        logError('[VFS::TextbookRepo] Failed to release purge savepoint:', error);
        try { conn.exec('ROLLBACK TO SAVEPOINT vfs_textbook_purge_tx; RELEASE SAVEPOINT vfs_textbook_purge_tx;'); }
        catch (rollbackError) { logWarn('[VFS::TextbookRepo] purge release rollback failed:', rollbackError); }
        throw databaseMessage(`Failed to release savepoint: ${messageOf(error)}`);
      }
    });
  }

  listDeletedTextbooks(conn: SqlExecutor, limit: number, offset: number): VfsTextbook[] {
    return databaseResult(() => mapTextbooks(conn.all<Row>(`SELECT ${TEXTBOOK_COLUMNS}
      FROM files f
      LEFT JOIN resources r ON r.id = f.resource_id
      WHERE f.status = 'deleted' AND f.id LIKE 'tb_%'
      ORDER BY f.updated_at DESC
      LIMIT ?1 OFFSET ?2`, [limit, offset])));
  }

  purgeDeletedTextbooks(conn: SqlExecutor, blobsDir: string): number {
    return databaseResult(() => {
      const textbookIds = conn.all<Row>(
        "SELECT id FROM files WHERE status = 'deleted' AND id LIKE 'tb_%'").flatMap(row => {
        try { return [readText(row, 'id', 0)]; }
        catch (error) { logWarn('[VFS::TextbookRepo] Row parse error (skipped):', error); return []; }
      });
      for (const textbookId of textbookIds) {
        try { this.purgeTextbookWithConn(conn, textbookId, blobsDir); }
        catch (error) { logWarn(`[VFS::TextbookRepo] Failed to purge textbook ${textbookId}:`, error); }
      }
      try { this.blobs.cleanupUnreferenced(conn, blobsDir); }
      catch (error) {
        logWarn('[VFS::TextbookRepo] Post-batch-purge blob sweep failed (will retry on next sweep):', error);
      }
      return textbookIds.length;
    });
  }

  createTextbookInFolder(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    blobHash: string | null, originalPath: string | null, folderId: string | null): VfsTextbook {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        if (folderId !== null && !this.folders.folderExists(conn, folderId)) {
          throw notFound('Folder', folderId);
        }
        const textbook = this.createTextbook(conn, sha256, fileName, size, blobHash, originalPath);
        const folderItem: VfsFolderItem = {
          id: `fi_${nanoid(10)}`,
          ...(folderId === null ? {} : { folderId }),
          itemType: 'file',
          itemId: textbook.id,
          sortOrder: 0,
          createdAt: nowMillis(),
        };
        this.folders.addItemToFolder(conn, folderItem);
        conn.exec('COMMIT');
        return textbook;
      } catch (error) {
        try { conn.exec('ROLLBACK'); }
        catch (rollbackError) { logWarn('[VFS::TextbookRepo] folder create rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  deleteTextbookWithFolderItem(conn: SqlExecutor, textbookId: string): void {
    databaseResult(() => {
      this.deleteTextbook(conn, textbookId);
      conn.run(`UPDATE folder_items SET deleted_at = ?1, updated_at = ?2
        WHERE item_type = 'file' AND item_id = ?3 AND deleted_at IS NULL`,
      [utcTimestamp(), nowMillis(), textbookId]);
    });
  }

  purgeTextbookWithFolderItem(conn: SqlExecutor, blobsDir: string, textbookId: string): void {
    databaseResult(() => {
      this.purgeTextbookWithConn(conn, textbookId, blobsDir);
      this.folders.removeItemByItemId(conn, 'file', textbookId);
    });
  }

  listTextbooksByFolder(conn: SqlExecutor, folderId: string | null, limit: number, offset: number): VfsTextbook[] {
    return databaseResult(() => mapTextbooks(conn.all<Row>(`SELECT ${TEXTBOOK_COLUMNS}
      FROM files f
      LEFT JOIN resources r ON r.id = f.resource_id
      JOIN folder_items fi ON fi.item_type = 'file' AND fi.item_id = f.id
      WHERE fi.folder_id IS ?1 AND f.status = 'active'
      ORDER BY fi.sort_order ASC, f.updated_at DESC
      LIMIT ?2 OFFSET ?3`, [folderId, limit, offset])));
  }

  getTextbookLocation(conn: SqlExecutor, textbookId: string): ResourceLocation | null {
    return databaseResult(() => this.folders.getResourceLocation(conn, 'file', textbookId));
  }

  listAllTextbooks(conn: SqlExecutor, limit: number, offset: number): VfsTextbook[] {
    return this.listTextbooks(conn, limit, offset);
  }

  savePageOcr(conn: SqlExecutor, textbookId: string, pageIndex: number, ocrText: string): void {
    databaseResult(() => {
      const row = conn.get<Row>('SELECT ocr_pages_json FROM files WHERE id = ?1', [textbookId]);
      const existing = row === undefined ? undefined : optionalText(row.ocr_pages_json);
      const ocrPages = existing === undefined ? [] : parseOcrPagesJson(existing);
      while (ocrPages.length <= pageIndex) ocrPages.push(null);
      ocrPages[pageIndex] = ocrText;
      conn.run('UPDATE files SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3',
        [serializeOcrPages(ocrPages), utcTimestamp(), textbookId]);
    });
  }

  saveOcrPages(conn: SqlExecutor, textbookId: string, ocrPages: readonly (string | null)[]): void {
    databaseResult(() => {
      conn.run('UPDATE files SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3',
        [serializeOcrPages(ocrPages), utcTimestamp(), textbookId]);
    });
  }

  getPageOcr(conn: SqlExecutor, textbookId: string, pageIndex: number): string | null {
    return databaseResult(() => {
      const row = conn.get<Row>('SELECT ocr_pages_json FROM files WHERE id = ?1', [textbookId]);
      const json = row === undefined ? undefined : optionalText(row.ocr_pages_json);
      if (json === undefined) return null;
      const ocrPages = parseOcrPagesJson(json);
      return pageIndex < ocrPages.length ? ocrPages[pageIndex] ?? null : null;
    });
  }

  getAllOcrPages(conn: SqlExecutor, textbookId: string): (string | null)[] {
    return databaseResult(() => {
      const row = conn.get<Row>('SELECT ocr_pages_json FROM files WHERE id = ?1', [textbookId]);
      const json = row === undefined ? undefined : optionalText(row.ocr_pages_json);
      return json === undefined ? [] : parseOcrPagesJson(json);
    });
  }

  hasPageOcr(conn: SqlExecutor, textbookId: string, pageIndex: number): boolean {
    return this.getPageOcr(conn, textbookId, pageIndex) !== null;
  }

  savePageMmIndex(conn: SqlExecutor, textbookId: string, meta: PageIndexMeta): void {
    databaseResult(() => {
      const row = conn.get<Row>('SELECT mm_indexed_pages_json FROM files WHERE id = ?1', [textbookId]);
      const existing = row === undefined ? undefined : optionalText(row.mm_indexed_pages_json);
      let pages: PageIndexMeta[] = [];
      if (existing !== undefined) {
        try {
          const parsed = JSON.parse(existing) as unknown;
          if (Array.isArray(parsed)) pages = parsed as PageIndexMeta[];
        } catch { pages = []; }
      }
      const position = pages.findIndex(page => page.pageIndex === meta.pageIndex);
      if (position >= 0) pages[position] = meta;
      else pages.push(meta);
      conn.run('UPDATE files SET mm_indexed_pages_json = ?1, updated_at = ?2 WHERE id = ?3',
        [JSON.stringify(pages), utcTimestamp(), textbookId]);
    });
  }

  getMmIndexedPages(conn: SqlExecutor, textbookId: string): PageIndexMeta[] {
    return databaseResult(() => {
      const row = conn.get<Row>('SELECT mm_indexed_pages_json FROM files WHERE id = ?1', [textbookId]);
      const json = row === undefined ? undefined : optionalText(row.mm_indexed_pages_json);
      if (json === undefined) return [];
      try {
        const parsed = JSON.parse(json) as unknown;
        if (!Array.isArray(parsed)) throw new Error('expected an array');
        return parsed as PageIndexMeta[];
      } catch (error) {
        throw databaseMessage(`解析索引元数据失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  getMmIndexedBlobHashes(conn: SqlExecutor, textbookId: string): Record<number, string> {
    return databaseResult(() => {
      const hashes: Record<number, string> = {};
      for (const page of this.getMmIndexedPages(conn, textbookId)) {
        hashes[page.pageIndex] = page.blobHash;
      }
      return hashes;
    });
  }

  clearMmIndex(conn: SqlExecutor, textbookId: string): void {
    databaseResult(() => {
      conn.run('UPDATE files SET mm_indexed_pages_json = NULL, updated_at = ?1 WHERE id = ?2',
        [utcTimestamp(), textbookId]);
    });
  }

  getMmIndexState(conn: SqlExecutor, textbookId: string): string | null {
    return databaseResult(() => {
      const row = conn.get<Row>('SELECT mm_index_state FROM files WHERE id = ?1', [textbookId]);
      return row === undefined ? null : optionalText(row.mm_index_state) ?? null;
    });
  }

  setMmIndexState(conn: SqlExecutor, textbookId: string, state: string, error: string | null): void {
    databaseResult(() => {
      const updated = conn.run(
        'UPDATE files SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4',
        [state, error, utcTimestamp(), textbookId]).changes;
      if (updated === 0) throw notFound('textbook', textbookId);
    });
  }
}
