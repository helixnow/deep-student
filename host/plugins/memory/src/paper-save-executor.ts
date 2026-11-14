/**
 * `PaperSaveExecutor` — Rust `src-tauri/src/chat_v2/tools/paper_save_executor.rs`
 * (`paper_save`: resolve sources → download with NDJSON progress → dedupe → VFS save;
 * `cite_format`: BibTeX / GB/T 7714 / APA).
 *
 * The VFS side (blob store, preview render, file row, unit sync, media pipeline)
 * is owned by the vfs plugin and reached only through the `paperLibrary` port;
 * an unmounted port is the Rust "VFS database not available". Unpaywall goes through
 * the L02 `llmHttp` client like the academic search executor; PDF downloads go through
 * `ctx.http` as public destinations and never reach local addresses.
 */
import type { ExecutionContext, ToolCall, ToolConcurrency, ToolExecutor, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import type { CryptoService } from '../../../platform/crypto/api.ts';
import type { HttpService } from '../../../platform/http/api.ts';
import { truncateUtf8, utf8ByteLength } from '../../../platform/util/portable.ts';
import type { AcademicFetch } from './academic-search-executor.ts';
import { formatCitation, localizedPaperFailure, paperSaveCanHandle, paperSaveSensitivity, sanitizeFilename,
  stripToolNamespace } from './paper-save.ts';
import { runResearchTool, toolErrorText, type ResearchToolLog } from './research-tool-runner.ts';
import { withLocalizedMessage } from './tool-errors.ts';

const MAX_BATCH_SIZE = 5;
const PDF_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_PDF_SIZE = 50 * 1024 * 1024;
export const UNPAYWALL_API_URL = 'https://api.unpaywall.org/v2';
const UNPAYWALL_TIMEOUT_MS = 15_000;
const UA = 'DeepStudent/1.0 (Academic Paper Save; mailto:support@deepstudent.app)';
const PROGRESS_BYTES_INTERVAL = 512 * 1024;
const MB = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** reqwest `Policy::limited(10)`. */
const MAX_REDIRECTS = 10;

export interface PaperPreview { previewJson: string | null; extractedText: string | null; pageCount: number }
export interface PaperFileInput {
  sha256: string; fileName: string; sizeBytes: number; blobHash: string; folderId: string | null;
  previewJson: string | null; extractedText: string | null; pageCount: number | null;
}
export interface PaperFileRecord {
  id: string; resourceId: string | null; pageCount: number | null;
  extractedText: string | null; previewJson: string | null;
}
export interface PaperUnitInput {
  resourceId: string; blobHash: string; pageCount: number | null;
  extractedText: string | null; previewJson: string | null;
}

/** VFS owner operations used by paper_save (vfs plugin). */
export interface PaperLibraryPort {
  /** `VfsFileRepo::get_by_sha256_with_conn`. */
  getFileBySha256(sha256: string): { id: string; status: string } | null;
  /** `VfsBlobRepo::store_blob_with_conn(.., Some("application/pdf"), None)`; returns the blob hash. */
  storeBlob(bytes: Uint8Array): string;
  /** `render_pdf_preview(.., PdfPreviewConfig::default())`. */
  renderPreview(bytes: Uint8Array): Promise<PaperPreview>;
  /** `VfsFileRepo::create_file_with_doc_data_in_folder(.., "pdf", Some("application/pdf"), .., None, ..)`. */
  createFile(input: PaperFileInput): PaperFileRecord;
  /** `VfsIndexService::sync_resource_units` (resource type `file`); returns the unit count. */
  syncResourceUnits(input: PaperUnitInput): number;
  /** `ctx.pdf_processing_service.start_pipeline(file_id, Some(OcrProcessing))`; absent ⇔ no service. */
  startPipeline?(fileId: string): Promise<void>;
}

export interface PaperSaveExecutorDeps {
  http(): { fetch: AcademicFetch } | null;
  /** `ctx.http`: PDF URLs come from the model or Unpaywall, so downloads use `destination: 'public'`. */
  publicHttp(): Pick<HttpService, 'fetch'> | null;
  library(): PaperLibraryPort | null;
  crypto(): CryptoService;
  log: ResearchToolLog & { error(message: string): void };
  unpaywallUrl?: string;
}

type Json = Record<string, unknown>;
type Stage = 'resolving' | 'downloading' | 'deduplicating' | 'storing' | 'processing' | 'indexing' | 'done' | 'error';

interface ProgressItem {
  index: number; title: string; stage: Stage; percent: number;
  downloaded: number | null; totalBytes: number | null; fileId: string | null; deduplicated: boolean;
  error: string | null; source: string | null; sources: Array<{ label: string; url: string }> | null;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function jsonType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (isRecord(value)) return 'object';
  return 'other';
}

/** Rust `{:?}` of `Vec<String>`. */
function debugKeys(keys: readonly string[]): string {
  return `[${keys.map(key => JSON.stringify(key)).join(', ')}]`;
}

function serializeProgress(item: ProgressItem): Json {
  return {
    i: item.index, t: item.title, s: item.stage, pct: item.percent,
    ...(item.downloaded === null ? {} : { dl: item.downloaded }),
    ...(item.totalBytes === null ? {} : { total: item.totalBytes }),
    ...(item.fileId === null ? {} : { fid: item.fileId }),
    ...(item.deduplicated ? { dedup: true } : {}),
    ...(item.error === null ? {} : { err: item.error }),
    ...(item.source === null ? {} : { src: item.source }),
    ...(item.sources === null ? {} : { srcs: item.sources }),
  };
}

function emitProgress(ctx: ExecutionContext, papers: readonly ProgressItem[]): void {
  ctx.emitter.emitChunk('tool_call', ctx.block_id, `${JSON.stringify({ papers: papers.map(serializeProgress) })}\n`, null);
}

class DownloadCancelled extends Error {}

/**
 * `localhost`, `*.localhost`, 127/8, `::1` and IPv4-mapped loopback. WHATWG URL parsing already
 * canonicalizes `127.1` / `0x7f000001` / `2130706433` to dotted decimal and IPv6 to compressed lowercase.
 */
function isLocalUrl(href: string): boolean {
  let url: URL;
  try { url = new URL(href); } catch { return false; }
  const host = url.hostname.replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || host === '[::1]') return true;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(host);
  return mapped !== null && parseInt(mapped[1]!, 16) >> 8 === 127;
}

