/**
 * Rust `dstu-vision/src/pdf_ocr_service.rs` (PdfOcrService) and the four session commands in
 * `src/commands.rs:727-871`. Page OCR is delegated to L02 (`callOcrPageWithFallback`, Rust
 * `LLMManager::call_ocr_page_with_fallback`); rendering uses F7 `nativePdfium` + `nativeImage`.
 *
 * Two Rust behaviours are kept verbatim on purpose:
 * - upload sessions (`init_pdf_ocr_session`) keep their cancel/pause senders inside the session
 *   object only; they are never inserted into the cancel/pause maps, so cancel/pause commands
 *   return false for them;
 * - `skip_pdf_ocr_page` populates the skip set but no worker ever reads it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import { isAbsolute, join, relative } from '../../../platform/util/path.ts';
import { AppError, type JsonValue } from '../../../platform/errors/api.ts';
import { CommandError } from '../../../kernel/api.ts';
import { llmOcrPagesService } from '../../llm/api.ts';
import type { ApiConfig, ExamSegmentationCard, LlmOcrPages } from '../../llm/api.ts';
import type { OcrEngineType } from '../../llm-providers/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type {
  PdfOcrPageInput, PdfOcrRequest, PdfOcrResult, PdfOcrTextBlock,
} from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import { Base64DecodeError, decodeBase64Standard } from './base64.ts';
import { resolveImagePath } from './exam-sheet-service.ts';
import { BoolWatch, BoundedChannel, OcrTaskSet, Semaphore } from './pdf-ocr-sync.ts';
export { BoolWatch, BoundedChannel } from './pdf-ocr-sync.ts';

export const PDF_OCR_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
export const PDF_OCR_CACHE_TARGET_BYTES = 800 * 1024 * 1024;
export const PDF_OCR_IMAGES_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const PDF_OCR_IMAGES_TARGET_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_RENDER_DPI = 150;
export const MAX_RENDER_DPI = 300;
export const MAX_OCR_CONCURRENCY = 4;
export const MAX_RETRY_ATTEMPTS = 3;
export const INITIAL_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 20_000;
/** `mpsc::channel::<PreparedPage>(32)` in `start_session`. */
const UPLOAD_CHANNEL_CAPACITY = 32;
/** image crate `save_with_format(Jpeg)` default encoder quality. */
const RUST_IMAGE_JPEG_QUALITY = 75;

/** L02 `llmOcrPages@1` (call_ocr_page_with_fallback / test_ocr_with_engine). */
export const LLM_OCR_PAGES_SERVICE = llmOcrPagesService.name;

export interface PdfOcrModelsPort {
  getOcrEngineType(): Promise<OcrEngineType>;
  getOcrModelConfig(): Promise<ApiConfig>;
}

export interface PdfOcrLogger {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PdfOcrDeps {
  /** FileManager::get_writable_app_data_dir */
  appDataDir(): string;
  /** FileManager images_dir */
  imagesDir(): string;
  ocrModels(): PdfOcrModelsPort | undefined;
  ocrPages(): LlmOcrPages | undefined;
  pdfium(): NativePdfium | undefined;
  image(): NativeImage | undefined;
  /** `app_handle.emit("pdf_ocr_progress", payload)` */
  emit(payload: Record<string, JsonValue>): void;
  log: PdfOcrLogger;
  /** Overridable for tests; defaults to real timers. */
  sleep?(ms: number): Promise<void>;
}

export interface PreparedPage {
  page_index: number;
  image_rel_path: string;
  width: number;
  height: number;
}

export interface PdfOcrSession {
  pageTx: BoundedChannel<PreparedPage>;
  cancelTx: BoolWatch;
  pauseTx: BoolWatch;
}

interface ErrorLike { message: string; details: JsonValue }

/** AppError-shaped view of a thrown value; `to_string()` is the message. */
export function errorLike(error: unknown): ErrorLike {
  const value = error instanceof CommandError ? error.value : error;
  if (value !== null && typeof value === 'object' && 'message' in value
    && typeof (value as { message: unknown }).message === 'string') {
    const details = (value as { details?: unknown }).details;
    return { message: (value as { message: string }).message, details: (details ?? null) as JsonValue };
  }
  if (typeof value === 'string') return { message: value, details: null };
  return { message: String(value), details: null };
}

function asU64(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** `PdfOcrService::rate_limit_hint` */
export function rateLimitHint(error: ErrorLike): [number, string] | null {
  const details = error.details;
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    if (asU64(details.status) === 429) {
      const ms = asU64(details.retry_after_ms);
      if (ms !== null) return [ms, 'retry_after_ms'];
      const seconds = asU64(details.retry_after_seconds);
      if (seconds !== null) return [Math.min(seconds * 1000, Number.MAX_SAFE_INTEGER), 'retry_after_seconds'];
      return [0, 'status'];
    }
  }
  const message = error.message.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
    return [0, 'message'];
  }
  return null;
}

