/** Upload/registration pipeline of attachment_repo.rs (upload_*_with_conn, media stream, PDF repair). */
import { logDebug, logError, logInfo, logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  AttachmentProcessingAdapter,
  StagedBlob,
  VfsAttachment,
  VfsFolderItem,
  VfsUploadAttachmentParams,
  VfsUploadAttachmentResult,
} from '../api.ts';
import {
  INLINE_SIZE_THRESHOLD,
  MAX_MEDIA_IMPORT_BYTES,
  type PreparedUpload,
  archiveKindFromExtension,
  archiveKindFromMime,
  buildZipManifestText,
  databaseMessage,
  errorMessage,
  extensionOf,
  inferExtension,
  internalMessage,
  invalidArgument,
  isPlainTextCodeExtension,
  isSqliteBusyError,
  notFound,
  optionalText,
  sleepSync,
  splitTextToPages,
  validateArchiveContent,
} from './attachment-utils.ts';
import { mediaKind } from '../src/media-kind.ts';
import type { BlobRepo } from './blobs.ts';
import { databaseResult } from './errors.ts';
import type { FolderRepo } from './folders.ts';
import { serializeOcrPages } from './ocr-utils.ts';
import { DEFAULT_PDF_PREVIEW_CONFIG } from './pdf-preview.ts';
import type { ResourceRepo } from './resources.ts';
import { utcTimestamp } from './timestamps.ts';

/** AttachmentRepo members the pipeline shares; validation and lookups stay in one place. */
/** Rust `text.len()` in text_len logs: UTF-8 bytes. */
const utf8Length = (text: string | null): number => (text === null ? 0 : utf8ByteLength(text));

/** `%PDF-` 的 ASCII 字节；`Buffer.from(x, 'latin1')` 的等价比较。 */
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

function startsWithPdfHeader(data: Uint8Array): boolean {
  if (data.length < PDF_HEADER.length) return false;
  return PDF_HEADER.every((byte, index) => data[index] === byte);
}

export interface AttachmentUploadHost {
  readonly blobs: BlobRepo;
  readonly folders: FolderRepo;
  readonly resources: ResourceRepo;
  readonly processing: AttachmentProcessingAdapter | null;
  validateUploadType(name: string, mimeType: string): void;
  validateUploadSize(mimeType: string, size: number): void;
  validateAttachmentType(explicit: string | null | undefined, mimeType: string): void;
  maxUploadSizeBytes(mimeType: string): number;
  decodeBase64Bounded(input: string, maxBytes: number): Uint8Array;
  computeHash(data: Uint8Array): string;
  inferTypeFromMime(mimeType: string): string;
  getByHash(conn: SqlExecutor, contentHash: string): VfsAttachment | null;
  getById(conn: SqlExecutor, id: string): VfsAttachment | null;
  getProcessingStatus(conn: SqlExecutor, attachmentId: string): [string | null, number | null, string[] | null];
  restoreAndRenameWithConn(conn: SqlExecutor, id: string, newName: string): void;
}

export class AttachmentUploadPipeline {
  private readonly host: AttachmentUploadHost;

  constructor(host: AttachmentUploadHost) {
    this.host = host;
  }

  private async prepareUpload(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams, data: Uint8Array): Promise<PreparedUpload> {
    this.host.validateUploadType(params.name, params.mimeType);
    this.host.validateAttachmentType(params.type, params.mimeType);
    this.host.validateUploadSize(params.mimeType, data.length);
    validateArchiveContent(params.name, params.mimeType, data);

    const isPdf = params.mimeType === 'application/pdf' || params.name.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      if (!startsWithPdfHeader(data)) {
        throw invalidArgument('content', '不是有效的 PDF 文档（缺少 PDF 文件头）');
      }
      try { this.host.processing?.checkPdfEncryption(data, params.name); }
      catch (error) { throw invalidArgument('content', errorMessage(error)); }
    }

    const contentHash = this.host.computeHash(data);
    logDebug(`[VFS::AttachmentRepo] Computed hash: ${contentHash} for file: ${params.name} (${data.length} bytes)`);
    const attachmentType = params.type ?? this.host.inferTypeFromMime(params.mimeType);

