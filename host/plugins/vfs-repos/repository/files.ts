/** Port of dstu-vfs file_repo.rs. All functions take the caller's connection. */
import { logError, logWarn } from './logger.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type FileRepository,
  type JsonValue,
  type VfsFile,
} from '../api.ts';
import { BlobRepo } from './blobs.ts';
import { databaseResult } from './errors.ts';
import { FolderRepo, newFolderItem } from './folders.ts';
import { purgeIndexArtifactsByResource } from './index-artifacts.ts';
import { parseOcrPagesJson, serializeOcrPages } from './ocr-utils.ts';
import { utcTimestamp } from './timestamps.ts';
import { parsePdfPreviewJson } from './pdf-preview-json.ts';
import { vfsReposLocalRuntime } from '../src/local-runtime.ts';
export { parsePdfPreviewJson } from './pdf-preview-json.ts';

const FILE_COLUMNS = `id, resource_id, blob_hash, sha256, file_name, original_path, size, page_count,
  "type" AS file_type, mime_type, tags_json, is_favorite, last_opened_at, last_page, bookmarks_json,
  cover_key, extracted_text, preview_json, ocr_pages_json, description,
  status, created_at, updated_at, deleted_at,
  processing_status, processing_progress, processing_error,
  processing_started_at, processing_completed_at,
  compressed_blob_hash`;

const FILE_COLUMNS_PREFIXED = `f.id, f.resource_id, f.blob_hash, f.sha256, f.file_name, f.original_path, f.size, f.page_count,
  f."type" AS file_type, f.mime_type, f.tags_json, f.is_favorite, f.last_opened_at, f.last_page, f.bookmarks_json,
  f.cover_key, f.extracted_text, f.preview_json, f.ocr_pages_json, f.description,
  f.status, f.created_at, f.updated_at, f.deleted_at,
  f.processing_status, f.processing_progress, f.processing_error,
  f.processing_started_at, f.processing_completed_at,
  f.compressed_blob_hash`;

const SPECIAL_SCHEMES = ['content://', 'asset://', 'ph://', 'image://', 'camera://'];
const ANDROID_SAF_PREFIXES = ['primary:', 'secondary:', 'raw:'];

function notFound(fileId: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `File not found: ${fileId}`, { resourceType: 'File', id: fileId });
}
function folderNotFound(folderId: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `Folder not found: ${folderId}`, { resourceType: 'Folder', id: folderId });
}
function databaseMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}
function ioMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_IO', `IO error: ${message}`);
}
function otherMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INTERNAL', message);
}
function isVirtualUri(path: string): boolean {
  const lower = path.trimStart().toLowerCase();
  return SPECIAL_SCHEMES.some(scheme => lower.startsWith(scheme))
    || ANDROID_SAF_PREFIXES.some(prefix => lower.startsWith(prefix));
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
function readOptionalText(row: Row, name: string, index: number): string | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
function readInteger(row: Row, name: string, index: number): number {
  const value = row[name];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) throw columnError(index, name, value);
  return number;
}
function readOptionalInteger(row: Row, name: string, index: number): number | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  return readInteger(row, name, index);
}
function readBoolean(row: Row, name: string, index: number): boolean {
  return readInteger(row, name, index) !== 0;
}

function parseTags(value: SqlValue | undefined): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(entry => typeof entry === 'string')) return parsed as string[];
  } catch (error) {
    logWarn('[VFS::FileRepo] Failed to parse tags_json:', error);
  }
  return [];
}
function parseBookmarks(value: SqlValue | undefined): JsonValue[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as JsonValue[];
  } catch (error) {
    logWarn('[VFS::FileRepo] Failed to parse bookmarks_json:', error);
  }
  return [];
}

