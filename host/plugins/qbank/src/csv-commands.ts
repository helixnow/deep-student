/**
 * `src-tauri/src/commands.rs:1663-2002` 的四条 CSV 命令外壳：
 * `import_questions_csv` / `cancel_questions_csv_import` / `export_questions_csv` /
 * `get_csv_preview`。虚拟 URI 的物化/回写走平台 `copyFileVerified`（Electron 桌面对
 * 虚拟 URI 按 Rust 同形状 fail-close），临时文件在每条路径上清理并 warn。
 */
const randomUUID = () => globalThis.crypto.randomUUID();
import * as path from '../../../platform/util/path.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { ioMessageFor } from '../../../platform/paths/io-error.ts';
import { extractFileName, isVirtualUri } from '../../../platform/storage/api.ts';
import { qbankLocalRuntime } from './local-runtime.ts';
import type { QuestionFilters } from '../api.ts';
import { QbankServiceError } from './question-service.ts';
import {
  CsvImportCancellation, importCsv, previewCsv,
  type CsvDuplicateStrategy, type CsvImportHost, type CsvImportProgress, type CsvImportResult,
  type CsvPreviewResult,
} from './csv-import.ts';
import { exportCsv, type CsvExportHost, type CsvExportResult, type ExportEncoding } from './csv-export.ts';

export interface CsvImportCommandRequest {
  file_path: string;
  exam_id: string;
  field_mapping: Record<string, string>;
  duplicate_strategy?: string | null;
  folder_id?: string | null;
  exam_name?: string | null;
  import_id?: string | null;
}

export interface CsvExportCommandRequest {
  exam_id: string;
  file_path: string;
  fields?: string[];
  filters?: QuestionFilters | null;
  include_answers?: boolean;
  encoding?: string | null;
}

export interface CsvCommandEnv {
  appDataDir: string;
  /** `state.vfs_db` 未初始化时为 null（Rust 返回 Validation “VFS 数据库未初始化”）。 */
  importHost(): CsvImportHost | null;
  exportHost(): CsvExportHost | null;
  emitProgress(payload: CsvImportProgress): void;
  log: { info(message: string): void; warn(message: string): void };
  /** Node 平台名（`ctx.app.platform`），决定 io::Error Display 的 strerror 文案。 */
  platform: string;
}

function fail(appError: unknown): never {
  throw new QbankServiceError(appError);
}