    // Rust 3.5: an existing active/deleted hash returns before PDF/text
    // rendering; only the stale-PDF repair branch renders here.
    const existing = this.host.getByHash(conn, contentHash);
    if (existing !== null) {
      if (existing.deletedAt === undefined) {
        const isExistingPdf = existing.mimeType === 'application/pdf'
          || existing.name.toLowerCase().endsWith('.pdf');
        const needsRepair = isExistingPdf && (existing.pageCount ?? 0) === 0
          && (existing.extractedText === undefined || existing.extractedText.trim() === '');
        if (needsRepair && this.host.processing !== null) {
          await this.repairExistingPdf(conn, blobsDir, data, existing);
        }
      }
      return {
        data, contentHash, attachmentType, isPdf,
        previewJson: null, extractedText: null, pageCount: null,
        pagedTextPages: null, pdfRenderError: null,
      };
    }

    let previewJson: string | null = null;
    let extractedText: string | null = null;
    let pageCount: number | null = null;
    let pagedTextPages: string[] | null = null;
    let pdfRenderError: string | null = null;

    if (isPdf) {
      if (this.host.processing === null) {
        throw internalMessage('PDF processing adapter not wired (pdfium/document parser unavailable in Host)');
      }
      logInfo(`[VFS::AttachmentRepo] PDF detected, triggering preview render: ${params.name}`);
      try {
        const result = await this.host.processing.renderPdf(conn, blobsDir, data, DEFAULT_PDF_PREVIEW_CONFIG);
        previewJson = result.previewJson === null ? null : JSON.stringify(result.previewJson);
        extractedText = result.extractedText;
        pageCount = result.pageCount;
        logInfo(`[VFS::AttachmentRepo] PDF preview rendered: ${result.pageCount} pages, `
          + `text_len=${utf8Length(result.extractedText)}, has_preview=${previewJson !== null}`);
      } catch (error) {
        logWarn('[VFS::AttachmentRepo] PDF preview failed, storing without preview:', error);
        pdfRenderError = `PDF 渲染失败，预览与文本提取不可用：${errorMessage(error)}。可尝试删除后重新导入，或检查 PDF 是否损坏/加密`;
      }
    } else {
      const extension = extensionOf(params.name);
      const isZipArchive = archiveKindFromExtension(params.name) === 'zip'
        || (archiveKindFromExtension(params.name) === null && archiveKindFromMime(params.mimeType) === 'zip');
      if (isZipArchive) {
        const manifest = this.host.processing !== null
          ? this.host.processing.buildZipManifest(params.name, data)
          : buildZipManifestText(params.name, data);
        if (manifest !== null) extractedText = manifest;
      } else if (extension !== null) {
        const supportedExtensions = ['docx', 'xlsx', 'xls', 'xlsb', 'ods', 'pptx', 'epub', 'rtf',
          'txt', 'md', 'markdown', 'html', 'htm', 'csv', 'json', 'xml'];
        const isParseable = supportedExtensions.includes(extension) || isPlainTextCodeExtension(extension);
        if (isParseable && this.host.processing !== null) {
          try {
            const pages = await this.host.processing.extractPagedText(params.name, data);
            if (pages !== null && pages.length > 0) {
              const joined = pages.join('\n\n').trim();
              if (joined !== '') {
                pagedTextPages = pages;
                extractedText = joined;
                pageCount = pages.length;
              }
            } else {
              const text = await this.host.processing.extractText(params.name, data);
              if (text !== null && text.trim() !== '') extractedText = text;
            }
          } catch (error) {
            logWarn(`[VFS::AttachmentRepo] Failed to extract text from ${params.name}:`, error);
          }
        }
      }
    }

