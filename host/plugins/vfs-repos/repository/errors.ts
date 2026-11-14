import { logWarn } from './logger.ts';
import { StorageError } from '../../../platform/storage/api.ts';
import { VfsRepositoryError } from '../api.ts';

export function databaseResult<T>(run: () => T): T {
  try { return run(); }
  catch (error) {
    if (error instanceof StorageError) {
      throw new VfsRepositoryError('VFS_STORAGE', `Database error: ${error.message}`, undefined, error);
    }
    throw error;
  }
}

export function rollbackIgnoringFailure(conn: { exec(sql: string): void }): void {
  try { conn.exec('ROLLBACK'); }
  catch (error) { logWarn('[VFS] Rollback failed:', error); }
}
