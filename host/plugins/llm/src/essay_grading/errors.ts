import { AppError, CommandError } from '../../../../platform/errors/api.ts';
import { EssayGradingError } from './pipeline.ts';
import { VfsRepositoryError } from '../../../vfs-repos/api.ts';

export function errorText(error: unknown): string {
  if (error instanceof CommandError) return errorText(error.value);
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return String(error);
}

export function gradingError(error: unknown): AppError {
  if (error instanceof CommandError) return gradingError(error.value);
  if (error instanceof EssayGradingError) return AppError.with_details(error.errorType, error.message, error.details);
  if (typeof error === 'object' && error !== null && 'error_type' in error && 'message' in error) return error as AppError;
  return AppError.internal(errorText(error));
}

export function vfsOperation<T>(context: string, operation: () => T): T {
  try { return operation(); } catch (error) {
    const kind = error instanceof VfsRepositoryError ? error.code.replace(/^VFS_/, '')
      : typeof error === 'object' && error !== null && 'kind' in error ? error.kind : null;
    const factory = kind === 'NOT_FOUND' || kind === 'ITEM_NOT_FOUND' || kind === 'NotFound' || kind === 'ItemNotFound' ? AppError.not_found
      : kind === 'INVALID_ARGUMENT' || kind === 'InvalidArgument' ? AppError.validation : AppError.database;
    throw new CommandError(factory(`${context}: ${errorText(error)}`));
  }
}
