/**
 * handlers.rs:2108-2713 `vfs_upload_file` / `upload_file_blocking` and the
 * `upload_saga.rs` compensation ledger. Shared by the IPC command and the
 * `dstuUpload.upload` business surface; there is no simplified create path.
 * Prepared implementation, NOT registered until the owner APIs reach main.
 *
 * Rust runs this whole body inside `spawn_blocking`. This port runs on the host
 * event loop; thread isolation is not claimed (see BLOCKERS R13-02).
 */
import { createWebCrypto } from '../../../platform/crypto/web.ts';
import { toHex } from '../../../platform/crypto/encoding.ts';
import { basename } from '../../../platform/util/path.ts';
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { VfsError } from '../../vfs/portable.ts';
import { decodeBase64Standard, rustTrim } from '../../../platform/util/portable.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { DocsService } from '../../media/api.ts';
import type {
  AttachmentProcessingAdapter, AttachmentRepository, BlobRepository, FileRepository,
  IndexStateRepository, PdfPreviewJson, VfsFile,
} from '../../vfs-repos/api.ts';
import { VfsRepositoryError } from '../../vfs-repos/api.ts';
import { parsePreview } from './pdf-preview.ts';
import type { DstuUploadService } from '../api.ts';
import { withUploadSavepoint } from '../repository/upload-savepoint.ts';
import type { PdfProcessingService, ProcessingStage, UnitBuilderService } from '../../vfs-index/api.ts';
import type {
  IndexStatus, OcrStatus, VfsUploadFileParams, VfsUploadFileResult,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';

export type PdfPreviewConfig = Parameters<AttachmentProcessingAdapter['renderPdf']>[3];
export type MediaKindFn = (mimeType: string, fileName: string) => 'Audio' | 'Video' | null;

export interface UploadFileDeps {
  readonly conn: () => DatabaseHandle;
  readonly blobsDir: () => string;
  readonly files: FileRepository;
  readonly blobs: BlobRepository;
  readonly attachments: AttachmentRepository;
  readonly indexStates: IndexStateRepository;
  /** L11 `vfsRepo.attachmentProcessing` (render_pdf_preview / DocumentParser / zip manifest). */
  readonly processing: AttachmentProcessingAdapter;
  /** L11 `PdfPreviewConfig::default()` owner value. */
  readonly previewConfig: PdfPreviewConfig;
  /** L11 `media_types::media_kind`. */
  readonly mediaKind: MediaKindFn;
  /** L13 `AttachmentConfig::get_or_create_root_folder`. */
  readonly rootFolder: () => string;
  /** Owner-only UPDATE of ocr_pages_json, without altering updated_at (handlers.rs:2528). */
  readonly writeUploadOcrPages: (conn: DatabaseHandle, fileId: string, json: string) => void;
  readonly unitBuilder: UnitBuilderService;
  readonly pdf: PdfProcessingService;
  readonly settings: SettingsStore;
  readonly docs: Pick<DocsService, 'isPlainTextCodeExtension'>;
  readonly notifyResourceCreated: (resourceId: string) => void;
  readonly log: Context['logger'];
}

function messageOf(error: unknown): string {
  if (error instanceof VfsError) return error.toString();
  return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof Error) throw new CommandError(messageOf(error));
  throw error;
}

/** handlers.rs:2047-2105 `OcrStrategyConfig::load_from_db`; read errors keep the default. */
export function loadOcrStrategy(settings: SettingsStore) {
  const config = { enabled: true, skipForMultimodal: false, pdfTextThreshold: 100n, ocrImages: true, ocrScannedPdf: true };
  const read = (key: string): string | null => {
    try { return settings.get(key); } catch { return null; } // Rust `if let Ok(Some(v))`.
  };
  const flag = (key: string): boolean | null => {
    const value = read(key);
    return value === null ? null : value.toLowerCase() === 'true';
  };
  config.enabled = flag('ocr.enabled') ?? config.enabled;
  config.skipForMultimodal = flag('ocr.skip_for_multimodal') ?? config.skipForMultimodal;
  const threshold = read('ocr.pdf_text_threshold');
  // Rust `v.parse::<usize>()`: optional '+', ASCII digits only.
  if (threshold !== null && /^\+?[0-9]+(?![\s\S])/.test(threshold)) {
    const parsed = BigInt(threshold);
    if (parsed <= 0xffff_ffff_ffff_ffffn) config.pdfTextThreshold = parsed;
  }
  config.ocrImages = flag('ocr.images') ?? config.ocrImages;
  config.ocrScannedPdf = flag('ocr.scanned_pdf') ?? config.ocrScannedPdf;
  return config;
}