/** pdfium-render 0.9.4 `PdfRenderConfig::apply_to_page` for target_width + maximum_height (f32 math). */
export function renderSize(pageWidth: number, pageHeight: number, dpi: number): { width: number; height: number } {
  const f = Math.fround;
  const sw = f(pageWidth);
  const sh = f(pageHeight);
  const targetWidth = Math.trunc(f(f(dpi) * f(8.5)));
  const maxHeight = Math.trunc(f(f(dpi) * f(14.0)));
  let scale = f(f(targetWidth) / sw);
  if (f(sh * scale) > f(maxHeight)) scale = f(f(maxHeight) / sh);
  return { width: Math.round(f(sw * scale)), height: Math.round(f(sh * scale)) };
}

/** `PdfOcrService::normalize_base64` */
export function normalizeBase64(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('data:') ? trimmed : `data:image/png;base64,${trimmed}`;
}

/** `FileManager::extract_extension_from_base64` restricted to data URLs (the only caller input). */
function extensionFromDataUrl(dataUrl: string): string | null {
  const semi = dataUrl.indexOf(';');
  if (semi < 0) return null;
  const mime = dataUrl.slice(5, semi);
  if (!mime.startsWith('image/')) return null;
  switch (mime) {
    case 'image/jpeg': case 'image/jpg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/bmp': return 'bmp';
    case 'image/tiff': return 'tiff';
    case 'image/heic': return 'heic';
    case 'image/heif': return 'heif';
    default: return null;
  }
}

function base64Error(error: unknown): string {
  return error instanceof Base64DecodeError ? error.message : String(error);
}

/** `FileManager::sanitize_pdf_file_name` */
export function sanitizePdfFileName(hint: string | null | undefined): string {
  const candidate = (hint ?? 'document.pdf').trim();
  let sanitized = Array.from(candidate).map((c) => (/^[A-Za-z0-9.\-_]$/.test(c) ? c : '_')).join('');
  if (sanitized === '') sanitized = 'document';
  sanitized = sanitized.replace(/^[._-]+/, '').replace(/[._-]+$/, '');
  if (sanitized === '') sanitized = 'document';
  if (!sanitized.toLowerCase().endsWith('.pdf')) sanitized += '.pdf';
  return sanitized;
}

function utcTimestamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}_${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(error: AppError): never { throw new CommandError(error); }

function pageFile(cacheDir: string, pageIndex: number, ext: string): string {
  return join(cacheDir, `page_${String(pageIndex).padStart(5, '0')}.${ext}`);
}

function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

function parseCachedBlocks(bytes: Buffer): PdfOcrTextBlock[] {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(value)) throw new Error('invalid type: expected a sequence');
  return value.map((item: unknown) => {
    const block = item as { text?: unknown; bbox?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } };
    if (block === null || typeof block !== 'object' || typeof block.text !== 'string'
      || block.bbox === null || typeof block.bbox !== 'object'
      || !isFiniteNumber(block.bbox.x) || !isFiniteNumber(block.bbox.y)
      || !isFiniteNumber(block.bbox.width) || !isFiniteNumber(block.bbox.height)) {
      throw new Error('invalid PdfOcrTextBlock');
    }
    return { text: block.text, bbox: { x: block.bbox.x, y: block.bbox.y, width: block.bbox.width, height: block.bbox.height } };
  });
}

export class PdfOcrService {
  private readonly deps: PdfOcrDeps;
  constructor(deps: PdfOcrDeps) { this.deps = deps; }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  private emitProgress(payload: Record<string, JsonValue>): void {
    try { this.deps.emit(payload); } catch { // boundary-allow empty-catch: Rust ignores emit errors
    }
  }

  private emitError(sessionId: string, page: number, msg: string): void {
    this.emitProgress({ type: 'PageFailed', session_id: sessionId, page_index: page, error: msg });
  }

