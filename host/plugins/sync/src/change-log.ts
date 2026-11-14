import type { ChangeOperation, DbJson as JsonValue, EngineChange as SyncChangeWithData } from '../api.ts';
import { rowSyncTables } from './classification.ts';
import { isJsonObject } from '../../../platform/util/lossless-json.ts';

export interface ChangeLogEntry {
  id: number | bigint;
  table_name: string;
  record_id: string;
  operation: ChangeOperation;
  changed_at: string;
  sync_version: number | bigint;
  field_deltas_json?: JsonValue;
}

/** sync/mod.rs:9980-10059. */
export interface PendingChanges {
  entries: ChangeLogEntry[];
  changes_by_table: Record<string, number>;
  total_count: number;
  earliest_change: string | null;
  latest_change: string | null;
}

/** sync/mod.rs:9666-9675. */
export interface ChangeLogStats {
  total_count: number;
  pending_count: number;
  synced_count: number;
}

/** sync/mod.rs:9743-9761. Unknown values fall back to Update at the row layer. */
export function changeOperationFromStr(value: string): ChangeOperation | null {
  switch (value.toUpperCase()) {
    case 'INSERT': return 'Insert';
    case 'UPDATE': return 'Update';
    case 'DELETE': return 'Delete';
    default: return null;
  }
}

export function changeOperationAsStr(value: ChangeOperation): 'INSERT' | 'UPDATE' | 'DELETE' {
  switch (value) {
    case 'Insert': return 'INSERT';
    case 'Update': return 'UPDATE';
    case 'Delete': return 'DELETE';
  }
}

export function pendingChangesFromEntries(entries: ChangeLogEntry[]): PendingChanges {
  const changesByTable: Record<string, number> = {};
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const entry of entries) {
    changesByTable[entry.table_name] = (changesByTable[entry.table_name] ?? 0) + 1;
    if (earliest === null || entry.changed_at < earliest) earliest = entry.changed_at;
    if (latest === null || entry.changed_at > latest) latest = entry.changed_at;
  }
  return {
    entries,
    changes_by_table: changesByTable,
    total_count: entries.length,
    earliest_change: earliest,
    latest_change: latest,
  };
}

export function pendingHasChanges(pending: PendingChanges): boolean {
  return pending.total_count > 0;
}

/** `SyncManager::filter_pending_changes_for_database`（sync/mod.rs:4262）。 */
export function filterPendingChangesForDatabase(
  pending: PendingChanges,
  databaseName: string,
): PendingChanges {
  const tables = new Set(
    rowSyncTables()
      .filter(entry => entry.database === databaseName)
      .map(entry => entry.table_name),
  );
  return pendingChangesFromEntries(pending.entries.filter(entry => tables.has(entry.table_name)));
}

export function pendingTableChanges(pending: PendingChanges, tableName: string): ChangeLogEntry[] {
  return pending.entries.filter(entry => entry.table_name === tableName);
}

export function pendingChangeIds(pending: PendingChanges): Array<number | bigint> {
  return pending.entries.map(entry => entry.id);
}

const SYNC_FIELD_DELTAS_KEY = '__sync_field_deltas';

/** sync/mod.rs:9821-9841. */
export function fromEntryWithData(entry: ChangeLogEntry, data: JsonValue | null): SyncChangeWithData {
  let enriched = data;
  if (entry.field_deltas_json !== undefined && isJsonObject(enriched)) {
    enriched = { ...enriched, [SYNC_FIELD_DELTAS_KEY]: entry.field_deltas_json };
  }
  return {
    table_name: entry.table_name,
    record_id: entry.record_id,
    operation: entry.operation,
    data: enriched,
    changed_at: entry.changed_at,
    change_log_id: entry.id,
    database_name: null,
    suppress_change_log: null,
    source_device_id: null,
    source_seq: null,
  };
}

/** sync/mod.rs:3223-3226. */
export function normalizeVersionToSeconds(version: number): number {
  return version > 100_000_000_000 ? Math.floor(version / 1000) : version;
}
