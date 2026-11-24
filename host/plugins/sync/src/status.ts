import { fs } from '../src/local-runtime.ts';
import { dirname } from '../../../platform/util/path.ts';
import type { CoordinatedDatabaseName, DatabaseHandle, StorageService } from '../../../platform/storage/api.ts';
import type { PathsService } from '../../../platform/paths/api.ts';
import type { DatabaseSyncStatusResponse, SyncStatusResponse } from '../api.ts';
import { changeLogTableExists, getChangeLogStats, getLastSyncedChangeAt } from '../repository/change-log.ts';
import type { SyncLogger } from './log.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

const databases: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function open(storage: StorageService, name: CoordinatedDatabaseName): DatabaseHandle {
  const path = storage.pathOf(name);
  if (!fs.existsSync(dirname(path))) throw new Error(`unable to open database file: ${path}`);
  return storage.openFile(path, { profile: 'plain' });
}

function parseTimestampMs(value: string): number | null {
  const sqliteUtc = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value.trim());
  const normalized = sqliteUtc ? `${sqliteUtc[1]}T${sqliteUtc[2]}Z` : value.trim();
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function maxString(values: readonly (string | null)[]): string | null {
  let result: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (result === null) {
      result = value;
      continue;
    }
    const leftMs = parseTimestampMs(value);
    const rightMs = parseTimestampMs(result);
    if (leftMs !== null && rightMs !== null) {
      if (leftMs > rightMs) result = value;
    } else if (compareUtf8(value, result) > 0) {
      result = value;
    }
  }
  return result;
}

export interface PendingTableBreakdown {
  table_name: string;
  count: number;
}

export interface PendingDatabaseBreakdown {
  id: CoordinatedDatabaseName;
  pending_changes: number;
  tables: PendingTableBreakdown[];
}

export interface PendingBreakdownResponse {
  total_pending_changes: number;
  databases: PendingDatabaseBreakdown[];
}

export function getPendingBreakdown(storage: StorageService): PendingBreakdownResponse {
  const resultDatabases: PendingDatabaseBreakdown[] = [];
  let totalPending = 0;
  for (const name of databases) {
    if (!fs.existsSync(storage.pathOf(name))) continue;
    let db: DatabaseHandle;
    try {
      db = open(storage, name);
    } catch {
      continue;
    }
    try {
      if (!changeLogTableExists(db)) continue;
      const rows = db.all<{ table_name: string; count: number | bigint }>(
        'SELECT table_name, COUNT(*) AS count FROM __change_log WHERE sync_version = 0 GROUP BY table_name ORDER BY count DESC, table_name ASC',
      );
      const tables = rows.map(row => ({ table_name: row.table_name, count: Number(row.count) }));
      const pending = tables.reduce((sum, item) => sum + item.count, 0);
      totalPending += pending;
      resultDatabases.push({
        id: name,
        pending_changes: pending,
        tables,
      });
    } finally {
      storage.close(db);
    }
  }
  return {
    total_pending_changes: totalPending,
    databases: resultDatabases,
  };
}

/** commands_sync.rs:1025-1186. */
export async function getSyncStatus(
  storage: StorageService,
  paths: PathsService,
  logger?: SyncLogger,
  lastSyncAtOverride: string | null = null,
): Promise<SyncStatusResponse> {
  const entries: DatabaseSyncStatusResponse[] = [];
  const statusErrors: string[] = [];
  let totalPending = 0;
  let totalSynced = 0;

  for (const name of databases) {
    if (!fs.existsSync(storage.pathOf(name))) continue;
    let db: DatabaseHandle;
    try {
      db = open(storage, name);
    } catch (error) {
      statusErrors.push(`${name}: 打开数据库失败: ${message(error)}`);
      entries.push({
        id: name,
        knowledge: 'unknown',
        error: message(error),
        has_change_log: false,
        pending_changes: 0,
        synced_changes: 0,
        last_sync_at: null,
      });
      continue;
    }
    try {
      let hasChangeLog: boolean;
      try {
        hasChangeLog = changeLogTableExists(db);
      } catch (error) {
        const detail = `检查变更日志表失败: ${message(error)}`;
        statusErrors.push(`${name}: ${detail}`);
        entries.push({
          id: name,
          knowledge: 'unknown',
          error: detail,
          has_change_log: false,
          pending_changes: 0,
          synced_changes: 0,
          last_sync_at: null,
        });
        continue;
      }

      if (!hasChangeLog) {
        entries.push({
          id: name,
          knowledge: 'known',
          error: null,
          has_change_log: false,
          pending_changes: 0,
          synced_changes: 0,
          last_sync_at: null,
        });
        continue;
      }

      let stats;
      try {
        stats = getChangeLogStats(db);
      } catch (error) {
        const detail = message(error);
        statusErrors.push(`${name}: 读取变更日志统计失败: ${detail}`);
        entries.push({
          id: name,
          knowledge: 'unknown',
          error: detail,
          has_change_log: true,
          pending_changes: 0,
          synced_changes: 0,
          last_sync_at: null,
        });
        continue;
      }
      totalPending += stats.pending_count;
      totalSynced += stats.synced_count;

      let lastSyncAt: string | null = null;
      let knowledge: DatabaseSyncStatusResponse['knowledge'] = 'known';
      let statusError: string | null = null;
      try {
        lastSyncAt = getLastSyncedChangeAt(db);
      } catch (error) {
        const detail = `读取最后同步时间失败: ${message(error)}`;
        statusErrors.push(`${name}: ${detail}`);
        knowledge = 'unknown';
        statusError = detail;
      }
      entries.push({
        id: name,
        knowledge,
        error: statusError,
        has_change_log: true,
        pending_changes: stats.pending_count,
        synced_changes: stats.synced_count,
        last_sync_at: lastSyncAt,
      });
    } finally {
      storage.close(db);
    }
  }

  logger?.info(`[data_governance] 同步状态: pending=${totalPending}, synced=${totalSynced}, databases=${entries.length}`);
  return {
    partial: statusErrors.length > 0,
    errors: statusErrors,
    has_pending_changes: totalPending > 0,
    total_pending_changes: totalPending,
    total_synced_changes: totalSynced,
    databases: entries,
    last_sync_at: maxString([...entries.map(entry => entry.last_sync_at), lastSyncAtOverride]),
    device_id: await paths.deviceId(),
  };
}