  /** `LLMManager::get_pdf_ocr_model_config` */
  private async getPdfOcrModelConfig(): Promise<ApiConfig> {
    const models = this.deps.ocrModels();
    if (models === undefined) throw new CommandError(AppError.configuration('OCR 模型服务不可用'));
    const engineType = await models.getOcrEngineType();
    const config = await models.getOcrModelConfig();
    this.deps.log.debug?.(`[OCR] PDF OCR 使用引擎 ${engineType}，模型: id=${config.id}, model=${config.model}`);
    return config;
  }

  private ocrPages(): LlmOcrPages {
    const pages = this.deps.ocrPages();
    if (pages === undefined) throw new CommandError(AppError.configuration('OCR 页面服务不可用'));
    return pages;
  }

  private async callOcrPage(pagePath: string, pageIndex: number): Promise<ExamSegmentationCard[]> {
    return this.ocrPages().callOcrPageWithFallback(pagePath, pageIndex, 'FreeText');
  }

  // ---------------------------------------------------------------- upload-driven session

  async startSession(pdfBase64: string, pdfName: string | null, totalPages: number):
    Promise<[string, PdfOcrSession]> {
    const tempId = randomUUID();
    const [, pdfAbsPath] = await this.savePdfFromBase64(pdfBase64, pdfName, tempId);
    let pdfBytes: Buffer;
    try { pdfBytes = await fsp.readFile(pdfAbsPath); }
    catch (error) { fail(AppError.file_system(`读取PDF失败: ${messageOf(error)}`)); }
    const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
    const cacheDir = join(this.deps.appDataDir(), 'pdf_ocr_cache', pdfHash);
    try { await fsp.mkdir(cacheDir, { recursive: true }); }
    catch (error) { this.deps.log.warn(`[PDF-OCR] 创建缓存目录失败: ${messageOf(error)}`); }
    await this.enforceCacheBudget([cacheDir]);

    const session: PdfOcrSession = {
      pageTx: new BoundedChannel<PreparedPage>(UPLOAD_CHANNEL_CAPACITY),
      cancelTx: new BoolWatch(false),
      pauseTx: new BoolWatch(false),
    };
    // run_worker owns page_rx: every exit (return or panic) drops it, failing pending and later sends.
    void this.runWorker(tempId, totalPages, session, cacheDir).catch((error: unknown) => {
      this.deps.log.error(`[PdfOcrService] OCR worker crashed: ${messageOf(error)}`);
    }).finally(() => session.pageTx.closeReceiver());
    return [tempId, session];
  }

  async addPage(pageTx: BoundedChannel<PreparedPage>, sessionId: string, page: PdfOcrPageInput): Promise<void> {
    const prepared = await this.preparePageImage(sessionId, page);
    if (!(await pageTx.send(prepared))) fail(AppError.new('Unknown', 'OCR session closed'));
  }

  /** `process_pdf` with an AppHandle (the command always supplies one). */
  async processPdf(request: PdfOcrRequest): Promise<PdfOcrResult> {
    const [sessionId, session] = await this.startSession(
      request.pdf_base64, request.pdf_name ?? null, request.pages.length);
    try {
      for (const page of request.pages) await this.addPage(session.pageTx, sessionId, page);
    } finally {
      // The session is a local in Rust: dropping it drops page_tx.
      session.pageTx.close();
    }
    return { temp_id: sessionId, source_pdf_path: '', pdfstream_url: '', page_results: [] };
  }

