/** commands_sync.rs:1755-1804,3084-3158. The progress path ignores pending-query errors. */
import { fs } from '../src/local-runtime.ts';
import type { CoordinatedDatabaseName, StorageService } from '../../../platform/storage/api.ts';
import { tableExists, tableHasColumn, quoteIdentifier } from '../repository/sqlite-values.ts';
import { getPendingChanges, markSyncedWithTimestamp } from '../repository/change-log.ts';
import { enrichChangesWithData, getRecordData } from '../repository/record-data.ts';
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
      const unresolvedKeys = new Set<string>();
      const unresolvedResourceIds = new Set<string>();
      if (tableExists(db, '__sync_conflicts')) {
        try {
          const conflictRows = db.all<{ table_name: string; record_id: string; data_json: string }>(
            'SELECT table_name, record_id, data_json FROM __sync_conflicts WHERE resolved_at IS NULL',
          );
          for (const row of conflictRows) {
            unresolvedKeys.add(`${row.table_name}\u001f${row.record_id}`);
            if (row.table_name === 'resources') {
              unresolvedResourceIds.add(row.record_id);
            } else if (row.table_name === 'notes') {
              try {
                const parsed = JSON.parse(row.data_json) as Record<string, unknown> | null;
                if (parsed && typeof parsed.resource_id === 'string') {
                  unresolvedResourceIds.add(parsed.resource_id);
                }
              } catch { /* ignore */ }
              if (tableExists(db, 'notes')) {
                const resId = db.pluck<string | null>('SELECT resource_id FROM notes WHERE id = ?1', [row.record_id]);
                if (resId) unresolvedResourceIds.add(resId);
              }
            }
          }
        } catch {
          // ignore optional conflict table query errors
        }
      }
      const activeEntries = unresolvedKeys.size === 0
        ? pending.entries
        : pending.entries.filter(entry => {
            if (unresolvedKeys.has(`${entry.table_name}\u001f${entry.record_id}`)) return false;
            if (entry.table_name === 'resources' && unresolvedResourceIds.has(entry.record_id)) return false;
            if (entry.table_name === 'note_document_formats' && unresolvedKeys.has(`notes\u001f${entry.record_id}`)) return false;
            if (entry.table_name === 'note_document_revisions' && tableExists(db, 'note_document_revisions')) {
              try {
                const parentNoteId = db.pluck<string | null>('SELECT note_id FROM note_document_revisions WHERE version_id = ?1', [entry.record_id]);
                if (parentNoteId && unresolvedKeys.has(`notes\u001f${parentNoteId}`)) return false;
              } catch { /* ignore */ }
            }
            return true;
          });
      if (activeEntries.length === 0) continue;
      const idColumnMap = buildIdColumnMap();
      let enriched: EngineChange[];
      try {
        enriched = enrichChangesWithData(db, activeEntries, idColumnMap);
      } catch (error) { throw new Error(`补全数据库 ${name} 变更数据失败: ${message(error)}`); }
      const pendingDeletes = new Set<string>();
      for (const change of enriched) {
        if (change.operation === 'Delete') {
          pendingDeletes.add(`${change.table_name}\u001f${change.record_id}`);
        }
      }
      const obsoleteIds: (number | bigint)[] = [];
      for (const change of enriched) {
        if ((change.operation === 'Insert' || change.operation === 'Update') && change.data === null) {
          const key = `${change.table_name}\u001f${change.record_id}`;
          if (pendingDeletes.has(key) || change.table_name === 'note_document_revisions') {
            if (change.change_log_id != null) obsoleteIds.push(change.change_log_id);
            continue;
          }
          const everSynced = Boolean(
            db.pluck(
              'SELECT EXISTS(SELECT 1 FROM __change_log WHERE table_name = ?1 AND record_id = ?2 AND sync_version > 0)',
              [change.table_name, change.record_id],
            ),
          );
          if (everSynced) {
            pendingDeletes.add(key);
            const hardDelete = tableHasColumn(db, change.table_name, 'deleted_at');
            changes.push({
              ...change,
              operation: 'Delete',
              data: null,
              database_name: name,
              ...(hardDelete ? { hard_delete: true } : {}),
            });
          } else if (change.change_log_id != null) {
            obsoleteIds.push(change.change_log_id);
          }
          continue;
        }
        if (change.operation === 'Delete' && tableHasColumn(db, change.table_name, 'deleted_at')) {
          const idCol = idColumnMap.get(change.table_name) ?? 'id';
          const rowStillPresent = getRecordData(db, change.table_name, change.record_id, idCol) !== null;
          changes.push({
            ...change,
            database_name: name,
            ...(!rowStillPresent ? { hard_delete: true } : {}),
          });
          continue;
        }
        changes.push({ ...change, database_name: name });
      }
      if (obsoleteIds.length > 0) {
        try { markSyncedWithTimestamp(db, [...new Set(obsoleteIds)]); }
        catch { /* non-fatal cleanup of superseded local log rows */ }
      }
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
          if ((change.operation === 'Insert' || change.operation === 'Update') && change.data === null) {
            continue;
          }
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
