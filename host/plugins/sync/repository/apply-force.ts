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
import { orderedChangesForApply } from './apply-order.ts';
import { ensureQuarantineTable } from './apply-quarantine.ts';
import { buildForeignKeyChildMap, collectForeignKeyViolationSet, fkBatchCheckTables, validateNoNewFkViolations } from './apply-fk.ts';
import { changeLogMaxId, recomputeDerivedRefCountsIfRelevant } from './apply-refcounts.ts';
import { buildDownloadIdAliases, persistIdAliases, remapChangeWithAliases } from './apply-id-aliases.ts';

export interface ForceExactHooks {
  preflight?(tx: SqlExecutor): void;
  finalize?(tx: SqlExecutor, result: ApplyChangesResult): void;
}

/** `apply_downloaded_changes_force_exact_with_hooks`（含 ID 别名与原子 hooks）。 */
export function applyDownloadedChangesForceExactWithHooks(
  db: DatabaseHandle,
  changes: readonly EngineChange[],
  context: ApplyContext,
  hooks: ForceExactHooks = {},
): ApplyChangesResult {
  if (changes.length === 0) return emptyApplyChangesResult();
  const result = emptyApplyChangesResult();
  let transactionStarted = false;
  let callbackCompleted = false;
  try {
    db.transaction(tx => {
      transactionStarted = true;
      hooks.preflight?.(tx);
      ensureQuarantineTable(tx);
      const aliases = buildDownloadIdAliases(tx, changes);
      const childMap = buildForeignKeyChildMap(tx);
      const fkTables = fkBatchCheckTables(changes, childMap);
      const fkBaseline = collectForeignKeyViolationSet(tx, fkTables);

      orderedChangesForApply(changes).forEach((change, index) => {
        const savepoint = beginApplySavepoint(tx, index);
        try {
          const idColumn = context.idColumnMap?.get(change.table_name) ?? 'id';
          const remapped = remapChangeWithAliases(tx, change, idColumn, aliases);
          const preLogMax = remapped.suppress_change_log === true ? changeLogMaxId(tx) : null;
          const applied = applySingleChange(tx, remapped, idColumn, true, false, context);
          if (preLogMax !== null) {
            suppressEchoChangeLog(tx, Math.floor(Date.now() / 1000), preLogMax, remapped.table_name, remapped.record_id);
          }
          validateNoNewFkViolations(tx, fkBaseline, fkTables);
          releaseApplySavepoint(tx, savepoint);
          if (applied) {
            result.success_count += 1;
            result.applied_keys.add(keyOf(remapped.table_name, remapped.record_id));
          } else {
            result.skipped_count += 1;
          }
        } catch (error) {
          rollbackAndReleaseApplySavepoint(tx, savepoint);
          throw error;
        }
      });

      recomputeDerivedRefCountsIfRelevant(tx, changes);
      recomputeTodoCompletedPomodorosIfRelevant(tx, changes);
      persistIdAliases(tx, aliases);
      validateNoNewFkViolations(tx, fkBaseline, fkTables);
      hooks.finalize?.(tx, result);
      callbackCompleted = true;
    }, { behavior: 'immediate' });
  } catch (error) {
    if (error instanceof SyncError) throw error;
    if (!transactionStarted) databaseError(`开始事务失败: ${message(error)}`);
    if (!callbackCompleted) throw error;
    databaseError(`提交事务失败: ${message(error)}`);
  }
  return result;
}

/** `apply_single_change_force`：跳过 LWW 门（冲突已显式裁决）。 */
export function applySingleChangeForce(
  db: DatabaseHandle,
  change: EngineChange,
  context: ApplyContext,
  allowFieldMerge = false,
): boolean {
  return db.transaction(tx => {
    const idColumn = context.idColumnMap?.get(change.table_name) ?? 'id';
    return applySingleChange(tx, change, idColumn, true, allowFieldMerge, context);
  }, { behavior: 'immediate' });
}

/** `apply_downloaded_changes_force_exact` 的核心应用（不含 hooks）。 */
export function applyDownloadedChangesForceExact(
  db: DatabaseHandle,
  changes: readonly EngineChange[],
  context: ApplyContext,
): ApplyChangesResult {
  return applyDownloadedChangesForceExactWithHooks(db, changes, context);
}
