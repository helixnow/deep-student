/** Port of dstu-vfs attachment_repo.rs. All DB functions take the caller's connection. */
import { logError, logWarn } from './logger.ts';
import { fromBase64, toBase64 } from '../../../platform/crypto/encoding.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { posix, win32 } from '../../../platform/util/path.ts';
import { vfsReposLocalRuntime, type LocalReadHandle } from '../src/local-runtime.ts';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type AttachmentProcessingAdapter,
  type AttachmentRepository,
  type JsonValue,
  type VfsAttachment,
  type VfsAttachmentContentSource,
  type VfsUploadAttachmentParams,
  type VfsUploadAttachmentResult,
} from '../api.ts';
import {
  ATTACHMENT_COLUMNS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
  NATIVE_ATTACHMENT_PATHS,
  databaseMessage,
  errorMessage,
  internalMessage,
  inferExtension,
  invalidArgument,
  ioError,
  isInside,
  isPlainTextCodeExtension,
  isProbablyBase64,
  isVirtualUri,
  looksLikePath,
  normalizeExtension,
  notFound,
  optionalText,
  parsePdfPreview,
  retainsAsset,
  rowToAttachment,
  rustIsAbsolute,
  rustParent,
  serializationMessage,
  validateArchiveContent,
  type AttachmentPathPlatform,
} from './attachment-utils.ts';
import { AttachmentUploadPipeline } from './attachment-upload.ts';
import { BlobRepo } from './blobs.ts';
import { databaseResult, rollbackIgnoringFailure } from './errors.ts';
import { FolderRepo } from './folders.ts';
import { idAliasRepository } from './id-alias.ts';
import { purgeIndexArtifactsByResource } from './index-artifacts.ts';
import { parseOcrPagesJson, serializeOcrPages } from './ocr-utils.ts';
import { ResourceRepo } from './resources.ts';
import { utcTimestamp } from './timestamps.ts';


export class AttachmentRepo implements AttachmentRepository {
  private readonly blobs = new BlobRepo();
  private readonly folders = new FolderRepo();
  private readonly resources = new ResourceRepo();

  private readonly processing: AttachmentProcessingAdapter | null;
  private readonly upload: AttachmentUploadPipeline;
  private readonly paths: AttachmentPathPlatform;

  constructor(processing: AttachmentProcessingAdapter | null = null, paths: AttachmentPathPlatform = NATIVE_ATTACHMENT_PATHS) {
    this.processing = processing;
    this.paths = paths;
    this.upload = new AttachmentUploadPipeline({
      blobs: this.blobs,
      folders: this.folders,
      resources: this.resources,
      processing,
      validateUploadType: (name, mimeType) => this.validateUploadType(name, mimeType),
      validateUploadSize: (mimeType, size) => this.validateUploadSize(mimeType, size),
      validateAttachmentType: (explicit, mimeType) => this.validateAttachmentType(explicit, mimeType),
      maxUploadSizeBytes: (mimeType) => this.maxUploadSizeBytes(mimeType),
      decodeBase64Bounded: (input, maxBytes) => this.decodeBase64Bounded(input, maxBytes),
      computeHash: (data) => this.computeHash(data),
      inferTypeFromMime: (mimeType) => this.inferTypeFromMime(mimeType),
      getByHash: (conn, contentHash) => this.getByHash(conn, contentHash),
      getById: (conn, id) => this.getById(conn, id),
      getProcessingStatus: (conn, attachmentId) => this.getProcessingStatus(conn, attachmentId),
      restoreAndRenameWithConn: (conn, id, newName) => this.restoreAndRenameWithConn(conn, id, newName),
    });
  }

  maxUploadSizeBytes(mimeType: string): number {
    return mimeType.trim().toLowerCase().startsWith('image/') ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  }

  isSupportedUploadType(name: string, mimeType: string): boolean {
    const normalizedMime = mimeType.trim().toLowerCase();
    if (normalizedMime === '') return false;
    if (SUPPORTED_MIME_TYPES.includes(normalizedMime)) return true;
    const ext = normalizeExtension(name);
    return ext !== null && (SUPPORTED_EXTENSIONS.includes(ext) || isPlainTextCodeExtension(ext));
  }

