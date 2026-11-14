/**
 * Pre-storage `SyncStateStore::reset_default_after_local_purge` (state.rs:528-552).
 *
 * F3 calls this from `DataSpaceStartup` *before* `ctx.storage` is published
 * (host/platform/storage/api.ts `StorageStartupSyncService`), so the regular
 * `dstu.sync-support` service cannot be the provider: it injects `storage`.
 * Like Rust `open_default`, this opens `sync_state.db` on its own connection via
 * F3's public `openStartupDatabase` seam (same Connection/PROFILES.sync_state), creates
 * the same schema, and clears the five consumed-state tables in one transaction while
 * preserving `upload_seq` and `tombstone_event_publish`.
 */
import { openStartupDatabase, type StartupDatabase } from '../../../platform/storage/node.ts';
import { SyncError } from '../src/errors.ts';
import { PURGE_RESET_TABLES, SYNC_STATE_SCHEMA } from './state.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function resetDefaultAfterLocalPurgeAt(path: string): void {
  let conn: StartupDatabase;
  try {
    conn = openStartupDatabase(path, { label: 'sync_state' });
  } catch (error) {
    throw new SyncError(`Database error: 打开 sync_state.db 失败: ${message(error)}`);
  }
  try {
    try {
      conn.exec(SYNC_STATE_SCHEMA);
    } catch (error) {
      throw new SyncError(`Database error: 初始化 sync_state.db 失败: ${message(error)}`);
    }
    // Rust uses `unchecked_transaction()` = deferred BEGIN.
    try {
      conn.begin();
    } catch (error) {
      throw new SyncError(`Database error: 开始清空同步基线事务失败: ${message(error)}`);
    }
    try {
      for (const table of PURGE_RESET_TABLES) {
        try {
          conn.run(`DELETE FROM ${table}`);
        } catch (error) {
          throw new SyncError(`Database error: 清空同步状态表 ${table} 失败: ${message(error)}`);
        }
      }
    } catch (error) {
      conn.rollback();
      throw error;
    }
    try {
      conn.commit();
    } catch (error) {
      throw new SyncError(`Database error: 提交清空同步基线事务失败: ${message(error)}`);
    }
  } finally {
    conn.close();
  }
}
