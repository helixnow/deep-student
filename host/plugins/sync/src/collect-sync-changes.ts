/** commands_sync.rs:1755-1804,3084-3158. The progress path ignores pending-query errors. */
import { fs } from '../src/local-runtime.ts';
import type { CoordinatedDatabaseName, StorageService } from '../../../platform/storage/api.ts';
import { tableExists } from '../repository/sqlite-values.ts';
import { getPendingChanges } from '../repository/change-log.ts';
import { enrichChangesWithData } from '../repository/record-data.ts';
import { buildIdColumnMap } from './conflict-commands.ts';
import { filterPendingChangesForDatabase, pendingHasChanges } from './change-log.ts';
import type { EngineChange } from './change-payload.ts';
import type { SyncProgressEmitter } from './emitter.ts';

const names: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export async function collectSyncChanges(local: StorageService, emitter: SyncProgressEmitter | null): Promise<EngineChange[]> {
  const changes: EngineChange[] = []; let found = false;
  for (const [index, name] of names.entries()) {
    const path = local.pathOf(name); if (!fs.existsSync(path)) continue;
    found = true;
    await emitter?.emit({ operation_id: null, outcome: null, phase: 'detecting_changes', percent: 5, current: index + 1, total: 4,
      current_item: name, speed_bytes_per_sec: null, eta_seconds: null, error: null });
    let db;
    try { db = local.openFile(path, { profile: 'plain' }); }
    catch (error) { throw new Error(`打开数据库 ${name} 失败: ${message(error)}`); }
    try {
      if (!tableExists(db, '__change_log')) continue;
      let pending;
      try { pending = filterPendingChangesForDatabase(getPendingChanges(db, null, null), name); }
      catch (error) {
        if (emitter !== null) continue;
        throw new Error(`获取数据库 ${name} 待同步变更失败: ${message(error)}`);
      }
      if (!pendingHasChanges(pending)) continue;
      try {
        for (const change of enrichChangesWithData(db, pending.entries, buildIdColumnMap())) changes.push({ ...change, database_name: name });
      } catch (error) { throw new Error(`补全数据库 ${name} 变更数据失败: ${message(error)}`); }
    } finally { local.close(db); }
  }
  if (!found) throw new Error('未找到可用的数据库。请先初始化数据库。');
  return changes;
}
