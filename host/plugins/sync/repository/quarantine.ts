import { defineQuery, type DatabaseHandle, type SqlExecutor } from '../../../platform/storage/api.ts';
import { canonicalizeSyncValueForCompare, getRecordData } from './record-data.ts';
import { parseSyncChange, serializeSyncChange, type EngineChange } from '../src/change-payload.ts';
import { SyncError } from '../src/errors.ts';
import type { DbJson } from '../../../platform/util/lossless-json.ts';
import { stringifyJsonLossless } from '../../../platform/util/lossless-json.ts';
import { applyDownloadedChangesWithConflictGuard } from './apply.ts';
import { ensureConflictTable, saveConflictRecord } from './conflict-resolver.ts';
import { primaryKeyColumns } from './sqlite-values.ts';
import { sourceSeqForQuarantine } from './apply-quarantine.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function databaseError(detail: string): never {
  throw new SyncError(`Database error: ${detail}`);
}

export function stableSyncValueHash(value: DbJson): string {
  const canonical = canonicalizeSyncValueForCompare(value);
  return createHasherSync('SHA-256')
    .update(stringifyJsonLossless(canonical))
    .digestHex();
}

export function syncPayloadHash(payload: string): string {
  return createHasherSync('SHA-256').update(payload).digestHex();
}

function quarantineBaseline(db: SqlExecutor, change: EngineChange): [string, string] {
  let baseline: DbJson = null;
  try {
    const pk = primaryKeyColumns(db, change.table_name);
    const first = pk[0];
    if (first !== undefined) {
      baseline = (getRecordData(db, change.table_name, change.record_id, first) ?? null) as DbJson;
    }
  } catch {
    baseline = null;
  }
  return [stringifyJsonLossless(baseline), stableSyncValueHash(baseline)];
}

