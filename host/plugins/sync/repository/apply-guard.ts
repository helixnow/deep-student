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
  /** Live sync mode: keep active local conflicting record intact in DB until user resolves in UI. */
  deferConflictingOverwrite?: boolean;
  onDeferredConflict?: (key: string) => void;
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

function extractNoteBodyText(raw: DbJson | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = parseJsonLossless(trimmed);
        if (isJsonObject(parsed)) {
          for (const key of ['content_md', 'content', 'body', 'markdown', 'text']) {
            if (typeof parsed[key] === 'string') return parsed[key];
          }
        }
      } catch {
        // treat as plain markdown/text
      }
    }
    return raw;
  }
  if (isJsonObject(raw)) {
    for (const key of ['content_md', 'data', 'content', 'body', 'markdown', 'text']) {
      if (typeof raw[key] === 'string') return raw[key];
    }
  }
  return null;
}

function readResourceBodyFromDb(db: SqlExecutor, resourceId: string | null | undefined): string | null {
  if (!resourceId || !tableExists(db, 'resources')) return null;
  try {
    const row = db.get<{ data: unknown }>('SELECT data FROM resources WHERE id = ?1', [resourceId]);
    if (!row || row.data === null || row.data === undefined) return null;
    return extractNoteBodyText(typeof row.data === 'string' ? row.data : stringifyJsonLossless(row.data as DbJson));
  } catch {
    return null;
  }
}

function enrichNoteSnapshotWithBody(
  db: SqlExecutor,
  snapshot: DbJson,
  batchResourcesById: ReadonlyMap<string, EngineChange>,
  isCloudSide: boolean,
): DbJson {
  if (!isJsonObject(snapshot) || tableHasColumn(db, 'notes', 'content_md')) return snapshot;
  if (typeof snapshot.content_md === 'string') return snapshot;
  const resourceId = typeof snapshot.resource_id === 'string' ? snapshot.resource_id : null;
  if (!resourceId) return snapshot;
  let body: string | null = null;
  if (isCloudSide) {
    const incomingResource = batchResourcesById.get(resourceId);
    if (incomingResource && incomingResource.data !== null && isJsonObject(incomingResource.data)) {
      body = extractNoteBodyText(incomingResource.data.data ?? incomingResource.data);
    }
  }
  if (body === null) {
    body = readResourceBodyFromDb(db, resourceId);
  }
  return body !== null ? { ...snapshot, content_md: body } : snapshot;
}

function localHasPendingForRecord(db: SqlExecutor, tableName: string, recordId: string): boolean {
  if (!tableExists(db, '__change_log')) return false;
  try {
    return Number(
      db.pluck<number | bigint>(
        'SELECT COUNT(*) FROM __change_log WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0',
        [tableName, recordId],
      ) ?? 0,
    ) > 0;
  } catch {
    return false;
  }
}

function hasUnresolvedConflictForRecord(db: SqlExecutor, tableName: string, recordId: string): boolean {
  if (!tableExists(db, '__sync_conflicts')) return false;
  try {
    return Number(
      db.pluck<number | bigint>(
        'SELECT COUNT(*) FROM __sync_conflicts WHERE table_name = ?1 AND record_id = ?2 AND resolved_at IS NULL',
        [tableName, recordId],
      ) ?? 0,
    ) > 0;
  } catch {
    return false;
  }
}

function toTimestampMillis(value: DbJson | undefined): bigint | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const intVal = BigInt(Math.trunc(value));
    return intVal >= 100_000_000_000n ? intVal : intVal >= 1_000_000_000n ? intVal * 1000n : null;
  }
  if (typeof value === 'bigint') {
    return value >= 100_000_000_000n ? value : value >= 1_000_000_000n ? value * 1000n : null;
  }
  const lww = timestampValueToLwwString(value);
  return lww === null ? null : lwwTimestampMillis(lww);
}

