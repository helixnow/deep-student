/** vfs/upload_saga.rs: same-connection, nestable savepoint with observable rollback failure. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { VfsError } from '../src/error.ts';
export interface UploadLog {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export function uploadSavepoint<T>(conn: SqlExecutor, name: string, work: () => T, log: UploadLog): T {
  try { conn.exec(`SAVEPOINT ${name}`); }
  catch (error) {
    log.error('[VFS::UploadSaga] Failed to open savepoint %s: %s', name, message(error));
    throw new VfsError('Database', `Failed to open savepoint ${name}: ${message(error)}`);
  }
  let result: T;
  try { result = work(); }
  catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`); }
    catch (rollbackError) {
      log.error('[VFS::UploadSaga] Rollback of savepoint %s failed: %s', name, message(rollbackError));
      throw new VfsError('Database', `${message(error)}; savepoint ${name} rollback failed: ${message(rollbackError)}`);
    }
    throw error;
  }
  try { conn.exec(`RELEASE SAVEPOINT ${name}`); }
  catch (error) {
    log.error('[VFS::UploadSaga] Failed to release savepoint %s: %s', name, message(error));
    throw new VfsError('Database', `Failed to release savepoint ${name}: ${message(error)}`);
  }
  return result;
}
