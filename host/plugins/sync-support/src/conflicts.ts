/**
 * `conflict_resolver.rs` 的 TS 移植（记录级冲突解决器）。
 *
 * 冲突定义（三条同时满足）：
 * 1. 本地存在该记录；
 * 2. 本地在 `__change_log` 有 `sync_version = 0` 的未同步变更；
 * 3. 本地与云端"业务指纹"（忽略同步元字段）不同。
 *
 * 三种策略（keep_cloud / keep_local / keep_latest）下**落败方都会进
 * `__sync_conflicts`**；Cloud 胜（本地被覆盖/删除）前必须经 `SyncHistoryPort`
 * 落快照，失败即整条变更失败（fail-closed）。
 */
import { sha256Hex } from './portable.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  ConflictAwareApplyResult,
  ConflictOutcome,
  ConflictPolicy,
  ConflictRecordToSave,
  ConflictResolver,
  ConflictSide,
  ConflictSupport,
  JsonValue,
  SyncChangeWithData,
  SyncHistoryPort,
} from '../api.ts';
import { databaseError } from './errors.ts';
import {
  canonicalizeForCompare,
  isJsonObject,
  stringifyJson,
  toWireJson,
} from './json.ts';
import type { Json } from './json.ts';
import { compareLwwTimestamps, lwwDevicePair, timestampValueToLwwString } from './lww.ts';
import { getRecordData } from '../repository/records.ts';
import {
  ADD_CONFLICT_DATA_HASH,
  CREATE_CONFLICT_DEDUP_INDEX,
  CREATE_CONFLICT_TABLE,
  hasUnsyncedChange,
  insertConflictRecord,
  selectConflictDataHashColumn,
} from '../repository/conflicts.ts';

const REASON_POLICY_OVERRIDE = 'policy_override';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `local_has_unsynced_change`：`__change_log` 缺失/查询失败视为无本地变更。 */
function localHasUnsyncedChange(db: SqlExecutor, tableName: string, recordId: string): boolean {
  try {
    const row = db.get(hasUnsyncedChange, [tableName, recordId]);
    return row !== undefined && Number(row.count) > 0;
  } catch {
    return false;
  }
}

/** `extract_updated_at`：仅对象上的 `updated_at`（字符串/数字）。 */
function extractUpdatedAt(value: Json): string | null {
  if (!isJsonObject(value)) return null;
  return timestampValueToLwwString(value.updated_at);
}

/**
 * `differs_semantically`：以云端字段集为基准比较本地子集。
 * 云端 payload 缺的字段不参与判断（与 apply 的 UPSERT 列集语义一致）。
 */
function differsSemantically(local: Json, cloud: Json): boolean {
  const cloudKeys = isJsonObject(cloud) ? new Set(Object.keys(cloud)) : null;
  let localSubset: Json;
  if (cloudKeys === null) {
    return stringifyJson(canonicalizeForCompare(local)) !== stringifyJson(canonicalizeForCompare(cloud));
  }
  if (isJsonObject(local)) {
    const filtered: { [key: string]: Json } = {};
    for (const [key, value] of Object.entries(local)) {
      if (cloudKeys.has(key)) filtered[key] = value;
    }
    localSubset = filtered;
  } else {
    localSubset = local;
  }
  return (
    stringifyJson(canonicalizeForCompare(localSubset)) !==
    stringifyJson(canonicalizeForCompare(cloud))
  );
}

/** `compute_data_hash`：规范化 JSON 的 sha256 前 16 字节 hex。 */
export function computeDataHash(data: JsonValue): string {
  const canonical = canonicalizeForCompare(data);
  const text = stringifyJson(canonical);
  return sha256Hex(text).slice(0, 32);
}

/** `ensure_conflict_table`。 */
export function ensureConflictTable(db: SqlExecutor): void {
  try {
    db.exec(CREATE_CONFLICT_TABLE);
  } catch (error) {
    databaseError(`创建 __sync_conflicts 失败: ${errorMessage(error)}`);
  }

  let hasDataHash = false;
  try {
    const row = db.get(selectConflictDataHashColumn, ['data_hash']);
    hasDataHash = row !== undefined && Number(row.count) > 0;
  } catch {
    hasDataHash = false;
  }
  if (!hasDataHash) {
    try {
      db.exec(ADD_CONFLICT_DATA_HASH);
    } catch { // boundary-allow empty-catch: conflict_resolver.rs:205 的 let _ = conn.execute 无日志，忽略加列错误后继续建索引。
    }
  }

  try {
    db.exec(CREATE_CONFLICT_DEDUP_INDEX);
  } catch (error) {
    databaseError(`创建冲突表去重索引失败: ${errorMessage(error)}`);
  }
}

/** `save_conflict_record`：重复内容被部分唯一索引吞掉（返回 false）。 */
export function saveConflictRecord(db: SqlExecutor, record: ConflictRecordToSave): boolean {
  ensureConflictTable(db);
  const dataJson = stringifyJson(record.data);
  const dataHash = computeDataHash(record.data);
  let changes: number;
  try {
    const result = db.run(insertConflictRecord, [
      record.table_name,
      record.record_id,
      record.side,
      dataJson,
      dataHash,
      record.winning_device_id ?? null,
      record.losing_device_id ?? null,
    ]);
    changes = result.changes;
  } catch (error) {
    databaseError(`写入冲突表失败: ${errorMessage(error)}`);
  }
  return changes > 0;
}

