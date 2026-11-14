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
  allSafe,
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
import { toHex } from '../../../platform/crypto/encoding.ts';

type ForeignKeyViolationSet = Set<string>;

export function collectForeignKeyViolationSet(db: SqlExecutor, tables: readonly string[]): ForeignKeyViolationSet {
  const violations: ForeignKeyViolationSet = new Set();
  for (const table of tables) {
    let ident: string;
    try {
      ident = quoteIdentifier(table);
    } catch (_error) {
      continue;
    }
    let rows;
    try {
      rows = allSafe(db, `PRAGMA foreign_key_check(${ident})`);
    } catch (error) {
      if (/\bno such table\b/i.test(message(error))) continue;
      databaseError(`检查外键失败 ${table}: ${message(error)}`);
    }
    for (const row of rows) {
      violations.add(
        `table=${String(row.table)}, rowid=${formatSqliteValue(row.rowid as never)}, parent=${String(row.parent)}, fkid=${formatSqliteValue(row.fkid as never)}`,
      );
    }
  }
  return violations;
}

function formatSqliteValue(value: number | bigint | string | null | Uint8Array): string {
  if (value === null) return 'Null';
  if (typeof value === 'bigint' || typeof value === 'number') return `Integer(${String(value)})`;
  if (typeof value === 'string') return `Text("${value}")`;
  return `Blob(${toHex(value)})`;
}

export function buildForeignKeyChildMap(db: SqlExecutor): Map<string, string[]> {
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).map(row => row.name);
  const map = new Map<string, string[]>();
  for (const child of tables) {
    let ident: string;
    try {
      ident = quoteIdentifier(child);
    } catch (_error) {
      continue;
    }
    let rows;
    try {
      rows = db.all<{ table: string }>(`PRAGMA foreign_key_list(${ident})`);
    } catch (error) {
      if (/\bno such table\b/i.test(message(error))) continue;
      databaseError(`查询外键失败 ${child}: ${message(error)}`);
    }
    for (const row of rows) {
      const parent = String(row.table);
      const children = map.get(parent) ?? [];
      children.push(child);
      map.set(parent, children);
    }
  }
  return map;
}

export function fkBatchCheckTables(changes: readonly EngineChange[], childMap: Map<string, string[]>): string[] {
  const set = new Set<string>();
  for (const change of changes) {
    set.add(change.table_name);
    for (const child of childMap.get(change.table_name) ?? []) set.add(child);
  }
  return [...set];
}

export function validateNoNewFkViolations(
  db: SqlExecutor,
  baseline: ForeignKeyViolationSet,
  tables: readonly string[],
): void {
  const current = collectForeignKeyViolationSet(db, tables);
  const newViolations = [...current].filter(violation => !baseline.has(violation)).slice(0, 20);
  if (newViolations.length > 0) {
    databaseError(`新增外键约束违规（示例最多 20 条）: ${newViolations.join('; ')}`);
  }
}
