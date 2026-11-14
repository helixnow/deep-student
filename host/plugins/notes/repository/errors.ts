import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { StorageError } from '../../../platform/storage/errors.ts';
import { NoteSerializationError } from './json.ts';

// note_format_repo.rs:14-25. Keep domain errors distinct until the IPC boundary.
export class NoteDocumentError extends Error {
  readonly kind: 'invalid' | 'conflict';
  readonly key: string;
  /** VfsError::InvalidArgument.param (Display uses it verbatim). */
  readonly param: string;
  constructor(kind: 'invalid' | 'conflict', message: string, key = '', param = 'note_document') {
    super(message);
    this.kind = kind;
    this.key = key;
    this.param = param;
  }
}

/** File-system failures surface as AppError::file_system at the command boundary. */
export class NoteFileSystemError extends Error {}

/** VfsError variants whose Display text is surfaced verbatim as a database error. */
export class NoteDatabaseError extends Error {}

/** VfsError::NotFound: `map_vfs_error` maps only this variant to AppError::not_found. */
export class NoteNotFoundError extends NoteDatabaseError {}

export function invalid(reason: string): never {
  throw new NoteDocumentError('invalid', reason);
}
/** VfsError::InvalidArgument with an explicit param name (title/tags/props). */
export function invalidParam(param: string, reason: string): never {
  throw new NoteDocumentError('invalid', reason, '', param);
}
export function conflict(key: string): never {
  throw new NoteDocumentError('conflict', 'Stored revision changed; reload before retrying', key);
}
/** VfsError::NotFound Display: `<resource_type> not found: <id>`. */
export function notFound(resourceType: string, id: string): never {
  throw new NoteNotFoundError(`${resourceType} not found: ${id}`);
}
/** VfsError::Database Display: `Database error: <message>`. */
export function databaseFailure(message: string): never {
  throw new NoteDatabaseError(`Database error: ${message}`);
}

/**
 * Manual history commands (notes_history_set_pinned / notes_history_restore_copy)
 * map every VfsError to `AppError::database(Display)` instead of going through
 * `note_storage` (no conflict/invalid split).
 */
export function databaseStorage<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(AppError.database(vfsErrorDisplay(error)));
  }
}

/** cmd/notes.rs::note_storage maps VfsError, rather than panic, into AppError. */
export function noteStorage<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof NoteDocumentError) {
      throw new CommandError(error.kind === 'invalid'
        ? AppError.validation(error.message)
        : AppError.conflict(`${error.key}: ${error.message}`));
    }
    if (error instanceof NoteDatabaseError) {
      throw new CommandError(AppError.database(error.message));
    }
    if (error instanceof StorageError) {
      throw new CommandError(AppError.database(`Database error: ${error.message}`));
    }
    if (error instanceof NoteSerializationError) {
      throw new CommandError(AppError.database(`Serialization error: ${error.message}`));
    }
    throw error;
  }
}

/**
 * notes_manager VFS wrappers map every failure to `AppError::database("...: {e}")`
 * (with a plain `CONFLICT(...)` Display for optimistic-lock conflicts).
 */
export function noteManagerStorage<T>(work: () => T, prefix: string): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof NoteDocumentError) {
      const display = error.kind === 'invalid'
        ? `Invalid argument '${error.param}': ${error.message}`
        : `CONFLICT(${error.key}): ${error.message}`;
      throw new CommandError(AppError.database(`${prefix}: ${display}`));
    }
    if (error instanceof NoteDatabaseError) {
      throw new CommandError(AppError.database(`${prefix}: ${error.message}`));
    }
    if (error instanceof StorageError) {
      throw new CommandError(AppError.database(`${prefix}: Database error: ${error.message}`));
    }
    throw error;
  }
}

/**
 * `update_note_vfs` maps VfsError::Conflict to AppError::conflict (keeping the
 * VfsError Display), and every other failure to `AppError::database("...: {e}")`.
 */
export function noteUpdateStorage<T>(work: () => T, prefix = 'VFS 更新笔记失败'): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof NoteDocumentError && error.kind === 'conflict') {
      throw new CommandError(AppError.conflict(`CONFLICT(${error.key}): ${error.message}`));
    }
    return noteManagerStorage(() => { throw error; }, prefix);
  }
}

/** VfsError Display for wrappers that format `{e}` into an AppError message. */
export function vfsErrorDisplay(error: unknown): string {
  if (error instanceof NoteDocumentError) {
    return error.kind === 'invalid'
      ? `Invalid argument '${error.param}': ${error.message}`
      : `CONFLICT(${error.key}): ${error.message}`;
  }
  if (error instanceof StorageError) return `Database error: ${error.message}`;
  if (error instanceof NoteSerializationError) return `Serialization error: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** cmd/notes.rs::map_vfs_error. */
export function mapVfsError(context: string, error: unknown): never {
  if (error instanceof NoteNotFoundError) {
    throw new CommandError(AppError.not_found(`${context}: ${error.message}`));
  }
  throw new CommandError(AppError.database(`${context}: ${vfsErrorDisplay(error)}`));
}

export function commandDatabase(prefix: string, error: unknown): never {
  throw new CommandError(AppError.database(`${prefix}: ${vfsErrorDisplay(error)}`));
}