/** `ConflictResolver::new`（批次 id 由 L20 history 端口生成）。 */
export function createResolver(policy: ConflictPolicy, history: SyncHistoryPort): ConflictResolver {
  const historyBatchId = history.newBatchId();

  function snapshotLocalBeforeOverwrite(
    db: SqlExecutor,
    tableName: string,
    recordId: string,
    localData: Json,
  ): void {
    const ok = history.snapshotRecord(
      db,
      historyBatchId,
      REASON_POLICY_OVERRIDE,
      tableName,
      recordId,
      toWireJson(localData),
    );
    if (!ok) {
      databaseError(
        `冲突快照失败: ${tableName}.${recordId}（未留下可回退快照，拒绝覆盖）`,
      );
    }
  }

  function resolveOne(
    db: SqlExecutor,
    change: SyncChangeWithData,
    idColumn: string,
  ): ConflictOutcome | null {
    // DELETE 单独处理：本地有未同步修改且记录仍在 → 冲突。
    if (change.operation === 'Delete') {
      if (!localHasUnsyncedChange(db, change.table_name, change.record_id)) return null;
      const localData = getRecordData(db, change.table_name, change.record_id, idColumn);
      if (localData === null) return null;

      const cloudData: JsonValue = null;
      let winner: ConflictSide;
      let loser: ConflictSide;
      if (policy === 'keep_cloud') {
        winner = 'cloud';
        loser = 'local';
      } else if (policy === 'keep_local') {
        winner = 'local';
        loser = 'cloud';
      } else {
        const localTimestamp = extractUpdatedAt(localData);
        if (
          localTimestamp !== null &&
          (() => {
            const [localDevice, cloudDevice] = lwwDevicePair(
              localData,
              null,
              change.source_device_id ?? null,
            );
            return (
              compareLwwTimestamps(
                localTimestamp,
                localDevice,
                stringifyJson(localData),
                change.changed_at,
                cloudDevice,
                '',
              ) === -1
            );
          })()
        ) {
          winner = 'cloud';
          loser = 'local';
        } else {
          winner = 'local';
          loser = 'cloud';
        }
      }

      if (winner === 'cloud') {
        snapshotLocalBeforeOverwrite(db, change.table_name, change.record_id, localData);
      }

      const winnerData = winner === 'cloud' ? cloudData : localData;
      const loserData = loser === 'cloud' ? cloudData : localData;
      return {
        winner,
        loser,
        winner_data: toWireJson(winnerData),
        loser_data: toWireJson(loserData),
      };
    }

    // INSERT/UPDATE：没有数据的变更（legacy v1）不参与冲突检测。
    if (change.data === null || change.data === undefined) return null;
    const cloudData = change.data;

    if (!localHasUnsyncedChange(db, change.table_name, change.record_id)) return null;
    const localData = getRecordData(db, change.table_name, change.record_id, idColumn);
    if (localData === null) return null;

    if (!differsSemantically(localData, cloudData)) return null;

    let winner: ConflictSide;
    let loser: ConflictSide;
    if (policy === 'keep_cloud') {
      winner = 'cloud';
      loser = 'local';
    } else if (policy === 'keep_local') {
      winner = 'local';
      loser = 'cloud';
    } else {
      const localTimestamp = extractUpdatedAt(localData);
      const cloudTimestamp = extractUpdatedAt(cloudData) ?? change.changed_at;
      if (localTimestamp !== null) {
        const [localDevice, cloudDevice] = lwwDevicePair(
          localData,
          cloudData,
          change.source_device_id ?? null,
        );
        if (
          compareLwwTimestamps(
            localTimestamp,
            localDevice,
            stringifyJson(localData),
            cloudTimestamp,
            cloudDevice,
            stringifyJson(cloudData),
          ) === -1
        ) {
          winner = 'cloud';
          loser = 'local';
        } else {
          winner = 'local';
          loser = 'cloud';
        }
      } else {
        // (None, Some(_)) → Cloud；即使 cloud 也无时间戳，Rust 恒为 Cloud。
        winner = 'cloud';
        loser = 'local';
      }
    }

    if (winner === 'cloud') {
      snapshotLocalBeforeOverwrite(db, change.table_name, change.record_id, localData);
    }

    const winnerData = winner === 'cloud' ? cloudData : localData;
    const loserData = loser === 'cloud' ? cloudData : localData;
    return {
      winner,
      loser,
      winner_data: toWireJson(winnerData),
      loser_data: toWireJson(loserData),
    };
  }

  return {
    historyBatchId,
    resolveOne,
  };
}

/** `ConflictAwareApplyResult::is_clean`。 */
export function isClean(result: ConflictAwareApplyResult): boolean {
  return result.rejected === 0;
}

/** 用于去重键的规范化（对外只暴露 wire JSON）。 */
export function canonicalizeConflictData(value: JsonValue): JsonValue {
  return toWireJson(canonicalizeForCompare(value));
}

export const conflictSupport: ConflictSupport = {
  createResolver,
  ensureConflictTable,
  computeDataHash,
  saveConflictRecord,
  isClean,
  canonicalizeForCompare: canonicalizeConflictData,
};