export function ensureQuarantineTable(db: SqlExecutor): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS __sync_quarantine (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_device_id TEXT NOT NULL,
          source_seq INTEGER NOT NULL,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          payload_json TEXT,
          payload_hash TEXT NOT NULL DEFAULT '',
          baseline_json TEXT,
          baseline_hash TEXT NOT NULL DEFAULT '',
          error TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 1,
          first_seen TEXT NOT NULL DEFAULT (datetime('now')),
          last_attempt TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(source_device_id, source_seq, table_name, record_id, operation)
      );
      CREATE INDEX IF NOT EXISTS idx__sync_quarantine_last_attempt
          ON __sync_quarantine(last_attempt);
    `);
  } catch (error) {
    databaseError(`创建 __sync_quarantine 失败: ${message(error)}`);
  }
  for (const [column, definition] of [
    ['payload_hash', "TEXT NOT NULL DEFAULT ''"],
    ['baseline_json', 'TEXT'],
    ['baseline_hash', "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    const exists = Number(db.pluck<number | bigint>(
      "SELECT EXISTS(SELECT 1 FROM pragma_table_info('__sync_quarantine') WHERE name=?1)",
      [column],
    ) ?? 0) !== 0;
    if (!exists) {
      try {
        db.run(`ALTER TABLE __sync_quarantine ADD COLUMN ${column} ${definition}`);
      } catch (error) {
        databaseError(`迁移 __sync_quarantine.${column} 失败: ${message(error)}`);
      }
    }
  }
}

function preserveQuarantineBaselineConflict(
  db: DatabaseHandle,
  quarantineId: number | bigint,
  change: EngineChange,
  idColumnMap: ReadonlyMap<string, string> | null,
): void {
  db.transaction(tx => {
    ensureConflictTable(tx);
    const idColumn = idColumnMap?.get(change.table_name) ?? 'id';
    const local = (getRecordData(tx, change.table_name, change.record_id, idColumn) ?? null) as DbJson;
    const cloud = (change.data ?? null) as DbJson;
    const cloudDevice = change.source_device_id ?? null;
    saveConflictRecord(tx, {
      table_name: change.table_name,
      record_id: change.record_id,
      side: 'Local',
      data: local,
      winning_device_id: null,
      losing_device_id: cloudDevice,
    });
    saveConflictRecord(tx, {
      table_name: change.table_name,
      record_id: change.record_id,
      side: 'Cloud',
      data: cloud,
      winning_device_id: null,
      losing_device_id: cloudDevice,
    });
    try {
      tx.run('DELETE FROM __sync_quarantine WHERE id=?1', [quarantineId]);
    } catch (error) {
      databaseError(`清除已转冲突的隔离项失败: ${message(error)}`);
    }
  }, { behavior: 'immediate' });
}

function markQuarantineAttempt(db: SqlExecutor, quarantineId: number | bigint, error: string): void {
  try {
    db.run(
      `UPDATE __sync_quarantine
       SET attempts = attempts + 1, error = ?1, last_attempt = datetime('now')
       WHERE id = ?2`,
      [error, quarantineId],
    );
  } catch (updateError) {
    databaseError(`记录隔离 payload 校验失败: ${message(updateError)}`);
  }
}

function replayQuarantineCandidate(
  db: DatabaseHandle,
  idColumnMap: ReadonlyMap<string, string> | null,
  deviceId: string,
  quarantineId: number | bigint,
  payloadJson: string,
  payloadHash: string,
  baselineHash: string,
  allowSyncTestFixtureTables = false,
): boolean {
  if (payloadHash === '' || syncPayloadHash(payloadJson) !== payloadHash) {
    markQuarantineAttempt(db, quarantineId, 'payload hash 缺失或校验失败');
    return false;
  }
  let change: EngineChange;
  try {
    change = parseSyncChange(payloadJson);
  } catch (error) {
    markQuarantineAttempt(db, quarantineId, `payload 解析失败: ${message(error)}`);
    return false;
  }
  const [, currentBaselineHash] = quarantineBaseline(db, change);
  if (baselineHash === '' || currentBaselineHash !== baselineHash) {
    preserveQuarantineBaselineConflict(db, quarantineId, change, idColumnMap);
    return true;
  }

  try {
    const result = applyDownloadedChangesWithConflictGuard(
      db,
      [change],
      { deviceId, idColumnMap, allowSyncTestFixtureTables },
      { policy: 'KeepLatest' },
    );
    return result.apply.failure_count === 0;
  } catch (error) {
    markQuarantineAttempt(db, quarantineId, message(error));
    throw error;
  }
}

/** `retry_quarantined_change`（mod.rs:6840）。 */
export function retryQuarantinedChange(
  db: DatabaseHandle,
  quarantineId: number | bigint,
  idColumnMap: ReadonlyMap<string, string> | null,
  deviceId: string,
  allowSyncTestFixtureTables = false,
): boolean {
  ensureQuarantineTable(db);
  let candidate;
  try {
    candidate = db.get<{ payload_json: string; payload_hash: string; baseline_hash: string }>(
      `SELECT payload_json, payload_hash, baseline_hash
       FROM __sync_quarantine WHERE id=?1`,
      [quarantineId],
    );
  } catch (error) {
    databaseError(`读取隔离记录失败: ${message(error)}`);
  }
  if (candidate === undefined) return false;
  return replayQuarantineCandidate(
    db,
    idColumnMap,
    deviceId,
    quarantineId,
    candidate.payload_json,
    candidate.payload_hash,
    candidate.baseline_hash,
    allowSyncTestFixtureTables,
  );
}

/** `replay_quarantined_changes`（mod.rs:6884）：自动重放上限内的条目。 */
export function replayQuarantinedChanges(
  db: DatabaseHandle,
  idColumnMap: ReadonlyMap<string, string> | null,
  maxAttempts: number,
  deviceId: string,
  allowSyncTestFixtureTables = false,
): number {
  let tableExists = false;
  try {
    tableExists = Boolean(db.pluck(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_quarantine')",
    ));
  } catch {
    tableExists = false;
  }
  if (!tableExists) return 0;

  ensureQuarantineTable(db);
  let candidates;
  try {
    candidates = db.all(defineQuery<[number], { id: bigint; payload_json: string; payload_hash: string; baseline_hash: string }>(
      `SELECT id, payload_json, payload_hash, baseline_hash FROM __sync_quarantine
       WHERE payload_json IS NOT NULL AND attempts <= ?1
        ORDER BY id`, { options: { safeIntegers: true } }),
      [Math.trunc(maxAttempts)],
    );
  } catch (error) {
    databaseError(`准备隔离区重放查询失败: ${message(error)}`);
  }

  let replayed = 0;
  for (const candidate of candidates) {
    try {
      if (replayQuarantineCandidate(
        db,
        idColumnMap,
        deviceId,
        candidate.id,
        candidate.payload_json,
        candidate.payload_hash,
        candidate.baseline_hash,
        allowSyncTestFixtureTables,
      )) {
        replayed += 1;
      }
    } catch {
      break;
    }
  }
  return replayed;
}

/** `quarantine_change`（mod.rs:6626）：写入/累加隔离项。 */
export function quarantineChange(db: SqlExecutor, change: EngineChange, error: unknown): void {
  ensureQuarantineTable(db);
  const payloadJson = serializeSyncChange(change);
  const payloadHash = syncPayloadHash(payloadJson);
  const [baselineJson, baselineHash] = quarantineBaseline(db, change);
  try {
    db.run(
      `INSERT INTO __sync_quarantine
       (source_device_id, source_seq, table_name, record_id, operation,
        payload_json, payload_hash, baseline_json, baseline_hash, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(source_device_id, source_seq, table_name, record_id, operation)
       DO UPDATE SET
          payload_json = excluded.payload_json,
          payload_hash = excluded.payload_hash,
          baseline_json = COALESCE(__sync_quarantine.baseline_json, excluded.baseline_json),
          baseline_hash = CASE
              WHEN __sync_quarantine.baseline_hash = '' THEN excluded.baseline_hash
              ELSE __sync_quarantine.baseline_hash
          END,
          error = excluded.error,
          attempts = attempts + 1,
          last_attempt = datetime('now')`,
      [
        sourceDeviceForQuarantine(change),
        sourceSeqForQuarantine(change),
        change.table_name,
        change.record_id,
        change.operation.toUpperCase(),
        payloadJson,
        payloadHash,
        baselineJson,
        baselineHash,
        message(error),
      ],
    );
  } catch (insertError) {
    databaseError(`写入 __sync_quarantine 失败: ${message(insertError)}`);
  }
}

function sourceDeviceForQuarantine(change: EngineChange): string {
  if (change.source_device_id !== undefined && change.source_device_id !== null) return change.source_device_id;
  if (change.database_name !== undefined && change.database_name !== null) return `download:${change.database_name}`;
  return 'download:unknown';
}
