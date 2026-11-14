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
import { applySingleChange, upsertBlockedByDeleteVersion } from './apply-record.ts';
import { isIncompleteUpsert, orderedChangesForApply, shouldSkipShadowedIncompleteUpsert } from './apply-order.ts';
import {
  ensureQuarantineTable,
  isTransientApplyError,
  quarantineChange,
  sourceDeviceForQuarantine,
  sourceSeqForQuarantine,
} from './apply-quarantine.ts';
import { collectPendingLocalChangeKeys, incompleteUpsertsShadowedByDelete, recordApplyFailure } from './apply-batch.ts';
import { buildForeignKeyChildMap, collectForeignKeyViolationSet, fkBatchCheckTables, validateNoNewFkViolations } from './apply-fk.ts';
import { changeLogMaxId, recomputeDerivedRefCountsIfRelevant } from './apply-refcounts.ts';
import { buildDownloadIdAliases, persistIdAliases, remapChangeWithAliases } from './apply-id-aliases.ts';

export interface ConflictAwareApplyResult {
  applied: number;
  rejected: number;
  conflicts_saved: number;
  conflicts_by_table: Record<string, number>;
}

export interface ConflictGuardOptions {
  policy: 'KeepCloud' | 'KeepLocal' | 'KeepLatest';
  cloudDeviceId?: string | null;
  localDeviceId?: string | null;
  historyBatchId?: string | null;
}

function clearMatchingQuarantine(db: SqlExecutor, change: EngineChange): number {
  try {
    return db.run(
      `DELETE FROM __sync_quarantine
       WHERE source_device_id=?1 AND source_seq=?2
         AND table_name=?3 AND record_id=?4 AND operation=?5`,
      [
        sourceDeviceForQuarantine(change),
        sourceSeqForQuarantine(change),
        change.table_name,
        change.record_id,
        change.operation.toUpperCase(),
      ],
    ).changes;
  } catch (error) {
    databaseError(`完成隔离区重放状态迁移失败: ${message(error)}`);
  }
}

/** `fold_safe_field_merge_into_local`（mod.rs:8477）。 */
export function foldSafeFieldMergeIntoLocal(
  db: SqlExecutor,
  change: EngineChange,
  policy: ConflictGuardOptions['policy'],
): boolean {
  if (policy !== 'KeepLatest') return false;
  if (change.operation === 'Delete' || change.data === null || !isJsonObject(change.data)) return false;
  const picklist = fieldMergeColumnsForTable(change.table_name);
  if (picklist.length === 0) return false;

  const pkColumns = primaryKeyColumns(db, change.table_name);
  const pkValues = parseRecordKeyValues(change.table_name, change.record_id, pkColumns);
  const predicate = buildPrimaryKeyPredicate(pkColumns, 2);
  const local = getRecordData(db, change.table_name, change.record_id, pkColumns[0] ?? 'id');
  if (local === null || !isJsonObject(local)) return false;

  let folded = false;
  for (const column of picklist) {
    if (!tableHasColumn(db, change.table_name, column)) continue;
    const remote = change.data[column];
    const original = local[column];
    if (remote === undefined || remote === null) continue;
    const [merged, wasMerged, mergeConflict] = mergeField(
      change.table_name,
      column,
      original as never,
      remote as never,
    );
    // [R04] 比较前先 canonicalize：SQLite TEXT 里的 '["a","b"]' 与合并产物
    // Array(["a","b"]) 语义等价，不得产生空转 UPDATE（触发器会记 pending）。
    if (!wasMerged
      || mergeConflict
      || stringifyJsonLossless(canonicalizeSyncValueForCompare(merged as DbJson))
        === stringifyJsonLossless(canonicalizeSyncValueForCompare(original as DbJson))) {
      continue;
    }
    const value = jsonValueToSqlParam(merged as DbJson);
    if (value === undefined) continue;
    let affected;
    try {
      affected = db.run(
        `UPDATE ${quoteIdentifier(change.table_name)} SET ${quoteIdentifier(column)} = ?1 WHERE ${predicate}`,
        [value, ...pkValues],
      ).changes;
    } catch (error) {
      databaseError(`冲突败方安全字段折叠写入失败: ${change.table_name}.${column} ${message(error)}`);
    }
    if (affected !== 1) {
      databaseError(`字段级合并未命中目标记录: ${change.table_name}.${column} record_id=${change.record_id}`);
    }
    folded = true;
  }
  return folded;
}

