/**
 * handlers.rs:1985-2712 `vfs_upload_file` / `upload_file_blocking` (TD-03 saga).
 *
 * Owner surfaces: L11 files/blobs/indexStates/attachments + `attachmentProcessing`
 * (pdf preview, document text, zip manifest), L12 `vfsUnitBuilder` and
 * `vfsIndex.pdf`, L18 `docs.isPlainTextCodeExtension`, F4 settings (`ocr.*`).
 * Saga primitives (`UploadSaga`, savepoint) are this lane's own.
 *
 * Thread semantics: Rust runs the body in `spawn_blocking`; this runs on the host
 * event loop with the async F7 renderer awaited before the savepoint (see SPEC).
 */
import type { Context } from '@deepseek-ai/cordis';
import { createWebCrypto } from '../../../platform/crypto/web.ts';
import { toHex } from '../../../platform/crypto/encoding.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { DEFAULT_PDF_PREVIEW_CONFIG, type AttachmentProcessingAdapter, type PdfPreviewJson, type VfsFile,
  type VfsReposService } from '../../vfs-repos/api.ts';
import type { PdfProcessingService, ProcessingStage, UnitBuilderService } from '../../vfs-index/api.ts';
import type { AttachmentConfig } from './attachment-config.ts';
import { VfsError } from './error.ts';
import type { ResourceCreatedHooks } from './resource-created-hooks.ts';
import type { UploadSaga } from './upload-saga.ts';
import { decodeStandardBase64, imageNeedsCompression, ownerMediaKind, pdfPreviewNeedsCompression,
  type MediaKindFn } from './upload-attachment.ts';

/** handlers.rs:1985-1995. */
export interface VfsUploadFileParams {
  name: string;
  mimeType: string;
  base64Content: string;
  fileType?: string | null;
  folderId?: string | null;
}
/** handlers.rs:2013-2022. */
export interface IndexStatus { queued: boolean; unitsCreated: number; message: string }
/** handlers.rs:2024-2045 (`skipReason` omitted when None). */
export interface OcrStatus {
  performed: boolean; skipReason?: string; successCount: number; failedCount: number;
  blobMissingCount: number; totalPages: number; allSuccess: boolean; message: string;
}
/** handlers.rs:1997-2010. */
export interface VfsUploadFileResult {
  file: VfsFile; sourceId: string; resourceHash: string; isNew: boolean;
  ocrStatus?: OcrStatus; indexStatus?: IndexStatus;
}

export interface SettingsReader { get(key: string): string | null }
export interface PlainTextCodeExtensions { isPlainTextCodeExtension(extension: string): boolean }

export interface FileUploadDeps {
  conn(): SqlExecutor;
  blobsDir(): string;
  repos: VfsReposService;
  attachmentConfig: AttachmentConfig;
  unitBuilder: UnitBuilderService;
  pdf: PdfProcessingService;
  hooks: ResourceCreatedHooks;
  createSaga(): UploadSaga;
  withSavepoint<T>(conn: SqlExecutor, name: string, work: () => T): T;
  /** F4 settings (`Database::get_setting`). */
  settings(): SettingsReader;
  /** L18 docs (`document_parser::is_plain_text_code_extension`). */
  docs(): PlainTextCodeExtensions;
  log: Context['logger'];
  mediaKind?: MediaKindFn;
}

export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const MIB = 1024 * 1024;
const DEFAULT_PDF_TEXT_THRESHOLD = 100;

/** L11 `vfsRepo.attachmentProcessing` (published in L11 0a3d703ad). */
export function ownerAttachmentProcessing(repos: VfsReposService): AttachmentProcessingAdapter {
  const processing = (repos as VfsReposService & { attachmentProcessing?: AttachmentProcessingAdapter | null }).attachmentProcessing;
  if (processing === undefined || processing === null) {
    throw new Error('L11 vfsRepo.attachmentProcessing 未发布（render_pdf_preview / DocumentParser 适配器）');
  }
  return processing;
}

