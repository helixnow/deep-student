import { fs } from '../src/local-runtime.ts';
import { dirname } from '../../../platform/util/path.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { CoordinatedDatabaseName, DatabaseHandle, StorageService } from '../../../platform/storage/api.ts';
import type { RecordConflictRow as WireRecordConflictRow, SyncQuarantineRow } from '../api.ts';
import {
  listQuarantineRows,
  listUnresolvedConflictRows,
  sqliteTableExists,
  type QuarantineRow, type RecordConflictRow,
} from '../repository/conflicts.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

const databases: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function open(storage: StorageService, name: CoordinatedDatabaseName): DatabaseHandle {
  const path = storage.pathOf(name);
  if (!fs.existsSync(dirname(path))) throw new Error(`unable to open database file: ${path}`);
  return storage.openFile(path, { profile: 'plain' });
}

function compareTextDescending(left: string, right: string): number {
  return compareUtf8(right, left);
}

/** commands_sync.rs:4168-4229. */
export function listQuarantine(storage: StorageService, limit?: number | null, offset?: number | null): SyncQuarantineRow[] {
  const cappedLimit = Math.min(limit ?? 200, 2000);
  const start = offset ?? 0;
  const out: Array<QuarantineRow & { database_name: string }> = [];
  for (const name of databases) {
    if (!fs.existsSync(storage.pathOf(name))) continue;
    let db: DatabaseHandle;
    try { db = open(storage, name); } catch { continue; }
    try {
      if (!sqliteTableExists(db, '__sync_quarantine')) continue;
      let rows;
      try {
        rows = listQuarantineRows(db);
      } catch (error) {
        throw new CommandError(message(error));
      }
      for (const row of rows) out.push({ ...row, database_name: name });
    } finally {
      storage.close(db);
    }
  }
  out.sort((left, right) => compareTextDescending(left.last_attempt, right.last_attempt) || compareIdDescending(left.id, right.id));
  return out.slice(start, start + cappedLimit).map(row => ({ ...row, id: Number(row.id), source_seq: Number(row.source_seq), attempts: Number(row.attempts) }));
}

/** commands_sync.rs:4407-4501. Pagination counts (database, table, record) groups. */
export function listRecordConflicts(storage: StorageService, limit?: number | null, offset?: number | null): WireRecordConflictRow[] {
  const cappedLimit = Math.min(limit ?? 200, 2000);
  const start = offset ?? 0;
  const out: Array<RecordConflictRow & { database_name: string }> = [];
  for (const name of databases) {
    if (!fs.existsSync(storage.pathOf(name))) continue;
    let db: DatabaseHandle;
    try { db = open(storage, name); } catch { continue; }
    try {
      if (!sqliteTableExists(db, '__sync_conflicts')) continue;
      let rows;
      try {
        rows = listUnresolvedConflictRows(db);
      } catch (error) {
        throw new CommandError(message(error));
      }
      for (const row of rows) out.push({ ...row, database_name: name });
    } finally {
      storage.close(db);
    }
  }
  out.sort((left, right) => compareTextDescending(left.detected_at, right.detected_at) || compareIdDescending(left.id, right.id));

  const seen = new Set<string>();
  const selected = new Set<string>();
  let groupIndex = 0;
  for (const row of out) {
    const key = `${row.database_name}\u001f${row.table_name}\u001f${row.record_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (groupIndex >= start && groupIndex < start + cappedLimit) selected.add(key);
      groupIndex += 1;
    }
  }
  return out.filter(row => selected.has(`${row.database_name}\u001f${row.table_name}\u001f${row.record_id}`)).map(row => ({ ...row, id: Number(row.id) }));
}

function compareIdDescending(a: bigint, b: bigint): number { return a < b ? 1 : a > b ? -1 : 0; }

/** commands_sync.rs:1429-1460: the batch API is disabled before touching any database. */
export function resolveConflicts(strategy: string, cloudManifestJson: string, beforeStrategy?: () => void): never {
  if (strategy !== '' || cloudManifestJson !== '') {
    throw new CommandError(
      '批量清单级冲突接口已停用，因为它只生成记录 ID、不会提交数据库或云端变更。请使用 data_governance_list_record_conflicts 和 data_governance_resolve_record_conflict 逐条裁决。',
    );
  }
  beforeStrategy?.();
  throw new CommandError(`未知的合并策略: ${strategy}。可选值: keep_local, use_cloud, keep_latest, manual`);
}