  private validateUploadType(name: string, mimeType: string): void {
    if (name.trim() === '') throw invalidArgument('name', 'File name is required');
    if (!this.isSupportedUploadType(name, mimeType)) {
      const ext = normalizeExtension(name);
      const extDisplay = ext === null ? '(无扩展名)' : `.${ext}`;
      throw invalidArgument('mime_type',
        `UNSUPPORTED_FILE_TYPE: 不支持的文件类型 ${extDisplay} (文件: ${name}, MIME: ${mimeType})`);
    }
  }

  private validateUploadSize(mimeType: string, size: number): void {
    const maxSize = this.maxUploadSizeBytes(mimeType);
    if (size > maxSize) {
      const maxMb = Math.trunc(maxSize / (1024 * 1024));
      const actualMb = size / (1024 * 1024);
      throw invalidArgument('base64_content', `File too large: max ${maxMb}MB, got ${actualMb.toFixed(2)}MB`);
    }
  }

  private validateAttachmentType(explicit: string | null | undefined, mimeType: string): void {
    if (explicit === null || explicit === undefined) return;
    if (explicit !== 'image' && explicit !== 'file') {
      throw invalidArgument('attachment_type', `Invalid attachment_type: ${explicit}`);
    }
    const isImage = mimeType.trim().toLowerCase().startsWith('image/');
    if (explicit === 'image' && !isImage) {
      throw invalidArgument('attachment_type', `attachment_type=image but mime_type=${mimeType}`);
    }
    if (explicit === 'file' && isImage) {
      throw invalidArgument('attachment_type', `attachment_type=file but mime_type=${mimeType}`);
    }
  }

  isSafeOriginalPath(blobsDir: string, path: string): boolean {
    const trimmed = path.trim();
    if (trimmed === '') return false;
    const { path: api, canonicalize } = this.paths;

    const canonicalPath = canonicalize(trimmed);
    if (canonicalPath !== null) {
      const canonicalBlobs = canonicalize(blobsDir);
      if (canonicalBlobs === null) return false;
      if (isInside(canonicalPath, canonicalBlobs, api)) return true;
      const slotRoot = rustParent(canonicalBlobs, api);
      return slotRoot !== null && isInside(canonicalPath, slotRoot, api);
    }

    const parent = rustParent(trimmed, api);
    const canonicalParent = parent === null || parent === '' ? null : canonicalize(parent);
    if (canonicalParent !== null) {
      const canonicalBlobs = canonicalize(blobsDir);
      if (canonicalBlobs !== null) {
        if (isInside(canonicalParent, canonicalBlobs, api)) return true;
        const slotRoot = rustParent(canonicalBlobs, api);
        if (slotRoot !== null) {
          if (isInside(canonicalParent, api.join(slotRoot, 'textbooks'), api)) return true;
          if (isInside(canonicalParent, slotRoot, api)) return true;
        }
      }
    }
    return false;
  }

  buildOriginalPathCandidates(blobsDir: string, rawPath: string): string[] {
    const trimmed = rawPath.trim();
    if (trimmed === '') return [];
    if (isVirtualUri(trimmed)) return [];
    const api = this.paths.path;
    const slotRoot = rustParent(blobsDir, api);

    const candidates: string[] = [];
    const nativeAbsolute = rustIsAbsolute(trimmed, api);
    // RUST-FIX(RF-W07-attachment-foreign-original-path): Rust only remaps host-flavour absolute paths,
    // so a Windows original_path restored on macOS/Linux (or the reverse) never reaches the remap its own comment documents.
    const foreignAbsolute = !nativeAbsolute && (rustIsAbsolute(trimmed, posix) || rustIsAbsolute(trimmed, win32));
    if (nativeAbsolute || foreignAbsolute) {
      if (nativeAbsolute) candidates.push(trimmed);
      const relative = this.extractRelativeFromSlotPath(trimmed);
      if (slotRoot !== null && relative !== null) {
        const remapped = api.join(slotRoot, relative);
        if (!candidates.includes(remapped)) candidates.push(remapped);
      }
      return candidates;
    }

    if (slotRoot !== null) candidates.push(api.join(slotRoot, trimmed));
    candidates.push(api.join(blobsDir, trimmed));
    return [...new Set(candidates)];
  }

