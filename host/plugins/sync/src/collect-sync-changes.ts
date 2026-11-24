/** commands_sync.rs:1755-1804,3084-3158. The progress path ignores pending-query errors. */
import { fs } from '../src/local-runtime.ts';
import type { CoordinatedDatabaseName, StorageService } from '../../../platform/storage/api.ts';
import { tableExists, tableHasColumn, quoteIdentifier } from '../repository/sqlite-values.ts';
import { getPendingChanges } from '../repository/change-log.ts';
import { enrichChangesWithData } from '../repository/record-data.ts';
import { buildIdColumnMap } from './conflict-commands.ts';
import { filterPendingChangesForDatabase, pendingHasChanges } from './change-log.ts';
import type { ChangeLogEntry } from './change-log.ts';
import { rowSyncTables } from './classification.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
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

/** Collect pending changes plus a full active-row UPSERT snapshot across RowSync tables for DSPAIR pairing bootstrap. */
export async function collectFullSnapshotChanges(local: StorageService, emitter: SyncProgressEmitter | null): Promise<EngineChange[]> {
  const pending = await collectSyncChanges(local, emitter);
  const idColumnMap = buildIdColumnMap();
  const seenByDb = new Map<CoordinatedDatabaseName, Set<string>>();
  for (const name of names) seenByDb.set(name, new Set<string>());
  for (const change of pending) {
    const dbName = change.database_name as CoordinatedDatabaseName | null | undefined;
    if (dbName && seenByDb.has(dbName)) {
      seenByDb.get(dbName)!.add(`${change.table_name}\u001f${change.record_id}`);
    }
  }
  const snapshot: EngineChange[] = [...pending];
  const now = toRfc3339();
  const tableWeight = (table: string): number => table === 'resources' ? 0 : table === 'folders' ? 1 : table === 'notes' ? 2 : 3;

  for (const name of names) {
    const path = local.pathOf(name);
    if (!fs.existsSync(path)) continue;
    let db;
    try { db = local.openFile(path, { profile: 'plain' }); }
    catch { continue; }
    try {
      const seen = seenByDb.get(name)!;
      const syntheticEntries: ChangeLogEntry[] = [];
      const tables = rowSyncTables()
        .filter(entry => entry.database === name && entry.primary_key !== '(virtual)')
        .sort((a, b) => tableWeight(a.table_name) - tableWeight(b.table_name));
      for (const entry of tables) {
        if (!tableExists(db, entry.table_name)) continue;
        const pkColumns = entry.primary_key.split(',').map(part => part.trim()).filter(Boolean);
        if (pkColumns.length === 0 || !pkColumns.every(col => tableHasColumn(db, entry.table_name, col))) continue;
        const selectCols = pkColumns.map(quoteIdentifier).join(', ');
        const hasUpdatedAt = tableHasColumn(db, entry.table_name, 'updated_at');
        const hasCreatedAt = tableHasColumn(db, entry.table_name, 'created_at');
        const hasDeletedAt = tableHasColumn(db, entry.table_name, 'deleted_at');
        const tsExpr = hasUpdatedAt ? ', updated_at AS _snapshot_ts' : hasCreatedAt ? ', created_at AS _snapshot_ts' : '';
        const whereClause = hasDeletedAt ? ' WHERE deleted_at IS NULL' : '';
        let rows: Array<Record<string, unknown>>;
        try {
          rows = db.all<Record<string, unknown>>(`SELECT ${selectCols}${tsExpr} FROM ${quoteIdentifier(entry.table_name)}${whereClause}`);
        } catch {
          continue;
        }
        for (const row of rows) {
          const recordId = pkColumns.map(col => row[col]).filter(v => v !== null && v !== undefined).map(String).join(':');
          if (!recordId) continue;
          const key = `${entry.table_name}\u001f${recordId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const rawTs = row._snapshot_ts;
          const changedAt = typeof rawTs === 'string' && rawTs.trim() !== '' ? rawTs : now;
          syntheticEntries.push({
            id: 0,
            table_name: entry.table_name,
            record_id: recordId,
            operation: 'Insert',
            changed_at: changedAt,
            sync_version: 0,
          });
        }
      }
      if (syntheticEntries.length > 0) {
        const enrichedSnapshot = enrichChangesWithData(db, syntheticEntries, idColumnMap);
        for (const change of enrichedSnapshot) {
          const key = `${change.table_name}\u001f${change.record_id}`;
          if (change.table_name.startsWith('note_') && pending.some(p => p.database_name === name && `${p.table_name}\u001f${p.record_id}` === key)) {
            continue;
          }
          snapshot.push({ ...change, change_log_id: null, database_name: name });
        }
      }
    } finally {
      local.close(db);
    }
  }
  return snapshot;
}
