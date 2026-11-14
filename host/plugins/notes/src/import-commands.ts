// cmd/notes.rs::notes_import_markdown / notes_import_markdown_batch.
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { Commands } from '../../../../contracts/ipc/generated/L10-notes.ts';
import { importMarkdownNote, markdownTitleFromPath, normalizeFolderId } from '../repository/import.ts';
import { NoteFileSystemError } from '../repository/errors.ts';
import { errorMessage, materializeLocalImportPath } from './command-utils.ts';
import { rustTrim } from '../../../platform/util/index.ts';

function importMarkdownNode(
  conn: SqlExecutor,
  rawPath: string,
  titleHint: string,
  folderId: string | null,
): Commands['notes_import_markdown']['result'] {
  const importPath = materializeLocalImportPath(rawPath);
  try {
    return importMarkdownNote(conn, importPath, markdownTitleFromPath(titleHint), folderId);
  } catch (error) {
    if (error instanceof NoteFileSystemError) throw new CommandError(AppError.file_system(error.message));
    throw new CommandError(AppError.database(`导入 Markdown 笔记失败: ${errorMessage(error)}`));
  }
}

function nonEmptyHint(hint: string | null | undefined, fallback: string): string {
  return hint !== null && hint !== undefined && rustTrim(hint).length > 0 ? hint : fallback;
}

function failureMessage(error: unknown): string {
  if (error instanceof CommandError && typeof error.value === 'object' && error.value !== null) {
    const value = error.value as { message?: unknown };
    if (typeof value.message === 'string') return value.message;
  }
  return errorMessage(error);
}

export function importMarkdown(
  conn: SqlExecutor,
  request: Commands['notes_import_markdown']['args']['request'],
): Commands['notes_import_markdown']['result'] {
  const rawPath = rustTrim(request.filePath);
  if (rawPath.length === 0) throw new CommandError(AppError.validation('Markdown 文件路径不能为空'));
  const folderId = normalizeFolderId(request.folderId);
  return importMarkdownNode(conn, rawPath, nonEmptyHint(request.titleHint, rawPath), folderId);
}

export function importMarkdownBatch(
  conn: SqlExecutor,
  request: Commands['notes_import_markdown_batch']['args']['request'],
): Commands['notes_import_markdown_batch']['result'] {
  const imported: Commands['notes_import_markdown_batch']['result']['imported'] = [];
  const failed: Commands['notes_import_markdown_batch']['result']['failed'] = [];
  if (request.items.length === 0) return { imported, failed };
  const folderId = normalizeFolderId(request.folderId);

  // Rust materializes every item before importing any note; a missing path
  // aborts the whole batch instead of becoming a per-item failure.
  const items = request.items.map((item) => {
    const rawPath = rustTrim(item.filePath);
    if (rawPath.length === 0) {
      throw new CommandError(AppError.validation('Markdown 文件路径不能为空'));
    }
    materializeLocalImportPath(rawPath);
    return { rawPath, titleHint: nonEmptyHint(item.titleHint, rawPath) };
  });

  for (const item of items) {
    try {
      imported.push(importMarkdownNode(conn, item.rawPath, item.titleHint, folderId));
    } catch (error) {
      failed.push({ file_path: item.rawPath, message: failureMessage(error) });
    }
  }
  return { imported, failed };
}