function rowToFile(row: Row): VfsFile {
  const file: VfsFile = {
    id: readText(row, 'id', 0),
    sha256: readText(row, 'sha256', 3),
    fileName: readText(row, 'file_name', 4),
    size: readInteger(row, 'size', 6),
    fileType: readText(row, 'file_type', 8),
    tags: parseTags(row.tags_json),
    isFavorite: readBoolean(row, 'is_favorite', 11),
    bookmarks: parseBookmarks(row.bookmarks_json),
    status: readText(row, 'status', 20),
    createdAt: readText(row, 'created_at', 21),
    updatedAt: readText(row, 'updated_at', 22),
  };
  const resourceId = readOptionalText(row, 'resource_id', 1);
  if (resourceId !== null) file.resourceId = resourceId;
  const blobHash = readOptionalText(row, 'blob_hash', 2);
  if (blobHash !== null) file.blobHash = blobHash;
  const originalPath = readOptionalText(row, 'original_path', 5);
  if (originalPath !== null) file.originalPath = originalPath;
  const pageCount = readOptionalInteger(row, 'page_count', 7);
  if (pageCount !== null) file.pageCount = pageCount;
  const mimeType = readOptionalText(row, 'mime_type', 9);
  if (mimeType !== null) file.mimeType = mimeType;
  const lastOpenedAt = readOptionalText(row, 'last_opened_at', 12);
  if (lastOpenedAt !== null) file.lastOpenedAt = lastOpenedAt;
  const lastPage = readOptionalInteger(row, 'last_page', 13);
  if (lastPage !== null) file.lastPage = lastPage;
  const coverKey = readOptionalText(row, 'cover_key', 15);
  if (coverKey !== null) file.coverKey = coverKey;
  const extractedText = readOptionalText(row, 'extracted_text', 16);
  if (extractedText !== null) file.extractedText = extractedText;
  const previewJson = readOptionalText(row, 'preview_json', 17);
  if (previewJson !== null) file.previewJson = previewJson;
  const ocrPagesJson = readOptionalText(row, 'ocr_pages_json', 18);
  if (ocrPagesJson !== null) file.ocrPagesJson = ocrPagesJson;
  const description = readOptionalText(row, 'description', 19);
  if (description !== null) file.description = description;
  const deletedAt = readOptionalText(row, 'deleted_at', 23);
  if (deletedAt !== null) file.deletedAt = deletedAt;
  const processingStatus = readOptionalText(row, 'processing_status', 24);
  if (processingStatus !== null) file.processingStatus = processingStatus;
  const processingProgress = readOptionalText(row, 'processing_progress', 25);
  if (processingProgress !== null) file.processingProgress = processingProgress;
  const processingError = readOptionalText(row, 'processing_error', 26);
  if (processingError !== null) file.processingError = processingError;
  const processingStartedAt = readOptionalInteger(row, 'processing_started_at', 27);
  if (processingStartedAt !== null) file.processingStartedAt = processingStartedAt;
  const processingCompletedAt = readOptionalInteger(row, 'processing_completed_at', 28);
  if (processingCompletedAt !== null) file.processingCompletedAt = processingCompletedAt;
  const compressedBlobHash = readOptionalText(row, 'compressed_blob_hash', 29);
  if (compressedBlobHash !== null) file.compressedBlobHash = compressedBlobHash;
  return file;
}

function mapRows(rows: readonly Row[]): VfsFile[] {
  const files: VfsFile[] = [];
  for (const row of rows) {
    try { files.push(rowToFile(row)); }
    catch (error) { logWarn('[VFS::FileRepo] Row parse error (skipped):', error); }
  }
  return files;
}

