/** upload_saga.rs:43-94. Transaction control only; all table writes stay with L11. */
import type { Context } from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { VfsError } from '../../vfs/portable.ts';

const NAME = 'vfs_upload_file_saga';
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function withUploadSavepoint<T>(conn: SqlExecutor, log: Context['logger'], run: () => T): T {
  try { conn.exec('SAVEPOINT vfs_upload_file_saga'); }
  catch (error) {
    log.error('[VFS::UploadSaga] Failed to open savepoint %s: %s', NAME, message(error));
    throw new VfsError('Database', `Failed to open savepoint ${NAME}: ${message(error)}`);
  }

  let result: T;
  try { result = run(); }
  catch (error) {
    try { conn.exec('ROLLBACK TO SAVEPOINT vfs_upload_file_saga; RELEASE SAVEPOINT vfs_upload_file_saga;'); }
    catch (rollbackError) {
      log.error('[VFS::UploadSaga] Rollback of savepoint %s failed: %s', NAME, message(rollbackError));
      throw new VfsError('Database', `${message(error)}; savepoint ${NAME} rollback failed: ${message(rollbackError)}`);
    }
    throw error;
  }

  try { conn.exec('RELEASE SAVEPOINT vfs_upload_file_saga'); }
  catch (error) {
    log.error('[VFS::UploadSaga] Failed to release savepoint %s: %s', NAME, message(error));
    throw new VfsError('Database', `Failed to release savepoint ${NAME}: ${message(error)}`);
  }
  return result;
}