/** `std::path::Path::extension` on the final `/`-separated component. */
export function pathExtension(name: string): string | null {
  const file = basename(name);
  if (file === '' || file === '..') return null;
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  return file.slice(dot + 1);
}

/**
 * Blob extension for `storeBlob`. Content-addressed blobs stored as
 * `<sha256>.bin` made the streaming protocols infer `application/octet-stream`
 * (and `pdfstream://` reject PDFs by extension); keep the real extension when
 * the upload has one, otherwise map the MIME type.
 */
export function extensionForMime(name: string, mimeType: string): string | null {
  const fromName = pathExtension(name);
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

/** types.rs:2006-2016 `VfsFile::infer_file_type`. */
export function inferFileType(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

/** handlers.rs:192-207. */
export function pdfPreviewNeedsCompression(previewJson: string): boolean {
  let preview: ReturnType<typeof parsePreview>;
  try { preview = parsePreview(previewJson, false); } catch { return false; }
  return preview.pages.some(page => {
    const hash = 'compressedBlobHash' in page ? page.compressedBlobHash : null;
    return typeof hash !== 'string' || rustTrim(hash) === '';
  });
}

/** handlers.rs:209-238; query failures read as "no row". */
export function imageNeedsCompression(deps: Pick<UploadFileDeps, 'files' | 'blobs'>, conn: DatabaseHandle,
  blobsDir: string, fileId: string): boolean {
  let file: VfsFile | null;
  try { file = deps.files.getFile(conn, fileId); } catch { return false; }
  if (file === null) return false;
  const compressed = file.compressedBlobHash;
  if (compressed === undefined || rustTrim(compressed) === '') return true;
  let path: string | null;
  try { path = deps.blobs.getBlobPath(conn, blobsDir, compressed); } catch { return true; }
  return path === null;
}

/** upload_saga.rs:100-200 compensation ledger. */
export class UploadSaga {
  private refs: string[] = [];
  private committed = false;
  private readonly deps: Pick<UploadFileDeps, 'blobs' | 'log'>;
  constructor(deps: Pick<UploadFileDeps, 'blobs' | 'log'>) { this.deps = deps; }
  recordBlobRef(hash: string): void { this.refs.push(hash); }
  recordPreviewBlobs(preview: PdfPreviewJson): void {
    for (const page of preview.pages) {
      this.recordBlobRef(page.blobHash);
      if (page.compressedBlobHash !== undefined && page.compressedBlobHash !== page.blobHash) {
        this.recordBlobRef(page.compressedBlobHash);
      }
    }
  }
  commit(): void { this.committed = true; this.refs = []; }
  abort(conn: DatabaseHandle, blobsDir: string): void {
    if (this.committed) return;
    const refs = this.refs;
    this.refs = [];
    if (refs.length === 0) return;
    this.deps.log.info('[VFS::UploadSaga] Aborting upload, compensating %d blob ref(s)', refs.length);
    for (const hash of [...refs].reverse()) {
      const short = hash.slice(0, 16);
      try {
        this.deps.blobs.decrementRef(conn, hash);
      } catch (error) {
        if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND') {
          this.deps.log.debug('[VFS::UploadSaga] Blob %s already gone during compensation', short);
        } else {
          this.deps.log.warn('[VFS::UploadSaga] Failed to decrement blob %s during compensation: %s (left to background sweep)', short, messageOf(error));
        }
        continue;
      }
      try {
        this.deps.blobs.cleanupBlob(conn, blobsDir, hash);
      } catch (error) {
        this.deps.log.warn('[VFS::UploadSaga] Failed to cleanup blob %s during compensation: %s (left to background sweep)', short, messageOf(error));
      }
    }
  }
}

/** handlers.rs:2425-2499. All writes use the caller's single connection. */
export function saveUploadedFile(deps: Pick<UploadFileDeps, 'blobs' | 'files' | 'log'>,
  conn: DatabaseHandle, blobsDir: string, input: {
    params: VfsUploadFileParams; content: Uint8Array; sha256: string; fileType: string;
    targetFolderId: string; previewJson: string | null; extractedText: string | null; pageCount: number | null;
  }, saga: UploadSaga): { file: VfsFile; created: boolean } {
  const { params, content, sha256, fileType, targetFolderId, previewJson, extractedText, pageCount } = input;
  // Every upload keeps its bytes. The old `< 1 MiB non-image` branch wrote an
  // inline `('inline', '')` resource row and dropped the content, so neither
  // read_file_bytes nor vfs_get_file_content could recover the file.
  const blobExtension = extensionForMime(params.name, params.mimeType);
  let blobHash: string | null;
  let file: VfsFile;
  let created: boolean;
  try {
    ({ blobHash, file, created } = withUploadSavepoint(conn, deps.log, () => {
      const hash = deps.blobs.storeBlob(conn, blobsDir, content, params.mimeType, blobExtension).hash;
      const [row, isCreated] = deps.files.createFileWithDocDataInFolderOutcome(conn, sha256, params.name, content.length,
        fileType, params.mimeType, hash, null, targetFolderId, previewJson, extractedText, pageCount);
      return { blobHash: hash, file: row, created: isCreated };
    }));
  } catch (error) {
    deps.log.warn('[VFS::handlers] 上传事务失败，已回滚 DB 写入，开始补偿: %s', messageOf(error));
    saga.abort(conn, blobsDir);
    try { deps.blobs.removeUnregisteredBlobFile(conn, blobsDir, sha256); }
    catch (cleanup) { deps.log.error('[VFS::handlers] 补偿删除孤儿 blob 文件失败（内容寻址可自愈）: %s', messageOf(cleanup)); }
    throw error;
  }

  if (created) {
    saga.commit();
  } else {
    deps.log.info('[VFS::handlers] 上传去重命中已有文件 %s，回退本次新增的 blob 引用', file.id);
    if (blobHash !== null) saga.recordBlobRef(blobHash);
    saga.abort(conn, blobsDir);
  }
  return { file, created };
}

const PARSEABLE_EXTENSIONS = ['docx', 'xlsx', 'xls', 'xlsb', 'ods', 'pptx', 'epub', 'rtf', 'txt', 'md',
  'markdown', 'html', 'htm', 'csv', 'json', 'xml'];

function utf8Length(text: string): number { return new TextEncoder().encode(text).length; }

function startPipelineLater(deps: UploadFileDeps, fileId: string, isPdf: boolean, isImage: boolean,
  label: 'reused file' | 'file'): void {
  const stage: ProcessingStage = isPdf ? 'ocr_processing' : 'image_compression';
  // Rust tokio::spawn is detached. Defer scheduling here; this is not spawn_blocking.
  setImmediate(() => {
    deps.log.info(`[VFS::handlers] Starting media pipeline for ${label}: %s (pdf=%s, image=%s)`, fileId, isPdf, isImage);
    deps.pdf.startPipeline(fileId, stage).catch((error: unknown) => {
      deps.log.error(`[VFS::handlers] Failed to start media pipeline for ${label} %s: %s`, fileId, messageOf(error));
    });
  });
}

export async function uploadFile(deps: UploadFileDeps, params: VfsUploadFileParams): Promise<VfsUploadFileResult> {
  try {
    return await uploadFileInner(deps, params);
  } catch (error) {
    return fail(error);
  }
}

/** Same function for L13 DSTU tooling and the IPC command; no dstu_create shortcut. */
export function createDstuUploadService(deps: UploadFileDeps): DstuUploadService {
  return {
    isSupportedUploadType: (name, mimeType) => deps.attachments.isSupportedUploadType(name, mimeType),
    maxUploadSizeBytes: mimeType => deps.attachments.maxUploadSizeBytes(mimeType),
    upload: params => uploadFile(deps, params),
  };
}

async function uploadFileInner(deps: UploadFileDeps, params: VfsUploadFileParams): Promise<VfsUploadFileResult> {
  const ocrConfig = loadOcrStrategy(deps.settings);
  deps.log.info('[VFS::handlers] vfs_upload_file: name=%s, mime_type=%s, folder_id=%s',
    params.name, params.mimeType, params.folderId ?? null);

  const decoded = decodeBase64Standard(params.base64Content);
  if (decoded.error !== undefined) throw new Error(`Base64 decode failed: ${decoded.error}`);
  const content = new Uint8Array(decoded.bytes);

  if (!deps.attachments.isSupportedUploadType(params.name, params.mimeType)) {
    const extension = pathExtension(params.name);
    const extDisplay = extension === null ? '(无扩展名)' : `.${extension.toLowerCase()}`;
    throw new VfsError('InvalidArgument', { param: 'mime_type',
      reason: `UNSUPPORTED_FILE_TYPE: 不支持的文件类型 ${extDisplay} (文件: ${params.name}, MIME: ${params.mimeType})` });
  }
  const maxSize = deps.attachments.maxUploadSizeBytes(params.mimeType);
  if (content.length > maxSize) {
    const maxMb = Math.floor(maxSize / (1024 * 1024));
    const actualMb = (content.length / (1024 * 1024)).toFixed(2);
    throw new VfsError('InvalidArgument', { param: 'base64_content', reason: `File too large: max ${maxMb}MB, got ${actualMb}MB` });
  }

  const sha256 = toHex(await createWebCrypto().digest('SHA-256', content));
  const fileType = params.fileType ?? inferFileType(params.mimeType);
  const blobsDir = deps.blobsDir();
  const isImage = params.mimeType.startsWith('image/');

  {
    const conn = deps.conn();
    const existing = deps.files.getBySha256(conn, sha256);
    if (existing !== null && existing.status === 'active') {
      deps.log.info('[VFS::handlers] File reused: %s', existing.id);
      const reusedPdf = existing.mimeType === 'application/pdf' || existing.fileName.toLowerCase().endsWith('.pdf');
      const reusedImage = existing.mimeType?.startsWith('image/') ?? false;
      let needsProcessing = false;
      if (reusedPdf) {
        if (existing.previewJson !== undefined) needsProcessing = pdfPreviewNeedsCompression(existing.previewJson);
      } else if (reusedImage) {
        needsProcessing = imageNeedsCompression(deps, conn, blobsDir, existing.id);
      }
      if (needsProcessing) startPipelineLater(deps, existing.id, reusedPdf, reusedImage, 'reused file');
      return { sourceId: existing.id, resourceHash: sha256, isNew: false, file: existing };
    }
  }

  const targetFolderId = params.folderId !== undefined && params.folderId !== null && params.folderId !== ''
    ? params.folderId : deps.rootFolder();
  const conn = deps.conn();
  const isPdf = params.mimeType === 'application/pdf' || params.name.toLowerCase().endsWith('.pdf');
  const saga = new UploadSaga(deps);
  let pagedTextPages: string[] | null = null;
  let previewJson: string | null = null;
  let extractedText: string | null = null;
  let pageCount: number | null = null;

  if (isPdf) {
    deps.log.info('[VFS::handlers] PDF detected, triggering preview render: %s', params.name);
    try {
      const result = await deps.processing.renderPdf(conn, blobsDir, content, deps.previewConfig);
      if (result.previewJson !== null) saga.recordPreviewBlobs(result.previewJson);
      previewJson = result.previewJson === null ? null : JSON.stringify(result.previewJson);
      deps.log.info('[VFS::handlers] PDF preview rendered: %d pages, text_len=%d, has_preview=%s',
        result.pageCount, result.extractedText === null ? 0 : utf8Length(result.extractedText), previewJson !== null);
      extractedText = result.extractedText;
      pageCount = result.pageCount;
    } catch (error) {
      deps.log.warn('[VFS::handlers] PDF preview failed: %s', messageOf(error));
    }
  } else {
    const extension = pathExtension(params.name)?.toLowerCase() ?? null;
    const mime = rustTrim(params.mimeType).replace(/[A-Z]/g, char => char.toLowerCase());
    const isZip = extension === 'zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed';
    if (isZip) {
      const manifest = deps.processing.buildZipManifest(params.name, content);
      if (manifest !== null) {
        deps.log.info('[VFS::handlers] Built zip manifest for %s: %d chars', params.name, utf8Length(manifest));
        extractedText = manifest;
      }
    } else if (extension !== null && (PARSEABLE_EXTENSIONS.includes(extension) || deps.docs.isPlainTextCodeExtension(extension))) {
      let pages: string[] | null = null;
      try { pages = await deps.processing.extractPagedText(params.name, content); } catch { pages = null; } // Rust `Ok(_) | Err(_)` fallback.
      if (pages !== null && pages.length > 0) {
        const joined = rustTrim(pages.join('\n\n'));
        deps.log.info('[VFS::handlers] Extracted paged text from %s: %d pages, %d chars', params.name, pages.length, utf8Length(joined));
        pagedTextPages = pages;
        extractedText = joined;
        pageCount = pages.length;
      } else {
        try {
          const text = await deps.processing.extractText(params.name, content);
          if (text !== null && rustTrim(text) !== '') {
            deps.log.info('[VFS::handlers] Extracted text from %s: %d chars', params.name, utf8Length(text));
            extractedText = text;
          }
        } catch (error) {
          deps.log.warn('[VFS::handlers] Failed to extract text from %s: %s', params.name, messageOf(error));
        }
      }
    }
  }

  const { file, created } = saveUploadedFile(deps, conn, blobsDir, {
    params, content, sha256, fileType, targetFolderId, previewJson, extractedText, pageCount,
  }, saga);
  deps.log.info('[VFS::handlers] File uploaded: %s (type=%s, folder=%s, has_text=%s)', file.id, fileType, targetFolderId, extractedText !== null);

  const ocrPagesJson = pagedTextPages === null ? null : JSON.stringify(pagedTextPages);
  if (created && ocrPagesJson !== null) {
    try { deps.writeUploadOcrPages(conn, file.id, ocrPagesJson); }
    catch (error) { deps.log.warn('[VFS::handlers] Failed to write ocr_pages_json for %s: %s', file.id, messageOf(error)); }
  }

  const needsImageOcr = isImage && ocrConfig.enabled && ocrConfig.ocrImages;
  const needsPdfOcr = isPdf && ocrConfig.enabled && ocrConfig.ocrScannedPdf
    && BigInt(extractedText === null ? 0 : utf8Length(extractedText)) < ocrConfig.pdfTextThreshold;
  const needsOcr = needsImageOcr || needsPdfOcr;
  deps.log.debug('[VFS::handlers] OCR config: enabled=%s, threshold=%s, images=%s, pdf=%s, needs_ocr=%s',
    ocrConfig.enabled, ocrConfig.pdfTextThreshold.toString(), ocrConfig.ocrImages, ocrConfig.ocrScannedPdf, needsOcr);

  let unitsCreated = 0;
  let queued = false;
  let indexError: string | null = null;
  if (file.resourceId !== undefined) {
    try {
      const units = deps.unitBuilder.syncResourceUnits({ resourceId: file.resourceId, resourceType: 'file', data: null,
        ocrText: null, ocrPagesJson, blobHash: file.blobHash ?? null, pageCount: file.pageCount ?? null,
        extractedText: file.extractedText ?? null, previewJson: file.previewJson ?? null });
      unitsCreated = units.length;
      queued = true;
      deps.log.info('[VFS::handlers] Auto-synced %d units for file %s', units.length, file.id);
    } catch (error) {
      indexError = messageOf(error);
      deps.log.warn('[VFS::handlers] Failed to auto-sync units for file %s: %s', file.id, indexError);
      try { deps.indexStates.markFailed(deps.conn(), file.resourceId, indexError); }
      catch (markError) {
        deps.log.error('[VFS::handlers] Failed to mark index retry state for %s: %s (NULL state still retried by queue)', file.resourceId, messageOf(markError));
      }
    }
  }

  const ocrStatus: OcrStatus | null = needsOcr ? {
    performed: false,
    ...(!ocrConfig.enabled ? { skipReason: 'OCR 已在设置中禁用' } : {}),
    successCount: 0, failedCount: 0, blobMissingCount: 0,
    totalPages: pageCount ?? 0,
    allSuccess: false,
    message: !ocrConfig.enabled ? 'OCR 已在设置中禁用' : isPdf ? 'OCR 将由 Pipeline 异步处理'
      : isImage ? '图片 OCR 将由 Pipeline 处理' : '等待 OCR 处理',
  } : null;
  const indexStatus: IndexStatus | null = file.resourceId === undefined ? null : {
    queued,
    unitsCreated,
    message: indexError !== null ? `索引失败，已加入后台重试队列: ${indexError}`
      : queued && unitsCreated > 0 ? `已加入索引队列（${unitsCreated} 个单元）`
        : queued ? '已加入索引队列' : '未创建索引',
  };

  if (created && deps.mediaKind(params.mimeType, params.name) !== null) {
    deps.notifyResourceCreated(file.id);
  }
  if (isPdf || isImage) startPipelineLater(deps, file.id, isPdf, isImage, 'file');

  return { sourceId: file.id, resourceHash: sha256, isNew: true, file,
    ...(ocrStatus === null ? {} : { ocrStatus }), ...(indexStatus === null ? {} : { indexStatus }) };
}
