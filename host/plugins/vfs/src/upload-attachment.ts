/**
 * handlers.rs:1310-1639 `vfs_upload_attachment` / `upload_attachment_blocking`.
 *
 * Persistence goes through L11 `AttachmentRepository` (upload / bytes / media
 * stream), unit sync through L12 `vfsUnitBuilder`, pipeline status/start
 * through L12 `vfsIndex.pdf`; the default folder comes from this lane's
 * `AttachmentConfig`. Thread semantics: Rust runs the body in
 * `spawn_blocking`; here it runs on the host event loop (same gap as R13-02).
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
type StagedFile = ReturnType<typeof fs.takeStagedUpload>;
import * as vfsReposApi from '../../vfs-repos/api.ts';
import type { VfsReposService, VfsUploadAttachmentParams, VfsUploadAttachmentResult } from '../../vfs-repos/api.ts';
import type { VfsUploadAttachmentResult as UploadAttachmentWireResult } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { PdfProcessingService, ProcessingStage, UnitBuilderService } from '../../vfs-index/api.ts';
import { hasRetriableFailure } from '../../vfs-index/api.ts';
import type { AttachmentConfig } from './attachment-config.ts';
import { decodeBase64Standard } from '../../../platform/util/base64-core.ts';
import { fs } from './local-runtime.ts';
import { classifyPdfContent } from './ocr.ts';
import type { ResourceCreatedHooks } from './resource-created-hooks.ts';

/** handlers.rs:1310-1325 `VfsUploadAttachmentParamsExt` (camelCase, serde defaults). */
export interface VfsUploadAttachmentParamsExt {
  name: string;
  mimeType: string;
  base64Content?: string;
  stagedUploadId?: string | null;
  attachmentType?: string | null;
  folderId?: string | null;
}

export type MediaKindFn = (mimeType: string, fileName: string) => unknown;

export interface UploadAttachmentDeps {
  conn(): SqlExecutor;
  blobsDir(): string;
  repos: VfsReposService;
  attachmentConfig: AttachmentConfig;
  unitBuilder: UnitBuilderService;
  pdf: PdfProcessingService;
  hooks: ResourceCreatedHooks;
  log: Context['logger'];
  /** Overridable only to bind the owner's export; defaults to L11 `mediaKind`. */
  mediaKind?: MediaKindFn;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** dstu-core media_types.rs `media_kind`, published by L11 api.ts (commit 0a3d703ad). */
export function ownerMediaKind(): MediaKindFn {
  const fn = (vfsReposApi as unknown as { mediaKind?: MediaKindFn }).mediaKind;
  if (typeof fn !== 'function') throw new Error('L11 vfs-repos api.ts 未发布 mediaKind（dstu-core media_types.rs）');
  return fn;
}

/** base64 STANDARD engine: canonical alphabet with required padding. */
export function decodeStandardBase64(input: string): Uint8Array {
  if (input.length % 4 !== 0) throw new Error('Base64 decode failed: Invalid input length');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input)) throw new Error('Base64 decode failed: Invalid symbol');
  const decoded = decodeBase64Standard(input);
  if (decoded.error !== undefined) throw new Error('Base64 decode failed: Invalid symbol');
  return decoded.bytes;
}

const isUint = (v: unknown, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const U32_MAX = 0xffff_ffff;
/** serde `PdfPagePreview` (types.rs:2876-2898, camelCase, all but compressedBlobHash required). */
function pagePreviewCompressed(value: unknown): { ok: boolean; compressed: string | null } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, compressed: null };
  const page = value as Record<string, unknown>;
  const ok = isUint(page.pageIndex) && typeof page.blobHash === 'string' && isUint(page.width, U32_MAX)
    && isUint(page.height, U32_MAX) && typeof page.mimeType === 'string'
    && (page.compressedBlobHash === undefined || page.compressedBlobHash === null || typeof page.compressedBlobHash === 'string');
  return { ok, compressed: typeof page.compressedBlobHash === 'string' ? page.compressedBlobHash : null };
}

/** handlers.rs:192-206 `pdf_preview_needs_compression`; serde failure (types.rs:2849-2873) → false. */
export function pdfPreviewNeedsCompression(previewJson: string): boolean {
  let preview: unknown;
  try { preview = JSON.parse(previewJson); } catch { return false; }
  if (preview === null || typeof preview !== 'object' || Array.isArray(preview)) return false;
  const record = preview as Record<string, unknown>;
  if (!Array.isArray(record.pages) || !isUint(record.renderDpi, U32_MAX) || !isUint(record.totalPages)
    || typeof record.renderedAt !== 'string'
    || (record.isTruncated !== undefined && typeof record.isTruncated !== 'boolean')
    || (record.maxRenderedPages !== undefined && !isUint(record.maxRenderedPages))) return false;
  const pages = record.pages.map(pagePreviewCompressed);
  if (pages.some(page => !page.ok)) return false;
  if (pages.length === 0) return false;
  return pages.some(page => page.compressed === null || page.compressed.trim() === '');
}

