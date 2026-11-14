/**
 * 记录级冲突解决器（`conflict_resolver.rs` 移植）。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { SyncError } from '../src/errors.ts';
import { compareLwwTimestamps, lwwDevicePair, timestampValueToLwwString } from '../src/lww.ts';
import type { DbJson } from '../../../platform/util/lossless-json.ts';
import { isJsonObject } from '../../../platform/util/lossless-json.ts';
import { canonicalizeSyncValueForCompare, differsSemantically, getRecordData } from './record-data.ts';
import { stringifyJsonLossless } from '../../../platform/util/lossless-json.ts';
import { pluckSafe, tableExists } from './sqlite-values.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { toHex } from '../../../platform/crypto/encoding.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function databaseError(detail: string): never {
  throw new SyncError(`Database error: ${detail}`);
}

export type ConflictPolicy = 'KeepCloud' | 'KeepLocal' | 'KeepLatest';
export type ConflictSide = 'Local' | 'Cloud';

export interface ConflictOutcome {
  winner: ConflictSide;
  loser: ConflictSide;
  winner_data: DbJson;
  loser_data: DbJson;
}

export interface ConflictRecordToSave {
  table_name: string;
  record_id: string;
  side: ConflictSide;
  data: DbJson;
  winning_device_id?: string | null;
  losing_device_id?: string | null;
}

/** 本地未同步变更查询（`local_has_unsynced_change`）。 */
export function localHasUnsyncedChange(db: SqlExecutor, tableName: string, recordId: string): boolean {
  if (!tableExists(db, '__change_log')) return false;
  try {
    return Number(pluckSafe<number | bigint>(
      db,
      'SELECT COUNT(*) FROM __change_log WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0',
      [tableName, recordId],
    ) ?? 0) > 0;
  } catch {
    return false;
  }
}

/** `ConflictResolver::ensure_conflict_table`。 */
export function ensureConflictTable(db: SqlExecutor): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS __sync_conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('local','cloud')),
          data_json TEXT NOT NULL,
          data_hash TEXT NOT NULL DEFAULT '',
          winning_device_id TEXT,
          losing_device_id TEXT,
          detected_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT,
          resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx__sync_conflicts_unresolved
          ON __sync_conflicts(resolved_at) WHERE resolved_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx__sync_conflicts_record
          ON __sync_conflicts(table_name, record_id);
    `);
  } catch (error) {
    databaseError(`创建 __sync_conflicts 失败: ${message(error)}`);
  }

  const hasDataHash = Number(pluckSafe<number | bigint>(
    db,
    "SELECT COUNT(*) FROM pragma_table_info('__sync_conflicts') WHERE name = 'data_hash'",
  ) ?? 0) > 0;
  if (!hasDataHash) {
    try {
      db.run("ALTER TABLE __sync_conflicts ADD COLUMN data_hash TEXT NOT NULL DEFAULT ''");
    } catch { // boundary-allow empty-catch: Rust ensure_conflict_table 对 ALTER TABLE 失败用 `let _` 忽略（列已存在/并发迁移），无日志。
    }
  }

  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx__sync_conflicts_dedup
          ON __sync_conflicts(table_name, record_id, side, data_hash)
          WHERE resolved_at IS NULL;
    `);
  } catch (error) {
    databaseError(`创建冲突表去重索引失败: ${message(error)}`);
  }
}

/** `compute_data_hash`：规范化 JSON 的 SHA-256 前 16 字节 hex。 */
export function computeConflictDataHash(data: DbJson): string {
  const canonical = canonicalizeSyncValueForCompare(data);
  const encoded = stringifyJsonLossless(canonical);
  return toHex(createHasherSync('SHA-256').update(encoded).digest().subarray(0, 16));
}

/** `ConflictResolver::save_conflict_record`。 */
export function saveConflictRecord(db: SqlExecutor, record: ConflictRecordToSave): boolean {
  ensureConflictTable(db);
  const dataJson = stringifyJsonLossless(record.data);
  const dataHash = computeConflictDataHash(record.data);
  try {
    const result = db.run(
      `INSERT INTO __sync_conflicts
       (table_name, record_id, side, data_json, data_hash, winning_device_id, losing_device_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(table_name, record_id, side, data_hash) WHERE resolved_at IS NULL
       DO NOTHING`,
      [
        record.table_name,
        record.record_id,
        record.side === 'Local' ? 'local' : 'cloud',
        dataJson,
        dataHash,
        record.winning_device_id ?? null,
        record.losing_device_id ?? null,
      ],
    );
    return result.changes > 0;
  } catch (error) {
    databaseError(`写入冲突表失败: ${message(error)}`);
  }
}

