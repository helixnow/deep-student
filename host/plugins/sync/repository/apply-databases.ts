/**
 * `commands_backup.rs::apply_downloaded_changes_to_databases` 移植。
 *
 * 按 `database_name`（旧格式按表名推断）把下载/导入的变更路由到各业务库，
 * 统一走冲突保护、隔离区自动重放，并在 mastery_events 变更后重建画像。
 */
import { fs } from '../src/local-runtime.ts';
import { CommandError } from '../../../kernel/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { CoordinatedDatabaseName, DatabaseHandle, SqlExecutor, StorageService } from '../../../platform/storage/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { rowSyncTables } from '../src/classification.ts';
import {
  compareLwwTimestamps,
  lwwDevicePair,
  timestampValueToLwwString,
} from '../src/lww.ts';
import type { MergeStrategy } from '../src/merge.ts';
import type { SyncLogger } from '../src/log.ts';
import { getRecordData, recordsSemanticallyEqualForSync } from './record-data.ts';
import { applyDownloadedChangesWithConflictGuard } from './apply.ts';
import { replayQuarantinedChanges } from './quarantine.ts';

const QUARANTINE_AUTO_REPLAY_MAX_ATTEMPTS = 20;

const databases: readonly CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];

export interface MasteryHooks {
  recomputeAllStatesWithConn(conn: SqlExecutor): number;
  syncAllLearnerProfiles(): number;
}

