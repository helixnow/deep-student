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
import { applySingleChange } from './apply-record.ts';
import { isIncompleteUpsert, orderedChangesForApply } from './apply-order.ts';
import { ensureQuarantineTable, isTransientApplyError, quarantineChange } from './apply-quarantine.ts';
import { buildForeignKeyChildMap, collectForeignKeyViolationSet, fkBatchCheckTables, validateNoNewFkViolations } from './apply-fk.ts';
import { changeLogMaxId, recomputeDerivedRefCountsIfRelevant } from './apply-refcounts.ts';
import { buildDownloadIdAliases, persistIdAliases, remapChangeWithAliases } from './apply-id-aliases.ts';

export function collectPendingLocalChangeKeys(db: SqlExecutor): Set<string> {
  if (!tableExists(db, '__change_log')) return new Set();
  const rows = db.all<{ table_name: string; record_id: string }>(
    'SELECT DISTINCT table_name, record_id FROM __change_log WHERE sync_version = 0',
  );
  return new Set(rows.map(row => keyOf(row.table_name, row.record_id)));
}

export function incompleteUpsertsShadowedByDelete(changes: readonly EngineChange[]): Set<string> {
  const deleted = new Set<string>();
  for (const change of changes) {
    if (change.operation === 'Delete') deleted.add(keyOf(change.table_name, change.record_id));
  }
  const shadowed = new Set<string>();
  for (const change of changes) {
    if (!isIncompleteUpsert(change)) continue;
    const key = keyOf(change.table_name, change.record_id);
    if (deleted.has(key)) shadowed.add(key);
  }
  return shadowed;
}

export function recordApplyFailure(result: ApplyChangesResult, change: EngineChange, error: unknown): void {
  result.failure_count += 1;
  result.failures.push({
    table_name: change.table_name,
    record_id: change.record_id,
    operation: change.operation.toUpperCase(),
    error: message(error),
  });
}

/**
 * `apply_downloaded_changes`：批量应用（事务 + 单条保存点 + 检疫）。
 */
export function applyDownloadedChanges(
  db: DatabaseHandle,
  changes: readonly EngineChange[],
  context: ApplyContext,
): ApplyChangesResult {
  (context.noteHistory ?? getDefaultNoteHistory())?.validateBatchFormats?.(db, changes);
  if (changes.length === 0) return emptyApplyChangesResult();

  const result = emptyApplyChangesResult();
  let transactionStarted = false;
  let callbackCompleted = false;
  try {
    db.transaction(tx => {
      transactionStarted = true;
      ensureQuarantineTable(tx);
      ensureConflictTable(tx);
      const idAliases = buildDownloadIdAliases(tx, changes);
      const shadowedIncomplete = incompleteUpsertsShadowedByDelete(changes);
      const childMap = buildForeignKeyChildMap(tx);
      const fkTables = fkBatchCheckTables(changes, childMap);
      const fkBaseline = collectForeignKeyViolationSet(tx, fkTables);
      const pendingLocalKeys = collectPendingLocalChangeKeys(tx);

      const ordered = orderedChangesForApply(changes);
      ordered.forEach((change, index) => {
        if (isIncompleteUpsert(change) && shadowedIncomplete.has(keyOf(change.table_name, change.record_id))) {
          context.logger?.warn(`[sync] 跳过同批 DELETE 覆盖的缺数据 UPSERT: ${change.table_name}.${change.record_id}`);
          result.skipped_count += 1;
          result.skipped_incomplete_count += 1;
          return;
        }
        const idColumn = context.idColumnMap?.get(change.table_name) ?? 'id';
        const savepoint = beginApplySavepoint(tx, index);
        try {
          const remapped = remapChangeWithAliases(tx, change, idColumn, idAliases);
          const suppress = remapped.suppress_change_log === true;
          const preLogMax = suppress ? changeLogMaxId(tx) : null;
          const allowFieldMerge = pendingLocalKeys.has(keyOf(remapped.table_name, remapped.record_id));
          const applied = applySingleChange(tx, remapped, idColumn, false, allowFieldMerge, context);
          if (preLogMax !== null) {
            suppressEchoChangeLog(tx, Math.floor(Date.now() / 1000), preLogMax);
          }
          validateNoNewFkViolations(tx, fkBaseline, fkTables);
          releaseApplySavepoint(tx, savepoint);
          if (applied) {
            result.success_count += 1;
            // Rust 在 remap 之后才登记 applied_keys（mod.rs:7140）。
            result.applied_keys.add(keyOf(remapped.table_name, remapped.record_id));
          } else {
            result.skipped_count += 1;
            if (isIncompleteUpsert(remapped)) result.skipped_incomplete_count += 1;
          }
        } catch (error) {
          rollbackAndReleaseApplySavepoint(tx, savepoint);
          if (isTransientApplyError(error)) throw error;
          quarantineChange(tx, change, error);
          recordApplyFailure(result, change, error);
          context.logger?.warn(
            `[sync] 单条变更已进入检疫，继续应用后续变更: ${change.table_name}.${change.record_id} ${change.operation.toUpperCase()}: ${message(error)}`,
          );
        }
      });

      recomputeDerivedRefCountsIfRelevant(tx, changes);
      recomputeTodoCompletedPomodorosIfRelevant(tx, changes);
      persistIdAliases(tx, idAliases);
      validateNoNewFkViolations(tx, fkBaseline, fkTables);
      callbackCompleted = true;
    }, { behavior: 'immediate' });
  } catch (error) {
    if (error instanceof SyncError) throw error;
    if (!transactionStarted) databaseError(`开始事务失败: ${message(error)}`);
    if (!callbackCompleted) throw error;
    databaseError(`提交事务失败: ${message(error)}`);
  }
  context.logger?.info(
    `[sync] 变更应用完成: success=${result.success_count}, failed=${result.failure_count}, skipped=${result.skipped_count}`,
  );
  return result;
}

/** ID 别名：`(table, remote_id) -> canonical_id`（`mod.rs` IdAliasMap）。 */