  private async runWorker(tempId: string, totalPages: number, session: PdfOcrSession, cacheDir: string): Promise<void> {
    const { log } = this.deps;
    const cancelRx = session.cancelTx;
    const pauseRx = session.pauseTx;
    const pageRx = session.pageTx;
    log.info(`[PDF-OCR] Worker started: ${tempId}`);
    try { this.deps.emit({ type: 'Started', total_pages: totalPages, session_id: tempId }); }
    catch (error) { log.warn(`[PDF-OCR] Emit error: ${messageOf(error)}`); }

    const counter = { completed: 0 };
    const failedPages: Array<[number, string]> = [];
    const allResults = new Map<number, [PreparedPage, PdfOcrTextBlock[]]>();

    try { await this.getPdfOcrModelConfig(); }
    catch (error) {
      this.emitError(tempId, 0, errorLike(error).message);
      this.emitProgress({
        type: 'Completed', session_id: tempId, total_pages: totalPages, success_count: 0,
        failed_count: totalPages, has_failures: true, cancelled: false,
      });
      return;
    }

    const semaphore = new Semaphore(MAX_OCR_CONCURRENCY);
    const tasks = new OcrTaskSet();
    const aborted = { value: false };
    let processedCount = 0;
    let cancelled = false;

    for (;;) {
      if (cancelRx.value) { cancelled = true; break; }
      while (pauseRx.value) {
        this.emitProgress({ type: 'Paused', session_id: tempId });
        await this.sleep(500);
        if (cancelRx.value) { cancelled = true; break; }
      }
      if (cancelled) break;

      if (processedCount === totalPages) {
        // Rust :1094-1097 discards these join results, unlike the final drain below.
        await tasks.drain();
        break;
      }
      const page = await pageRx.recv();
      if (page === null) break;
      const release = await semaphore.acquire();
      tasks.add(this.ocrTask({
        sessionId: tempId, page, totalPages, cacheDir, cancelRx, counter, allResults, failedPages,
        aborted, emitCachedFlag: null,
      }), release);
      processedCount += 1;

      if (processedCount === totalPages && tasks.size === 0) break;
    }

    if (cancelled) aborted.value = true;
    await tasks.drain(log, cancelled);

    const mapped = [...allResults.values()]
      .map(([p, blocks]) => ({ page_index: p.page_index, width: p.width, height: p.height, image_path: p.image_rel_path, blocks }))
      .sort((a, b) => a.page_index - b.page_index);

    this.emitProgress({
      type: 'Completed', session_id: tempId, total_pages: totalPages, success_count: mapped.length,
      failed_count: failedPages.length, has_failures: failedPages.length > 0, cancelled,
    });
    log.info(`[PDF-OCR] Worker finished: ${tempId} (Success: ${mapped.length})`);
  }

  /** Shared per-page task body of both workers (the cached-flag differs). */
  private async ocrTask(args: {
    sessionId: string; page: PreparedPage; totalPages: number; cacheDir: string; cancelRx: BoolWatch;
    counter: { completed: number }; allResults: Map<number, [PreparedPage, PdfOcrTextBlock[]]>;
    failedPages: Array<[number, string]>; aborted: { value: boolean };
    /** null: upload worker (no `cached` key); boolean key present for backend worker. */
    emitCachedFlag: true | null;
  }): Promise<void> {
    const { sessionId, page, totalPages, cacheDir, cancelRx, counter, allResults, failedPages, aborted } = args;
    const pageIndex = page.page_index;
    if (cancelRx.value || aborted.value) return;

    const cached = await this.loadCachedBlocks(cacheDir, pageIndex);
    if (aborted.value) return;
    if (cached !== null) {
      counter.completed += 1;
      allResults.set(pageIndex, [page, cached]);
      this.emitProgress({
        type: 'PageCompleted', session_id: sessionId, page_index: pageIndex, completed: counter.completed,
        total: totalPages, ...(args.emitCachedFlag === null ? {} : { cached: true }),
        page_result: { page_index: pageIndex, width: page.width, height: page.height, blocks: cached },
      });
      return;
    }

    let attempt = 0;
    let backoff = INITIAL_BACKOFF_MS;
    for (;;) {
      if (cancelRx.value || aborted.value) return;
      let cards: ExamSegmentationCard[];
      try {
        cards = await this.callOcrPage(page.image_rel_path, pageIndex);
      } catch (error) {
        if (aborted.value) return;
        const e = errorLike(error);
        const hint = rateLimitHint(e);
        if (hint !== null && attempt < MAX_RETRY_ATTEMPTS) {
          attempt += 1;
          const [wait, label] = hint;
          const sleepTime = wait === 0 ? backoff : Math.max(wait, backoff);
          this.emitProgress({
            type: 'Retrying', session_id: sessionId, page_index: pageIndex, attempt,
            max_attempts: MAX_RETRY_ATTEMPTS, backoff_ms: sleepTime, hint: label,
          });
          if (await this.sleepWithCancel(cancelRx, sleepTime)) return;
          if (aborted.value) return;
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          continue;
        }
        failedPages.push([pageIndex, e.message]);
        this.emitProgress({ type: 'PageFailed', session_id: sessionId, page_index: pageIndex, error: e.message });
        return;
      }
      if (aborted.value) return;
      counter.completed += 1;
      const blocks: PdfOcrTextBlock[] = cards.map((c) => ({
        text: c.ocr_text ?? '',
        bbox: { x: c.bbox.x, y: c.bbox.y, width: c.bbox.width, height: c.bbox.height },
      }));
      await this.saveCachedBlocks(cacheDir, pageIndex, blocks);
      if (aborted.value) return;
      allResults.set(pageIndex, [page, blocks]);
      this.emitProgress({
        type: 'PageCompleted', session_id: sessionId, page_index: pageIndex, completed: counter.completed,
        total: totalPages, ...(args.emitCachedFlag === null ? {} : { cached: false }),
        page_result: { page_index: pageIndex, width: page.width, height: page.height, blocks },
      });
      return;
    }
  }