    return {
      data,
      contentHash,
      attachmentType,
      isPdf,
      previewJson,
      extractedText,
      pageCount,
      pagedTextPages,
      pdfRenderError,
    };
  }

  async uploadWithConn(conn: SqlExecutor, blobsDir: string,
    params: VfsUploadAttachmentParams): Promise<VfsUploadAttachmentResult> {
    this.host.validateUploadType(params.name, params.mimeType);
    this.host.validateAttachmentType(params.type, params.mimeType);
    const maxBytes = this.host.maxUploadSizeBytes(params.mimeType);
    const data = this.host.decodeBase64Bounded(params.base64Content, maxBytes);
    return this.uploadBytesWithConn(conn, blobsDir, params, data);
  }

  async uploadBytesWithConn(conn: SqlExecutor, blobsDir: string,
    params: VfsUploadAttachmentParams, data: Uint8Array): Promise<VfsUploadAttachmentResult> {
    const prepared = await this.prepareUpload(conn, blobsDir, params, data);
    return databaseResult(() => this.registerPrepared(conn, blobsDir, params, prepared));
  }

  async uploadWithFolderConn(conn: SqlExecutor, blobsDir: string,
    params: VfsUploadAttachmentParams, folderId: string | null): Promise<VfsUploadAttachmentResult> {
    this.host.validateUploadType(params.name, params.mimeType);
    this.host.validateAttachmentType(params.type, params.mimeType);
    const maxBytes = this.host.maxUploadSizeBytes(params.mimeType);
    const data = this.host.decodeBase64Bounded(params.base64Content, maxBytes);
    return this.uploadBytesWithFolderConn(conn, blobsDir, params, data, folderId);
  }

  async uploadBytesWithFolderConn(conn: SqlExecutor, blobsDir: string,
    params: VfsUploadAttachmentParams, data: Uint8Array,
    folderId: string | null): Promise<VfsUploadAttachmentResult> {
    const prepared = await this.prepareUpload(conn, blobsDir, params, data);
    return databaseResult(() => {
      const busyRetries = 4;
      for (let attempt = 0; attempt < busyRetries; attempt += 1) {
        try {
          return this.uploadPreparedWithFolder(conn, blobsDir, params, prepared, folderId);
        } catch (error) {
          if (isSqliteBusyError(error) && attempt < busyRetries - 1) {
            const backoffMs = Math.min(80 * (2 ** Math.min(attempt, 6)), 1000);
            logWarn(`[VFS::AttachmentRepo] upload_with_folder busy (attempt ${attempt + 1}/${busyRetries}), retry in ${backoffMs}ms:`, error);
            sleepSync(backoffMs);
            continue;
          }
          throw error;
        }
      }
      throw databaseMessage('upload_with_folder retry exhausted due to SQLITE_BUSY');
    });
  }

  private uploadPreparedWithFolder(conn: SqlExecutor, blobsDir: string,
    params: VfsUploadAttachmentParams, prepared: PreparedUpload,
    folderId: string | null): VfsUploadAttachmentResult {
    try { conn.exec('SAVEPOINT upload_with_folder'); }
    catch (error) {
      logError('[VFS::AttachmentRepo] Failed to create savepoint for upload_with_folder:', error);
      throw databaseMessage(`Failed to create savepoint: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const result = this.registerPrepared(conn, blobsDir, params, prepared);
      const itemType = result.attachment.type === 'image' ? 'image' : 'file';
      const existing = this.host.folders.getFolderItemByItemId(conn, itemType, result.sourceId);
      if (existing === null) {
        const folderItem: VfsFolderItem = {
          id: `fi_${nanoid(10)}`,
          ...(folderId === null ? {} : { folderId }),
          itemType,
          itemId: result.sourceId,
          sortOrder: 0,
          createdAt: Date.now(),
        };
        this.host.folders.addItemToFolder(conn, folderItem);
      }
      try { conn.exec('RELEASE upload_with_folder'); }
      catch (error) {
        logError('[VFS::AttachmentRepo] Failed to release savepoint upload_with_folder:', error);
        throw databaseMessage(`Failed to release savepoint: ${error instanceof Error ? error.message : String(error)}`);
      }
      return result;
    } catch (error) {
      try { conn.exec('ROLLBACK TO upload_with_folder'); }
      catch (rollbackError) { logWarn('[VFS::AttachmentRepo] upload_with_folder rollback failed:', rollbackError); }
      try { conn.exec('RELEASE upload_with_folder'); }
      catch (releaseError) { logWarn('[VFS::AttachmentRepo] upload_with_folder release failed:', releaseError); }
      throw error;
    }
  }

  uploadMediaStreamFinalized(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams,
    chunks: Iterable<Uint8Array>, folderId: string | null,
    finalize?: (conn: SqlExecutor, result: VfsUploadAttachmentResult) => void): VfsUploadAttachmentResult {
    return databaseResult(() => {
      this.host.validateUploadType(params.name, params.mimeType);
      if (mediaKind(params.mimeType, params.name) === null) {
        throw invalidArgument('mime_type', `Not an audio/video file: ${params.name}`);
      }
      const staged = this.host.blobs.stageStream(blobsDir, chunks, MAX_MEDIA_IMPORT_BYTES);
      conn.exec('SAVEPOINT upload_media_stream');
      try {
        const result = this.registerStagedMedia(conn, blobsDir, params, staged, folderId);
        if (finalize !== undefined) finalize(conn, result);
        conn.exec('RELEASE upload_media_stream');
        return result;
      } catch (error) {
        try { conn.exec('ROLLBACK TO upload_media_stream'); }
        catch (rollbackError) { logWarn('[VFS::AttachmentRepo] upload_media_stream rollback failed:', rollbackError); }
        try { conn.exec('RELEASE upload_media_stream'); }
        catch (releaseError) { logWarn('[VFS::AttachmentRepo] upload_media_stream release failed:', releaseError); }
        throw error;
      }
    });
  }

  private registerStagedMedia(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams,
    staged: StagedBlob, folderId: string | null): VfsUploadAttachmentResult {
    const contentHash = staged.hash;
    const size = staged.size;
    const attachmentType = params.type ?? this.host.inferTypeFromMime(params.mimeType);

    let result: VfsUploadAttachmentResult;
    const existing = this.host.getByHash(conn, contentHash);
    if (existing !== null) {
      if (existing.deletedAt !== undefined) this.host.restoreAndRenameWithConn(conn, existing.id, params.name);
      const attachment = this.host.getById(conn, existing.id) ?? existing;
      result = {
        sourceId: attachment.id,
        resourceHash: attachment.contentHash,
        isNew: false,
        attachment,
      };
    } else {
      const extension = inferExtension(params.mimeType, params.name);
      const blob = this.host.blobs.storeStagedBlob(conn, blobsDir, staged, params.mimeType, extension);
      const metadata = {
        name: params.name,
        mimeType: params.mimeType,
        size,
      };
      const resource = this.host.resources.createOrReuseExternal(conn, 'file', blob.hash, blob.hash,
        null, null, metadata);
      const attachmentId = `att_${nanoid(10)}`;
      const now = utcTimestamp();
      conn.run(`INSERT INTO files (
          id, resource_id, blob_hash, type, name, mime_type, size,
          content_hash, sha256, file_name, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?5, ?9, ?9)`,
      [attachmentId, resource.resourceId, blob.hash, attachmentType, params.name,
        params.mimeType, size, contentHash, now]);
      conn.run("UPDATE resources SET source_id = ?1, source_table = 'files' WHERE id = ?2 AND source_id IS NULL",
        [attachmentId, resource.resourceId]);
      result = {
        sourceId: attachmentId,
        resourceHash: contentHash,
        isNew: true,
        attachment: {
          id: attachmentId,
          resourceId: resource.resourceId,
          blobHash: blob.hash,
          type: attachmentType,
          name: params.name,
          mimeType: params.mimeType,
          size,
          contentHash,
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        },
      };
    }

    const itemType = result.attachment.type === 'image' ? 'image' : 'file';
    if (this.host.folders.getFolderItemByItemId(conn, itemType, result.sourceId) === null) {
      const folderItem: VfsFolderItem = {
        id: `fi_${nanoid(10)}`,
        ...(folderId === null ? {} : { folderId }),
        itemType,
        itemId: result.sourceId,
        sortOrder: 0,
        createdAt: Date.now(),
      };
      this.host.folders.addItemToFolder(conn, folderItem);
    }
    return result;
  }

  /**
   * Rust `upload_bytes_with_conn` 的 stale-PDF repair 分支：命中同 hash 的未删除
   * PDF 且 `page_count=0`/无文本时重跑 `render_pdf_preview` 并回写。异步渲染在
   * 进入同步 SAVEPOINT 前完成；失败只 warn（Rust `if let Ok(result)`）。
   */
  private async repairExistingPdf(conn: SqlExecutor, blobsDir: string,
    data: Uint8Array, existing: VfsAttachment): Promise<void> {
    if (this.host.processing === null) return;
    logInfo(`[VFS::AttachmentRepo] Repairing stale PDF data for ${existing.id}: page_count=0, re-extracting`);
    try {
      const result = await this.host.processing.renderPdf(conn, blobsDir, data, DEFAULT_PDF_PREVIEW_CONFIG);
      const repairedPreview = result.previewJson === null ? null : JSON.stringify(result.previewJson);
      const repairedText = result.extractedText;
      const repairedPages = result.pageCount;
      const hasText = repairedText !== null && repairedText.trim() !== '';
      const readyModes = hasText ? ['text'] : [];
      const progress = JSON.stringify({ stage: 'page_compression', percent: 25, readyModes });
      conn.run(`UPDATE files SET preview_json = ?1, extracted_text = ?2, page_count = ?3,
          processing_status = 'page_compression', processing_progress = ?4 WHERE id = ?5`,
      [repairedPreview, repairedText, repairedPages, progress, existing.id]);
      logInfo(`[VFS::AttachmentRepo] Repaired PDF ${existing.id}: pages=${repairedPages}, `
        + `text_len=${utf8Length(repairedText)}`);
    } catch (error) {
      logWarn(`[VFS::AttachmentRepo] Failed to repair PDF ${existing.id}:`, error);
    }
  }

  private registerPrepared(conn: SqlExecutor, blobsDir: string, params: VfsUploadAttachmentParams,
    prepared: PreparedUpload): VfsUploadAttachmentResult {
    const { data, contentHash, attachmentType, isPdf, previewJson, extractedText, pageCount } = prepared;
    const size = data.length;

    const existing = this.host.getByHash(conn, contentHash);
    if (existing !== null) {
      if (existing.deletedAt === undefined) {
        const [status, percent, modes] = this.host.getProcessingStatus(conn, existing.id);
        logInfo(`[VFS::AttachmentRepo] Attachment already exists (active): ${contentHash} -> `
          + `${existing.id}, status=${status}, ready_modes=${JSON.stringify(modes)}`);
        return {
          sourceId: existing.id,
          resourceHash: existing.contentHash,
          isNew: false,
          attachment: this.host.getById(conn, existing.id) ?? existing,
          ...(status === null ? {} : { processingStatus: status }),
          ...(percent === null ? {} : { processingPercent: percent }),
          ...(modes === null ? {} : { readyModes: modes }),
        };
      }
      logInfo(`[VFS::AttachmentRepo] Restoring deleted attachment: ${existing.id} `
        + `(new name: ${params.name})`);
      this.host.restoreAndRenameWithConn(conn, existing.id, params.name);
      const restored = this.host.getById(conn, existing.id);
      if (restored === null) {
        throw internalMessage(`Restored attachment ${existing.id} not found after restore`);
      }
      return {
        sourceId: restored.id,
        resourceHash: restored.contentHash,
        isNew: false,
        attachment: restored,
      };
    }

    const [resourceId, blobHash] = size < INLINE_SIZE_THRESHOLD
      ? this.storeInline(conn, data, params, attachmentType)
      : this.storeExternal(conn, blobsDir, data, params);

    const now = utcTimestamp();
    const nowMs = Date.now();

    let processingStatus: string | null = null;
    let processingProgress: string | null = null;
    let processingStartedAt: number | null = null;
    if (isPdf) {
      const hasText = extractedText !== null && extractedText.trim() !== '';
      const readyModes = hasText ? ['text'] : [];
      processingStatus = prepared.pdfRenderError === null ? 'page_compression' : 'error';
      processingProgress = JSON.stringify(prepared.pdfRenderError === null
        ? { stage: 'page_compression', percent: 25, readyModes }
        : { stage: 'error', percent: 0, readyModes });
      processingStartedAt = nowMs;
    }

    const attachmentId = `att_${nanoid(10)}`;
    const affected = conn.run(`INSERT OR IGNORE INTO files (
        id, resource_id, blob_hash, type, name, mime_type, size,
        content_hash, sha256, file_name, created_at, updated_at,
        preview_json, extracted_text, page_count,
        processing_status, processing_progress, processing_started_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    [attachmentId, resourceId, blobHash, attachmentType, params.name, params.mimeType, size,
      contentHash, contentHash, params.name, now, now, previewJson, extractedText, pageCount,
      processingStatus, processingProgress, processingStartedAt]).changes;

    if (blobHash !== null && resourceId !== null) {
      try { conn.run('UPDATE files SET resource_id = COALESCE(resource_id, ?1) WHERE id = ?2', [resourceId, attachmentId]); }
      catch (error) { logWarn(`[VFS::AttachmentRepo] Failed to backfill resource_id for attachment ${attachmentId}:`, error); }
    }

    if (resourceId !== null) {
      try {
        conn.run("UPDATE resources SET source_id = ?1, source_table = 'files' WHERE id = ?2 AND source_id IS NULL",
          [attachmentId, resourceId]);
      } catch (error) { logWarn(`[VFS::AttachmentRepo] Failed to backfill source_id for resource ${resourceId}:`, error); }
    }

    if (resourceId !== null && extractedText !== null && extractedText.trim() !== '') {
      try { this.host.resources.saveOcrText(conn, resourceId, extractedText); }
      catch (error) { logWarn(`[VFS::AttachmentRepo] Failed to persist OCR text for resource ${resourceId}:`, error); }
    }

    let ocrPagesJson: string | null = null;
    if (isPdf && extractedText !== null && extractedText.trim() !== '') {
      const effectivePageCount = Math.max(pageCount ?? 0, 1);
      ocrPagesJson = serializeOcrPages(splitTextToPages(extractedText, effectivePageCount));
    } else if (!isPdf && prepared.pagedTextPages !== null) {
      ocrPagesJson = serializeOcrPages(prepared.pagedTextPages);
    }

    if (affected > 0) {
      if (ocrPagesJson !== null) {
        try { conn.run('UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2', [ocrPagesJson, attachmentId]); }
        catch (error) { logWarn(`[VFS::AttachmentRepo] Failed to write ocr_pages_json for ${attachmentId}:`, error); }
      }
      if (prepared.pdfRenderError !== null) {
        try { conn.run('UPDATE files SET processing_error = ?1 WHERE id = ?2', [prepared.pdfRenderError, attachmentId]); }
        catch (error) { logWarn(`[VFS::AttachmentRepo] Failed to write processing_error for ${attachmentId}:`, error); }
      }
      return {
        sourceId: attachmentId,
        resourceHash: contentHash,
        isNew: true,
        attachment: {
          id: attachmentId,
          ...(resourceId === null ? {} : { resourceId }),
          ...(blobHash === null ? {} : { blobHash }),
          type: attachmentType,
          name: params.name,
          mimeType: params.mimeType,
          size,
          contentHash,
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
          ...(previewJson === null ? {} : { previewJson }),
          ...(extractedText === null ? {} : { extractedText }),
          ...(pageCount === null ? {} : { pageCount }),
        },
      };
    }

    let collision = this.host.getByHash(conn, contentHash);
    for (let attempt = 0; collision === null && attempt < 7; attempt += 1) {
      sleepSync(30);
      collision = this.host.getByHash(conn, contentHash);
    }
    if (collision === null) {
      throw notFound('Attachment',
        `content_hash=${contentHash} (race condition edge case: should exist but not found)`);
    }
    if (ocrPagesJson !== null) {
      const row = conn.get<Row>('SELECT ocr_pages_json FROM files WHERE id = ?1', [collision.id]);
      const existingOcr = row === undefined ? null : optionalText(row.ocr_pages_json);
      if (existingOcr === null) {
        try { conn.run('UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2', [ocrPagesJson, collision.id]); }
        catch (error) { logWarn(`[VFS::AttachmentRepo] Failed to backfill ocr_pages_json for ${collision.id}:`, error); }
      }
    }
    return {
      sourceId: collision.id,
      resourceHash: collision.contentHash,
      isNew: false,
      attachment: collision,
    };
  }

  private storeInline(conn: SqlExecutor, data: Uint8Array, params: VfsUploadAttachmentParams,
    attachmentType: string): [string | null, string | null] {
    const base64Data = toBase64(data);
    const resourceType = attachmentType === 'image' ? 'image' : 'file';
    const result = this.host.resources.createOrReuse(conn, resourceType, base64Data, null, null, {
      name: params.name,
      mimeType: params.mimeType,
      size: data.length,
    });
    return [result.resourceId, null];
  }

  private storeExternal(conn: SqlExecutor, blobsDir: string, data: Uint8Array,
    params: VfsUploadAttachmentParams): [string | null, string | null] {
    const extension = inferExtension(params.mimeType, params.name);
    const blob = this.host.blobs.storeBlob(conn, blobsDir, data, params.mimeType, extension);
    const resourceType = (params.type ?? 'file') === 'image' ? 'image' : 'file';
    const result = this.host.resources.createOrReuseExternal(conn, resourceType, blob.hash, blob.hash,
      null, null, { name: params.name, mimeType: params.mimeType, size: data.length });
    return [result.resourceId, blob.hash];
  }
}
