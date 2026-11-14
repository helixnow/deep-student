/**
 * `src/cmd/textbooks.rs::textbooks_add`（:114-700）及其辅助
 * `attach_textbook_to_folder`（:43）/ `start_textbook_pipeline_if_needed`（:84）。
 *
 * 依赖全部显式注入（index.ts 负责接 ctx 服务）：
 * - 文件信息：F3 `platform/storage/node.ts`（= `unified_file_manager::*`）；
 * - 教材/blob/文件夹表：L11 `vfsRepo` 发布的仓储方法；
 * - PDF 预览渲染：L11 `vfsRepo.attachmentProcessing.renderPdf`（= `render_pdf_preview_with_progress`）；
 * - 文档解析：本 lane `docs` 服务（= `DocumentParser`）；
 * - 流水线：L12 `vfsIndex.pdf.startPipeline`；
 * - `ocr_pages_json` / 渲染失败状态两条 UPDATE：L11 `textbooks.updateTextbookOcrPagesJson` /
 *   `textbooks.markTextbookRenderError`（只写 Rust 原有列，warn 由本命令按 Rust 记录）。
 * 事件：Tauri 2 `Window::emit` 是全局广播，`textbook-import-progress` 与 `dstu:change*` 均用
 * `backendEvents.emit`（target Any）。
 */
import { nanoid } from 'nanoid';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { Logger } from '../../../platform/log/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  extractFileName, getFileSize, hashFileSha256, isOpaqueDocumentId, readAllBytesBounded, resolveFileInfo,
} from '../../../platform/storage/node.ts';
import type { Textbook, TextbookImportProgress } from '../../../../contracts/ipc/generated/L18-media-docs.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { PdfProcessingService } from '../../vfs-index/api.ts';
import type {
  PdfPreviewResult, PdfRenderProgress, VfsFolderItem, VfsReposService, VfsTextbook,
} from '../../vfs-repos/api.ts';
import type { DocsService } from '../api.ts';
import { MAX_TEXTBOOK_IMPORT_BYTES, toTextbook } from './textbooks.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

export const TEXTBOOK_IMPORT_PROGRESS_EVENT = 'textbook-import-progress';

/** `textbooks_add` 白名单（:206-209，PDF 单独分支）。 */
const SUPPORTED_EXTENSIONS: readonly string[] = [
  'docx', 'txt', 'md', 'markdown', 'xlsx', 'xls', 'xlsb', 'ods', 'html', 'htm',
  'pptx', 'epub', 'rtf', 'csv', 'json', 'xml',
];

export interface TextbooksAddDeps {
  /** `state.vfs_db`；undefined = `AppError::configuration("VFS database not configured")`。 */
  database(): VfsDatabase | undefined;
  /** L11 仓储；index.ts 的 `vfsRepo()` 缺失时抛 configuration CommandError。 */
  repos(): Pick<VfsReposService, 'textbooks' | 'blobs' | 'folders'>;
  docs: Pick<DocsService,
    'checkPdfEncryptionBytes' | 'extractPagedTextFromBytes' | 'extractTextFromBytes' | 'isPlainTextCodeExtension'>;
  /** `render_pdf_preview_with_progress(conn, blobs_dir, bytes, &PdfPreviewConfig::default(), cb)`。 */
  renderPdfPreview(conn: SqlExecutor, blobsDir: string, bytes: Uint8Array,
    progress: PdfRenderProgress): Promise<PdfPreviewResult>;
  /** `State<Arc<PdfProcessingService>>`（L12 `vfsIndex.pdf`）。 */
  pdfProcessing(): PdfProcessingService | undefined;
  /** `window.emit(event, payload)`：Tauri 2 全局广播（`backendEvents.emit`）。 */
  emit(event: string, payload: unknown): void;
  /** `emit_textbook_watch_event(window, id, type)`：同样全局广播。 */
  emitWatchEvent(textbookId: string, eventType: string): void;
  log: Pick<Logger, 'info' | 'warn'>;
  /** `tokio::time::sleep`（测试可替换）。 */
  sleep?(ms: number): Promise<void>;
  /** `chrono::Utc::now()`（测试可替换）。 */
  now?(): Date;
}

export interface TextbooksAddArgs {
  sources: string[];
  folderId?: string | null;
}

/** Rust `AppError`/`VfsError`/`ParsingError` 的 Display：AppError 是带 message 的普通对象。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null
    && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** `{:?}` of `Option<usize>`。 */
function debugOptionNumber(value: number | null): string {
  return value === null ? 'None' : `Some(${value})`;
}

