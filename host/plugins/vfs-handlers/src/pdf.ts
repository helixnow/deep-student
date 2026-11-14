/** vfs/handlers.rs PDF 流水线命令（handlers.rs:2950-3106, 6500-6740）。 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { VfsError } from '../../vfs/portable.ts';
import { sanitize_unicode } from '../../../platform/paths/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type {
  BlobRepository,
  FileRepository,
  ResourceRepository,
  VfsFile,
} from '../../vfs-repos/api.ts';
// Internal L12 status keeps exact counters (number|bigint); kernel converts at the IPC boundary.
import { processingStageFromString, type PdfProcessingService, type ProcessingStatus } from '../../vfs-index/api.ts';
import type { VfsBlobBase64Result } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { pendingPdfFileIds, previewJsonForSource } from '../repository/pdf.ts';
import { parsePreview, type PreviewPage, type ExamPreviewPage } from './pdf-preview.ts';

const FILE_ID_PREFIXES = ['file_', 'tb_', 'att_'] as const;

export interface PdfDeps {
  readonly conn: () => DatabaseHandle;
  readonly files: FileRepository;
  readonly blobs: BlobRepository;
  readonly resources: ResourceRepository;
  readonly pdf: PdfProcessingService;
  readonly blobsDir: () => string;
  /** `ctx.files`：blob 在 appData 根下的数据槽里。 */
  readonly hostFiles: () => Pick<FilesService, 'stat' | 'readBytes'>;
  readonly log: Context['logger'];
}

function fail(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof VfsError) throw new CommandError(error.toString());
  if (error instanceof Error) throw new CommandError(error.message);
  throw error;
}

/** handlers.rs:155-172 `validate_id_format_any`. */
export function validateFileIdAny(fileId: string): void {
  if (sanitize_unicode(fileId) !== fileId) {
    throw new VfsError('InvalidArgument', { param: 'file_id', reason: 'ID contains invalid Unicode characters' });
  }
  if (!FILE_ID_PREFIXES.some(prefix => fileId.startsWith(prefix))) {
    throw new VfsError('InvalidArgument', {
      param: 'file_id', reason: `Invalid file_id format: ${fileId}`,
    });
  }
}

export function getPdfProcessingStatus(deps: PdfDeps, fileId: string): ProcessingStatus | null {
  deps.log.info('[VFS::handlers] vfs_get_pdf_processing_status: file_id=%s', fileId);
  try {
    validateFileIdAny(fileId);
    return deps.pdf.getStatus(fileId);
  } catch (error) {
    return fail(error);
  }
}

export function cancelPdfProcessing(deps: PdfDeps, fileId: string): boolean {
  deps.log.info('[VFS::handlers] vfs_cancel_pdf_processing: file_id=%s', fileId);
  try {
    validateFileIdAny(fileId);
    return deps.pdf.cancel(fileId);
  } catch (error) {
    return fail(error);
  }
}

export async function retryPdfProcessing(deps: PdfDeps, fileId: string): Promise<null> {
  deps.log.info('[VFS::handlers] vfs_retry_pdf_processing: file_id=%s', fileId);
  try {
    validateFileIdAny(fileId);
    await deps.pdf.retry(fileId);
    return null;
  } catch (error) {
    return fail(error);
  }
}