  extractRelativeFromSlotPath(path: string): string | null {
    const normalized = path.replaceAll('\\', '/');
    const marker = '/slots/';
    const slotsIndex = normalized.indexOf(marker);
    if (slotsIndex < 0) return null;
    const afterSlots = normalized.slice(slotsIndex + marker.length);
    const slotEnd = afterSlots.indexOf('/');
    if (slotEnd < 0) return null;
    const relative = afterSlots.slice(slotEnd + 1);
    return relative === '' ? null : relative;
  }

  resolveOriginalPath(blobsDir: string, id: string, rawPath: string): string | null {
    return this.tryResolveOriginalPath(blobsDir, id, rawPath);
  }

  private tryResolveOriginalPath(blobsDir: string, id: string, rawPath: string): string | null {
    for (const candidate of this.buildOriginalPathCandidates(blobsDir, rawPath)) {
      if (!this.isSafeOriginalPath(blobsDir, candidate)) {
        logWarn(`[VFS::AttachmentRepo] Blocked unsafe original_path for ${id}: ${candidate}`);
        continue;
      }
      if (!this.paths.isFile(candidate)) continue;
      return this.paths.canonicalize(candidate) ?? candidate;
    }
    return null;
  }

  readFileBounded(path: string, maxBytes: number): Uint8Array {
    let handle: LocalReadHandle;
    try { handle = vfsReposLocalRuntime().openRead(path); }
    catch (error) { throw ioError(`Failed to open attachment file: ${errorMessage(error)}`); }
    try {
      let declaredSize: number;
      try { declaredSize = Number(handle.size()); }
      catch (error) { throw ioError(`Failed to stat attachment file: ${errorMessage(error)}`); }
      if (declaredSize > maxBytes) {
        throw invalidArgument('attachment',
          `Attachment file too large: ${declaredSize} bytes exceeds ${maxBytes} bytes`);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const chunk = new Uint8Array(64 * 1024);
      while (total <= maxBytes) {
        const toRead = Math.min(chunk.length, maxBytes + 1 - total);
        if (toRead <= 0) break;
        let read: number;
        try { read = handle.read(toRead === chunk.length ? chunk : chunk.subarray(0, toRead)); }
        catch (error) { throw ioError(`Failed to read attachment file: ${errorMessage(error)}`); }
        if (read === 0) break;
        chunks.push(chunk.slice(0, read));
        total += read;
        if (total > maxBytes) {
          throw invalidArgument('attachment',
            `Attachment grew beyond the ${maxBytes} byte limit while reading`);
        }
      }
      const data = new Uint8Array(total);
      let offset = 0;
      for (const part of chunks) {
        data.set(part, offset);
        offset += part.length;
      }
      return data;
    } finally {
      handle.close();
    }
  }

  decodeBase64(input: string): Uint8Array {
    return this.decodeBase64Bounded(input, MAX_FILE_BYTES);
  }

  decodeBase64Bounded(input: string, maxBytes: number): Uint8Array {
    let base64: string;
    if (input.startsWith('data:')) {
      const parts = input.split(',');
      if (parts.length < 2) throw invalidArgument('base64', 'Invalid data URL format');
      base64 = parts[1]!;
    } else {
      base64 = input;
    }
    const groups = Math.floor((base64.length + 3) / 4);
    let padding = 0;
    for (let index = base64.length - 1; index >= 0 && padding < 2 && base64[index] === '='; index -= 1) {
      padding += 1;
    }
    const decodedUpperBound = groups * 3 - padding;
    if (decodedUpperBound > maxBytes) {
      throw invalidArgument('base64_content',
        `File too large: decoded base64 may exceed ${Math.trunc(maxBytes / (1024 * 1024))}MB`);
    }
    if (base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw invalidArgument('base64', 'Invalid base64: invalid symbol or padding');
    }
    const data = fromBase64(base64);
    if (data.length > maxBytes) {
      throw invalidArgument('base64_content', `File too large: ${data.length} bytes exceeds ${maxBytes} bytes`);
    }
    return new Uint8Array(data);
  }

  computeHash(data: Uint8Array): string {
    return sha256HexSync(data);
  }

  inferTypeFromMime(mimeType: string): string {
    return mimeType.startsWith('image/') ? 'image' : 'file';
  }

  inferExtension(mimeType: string, name: string): string | null {
    return inferExtension(mimeType, name);
  }

  isProbablyBase64(input: string): boolean {
    return isProbablyBase64(input);
  }

  validateArchiveContent(name: string, mimeType: string, data: Uint8Array): void {
    validateArchiveContent(name, mimeType, data);
  }

  getProcessingStatus(conn: SqlExecutor, attachmentId: string): [string | null, number | null, string[] | null] {
    return databaseResult(() => {
      let row: Row | undefined;
      try {
        row = conn.get<Row>('SELECT processing_status, processing_progress FROM files WHERE id = ?1', [attachmentId]);
      } catch (error) {
        logWarn(`[VFS::AttachmentRepo] Failed to get processing status for ${attachmentId}:`, error);
        return [null, null, null];
      }
      if (row === undefined) return [null, null, null];
      const status = optionalText(row.processing_status);
      const progressJson = optionalText(row.processing_progress);
      if (progressJson === null) return [status, null, null];
      try {
        const progress = JSON.parse(progressJson) as JsonValue;
        if (progress === null || typeof progress !== 'object' || Array.isArray(progress)) {
          return [status, null, null];
        }
        const object = progress as Record<string, JsonValue>;
        const percent = typeof object.percent === 'number' ? object.percent : null;
        const modesValue = object.readyModes ?? object.ready_modes;
        const readyModes = Array.isArray(modesValue)
          ? modesValue.filter((value): value is string => typeof value === 'string')
          : null;
        return [status, percent, readyModes];
      } catch {
        return [status, null, null];
      }
    });
  }

  getById(conn: SqlExecutor, id: string): VfsAttachment | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${ATTACHMENT_COLUMNS} FROM files WHERE id = ?1`, [id]);
      return row === undefined ? null : rowToAttachment(row);
    });
  }

  resolveFileId(conn: SqlExecutor, rawId: string): string | null {
    return databaseResult(() => {
      const id = rawId.trim();
      if (!id.startsWith('res_')) return id;
      const fileByResource = (resourceId: string): string | null => {
        const value = conn.pluck<string>(
          'SELECT id FROM files WHERE resource_id = ?1 ORDER BY deleted_at IS NULL DESC LIMIT 1',
          [resourceId]);
        return value === undefined ? null : value;
      };
      const uploadFile = fileByResource(id);
      if (uploadFile !== null) return uploadFile;

      const sourceRow = conn.get<Row>('SELECT source_id FROM resources WHERE id = ?1', [id]);
      const rawSource = sourceRow === undefined ? null : optionalText(sourceRow.source_id);
      const sourceId = rawSource === null ? null : rawSource.trim();
      if (sourceId === null || sourceId === '' || sourceId === id) return null;

      const direct = conn.pluck<string>('SELECT id FROM files WHERE id = ?1', [sourceId]);
      if (direct !== undefined) return direct;
      const viaResource = fileByResource(sourceId);
      if (viaResource !== null) return viaResource;
      const fileLike = sourceId.startsWith('att_') || sourceId.startsWith('file_') || sourceId.startsWith('tb_');
      return fileLike ? sourceId : null;
    });
  }

  list(conn: SqlExecutor, typeFilter: string | null, limit: number, offset: number): VfsAttachment[] {
    return databaseResult(() => {
      const rows = typeFilter === null
        ? conn.all<Row>(`SELECT ${ATTACHMENT_COLUMNS} FROM files
            WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2`, [limit, offset])
        : conn.all<Row>(`SELECT ${ATTACHMENT_COLUMNS} FROM files
            WHERE type = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3`,
        [typeFilter, limit, offset]);
      return rows.map(rowToAttachment);
    });
  }

  getByHash(conn: SqlExecutor, contentHash: string): VfsAttachment | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${ATTACHMENT_COLUMNS} FROM files
        WHERE content_hash = ?1 ORDER BY deleted_at IS NULL DESC LIMIT 1`, [contentHash]);
      return row === undefined ? null : rowToAttachment(row);
    });
  }

  getInlineDataWithConn(conn: SqlExecutor, fileId: string): string | null {
    const row = conn.get<{ data: SqlValue }>(`SELECT COALESCE(r.data, '') AS data
      FROM files f
      LEFT JOIN resources r ON f.resource_id = r.id
      WHERE f.id = ?1 AND f.deleted_at IS NULL`, [fileId]);
    if (row === undefined) return null;
    // rusqlite `row.get::<String>` rejects non-TEXT values (e.g. BLOB data).
    if (typeof row.data !== 'string') {
      throw new VfsRepositoryError('VFS_STORAGE', `Invalid column type ${row.data === null ? 'Null' : typeof row.data === 'number' || typeof row.data === 'bigint' ? 'Integer' : 'Blob'} at index: 0, name: data`);
    }
    return row.data;
  }

  getContent(conn: SqlExecutor, blobsDir: string, id: string): string | null {
    return databaseResult(() => {
      const source = this.getContentSource(conn, blobsDir, id);
      if (source === null) return null;
      if (source.kind === 'base64') return source.data;
      return toBase64(this.readFileBounded(source.path, MAX_FILE_BYTES));
    });
  }

  getContentBounded(conn: SqlExecutor, blobsDir: string, id: string, maxBytes: number): string | null {
    return databaseResult(() => {
      const source = this.getContentSource(conn, blobsDir, id);
      if (source === null) return null;
      if (source.kind === 'base64') {
        const decodedUpperBound = Math.floor((source.data.trim().length * 3) / 4);
        if (decodedUpperBound > maxBytes) {
          throw invalidArgument('max_bytes',
            `attachment content exceeds preview limit: ${decodedUpperBound} > ${maxBytes} bytes`);
        }
        return source.data;
      }
      return toBase64(this.readFileBounded(source.path, maxBytes));
    });
  }

  getContentSource(conn: SqlExecutor, blobsDir: string, id: string): VfsAttachmentContentSource | null {
    return databaseResult(() => {
      let attachment = this.getById(conn, id);
      if (attachment === null) {
        const canonicalId = idAliasRepository.resolvePersistedIdAlias(conn, 'files', id);
        if (canonicalId === id) return null;
        attachment = this.getById(conn, canonicalId);
        if (attachment === null) return null;
      }
      const fileId = attachment.id;

      if (attachment.resourceId !== undefined) {
        const resourceRow = conn.get<Row>(
          'SELECT data, external_hash FROM resources WHERE id = ?1', [attachment.resourceId]);
        const data = resourceRow === undefined ? null : optionalText(resourceRow.data);
        const resourceExternalHash = resourceRow === undefined ? null : optionalText(resourceRow.external_hash);

        let shouldFallback = false;
        if (data === null) {
          logWarn(`[VFS::AttachmentRepo] resources.data is NULL for ${fileId}: resource_id=${attachment.resourceId}`);
          shouldFallback = true;
        } else {
          const trimmed = data.trim();
          if (trimmed === '') {
            logWarn(`[VFS::AttachmentRepo] resources.data is empty for ${fileId}: resource_id=${attachment.resourceId}`);
            shouldFallback = true;
          } else if (isProbablyBase64(trimmed)) {
            shouldFallback = false;
          } else if (looksLikePath(trimmed)) {
            logWarn(`[VFS::AttachmentRepo] resources.data looks like path for ${fileId}: resource_id=${attachment.resourceId}, len=${trimmed.length}`);
            shouldFallback = true;
          } else {
            logWarn(`[VFS::AttachmentRepo] resources.data is not valid base64 for ${fileId}: resource_id=${attachment.resourceId}, len=${trimmed.length}, first_chars=${JSON.stringify(trimmed.slice(0, 80))}`);
            shouldFallback = true;
          }
        }

        if (shouldFallback) {
          const originalPath = this.originalPathOf(conn, fileId);
          if (originalPath !== null) {
            const resolved = this.tryResolveOriginalPath(blobsDir, fileId, originalPath);
            if (resolved !== null) return { kind: 'file', path: resolved };
          }

          const blobHashes: string[] = [];
          if (attachment.blobHash !== undefined) blobHashes.push(attachment.blobHash);
          if (resourceExternalHash !== null && !blobHashes.includes(resourceExternalHash)) {
            blobHashes.push(resourceExternalHash);
          }
          for (const hash of blobHashes) {
            const blobPath = this.blobs.getBlobPath(conn, blobsDir, hash);
            if (blobPath === null) {
              logWarn(`[VFS::AttachmentRepo] Blob not found for attachment ${fileId}: ${hash}`);
              continue;
            }
            let isFile = false;
            try { isFile = vfsReposLocalRuntime().stat(blobPath).kind === 'file'; }
            catch { isFile = false; }
            if (isFile) return { kind: 'file', path: blobPath };
          }
          logWarn(`[VFS::AttachmentRepo] Fallback exhausted for ${fileId} (resource_id=${attachment.resourceId}), returning None`);
          return null;
        }
        return data === null ? null : { kind: 'base64', data };
      }

      if (attachment.blobHash !== undefined) {
        const blobPath = this.blobs.getBlobPath(conn, blobsDir, attachment.blobHash);
        if (blobPath === null) {
          logWarn(`[VFS::AttachmentRepo] Blob not found for attachment ${fileId}: ${attachment.blobHash}`);
          return null;
        }
        let isFile = false;
        try { isFile = vfsReposLocalRuntime().stat(blobPath).kind === 'file'; }
        catch { isFile = false; }
        if (!isFile) {
          logWarn(`[VFS::AttachmentRepo] Blob path is not a file for attachment ${fileId}: ${blobPath}`);
          return null;
        }
        return { kind: 'file', path: blobPath };
      }

      const originalPath = this.originalPathOf(conn, fileId);
      if (originalPath !== null) {
        const resolved = this.tryResolveOriginalPath(blobsDir, fileId, originalPath);
        if (resolved !== null) return { kind: 'file', path: resolved };
      }
      logWarn(`[VFS::AttachmentRepo] Attachment ${fileId} has no resource_id, blob_hash, or valid original_path`);
      return null;
    });
  }

  private originalPathOf(conn: SqlExecutor, id: string): string | null {
    const row = conn.get<Row>('SELECT original_path FROM files WHERE id = ?1', [id]);
    return row === undefined ? null : optionalText(row.original_path);
  }

  setFavorite(conn: SqlExecutor, attachmentId: string, favorite: boolean): void {
    databaseResult(() => {
      const updated = conn.run(
        'UPDATE files SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3',
        [favorite ? 1 : 0, utcTimestamp(), attachmentId]).changes;
      if (updated === 0) throw notFound('attachment', attachmentId);
    });
  }

  purgeAttachment(conn: SqlExecutor, blobsDir: string, id: string): void {
    databaseResult(() => {
      this.purgeAttachmentWithConn(conn, id);
      try { this.blobs.cleanupUnreferenced(conn, blobsDir); }
      catch (error) {
        logWarn('[VFS::AttachmentRepo] Post-purge blob sweep failed (will retry on next sweep):', error);
      }
    });
  }

  purgeAttachmentWithConn(conn: SqlExecutor, id: string): void {
    databaseResult(() => {
      if (retainsAsset(conn, id)) return;
      const attachment = this.getById(conn, id);
      if (attachment === null) {
        logWarn(`[VFS::AttachmentRepo] Attachment not found in attachments table: ${id}, trying folder_items cleanup`);
        const deleted = conn.run('DELETE FROM folder_items WHERE item_id = ?1', [id]).changes;
        if (deleted > 0) return;
        throw notFound('attachment', id);
      }

      try { conn.exec('SAVEPOINT vfs_attachment_purge_tx'); }
      catch (error) {
        logError('[VFS::AttachmentRepo] Failed to begin savepoint for purge:', error);
        throw databaseMessage(`Failed to begin savepoint: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        conn.run('DELETE FROM folder_items WHERE item_id = ?1', [id]);

        if (attachment.blobHash !== undefined) {
          try { this.blobs.decrementRef(conn, attachment.blobHash); }
          catch (error) {
            logWarn(`[VFS::AttachmentRepo] Failed to decrement blob ref ${attachment.blobHash}:`, error);
          }
        }

        if (attachment.previewJson !== undefined) {
          const preview = parsePdfPreview(attachment.previewJson);
          if (preview !== null) {
            for (const page of preview.pages) {
              try { this.blobs.decrementRef(conn, page.blobHash); }
              catch (error) {
                logWarn(`[VFS::AttachmentRepo] Failed to decrement PDF page blob ${page.blobHash}:`, error);
              }
            }
          }
        }

        const deleted = conn.run('DELETE FROM files WHERE id = ?1', [id]).changes;
        if (deleted === 0) {
          logError(`[VFS::AttachmentRepo] CRITICAL: Attachment record disappeared during deletion: ${id}`);
          rollbackIgnoringFailure(conn);
          throw internalMessage(`Attachment record disappeared during deletion: ${id}. This may indicate a race condition.`);
        }

        if (attachment.resourceId !== undefined) {
          try { purgeIndexArtifactsByResource(conn, attachment.resourceId); }
          catch (error) {
            logError('[VFS::AttachmentRepo] Failed to delete index artifacts:', error);
            rollbackIgnoringFailure(conn);
            throw databaseMessage(`Failed to delete index artifacts: ${error instanceof Error ? error.message : String(error)}`);
          }
          try { conn.run('DELETE FROM resources WHERE id = ?1', [attachment.resourceId]); }
          catch (error) {
            logError('[VFS::AttachmentRepo] Failed to delete resource:', error);
            rollbackIgnoringFailure(conn);
            throw databaseMessage(`Failed to delete resource: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        try { conn.exec('RELEASE SAVEPOINT vfs_attachment_purge_tx'); }
        catch (error) {
          logError('[VFS::AttachmentRepo] Failed to release purge savepoint:', error);
          throw error;
        }
      } catch (error) {
        try { conn.exec('ROLLBACK TO SAVEPOINT vfs_attachment_purge_tx; RELEASE SAVEPOINT vfs_attachment_purge_tx;'); }
        catch (rollbackError) { logWarn('[VFS::AttachmentRepo] Purge rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  deleteAttachment(conn: SqlExecutor, id: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      const updated = conn.run(
        "UPDATE files SET status = 'deleted', deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL AND status = 'active'",
        [now, id]).changes;
      if (updated === 0) {
        const exists = Number(conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)', [id]) ?? 0) !== 0;
        if (!exists) throw notFound('attachment', id);
      }
    });
  }

  restoreAttachment(conn: SqlExecutor, id: string): void {
    databaseResult(() => {
      const updated = conn.run(
        "UPDATE files SET deleted_at = NULL, status = 'active', updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL",
        [utcTimestamp(), id]).changes;
      if (updated === 0) {
        const exists = Number(conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)', [id]) ?? 0) !== 0;
        if (!exists) throw notFound('attachment', id);
      }
    });
  }

  private restoreAndRenameWithConn(conn: SqlExecutor, id: string, newName: string): void {
    const now = utcTimestamp();
    const updated = conn.run(
      "UPDATE files SET deleted_at = NULL, status = 'active', name = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NOT NULL",
      [newName, now, id]).changes;
    if (updated === 0) {
      const existsAndActive = Number(conn.pluck<number>(
        'SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1 AND deleted_at IS NULL)', [id]) ?? 0) !== 0;
      if (existsAndActive) {
        conn.run('UPDATE files SET name = ?1, updated_at = ?2 WHERE id = ?3', [newName, now, id]);
      } else {
        logError(`[VFS::AttachmentRepo] restore_and_rename failed: attachment ${id} not found or still deleted`);
        throw internalMessage(`Failed to restore attachment ${id}: concurrent modification or not found`);
      }
    }
  }

  listDeletedAttachments(conn: SqlExecutor, limit: number, offset: number): VfsAttachment[] {
    return databaseResult(() => conn.all<Row>(`SELECT ${ATTACHMENT_COLUMNS} FROM files
      WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?1 OFFSET ?2`, [limit, offset])
      .map(rowToAttachment));
  }

  purgeDeletedAttachments(conn: SqlExecutor, blobsDir: string): number {
    return databaseResult(() => {
      const deleted = this.listDeletedAttachments(conn, 1000, 0);
      for (const attachment of deleted) {
        try { this.purgeAttachmentWithConn(conn, attachment.id); }
        catch (error) {
          logWarn(`[VFS::AttachmentRepo] Failed to purge attachment ${attachment.id}:`, error);
        }
      }
      try { this.blobs.cleanupUnreferenced(conn, blobsDir); }
      catch (error) {
        logWarn('[VFS::AttachmentRepo] Post-batch-purge blob sweep failed (will retry on next sweep):', error);
      }
      return deleted.length;
    });
  }

  saveOcrPages(conn: SqlExecutor, attachmentId: string, ocrPages: readonly (string | null)[]): void {
    databaseResult(() => {
      let json: string;
      try { json = serializeOcrPages(ocrPages); }
      catch (error) { throw serializationMessage(errorMessage(error)); }
      const updated = conn.run(
        'UPDATE files SET ocr_pages_json = ?1, updated_at = ?2 WHERE id = ?3',
        [json, utcTimestamp(), attachmentId]).changes;
      if (updated === 0) throw notFound('attachment', attachmentId);
    });
  }

  savePageOcr(conn: SqlExecutor, attachmentId: string, pageIndex: number, ocrText: string): void {
    databaseResult(() => {
      const row = conn.get<Row>('SELECT ocr_pages_json FROM files WHERE id = ?1', [attachmentId]);
      const existing = row === undefined ? null : optionalText(row.ocr_pages_json);
      const pages = existing === null ? [] : parseOcrPagesJson(existing);
      while (pages.length <= pageIndex) pages.push(null);
      pages[pageIndex] = ocrText;
      this.saveOcrPages(conn, attachmentId, pages);
    });
  }

  getOcrPages(conn: SqlExecutor, attachmentId: string): (string | null)[] {
    return databaseResult(() => {
      const row = conn.get<Row>('SELECT ocr_pages_json FROM files WHERE id = ?1', [attachmentId]);
      const existing = row === undefined ? null : optionalText(row.ocr_pages_json);
      return existing === null ? [] : parseOcrPagesJson(existing);
    });
  }

  getPageOcr(conn: SqlExecutor, attachmentId: string, pageIndex: number): string | null {
    const pages = this.getOcrPages(conn, attachmentId);
    return pageIndex < pages.length ? pages[pageIndex] ?? null : null;
  }

  getMmIndexState(conn: SqlExecutor, attachmentId: string): string | null {
    return databaseResult(() => {
      const row = conn.get<Row>('SELECT mm_index_state FROM files WHERE id = ?1', [attachmentId]);
      return row === undefined ? null : optionalText(row.mm_index_state);
    });
  }

  setMmIndexState(conn: SqlExecutor, attachmentId: string, state: string, error: string | null): void {
    databaseResult(() => {
      const updated = conn.run(
        'UPDATE files SET mm_index_state = ?1, mm_index_error = ?2, updated_at = ?3 WHERE id = ?4',
        [state, error, utcTimestamp(), attachmentId]).changes;
      if (updated === 0) throw notFound('attachment', attachmentId);
    });
  }

  saveMmIndexedPages(conn: SqlExecutor, attachmentId: string, indexedPagesJson: string): void {
    databaseResult(() => {
      conn.run('UPDATE files SET mm_indexed_pages_json = ?1, updated_at = ?2 WHERE id = ?3',
        [indexedPagesJson, utcTimestamp(), attachmentId]);
    });
  }

  // ------------------------------------------------------------------ upload

  async uploadWithConn(conn: SqlExecutor, blobsDir: string,
    params: VfsUploadAttachmentParams): Promise<VfsUploadAttachmentResult> {
    return this.upload.uploadWithConn(conn, blobsDir, params);
  }

  async uploadBytesWithConn(conn: SqlExecutor, blobsDir: string,
    params: VfsUploadAttachmentParams, data: Uint8Array): Promise<VfsUploadAttachmentResult> {
    return this.upload.uploadBytesWithConn(conn, blobsDir, params, data);
  }

  async uploadWithFolderConn(conn: SqlExecutor, blobsDir: string,
    params: VfsUploadAttachmentParams, folderId: string | null): Promise<VfsUploadAttachmentResult> {
    return this.upload.uploadWithFolderConn(conn, blobsDir, params, folderId);
  }

  async uploadBytesWithFolderConn(conn: SqlExecutor, blobsDir: string,
    params: VfsUploadAttachmentParams, data: Uint8Array,
    folderId: string | null): Promise<VfsUploadAttachmentResult> {
    return this.upload.uploadBytesWithFolderConn(conn, blobsDir, params, data, folderId);
  }

  uploadMediaStreamFinalized(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams,
    chunks: Iterable<Uint8Array>, folderId: string | null,
    finalize?: (conn: SqlExecutor, result: VfsUploadAttachmentResult) => void): VfsUploadAttachmentResult {
    return this.upload.uploadMediaStreamFinalized(conn, blobsDir, params, chunks, folderId, finalize);
  }
}