function withSavepoint<T>(conn: SqlExecutor, name: string, run: () => T): T {
  try { conn.exec(`SAVEPOINT ${name}`); }
  catch (error) {
    logError(`[VFS::FileRepo] Failed to create savepoint for ${name}:`, error);
    throw error;
  }
  try {
    const result = run();
    try { conn.exec(`RELEASE SAVEPOINT ${name}`); }
    catch (error) {
      logError(`[VFS::FileRepo] Failed to release savepoint ${name}:`, error);
      throw error;
    }
    return result;
  } catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`); }
    catch (rollbackError) { logWarn('[VFS::FileRepo] Savepoint rollback failed:', rollbackError); }
    throw error;
  }
}

function buildPreviewProgress(hasText: boolean): string {
  const readyModes = hasText ? '["text"]' : '[]';
  return `{"stage":"page_rendering","percent":25.0,"readyModes":${readyModes}}`;
}

export class FileRepo implements FileRepository {
  private readonly blobs = new BlobRepo();
  private readonly folders = new FolderRepo();

  createFile(conn: SqlExecutor, sha256: string, fileName: string, size: number, fileType: string,
    mimeType?: string | null, blobHash?: string | null, originalPath?: string | null): VfsFile {
    return databaseResult(() => {
      const existing = this.getBySha256(conn, sha256);
      if (existing !== null) {
        if (existing.status !== 'active') {
          const now = utcTimestamp();
          conn.run("UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            [now, existing.id]);
          const restored = this.getFile(conn, existing.id);
          if (restored === null) throw databaseMessage(`File ${existing.id} not found after restore`);
          return restored;
        }
        return existing;
      }

      return withSavepoint(conn, 'create_file', () => {
        const fileId = `file_${nanoid(10)}`;
        const now = utcTimestamp();
        const nowMs = Date.now();
        const resourceId = `res_${nanoid(10)}`;

        conn.run(`INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
          VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', 0, ?4, ?5)`,
        [resourceId, sha256, fileId, nowMs, nowMs]);

        conn.run(`INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size, "type", mime_type, tags_json, is_favorite, status, created_at, updated_at, processing_status, processing_progress, processing_error, processing_started_at, processing_completed_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '[]', 0, 'active', ?10, ?11, NULL, NULL, NULL, NULL, NULL)`,
        [fileId, resourceId, blobHash ?? null, sha256, fileName, originalPath ?? null, size, fileType,
          mimeType ?? null, now, now]);

        const file: VfsFile = {
          id: fileId, resourceId, sha256, fileName, size, fileType, tags: [], isFavorite: false,
          bookmarks: [], status: 'active', createdAt: now, updatedAt: now,
        };
        if (blobHash !== null && blobHash !== undefined) file.blobHash = blobHash;
        if (originalPath !== null && originalPath !== undefined) file.originalPath = originalPath;
        if (mimeType !== null && mimeType !== undefined) file.mimeType = mimeType;
        return file;
      });
    });
  }

  createFileInFolder(conn: SqlExecutor, sha256: string, fileName: string, size: number, fileType: string,
    mimeType: string | null, blobHash: string | null, originalPath: string | null, folderId: string | null): VfsFile {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        if (folderId !== null && !this.folders.folderExists(conn, folderId)) throw folderNotFound(folderId);
        const file = this.createFile(conn, sha256, fileName, size, fileType, mimeType, blobHash, originalPath);
        this.folders.addItemToFolder(conn, newFolderItem(folderId, 'file', file.id));
        conn.exec('COMMIT');
        return file;
      } catch (error) {
        try { conn.exec('ROLLBACK'); }
        catch (rollbackError) { logWarn('[VFS::FileRepo] Rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  copyFile(conn: SqlExecutor, srcFileId: string, newFileName: string): VfsFile {
    return databaseResult(() => {
      const src = this.getFile(conn, srcFileId);
      if (src === null) throw notFound(srcFileId);

      const processing = conn.get<{ processing_status: string | null; processing_progress: string | null }>(
        'SELECT processing_status, processing_progress FROM files WHERE id = ?1', [srcFileId]);
      const processingStatus = processing?.processing_status ?? null;
      const processingProgress = processing?.processing_progress ?? null;

      const sharedHashes: string[] = [];
      if (src.blobHash !== undefined) sharedHashes.push(src.blobHash);
      if (src.compressedBlobHash !== undefined && src.blobHash !== src.compressedBlobHash) {
        sharedHashes.push(src.compressedBlobHash);
      }
      if (src.previewJson !== undefined) {
        const preview = parsePdfPreviewJson(src.previewJson);
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

      try {
        return withSavepoint(conn, 'copy_file', () => {
          for (const hash of sharedHashes) this.blobs.incrementRef(conn, hash);

          const fileId = `file_${nanoid(10)}`;
          const now = utcTimestamp();
          const nowMs = Date.now();
          const resourceId = `res_${nanoid(10)}`;

          conn.run(`INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
            VALUES (?1, ?2, 'file', ?3, 'files', 'inline', ?4, 0, ?5, ?6)`,
          [resourceId, newSha256, fileId, src.extractedText ?? '', nowMs, nowMs]);

          conn.run(`INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size,
              page_count, "type", mime_type, tags_json, is_favorite, status,
              created_at, updated_at, preview_json, extracted_text, ocr_pages_json,
              compressed_blob_hash, processing_status, processing_progress)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '[]', 0, 'active', ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
          [fileId, resourceId, src.blobHash ?? null, newSha256, newFileName, src.originalPath ?? null,
            src.size, src.pageCount ?? null, src.fileType, src.mimeType ?? null, now, now,
            src.previewJson ?? null, src.extractedText ?? null, src.ocrPagesJson ?? null,
            src.compressedBlobHash ?? null, processingStatus, processingProgress]);

          const copied = this.getFile(conn, fileId);
          if (copied === null) throw databaseMessage(`File ${fileId} not found after copy`);
          return copied;
        });
      } catch (error) {
        logError(`[VFS::FileRepo] Failed to copy file ${srcFileId}:`, error);
        throw error;
      }
    });
  }

  createFileWithDocDataInFolder(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    fileType: string, mimeType: string | null, blobHash: string | null, originalPath: string | null,
    folderId: string | null, previewJson: string | null, extractedText: string | null,
    pageCount: number | null): VfsFile {
    return this.createFileWithDocDataInFolderOutcome(conn, sha256, fileName, size, fileType, mimeType,
      blobHash, originalPath, folderId, previewJson, extractedText, pageCount)[0];
  }

  createFileWithDocDataInFolderOutcome(conn: SqlExecutor, sha256: string, fileName: string, size: number,
    fileType: string, mimeType: string | null, blobHash: string | null, originalPath: string | null,
    folderId: string | null, previewJson: string | null, extractedText: string | null,
    pageCount: number | null): [VfsFile, boolean] {
    return databaseResult(() => withSavepoint(conn, 'create_file_doc', () => {
      // Acquire the write lock before folder/dedup reads so this deferred
      // SAVEPOINT cannot become a stale read snapshot while other uploads commit.
      conn.run('UPDATE files SET id = id WHERE 0');

      if (folderId !== null && !this.folders.folderExists(conn, folderId)) throw folderNotFound(folderId);

      const existing = this.getBySha256(conn, sha256);
      if (existing !== null) {
        const ensureFolderAssignment = (fileId: string): void => {
          this.folders.addItemToFolder(conn, newFolderItem(folderId, 'file', fileId));
        };

        if (existing.status !== 'active') {
          const now = utcTimestamp();
          conn.run("UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            [now, existing.id]);
          ensureFolderAssignment(existing.id);
          const restored = this.getFile(conn, existing.id);
          if (restored === null) throw databaseMessage(`File ${existing.id} not found after restore`);
          return [restored, false] as [VfsFile, boolean];
        }

        ensureFolderAssignment(existing.id);
        return [existing, false] as [VfsFile, boolean];
      }

      const fileId = `file_${nanoid(10)}`;
      const now = utcTimestamp();
      const nowMs = Date.now();
      const resourceId = `res_${nanoid(10)}`;

      conn.run(`INSERT INTO resources (id, hash, type, source_id, source_table, storage_mode, data, ref_count, created_at, updated_at)
        VALUES (?1, ?2, 'file', ?3, 'files', 'inline', '', 0, ?4, ?5)`,
      [resourceId, sha256, fileId, nowMs, nowMs]);

      const isPdf = mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
      let processingStatus: string | null = null;
      let processingProgress: string | null = null;
      let processingStartedAt: number | null = null;
      if (isPdf) {
        const hasText = extractedText !== null && extractedText.trim() !== '';
        processingStatus = 'page_rendering';
        processingProgress = buildPreviewProgress(hasText);
        processingStartedAt = nowMs;
      }

      conn.run(`INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path, size, "type", mime_type,
          tags_json, is_favorite, status, created_at, updated_at, preview_json, extracted_text, page_count,
          processing_status, processing_progress, processing_started_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '[]', 0, 'active', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      [fileId, resourceId, blobHash, sha256, fileName, originalPath, size, fileType, mimeType,
        now, now, previewJson, extractedText, pageCount, processingStatus, processingProgress, processingStartedAt]);

      this.folders.addItemToFolder(conn, newFolderItem(folderId, 'file', fileId));

      const file: VfsFile = {
        id: fileId, resourceId, sha256, fileName, size, fileType, tags: [], isFavorite: false,
        bookmarks: [], status: 'active', createdAt: now, updatedAt: now,
      };
      if (blobHash !== null) file.blobHash = blobHash;
      if (originalPath !== null) file.originalPath = originalPath;
      if (pageCount !== null) file.pageCount = pageCount;
      if (mimeType !== null) file.mimeType = mimeType;
      if (extractedText !== null) file.extractedText = extractedText;
      if (previewJson !== null) file.previewJson = previewJson;
      if (processingStatus !== null) file.processingStatus = processingStatus;
      if (processingProgress !== null) file.processingProgress = processingProgress;
      if (processingStartedAt !== null) file.processingStartedAt = processingStartedAt;
      return [file, true] as [VfsFile, boolean];
    }));
  }

  getBlobHashByFileOrResourceId(conn: SqlExecutor, sourceId: string): string | null {
    const value = conn.pluck<SqlValue>(`SELECT blob_hash FROM files WHERE id = ?1 OR resource_id = ?1
      ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1`, [sourceId]);
    return typeof value === 'string' ? value : null;
  }

  getFile(conn: SqlExecutor, fileId: string): VfsFile | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${FILE_COLUMNS} FROM files WHERE id = ?1`, [fileId]);
      return row === undefined ? null : rowToFile(row);
    });
  }

  getBySha256(conn: SqlExecutor, sha256: string): VfsFile | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${FILE_COLUMNS} FROM files WHERE sha256 = ?1`, [sha256]);
      return row === undefined ? null : rowToFile(row);
    });
  }

  listFiles(conn: SqlExecutor, limit: number, offset: number): VfsFile[] {
    return databaseResult(() => mapRows(conn.all(
      `SELECT ${FILE_COLUMNS} FROM files WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2`,
      [limit, offset])));
  }

  listFilesByFolder(conn: SqlExecutor, folderId: string | null, limit: number, offset: number): VfsFile[] {
    return databaseResult(() => mapRows(conn.all(
      `SELECT ${FILE_COLUMNS_PREFIXED}
       FROM files f
       JOIN folder_items fi ON fi.item_type = 'file' AND fi.item_id = f.id
       WHERE fi.folder_id IS ?1 AND f.status = 'active'
       ORDER BY fi.sort_order ASC, f.updated_at DESC
       LIMIT ?2 OFFSET ?3`,
      [folderId, limit, offset])));
  }

  listFilesByType(conn: SqlExecutor, fileType: string, limit: number, offset: number): VfsFile[] {
    return databaseResult(() => mapRows(conn.all(
      `SELECT ${FILE_COLUMNS} FROM files WHERE "type" = ?1 AND status = 'active'
       ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3`,
      [fileType, limit, offset])));
  }

  updateFileName(conn: SqlExecutor, fileId: string, newName: string): VfsFile {
    return databaseResult(() => {
      const now = utcTimestamp();
      const updated = conn.run('UPDATE files SET file_name = ?1, updated_at = ?2 WHERE id = ?3',
        [newName, now, fileId]).changes;
      if (updated === 0) throw notFound(fileId);
      const file = this.getFile(conn, fileId);
      if (file === null) throw notFound(fileId);
      return file;
    });
  }

  setFavorite(conn: SqlExecutor, fileId: string, favorite: boolean): void {
    databaseResult(() => {
      const now = utcTimestamp();
      conn.run('UPDATE files SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
        [favorite ? 1 : 0, now, fileId]);
    });
  }

  deleteFile(conn: SqlExecutor, fileId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const updated = conn.run(
        "UPDATE files SET status = 'deleted', deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'active'",
        [now, fileId]).changes;

      if (updated === 0) {
        const alreadyDeleted = Number(conn.pluck<number>(
          "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1 AND status = 'deleted')", [fileId]) ?? 0) !== 0;
        if (!alreadyDeleted) throw notFound(fileId);
      }

      const nowStr = utcTimestamp();
      const nowMs = Date.now();
      conn.run(
        "UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_type = 'file' AND item_id = ?3 AND deleted_at IS NULL",
        [nowStr, nowMs, fileId]);
    });
  }

  restoreFile(conn: SqlExecutor, fileId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const updated = conn.run(
        "UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND status = 'deleted'",
        [now, fileId]).changes;
      if (updated === 0) throw notFound(fileId);

      const nowMs = Date.now();
      conn.run(
        'UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_type = \'file\' AND item_id = ?2 AND deleted_at IS NOT NULL',
        [nowMs, fileId]);
    });
  }

  purgeFile(conn: SqlExecutor, blobsDir: string, fileId: string): void {
    databaseResult(() => {
      this.purgeFileWithConn(conn, fileId, blobsDir);
      try { this.blobs.cleanupUnreferenced(conn, blobsDir); }
      catch (error) { logWarn('[VFS::FileRepo] Post-purge blob sweep failed (will retry on next sweep):', error); }
    });
  }

  purgeFileWithConn(conn: SqlExecutor, fileId: string, _blobsDir?: string): void {
    databaseResult(() => {
      const file = this.getFile(conn, fileId);
      if (file === null) {
        logWarn(`[VFS::FileRepo] File not found in files table: ${fileId}, trying folder_items cleanup`);
        const fiDeleted = conn.run('DELETE FROM folder_items WHERE item_id = ?1', [fileId]).changes;
        if (fiDeleted > 0) return;
        throw notFound(fileId);
      }

      const resourceIdToDelete = file.resourceId;

      try { conn.exec('SAVEPOINT vfs_file_purge_tx'); }
      catch (error) {
        logError('[VFS::FileRepo] Failed to begin savepoint for purge:', error);
        throw databaseMessage(`Failed to begin savepoint: ${error instanceof Error ? error.message : String(error)}`);
      }
      conn.run('DELETE FROM folder_items WHERE item_id = ?1', [fileId]);

      if (file.blobHash !== undefined) {
        try { this.blobs.decrementRef(conn, file.blobHash); }
        catch (error) { logWarn(`[VFS::FileRepo] Failed to decrement blob ref ${file.blobHash}:`, error); }
      }

      if (file.compressedBlobHash !== undefined && file.blobHash !== file.compressedBlobHash) {
        try { this.blobs.decrementRef(conn, file.compressedBlobHash); }
        catch (error) {
          logWarn(`[VFS::FileRepo] Failed to decrement compressed blob ref ${file.compressedBlobHash}:`, error);
        }
      }

      if (file.previewJson !== undefined) {
        const preview = parsePdfPreviewJson(file.previewJson);
        if (preview !== null) {
          for (const page of preview.pages) {
            try { this.blobs.decrementRef(conn, page.blobHash); }
            catch (error) {
              logWarn(`[VFS::FileRepo] Failed to decrement PDF page blob ${page.blobHash}:`, error);
            }
            if (page.compressedBlobHash !== undefined && page.compressedBlobHash !== page.blobHash) {
              try { this.blobs.decrementRef(conn, page.compressedBlobHash); }
              catch (error) {
                logWarn(
                  `[VFS::FileRepo] Failed to decrement PDF compressed page blob ${page.compressedBlobHash}:`, error);
              }
            }
          }
        }
      }

      const deleted = conn.run('DELETE FROM files WHERE id = ?1', [fileId]).changes;
      if (deleted === 0) {
        logError(`[VFS::FileRepo] CRITICAL: File record disappeared during deletion: ${fileId}`);
        try { conn.exec('ROLLBACK TO SAVEPOINT vfs_file_purge_tx; RELEASE SAVEPOINT vfs_file_purge_tx;'); }
        catch (rollbackError) { logWarn('[VFS::FileRepo] Purge rollback failed:', rollbackError); }
        throw otherMessage(`File record disappeared during deletion: ${fileId}. This may indicate a race condition.`);
      }

      if (resourceIdToDelete !== undefined) {
        try { purgeIndexArtifactsByResource(conn, resourceIdToDelete); }
        catch (error) {
          this.failPurge(conn, 'Failed to delete index artifacts', error);
        }
        try { conn.run('DELETE FROM resources WHERE id = ?1', [resourceIdToDelete]); }
        catch (error) {
          this.failPurge(conn, 'Failed to delete resource', error);
        }
      }

      try { conn.exec('RELEASE SAVEPOINT vfs_file_purge_tx'); }
      catch (error) {
        logError('[VFS::FileRepo] Failed to release purge savepoint:', error);
        try { conn.exec('ROLLBACK TO SAVEPOINT vfs_file_purge_tx; RELEASE SAVEPOINT vfs_file_purge_tx;'); }
        catch (rollbackError) { logWarn('[VFS::FileRepo] Purge rollback failed:', rollbackError); }
        throw databaseMessage(`Failed to release savepoint: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private failPurge(conn: SqlExecutor, message: string, error: unknown): never {
    logError(`[VFS::FileRepo] ${message}:`, error);
    try { conn.exec('ROLLBACK TO SAVEPOINT vfs_file_purge_tx; RELEASE SAVEPOINT vfs_file_purge_tx;'); }
    catch (rollbackError) { logWarn('[VFS::FileRepo] Purge rollback failed:', rollbackError); }
    const detail = error instanceof Error ? error.message : String(error);
    throw databaseMessage(`${message}: ${detail}`);
  }

  listDeletedFiles(conn: SqlExecutor, limit: number, offset: number): VfsFile[] {
    return databaseResult(() => mapRows(conn.all(
      `SELECT ${FILE_COLUMNS} FROM files
       WHERE status = 'deleted' AND id NOT LIKE 'tb_%'
       ORDER BY deleted_at DESC LIMIT ?1 OFFSET ?2`,
      [limit, offset])));
  }

  getContent(conn: SqlExecutor, blobsDir: string, fileId: string): string | null {
    return databaseResult(() => {
      const file = this.getFile(conn, fileId);
      if (file === null) return null;

      if (file.fileType === 'image' && file.compressedBlobHash !== undefined) {
        const blobPath = this.blobs.getBlobPath(conn, blobsDir, file.compressedBlobHash);
        if (blobPath !== null) {
          let data: Uint8Array;
          try { data = vfsReposLocalRuntime().readFile(blobPath); }
          catch (error) {
            throw ioMessage(`Failed to read compressed blob file: ${error instanceof Error ? error.message : String(error)}`);
          }
          return toBase64(data);
        }
        logWarn(`[VFS::FileRepo] Compressed blob not found for image ${fileId}: ${file.compressedBlobHash}`);
      }

      if (file.resourceId !== undefined) {
        const row = conn.get<{ data: string | null }>('SELECT data FROM resources WHERE id = ?1', [file.resourceId]);
        const data = row === undefined ? null : row.data;
        if (data !== null && data !== '') return data;
      }

      if (file.blobHash !== undefined) {
        const blobPath = this.blobs.getBlobPath(conn, blobsDir, file.blobHash);
        if (blobPath !== null) {
          let data: Uint8Array;
          try { data = vfsReposLocalRuntime().readFile(blobPath); }
          catch (error) {
            throw ioMessage(`Failed to read blob file: ${error instanceof Error ? error.message : String(error)}`);
          }
          return toBase64(data);
        }
        logWarn(`[VFS::FileRepo] Blob not found for file ${fileId}: ${file.blobHash}`);
      }

      if (file.originalPath !== undefined) {
        if (isVirtualUri(file.originalPath)) {
          logWarn(`[VFS::FileRepo] original_path is a virtual URI, skipping read: ${file.originalPath}`);
        } else if (vfsReposLocalRuntime().exists(file.originalPath)) {
          try { return toBase64(vfsReposLocalRuntime().readFile(file.originalPath)); }
          catch (error) { logWarn('[VFS::FileRepo] Failed to read original_path:', error); }
        } else {
          logWarn(`[VFS::FileRepo] original_path does not exist: ${file.originalPath}`);
        }
      }

      logWarn(`[VFS::FileRepo] File ${fileId} has no valid content source (resource_id empty, no blob_hash, original_path not accessible)`);
      return null;
    });
  }

  getOcrPages(conn: SqlExecutor, fileId: string): (string | null)[] {
    return databaseResult(() => {
      const ocrJson = conn.pluck<string | null>('SELECT ocr_pages_json FROM files WHERE id = ?1', [fileId]) ?? null;
      return ocrJson === null ? [] : parseOcrPagesJson(ocrJson);
    });
  }

  getPageOcr(conn: SqlExecutor, fileId: string, pageIndex: number): string | null {
    const pages = this.getOcrPages(conn, fileId);
    return pages[pageIndex] ?? null;
  }

  savePageOcr(conn: SqlExecutor, fileId: string, pageIndex: number, ocrText: string): void {
    databaseResult(() => {
      const pages = this.getOcrPages(conn, fileId);
      while (pages.length <= pageIndex) pages.push(null);
      pages[pageIndex] = ocrText;
      const json = serializeOcrPages(pages);
      const now = utcTimestamp();
      conn.run('UPDATE files SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3', [json, now, fileId]);
    });
  }

  updatePdfExtractedText(conn: SqlExecutor, fileId: string, extractedText: string,
    pageCount: number | null): void {
    databaseResult(() => {
      conn.run(
        `UPDATE files SET extracted_text = ?1, page_count = ?2, updated_at = datetime('now')
         WHERE id = ?3`,
        [extractedText, pageCount, fileId]);
    });
  }

  updatePdfPreview(conn: SqlExecutor, fileId: string, previewJson: string,
    pageCount: number): void {
    databaseResult(() => {
      conn.run(
        `UPDATE files SET preview_json = ?1, page_count = ?2, updated_at = datetime('now')
         WHERE id = ?3`,
        [previewJson, pageCount, fileId]);
    });
  }

  updatePdfPreviewOnly(conn: SqlExecutor, fileId: string, previewJson: string): void {
    databaseResult(() => {
      conn.run(
        "UPDATE files SET preview_json = ?1, updated_at = datetime('now') WHERE id = ?2",
        [previewJson, fileId]);
    });
  }

  updatePdfOcrPages(conn: SqlExecutor, fileId: string, ocrPagesJson: string): void {
    databaseResult(() => {
      conn.run(
        "UPDATE files SET ocr_pages_json = ?1, updated_at = datetime('now') WHERE id = ?2",
        [ocrPagesJson, fileId]);
    });
  }

  setUploadOcrPagesWithConn(conn: SqlExecutor, fileId: string, ocrPagesJson: string): void {
    conn.run('UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2', [ocrPagesJson, fileId]);
  }

  /** pipeline.rs:336-339 / bilibili.rs:1011-1014,1044-1047; extracted_text only. */
  setMediaExtractedTextWithConn(conn: SqlExecutor, fileId: string, text: string | null): void {
    conn.run('UPDATE files SET extracted_text = ?1 WHERE id = ?2', [text, fileId]);
  }

  updateCompressedBlobHash(conn: SqlExecutor, fileId: string, blobHash: string): void {
    databaseResult(() => {
      conn.run(
        "UPDATE files SET compressed_blob_hash = ?1, updated_at = datetime('now') WHERE id = ?2",
        [blobHash, fileId]);
    });
  }

  cancelProcessing(conn: SqlExecutor, fileId: string): number {
    return databaseResult(() => conn.run(
      `UPDATE files
       SET processing_status = 'cancelled', processing_error = NULL
       WHERE id = ?1 AND processing_status IN ('queued','decode','vad','asr','indexing','pending')`,
      [fileId]).changes);
  }

  markProcessingRecovered(conn: SqlExecutor, fileId: string): number {
    return databaseResult(() => conn.run(
      `UPDATE files
       SET processing_status = 'pending',
           processing_error = 'recovered: interrupted by app restart'
       WHERE id = ?1`,
      [fileId]).changes);
  }

  setProcessingError(conn: SqlExecutor, fileId: string, error: string,
    completedAt: number): void {
    databaseResult(() => {
      conn.run(
        `UPDATE files
         SET processing_status = 'error',
             processing_error = ?1,
             processing_completed_at = ?2
         WHERE id = ?3`,
        [error, completedAt, fileId]);
    });
  }

  updateProcessingProgress(conn: SqlExecutor, fileId: string, progressJson: string): void {
    databaseResult(() => {
      conn.run(
        'UPDATE files SET processing_progress = ?1 WHERE id = ?2',
        [progressJson, fileId]);
    });
  }

  applyProcessingStatus(conn: SqlExecutor, fileId: string, stage: string,
    progressJson: string | null, completedAt: number | null, now: number,
    issueSummary: string | null): void {
    databaseResult(() => {
      // G2: processing writes deliberately never touch business `updated_at`
      // (pdf_processing_service.rs:2766-2840).
      if (stage === 'completed') {
        conn.run(
          `UPDATE files SET processing_status = ?1, processing_progress = ?2,
                  processing_completed_at = ?3, processing_error = NULL WHERE id = ?4`,
          [stage, progressJson, completedAt ?? now, fileId]);
      } else if (stage === 'completed_with_issues') {
        conn.run(
          `UPDATE files SET processing_status = ?1, processing_progress = ?2,
                  processing_completed_at = ?3, processing_error = COALESCE(?4, processing_error)
           WHERE id = ?5`,
          [stage, progressJson, completedAt ?? now, issueSummary, fileId]);
      } else if (stage === 'error') {
        conn.run(
          'UPDATE files SET processing_status = ?1, processing_progress = ?2 WHERE id = ?3',
          [stage, progressJson, fileId]);
      } else {
        conn.run(
          `UPDATE files SET processing_status = ?1, processing_progress = ?2,
                  processing_started_at = COALESCE(processing_started_at, ?3)
           WHERE id = ?4`,
          [stage, progressJson, now, fileId]);
      }
    });
  }

  applyMultimodalIndexState(conn: SqlExecutor, fileId: string, state: string,
    indexedPagesJsonOrError: string | null): void {
    databaseResult(() => {
      // multimodal_service.rs:1631-1644: only `indexed` stores pages, only
      // `failed` stores the error, and every branch bumps `updated_at`.
      const now = utcTimestamp();
      if (state === 'indexed') {
        conn.run(
          'UPDATE files SET mm_index_state = ?1, mm_indexed_pages_json = ?2, updated_at = ?3 WHERE id = ?4',
          [state, indexedPagesJsonOrError, now, fileId]);
      } else if (state === 'failed') {
        conn.run(
          'UPDATE files SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4',
          [state, indexedPagesJsonOrError, now, fileId]);
      } else {
        conn.run(
          'UPDATE files SET mm_index_state = ?1, updated_at = ?2 WHERE id = ?3',
          [state, now, fileId]);
      }
    });
  }

  purgeDeletedFiles(conn: SqlExecutor, blobsDir: string): number {
    return databaseResult(() => {
      const fileIds = conn.all<{ id: string }>(
        "SELECT id FROM files WHERE status = 'deleted' AND id NOT LIKE 'tb_%'").map(row => row.id);
      for (const fileId of fileIds) this.purgeFileWithConn(conn, fileId, blobsDir);
      try { this.blobs.cleanupUnreferenced(conn, blobsDir); }
      catch (error) {
        logWarn('[VFS::FileRepo] Post-batch-purge blob sweep failed (will retry on next sweep):', error);
      }
      return fileIds.length;
    });
  }

  fileExists(conn: SqlExecutor, fileId: string): boolean {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)', [fileId]) ?? 0) !== 0);
  }

  ensureFileForBlobWithConn(conn: SqlExecutor, blobHash: string, fileName: string, mime: string): string {
    let existing: string | null = null;
    try {
      existing = conn.pluck<string | null>(
        'SELECT id FROM files WHERE blob_hash = ?1 AND deleted_at IS NULL LIMIT 1', [blobHash]) ?? null;
    } catch { // boundary-allow empty-catch: question_import_service.rs:3774-3782 `.optional().ok().flatten()` 无日志，查询失败按未命中。
      existing = null;
    }
    if (existing !== null) return existing;

    const fileId = `file_${nanoid(12)}`;
    const now = utcTimestamp();
    // RUST-FIX(RF-W10-ensure-file-for-blob-sha256): Rust omits the NOT NULL UNIQUE sha256 column, so OR IGNORE drops the row and the returned id dangles; the blob hash is the content SHA-256.
    const inserted = conn.run(
      `INSERT OR IGNORE INTO files (id, sha256, blob_hash, file_name, original_path, size, "type", mime_type, tags_json, is_favorite, status, created_at, updated_at)
           VALUES (?1, ?2, ?2, ?3, '', 0, 'image', ?4, '[]', 0, 'active', ?5, ?6)`,
      [fileId, blobHash, fileName, mime, now, now]).changes;
    if (inserted !== 0) return fileId;
    // Same content already owned by a soft-deleted row: restore it like `create_file`'s sha256 dedupe.
    const owner = conn.pluck<string | null>('SELECT id FROM files WHERE sha256 = ?1', [blobHash]) ?? null;
    if (owner === null) return fileId;
    conn.run("UPDATE files SET status = 'active', deleted_at = NULL, updated_at = ?1 WHERE id = ?2", [now, owner]);
    return owner;
  }

  getResourceIdByFileId(conn: SqlExecutor, fileId: string): string | null {
    return databaseResult(() => conn.pluck<string | null>(
      'SELECT resource_id FROM files WHERE id = ?1', [fileId]) ?? null);
  }
}