export async function startPdfProcessing(
  deps: PdfDeps,
  fileId: string,
  startFromStage: string | null,
): Promise<null> {
  deps.log.info('[VFS::handlers] vfs_start_pdf_processing: file_id=%s, start_from_stage=%s', fileId, startFromStage);
  try {
    validateFileIdAny(fileId);
    const stage = startFromStage === null ? null : processingStageFromString(startFromStage);
    await deps.pdf.startPipeline(fileId, stage);
    return null;
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:6628-6684：无效 id 跳过，get_status 失败只警告。 */
export function getBatchPdfProcessingStatus(
  deps: PdfDeps,
  fileIds: readonly string[],
): Record<string, ProcessingStatus> {
  deps.log.info('[VFS::handlers] vfs_get_batch_pdf_processing_status: count=%d', fileIds.length);
  const results: Record<string, ProcessingStatus> = {};
  for (const fileId of fileIds) {
    try {
      validateFileIdAny(fileId);
    } catch (error) {
      deps.log.warn('[VFS::handlers] Invalid file_id in batch: %s - %s', fileId, error);
      continue;
    }
    try {
      const status = deps.pdf.getStatus(fileId);
      if (status !== null) results[fileId] = status;
    } catch (error) {
      deps.log.warn('[VFS::handlers] Failed to get status for %s: %s', fileId, error);
    }
  }
  return results;
}

/** handlers.rs:6686-6740 */
export function listPendingPdfProcessing(deps: PdfDeps, limit: number | null): VfsFile[] {
  deps.log.info('[VFS::handlers] vfs_list_pending_pdf_processing: limit=%s', limit);
  try {
    const conn = deps.conn();
    const files: VfsFile[] = [];
    for (const fileId of pendingPdfFileIds(conn, limit ?? 50)) {
      try {
        const file = deps.files.getFile(conn, fileId);
        if (file !== null) files.push(file);
      } catch (error) { deps.log.warn('[VfsHandlers] Skipping malformed row: %s', error); }
    }
    deps.log.info('[VFS::handlers] vfs_list_pending_pdf_processing: found %d files', files.length);
    return files;
  } catch (error) {
    return fail(error);
  }
}

export interface PdfPageImageSource {
  readonly conn: () => DatabaseHandle;
  readonly resources: Pick<ResourceRepository, 'getResource'>;
  readonly blobs: Pick<BlobRepository, 'getBlob' | 'getBlobPath'>;
  readonly blobsDir: () => string;
  readonly hostFiles: () => Pick<FilesService, 'stat' | 'readBytes'>;
  readonly log?: Pick<Context['logger'], 'debug' | 'info'>;
}

export interface PdfPageImageBytes {
  bytes: Uint8Array;
  mimeType: string;
  storedSize: number;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * handlers.rs:2943-3103 `read_pdf_page_image_bytes`: shared by
 * `vfs_get_pdf_page_image` and the `pdf_page_image` tool. Throws plain
 * `Error`s carrying the Rust `Err(String)` text.
 */
export async function readPdfPageImageBytes(
  source: PdfPageImageSource,
  resourceId: string,
  pageIndex: number,
  maxBytes: number | null,
): Promise<PdfPageImageBytes> {
  source.log?.debug('[VFS::handlers] vfs_get_pdf_page_image: resource_id=%s, page_index=%d', resourceId, pageIndex);
  let conn: DatabaseHandle;
  try { conn = source.conn(); } catch (error) { throw new Error(`获取数据库连接失败: ${errorText(error)}`); }
  let resource;
  try { resource = source.resources.getResource(conn, resourceId); }
  catch (error) { throw new Error(`获取资源失败: ${errorText(error)}`); }
  if (resource === null) throw new Error(`资源不存在: ${resourceId}`);

  const sourceTable = resource.sourceTable ?? null;
  const preview = previewJsonForSource(conn, resourceId, sourceTable);
  if (preview === null || preview.previewJson === null) {
    throw new Error(
      `资源无 PDF 预渲染数据: ${resourceId} (source_table: ${sourceTable === null ? 'None' : `Some(${JSON.stringify(sourceTable)})`})`,
    );
  }

  const isExam = sourceTable === 'exam_sheets';
  let blobHash: string;
  let mimeType: string;
  if (isExam) {
    const pages = parsePreview(preview.previewJson, true).pages as ExamPreviewPage[];
    const page = pages.find(candidate => candidate.page_index === pageIndex);
    if (page === undefined) {
      throw new Error(`页码越界: page_index=${pageIndex}, total_pages=${pages.length}`);
    }
    const hash = page.blob_hash;
    if (hash == null) throw new Error(`页面 ${pageIndex} 无 blob_hash（可能是旧数据）`);
    blobHash = hash;
    mimeType = 'image/png';
  } else {
    const parsed = parsePreview(preview.previewJson, false) as { pages: PreviewPage[]; totalPages: number };
    const page = parsed.pages.find(candidate => candidate.pageIndex === pageIndex);
    if (page === undefined) {
      throw new Error(`页码越界: page_index=${pageIndex}, total_pages=${parsed.totalPages}`);
    }
    const original = page.blobHash;
    const compressed = page.compressedBlobHash ?? null;
    const pageMime = page.mimeType;
    if (compressed !== null && compressed !== '') {
      blobHash = compressed;
      mimeType = compressed !== original ? 'image/jpeg' : pageMime;
    } else {
      blobHash = original;
      mimeType = pageMime;
    }
  }

  let blob;
  try { blob = source.blobs.getBlob(conn, blobHash); }
  catch (error) { throw new Error(`获取 blob 元数据失败: ${errorText(error)}`); }
  if (blob === null) throw new Error(`Blob 不存在: ${blobHash}`);
  let path;
  try { path = source.blobs.getBlobPath(conn, source.blobsDir(), blobHash); }
  catch (error) { throw new Error(`获取 blob 路径失败: ${errorText(error)}`); }
  if (path === null) throw new Error(`Blob 文件路径不存在: ${blobHash}`);

  if (maxBytes !== null) {
    let sourceSize: number;
    try { sourceSize = (await source.hostFiles().stat(path)).size; }
    catch (error) { throw new Error(`读取 blob 元数据失败: ${errorText(error)}`); }
    if (sourceSize > maxBytes) {
      throw new Error(`PDF page image exceeds source limit: ${sourceSize} > ${maxBytes} bytes`);
    }
  }
  let data: Uint8Array;
  try { data = await source.hostFiles().readBytes(path); }
  catch (error) { throw new Error(`读取 blob 文件失败: ${errorText(error)}`); }
  if (maxBytes !== null && data.byteLength > maxBytes) {
    throw new Error(`PDF page image exceeded source limit while reading: ${data.byteLength} bytes`);
  }
  source.log?.info('[VFS::handlers] vfs_get_pdf_page_image: resource_id=%s, page_index=%d, size=%d bytes',
    resourceId, pageIndex, data.byteLength);
  return { bytes: data, mimeType, storedSize: blob.size };
}

/** handlers.rs:3106 `vfs_get_pdf_page_image`: `read_pdf_page_image_bytes(.., None)` → base64. */
export async function getPdfPageImage(deps: PdfDeps, resourceId: string, pageIndex: number): Promise<VfsBlobBase64Result> {
  try {
    const page = await readPdfPageImageBytes(deps, resourceId, pageIndex, null);
    return {
      base64: toBase64(page.bytes),
      mimeType: page.mimeType,
      size: page.storedSize,
    };
  } catch (error) {
    return fail(error);
  }
}
