// cmd/notes.rs::notes_export / notes_export_single / notes_import command
// wrappers: staging + verified copy for user destinations, and the per-kind
// AppError mapping.
const randomUUID = () => globalThis.crypto.randomUUID();
import { join } from '../../../platform/util/path.ts';
import { notesLocalRuntime } from './local-runtime.ts';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsService } from '../../../platform/settings/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { exportNotes, exportSingle, importNotes } from '../repository/exporter.ts';
import type { ExportSummary, ImportProgress } from '../repository/exporter.ts';
import { notesLog } from '../repository/log.ts';
import {
  exportFailure, importConflictStrategy, errorMessage, materializeLocalImportPath,
} from './command-utils.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export interface TransferContext {
  conn: SqlExecutor;
  settings: SettingsService;
  /** Active slot dir: `notes_assets/` lives here. */
  baseDir: string;
  /** App data dir: default export directory and staging live here. */
  appDataDir: string;
  appVersion: string;
  stagingDir?: string;
  onProgress?: (progress: ImportProgress) => void;
}

function utcStamp(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}_`
    + `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

export const NOTES_EXPORT_STAGING_FALLBACK = 'notes_export_use_private_staging';

function stagingPath(ctx: TransferContext, single: boolean): string {
  const folder = ctx.settings.get(NOTES_EXPORT_STAGING_FALLBACK) === 'true' ? 'notes-export-staging' : 'exports';
  const exportsDir = ctx.stagingDir ?? join(ctx.appDataDir, folder);
  try {
    notesLocalRuntime().mkdirp(exportsDir);
    if (folder === 'notes-export-staging' && notesLocalRuntime().lstat(exportsDir).kind !== 'directory') {
      throw new Error('应用管理的导出暂存路径必须是真实目录');
    }
  } catch (error) {
    throw new CommandError(AppError.with_details('FileSystem', '创建临时导出目录失败: ' + errorMessage(error), { code: 'NOTES_EXPORT_STAGE_UNAVAILABLE' }));
  }
  const name = `${single ? 'note_export' : 'notes_export'}_staging_${utcStamp()}_${randomUUID()}.zip`;
  return join(exportsDir, name);
}

/** Rust command: export to a staging ZIP, then verified-copy to the user path. */
async function stagedExport(
  ctx: TransferContext,
  requestedPath: string | null,
  produce: (outputPath: string | null) => Promise<ExportSummary>,
): Promise<ExportSummary> {
  if (requestedPath === null) return produce(null);
  const staging = stagingPath(ctx, false);
  const summary = await produce(staging);
  try {
    await notesLocalRuntime().copyFileVerified(summary.output_path, requestedPath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'error_type' in error) {
      throw new CommandError(error);
    }
    throw new CommandError(AppError.file_system(errorMessage(error)));
  }
  if (requestedPath !== summary.output_path) {
    try {
      notesLocalRuntime().unlink(summary.output_path);
    } catch (error) {
      notesLog.warn(`notes_export: 清理临时导出文件失败 (${summary.output_path}): ${errorMessage(error)}`);
    }
  }
  return { ...summary, output_path: requestedPath };
}

async function stagedSingleExport(
  ctx: TransferContext,
  requestedPath: string | null,
  produce: (outputPath: string | null) => Promise<ExportSummary>,
): Promise<ExportSummary> {
  if (requestedPath === null) return produce(null);
  const staging = stagingPath(ctx, true);
  const summary = await produce(staging);
  try {
    await notesLocalRuntime().copyFileVerified(summary.output_path, requestedPath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'error_type' in error) {
      throw new CommandError(error);
    }
    throw new CommandError(AppError.file_system(errorMessage(error)));
  }
  if (requestedPath !== summary.output_path) {
    try {
      notesLocalRuntime().unlink(summary.output_path);
    } catch (error) {
      notesLog.warn(`notes_export_single: 清理临时导出文件失败 (${summary.output_path}): ${errorMessage(error)}`);
    }
  }
  return { ...summary, output_path: requestedPath };
}

export async function exportAll(
  ctx: TransferContext,
  request: Commands['notes_export']['args']['request'],
): Promise<Commands['notes_export']['result']> {
  try {
    const summary = await stagedExport(ctx, request.output_path ?? null, (outputPath) => exportNotes({
      conn: ctx.conn,
      settings: ctx.settings,
      baseDir: ctx.baseDir,
      appDataDir: ctx.appDataDir,
      appVersion: ctx.appVersion,
      includeVersions: request.include_versions ?? true,
      outputPath,
    }));
    return {
      output_path: summary.output_path,
      note_count: summary.note_count,
      attachment_count: summary.attachment_count,
    };
  } catch (error) {
    return exportFailure(error);
  }
}

export async function exportOne(
  ctx: TransferContext,
  request: Commands['notes_export_single']['args']['request'],
): Promise<Commands['notes_export_single']['result']> {
  try {
    if (rustTrim(request.note_id).length === 0) {
      throw new CommandError(AppError.validation('未找到要导出的笔记'));
    }
    const summary = await stagedSingleExport(ctx, request.output_path ?? null, (outputPath) => exportSingle({
      conn: ctx.conn,
      settings: ctx.settings,
      baseDir: ctx.baseDir,
      appDataDir: ctx.appDataDir,
      appVersion: ctx.appVersion,
      includeVersions: request.include_versions ?? true,
      outputPath,
    }, request.note_id));
    return {
      output_path: summary.output_path,
      note_count: summary.note_count,
      attachment_count: summary.attachment_count,
    };
  } catch (error) {
    return exportFailure(error);
  }
}

export async function importAll(
  ctx: TransferContext,
  request: Commands['notes_import']['args']['request'],
): Promise<Commands['notes_import']['result']> {
  try {
    // cmd/notes.rs: `unified_file_manager::ensure_local_path`.
    const filePath = materializeLocalImportPath(request.file_path);
    const summary = await importNotes({
      conn: ctx.conn,
      settings: ctx.settings,
      baseDir: ctx.baseDir,
      filePath,
      conflictStrategy: importConflictStrategy(request.conflict_strategy),
      ...(ctx.onProgress === undefined ? {} : { onProgress: ctx.onProgress }),
    });
    return {
      subject_count: summary.subject_count,
      note_count: summary.note_count,
      attachment_count: summary.attachment_count,
      skipped_count: summary.skipped_count,
      overwritten_count: summary.overwritten_count,
    };
  } catch (error) {
    return exportFailure(error);
  }
}