function appErrorMessage(error: unknown): string {
  if (error instanceof QbankServiceError) {
    const appError = error.appError as { message?: unknown };
    if (typeof appError.message === 'string') return appError.message;
  }
  if (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** 平台 helper 抛出的是 AppError 值本身；包成 QbankServiceError 交给命令层解包。 */
function asServiceError(error: unknown): unknown {
  if (error instanceof QbankServiceError) return error;
  if (error !== null && typeof error === 'object' && 'error_type' in error) return new QbankServiceError(error);
  return error;
}

/** `unified_file_manager::ensure_local_path` 的虚拟分支：复制到临时目录，返回物化路径（需清理）。 */
async function materializeVirtual(env: CsvCommandEnv, rawPath: string, tempDir: string): Promise<string> {
  if (!qbankLocalRuntime().exists(tempDir)) {
    try { qbankLocalRuntime().mkdirp(tempDir); }
    catch (error) { fail(AppError.file_system(`创建临时目录失败: ${tempDir} (${ioMessageFor(error, env.platform)})`)); }
  }
  const name = extractFileName(rawPath);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : null;
  const dest = path.join(tempDir, extension === null
    ? `dstu_materialized_${randomUUID()}`
    : `dstu_materialized_${randomUUID()}.${extension}`);
  try { await qbankLocalRuntime().copyFileVerified(rawPath, dest); }
  catch (error) { throw asServiceError(error); }
  return dest;
}

function removeTemp(env: CsvCommandEnv, file: string, label: string): void {
  try { qbankLocalRuntime().removeFile(file); }
  catch (error) { env.log.warn(`[${label}] 清理临时 CSV 文件失败 (${file}): ${ioMessageFor(error, env.platform)}`); }
}

/** 进程内 `state.csv_import_cancellations`。 */
export class CsvImportRegistry {
  private readonly tokens = new Map<string, CsvImportCancellation>();

  register(importId: string): CsvImportCancellation | null {
    if (this.tokens.has(importId)) return null;
    const token = new CsvImportCancellation();
    this.tokens.set(importId, token);
    return token;
  }

  /** 只移除自己登记的令牌。 */
  release(importId: string, token: CsvImportCancellation): void {
    if (this.tokens.get(importId) === token) this.tokens.delete(importId);
  }

  /** `cancel_questions_csv_import`。 */
  cancel(importId: string): boolean {
    return this.tokens.get(importId)?.requestCancel() ?? false;
  }
}

function duplicateStrategy(raw: string | null | undefined): CsvDuplicateStrategy {
  if (raw === 'overwrite') return 'overwrite';
  if (raw === 'merge') return 'merge';
  return 'skip';
}

/** `import_questions_csv`。 */
export async function importQuestionsCsvCommand(env: CsvCommandEnv, registry: CsvImportRegistry,
  request: CsvImportCommandRequest): Promise<CsvImportResult> {
  const host = env.importHost();
  if (host === null) fail(AppError.validation('VFS 数据库未初始化'));

  let csvFilePath = request.file_path;
  let cleanupPath: string | null = null;
  if (isVirtualUri(request.file_path)) {
    csvFilePath = await materializeVirtual(env, request.file_path, path.join(env.appDataDir, 'temp_csv_import'));
    cleanupPath = csvFilePath;
  }

  const strategy = duplicateStrategy(request.duplicate_strategy);
  const importId = request.import_id != null && request.import_id.trim() !== '' ? request.import_id : null;
  const progressExamId = request.exam_id;

  let cancellation: CsvImportCancellation | null = null;
  if (importId !== null) {
    cancellation = registry.register(importId);
    if (cancellation === null) {
      if (cleanupPath !== null) {
        try { qbankLocalRuntime().removeFile(cleanupPath); }
        catch (error) {
          env.log.warn(`[csv_import] 清理重复导入的临时 CSV 文件失败 (${cleanupPath}): ${ioMessageFor(error, env.platform)}`);
        }
      }
      fail(AppError.validation('该 CSV 导入仍在进行中，请稍后再试'));
    }
  }

  let outcome: { ok: true; result: CsvImportResult } | { ok: false; error: unknown };
  try {
    outcome = {
      ok: true,
      result: await importCsv(host, {
        file_path: csvFilePath,
        exam_id: request.exam_id,
        field_mapping: request.field_mapping,
        duplicate_strategy: strategy,
        folder_id: request.folder_id ?? null,
        exam_name: request.exam_name ?? null,
      }, payload => env.emitProgress(payload), cancellation),
    };
  } catch (error) {
    // 非 AppError 的异常对应 Rust spawn_blocking 的 JoinError（任务 panic）。
    outcome = {
      ok: false,
      error: error instanceof QbankServiceError
        ? error
        : new QbankServiceError(AppError.internal(`CSV 导入任务异常终止: ${appErrorMessage(error)}`)),
    };
  }

  if (importId !== null && cancellation !== null) registry.release(importId, cancellation);

  if (!outcome.ok) {
    env.emitProgress({ type: 'Failed', error: appErrorMessage(outcome.error), exam_id: progressExamId });
  }

  if (cleanupPath !== null) {
    try { qbankLocalRuntime().removeFile(cleanupPath); }
    catch (error) { env.log.warn(`[csv_import] 清理临时 CSV 文件失败 (${cleanupPath}): ${ioMessageFor(error, env.platform)}`); }
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}

function exportEncoding(raw: string | null | undefined): ExportEncoding {
  if (raw === 'gbk') return 'gbk';
  if (raw === 'utf8_bom') return 'utf8_bom';
  return 'utf8';
}

/** `export_questions_csv`。 */
export async function exportQuestionsCsvCommand(env: CsvCommandEnv,
  request: CsvExportCommandRequest): Promise<CsvExportResult> {
  const host = env.exportHost();
  if (host === null) fail(AppError.validation('VFS 数据库未初始化'));

  const targetPath = request.file_path;
  let exportFilePath = targetPath;
  let stagedFilePath: string | null = null;
  if (isVirtualUri(targetPath)) {
    const tempDir = path.join(env.appDataDir, 'temp_csv_export');
    try { qbankLocalRuntime().mkdirp(tempDir); }
    catch (error) { fail(AppError.file_system(`创建 CSV 临时导出目录失败: ${ioMessageFor(error, env.platform)}`)); }
    exportFilePath = path.join(tempDir, `questions_export_${randomUUID()}.csv`);
    stagedFilePath = exportFilePath;
  }

  const removeStaged = (message: string): void => {
    if (stagedFilePath === null) return;
    try { qbankLocalRuntime().removeFile(stagedFilePath); }
    catch (error) { env.log.warn(`[csv_export] ${message} (${stagedFilePath}): ${ioMessageFor(error, env.platform)}`); }
  };

  let result: CsvExportResult;
  try {
    result = exportCsv(host, {
      exam_id: request.exam_id,
      file_path: exportFilePath,
      fields: request.fields ?? [],
      filters: request.filters ?? {},
      include_answers: request.include_answers ?? false,
      encoding: exportEncoding(request.encoding),
    });
  } catch (error) {
    removeStaged('导出失败后清理临时文件失败');
    throw error;
  }

  if (stagedFilePath !== null) {
    try { await qbankLocalRuntime().copyFileVerified(exportFilePath, targetPath); }
    catch (error) {
      removeStaged('导出失败后清理临时文件失败');
      fail(AppError.file_system(`写入目标 URI 失败: ${appErrorMessage(error)}`));
    }
    removeStaged('清理临时导出文件失败');
    result.file_path = targetPath;
  }
  return result;
}

/** `get_csv_preview`。 */
export async function getCsvPreviewCommand(env: CsvCommandEnv, filePath: string,
  rows: number | null | undefined): Promise<CsvPreviewResult> {
  let previewFilePath = filePath;
  let cleanupPath: string | null = null;
  if (isVirtualUri(filePath)) {
    previewFilePath = await materializeVirtual(env, filePath, path.join(env.appDataDir, 'temp_csv_preview'));
    cleanupPath = previewFilePath;
  }
  try {
    return previewCsv(previewFilePath, rows ?? 5, env.platform);
  } finally {
    if (cleanupPath !== null) removeTemp(env, cleanupPath, 'csv_preview');
  }
}