/** `apply_downloaded_changes_with_conflict_guard`（mod.rs:7760）。 */
export function applyDownloadedChangesWithConflictGuard(
  db: DatabaseHandle,
  changes: readonly EngineChange[],
  context: ApplyContext,
  options: ConflictGuardOptions,
): { apply: ApplyChangesResult; conflict: ConflictAwareApplyResult } {
  const applyResult = emptyApplyChangesResult();
  const conflictResult: ConflictAwareApplyResult = {
    applied: 0,
    rejected: 0,
    conflicts_saved: 0,
    conflicts_by_table: {},
  };
  if (changes.length === 0) return { apply: applyResult, conflict: conflictResult };
  const historyBatchId = options.historyBatchId ?? newBatchId();
  let transactionStarted = false;
  let callbackCompleted = false;

  try {
    db.transaction(tx => {
    transactionStarted = true;
    ensureQuarantineTable(tx);
    ensureConflictTable(tx);
    const aliases = buildDownloadIdAliases(tx, changes);
    const shadowed = incompleteUpsertsShadowedByDelete(changes);
    const childMap = buildForeignKeyChildMap(tx);
    const fkTables = fkBatchCheckTables(changes, childMap);
    const fkBaseline = collectForeignKeyViolationSet(tx, fkTables);
    const pendingLocalKeys = collectPendingLocalChangeKeys(tx);

    orderedChangesForApply(changes).forEach((change, index) => {
      if (shouldSkipShadowedIncompleteUpsert(change, shadowed)) {
        context.logger?.warn(`[sync] 跳过同批 DELETE 覆盖的缺数据 UPSERT: ${change.table_name}.${change.record_id}`);
        applyResult.skipped_count += 1;
        applyResult.skipped_incomplete_count += 1;
        return;
      }
      const savepoint = beginApplySavepoint(tx, index);
      const applyBefore = {
        success: applyResult.success_count,
        failure: applyResult.failure_count,
        skipped: applyResult.skipped_count,
        incomplete: applyResult.skipped_incomplete_count,
        failures: [...applyResult.failures],
        applied: new Set(applyResult.applied_keys),
      };
      const conflictBefore = {
        applied: conflictResult.applied,
        rejected: conflictResult.rejected,
        saved: conflictResult.conflicts_saved,
        byTable: { ...conflictResult.conflicts_by_table },
      };
      try {
        const idColumn = context.idColumnMap?.get(change.table_name) ?? 'id';
        const remapped = remapChangeWithAliases(tx, change, idColumn, aliases);

        if ((remapped.operation === 'Insert' || remapped.operation === 'Update')
          && upsertBlockedByDeleteVersion(tx, remapped, idColumn, context.deviceId)) {
          applyResult.skipped_count += 1;
          return;
        }

        const outcome = resolveOne(tx, remapped, idColumn, {
          policy: options.policy,
          snapshotLocalBeforeOverwrite: (tableName, recordId, localData) => {
            snapshotRecordWithData(
              tx,
              historyBatchId,
              REASON_POLICY_OVERRIDE,
              tableName,
              recordId,
              localData as never,
            );
          },
        });

        if (outcome === null) {
          const suppress = remapped.suppress_change_log === true;
          const preLogMax = suppress ? changeLogMaxId(tx) : null;
          const allowFieldMerge = pendingLocalKeys.has(keyOf(remapped.table_name, remapped.record_id));
          const applied = applySingleChange(tx, remapped, idColumn, false, allowFieldMerge, context);
          if (applied) {
            applyResult.success_count += 1;
            applyResult.applied_keys.add(keyOf(remapped.table_name, remapped.record_id));
          } else {
            applyResult.skipped_count += 1;
            if (isIncompleteUpsert(remapped)) applyResult.skipped_incomplete_count += 1;
          }
          if (preLogMax !== null) {
            suppressEchoChangeLog(tx, Math.floor(Date.now() / 1000), preLogMax, remapped.table_name, remapped.record_id);
          }
        } else {
          const winningDevice = outcome.winner === 'Cloud' ? options.cloudDeviceId ?? null : options.localDeviceId ?? null;
          const losingDevice = outcome.loser === 'Cloud' ? options.cloudDeviceId ?? null : options.localDeviceId ?? null;
          const loserInserted = saveConflictRecord(tx, {
            table_name: remapped.table_name,
            record_id: remapped.record_id,
            side: outcome.loser,
            data: outcome.loser_data,
            winning_device_id: winningDevice,
            losing_device_id: losingDevice,
          });
          const winnerInserted = saveConflictRecord(tx, {
            table_name: remapped.table_name,
            record_id: remapped.record_id,
            side: outcome.winner,
            data: outcome.winner_data,
            winning_device_id: winningDevice,
            losing_device_id: losingDevice,
          });
          const inserted = (loserInserted ? 1 : 0) + (winnerInserted ? 1 : 0);
          conflictResult.conflicts_saved += inserted;
          if (inserted > 0) {
            conflictResult.conflicts_by_table[remapped.table_name] =
              (conflictResult.conflicts_by_table[remapped.table_name] ?? 0) + inserted;
          }

          if (outcome.winner === 'Cloud') {
            const cloudChange: EngineChange = { ...remapped, suppress_change_log: true };
            const preLogMax = changeLogMaxId(tx);
            const applied = applySingleChange(tx, cloudChange, idColumn, true, true, context);
            if (applied) {
              applyResult.success_count += 1;
              applyResult.applied_keys.add(keyOf(cloudChange.table_name, cloudChange.record_id));
              conflictResult.applied += 1;
            } else {
              applyResult.skipped_count += 1;
              if (isIncompleteUpsert(cloudChange)) applyResult.skipped_incomplete_count += 1;
            }
            if (preLogMax !== null) {
              suppressEchoChangeLog(
                tx,
                Math.floor(Date.now() / 1000),
                preLogMax,
                cloudChange.table_name,
                cloudChange.record_id,
              );
            }
          } else {
            foldSafeFieldMergeIntoLocal(tx, remapped, options.policy);
            conflictResult.rejected += 1;
            applyResult.skipped_count += 1;
          }
        }

        validateNoNewFkViolations(tx, fkBaseline, fkTables);
        clearMatchingQuarantine(tx, change);
        releaseApplySavepoint(tx, savepoint);
      } catch (error) {
        rollbackAndReleaseApplySavepoint(tx, savepoint);
        applyResult.success_count = applyBefore.success;
        applyResult.failure_count = applyBefore.failure;
        applyResult.skipped_count = applyBefore.skipped;
        applyResult.skipped_incomplete_count = applyBefore.incomplete;
        applyResult.failures = applyBefore.failures;
        applyResult.applied_keys = applyBefore.applied;
        conflictResult.applied = conflictBefore.applied;
        conflictResult.rejected = conflictBefore.rejected;
        conflictResult.conflicts_saved = conflictBefore.saved;
        conflictResult.conflicts_by_table = conflictBefore.byTable;
        if (isTransientApplyError(error)) throw error;
        quarantineChange(tx, change, error);
        recordApplyFailure(applyResult, change, error);
        context.logger?.warn(
          `[sync] 单条变更已进入检疫，继续应用后续变更: ${change.table_name}.${change.record_id} ${change.operation.toUpperCase()}: ${message(error)}`,
        );
      }
    });

    recomputeDerivedRefCountsIfRelevant(tx, changes);
    recomputeTodoCompletedPomodorosIfRelevant(tx, changes);
    persistIdAliases(tx, aliases);
    validateNoNewFkViolations(tx, fkBaseline, fkTables);
    callbackCompleted = true;
    }, { behavior: 'immediate' });
  } catch (error) {
    if (error instanceof SyncError) throw error;
    if (!transactionStarted) databaseError(`开始事务失败: ${message(error)}`);
    if (!callbackCompleted) throw error;
    databaseError(`提交事务失败: ${message(error)}`);
  }

  return { apply: applyResult, conflict: conflictResult };
}
