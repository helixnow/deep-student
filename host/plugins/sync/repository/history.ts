import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { toRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import type { JsonValue } from '../api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import type { DbJson } from '../../../platform/util/lossless-json.ts';
import { isJsonObject, parseJsonLossless } from '../../../platform/util/lossless-json.ts';
import type { SnapshotBatchSummary } from '../src/history.ts';
import { DEFAULT_MAX_BATCHES, newBatchId, REASON_ROLLBACK_UNDO, type RollbackOutcome } from '../src/history.ts';
import { SyncError } from '../src/errors.ts';
import { lwwTimestampMillis, timestampValueToLwwString } from '../src/lww.ts';
import { getRecordData, recordsSemanticallyEqualForSync } from './record-data.ts';
import { applyDownloadedChangesForceExactWithHooks } from './apply.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function databaseError(detail: string): never {
  throw new SyncError(`Database error: ${detail}`);
}

const HISTORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS __sync_record_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    existed INTEGER NOT NULL CHECK(existed IN (0,1)),
    data_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    rolled_back_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx__sync_record_history_batch
    ON __sync_record_history(batch_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx__sync_record_history_dedup
    ON __sync_record_history(batch_id, table_name, record_id);
`;

/** history.rs:72-94. */
export function ensureHistoryTable(db: SqlExecutor): void {
  try {
    db.exec(HISTORY_SCHEMA);
  } catch (error) {
    databaseError(`创建 __sync_record_history 失败: ${message(error)}`);
  }
}

function pruneBatches(db: SqlExecutor, maxBatches: number): number {
  ensureHistoryTable(db);
  try {
    return db.run(
      `DELETE FROM __sync_record_history WHERE batch_id NOT IN (
         SELECT batch_id FROM __sync_record_history
         GROUP BY batch_id
         ORDER BY MAX(id) DESC
         LIMIT ?1
       )`,
      [Math.trunc(maxBatches)],
    ).changes;
  } catch (error) {
    databaseError(`清理历史快照失败: ${message(error)}`);
  }
}

/** history.rs:102-149. */
export function snapshotRecordWithData(
  db: SqlExecutor,
  batchId: string,
  reason: string,
  tableName: string,
  recordId: string,
  current: JsonValue | null,
): boolean {
  ensureHistoryTable(db);
  let dataJson: string | null = null;
  if (current !== null) {
    try {
      dataJson = JSON.stringify(current);
    } catch (error) {
      databaseError(`序列化快照数据失败: ${message(error)}`);
    }
  }
  let inserted: number;
  try {
    inserted = db.run(
      `INSERT INTO __sync_record_history
       (batch_id, reason, table_name, record_id, existed, data_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(batch_id, table_name, record_id) DO NOTHING`,
      [batchId, reason, tableName, recordId, current === null ? 0 : 1, dataJson],
    ).changes;
  } catch (error) {
    databaseError(`写入记录快照失败: ${message(error)}`);
  }
  if (inserted > 0) {
    let batchRows = 0;
    try {
      batchRows = db.pluck<number>(
        'SELECT COUNT(*) FROM __sync_record_history WHERE batch_id = ?1',
        [batchId],
      ) ?? 0;
    } catch {
      batchRows = 0;
    }
    if (batchRows === 1) {
      try {
        pruneBatches(db, DEFAULT_MAX_BATCHES);
      } catch {
        // history.rs:145: retention cleanup must not block the snapshot itself.
        return inserted > 0;
      }
    }
  }
  return inserted > 0;
}

/** history.rs:175-189. */
export function pruneBatchesToCap(db: SqlExecutor, maxBatches: number): number {
  return pruneBatches(db, maxBatches);
}

interface RawBatchRow {
  batch_id: string;
  reason: string;
  created_at: string;
  record_count: number;
  rolled_back_at: string | null;
}

/** history.rs:202-241. */
export function listBatches(db: SqlExecutor, limit: number): SnapshotBatchSummary[] {
  let tableExists: boolean;
  try {
    tableExists = Boolean(db.pluck(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_record_history')",
    ));
  } catch {
    tableExists = false;
  }
  if (!tableExists) return [];

  let rows: RawBatchRow[];
  try {
    rows = db.all<RawBatchRow>(
      `SELECT batch_id, reason, MIN(created_at) AS created_at, COUNT(*) AS record_count,
              MAX(rolled_back_at) AS rolled_back_at
       FROM __sync_record_history
       GROUP BY batch_id
       ORDER BY MAX(id) DESC
       LIMIT ?1`,
      [Math.trunc(limit)],
    );
  } catch (error) {
    databaseError(`查询快照批次失败: ${message(error)}`);
  }
  try {
    return rows.map(row => ({
      batch_id: row.batch_id,
      reason: row.reason,
      created_at: row.created_at,
      record_count: Math.max(0, row.record_count),
      rolled_back_at: row.rolled_back_at,
    }));
  } catch (error) {
    databaseError(`解析快照批次失败: ${message(error)}`);
  }
}

interface HistorySnapshotRow {
  table_name: string;
  record_id: string;
  existed: boolean;
  data_json: string | null;
}

/** `snapshot_record`（history.rs:150）：读取当前行后写快照。 */
export function snapshotRecord(
  db: SqlExecutor,
  batchId: string,
  reason: string,
  tableName: string,
  recordId: string,
  idColumn: string,
): boolean {
  const current = getRecordData(db, tableName, recordId, idColumn);
  return snapshotRecordWithData(db, batchId, reason, tableName, recordId, current as JsonValue | null);
}

function recordLwwMillis(data: DbJson | null | undefined): bigint | null {
  if (data === null || data === undefined || !isJsonObject(data)) return null;
  let best: bigint | null = null;
  for (const key of ['updated_at', 'deleted_at']) {
    const timestamp = timestampValueToLwwString(data[key]);
    if (timestamp === null) continue;
    const millis = lwwTimestampMillis(timestamp);
    if (millis !== null && (best === null || millis > best)) best = millis;
  }
  return best;
}

/** `next_rollback_timestamp`（history.rs:275）。 */
function nextRollbackTimestamp(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  current: DbJson | null,
  snapshot: DbJson | null,
): { millis: bigint; rfc3339: string } {
  const nowMillis = BigInt(Date.now());
  let observed: bigint | null = null;
  for (const value of [recordLwwMillis(current), recordLwwMillis(snapshot)]) {
    if (value !== null && (observed === null || value > observed)) observed = value;
  }

  let hasDeleteVersions = false;
  try {
    hasDeleteVersions = Boolean(db.pluck(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_delete_versions')",
    ));
  } catch {
    hasDeleteVersions = false;
  }
  if (hasDeleteVersions) {
    let timestamp: string | null = null;
    try {
      timestamp = db.pluck<string | null>(
        'SELECT changed_at FROM __sync_delete_versions WHERE table_name = ?1 AND record_id = ?2',
        [tableName, recordId],
      ) ?? null;
    } catch (error) {
      databaseError(`读取回退 DELETE 版本失败: ${message(error)}`);
    }
    if (timestamp !== null) {
      const deleteMillis = lwwTimestampMillis(timestamp);
      if (deleteMillis !== null && (observed === null || deleteMillis > observed)) observed = deleteMillis;
    }
  }

  const rollbackMillis = observed !== null && observed >= nowMillis ? observed + 1n : nowMillis;
  const date = new Date(Number(rollbackMillis));
  if (Number.isNaN(date.getTime())) databaseError('生成回退 LWW 时间戳失败');
  return {
    millis: rollbackMillis,
    rfc3339: toRfc3339Opts(rollbackMillis * 1_000_000n, 'Millis', true),
  };
}

/** `refresh_updated_at`（history.rs:315）：保留原值的数值/字符串形态。 */
function refreshUpdatedAt(data: DbJson, millis: bigint, rfc3339: string): DbJson {
  if (!isJsonObject(data)) return data;
  const current = data.updated_at;
  if (current === undefined) return data;
  data.updated_at = typeof current === 'number' || typeof current === 'bigint'
    ? millis
    : rfc3339;
  return data;
}

function loadBatchSnapshots(db: SqlExecutor, batchId: string): HistorySnapshotRow[] {
  let rows;
  try {
    rows = db.all<{ table_name: string; record_id: string; existed: number | bigint; data_json: string | null }>(
      `SELECT table_name, record_id, existed, data_json
       FROM __sync_record_history WHERE batch_id = ?1 ORDER BY id ASC`,
      [batchId],
    );
  } catch (error) {
    databaseError(`读取快照失败: ${message(error)}`);
  }
  return rows.map(row => ({
    table_name: row.table_name,
    record_id: row.record_id,
    existed: Number(row.existed) !== 0,
    data_json: row.data_json,
  }));
}

/** `history.rs:348-540` `rollback_batch`。 */
export function rollbackBatch(
  db: DatabaseHandle,
  batchId: string,
  idColumnMap: ReadonlyMap<string, string> | null,
  databaseName: string | null,
): RollbackOutcome {
  ensureHistoryTable(db);

  let alreadyRolledBack: string | null = null;
  try {
    alreadyRolledBack = db.pluck<string | null>(
      'SELECT MAX(rolled_back_at) FROM __sync_record_history WHERE batch_id = ?1',
      [batchId],
    ) ?? null;
  } catch (error) {
    databaseError(`读取快照批次状态失败: ${message(error)}`);
  }
  if (alreadyRolledBack !== null) {
    databaseError(`快照批次 ${batchId} 已回退过，不能重复回退（回退本身已生成新的撤销点批次）`);
  }

  const snapshots = loadBatchSnapshots(db, batchId);
  if (snapshots.length === 0) {
    databaseError(`快照批次 ${batchId} 不存在或已被保留策略清理`);
  }

  const now = toRfc3339();
  const undoBatchId = newBatchId();
  const changes: EngineChange[] = [];
  let skipped = 0;
  let restored = 0;
  let deleted = 0;

  for (const snapshot of snapshots) {
    const idColumn = idColumnMap?.get(snapshot.table_name) ?? 'id';
    const current = getRecordData(db, snapshot.table_name, snapshot.record_id, idColumn) as DbJson | null;
    if (snapshot.existed) {
      if (snapshot.data_json === null) {
        databaseError(`快照数据缺失: ${snapshot.table_name}.${snapshot.record_id}（existed=1 但 data_json 为空）`);
      }
      let value: DbJson;
      try {
        value = parseJsonLossless(snapshot.data_json);
      } catch (error) {
        databaseError(`解析快照数据失败: ${message(error)}`);
      }
      if (current !== null && recordsSemanticallyEqualForSync(current, value)) {
        skipped += 1;
        continue;
      }
      const rollback = nextRollbackTimestamp(db, snapshot.table_name, snapshot.record_id, current, value);
      refreshUpdatedAt(value, rollback.millis, rollback.rfc3339);
      restored += 1;
      changes.push({
        table_name: snapshot.table_name,
        record_id: snapshot.record_id,
        operation: 'Update',
        data: value,
        changed_at: rollback.rfc3339,
        change_log_id: null,
        database_name: databaseName,
        suppress_change_log: false,
        source_device_id: null,
        source_seq: null,
      });
    } else {
      if (current === null) {
        skipped += 1;
        continue;
      }
      const rollback = nextRollbackTimestamp(db, snapshot.table_name, snapshot.record_id, current, null);
      deleted += 1;
      changes.push({
        table_name: snapshot.table_name,
        record_id: snapshot.record_id,
        operation: 'Delete',
        data: null,
        changed_at: rollback.rfc3339,
        change_log_id: null,
        database_name: databaseName,
        suppress_change_log: false,
        source_device_id: null,
        source_seq: null,
      });
    }
  }

  const markNow = now;
  const markBatchId = batchId;
  if (changes.length === 0) {
    try {
      db.run(
        'UPDATE __sync_record_history SET rolled_back_at = ?1 WHERE batch_id = ?2',
        [now, batchId],
      );
    } catch (error) {
      databaseError(`标记快照批次已回退失败: ${message(error)}`);
    }
    return { batch_id: batchId, restored, deleted, skipped, undo_batch_id: undoBatchId };
  }

  const undoTargets = changes.map(change => ({
    table_name: change.table_name,
    record_id: change.record_id,
    id_column: idColumnMap?.get(change.table_name) ?? 'id',
  }));
  const undoBatch = undoBatchId;

  applyDownloadedChangesForceExactWithHooks(
    db,
    changes,
    { deviceId: '', idColumnMap },
    {
      preflight(tx) {
        for (const target of undoTargets) {
          snapshotRecord(tx, undoBatch, REASON_ROLLBACK_UNDO, target.table_name, target.record_id, target.id_column);
        }
      },
      finalize(tx) {
        try {
          tx.run(
            'UPDATE __sync_record_history SET rolled_back_at = ?1 WHERE batch_id = ?2',
            [markNow, markBatchId],
          );
        } catch (error) {
          databaseError(`标记快照批次已回退失败: ${message(error)}`);
        }
      },
    },
  );

  return { batch_id: batchId, restored, deleted, skipped, undo_batch_id: undoBatchId };
}
