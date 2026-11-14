/**
 * handlers.rs:7311-7587 `vfs_download_paper` / `save_downloaded_paper_blocking`.
 *
 * Download: reqwest (90 s total timeout, default redirect policy = 10 hops) →
 * `ctx.http.fetch` (desktop undici / mobile native HTTP) with the same total
 * timeout; the timeout spans headers and body like reqwest's.
 * Save: same TD-03 saga as `vfs_upload_file` through L11/L12 owner APIs.
 */
import { createWebCrypto } from '../../../platform/crypto/web.ts';
import { toHex } from '../../../platform/crypto/encoding.ts';
import type { HttpService } from '../../../platform/http/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { VfsFile } from '../../vfs-repos/api.ts';
import { message, ownerAttachmentProcessing, renderPreview, type FileUploadDeps } from './upload-file.ts';

/** handlers.rs:7315-7324. */
export interface VfsDownloadPaperParams { url: string; title: string; folderId?: string | null }
/** handlers.rs:7326-7335 (no skip_serializing_if: None → null). */
export interface VfsDownloadPaperResult {
  success: boolean; fileId: string | null; fileName: string | null; sizeBytes: number | null;
  pageCount: number | null; error: string | null;
}

export type PaperSaveDeps = Pick<FileUploadDeps, 'conn' | 'blobsDir' | 'repos' | 'unitBuilder' | 'pdf' | 'createSaga'
  | 'withSavepoint' | 'log'> & {
  /** `ctx.http`：只接受 HTTPS（与 Rust 相同），不套 `destination: 'public'` 判定。 */
  readonly http: Pick<HttpService, 'fetch'> | null;
};

const DOWNLOAD_TIMEOUT_MS = 90_000;

export async function downloadPaperCommand(deps: PaperSaveDeps, params: VfsDownloadPaperParams) {
  try { return await downloadPaper(deps, params); }
  catch (error) { throw error instanceof CommandError ? error : new CommandError(message(error)); }
}

async function fetchPdf(http: Pick<HttpService, 'fetch'>, url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await http.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'DeepStudent/1.0 (Academic Paper Save)' },
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
  } catch (error) { throw new Error(`Download failed: ${message(error)}`); }
  if (response.status < 200 || response.status > 299) {
    // boundary-allow empty-catch: reqwest drops the body of a non-success response without reading it
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${response.status}`);
  }
  try { return new Uint8Array(await response.arrayBuffer()); }
  catch (error) { throw new Error(`Read failed: ${message(error)}`); }
}

async function downloadPaper(deps: PaperSaveDeps, params: VfsDownloadPaperParams): Promise<VfsDownloadPaperResult> {
  deps.log.info("[VFS::download_paper] Downloading '%s' from: %s", params.title, params.url);
  if (!params.url.startsWith('https://')) throw new Error('Only HTTPS URLs are allowed');
  if (deps.http === null) throw new Error('http service is not available');
  const pdfBytes = await fetchPdf(deps.http, params.url);
  return saveDownloadedPaper(deps, params, pdfBytes);
}

async function saveDownloadedPaper(deps: PaperSaveDeps, params: VfsDownloadPaperParams,
  pdfBytes: Uint8Array): Promise<VfsDownloadPaperResult> {
  const { log, repos } = deps;
  if (pdfBytes.length < 4 || pdfBytes[0] !== 0x25 || pdfBytes[1] !== 0x50 || pdfBytes[2] !== 0x44 || pdfBytes[3] !== 0x46) {
    throw new Error('Downloaded file is not a valid PDF');
  }
  const sha256 = toHex(await createWebCrypto().digest('SHA-256', pdfBytes));
  const conn = deps.conn();
  // `if let Ok(Some(existing))`: lookup errors fall through to a fresh save.
  let existing: VfsFile | null = null;
  try { existing = repos.files.getBySha256(conn, sha256); } catch { existing = null; }
  if (existing !== null && existing.status === 'active') {
    return { success: true, fileId: existing.id, fileName: null, sizeBytes: pdfBytes.length,
      pageCount: existing.pageCount ?? null, error: null };
  }

  const blobsDir = deps.blobsDir();
  const saga = deps.createSaga();
  const processing = ownerAttachmentProcessing(repos);
  const { previewJson, extractedText, pageCount } = await renderPreview(deps, processing, conn, blobsDir, pdfBytes, saga,
    '[VFS::download_paper]');

  const safeTitle = params.title.replace(/[/\\:*?"<>|\0]/g, '_');
  const fileName = safeTitle.toLowerCase().endsWith('.pdf') ? safeTitle : `${safeTitle}.pdf`;
  const folderId = params.folderId !== undefined && params.folderId !== null && params.folderId !== '' ? params.folderId : null;

  let saved: [string, VfsFile, boolean];
  try {
    saved = deps.withSavepoint(conn, 'vfs_download_paper_saga', () => {
      const blobHash = repos.blobs.storeBlob(conn, blobsDir, pdfBytes, 'application/pdf', 'pdf').hash;
      const [file, created] = repos.files.createFileWithDocDataInFolderOutcome(conn, sha256, fileName, pdfBytes.length,
        'pdf', 'application/pdf', blobHash, null, folderId, previewJson, extractedText, pageCount);
      return [blobHash, file, created] as [string, VfsFile, boolean];
    });
  } catch (error) {
    log.warn('[VFS::download_paper] 保存事务失败，已回滚 DB 写入，开始补偿: %s', message(error));
    saga.abort(conn, blobsDir);
    try { repos.blobs.removeUnregisteredBlobFile(conn, blobsDir, sha256); }
    catch (cleanupError) {
      log.error('[VFS::download_paper] 补偿删除孤儿 blob 文件失败（内容寻址可自愈）: %s', message(cleanupError));
    }
    throw new Error(`File creation failed: ${message(error)}`);
  }
  const [blobHash, file, created] = saved;
  if (created) saga.commit();
  else {
    saga.recordBlobRef(blobHash);
    saga.abort(conn, blobsDir);
  }

  if (file.resourceId !== undefined) {
    try {
      deps.unitBuilder.syncResourceUnits({
        resourceId: file.resourceId, resourceType: 'file', data: null, ocrText: null, ocrPagesJson: null,
        blobHash: file.blobHash ?? null, pageCount: file.pageCount ?? null,
        extractedText: file.extractedText ?? null, previewJson: file.previewJson ?? null,
      });
    } catch (error) {
      log.warn('[VFS::download_paper] Failed to sync units for %s: %s (queued for background retry)',
        file.resourceId, message(error));
      try { repos.indexStates.markFailed(deps.conn(), file.resourceId, message(error)); }
      catch (markError) {
        log.error('[VFS::download_paper] Failed to mark index retry state for %s: %s', file.resourceId, message(markError));
      }
    }
  }

  // tokio::spawn + `let _ =`: detached, result discarded.
  const fileId = file.id;
  // boundary-allow empty-catch: Rust `let _ = service.start_pipeline(..).await` discards the result
  queueMicrotask(() => { deps.pdf.startPipeline(fileId, 'ocr_processing').catch(() => undefined); });

  return { success: true, fileId: file.id, fileName, sizeBytes: pdfBytes.length, pageCount, error: null };
}
