/** Local marking/rollback/archive from commands_sync.rs:82-121,333-381,3936-3956. */
import { fs } from '../src/local-runtime.ts';
import type { CoordinatedDatabaseName, StorageService } from '../../../platform/storage/api.ts';
import { nowEpochNanos, toRfc3339 } from '../../../platform/time/index.ts';
import type { EngineChange } from '../src/change-payload.ts';
import type { SyncLogger } from '../src/log.ts';
import { markSyncedWithTimestamp, cleanupSyncedChanges } from './change-log.ts';
import { prepareDeleteVersionsForCleanup } from './apply-record.ts';

const names: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export type MarkedChanges = Map<CoordinatedDatabaseName, (number | bigint)[]>;
export function markUploadedChanges(local: StorageService, changes: readonly EngineChange[], openEmpty = false): MarkedChanges {
  const marked: MarkedChanges = new Map();
  for (const name of names) {
    if (!fs.existsSync(local.pathOf(name))) continue;
    const ids = changes.filter(change => change.database_name === name).flatMap(change => change.change_log_id == null ? [] : [change.change_log_id]);
    if (ids.length === 0 && !openEmpty) continue;
    let db;
    try { db = local.openFile(local.pathOf(name), { profile: 'plain' }); }
    catch (error) { throw new Error(`打开数据库失败: ${message(error)}`); }
    try {
      if (ids.length === 0) continue;
      try { markSyncedWithTimestamp(db, ids); }
      catch (error) { throw new Error(`标记变更失败: ${message(error)}`); }
      marked.set(name, ids);
    } finally { local.close(db); }
  }
  return marked;
}
export function rollbackMarkedChanges(local: StorageService, marked: MarkedChanges, logger: SyncLogger): void {
  for (const [name, ids] of marked) {
    if (ids.length === 0) continue;
    let db;
    try { db = local.openFile(local.pathOf(name), { profile: 'plain' }); }
    catch { logger.warn(`[data_governance] 回滚 sync_version 失败：无法打开数据库 ${name}`); continue; }
    try {
      for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        try { db.run(`UPDATE __change_log SET sync_version=0 WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk); }
        catch (error) { logger.warn(`[data_governance] 回滚 sync_version 失败（${name}，${chunk.length} 条）: ${message(error)}`); }
      }
    } finally { local.close(db); }
  }
}
export function archiveSyncedChangeLogs(local: StorageService, keepDays: number, deviceId: string, logger: SyncLogger): void {
  const cutoff = toRfc3339(nowEpochNanos() - BigInt(keepDays) * 86_400_000_000_000n);
  for (const name of names) {
    if (!fs.existsSync(local.pathOf(name))) continue;
    let db;
    try { db = local.openFile(local.pathOf(name), { profile: 'plain' }); }
    catch (error) { logger.warn(`[data_governance] 归档时无法打开数据库 ${name}: ${message(error)}（跳过）`); continue; }
    try {
      try { prepareDeleteVersionsForCleanup(db, deviceId); }
      catch (error) { logger.warn(`[data_governance] DELETE 版本固化失败，跳过变更日志归档（${name}）: ${message(error)}`); continue; }
      try {
        const count = cleanupSyncedChanges(db, cutoff);
        if (count > 0) logger.info(`[data_governance] 已归档 ${count} 条 ${keepDays} 日前的已同步变更日志（${name}）`);
      } catch (error) { logger.warn(`[data_governance] 归档 __change_log 失败（${name}，非致命）: ${message(error)}`); }
    } finally { local.close(db); }
  }
}