/** handlers.rs:209-238 `image_needs_compression_with_conn` via L11 FileRepository/BlobRepository. */
export function imageNeedsCompression(repos: VfsReposService, conn: SqlExecutor, blobsDir: string, fileId: string): boolean {
  let file;
  try { file = repos.files.getFile(conn, fileId); } catch { return false; }
  if (file === null) return false;
  const hash = file.compressedBlobHash;
  if (hash === undefined || hash === null) return true;
  if (hash.trim() === '') return true;
  try { return repos.blobs.getBlobPath(conn, blobsDir, hash) === null; } catch { return true; }
}

function* stagedChunks(staged: StagedFile): Generator<Uint8Array> {
  let fd: number;
  try { fd = fs.openSync(staged.path(), 'r'); }
  catch (error) { throw new Error(`Failed to open staged upload: ${message(error)}`); }
  try {
    const buffer = new Uint8Array(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) return;
      yield buffer.subarray(0, read);
    }
  } finally { fs.closeSync(fd); }
}

export async function uploadAttachmentCommand(deps: UploadAttachmentDeps, params: VfsUploadAttachmentParamsExt) {
  try { return await uploadAttachment(deps, params); }
  catch (error) { throw error instanceof CommandError ? error : new CommandError(message(error)); }
}

async function uploadAttachment(deps: UploadAttachmentDeps, params: VfsUploadAttachmentParamsExt) {
  const { log, repos } = deps;
  const folderIdParam = params.folderId ?? null;
  log.info('[VFS::handlers] vfs_upload_attachment: name=%s, mime_type=%s, folder_id=%s',
    params.name, params.mimeType, folderIdParam === null ? 'None' : `Some(${JSON.stringify(folderIdParam)})`);

  const isPdf = params.mimeType === 'application/pdf' || params.name.toLowerCase().endsWith('.pdf');
  const targetFolderId = folderIdParam !== null && folderIdParam !== ''
    ? folderIdParam
    : deps.attachmentConfig.getOrCreateRootFolder();

  const mediaKind = deps.mediaKind ?? ownerMediaKind();
  const kind = mediaKind(params.mimeType, params.name);
  const isMedia = kind !== null && kind !== undefined;

  const uploadId = params.stagedUploadId ?? null;
  const staged = uploadId !== null && uploadId !== '' ? fs.takeStagedUpload(uploadId) : undefined;
  let result: VfsUploadAttachmentResult;
  try {
    let stagedBytes: Uint8Array | undefined;
    if (staged !== undefined && !isMedia) {
      stagedBytes = staged.readBounded(repos.attachments.maxUploadSizeBytes(params.mimeType));
    }
    const uploadParams: VfsUploadAttachmentParams = {
      name: params.name,
      mimeType: params.mimeType,
      base64Content: params.base64Content ?? '',
      type: params.attachmentType ?? null,
    };
    const conn = deps.conn();
    const blobsDir = deps.blobsDir();
    if (isMedia) {
      const chunks: Iterable<Uint8Array> = staged !== undefined
        ? stagedChunks(staged)
        : [decodeStandardBase64(uploadParams.base64Content.trim())];
      result = repos.attachments.uploadMediaStreamFinalized(conn, blobsDir, uploadParams, chunks, targetFolderId);
    } else if (stagedBytes !== undefined) {
      result = await repos.attachments.uploadBytesWithFolderConn(conn, blobsDir, uploadParams, stagedBytes, targetFolderId);
    } else {
      result = await repos.attachments.uploadWithFolderConn(conn, blobsDir, uploadParams, targetFolderId);
    }
  } finally {
    // StagedFile drop: the temp file is removed on every path.
    staged?.dispose();
  }

  if (isMedia) deps.hooks.notify(result.sourceId);

  log.info('[VFS::handlers] Attachment %s: source_id=%s, hash=%s, folder=%s',
    result.isNew ? 'uploaded' : 'reused', result.sourceId,
    result.resourceHash.slice(0, Math.min(16, result.resourceHash.length)), `Some(${JSON.stringify(targetFolderId)})`);

  const attachment = result.attachment;
  if (attachment.resourceId !== undefined && attachment.resourceId !== null) {
    try {
      const units = deps.unitBuilder.syncResourceUnits({
        resourceId: attachment.resourceId,
        resourceType: 'attachment',
        data: null,
        ocrText: null,
        ocrPagesJson: null,
        blobHash: attachment.blobHash ?? null,
        pageCount: attachment.pageCount ?? null,
        extractedText: attachment.extractedText ?? null,
        previewJson: attachment.previewJson ?? null,
      });
      log.info('[VFS::handlers] Auto-synced %d units for attachment %s', units.length, result.sourceId);
    } catch (error) {
      log.warn('[VFS::handlers] Failed to auto-sync units for attachment %s: %s', result.sourceId, message(error));
    }
  }

  const isImage = params.mimeType.startsWith('image/');
  const textReady = () => (attachment.extractedText ?? '').trim() !== '';
  let processingStatus: string | undefined;
  let processingPercent: number | null | undefined;
  let readyModes: string[] | undefined;
  let needsProcessing = false;
  if (isPdf || isImage) {
    let status = null;
    try { status = deps.pdf.getStatus(result.sourceId); } catch { status = null; }
    if (status !== null) {
      const stage = status.progress.stage;
      needsProcessing = stage === 'completed' || stage === 'error'
        ? false
        : stage === 'completed_with_issues' ? hasRetriableFailure(status.progress) : true;
      processingStatus = stage;
      // 契约（F5 b4a033c65）：ProcessingProgress.percent 为 number|null，null 是非有限 f32
      // 在 serde 中的输出形状。Rust 此处传 Some(percent)，故保留 null 出站；undefined 只表示
      // "没有处理状态"（Rust None → skip_serializing_if 省略该键），数值 0 与 null 都正常输出。
      processingPercent = status.progress.percent;
      readyModes = [...status.progress.readyModes];
    } else if (isPdf) {
      processingStatus = 'page_compression';
      processingPercent = 25.0;
      readyModes = textReady() ? ['text'] : [];
      needsProcessing = true;
    } else {
      processingStatus = 'image_compression';
      processingPercent = 10.0;
      readyModes = [];
      needsProcessing = true;
    }
  }

  let needsCompression = false;
  if (isPdf) {
    if (attachment.previewJson !== undefined && attachment.previewJson !== null) {
      needsCompression = pdfPreviewNeedsCompression(attachment.previewJson);
    }
  } else if (isImage) {
    let conn: SqlExecutor | undefined;
    try { conn = deps.conn(); } catch { conn = undefined; }
    if (conn !== undefined) needsCompression = imageNeedsCompression(repos, conn, deps.blobsDir(), result.sourceId);
  }
  if (needsCompression && processingStatus !== 'error') needsProcessing = true;
  if (needsCompression && (processingStatus === 'completed' || processingStatus === undefined)) {
    if (isPdf) {
      processingStatus = 'page_compression';
      processingPercent = 25.0;
      readyModes = textReady() ? ['text'] : [];
    } else if (isImage) {
      processingStatus = 'image_compression';
      processingPercent = 10.0;
      readyModes = [];
    }
  }

  if ((result.isNew || needsProcessing) && (isPdf || isImage)) {
    const fileId = result.sourceId;
    const startStage: ProcessingStage = isPdf ? 'ocr_processing' : 'image_compression';
    const isNew = result.isNew;
    queueMicrotask(() => {
      log.info('[VFS::handlers] Starting media pipeline for attachment: %s (pdf=%s, image=%s, is_new=%s, resume=%s)',
        fileId, isPdf, isImage, isNew, !isNew);
      deps.pdf.startPipeline(fileId, startStage).catch((error: unknown) => {
        log.error('[VFS::handlers] Failed to start media pipeline for attachment %s: %s', fileId, message(error));
      });
    });
  }

  const contentKind = isPdf ? classifyPdfContent(attachment.extractedText ?? null, 100) : undefined;
  // 命令出站形状以本 lane 的 IPC 契约为准：processingPercent?: number | null（F5 b4a033c65）。
  // L11 的 VfsUploadAttachmentResult 仍是窄类型，不能为迁就它而丢弃 null 或改写对方类型。
  const out: UploadAttachmentWireResult = {
    sourceId: result.sourceId,
    resourceHash: result.resourceHash,
    isNew: result.isNew,
    attachment,
  };
  if (processingStatus !== undefined) out.processingStatus = processingStatus;
  if (processingPercent !== undefined) out.processingPercent = processingPercent;
  if (readyModes !== undefined) out.readyModes = readyModes;
  if (contentKind !== undefined) out.contentKind = contentKind;
  return out;
}