  // ---------------------------------------------------------------- backend-driven session

  async startBackendSession(pdfPath: string, pdfName: string | null, renderDpi: number | null):
    Promise<[string, BoolWatch, BoolWatch]> {
    const sessionId = randomUUID();
    const dpi = Math.min(renderDpi ?? DEFAULT_RENDER_DPI, MAX_RENDER_DPI);
    let pdfBytes: Buffer;
    try { pdfBytes = await fsp.readFile(pdfPath); }
    catch (error) { fail(AppError.file_system(`读取 PDF 文件失败: ${messageOf(error)}`)); }
    const pdfHash = createHash('sha256').update(pdfBytes).digest('hex');
    const cacheDir = join(this.deps.appDataDir(), 'pdf_ocr_cache', pdfHash);
    try { await fsp.mkdir(cacheDir, { recursive: true }); }
    catch (error) { this.deps.log.warn(`[PDF-OCR] 创建缓存目录失败: ${messageOf(error)}`); }
    await this.enforceCacheBudget([cacheDir]);

    const sessionImagesDir = join(this.deps.appDataDir(), 'pdf_ocr_images', sessionId);
    try { await fsp.mkdir(sessionImagesDir, { recursive: true }); }
    catch (error) { this.deps.log.warn(`[PDF-OCR] 创建图片目录失败: ${messageOf(error)}`); }
    await this.enforceDirBudget('pdf_ocr_images', [sessionImagesDir], PDF_OCR_IMAGES_MAX_BYTES, PDF_OCR_IMAGES_TARGET_BYTES);

    const cancelTx = new BoolWatch(false);
    const pauseTx = new BoolWatch(false);
    void this.runBackendWorker(sessionId, pdfPath, pdfName, dpi, cacheDir, cancelTx, pauseTx)
      .catch((error: unknown) => {
        this.deps.log.error(`[PdfOcrService] OCR worker crashed: ${messageOf(error)}`);
      });
    return [sessionId, cancelTx, pauseTx];
  }

