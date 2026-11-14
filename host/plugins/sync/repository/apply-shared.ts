/**
 * 下载变更应用引擎的共享类型与小型工具。
 *
 * 事务/savepoint/回声抑制的错误语义在这里集中实现，批次应用、强制套用与冲突保护
 * 三条路径共用，避免各写一份后逐渐偏离 Rust。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { SyncError } from '../src/errors.ts';
import type { LearnerProfileMerger } from '../src/field-merge.ts';
import type { DbJson } from '../../../platform/util/lossless-json.ts';
import type { SyncLogger } from '../src/log.ts';

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function databaseError(detail: string): never {
  throw new SyncError(`Database error: ${detail}`);
}

/** 可选 VFS 笔记历史钩子（L10/VFS lane 提供）。 */
export interface NoteHistoryHooks {
  validateBatchFormats?(db: SqlExecutor, changes: readonly EngineChange[]): void;
  validateIncoming?(db: SqlExecutor, table: string, recordId: string, data: DbJson): void;
  affectedNotes?(db: SqlExecutor, table: string, recordId: string): string[];
  snapshotNotes?(db: SqlExecutor, noteIds: readonly string[], source: string): void;
  retargetNoteRelations?(db: SqlExecutor, noteId: string, previousResourceId: string): void;
  prepareRelation?(db: SqlExecutor, recordId: string, obj: { [key: string]: DbJson }): void;
  applyRevision?(db: SqlExecutor, recordId: string, data: DbJson): void;
}

let defaultNoteHistory: NoteHistoryHooks | null = null;

/** `index.ts` 在 `notes` 可用时安装 L10 钩子。 */
export function setDefaultNoteHistory(hooks: NoteHistoryHooks | null): void {
  defaultNoteHistory = hooks;
}

/** 供 apply 系列模块读取已安装的默认钩子。 */
export function getDefaultNoteHistory(): NoteHistoryHooks | null {
  return defaultNoteHistory;
}

export interface ApplyContext {
  deviceId: string;
  idColumnMap?: ReadonlyMap<string, string> | null;
  profileMerger?: LearnerProfileMerger | null;
  noteHistory?: NoteHistoryHooks | null;
  /** 测试替代 Rust `#[cfg(test)]` 的表名豁免；生产必须保持 undefined。 */
  allowSyncTestFixtureTables?: boolean;
  /** Rust tracing 出口；仅在 warn!/info! 位置使用，不改变控制流。 */
  logger?: SyncLogger | null;
}

export interface ApplyChangeFailure {
  table_name: string;
  record_id: string;
  operation: string;
  error: string;
}

export interface ApplyChangesResult {
  success_count: number;
  failure_count: number;
  skipped_count: number;
  skipped_incomplete_count: number;
  failures: ApplyChangeFailure[];
  applied_keys: Set<string>;
}

export function emptyApplyChangesResult(): ApplyChangesResult {
  return {
    success_count: 0,
    failure_count: 0,
    skipped_count: 0,
    skipped_incomplete_count: 0,
    failures: [],
    applied_keys: new Set<string>(),
  };
}

export function keyOf(table: string, recordId: string): string {
  return `${table}\u001f${recordId}`;
}

/** Rust `begin_apply_savepoint`（mod.rs:6971）。 */
export function beginApplySavepoint(tx: SqlExecutor, index: number): string {
  const name = `sp_sync_apply_${index}`;
  try {
    tx.exec(`SAVEPOINT ${name}`);
  } catch (error) {
    databaseError(`创建 SAVEPOINT 失败: ${message(error)}`);
  }
  return name;
}

/** Rust `release_savepoint`（mod.rs:6983）。 */
export function releaseApplySavepoint(tx: SqlExecutor, name: string): void {
  try {
    tx.exec(`RELEASE SAVEPOINT ${name}`);
  } catch (error) {
    databaseError(`释放 SAVEPOINT 失败: ${message(error)}`);
  }
}

/** Rust `rollback_and_release_savepoint`（mod.rs:6978）：两步都是 `let _`。 */
export function rollbackAndReleaseApplySavepoint(tx: SqlExecutor, name: string): void {
  try {
    tx.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    tx.exec(`RELEASE SAVEPOINT ${name}`);
  } catch { // boundary-allow empty-catch: Rust rollback_and_release_savepoint 对两步都忽略错误（`let _ =`）。
  }
}

/**
 * 回放/回滚期间的 change_log 回声抑制。
 *
 * Rust 对应位置是 `let _ = conn.execute("UPDATE __change_log ...")`，失败只忽略，
 * 不能反过来让已经应用成功的变更失败。
 */
export function suppressEchoChangeLog(
  tx: SqlExecutor,
  syncVersion: number,
  preLogMax: bigint,
  tableName?: string,
  recordId?: string,
): void {
  try {
    if (tableName === undefined) {
      tx.run(
        'UPDATE __change_log SET sync_version = ?1 WHERE id > ?2 AND sync_version = 0',
        [syncVersion, preLogMax],
      );
    } else {
      tx.run(
        `UPDATE __change_log SET sync_version = ?1
         WHERE id > ?2 AND sync_version = 0
           AND table_name = ?3 AND record_id = ?4`,
        [syncVersion, preLogMax, tableName, recordId ?? ''],
      );
    }
  } catch { // boundary-allow empty-catch: Rust 对回声抑制 UPDATE 用 `let _ = conn.execute(...)`，失败不阻断已应用变更。
  }
}