/** types.rs:2006-2016 `VfsFile::infer_file_type`. */
export function inferFileType(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

/** handlers.rs:2051-2105 `OcrStrategyConfig::load_from_db`; read errors keep defaults (`if let Ok(Some(v))`). */
export function loadOcrStrategyConfig(settings: SettingsReader) {
  const config = { enabled: true, skipForMultimodal: false, pdfTextThreshold: DEFAULT_PDF_TEXT_THRESHOLD,
    ocrImages: true, ocrScannedPdf: true };
  const read = (key: string) => { try { return settings.get(key); } catch { return null; } };
  const enabled = read('ocr.enabled');
  if (enabled !== null) config.enabled = enabled.toLowerCase() === 'true';
  const skip = read('ocr.skip_for_multimodal');
  if (skip !== null) config.skipForMultimodal = skip.toLowerCase() === 'true';
  const threshold = read('ocr.pdf_text_threshold');
  // usize::from_str: ASCII digits with optional leading '+', no whitespace.
  if (threshold !== null && /^\+?[0-9]+$/.test(threshold)) {
    const n = Number(threshold.replace(/^\+/, ''));
    if (Number.isSafeInteger(n)) config.pdfTextThreshold = n;
  }
  const images = read('ocr.images');
  if (images !== null) config.ocrImages = images.toLowerCase() === 'true';
  const scanned = read('ocr.scanned_pdf');
  if (scanned !== null) config.ocrScannedPdf = scanned.toLowerCase() === 'true';
  return config;
}

/** Rust `{:.2}` for f64; `toFixed` rounds exact ties up where Rust rounds to even (e.g. 0.125 MiB). */
const mb2 = (bytes: number) => (bytes / MIB).toFixed(2);
const extensionOf = (name: string): string | null => {
  // std::path::Path::extension on the final component; leading-dot names have none.
  const base = name.split('/').pop() ?? name;
  const index = base.lastIndexOf('.');
  if (index <= 0) return null;
  return base.slice(index + 1);
};

/**
 * Blob extension for `storeBlob`. Content-addressed blobs used to be stored as
 * `<sha256>.bin`, which made `pdfstream://`/`filestream://` infer
 * `application/octet-stream` and reject PDFs by extension. Prefer the upload's
 * real extension, then a known MIME mapping, and only fall back to `.bin`.
 */
export function extensionForMime(name: string, mimeType: string): string | null {
  const fromName = extensionOf(name);
  if (fromName !== null && /^[A-Za-z0-9]{1,9}$/u.test(fromName)) return fromName.toLowerCase();
  switch (mimeType.trim().toLowerCase()) {
    case 'application/pdf': return 'pdf';
    case 'application/epub+zip': return 'epub';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return 'pptx';
    case 'application/vnd.ms-excel': return 'xls';
    case 'application/vnd.ms-excel.sheet.binary.macroEnabled.12': return 'xlsb';
    case 'application/vnd.oasis.opendocument.spreadsheet': return 'ods';
    case 'text/plain': return 'txt';
    case 'text/markdown': return 'md';
    case 'text/csv': return 'csv';
    case 'application/json': return 'json';
    case 'application/xml':
    case 'text/xml': return 'xml';
    case 'application/rtf':
    case 'text/rtf': return 'rtf';
    case 'application/zip':
    case 'application/x-zip-compressed': return 'zip';
    case 'application/x-rar-compressed':
    case 'application/vnd.rar': return 'rar';
    case 'application/x-7z-compressed': return '7z';
    default: return null;
  }
}

/**
 * Rust `render_pdf_preview(.., &PdfPreviewConfig::default())` under catch_unwind (handlers.rs:2302, 7434);
 * every failure degrades to no preview.
 */
export async function renderPreview(deps: { log: Context['logger'] }, processing: AttachmentProcessingAdapter,
  conn: SqlExecutor, blobsDir: string, content: Uint8Array, saga: UploadSaga, prefix: string) {
  try {
    const result = await processing.renderPdf(conn, blobsDir, content, DEFAULT_PDF_PREVIEW_CONFIG);
    if (result.previewJson !== null) saga.recordPreviewBlobs(result.previewJson);
    const previewStr = result.previewJson === null ? null : JSON.stringify(result.previewJson satisfies PdfPreviewJson);
    return { previewJson: previewStr, extractedText: result.extractedText, pageCount: result.pageCount as number | null, rendered: result };
  } catch (error) {
    deps.log.warn(`${prefix} PDF preview failed: %s`, message(error));
    return { previewJson: null, extractedText: null, pageCount: null, rendered: null };
  }
}

export async function uploadFileCommand(deps: FileUploadDeps, params: VfsUploadFileParams) {
  try { return await uploadFile(deps, params); }
  catch (error) { throw error instanceof CommandError ? error : new CommandError(message(error)); }
}

const SUPPORTED_EXTENSIONS = ['docx', 'xlsx', 'xls', 'xlsb', 'ods', 'pptx', 'epub', 'rtf', 'txt', 'md',
  'markdown', 'html', 'htm', 'csv', 'json', 'xml'];

async function uploadFile(deps: FileUploadDeps, params: VfsUploadFileParams): Promise<VfsUploadFileResult> {
  const { log, repos } = deps;
  const ocrConfig = loadOcrStrategyConfig(deps.settings());
  const folderIdParam = params.folderId ?? null;
  log.info('[VFS::handlers] vfs_upload_file: name=%s, mime_type=%s, folder_id=%s', params.name, params.mimeType,
    folderIdParam === null ? 'None' : `Some(${JSON.stringify(folderIdParam)})`);

  let content: Uint8Array;
  try { content = decodeStandardBase64(params.base64Content); }
  catch (error) { throw new Error(message(error)); }

  if (!repos.attachments.isSupportedUploadType(params.name, params.mimeType)) {
    const ext = extensionOf(params.name);
    const extDisplay = ext === null ? '(无扩展名)' : `.${ext.toLowerCase()}`;
    throw new Error(new VfsError('InvalidArgument', { param: 'mime_type',
      reason: `UNSUPPORTED_FILE_TYPE: 不支持的文件类型 ${extDisplay} (文件: ${params.name}, MIME: ${params.mimeType})` }).message);
  }
  const maxSize = repos.attachments.maxUploadSizeBytes(params.mimeType);
  if (content.length > maxSize) {
    throw new Error(new VfsError('InvalidArgument', { param: 'base64_content',
      reason: `File too large: max ${Math.floor(maxSize / MIB)}MB, got ${mb2(content.length)}MB` }).message);
  }
  const sha256 = toHex(await createWebCrypto().digest('SHA-256', content));
  const fileType = params.fileType ?? inferFileType(params.mimeType);
  const size = content.length;
  const blobsDir = deps.blobsDir();
  const isImage = params.mimeType.startsWith('image/');

  let conn = deps.conn();
  const existing = repos.files.getBySha256(conn, sha256);
  if (existing !== null && existing.status === 'active') {
    log.info('[VFS::handlers] File reused: %s', existing.id);
    const reusedPdf = existing.mimeType === 'application/pdf' || existing.fileName.toLowerCase().endsWith('.pdf');
    const reusedImage = existing.mimeType?.startsWith('image/') ?? false;
    let needsProcessing = false;
    if (reusedPdf) {
      if (existing.previewJson !== undefined) needsProcessing = pdfPreviewNeedsCompression(existing.previewJson);
    } else if (reusedImage) {
      needsProcessing = imageNeedsCompression(repos, conn, blobsDir, existing.id);
    }
    if (needsProcessing) {
      startPipeline(deps, existing.id, reusedPdf ? 'ocr_processing' : 'image_compression',
        '[VFS::handlers] Starting media pipeline for reused file: %s (pdf=%s, image=%s)', [reusedPdf, reusedImage],
        '[VFS::handlers] Failed to start media pipeline for reused file %s: %s');
    }
    return { sourceId: existing.id, resourceHash: sha256, isNew: false, file: existing };
  }

  const targetFolderId = folderIdParam !== null && folderIdParam !== ''
    ? folderIdParam
    : deps.attachmentConfig.getOrCreateRootFolder();
  conn = deps.conn();
  const isPdf = params.mimeType === 'application/pdf' || params.name.toLowerCase().endsWith('.pdf');
  const saga = deps.createSaga();
  const processing = ownerAttachmentProcessing(repos);
  let pagedTextPages: string[] | null = null;

  let previewJson: string | null = null;
  let extractedText: string | null = null;
  let pageCount: number | null = null;
  if (isPdf) {
    log.info('[VFS::handlers] PDF detected, triggering preview render: %s', params.name);
    const rendered = await renderPreview(deps, processing, conn, blobsDir, content, saga, '[VFS::handlers]');
    ({ previewJson, extractedText, pageCount } = rendered);
    if (rendered.rendered !== null) {
      log.info('[VFS::handlers] PDF preview rendered: %d pages, text_len=%d, has_preview=%s',
        rendered.rendered.pageCount, utf8ByteLength(rendered.extractedText ?? ''), previewJson !== null);
    }
  } else {
    const extension = extensionOf(params.name)?.toLowerCase() ?? null;
    const isZipArchive = extension === 'zip'
      || ['application/zip', 'application/x-zip-compressed'].includes(params.mimeType.trim().toLowerCase());
    if (isZipArchive) {
      const manifest = processing.buildZipManifest(params.name, content);
      if (manifest !== null) {
        log.info('[VFS::handlers] Built zip manifest for %s: %d chars', params.name, utf8ByteLength(manifest));
        extractedText = manifest;
      }
    } else if (extension !== null) {
      const isParseable = SUPPORTED_EXTENSIONS.includes(extension) || deps.docs().isPlainTextCodeExtension(extension);
      if (isParseable) {
        let pages: string[] | null = null;
        try { pages = await processing.extractPagedText(params.name, content); } catch { pages = null; }
        if (pages !== null && pages.length > 0) {
          const joined = pages.join('\n\n').trim();
          log.info('[VFS::handlers] Extracted paged text from %s: %d pages, %d chars', params.name, pages.length,
            utf8ByteLength(joined));
          pageCount = pages.length;
          pagedTextPages = pages;
          extractedText = joined;
        } else {
          try {
            const text = await processing.extractText(params.name, content);
            if (text !== null && text.trim() !== '') {
              log.info('[VFS::handlers] Extracted text from %s: %d chars', params.name, utf8ByteLength(text));
              extractedText = text;
            }
          } catch (error) {
            log.warn('[VFS::handlers] Failed to extract text from %s: %s', params.name, message(error));
          }
        }
      }
    }
  }

  // Every upload keeps its bytes: the previous `< 1 MiB non-image` branch
  // wrote an inline `('inline', '')` resource row and silently dropped the file
  // content, so neither read_file_bytes nor vfs_get_file_content could recover it.
  const blobExtension = extensionForMime(params.name, params.mimeType);
  let saved: [string | null, VfsFile, boolean];
  try {
    saved = deps.withSavepoint(conn, 'vfs_upload_file_saga', () => {
      const blobHash = repos.blobs.storeBlob(conn, blobsDir, content, params.mimeType, blobExtension).hash;
      const [file, created] = repos.files.createFileWithDocDataInFolderOutcome(conn, sha256, params.name, size, fileType,
        params.mimeType, blobHash, null, targetFolderId, previewJson, extractedText, pageCount);
      return [blobHash, file, created] as [string | null, VfsFile, boolean];
    });
  } catch (error) {
    log.warn('[VFS::handlers] 上传事务失败，已回滚 DB 写入，开始补偿: %s', message(error));
    saga.abort(conn, blobsDir);
    try { repos.blobs.removeUnregisteredBlobFile(conn, blobsDir, sha256); }
    catch (cleanupError) {
      log.error('[VFS::handlers] 补偿删除孤儿 blob 文件失败（内容寻址可自愈）: %s', message(cleanupError));
    }
    throw new Error(message(error));
  }
  const [blobHash, file, created] = saved;
  if (created) saga.commit();
  else {
    log.info('[VFS::handlers] 上传去重命中已有文件 %s，回退本次新增的 blob 引用', file.id);
    if (blobHash !== null) saga.recordBlobRef(blobHash);
    saga.abort(conn, blobsDir);
  }
  log.info('[VFS::handlers] File uploaded: %s (type=%s, folder=%s, has_text=%s)', file.id, fileType,
    `Some(${JSON.stringify(targetFolderId)})`, extractedText !== null);

  const ocrPagesJson = pagedTextPages === null ? null : JSON.stringify(pagedTextPages);
  // handlers.rs:2527-2538: `UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2` on the same conn; updated_at untouched.
  if (created && ocrPagesJson !== null) {
    try { repos.files.setUploadOcrPagesWithConn(conn, file.id, ocrPagesJson); }
    catch (error) { log.warn('[VFS::handlers] Failed to write ocr_pages_json for %s: %s', file.id, message(error)); }
  }

  const needsImageOcr = isImage && ocrConfig.enabled && ocrConfig.ocrImages;
  const needsPdfOcr = isPdf && ocrConfig.enabled && ocrConfig.ocrScannedPdf
    && utf8ByteLength(extractedText ?? '') < ocrConfig.pdfTextThreshold;
  const needsOcr = needsImageOcr || needsPdfOcr;
  log.debug('[VFS::handlers] OCR config: enabled=%s, threshold=%d, images=%s, pdf=%s, needs_ocr=%s',
    ocrConfig.enabled, ocrConfig.pdfTextThreshold, ocrConfig.ocrImages, ocrConfig.ocrScannedPdf, needsOcr);

  let indexUnitsCreated = 0;
  let indexQueued = false;
  let indexError: string | null = null;
  if (file.resourceId !== undefined) {
    try {
      const units = deps.unitBuilder.syncResourceUnits({
        resourceId: file.resourceId, resourceType: 'file', data: null, ocrText: null, ocrPagesJson,
        blobHash: file.blobHash ?? null, pageCount: file.pageCount ?? null,
        extractedText: file.extractedText ?? null, previewJson: file.previewJson ?? null,
      });
      indexUnitsCreated = units.length;
      indexQueued = true;
      log.info('[VFS::handlers] Auto-synced %d units for file %s', units.length, file.id);
    } catch (error) {
      indexError = message(error);
      log.warn('[VFS::handlers] Failed to auto-sync units for file %s: %s', file.id, indexError);
      try { repos.indexStates.markFailed(deps.conn(), file.resourceId, indexError); }
      catch (markError) {
        log.error('[VFS::handlers] Failed to mark index retry state for %s: %s (NULL state still retried by queue)',
          file.resourceId, message(markError));
      }
    }
  }

  let ocrStatus: OcrStatus | undefined;
  if (needsOcr) {
    const msg = !ocrConfig.enabled ? 'OCR 已在设置中禁用'
      : isPdf ? 'OCR 将由 Pipeline 异步处理'
        : isImage ? '图片 OCR 将由 Pipeline 处理' : '等待 OCR 处理';
    ocrStatus = {
      performed: false,
      ...(!ocrConfig.enabled ? { skipReason: 'OCR 已在设置中禁用' } : {}),
      successCount: 0, failedCount: 0, blobMissingCount: 0,
      totalPages: (pageCount ?? 0) >>> 0, allSuccess: false, message: msg,
    };
  }

  let indexStatus: IndexStatus | undefined;
  if (file.resourceId !== undefined) {
    const msg = indexError !== null ? `索引失败，已加入后台重试队列: ${indexError}`
      : indexQueued && indexUnitsCreated > 0 ? `已加入索引队列（${indexUnitsCreated} 个单元）`
        : indexQueued ? '已加入索引队列' : '未创建索引';
    indexStatus = { queued: indexQueued, unitsCreated: indexUnitsCreated, message: msg };
  }

  const mediaKind = deps.mediaKind ?? ownerMediaKind();
  if (created) {
    const kind = mediaKind(params.mimeType, params.name);
    if (kind !== null && kind !== undefined) deps.hooks.notify(file.id);
  }

  if (isPdf || isImage) {
    startPipeline(deps, file.id, isPdf ? 'ocr_processing' : 'image_compression',
      '[VFS::handlers] Starting media pipeline for file: %s (pdf=%s, image=%s)', [isPdf, isImage],
      '[VFS::handlers] Failed to start media pipeline for file %s: %s');
  }

  const out: VfsUploadFileResult = { file, sourceId: file.id, resourceHash: sha256, isNew: true };
  if (ocrStatus !== undefined) out.ocrStatus = ocrStatus;
  if (indexStatus !== undefined) out.indexStatus = indexStatus;
  return out;
}

/** tokio::spawn(start_pipeline): detached, failure logged at error. */
function startPipeline(deps: Pick<FileUploadDeps, 'pdf' | 'log'>, fileId: string, stage: ProcessingStage,
  startMessage: string, flags: [boolean, boolean], failMessage: string) {
  queueMicrotask(() => {
    deps.log.info(startMessage, fileId, flags[0], flags[1]);
    deps.pdf.startPipeline(fileId, stage).catch((error: unknown) => {
      deps.log.error(failMessage, fileId, message(error));
    });
  });
}