  private async runBackendWorker(sessionId: string, pdfPath: string, pdfName: string | null, dpi: number,
    cacheDir: string, cancelRx: BoolWatch, pauseRx: BoolWatch): Promise<void> {
    const { log } = this.deps;
    log.info(`[PDF-OCR-Backend] Worker started: ${sessionId}`);
    const imagesDir = join(this.deps.appDataDir(), 'pdf_ocr_images', sessionId);
    try { await fsp.mkdir(imagesDir, { recursive: true }); }
    catch (error) { log.warn(`[PDF-OCR-Backend] 创建图片目录失败: ${messageOf(error)}`); }

    try { await this.getPdfOcrModelConfig(); }
    catch (error) {
      this.emitError(sessionId, 0, errorLike(error).message);
      this.emitProgress({
        type: 'Completed', session_id: sessionId, total_pages: 0, success_count: 0, failed_count: 1,
        has_failures: true, cancelled: false,
      });
      return;
    }

    const renderChannel = new BoundedChannel<PreparedPage>(MAX_OCR_CONCURRENCY * 2);
    const totalPagesHolder = { value: 0 };
    const renderFailed: Array<[number, string]> = [];
    const renderTask = this.renderPages({
      pdfPath, dpi, imagesDir, sessionId, cancelRx, renderChannel, totalPagesHolder, renderFailed,
    }).then(
      (): string | null => null,
      (error: unknown): string => messageOf(error),
    ).finally(() => renderChannel.close());

    const counter = { completed: 0 };
    const failedPages: Array<[number, string]> = [];
    const allResults = new Map<number, [PreparedPage, PdfOcrTextBlock[]]>();
    const semaphore = new Semaphore(MAX_OCR_CONCURRENCY);
    const tasks = new OcrTaskSet();
    const aborted = { value: false };
    let cancelled = false;
    let startedSent = false;

    for (;;) {
      if (cancelRx.value) { cancelled = true; break; }
      while (pauseRx.value) {
        this.emitProgress({ type: 'Paused', session_id: sessionId });
        await this.sleep(500);
        if (cancelRx.value) { cancelled = true; break; }
      }
      if (cancelled) break;

      // `tokio::time::timeout(100ms, render_rx.recv())`
      const received = await renderChannel.recvTimeout(100, (ms) => this.sleep(ms));
      if (received === 'timeout') continue;
      if (received === null) break;
      const rendered = received;
      const pageIndex = rendered.page_index;
      const totalPages = totalPagesHolder.value;
      if (!startedSent) {
        startedSent = true;
        this.emitProgress({
          type: 'Started', session_id: sessionId, total_pages: totalPages, pdf_name: pdfName, render_dpi: dpi,
        });
      }
      const release = await semaphore.acquire();
      tasks.add(this.ocrTask({
        sessionId, page: rendered, totalPages, cacheDir, cancelRx, counter,
        allResults, failedPages, aborted, emitCachedFlag: true,
      }), release);
    }

    // drop(render_rx): unblock a renderer waiting on a full channel.
    renderChannel.closeReceiver();
    const renderError = await renderTask;
    if (renderError !== null) log.error(`[PDF-OCR-Backend] 渲染失败: ${renderError}`);

    if (cancelled) aborted.value = true;
    await tasks.drain(log, cancelled);

    const totalPages = totalPagesHolder.value;
    const successCount = allResults.size;
    const ocrFailedCount = failedPages.length;
    const renderFailedCount = renderFailed.length;
    const totalFailedCount = ocrFailedCount + renderFailedCount;

    if (renderError !== null && successCount === 0) this.emitError(sessionId, 0, renderError);
    if (totalPages === 0 && renderError === null) this.emitError(sessionId, 0, 'PDF 中没有可渲染的页面');

    this.emitProgress({
      type: 'Completed', session_id: sessionId, total_pages: totalPages, success_count: successCount,
      failed_count: totalFailedCount, ocr_failed_count: ocrFailedCount, render_failed_count: renderFailedCount,
      render_failed_pages: renderFailed.map(([idx]) => idx),
      has_failures: totalFailedCount > 0 || renderError !== null, cancelled,
    });
    log.info(`[PDF-OCR-Backend] Worker finished: ${sessionId} (Success: ${successCount}, OCR Failed: ${ocrFailedCount}, Render Failed: ${renderFailedCount})`);
  }

