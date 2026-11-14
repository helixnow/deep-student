/**
 * 同步分类注册表（`classification.rs`，逐表移植）。
 *
 * 分类决定哪些表参与行级同步/校验和、哪些仅备份、哪些是本地运行时数据。
 * `syncClassificationRegistry()` 的顺序与 Rust 完全一致（测试与 UI 依赖稳定顺序）。
 */

import { rustTrim } from '../../../platform/util/index.ts';

export type SyncCategory =
  | "RowSync"
  | "FileSync"
  | "DerivedRebuild"
  | "LocalRuntime"
  | "BackupOnly"
  | "Deprecated";
export type ConflictPolicyClass =
  | "Lww"
  | "FieldMerge"
  | "CounterMerge"
  | "SetUnion"
  | "DeleteWins"
  | "NoConflict";

export interface TableClassification {
  database: string;
  table_name: string;
  primary_key: string;
  category: SyncCategory;
  conflict_policy: ConflictPolicyClass;
  business_unique_keys: string;
  has_json_blobs: boolean;
  merge_notes: string;
}

import { syncClassificationRegistry } from './classification-registry.ts';

export { syncClassificationRegistry } from './classification-registry.ts';

/** `TableClassification::row_sync_tables`. */
export function rowSyncTables(): TableClassification[] {
  return syncClassificationRegistry().filter(
    (entry) => entry.category === "RowSync",
  );
}

/**
 * `TableClassification::change_log_trigger_exempt`。
 *
 * `note_document_revisions` 的清理只在本机进行：删除触发器会把一次本地裁剪
 * 重放到所有其他设备。pin 通过专门的 UPDATE 触发器同步。其余 RowSync 表都必须
 * 具备 insert/update/delete 触发器。
 */
export function changeLogTriggerExempt(
  database: string,
  tableName: string,
  operation: string,
): boolean {
  return (
    database === "vfs" &&
    tableName === "note_document_revisions" &&
    operation === "delete"
  );
}

/** `TableClassification::checksum_tables`（RowSync + FileSync）。 */
export function checksumTables(database: string): TableClassification[] {
  return syncClassificationRegistry().filter(
    (entry) =>
      entry.database === database &&
      (entry.category === "RowSync" || entry.category === "FileSync"),
  );
}

const FTS_SHADOW_SUFFIXES = [
  "_content",
  "_docsize",
  "_config",
  "_idx",
  "_segdir",
  "_segments",
  "_stat",
  "_data",
] as const;

/** `TableClassification::is_excluded_from_checksum`（FTS 影子表、运行时、派生表）。 */
export function isExcludedFromChecksum(
  database: string,
  tableName: string,
): boolean {
  if (tableName.startsWith("sqlite_") || tableName.startsWith("__"))
    return true;
  const registry = syncClassificationRegistry();
  for (const suffix of FTS_SHADOW_SUFFIXES) {
    if (tableName.endsWith(suffix)) {
      const base = tableName.slice(0, -suffix.length);
      if (
        registry.some(
          (entry) =>
            entry.database === database &&
            entry.table_name === base &&
            entry.primary_key === "(virtual)",
        )
      ) {
        return true;
      }
    }
  }
  return registry
    .filter((entry) => entry.database === database)
    .some(
      (entry) =>
        entry.table_name === tableName &&
        entry.category !== "RowSync" &&
        entry.category !== "FileSync",
    );
}

/** `TableClassification::get_business_unique_keys`。 */
export function getBusinessUniqueKeys(
  database: string,
  tableName: string,
): string[] {
  const keys: string[] = [];
  for (const entry of syncClassificationRegistry()) {
    if (entry.database !== database || entry.table_name !== tableName) continue;
    if (entry.business_unique_keys === "") continue;
    for (const part of entry.business_unique_keys.split(","))
      keys.push(rustTrim(part));
  }
  return keys;
}
