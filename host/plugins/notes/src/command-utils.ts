// Shared command-boundary adapters for cmd/notes.rs. Each Rust command maps
// failures to a specific AppError variant/message; keep those mappings here so
// index.ts stays pure wiring.
import type { Context } from '@deepseek-ai/cordis';
import { notesLocalRuntime } from './local-runtime.ts';
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsService } from '../../../platform/settings/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { ImportConflictStrategy } from '../repository/exporter.ts';
import { NotesExporterError } from '../repository/exporter.ts';
import { AssetError } from '../repository/assets.ts';
import { noteFormatRepository } from '../repository/format.ts';
import { invalid, NoteDocumentError } from '../repository/errors.ts';
import { noteRepository } from '../repository/notes.ts';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rust `as u32`: truncating float->int conversion followed by modulo 2^32. */
export function u32(value: number): number {
  return Number(BigInt.asUintN(32, BigInt(Math.trunc(value))));
}

export function settingsService(ctx: Context): SettingsService {
  const service = ctx.get('settings') as SettingsService | undefined;
  if (service === undefined) {
    throw new CommandError(AppError.configuration('Settings service unavailable'));
  }
  return service;
}

export function formatStatus(
  conn: SqlExecutor,
  noteId: string,
): Commands['notes_get_format']['result'] {
  const format = noteFormatRepository.get(conn, noteId);
  const note = noteRepository.getNoteIncludingDeleted(noteId, conn);
  if (note === null) invalid('Note missing');
  return {
    ...format,
    required_capabilities: noteFormatRepository.requiredCapabilities(format),
    updated_at: note.updatedAt,
  };
}

/** cmd/notes.rs asset commands: AssetError kind decides validation vs filesystem. */
export function assetFailure(error: unknown): never {
  if (error instanceof AssetError) {
    if (error.kind === 'validation') throw new CommandError(AppError.validation(error.message));
    if (error.kind === 'database') throw new CommandError(AppError.database(error.message));
    throw new CommandError(AppError.file_system(error.message));
  }
  throw new CommandError(AppError.file_system(errorMessage(error)));
}

export function exportFailure(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error) {
    throw new CommandError(error);
  }
  if (error instanceof NotesExporterError) {
    switch (error.kind) {
      case 'validation': throw new CommandError(AppError.validation(error.message));
      case 'filesystem': throw new CommandError(AppError.file_system(error.message));
      case 'database': throw new CommandError(AppError.database(error.message));
      default: throw new CommandError(AppError.internal(error.message));
    }
  }
  if (error instanceof NoteDocumentError) {
    throw new CommandError(AppError.validation(error.message));
  }
  throw new CommandError(AppError.database(errorMessage(error)));
}

export function importConflictStrategy(value: string | null | undefined): ImportConflictStrategy {
  if (value === 'overwrite') return 'overwrite';
  if (value === 'merge_keep_newer') return 'merge_keep_newer';
  return 'skip';
}

/**
 * cmd/notes.rs `unified_file_manager::ensure_local_path`: canonical local path.
 * SAF/content URIs have no Electron desktop equivalent; the Host unified-file-
 * manager fails closed instead of silently reading a local path.
 */
export function materializeLocalImportPath(rawPath: string): string {
  const classified = notesLocalRuntime().classifyPath(rawPath);
  if (classified.kind === 'virtual') {
    throw new CommandError(AppError.file_system(
      `读取文件失败: ${classified.uri} (虚拟路径在当前平台不可用)`));
  }
  if (!notesLocalRuntime().exists(classified.path)) {
    throw new CommandError(AppError.file_system(`文件不存在: ${classified.path}`));
  }
  try {
    return notesLocalRuntime().realpath(classified.path);
  } catch {
    return classified.path;
  }
}