  /** The `spawn_blocking` render thread; rejects with the Rust `Err(String)` messages. */
  private async renderPages(args: {
    pdfPath: string; dpi: number; imagesDir: string; sessionId: string; cancelRx: BoolWatch;
    renderChannel: BoundedChannel<PreparedPage>; totalPagesHolder: { value: number };
    renderFailed: Array<[number, string]>;
  }): Promise<void> {
    const { pdfPath, dpi, imagesDir, sessionId, cancelRx, renderChannel, totalPagesHolder, renderFailed } = args;
    const { log } = this.deps;
    const pdfium = this.deps.pdfium();
    if (pdfium === undefined) throw new Error('加载 Pdfium 库失败: Pdfium 服务不可用');
    const image = this.deps.image();
    let document: Awaited<ReturnType<NativePdfium['open']>>;
    try { document = await pdfium.open(new Uint8Array(await fsp.readFile(pdfPath)), null); }
    catch (error) { throw new Error(`加载 PDF 失败: ${messageOf(error)}`); }
    try {
      const totalPages = document.pageCount;
      totalPagesHolder.value = totalPages;
      log.info(`[PDF-OCR-Backend] PDF 加载成功: ${totalPages} 页`);
      try { await fsp.mkdir(imagesDir, { recursive: true }); }
      catch (error) { throw new Error(`创建图片目录失败: ${messageOf(error)}`); }
      this.emitProgress({ type: 'RenderStarted', session_id: sessionId, total_pages: totalPages });

      const pageFailed = (pageIndex: number, errMsg: string) => {
        log.error(`[PDF-OCR-Backend] 页面 ${pageIndex} ${errMsg}`);
        renderFailed.push([pageIndex, errMsg]);
        this.emitProgress({ type: 'PageRenderFailed', session_id: sessionId, page_index: pageIndex, error: errMsg });
      };

      for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
        if (cancelRx.value) { log.info('[PDF-OCR-Backend] 渲染被取消'); break; }
        let page: Awaited<ReturnType<typeof document.page>>;
        try { page = await document.page(pageIndex); }
        catch (error) { pageFailed(pageIndex, `获取页面失败: ${messageOf(error)}`); continue; }
        const imagePath = pageFile(imagesDir, pageIndex, 'jpg');
        let bitmap: { width: number; height: number; rgba: Uint8Array };
        try {
          const size = renderSize(page.width, page.height, dpi);
          bitmap = await page.render({ width: size.width, height: size.height, annotations: true });
        } catch (error) { pageFailed(pageIndex, `渲染失败: ${messageOf(error)}`); continue; }
        if (image === undefined) { pageFailed(pageIndex, '位图转换失败: 图像服务不可用'); continue; }
        try {
          const jpeg = await image.encode(
            { width: bitmap.width, height: bitmap.height, rgba: bitmap.rgba },
            { format: 'jpeg', quality: RUST_IMAGE_JPEG_QUALITY });
          await fsp.writeFile(imagePath, jpeg);
        } catch (error) { pageFailed(pageIndex, `保存图片失败: ${messageOf(error)}`); continue; }

        this.emitProgress({
          type: 'PageRendered', session_id: sessionId, page_index: pageIndex, rendered: pageIndex + 1, total: totalPages,
        });
        log.debug?.(`[PDF-OCR-Backend] 渲染页面 ${pageIndex + 1}/${totalPages} 完成`);
        const sent = await renderChannel.send({
          page_index: pageIndex, image_rel_path: imagePath, width: bitmap.width, height: bitmap.height,
        });
        if (!sent) { log.error('[PDF-OCR-Backend] 发送渲染页面到 channel 失败'); break; }
      }
    } finally {
      await document.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- helpers

  /** `sleep_with_cancel`: true when cancelled. */
  async sleepWithCancel(cancelRx: BoolWatch, waitMs: number): Promise<boolean> {
    if (waitMs === 0) return cancelRx.value;
    if (cancelRx.value) return true;
    const result = await Promise.race([
      this.sleep(waitMs).then(() => false),
      cancelRx.changed().then(() => cancelRx.value),
    ]);
    return result;
  }

  async enforceCacheBudget(keepDirs: string[]): Promise<void> {
    await this.enforceDirBudget('pdf_ocr_cache', keepDirs, PDF_OCR_CACHE_MAX_BYTES, PDF_OCR_CACHE_TARGET_BYTES);
  }

  /** `enforce_dir_budget`: LRU over first-level subdirectories of `<appData>/<rootName>`. */
  async enforceDirBudget(rootName: string, keepDirs: string[], maxBytes: number, targetBytes: number): Promise<void> {
    const { log } = this.deps;
    const cacheRoot = join(this.deps.appDataDir(), rootName);
    try { await fsp.stat(cacheRoot); } catch { return; }
    const keep = new Set<string>();
    for (const dir of keepDirs) {
      try { keep.add(await fsp.realpath(dir)); }
      catch (error) { log.warn(`[PdfOcrService] canonicalize error for "${dir}" (skipped): ${messageOf(error)}`); }
    }
    try {
      let totalBytes = 0;
      const entries: Array<[string, number, number]> = [];
      for (const name of await fsp.readdir(cacheRoot)) {
        const path = join(cacheRoot, name);
        try { if (!(await fsp.stat(path)).isDirectory()) continue; } catch { continue; }
        let canonical: string;
        try { canonical = await fsp.realpath(path); } catch { continue; }
        if (keep.has(canonical)) continue;
        const dirSize = await this.walkSize(path);
        let modified = 0;
        try { modified = (await fsp.stat(path)).mtimeMs; } catch { modified = 0; }
        totalBytes += dirSize;
        entries.push([path, dirSize, modified]);
      }
      if (totalBytes <= maxBytes) return;
      entries.sort((a, b) => a[2] - b[2]);
      for (const [path, size] of entries) {
        if (totalBytes <= targetBytes) break;
        try {
          await fsp.rm(path, { recursive: true });
          totalBytes = Math.max(0, totalBytes - size);
        } catch (error) {
          log.warn(`[PDF-OCR] 清理缓存目录失败 ${path}: ${messageOf(error)}`);
        }
      }
    } catch { // boundary-allow empty-catch: Rust discards the io::Error inside the blocking closure (only JoinError is logged)
    }
  }

  /** WalkDir (no symlink following) summing regular-file sizes. */
  private async walkSize(dir: string): Promise<number> {
    let total = 0;
    let entries: Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (error) { this.deps.log.warn(`[PdfOcrService] WalkDir entry error (skipped): ${messageOf(error)}`); return 0; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += await this.walkSize(path);
      else {
        try {
          const meta = await fsp.stat(path);
          if (meta.isFile()) total += (await fsp.lstat(path)).size;
        } catch { // boundary-allow empty-catch: WalkDir metadata error is skipped like Rust
        }
      }
    }
    return total;
  }

  async loadCachedBlocks(cacheDir: string, pageIndex: number): Promise<PdfOcrTextBlock[] | null> {
    const path = pageFile(cacheDir, pageIndex, 'json');
    let bytes: Buffer;
    try { bytes = await fsp.readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log.warn(`[PDF-OCR] 读取缓存失败 (${path}): ${messageOf(error)}`);
      }
      return null;
    }
    try { return parseCachedBlocks(bytes); }
    catch (error) {
      this.deps.log.warn(`[PDF-OCR] 读取缓存解析失败 (${path}): ${messageOf(error)}`);
      return null;
    }
  }

