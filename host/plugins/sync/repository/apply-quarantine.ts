import type { DatabaseHandle, SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { serializeSyncChange } from '../src/change-payload.ts';
import { mergeField, fieldMergeColumnsForTable } from '../src/field-merge.ts';
import { ClockDriftSuspectedError, SyncError } from '../src/errors.ts';
import { syncClassificationRegistry } from '../src/classification.ts';
import { MAX_DRIFT_MS } from '../src/hlc.ts';
import { isJsonFloat, isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { compareLwwTimestamps, lwwDevicePair, lwwTimestampMillis, timestampValueToLwwString } from '../src/lww.ts';
import { recomputeTodoCompletedPomodorosIfRelevant } from './pomodoro-counts.ts';
import { snapshotRecordWithData } from './history.ts';
import { newBatchId, REASON_POLICY_OVERRIDE } from '../src/history.ts';
import { canonicalizeSyncValueForCompare, getRecordData, recordsSemanticallyEqualForSync, SYNC_FIELD_DELTAS_KEY } from './record-data.ts';
import { saveConflictRecord, ensureConflictTable, resolveOne } from './conflict-resolver.ts';
import {
  buildPrimaryKeyPredicate,
  columnDeclaredType,
  ensureTableAllowedAndExists,
  getTableColumns,
  isLocalDerivedSyncColumn,
  jsonValueToAliasKey,
  jsonValueToSqlParam,
  parseRecordKeyValues,
  pluckSafe,
  primaryKeyColumns,
  quoteIdentifier,
  rowToJson,
  selectWithTypes,
  tableColumnNames,
  tableExists,
  tableHasColumn,
} from './sqlite-values.ts';
import {
  type ApplyChangeFailure,
  type ApplyChangesResult,
  type ApplyContext,
  type NoteHistoryHooks,
  beginApplySavepoint,
  databaseError,
  emptyApplyChangesResult,
  getDefaultNoteHistory,
  keyOf,
  message,
  releaseApplySavepoint,
  rollbackAndReleaseApplySavepoint,
  setDefaultNoteHistory,
  suppressEchoChangeLog,
} from './apply-shared.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

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
    const exists = Number(pluckSafe<number | bigint>(
      db,
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

export function sourceDeviceForQuarantine(change: EngineChange): string {
  if (change.source_device_id !== undefined && change.source_device_id !== null) return change.source_device_id;
  if (change.database_name !== undefined && change.database_name !== null) return `download:${change.database_name}`;
  return 'download:unknown';
}

export function sourceSeqForQuarantine(change: EngineChange): number | bigint {
  const seq = change.source_seq;
  if (seq != null && BigInt(seq) <= 9223372036854775807n) return seq;
  return change.change_log_id ?? 0;
}

function stableSyncValueHash(value: DbJson): string {
  const canonical = canonicalizeSyncValueForCompare(value);
  return createHasherSync('SHA-256').update(stringifyJsonLossless(canonical)).digestHex();
}

function syncPayloadHash(payload: string): string {
  return createHasherSync('SHA-256').update(payload).digestHex();
}

function quarantineBaseline(
  db: SqlExecutor,
  change: EngineChange,
): [string | null, string] {
  let baseline: DbJson = null;
  try {
    const pk = primaryKeyColumns(db, change.table_name);
    const first = pk[0];
    if (first !== undefined) baseline = getRecordData(db, change.table_name, change.record_id, first) ?? null;
  } catch {
    baseline = null;
  }
  const hash = stableSyncValueHash(baseline);
  return [stringifyJsonLossless(baseline), hash];
}

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

export function isTransientApplyError(error: unknown): boolean {
  if (error instanceof ClockDriftSuspectedError) return false;
  const text = message(error).toLowerCase();
  return text.includes('database is locked')
    || text.includes('database table is locked')
    || text.includes('sqlite_busy')
    || text.includes('disk i/o')
    || text.includes('database or disk is full')
    || text.includes('out of memory');
}