function resourceHasDivergentLocalEditForNote(
  tx: SqlExecutor,
  noteId: string,
  localNote: DbJson,
  localResId: string,
  incomingResourcesById: ReadonlyMap<string, EngineChange>,
): boolean {
  if (hasUnresolvedConflictForRecord(tx, 'resources', localResId)) return true;
  if (!localHasPendingForRecord(tx, 'resources', localResId)) return false;

  const localRes = getRecordData(tx, 'resources', localResId, 'id');
  if (localRes === null || !isJsonObject(localRes)) return false;

  const incomingRes = incomingResourcesById.get(localResId);
  if (incomingRes && incomingRes.data !== null) {
    return !recordsSemanticallyEqualForSync(localRes, incomingRes.data);
  }

  if (tableHasColumn(tx, 'note_document_revisions', 'version_id')) {
    try {
      const latestRevBody = tx.pluck<string | null>(
        'SELECT content_md FROM note_document_revisions WHERE note_id = ?1 ORDER BY seq DESC LIMIT 1',
        [noteId],
      );
      if (typeof latestRevBody === 'string') {
        const currentBody = extractNoteBodyText(localRes.data ?? localRes);
        if (currentBody !== null && currentBody !== latestRevBody) return true;
        if (currentBody === latestRevBody) return false;
      }
    } catch {
      // fallback to timestamp comparison below
    }
  }

  const resUpdatedMs = toTimestampMillis(localRes.updated_at);
  const noteUpdatedMs = isJsonObject(localNote) ? toTimestampMillis(localNote.updated_at) : null;
  if (resUpdatedMs !== null && noteUpdatedMs !== null) {
    return resUpdatedMs > noteUpdatedMs;
  }
  return localHasPendingForRecord(tx, 'notes', noteId);
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

  const incomingResourcesById = new Map<string, EngineChange>();
  for (const ch of changes) {
    if (ch.table_name === 'resources' && ch.operation !== 'Delete' && ch.data !== null) {
      incomingResourcesById.set(ch.record_id, ch);
    }
  }

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
    const deferredResourceIds = new Set<string>();

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

        let outcome = resolveOne(tx, remapped, idColumn, {
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

        // Cross-table pairing guard for notes <-> resources: never allow an overwrite of
        // one side while the paired side has unsynced local edits or unresolved conflicts.
        if (outcome === null && options.deferConflictingOverwrite && tableExists(tx, 'notes') && tableExists(tx, 'resources')) {
          if (remapped.table_name === 'resources') {
            const linkedNote = tx.get<{ id: string }>('SELECT id FROM notes WHERE resource_id = ?1 LIMIT 1', [remapped.record_id]);
            if (linkedNote && (localHasPendingForRecord(tx, 'notes', linkedNote.id) || hasUnresolvedConflictForRecord(tx, 'notes', linkedNote.id) || deferredResourceIds.has(remapped.record_id))) {
              const localRes = getRecordData(tx, 'resources', remapped.record_id, idColumn);
              const isSemanticEcho = remapped.operation !== 'Delete'
                && remapped.data !== null
                && localRes !== null
                && recordsSemanticallyEqualForSync(localRes, remapped.data);
              if (localRes !== null && !isSemanticEcho) {
                outcome = {
                  winner: 'Cloud',
                  loser: 'Local',
                  winner_data: remapped.operation === 'Delete' ? null : remapped.data,
                  loser_data: localRes,
                };
              }
            }
          } else if (remapped.table_name === 'notes') {
            const localNote = getRecordData(tx, 'notes', remapped.record_id, idColumn);
            const localAlreadyTrashed = isJsonObject(localNote)
              && localNote.deleted_at !== undefined
              && localNote.deleted_at !== null;
            const cloudSoftDeleted = isJsonObject(remapped.data)
              && remapped.data.deleted_at !== undefined
              && remapped.data.deleted_at !== null;
            const localResId = isJsonObject(localNote) && typeof localNote.resource_id === 'string' ? localNote.resource_id : null;
            const cloudResId = isJsonObject(remapped.data) && typeof remapped.data.resource_id === 'string' ? remapped.data.resource_id : null;
            if (
              localNote !== null
              && !(localAlreadyTrashed && cloudSoftDeleted)
              && localResId
              && resourceHasDivergentLocalEditForNote(tx, remapped.record_id, localNote, localResId, incomingResourcesById)
            ) {
              if (cloudResId) deferredResourceIds.add(cloudResId);
              deferredResourceIds.add(localResId);
              outcome = {
                winner: 'Cloud',
                loser: 'Local',
                winner_data: remapped.operation === 'Delete' ? null : remapped.data,
                loser_data: localNote,
              };
            }
          }
        }

        if (outcome === null) {
          const suppress = remapped.suppress_change_log === true;
          const preLogMax = suppress ? changeLogMaxId(tx) : null;
          const allowFieldMerge = pendingLocalKeys.has(keyOf(remapped.table_name, remapped.record_id));
          const pairedResourceApplied = remapped.table_name === 'notes'
            && isJsonObject(remapped.data)
            && typeof remapped.data.resource_id === 'string'
            && applyResult.applied_keys.has(keyOf('resources', remapped.data.resource_id));
          let noteMetadataAdvanced = false;
          if (
            remapped.table_name === 'notes'
            && remapped.operation !== 'Delete'
            && isJsonObject(remapped.data)
            && Object.hasOwn(remapped.data, 'updated_at')
            && !pairedResourceApplied
          ) {
            const localNoteForMeta = getRecordData(tx, 'notes', remapped.record_id, idColumn);
            if (isJsonObject(localNoteForMeta)) {
              const localMs = toTimestampMillis(localNoteForMeta.updated_at);
              const cloudMs = toTimestampMillis(remapped.data.updated_at);
              noteMetadataAdvanced = localMs !== null && cloudMs !== null && cloudMs > localMs;
            }
          }
          const applied = applySingleChange(
            tx,
            remapped,
            idColumn,
            false,
            allowFieldMerge,
            context,
            pairedResourceApplied || noteMetadataAdvanced,
          );
          if (applied) {
            applyResult.success_count += 1;
            applyResult.applied_keys.add(keyOf(remapped.table_name, remapped.record_id));
          } else {
            applyResult.skipped_count += 1;
            if (isIncompleteUpsert(remapped)) applyResult.skipped_incomplete_count += 1;
          }
          if (preLogMax !== null) {
            suppressEchoChangeLog(tx, Math.floor(Date.now() / 1000), preLogMax);
          }
        } else {
          const winningDevice = outcome.winner === 'Cloud' ? options.cloudDeviceId ?? null : options.localDeviceId ?? null;
          const losingDevice = outcome.loser === 'Cloud' ? options.cloudDeviceId ?? null : options.localDeviceId ?? null;
          if (remapped.table_name === 'notes') {
            const localSnap = outcome.winner === 'Local' ? outcome.winner_data : outcome.loser_data;
            const cloudSnap = outcome.winner === 'Cloud' ? outcome.winner_data : outcome.loser_data;
            if (isJsonObject(localSnap) && typeof localSnap.resource_id === 'string') deferredResourceIds.add(localSnap.resource_id);
            if (isJsonObject(cloudSnap) && typeof cloudSnap.resource_id === 'string') deferredResourceIds.add(cloudSnap.resource_id);
          }
          const rawLoserData = remapped.table_name === 'notes'
            ? enrichNoteSnapshotWithBody(tx, outcome.loser_data, incomingResourcesById, outcome.loser === 'Cloud')
            : outcome.loser_data;
          const rawWinnerData = remapped.table_name === 'notes'
            ? enrichNoteSnapshotWithBody(tx, outcome.winner_data, incomingResourcesById, outcome.winner === 'Cloud')
            : outcome.winner_data;
          const loserInserted = saveConflictRecord(tx, {
            table_name: remapped.table_name,
            record_id: remapped.record_id,
            side: outcome.loser,
            data: rawLoserData,
            winning_device_id: winningDevice,
            losing_device_id: losingDevice,
          });
          const winnerInserted = saveConflictRecord(tx, {
            table_name: remapped.table_name,
            record_id: remapped.record_id,
            side: outcome.winner,
            data: rawWinnerData,
            winning_device_id: winningDevice,
            losing_device_id: losingDevice,
          });
          const inserted = (loserInserted ? 1 : 0) + (winnerInserted ? 1 : 0);
          conflictResult.conflicts_saved += inserted;
          if (inserted > 0) {
            conflictResult.conflicts_by_table[remapped.table_name] =
              (conflictResult.conflicts_by_table[remapped.table_name] ?? 0) + inserted;
          }

          if (outcome.winner === 'Cloud' && options.deferConflictingOverwrite) {
            conflictResult.rejected += 1;
            applyResult.skipped_count += 1;
            options.onDeferredConflict?.(keyOf(remapped.table_name, remapped.record_id));
          } else if (outcome.winner === 'Cloud') {
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
              );
            }
          } else {
            foldSafeFieldMergeIntoLocal(tx, remapped, options.policy);
            conflictResult.rejected += 1;
            applyResult.skipped_count += 1;
            if (options.deferConflictingOverwrite) {
              options.onDeferredConflict?.(keyOf(remapped.table_name, remapped.record_id));
            }
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