export interface ApplyToDatabasesResult {
  total_success: number;
  total_skipped: number;
  total_incomplete_skipped: number;
  total_failed: number;
  db_errors: Array<[string, string]>;
  applied_keys: Set<string>;
  total_conflicts: number;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Mastery returns AppError; Rust Display uses only its message (models.rs:1038-1041). */
function masteryMessage(error: unknown): string {
  if (error instanceof CommandError && typeof error.value === 'object' && error.value !== null
    && 'message' in error.value && typeof error.value.message === 'string') return error.value.message;
  return message(error);
}

/** `infer_database_from_table`（commands_backup.rs:161）。 */
export function inferDatabaseFromTable(tableName: string, logger?: SyncLogger | null): CoordinatedDatabaseName | null {
  if (tableName.startsWith('chat_v2_')) return 'chat_v2';
  switch (tableName) {
    case 'workspace_index':
    case 'sleep_block':
    case 'subagent_task':
      return 'chat_v2';
    case 'resources':
      logger?.warn("[sync] 'resources' 表同时存在于 chat_v2 和 vfs，legacy 变更无法判定目标库，跳过");
      return null;
    case '__change_log':
      return null;
    case 'mistakes':
    case 'chat_messages':
    case 'temp_sessions':
    case 'review_analyses':
    case 'review_chat_messages':
    case 'review_sessions':
    case 'review_session_mistakes':
    case 'settings':
    case 'rag_configurations':
    case 'document_tasks':
    case 'anki_cards':
    case 'custom_anki_templates':
    case 'document_control_states':
    case 'vectorized_data':
    case 'rag_sub_libraries':
    case 'search_logs':
    case 'exam_sheet_sessions':
    case 'migration_progress':
      return 'mistakes';
    case 'blobs':
    case 'notes':
    case 'files':
    case 'exam_sheets':
    case 'translations':
    case 'essays':
    case 'essay_sessions':
    case 'folders':
    case 'folder_items':
    case 'path_cache':
    case 'mindmaps':
    case 'questions':
    case 'question_history':
    case 'question_bank_stats':
    case 'review_plans':
    case 'review_history':
    case 'review_stats':
    case 'mastery_events':
    case 'mastery_states':
      return 'vfs';
    case 'llm_usage_logs':
    case 'llm_usage_daily':
      return 'llm_usage';
    default:
      logger?.debug(`[sync] 未知表名 '${tableName}', 无法推断数据库`);
      return null;
  }
}

function hasUnsyncedLocalChange(db: SqlExecutor, tableName: string, recordId: string): boolean {
  try {
    return Number(db.pluck<number | bigint | null>(
      `SELECT COUNT(*) FROM __change_log
       WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0`,
      [tableName, recordId],
    ) ?? 0) > 0;
  } catch {
    return false;
  }
}

function shouldApplyChangeByStrategy(
  db: SqlExecutor,
  change: EngineChange,
  idColumn: string,
  strategy: MergeStrategy,
): boolean {
  if (strategy === 'UseCloud') return true;
  let local;
  try {
    local = getRecordData(db, change.table_name, change.record_id, idColumn);
  } catch (error) {
    throw new Error(
      `查询本地记录失败 ${change.table_name}.${change.record_id}: ${message(error)}`,
    );
  }
  if (local === null) return true;
  if (change.data !== null && recordsSemanticallyEqualForSync(local, change.data)) return false;
  if (strategy === 'KeepLocal') return false;

  const localTimestamp = timestampValueToLwwString(
    (local as { [key: string]: unknown }).updated_at,
  );
  const cloudTimestamp = change.data !== null
    && typeof change.data === 'object'
    && !Array.isArray(change.data)
    ? timestampValueToLwwString((change.data as { [key: string]: unknown }).updated_at)
      ?? change.changed_at
    : change.changed_at;
  if (localTimestamp !== null && cloudTimestamp !== null) {
    const [localDevice, cloudDevice] = lwwDevicePair(
      local,
      change.data,
      change.source_device_id,
    );
    const comparison = compareLwwTimestamps(
      localTimestamp,
      localDevice,
      JSON.stringify(local),
      cloudTimestamp,
      cloudDevice,
      change.data === null ? '' : JSON.stringify(change.data),
    );
    return comparison <= 0;
  }
  if (localTimestamp !== null && cloudTimestamp === null) return false;
  if (localTimestamp === null && cloudTimestamp !== null) return true;
  if (localTimestamp === null && cloudTimestamp === null && change.operation === 'Delete') return false;
  return true;
}

function policyForStrategy(strategy: MergeStrategy): 'KeepCloud' | 'KeepLocal' | 'KeepLatest' {
  switch (strategy) {
    case 'KeepLocal':
    case 'Manual':
      return 'KeepLocal';
    case 'UseCloud':
      return 'KeepCloud';
    case 'KeepLatest':
      return 'KeepLatest';
  }
}

function filterChangedForDatabase(
  changes: readonly EngineChange[],
  databaseName: CoordinatedDatabaseName,
): EngineChange[] {
  const tables = new Set(
    rowSyncTables()
      .filter(entry => entry.database === databaseName)
      .map(entry => entry.table_name),
  );
  return changes.filter(change => tables.has(change.table_name));
}

export function applyDownloadedChangesToDatabases(
  storage: StorageService,
  changes: readonly EngineChange[],
  strategy: MergeStrategy,
  localDeviceId: string,
  mastery?: MasteryHooks,
  logger?: SyncLogger | null,
): ApplyToDatabasesResult {
  const aggregate: ApplyToDatabasesResult = {
    total_success: 0,
    total_skipped: 0,
    total_incomplete_skipped: 0,
    total_failed: 0,
    db_errors: [],
    applied_keys: new Set<string>(),
    total_conflicts: 0,
  };
  let rebuildMasteryProfile = false;
  const grouped = new Map<CoordinatedDatabaseName | string, EngineChange[]>();
  for (const change of changes) {
    const dbName = change.database_name !== null && change.database_name !== undefined
      ? change.database_name
      : inferDatabaseFromTable(change.table_name, logger);
    if (dbName === null) {
      const error = `Legacy 变更表名 '${change.table_name}' 无法推断目标数据库 (record_id=${change.record_id})`;
      logger?.error(`[data_governance] ${error}，拒绝确认同步包`);
      aggregate.total_failed += 1;
      aggregate.db_errors.push(['unknown', error]);
      continue;
    }
    const bucket = grouped.get(dbName);
    if (bucket === undefined) grouped.set(dbName, [change]);
    else bucket.push(change);
  }

  const idColumnMap = new Map<string, string>();
  for (const entry of rowSyncTables()) {
    const primaryKey = rustTrim(entry.primary_key);
    if (primaryKey === '' || primaryKey === '(virtual)' || primaryKey.includes(',')) continue;
    if (primaryKey !== 'id') idColumnMap.set(entry.table_name, primaryKey);
  }

  for (const [dbName, dbChanges] of grouped) {
    const dbId = databases.find(id => id === dbName);
    if (dbId === undefined) {
      const error = `未知数据库名称 '${dbName}'，${dbChanges.length} 条变更没有可持久化的目标或隔离区`;
      logger?.error(`[data_governance] ${error}，拒绝确认同步包`);
      aggregate.total_failed += dbChanges.length;
      aggregate.db_errors.push([dbName, error]);
      continue;
    }
    const dbPath = storage.pathOf(dbId);
    if (!fs.existsSync(dbPath)) {
      const error = `目标数据库文件不存在: ${dbPath}，${dbChanges.length} 条变更无法应用或持久隔离`;
      logger?.error(`[data_governance] ${error}，拒绝确认同步包`);
      aggregate.total_failed += dbChanges.length;
      aggregate.db_errors.push([dbName, error]);
      continue;
    }

    let db: DatabaseHandle;
    try {
      db = storage.openFile(dbPath, { profile: { busyTimeoutMs: 5000 } });
    } catch (error) {
      throw new Error(`打开数据库 ${dbName} 失败: ${message(error)}`);
    }

    try {
      const idColumns = idColumnMap;
      const ownedChanges: EngineChange[] = [];
      if (strategy === 'KeepLocal') {
        for (const change of dbChanges) {
          const idColumn = idColumns.get(change.table_name) ?? 'id';
          const shouldApply = hasUnsyncedLocalChange(db, change.table_name, change.record_id)
            ? true
            : shouldApplyChangeByStrategy(db, change, idColumn, strategy);
          if (shouldApply) ownedChanges.push({ ...change, suppress_change_log: true });
        }
      } else {
        for (const change of dbChanges) ownedChanges.push({ ...change, suppress_change_log: true });
      }
      if (ownedChanges.length === 0) continue;

      const firstCloudDeviceId = ownedChanges
        .map(change => change.source_device_id)
        .find(id => typeof id === 'string');
      const cloudDeviceId = firstCloudDeviceId !== undefined && rustTrim(firstCloudDeviceId) !== '' ? firstCloudDeviceId : null;
      const rebuildMasteryStates = dbId === 'vfs'
        && ownedChanges.some(change => change.table_name === 'mastery_events');

      let applyOutcome: ReturnType<typeof applyDownloadedChangesWithConflictGuard> | null = null;
      try {
        applyOutcome = applyDownloadedChangesWithConflictGuard(
          db,
          ownedChanges,
          { deviceId: localDeviceId, idColumnMap: idColumns, logger },
          {
            policy: policyForStrategy(strategy),
            cloudDeviceId,
            localDeviceId,
          },
        );
      } catch (error) {
        // Rust 记 error! 后继续处理剩余数据库与隔离区重放。
        logger?.error(`[data_governance] 数据库 ${dbName} 应用变更失败（继续处理剩余库）: ${message(error)}`);
        aggregate.total_failed += dbChanges.length;
        aggregate.db_errors.push([dbName, message(error)]);
      }

      if (applyOutcome !== null) {
        const result = applyOutcome;
        aggregate.total_success += result.apply.success_count;
        aggregate.total_skipped += result.apply.skipped_count;
        aggregate.total_incomplete_skipped += result.apply.skipped_incomplete_count;
        aggregate.total_failed += result.apply.failure_count;
        for (const key of result.apply.applied_keys) aggregate.applied_keys.add(key);
        aggregate.total_conflicts += result.conflict.conflicts_saved;
        if (result.conflict.rejected > 0 || result.conflict.conflicts_saved > 0) {
          logger?.info(
            `[data_governance] 数据库 ${dbName} 冲突保护: rejected=${result.conflict.rejected}, conflicts_saved=${result.conflict.conflicts_saved}`,
          );
        }
        logger?.info(
          `[data_governance] 数据库 ${dbName} 应用变更完成: success=${result.apply.success_count}, failed=${result.apply.failure_count}, skipped=${result.apply.skipped_count}`,
        );
        if (rebuildMasteryStates) {
          if (mastery === undefined) {
            throw new Error('同步 mastery_events 后重建 mastery_states 失败: mastery 服务不可用');
          }
          try { mastery.recomputeAllStatesWithConn(db); }
          catch (error) { throw new Error(`同步 mastery_events 后重建 mastery_states 失败: ${masteryMessage(error)}`); }
          rebuildMasteryProfile = true;
        }
      }

      try {
        const replayed = replayQuarantinedChanges(
          db,
          idColumns,
          QUARANTINE_AUTO_REPLAY_MAX_ATTEMPTS,
          localDeviceId,
        );
        aggregate.total_success += replayed;
        if (replayed > 0) {
          logger?.info(`[data_governance] 数据库 ${dbName} 隔离区自动重放成功 ${replayed} 条`);
        }
      } catch (error) {
        logger?.warn(`[data_governance] 数据库 ${dbName} 隔离区自动重放失败（忽略）: ${message(error)}`);
      }
    } finally {
      storage.close(db);
    }
  }

  if (rebuildMasteryProfile) {
    if (mastery === undefined) {
      throw new Error('同步 mastery learner profile 失败: mastery 服务不可用');
    }
    try { mastery.syncAllLearnerProfiles(); }
    catch (error) { throw new Error(`同步 mastery learner profile 失败: ${masteryMessage(error)}`); }
  }

  if (aggregate.db_errors.length > 0) {
    const detail = aggregate.db_errors.map(([db, error]) => `${db}: ${error}`).join('；');
    throw new Error(
      `部分数据库应用变更失败（已成功 ${aggregate.total_success} 条，失败 ${aggregate.total_failed} 条）: ${detail}。请重试同步以修复`,
    );
  }

  return aggregate;
}

export { filterChangedForDatabase, databases as orderedDatabases };