function extractUpdatedAt(value: DbJson): string | null {
  if (!isJsonObject(value)) return null;
  return timestampValueToLwwString(value.updated_at);
}

export interface ConflictResolverOptions {
  policy: ConflictPolicy;
  /** Cloud 胜出、覆盖/删除本地行之前的快照钩子（history.rs）。 */
  snapshotLocalBeforeOverwrite?: (
    tableName: string,
    recordId: string,
    localData: DbJson,
  ) => void;
}

/** `ConflictResolver::resolve_one`。 */
export function resolveOne(
  db: SqlExecutor,
  change: EngineChange,
  idColumn: string,
  options: ConflictResolverOptions,
): ConflictOutcome | null {
  const { policy } = options;
  if (change.operation === 'Delete') {
    if (!localHasUnsyncedChange(db, change.table_name, change.record_id)) return null;
    const localData = getRecordData(db, change.table_name, change.record_id, idColumn);
    if (localData === null) return null;
    const cloudData: DbJson = null;
    let winner: ConflictSide;
    let loser: ConflictSide;
    if (policy === 'KeepCloud') {
      winner = 'Cloud';
      loser = 'Local';
    } else if (policy === 'KeepLocal') {
      winner = 'Local';
      loser = 'Cloud';
    } else {
      const localTimestamp = extractUpdatedAt(localData);
      if (localTimestamp !== null) {
        const [localDevice, cloudDevice] = lwwDevicePair(localData, null, change.source_device_id ?? null);
        const order = compareLwwTimestamps(
          localTimestamp,
          localDevice,
          stringifyJsonLossless(localData),
          change.changed_at,
          cloudDevice,
          '',
        );
        [winner, loser] = order < 0 ? ['Cloud', 'Local'] : ['Local', 'Cloud'];
      } else {
        [winner, loser] = ['Local', 'Cloud'];
      }
    }
    if (winner === 'Cloud') options.snapshotLocalBeforeOverwrite?.(change.table_name, change.record_id, localData);
    return {
      winner,
      loser,
      winner_data: winner === 'Cloud' ? cloudData : localData,
      loser_data: loser === 'Cloud' ? cloudData : localData,
    };
  }

  if (change.data === null || change.data === undefined) return null;
  const cloudData = change.data;
  if (!localHasUnsyncedChange(db, change.table_name, change.record_id)) return null;
  const localData = getRecordData(db, change.table_name, change.record_id, idColumn);
  if (localData === null) return null;
  if (!differsSemantically(localData, cloudData)) return null;

  let winner: ConflictSide;
  let loser: ConflictSide;
  if (policy === 'KeepCloud') {
    winner = 'Cloud';
    loser = 'Local';
  } else if (policy === 'KeepLocal') {
    winner = 'Local';
    loser = 'Cloud';
  } else {
    const localTimestamp = extractUpdatedAt(localData);
    const cloudTimestamp = extractUpdatedAt(cloudData) ?? change.changed_at;
    if (localTimestamp !== null && cloudTimestamp !== null) {
      const [localDevice, cloudDevice] = lwwDevicePair(localData, cloudData, change.source_device_id ?? null);
      const order = compareLwwTimestamps(
        localTimestamp,
        localDevice,
        stringifyJsonLossless(localData),
        cloudTimestamp,
        cloudDevice,
        stringifyJsonLossless(cloudData),
      );
      [winner, loser] = order < 0 ? ['Cloud', 'Local'] : ['Local', 'Cloud'];
    } else if (localTimestamp !== null) {
      [winner, loser] = ['Local', 'Cloud'];
    } else if (cloudTimestamp !== null) {
      [winner, loser] = ['Cloud', 'Local'];
    } else {
      [winner, loser] = ['Local', 'Cloud'];
    }
  }

  if (winner === 'Cloud') options.snapshotLocalBeforeOverwrite?.(change.table_name, change.record_id, localData);
  return {
    winner,
    loser,
    winner_data: winner === 'Cloud' ? cloudData : localData,
    loser_data: loser === 'Cloud' ? cloudData : localData,
  };
}