export class PaperSaveExecutor implements ToolExecutor {
  private readonly deps: PaperSaveExecutorDeps;

  constructor(deps: PaperSaveExecutorDeps) {
    this.deps = deps;
  }

  name(): string { return 'PaperSaveExecutor'; }
  canHandle(toolName: string): boolean { return paperSaveCanHandle(toolName); }
  sensitivityLevel(toolName: string): ToolSensitivity { return paperSaveSensitivity(toolName); }
  /** Trait default (`ToolConcurrency::Serial`); paper_save_executor.rs does not override it. */
  concurrencyClass(): ToolConcurrency { return 'serial'; }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    const tool = stripToolNamespace(call.name);
    this.deps.log.debug(`[PaperSave] Executing: ${tool} (full: ${call.name})`);
    return runResearchTool(call, ctx, async () => {
      if (tool === 'paper_save') return this.paperSave(call, ctx);
      if (tool === 'cite_format') return this.citeFormat(call.arguments);
      throw new Error(`Unknown paper tool: ${tool}`);
    }, { log: this.deps.log, executorName: 'PaperSave', saveBlock: true, mapError: localizedPaperFailure });
  }

  private citeFormat(args: unknown): Json {
    const papers = isRecord(args) && Array.isArray(args['papers']) ? args['papers'] : null;
    if (papers === null) throw new Error("Missing required parameter 'papers' (array)");
    const format = (isRecord(args) ? str(args['format']) : null) ?? 'bibtex';
    const citations = papers.map(paper => ({
      title: (isRecord(paper) ? str(paper['title']) : null) ?? '',
      citation: formatCitation(paper, format),
    }));
    return { format, count: citations.length, citations };
  }

  /** Rust `extract_papers_from_value`. */
  private extractPapers(value: unknown): unknown[] | null {
    const log = this.deps.log;
    if (isRecord(value) && Object.hasOwn(value, 'papers')) {
      const papers = value['papers'];
      log.info(`[PaperSave] Found 'papers' key, value type=${jsonType(papers)}, preview=${truncateUtf8(JSON.stringify(papers), 200)}`);
      if (Array.isArray(papers)) return papers;
      if (typeof papers === 'string') {
        log.warn(`[PaperSave] 'papers' value is a JSON string (len=${utf8ByteLength(papers)}), double-decoding`);
        const inner = parseJson(papers);
        if (Array.isArray(inner)) return inner;
        if (isRecord(inner)) return [inner];
      }
      if (isRecord(papers)) {
        log.warn("[PaperSave] 'papers' value is a single object, wrapping in array");
        return [papers];
      }
    }
    if (isRecord(value) && Object.hasOwn(value, 'paper')) {
      log.warn("[PaperSave] LLM used 'paper' (singular) instead of 'papers', auto-correcting");
      const paper = value['paper'];
      if (Array.isArray(paper)) return paper;
      if (typeof paper === 'string') {
        const inner = parseJson(paper);
        if (Array.isArray(inner)) return inner;
        if (isRecord(inner)) return [inner];
      }
      if (isRecord(paper)) return [paper];
    }
    if (isRecord(value) && Object.hasOwn(value, 'title')) {
      log.warn("[PaperSave] LLM sent a single paper object without 'papers' wrapper, auto-wrapping");
      return [value];
    }
    return null;
  }

  private async paperSave(call: ToolCall, ctx: ExecutionContext): Promise<Json> {
    const args = call.arguments;
    const raw = JSON.stringify(args) ?? 'null';
    this.deps.log.info(`[PaperSave] execute_paper_save called. args_type=${jsonType(args)}, args_len=${utf8ByteLength(raw)}, preview=${truncateUtf8(raw, 300)}`);
    if (isRecord(args) && Object.hasOwn(args, '_truncation_error')) {
      throw new Error('Tool call arguments were truncated by LLM max_tokens limit. Please retry with a shorter prompt.');
    }

    let papers: unknown[];
    const extracted = Array.isArray(args) ? null : this.extractPapers(args);
    if (Array.isArray(args)) {
      this.deps.log.warn('[PaperSave] arguments is a bare array, wrapping as papers');
      papers = args;
    } else if (extracted !== null) {
      papers = extracted;
    } else if (typeof args === 'string') {
      this.deps.log.warn(`[PaperSave] arguments is a JSON string (len=${utf8ByteLength(args)}), attempting double-decode`);
      let parsed: unknown;
      try { parsed = JSON.parse(args); }
      catch (error) { throw new Error(`Failed to parse arguments string: ${toolErrorText(error)}`); }
      const inner = this.extractPapers(parsed);
      if (inner === null) {
        const keys = isRecord(parsed) ? `Some(${debugKeys(Object.keys(parsed))})` : 'None';
        throw new Error(`After double-decode, still missing 'papers' (array). Parsed keys: ${keys}`);
      }
      papers = inner;
    } else {
      const keys = isRecord(args) ? Object.keys(args) : [];
      this.deps.log.error(`[PaperSave] Cannot extract 'papers' from arguments. type=${jsonType(args)}, keys=${debugKeys(keys)}, raw_preview=${truncateUtf8(raw, 500)}`);
      throw new Error(`Missing required parameter 'papers' (array). Got arguments type=${jsonType(args)}, keys=${debugKeys(keys)}`);
    }

    if (papers.length === 0) throw new Error("'papers' array is empty");
    if (papers.length > MAX_BATCH_SIZE) {
      throw new Error(`Batch size ${papers.length} exceeds limit ${MAX_BATCH_SIZE}. Please split into multiple calls.`);
    }
    const folderId = isRecord(args) ? str(args['folder_id']) : null;
    const library = this.deps.library();
    if (library === null) throw new Error('VFS database not available');

    const progress: ProgressItem[] = papers.map((paper, index) => ({
      index, title: (isRecord(paper) ? str(paper['title']) : null) ?? 'Untitled Paper', stage: 'resolving', percent: 0,
      downloaded: null, totalBytes: null, fileId: null, deduplicated: false, error: null, source: null, sources: null,
    }));
    emitProgress(ctx, progress);

    const results: Json[] = [];
    for (const [index, paper] of papers.entries()) {
      if (ctx.isCancelled()) {
        progress[index]!.stage = 'error';
        progress[index]!.error = 'cancelled';
        emitProgress(ctx, progress);
        results.push({ index, success: false, error: 'cancelled' });
        break;
      }
      try {
        const info = await this.saveSinglePaper(paper, folderId, library, ctx, progress, index);
        results.push({ ...info, index });
      } catch (error) {
        const message = toolErrorText(error);
        const title = progress[index]!.title;
        this.deps.log.warn(`[PaperSave] Failed to save paper '${title}': ${message}`);
        progress[index]!.stage = 'error';
        progress[index]!.error = message;
        emitProgress(ctx, progress);
        results.push({ index, success: false, title, error: message });
      }
    }

    const successCount = results.filter(result => result['success'] === true).length;
    return { total: papers.length, success_count: successCount, failed_count: papers.length - successCount, results };
  }

  private async saveSinglePaper(paper: unknown, folderId: string | null, library: PaperLibraryPort,
    ctx: ExecutionContext, progress: ProgressItem[], index: number): Promise<Json> {
    const record = isRecord(paper) ? paper : {};
    const title = str(record['title']) ?? 'Untitled Paper';
    const item = progress[index]!;
    item.stage = 'resolving';
    emitProgress(ctx, progress);

    const candidates = await this.resolveAllPdfUrls(str(record['url']), str(record['doi']), str(record['arxiv_id']));
    if (candidates.length === 0) throw new Error('No URL, arXiv ID, or DOI provided. At least one is required.');
    item.sources = candidates.map(([url, label]) => ({ label, url }));

    let pdfBytes: Uint8Array | null = null;
    let lastError = '';
    for (const [candidateUrl, sourceLabel] of candidates) {
      if (ctx.isCancelled()) throw new Error('Download cancelled');
      this.deps.log.info(`[PaperSave] Trying '${title}' source=${sourceLabel} url=${candidateUrl}`);
      item.stage = 'downloading';
      item.source = sourceLabel;
      item.percent = 0;
      item.downloaded = null;
      item.totalBytes = null;
      emitProgress(ctx, progress);
      try {
        pdfBytes = await this.downloadPdfWithProgress(candidateUrl, ctx, progress, index);
        break;
      } catch (error) {
        const message = error instanceof DownloadCancelled ? 'Download cancelled' : toolErrorText(error);
        this.deps.log.warn(`[PaperSave] Source '${sourceLabel}' failed for '${title}': ${message}`);
        lastError = `[${sourceLabel}] ${message}`;
      }
    }
    if (pdfBytes === null) throw new Error(`All ${candidates.length} sources failed. Last error: ${lastError}`);
    this.deps.log.info(`[PaperSave] Downloaded ${pdfBytes.length} bytes for '${title}'`);

    item.stage = 'deduplicating';
    item.percent = 100;
    emitProgress(ctx, progress);
    const sha256 = await this.deps.crypto().sha256Hex(pdfBytes);
    let existing: { id: string; status: string } | null = null;
    try { existing = library.getFileBySha256(sha256); }
    catch (error) { this.deps.log.debug(`[PaperSave] sha256 lookup failed, saving a new file: ${toolErrorText(error)}`); }
    if (existing !== null && existing.status === 'active') {
      this.deps.log.info(`[PaperSave] Paper '${title}' already exists: ${existing.id}`);
      item.stage = 'done';
      item.deduplicated = true;
      item.fileId = existing.id;
      emitProgress(ctx, progress);
      return withLocalizedMessage({ success: true, deduplicated: true, file_id: existing.id, title },
        'chat.tools.paper_save.already_exists', { fileId: existing.id },
        `论文已存在于资料库中（文件ID: ${existing.id}）`, `The paper already exists in the library (file ID: ${existing.id}).`);
    }

    item.stage = 'storing';
    emitProgress(ctx, progress);
    let blobHash: string;
    try { blobHash = library.storeBlob(pdfBytes); }
    catch (error) { throw new Error(`Blob storage failed: ${toolErrorText(error)}`); }

    item.stage = 'processing';
    emitProgress(ctx, progress);
    let preview: { previewJson: string | null; extractedText: string | null; pageCount: number | null };
    try { preview = await library.renderPreview(pdfBytes); }
    catch (error) {
      this.deps.log.warn(`[PaperSave] PDF preview failed for '${title}': ${toolErrorText(error)}`);
      preview = { previewJson: null, extractedText: null, pageCount: null };
    }

    const safeTitle = sanitizeFilename(title);
    const fileName = safeTitle.toLowerCase().endsWith('.pdf') ? safeTitle : `${safeTitle}.pdf`;
    let file: PaperFileRecord;
    try {
      file = library.createFile({
        sha256, fileName, sizeBytes: pdfBytes.length, blobHash, folderId: folderId !== null && folderId !== '' ? folderId : null,
        previewJson: preview.previewJson, extractedText: preview.extractedText, pageCount: preview.pageCount,
      });
    } catch (error) { throw new Error(`File creation failed: ${toolErrorText(error)}`); }
    this.deps.log.info(`[PaperSave] File created: ${file.id} (name=${fileName}, pages=${preview.pageCount === null ? 'None' : `Some(${preview.pageCount})`})`);

    item.stage = 'indexing';
    emitProgress(ctx, progress);
    if (file.resourceId !== null) {
      try {
        const units = library.syncResourceUnits({
          resourceId: file.resourceId, blobHash, pageCount: file.pageCount,
          extractedText: file.extractedText, previewJson: file.previewJson,
        });
        this.deps.log.info(`[PaperSave] Indexed ${units} units for file ${file.id}`);
      } catch (error) {
        this.deps.log.warn(`[PaperSave] Index sync failed for file ${file.id}: ${toolErrorText(error)}`);
      }
    }
    if (library.startPipeline !== undefined) {
      const fileId = file.id;
      this.deps.log.info(`[PaperSave] Starting media pipeline for file: ${fileId}`);
      void library.startPipeline(fileId).catch((error: unknown) => {
        this.deps.log.error(`[PaperSave] Media pipeline failed for file ${fileId}: ${toolErrorText(error)}`);
      });
    }

    item.stage = 'done';
    item.fileId = file.id;
    emitProgress(ctx, progress);
    const savedPages = preview.pageCount ?? 0;
    return withLocalizedMessage({
      success: true, deduplicated: false, file_id: file.id, title, file_name: fileName,
      size_bytes: pdfBytes.length, page_count: preview.pageCount, has_text: preview.extractedText !== null,
    }, 'chat.tools.paper_save.saved', { pageCount: savedPages, fileId: file.id },
    `论文已保存到资料库（${savedPages}页，文件ID: ${file.id}）`,
    `The paper was saved to the library (${savedPages} pages, file ID: ${file.id}).`);
  }

  /** Rust `resolve_all_pdf_urls`: direct URL, arXiv main + export mirror, Unpaywall, arXiv mirror of a direct URL. */
  private async resolveAllPdfUrls(url: string | null, doi: string | null, arxivId: string | null): Promise<Array<[string, string]>> {
    const candidates: Array<[string, string]> = [];
    const has = (candidate: string) => candidates.some(([existing]) => existing === candidate);
    if (url !== null && url !== '') candidates.push([url, 'Direct']);
    if (arxivId !== null && arxivId !== '') {
      // strip_prefix("arXiv:") runs on the trimmed id, the lowercase fallback and unwrap_or on the raw id.
      const trimmed = arxivId.trim();
      const cleanId = trimmed.startsWith('arXiv:') ? trimmed.slice(6)
        : arxivId.startsWith('arxiv:') ? arxivId.slice(6) : arxivId;
      const mainUrl = `https://arxiv.org/pdf/${cleanId}`;
      if (!has(mainUrl)) candidates.push([mainUrl, 'arXiv']);
      candidates.push([`https://export.arxiv.org/pdf/${cleanId}`, 'arXiv Export']);
    }
    if (doi !== null && doi !== '') {
      const trimmed = doi.trim();
      const cleanDoi = trimmed.startsWith('https://doi.org/') ? trimmed.slice('https://doi.org/'.length) : doi;
      try {
        const pdfUrl = await this.resolveDoiToPdf(cleanDoi);
        if (!has(pdfUrl)) candidates.push([pdfUrl, 'Unpaywall']);
      } catch (error) {
        this.deps.log.debug(`[PaperSave] Unpaywall resolve failed for DOI '${doi}': ${toolErrorText(error)}`);
      }
    }
    if (url !== null && url.includes('arxiv.org/pdf/')) {
      const idPart = url.split('arxiv.org/pdf/')[1]!;
      let clean = idPart;
      while (clean.endsWith('.pdf')) clean = clean.slice(0, -4);
      while (clean.endsWith('/')) clean = clean.slice(0, -1);
      const exportUrl = `https://export.arxiv.org/pdf/${clean}`;
      if (!has(exportUrl)) candidates.push([exportUrl, 'arXiv Export']);
    }
    return candidates;
  }

  private requireHttp(): { fetch: AcademicFetch } {
    const http = this.deps.http();
    if (http === null) throw new Error('llmHttp service is not available');
    return http;
  }

  private async resolveDoiToPdf(doi: string): Promise<string> {
    const url = `${this.deps.unpaywallUrl ?? UNPAYWALL_API_URL}/${doi}?email=support@deepstudent.app`;
    this.deps.log.debug(`[PaperSave] Unpaywall lookup: ${url}`);
    let response: Response;
    try {
      response = await this.requireHttp().fetch(url, { headers: { 'user-agent': UA }, requestTimeoutMs: UNPAYWALL_TIMEOUT_MS });
    } catch (error) { throw new Error(`Unpaywall request failed: ${toolErrorText(error)}`); }
    if (!response.ok) {
      throw new Error(`Unpaywall returned HTTP ${response.status} for DOI '${doi}'. The paper may not have an open access version.`);
    }
    let body: unknown;
    try { body = JSON.parse(await response.text()); }
    catch (error) { throw new Error(`Unpaywall parse failed: ${toolErrorText(error)}`); }
    const record = isRecord(body) ? body : {};
    const best = isRecord(record['best_oa_location']) ? str(record['best_oa_location']['url_for_pdf']) : null;
    if (best !== null && best !== '') return best;
    if (Array.isArray(record['oa_locations'])) {
      for (const location of record['oa_locations']) {
        const pdfUrl = isRecord(location) ? str(location['url_for_pdf']) : null;
        if (pdfUrl !== null && pdfUrl !== '') return pdfUrl;
      }
    }
    throw new Error(`No open access PDF found for DOI '${doi}'. The paper may be behind a paywall.`);
  }

  private async raceCancel<T>(work: Promise<T>, signal: AbortSignal | null): Promise<T> {
    if (signal === null) return work;
    if (signal.aborted) throw new DownloadCancelled();
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DownloadCancelled());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { return await Promise.race([work, cancelled]); }
    finally { signal.removeEventListener('abort', onAbort!); }
  }

  /**
   * GET with reqwest's redirect policy and one 60 s deadline over the whole chain. Redirects are followed here
   * and every hop is checked before it is requested; `allowLoopback: false` also refuses names resolving to loopback.
   */
  private async fetchPublicPdf(http: Pick<HttpService, 'fetch'>, url: string,
    signal: AbortSignal | null): Promise<Response> {
    const deadline = Date.now() + PDF_DOWNLOAD_TIMEOUT_MS;
    let current = url;
    for (let hop = 0; ; hop += 1) {
      const timeoutMs = hop === 0 ? PDF_DOWNLOAD_TIMEOUT_MS : Math.max(1, deadline - Date.now());
      // RUST-FIX(RF-W03-paper-save-public-destination): private, link-local, metadata and local targets are refused on every redirect hop.
      const response = await http.fetch(current, {
        headers: { 'user-agent': UA }, destination: 'public', allowLoopback: false, redirect: 'manual', timeoutMs,
        ...(signal === null ? {} : { signal }),
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      let next: string;
      try { next = new URL(location, current).href; } catch { return response; }
      await response.body?.cancel();
      if (hop + 1 >= MAX_REDIRECTS) throw new Error('too many redirects');
      if (isLocalUrl(next)) throw new Error(`redirect to a local address is not allowed: ${next}`);
      current = next;
    }
  }

  /** Rust `download_pdf_with_progress`. */
  private async downloadPdfWithProgress(url: string, ctx: ExecutionContext, progress: ProgressItem[],
    index: number): Promise<Uint8Array> {
    if (!url.startsWith('https://')) throw new Error(`Only HTTPS URLs are allowed: ${url}`);
    // RUST-FIX(RF-W03-paper-save-public-destination): Rust exempted http://localhost and let model URLs reach local services (e.g. Ollama).
    if (isLocalUrl(url)) throw new Error(`Local addresses are not allowed: ${url}`);
    const signal = ctx.cancellation_token;
    const http = this.deps.publicHttp();
    if (http === null) throw new Error('http service is not available');
    let response: Response;
    try {
      response = await this.raceCancel(this.fetchPublicPdf(http, url, signal), signal);
    } catch (error) {
      if (error instanceof DownloadCancelled || signal?.aborted === true) throw new DownloadCancelled();
      throw new Error(`PDF download failed: ${toolErrorText(error)}`);
    }
    if (!response.ok) throw new Error(`PDF download returned HTTP ${response.status} from ${url}`);

    const lengthHeader = response.headers.get('content-length');
    const totalSize = lengthHeader !== null && /^[0-9]+$/.test(lengthHeader) ? Number(lengthHeader) : null;
    const item = progress[index]!;
    if (totalSize !== null) {
      if (totalSize > MAX_PDF_SIZE) {
        throw new Error(`PDF too large: ${Math.floor(totalSize / MB)} MB (limit: ${MAX_PDF_SIZE / MB} MB)`);
      }
      item.totalBytes = totalSize;
    }

    const chunks: Uint8Array[] = [];
    let buffered = 0;
    let downloaded = 0;
    let lastEmitAt = 0;
    const reader = response.body?.getReader() ?? null;
    while (reader !== null) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await this.raceCancel(reader.read(), signal); }
      catch (error) {
        if (error instanceof DownloadCancelled || signal?.aborted === true) throw new DownloadCancelled();
        throw new Error(`PDF read failed: ${toolErrorText(error)}`);
      }
      if (chunk.done) break;
      downloaded += chunk.value.length;
      if (buffered + chunk.value.length > MAX_PDF_SIZE) {
        await reader.cancel();
        throw new Error(`PDF too large: >${MAX_PDF_SIZE / MB} MB (limit: ${MAX_PDF_SIZE / MB} MB)`);
      }
      chunks.push(chunk.value);
      buffered += chunk.value.length;
      if (downloaded - lastEmitAt >= PROGRESS_BYTES_INTERVAL) {
        lastEmitAt = downloaded;
        item.downloaded = downloaded;
        item.percent = totalSize !== null ? Math.floor(Math.min((downloaded / totalSize) * 100, 99)) : 0;
        emitProgress(ctx, progress);
      }
    }
    item.downloaded = downloaded;
    item.percent = 100;
    emitProgress(ctx, progress);

    const bytes = new Uint8Array(buffered);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (bytes.length < 4 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
      throw new Error('Downloaded file is not a valid PDF (missing %PDF header)');
    }
    return bytes;
  }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