/** `{:?}` of `Option<String>`。 */
function debugOptionString(value: string | null): string {
  return value === null ? 'None' : `Some(${JSON.stringify(value)})`;
}

/** Rust `str::trim`（Unicode White_Space，与 JS `trim` 在 U+0085/U+FEFF 上不同）。 */
function rustTrim(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

function utf8Len(value: string): number {
  return utf8ByteLength(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `chrono::Utc::now().format("%Y%m%d_%H%M%S")`。 */
function compactUtcTimestamp(now: Date): string {
  return `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}_`
    + `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
}

/**
 * `((current_page as f32 / total_pages as f32) * 70.0) as u8 + 15` 后 `.min(85)`：
 * f32 运算；`as u8` 饱和（NaN→0）；`+ 15` 在 release 下按 u8 回绕。
 */
export function renderProgressPercent(currentPage: number, totalPages: number): number {
  const ratio = Math.fround(Math.fround(currentPage) / Math.fround(totalPages));
  const scaled = Math.fround(ratio * 70);
  const asU8 = Number.isNaN(scaled) ? 0 : Math.min(255, Math.max(0, Math.trunc(scaled)));
  return Math.min((asU8 + 15) & 0xff, 85);
}

/** `VfsFolderItem::new(Some(folder_id), "file", item_id)`（types.rs:1388）。 */
function newFolderItem(folderId: string, itemId: string): VfsFolderItem {
  return {
    id: `fi_${nanoid(10)}`, folderId, itemType: 'file', itemId, sortOrder: 0, createdAt: Date.now(),
  };
}

interface HeavyOutcome {
  blobHash: string | null;
  previewJsonStr: string | null;
  extractedText: string | null;
  pageCount: number | null;
  pagesJson: string | null;
  renderError: string | null;
  size: number;
}

type HeavyResult = { ok: true; outcome: HeavyOutcome } | { ok: false; error: AppError };

class HeavyFailure extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'HeavyFailure';
    this.appError = appError;
  }
}

function fail(appError: AppError): never {
  throw new HeavyFailure(appError);
}

export async function textbooksAdd(deps: TextbooksAddDeps, args: TextbooksAddArgs): Promise<Textbook[]> {
  const { sources } = args;
  const folderId = args.folderId ?? null;
  if (sources.length === 0) return [];

  const database = deps.database();
  if (database === undefined) {
    throw new CommandError(AppError.configuration('VFS database not configured'));
  }
  const repos = deps.repos();
  const { log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const now = deps.now ?? (() => new Date());

  const emitProgress = (fileName: string, stage: string, currentPage: number | null,
    totalPages: number | null, progress: number, error: string | null): void => {
    log.info(`📤 [Textbook] 发送进度事件: file=${fileName}, stage=${stage}, page=${
      debugOptionNumber(currentPage)}/${debugOptionNumber(totalPages)}, progress=${progress}%`);
    const payload: TextbookImportProgress = {
      file_name: fileName,
      stage,
      current_page: currentPage,
      total_pages: totalPages,
      progress,
      error,
    };
    try { deps.emit(TEXTBOOK_IMPORT_PROGRESS_EVENT, payload); }
    catch (err) {
      log.warn(`[Textbooks] 发送 textbook-import-progress 事件失败: file=${fileName}, stage=${stage}, err=${errorText(err)}`);
    }
  };

  /** `attach_textbook_to_folder`（:43-60）：best-effort，失败只 warn。 */
  const attachTextbookToFolder = (textbookId: string): void => {
    if (folderId === null) return;
    try {
      repos.folders.addItemToFolder(database.getConnSafe(), newFolderItem(folderId, textbookId));
    } catch (error) {
      log.warn(`[Textbooks] Failed to attach textbook ${textbookId} to folder ${folderId}: ${errorText(error)}`);
    }
  };

  /**
   * `start_textbook_pipeline_if_needed`（:84-108）：仅 pdf；`tokio::spawn` 后台启动，失败只 warn。
   * 推迟到命令返回之后，流水线的首个写入与事件排在 `dstu:change`、`done` 之后。
   */
  const startPipelineIfNeeded = (textbookId: string, extension: string): void => {
    if (extension !== 'pdf') return;
    setTimeout(() => void (async () => {
      log.info(`[Textbooks] Starting PDF pipeline for textbook: ${textbookId}`);
      try {
        const pdf = deps.pdfProcessing();
        if (pdf === undefined) throw new Error('VFS 索引服务未配置：需要 L12 vfsIndex');
        await pdf.startPipeline(textbookId, 'ocr_processing');
      } catch (error) {
        log.warn(`[Textbooks] Failed to start PDF pipeline for textbook ${textbookId}: ${errorText(error)}`);
      }
    })(), 0);
  };

  const out: Textbook[] = [];
  const skippedReasons: string[] = [];

  for (const src of sources) {
    const [resolvedName, resolvedExt] = resolveFileInfo(src);
    const uriRawName = extractFileName(src);
    const displayName = isOpaqueDocumentId(uriRawName)
      ? `导入文档_${compactUtcTimestamp(now())}${resolvedExt === null ? '' : `.${resolvedExt}`}`
      : resolvedName;

    log.info(`[Textbooks] Resolved file info: uri=${src}, name=${displayName}, ext=${debugOptionString(resolvedExt)}`);

    let extension: string;
    if (resolvedExt === 'pdf') {
      extension = resolvedExt;
    } else if (resolvedExt !== null) {
      if (SUPPORTED_EXTENSIONS.includes(resolvedExt) || deps.docs.isPlainTextCodeExtension(resolvedExt)) {
        extension = resolvedExt;
      } else {
        const reason = `${displayName}: 不支持的文件格式 (${resolvedExt})`;
        log.warn(`[Textbooks] ${reason}`);
        emitProgress(displayName, 'error', null, null, 0, `不支持的文件格式: ${resolvedExt}`);
        skippedReasons.push(reason);
        continue;
      }
    } else {
      const reason = `${displayName}: 无法识别文件格式`;
      log.warn(`[Textbooks] ${reason}`);
      emitProgress(displayName, 'error', null, null, 0, '无法识别文件格式，请确认文件类型后重试');
      skippedReasons.push(reason);
      continue;
    }

    // 超限文件尽早拒绝（无法获取大小的由后续有界读取兜底）
    let size: number | null = null;
    try { size = getFileSize(src); }
    // boundary-allow empty-catch: Rust `if let Ok(size) = get_file_size(..)` 忽略取大小失败
    catch {}
    if (size !== null && size > MAX_TEXTBOOK_IMPORT_BYTES) {
      const limitMb = Math.trunc(MAX_TEXTBOOK_IMPORT_BYTES / (1024 * 1024));
      const reason = `${displayName}: 文件过大 (${(size / (1024 * 1024)).toFixed(1)}MB，上限 ${limitMb}MB)`;
      log.warn(`[Textbooks] ${reason}`);
      emitProgress(displayName, 'error', null, null, 0, `文件过大，上限 ${limitMb}MB`);
      skippedReasons.push(reason);
      continue;
    }

    // 阶段1：计算哈希
    emitProgress(displayName, 'hashing', null, null, 5, null);
    let sha256: string;
    try { sha256 = await hashFileSha256(src); }
    catch (error) {
      const message = errorText(error);
      const reason = `${displayName}: 读取文件失败 (${message})`;
      log.warn(`[Textbooks] ${reason}`);
      emitProgress(displayName, 'error', null, null, 0, `读取文件失败: ${message}`);
      skippedReasons.push(reason);
      continue;
    }

    // 若已存在，恢复并重新挂载到目标位置
    let existing: VfsTextbook | null;
    try { existing = repos.textbooks.getBySha256(database.getConnSafe(), sha256); }
    catch (error) {
      throw new CommandError(AppError.database(`VFS 查询教材失败: ${errorText(error)}`));
    }
    if (existing !== null) {
      const tb = existing;
      let watchEventType = 'created';
      if (tb.status !== 'active') {
        try { repos.textbooks.restoreTextbook(database.getConnSafe(), tb.id); }
        catch (error) {
          throw new CommandError(AppError.database(`VFS 恢复教材失败: ${errorText(error)}`));
        }
        watchEventType = 'restored';

        if (tb.fileName !== displayName) {
          let conn: SqlExecutor | null = null;
          try { conn = database.getConnSafe(); }
          // boundary-allow empty-catch: Rust `if let Ok(conn) = vfs_db.get_conn_safe()` 静默跳过
          catch {}
          if (conn !== null) {
            try { repos.textbooks.renameTextbook(conn, tb.id, displayName); }
            catch (error) {
              log.warn(`[Textbooks] 恢复后重命名失败: ${tb.id} (${errorText(error)})`);
            }
          }
        }
      }

      // 老记录缺 blob 内容时趁重新导入自愈补存
      if (tb.blobHash === undefined || tb.blobHash === null) {
        try {
          const bytes = await readAllBytesBounded(src, MAX_TEXTBOOK_IMPORT_BYTES);
          let conn: SqlExecutor;
          try { conn = database.getConnSafe(); }
          catch (error) { throw AppError.database(`获取 VFS 连接失败: ${errorText(error)}`); }
          let healed: boolean;
          try {
            healed = repos.textbooks.attachBlobIfMissing(
              conn, database.blobsDir(), tb.id, bytes, null, extension);
          } catch (error) { throw AppError.database(`补存 blob 失败: ${errorText(error)}`); }
          if (healed) log.info(`[Textbooks] Healed blob for existing textbook ${tb.id}`);
        } catch (error) {
          log.warn(`[Textbooks] Blob heal failed for ${tb.id}: ${errorText(error)}`);
        }
      }

      attachTextbookToFolder(tb.id);
      deps.emitWatchEvent(tb.id, watchEventType);
      startPipelineIfNeeded(tb.id, extension);
      emitProgress(displayName, 'done', null, null, 100, null);
      // Rust 推入的是恢复/重命名之前查到的 `tb` 快照（:362）。
      out.push(toTextbook(tb));
      continue;
    }

    const fileName = displayName;
    emitProgress(fileName, 'copying', null, null, 10, null);

    const isPdf = extension === 'pdf';
    if (isPdf) emitProgress(fileName, 'rendering', 0, null, 15, null);
    else emitProgress(fileName, 'parsing', null, null, 15, null);

    let heavy: HeavyResult;
    try {
      heavy = { ok: true, outcome: await runHeavy(deps, database, repos, src, fileName, extension, isPdf) };
    } catch (error) {
      if (!(error instanceof HeavyFailure)) {
        // Rust `spawn_blocking` 的 JoinError（panic）分支。
        log.warn(`[Textbooks] Processing task panicked for ${fileName}: ${errorText(error)}`);
        emitProgress(fileName, 'error', null, null, 0, `处理任务异常终止: ${errorText(error)}`);
        skippedReasons.push(`${displayName}: 处理任务异常终止`);
        continue;
      }
      heavy = { ok: false, error: error.appError };
    }
    if (!heavy.ok) {
      log.warn(`[Textbooks] Processing failed for ${fileName}: ${heavy.error.message}`);
      emitProgress(fileName, 'error', null, null, 0, heavy.error.message);
      skippedReasons.push(`${displayName}: ${heavy.error.message}`);
      continue;
    }
    const { outcome } = heavy;

    // 阶段4：入库
    emitProgress(fileName, 'saving', null, null, 90, null);
    let conn: SqlExecutor;
    try { conn = database.getConnSafe(); }
    catch (error) {
      throw new CommandError(AppError.database(`获取 VFS 连接失败: ${errorText(error)}`));
    }
    let createAttempt = 0;
    let tb: VfsTextbook | null = null;
    for (;;) {
      createAttempt += 1;
      try {
        tb = repos.textbooks.createTextbookWithPreview(conn, sha256, fileName, outcome.size,
          outcome.blobHash, src, outcome.previewJsonStr, outcome.extractedText, outcome.pageCount);
        break;
      } catch (error) {
        const message = errorText(error);
        const transient = message.includes('locked') || message.includes('busy');
        if (transient && createAttempt < 4) {
          await sleep(250 * createAttempt);
          continue;
        }
        log.warn(`[Textbooks] 入库失败，跳过 ${fileName}: ${message}`);
        emitProgress(fileName, 'error', null, null, 0, `入库失败: ${message}`);
        skippedReasons.push(`${fileName}: 入库失败: ${message}`);
        break;
      }
    }
    if (tb === null) continue;

    if (outcome.pagesJson !== null) {
      try { repos.textbooks.updateTextbookOcrPagesJson(conn, tb.id, outcome.pagesJson); }
      catch (error) {
        log.warn(`[Textbooks] Failed to write ocr_pages_json for ${tb.id}: ${errorText(error)}`);
      }
    }

    if (outcome.renderError !== null) {
      try { repos.textbooks.markTextbookRenderError(conn, tb.id, outcome.renderError); }
      catch (error) {
        log.warn(`[Textbooks] Failed to write render failure status for ${tb.id}: ${errorText(error)}`);
      }
    }

    if (folderId !== null) {
      try { repos.folders.addItemToFolder(conn, newFolderItem(folderId, tb.id)); }
      catch (error) {
        throw new CommandError(AppError.database(`VFS 挂载教材失败: ${errorText(error)}`));
      }
    }

    emitProgress(fileName, 'indexing', null, null, 95, null);
    startPipelineIfNeeded(tb.id, extension);
    deps.emitWatchEvent(tb.id, 'created');

    // 阶段5：完成
    emitProgress(fileName, 'done', null, null, 100, null);
    out.push(toTextbook(tb));
  }

  if (out.length === 0 && skippedReasons.length > 0) {
    const summary = skippedReasons.join('; ');
    log.info(`[Textbooks] All files skipped. Reasons: ${summary}`);
    emitProgress('', 'error', null, null, 0, summary);
  }

  return out;
}

/** `spawn_blocking` 闭包（:396-584）：读取 → PDF 校验 → blob → 渲染/解析。 */
async function runHeavy(
  deps: TextbooksAddDeps,
  database: VfsDatabase,
  repos: Pick<VfsReposService, 'blobs'>,
  src: string,
  fileName: string,
  extension: string,
  isPdf: boolean,
): Promise<HeavyOutcome> {
  const { log } = deps;
  let fileBytes: Uint8Array;
  try { fileBytes = await readAllBytesBounded(src, MAX_TEXTBOOK_IMPORT_BYTES); }
  catch (error) { return fail(AppError.file_system(`读取文件失败: ${errorText(error)}`)); }
  const size = fileBytes.length;

  if (isPdf) {
    const header = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
    if (fileBytes.length < 5 || !header.every((byte, i) => fileBytes[i] === byte)) {
      fail(AppError.validation(`文件 '${fileName}' 不是有效的 PDF 文档（缺少 PDF 文件头）`));
    }
    try { deps.docs.checkPdfEncryptionBytes(fileBytes, fileName); }
    catch (error) { fail(AppError.validation(errorText(error))); }
  }

  let conn: SqlExecutor;
  try { conn = database.getConnSafe(); }
  catch (error) { return fail(AppError.database(`获取 VFS 连接失败: ${errorText(error)}`)); }
  const blobsDir = database.blobsDir();

  let blobHash: string;
  try { blobHash = repos.blobs.storeBlob(conn, blobsDir, fileBytes, null, extension).hash; }
  catch (error) { return fail(AppError.database(`复制文件进 VFS 失败: ${errorText(error)}`)); }

  let pagesJson: string | null = null;
  let renderError: string | null = null;
  let previewJsonStr: string | null = null;
  let extractedText: string | null = null;
  let pageCount: number | null = null;

  if (isPdf) {
    const progressCallback = (currentPage: number, totalPages: number): void => {
      const payload: TextbookImportProgress = {
        file_name: fileName,
        stage: 'rendering',
        current_page: currentPage,
        total_pages: totalPages,
        progress: renderProgressPercent(currentPage, totalPages),
        error: null,
      };
      try { deps.emit(TEXTBOOK_IMPORT_PROGRESS_EVENT, payload); }
      catch (err) {
        log.warn(`[Textbooks] 发送渲染进度事件失败: file=${fileName}, page=${currentPage}/${totalPages}, err=${errorText(err)}`);
      }
    };
    try {
      const result = await deps.renderPdfPreview(conn, blobsDir, fileBytes, progressCallback);
      const previewStr = result.previewJson === null ? null : JSON.stringify(result.previewJson);
      log.info(`[Textbooks] PDF preview rendered: ${result.pageCount} pages, text_len=${
        result.extractedText === null ? 0 : utf8Len(result.extractedText)}, has_preview=${previewStr !== null}`);
      previewJsonStr = previewStr;
      extractedText = result.extractedText;
      pageCount = result.pageCount;
    } catch (error) {
      log.warn(`[Textbooks] PDF preview failed, storing without preview: ${errorText(error)}`);
      renderError = `PDF 渲染失败，预览与文本提取不可用：${errorText(error)}。可尝试删除后重新导入，或检查 PDF 是否损坏/加密`;
    }
  } else {
    let pages: string[] | null = null;
    try { pages = await deps.docs.extractPagedTextFromBytes(fileName, fileBytes); }
    // boundary-allow empty-catch: Rust `Ok(_) | Err(_)` 分页失败静默回退整篇提取
    catch {}
    if (pages !== null && pages.length > 0) {
      const joined = rustTrim(pages.join('\n\n'));
      log.info(`[Textbooks] Paged document text extracted: ${pages.length} pages, ${utf8Len(joined)} chars from ${fileName}`);
      pagesJson = JSON.stringify(pages);
      extractedText = joined;
      pageCount = pages.length;
    } else {
      let text: string;
      try { text = await deps.docs.extractTextFromBytes(fileName, fileBytes); }
      catch (error) { return fail(AppError.file_system(`文档解析失败: ${errorText(error)}`)); }
      log.info(`[Textbooks] Document text extracted: ${utf8Len(text)} chars from ${fileName}`);
      extractedText = text;
      pageCount = 1;
    }
  }

  return { blobHash, previewJsonStr, extractedText, pageCount, pagesJson, renderError, size };
}