  async saveCachedBlocks(cacheDir: string, pageIndex: number, blocks: PdfOcrTextBlock[]): Promise<void> {
    const path = pageFile(cacheDir, pageIndex, 'json');
    try { await fsp.writeFile(path, JSON.stringify(blocks)); }
    catch (error) { this.deps.log.warn(`[PDF-OCR] 写入缓存失败 (${path}): ${messageOf(error)}`); }
  }

  /** `FileManager::save_pdf_from_base64` → (relative, absolute). */
  async savePdfFromBase64(base64Data: string, fileNameHint: string | null, tempId: string): Promise<[string, string]> {
    const writable = this.deps.appDataDir();
    const baseDir = join(writable, 'pdf_ocr_sessions', tempId);
    try { await fsp.mkdir(baseDir, { recursive: true }); }
    catch (error) { fail(AppError.file_system(`创建PDF目录失败: ${messageOf(error)}`)); }
    const trimmed = base64Data.trim();
    const idx = trimmed.indexOf('base64,');
    const payload = idx >= 0 ? trimmed.slice(idx + 7) : trimmed;
    let bytes: Uint8Array;
    try { bytes = decodeBase64Standard(payload); }
    catch (error) { fail(AppError.validation(`base64解码失败: ${base64Error(error)}`)); }
    const finalName = `${utcTimestamp()}_${sanitizePdfFileName(fileNameHint)}`;
    const filePath = join(baseDir, finalName);
    try { await fsp.writeFile(filePath, bytes); }
    catch (error) { fail(AppError.file_system(`写入PDF文件失败: ${messageOf(error)}`)); }
    const rel = relative(writable, filePath);
    return [rel.startsWith('..') || isAbsolute(rel) ? filePath : rel, filePath];
  }

  /** `prepare_page_image` (+ FileManager::save_image_from_base64). */
  async preparePageImage(tempId: string, page: PdfOcrPageInput): Promise<PreparedPage> {
    const base64 = normalizeBase64(page.image_base64);
    const ext = extensionFromDataUrl(base64) ?? 'png';
    const fileName = `pdfocr_${tempId}_p${page.page_index}.${ext}`;
    const imagesDir = this.deps.imagesDir();
    try { await fsp.mkdir(imagesDir, { recursive: true }); }
    catch (error) { fail(AppError.file_system(`创建图片目录失败: ${messageOf(error)}`)); }
    let start = 0;
    if (base64.startsWith('data:image/')) {
      const idx = base64.indexOf('base64,');
      if (idx < 0) fail(AppError.validation('无效的base64数据格式'));
      start = idx + 7;
    }
    let bytes: Uint8Array;
    try { bytes = decodeBase64Standard(base64.slice(start)); }
    catch (error) { fail(AppError.validation(`base64解码失败: ${base64Error(error)}`)); }
    try { await fsp.writeFile(join(imagesDir, fileName), bytes); }
    catch (error) { fail(AppError.file_system(`保存图片文件失败: ${messageOf(error)}`)); }
    const imageRelPath = `images/${fileName}`;

    let width: number;
    let height: number;
    if (page.width != null && page.height != null && page.width > 0 && page.height > 0) {
      width = page.width;
      height = page.height;
    } else {
      const absPath = resolveImagePath(imagesDir, imageRelPath, this.deps.log);
      const image = this.deps.image();
      try {
        if (image === undefined) throw new Error('图像服务不可用');
        ({ width, height } = await image.dimensions(new Uint8Array(await fsp.readFile(absPath))));
      } catch (error) {
        fail(AppError.file_system(`读取图片尺寸失败: ${messageOf(error)}`));
      }
    }
    return { page_index: page.page_index, image_rel_path: imageRelPath, width, height };
  }
}
