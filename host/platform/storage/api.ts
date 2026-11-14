/**
 * F3 存储服务接口（冻结边界）。业务插件只依赖本文件，不直接引用 better-sqlite3。
 *
 * 本文件只放**类型与零逻辑的工具函数**；实现见 `host/platform/storage/` 的其他文件。
 * 设计依据（Rust 原实现）：
 * - 每库连接与 PRAGMA：`dstu-storage/src/database/{mod,manager}.rs`、`dstu-vfs/src/vfs/database.rs`、
 *   `dstu-agent/src/chat_v2/database.rs`、`dstu-storage/src/llm_usage/database.rs`、
 *   `dstu-browser/src/browser/database.rs`、`dstu-storage/src/audit/mod.rs`、
 *   `dstu-sync/src/data_governance/sync/state.rs`、`dstu-agent/src/chat_v2/workspace/database.rs`。
 * - 仓储形态：Rust 仓储普遍是 `fn xxx_with_conn(conn: &Connection, ...)`，事务内外共用同一函数
 *   （`Transaction` deref 到 `Connection`）；事务用 `transaction_with_behavior(Immediate)`、
 *   `BEGIN IMMEDIATE`、`savepoint()`；单行查询用 `query_row(...).optional()`。
 *   对应到这里：仓储函数接收 {@link SqlExecutor}，事务与库句柄都实现它。
 *
 * 详细约定见 `API.md`。
 */

import type {} from '@deepseek-ai/cordis';
import type { StartupRecoveryStatus, StartupRecoveryIncident, StartupRecoveryResolveResponse } from '../../../contracts/ipc/generated/F3-storage.ts';
import type { FeatureFlag, FeatureFlagManager, FeatureFlagSettingsStore } from './feature-flags.ts';
import type { ImageQualityCodec } from './file-manager.ts';
export type { ImageQualityCodec } from './file-manager.ts';
// 依赖 Node 的值（文件删除队列、worker、统一文件管理的文件读写、syncStateDatabasePath、openStartupDatabase）
// 只从 `node.ts` 导入；本文件只转出它们的类型，是可移植入口（见 `storage-mobile/tests/storage-entries.test.ts`）。
export { registerWorkspaceIndexDeletionOwner } from './workspace-deletion-owner.ts';
export type { WorkspaceIndexDeletionOwner } from './workspace-deletion-owner.ts';
export type { PreparedDeletionIntent } from './file-deletion-queue.ts';
export type { NoteAssetRetention } from './file-deletion-queue.ts';
export { registerDeletionJournal } from './deletion-journal-owner.ts';
export type { DeletionJournalRepository, DeletionJournalIntent, PrepareDeletionJournalIntent, DeletionJournalTargetKind } from './deletion-journal-owner.ts';
export type { MigrationWorker, MigrationWorkerOptions, MigrationWorkerReport } from './migration-worker.ts';
/**
 * Multi-database worker task context also exposes `openFile(path, options?)` for task-owned files
 * (L16 APKG temporary `collection.anki2`): same defaults/errors as {@link StorageService.openFile},
 * closed by `close` or the task's finally, never returned across the thread boundary. Rust APKG
 * opens import collections with `open_with_flags(READ_ONLY | NO_MUTEX)` (`apkg_importer_service.rs:1301`)
 * and export collections with `Connection::open` + journal_mode=DELETE PRAGMAs; usage in API.md §11 WP-140.
 */
export type {
  DatabaseWorkerPool, DatabaseWorkerPoolOptions, DatabaseWorkerRunOptions,
  DatabaseWorkerTaskContext, DatabaseWorkerTask, DatabaseWorkerTasks,
  MultiDatabaseWorkerTaskContext, MultiDatabaseWorkerTasks, MultiDatabaseWorkerRunOptions,
} from './worker-pool.ts';
export {
  isVirtualUri, rejectDoubleEncodedVirtualUri, isOpaqueDocumentId, extractFileName, extractExtension, sanitizeFileNameForFs,
} from './file-names.ts';
import type {
  BudgetConfig,
  ExactBudgetConfig,
  ExactInjectionBudgetManager,
  InjectionBudgetManager,
  InjectionItem,
  InjectionType,
  Priority,
} from './injection-budget.ts';
export type { BudgetConfig, ExactBudgetConfig, AllocationResult, ExactAllocationResult, ExactInjectionBudgetManager } from './injection-budget.ts';

/** 数据空间服务：启动预检在任何业务连接/迁移前完成；恢复模式仍可查询和解决事件。 */
export interface DataSpaceService {
  readonly baseDir: string;
  readonly initialized: boolean;
  status(): StartupRecoveryStatus;
  incidents(): StartupRecoveryIncident[];
  retryPreflight(): StartupRecoveryStatus;
  resolve(candidateId: string): StartupRecoveryResolveResponse;
  slotDir(slot: DataSpaceSlot): string;
  activeDir(): string;
  inactiveDir(): string;
  markPendingSwitch(target: DataSpaceSlot): void;
  markRestoreCutoverPending(target: DataSpaceSlot, backupId: string): void;
  restoreCutoverPending(): DataSpaceRestoreLease | null;
  markRestoreActivationCommitted(activeDir: string, backupId: string): void;
  completeRestoreCutover(activeDir: string): boolean;
  clearSlotForRestore(target: DataSpaceSlot): string | null;
  cleanupRestoreTrash(target: DataSpaceSlot): number;
}

export type DataSpaceSlot = 'slotA' | 'slotB' | 'slotC' | 'slotD';
export interface DataSpaceRestoreLease {
  target_slot: string;
  backup_id: string;
  created_at: string;
  activation_committed: boolean;
}

/**
 * L20 startup-only hook: `SyncStateStore::reset_default_after_local_purge`（`state.rs:528-552`），
 * 必须在任何业务数据库连接打开前调用。
 *
 * 提供方要求（W13，不能由 F3 代做）：
 * - 由 L20 的一个**不 inject `storage`** 的插件在 `dstu.platform.storage` **之前** apply 并
 *   `ctx.provide('storageStartupSync', ...)`。它只能依赖 `paths`（或直接读 `dataLocalDir`），
 *   用 `node.ts` 的 `syncStateDatabasePath` 得到 `<dataLocalDir>/deep-student/sync/sync_state.db`，
 *   用 `node.ts` 的 `openStartupDatabase` 像 Rust `open_default()` 一样独立开库（同一
 *   `PROFILES.sync_state` PRAGMA，不经过 `ctx.storage`），`CREATE TABLE IF NOT EXISTS`、在
 *   **同一事务**里清空 `consume_cursor` / `legacy_processed_key` / `tombstone_watermark` /
 *   `instance_binding` / `device_history`，**保留 `upload_seq`**。
 * - 不能把该提供方挂在注入 `storage` 的 `dstu.sync-support` 上：F3 的 purge 发生在
 *   `ctx.storage` 发布之前（`index.ts` 的 `startup.start()`），此时该插件尚未 apply。
 * - 不能改用 D2 `registerFinalizer`：finalizer 在全部插件 apply 之后、迁移之后运行，晚于
 *   Rust `lib.rs:1021` 的 reset 点，也晚于 F3 清除 `.purge_on_next_start`。
 *
 * F3 在删除活动槽/非活跃槽之后、清除 `.purge_on_next_start` 之前调用本方法；抛错会作为
 * `重置同步消费基线失败: <message>` 计入 `startup_cleanup` 失败并保留清理标记，业务库保持关闭。
 */
export interface StorageStartupSyncService { resetDefaultAfterLocalPurge(): void | Promise<void> }

// ------------------------------------------------------------------ 库名与位置

/**
 * 注册的逻辑库名。路径相对 {@link StorageLocations}（与 Rust 完全一致）：
 *
 * | 名称 | 文件 | Rust 来源 |
 * |---|---|---|
 * | `mistakes` | `<active>/mistakes.db`（主库：错题/Anki/设置表 `settings`/superagent 状态等） | `file_manager.rs:222` |
 * | `vfs` | `<active>/databases/vfs.db` | `vfs/database.rs`、`coordinator.rs:1324` |
 * | `chat_v2` | `<active>/chat_v2.db` | `chat_v2/database.rs:76` |
 * | `llm_usage` | `<active>/llm_usage.db` | `llm_usage/database.rs:120` |
 * | `audit` | `<active>/databases/audit.db` | `coordinator.rs:264`、`init.rs:295` |
 * | `browser` | `<active>/browser.db`（独立 refinery 迁移，懒加载） | `browser/database.rs:46` |
 * | `sync_state` | `<dataLocalDir>/deep-student/sync/sync_state.db`（**不在**数据空间内） | `sync/state.rs:23-29` |
 *
 * `<active>` = 数据空间活动槽目录 `<AppInfo.dataDir>/slots/slot{A|B}`（`data_space.rs`）。
 * 动态库（chat_v2 工作区 `ws_<id>.db`、导入的外部 SQLite 文件、备份快照）不在此列，用
 * {@link StorageService.openFile} 打开。
 */
export type DatabaseName = 'mistakes' | 'vfs' | 'chat_v2' | 'llm_usage' | 'audit' | 'browser' | 'sync_state';

/** 全部注册库名（顺序无语义）。 */
export const DATABASE_NAMES: readonly DatabaseName[] = [
  'mistakes',
  'vfs',
  'chat_v2',
  'llm_usage',
  'audit',
  'browser',
  'sync_state',
];

/** 由迁移协调器（refinery 兼容）管理 schema 的库，顺序 = Rust `DatabaseId::all_ordered()`。 */
export type CoordinatedDatabaseName = 'vfs' | 'llm_usage' | 'chat_v2' | 'mistakes';

export interface StorageLocations {
  /** Tauri `app_data_dir()`（= `AppInfo.dataDir`）。 */
  readonly baseDir: string;
  /** 活动数据空间槽名：`slotA` / `slotB`（测试槽 `slotC` / `slotD` 只在测试切换中出现）。 */
  readonly activeSlot: 'slotA' | 'slotB' | 'slotC' | 'slotD';
  /** 活动槽目录，Rust 中的 `active_app_data_dir`。 */
  readonly activeDir: string;
  /** `dirs::data_local_dir()` 的等价目录（sync_state 用）。 */
  readonly dataLocalDir: string;
}

/**
 * `node.ts` 的 `syncStateDatabasePath`：L20 启动期同步基线重置使用的 `sync_state.db` 绝对路径
 * （`<dataLocalDir>/deep-student/sync/sync_state.db`，Rust `state.rs:22-29`）。
 * 该库不在数据空间槽内；提供方可在 storage 发布前用此路径独立开库。
 *
 * `node.ts` 的 `openStartupDatabase`：启动期（pre-storage）独立开库工厂：不注入/不依赖 `ctx.storage`，只打开调用方给出的文件
 * （默认 `PROFILES.sync_state`），返回 {@link StartupDatabase}——同步 {@link SqlExecutor} +
 * `begin()`（默认 deferred）/`commit()`/`rollback()`/`close()`。供 L20 的
 * {@link StorageStartupSyncService} 提供方在 `dstu.platform.storage` 发布前使用；
 * 不打开业务库、不跑迁移、不复制 schema。打开/关闭/错误行为与 `ctx.storage.openFile` 一致。
 */
export type { StartupDatabase, OpenStartupDatabaseOptions } from './startup-database.ts';

// ------------------------------------------------------------------ 值与参数

/**
 * 可绑定的参数值。`boolean` 按 rusqlite `ToSql for bool` 绑定为 0/1；`undefined` 不允许
 * （Rust 中不存在，传入即抛错，防止漏字段静默写 NULL）。
 */
export type SqlParam = null | number | bigint | string | boolean | Uint8Array;

/** 读出的列值：INTEGER → number（`safeIntegers` 时 bigint），REAL → number，TEXT → string，BLOB → Buffer。 */
export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * 参数：位置参数数组（`?` / `?1`）或命名参数对象（SQL 中写 `:name` / `@name` / `$name`，
 * 对象键不带前缀）。
 */
export type SqlParams = readonly SqlParam[] | Readonly<Record<string, SqlParam>>;

export type Row = Record<string, SqlValue>;

export interface RunResult {
  /** `sqlite3_changes()`，同 rusqlite `execute` 的返回值。 */
  readonly changes: number;
  /** `sqlite3_last_insert_rowid()`。 */
  readonly lastInsertRowid: number | bigint;
}

// ------------------------------------------------------------------ 命名查询

export interface QueryOptions {
  /** 整数以 bigint 返回（i64 超过 2^53 的列，如序列号/纳秒时间戳）。默认 false。 */
  readonly safeIntegers?: boolean;
}

/**
 * 命名查询：插件在 `repository/` 中用 {@link defineQuery} 声明，`P`/`R` 是参数与行的
 * 编译期契约。实现按 `sql` 文本缓存预编译语句（等价 rusqlite `prepare_cached`）。
 */
export interface Query<P extends SqlParams | void = SqlParams | void, R = Row> {
  readonly sql: string;
  /** 日志/诊断用名称，如 `vfs.folder.getById`。 */
  readonly name?: string;
  readonly options?: QueryOptions;
  /** 仅类型用途，运行时不存在。 */
  readonly __types?: { params: P; row: R };
}

/** 零逻辑：声明一个命名查询（定义在可移植叶子模块 `query.ts`）。 */
export { defineQuery } from './query.ts';

type ParamsOf<Q> = Q extends Query<infer P, unknown> ? P : never;
type RowOf<Q> = Q extends Query<SqlParams | void, infer R> ? R : never;
/** `Query<void, …>` 不需要参数；其余必须传参数。 */
type ArgsOf<Q> = ParamsOf<Q> extends void ? [] : [params: ParamsOf<Q>];

// ------------------------------------------------------------------ 执行器

/**
 * 同步执行面：库句柄、同步事务、异步事务句柄、保存点都实现它。仓储函数一律写成
 * `(db: SqlExecutor, ...) => ...`，事务内外复用（对应 Rust `*_with_conn(conn: &Connection)`）。
 *
 * 所有方法都同步执行（better-sqlite3），不会在中途让出事件循环。
 */
export interface SqlExecutor {
  /**
   * 是否处于事务中（`true` = 该执行器是 {@link SyncTransaction}/{@link AsyncTransaction}
   * 或当前连接已有未提交事务）。低层 journal 用它执行 `ensure_autocommit` 边界检查；
   * 普通仓储函数不应依赖它。
   */
  readonly inTransaction?: boolean;
  /** 首行或 `undefined`（= rusqlite `query_row(..).optional()`）。 */
  get<Q extends Query<any, any>>(query: Q, ...args: ArgsOf<Q>): RowOf<Q> | undefined;
  get<R = Row>(sql: string, params?: SqlParams): R | undefined;
  /** 首行；无行时抛 {@link StorageError}（code `NO_ROWS`，message 与 rusqlite 一致：`Query returned no rows`）。 */
  one<Q extends Query<any, any>>(query: Q, ...args: ArgsOf<Q>): RowOf<Q>;
  one<R = Row>(sql: string, params?: SqlParams): R;
  /** 首行首列（= `query_row(sql, p, |r| r.get(0))`），无行返回 `undefined`。 */
  pluck<T = SqlValue>(query: Query<any, any> | string, params?: SqlParams): T | undefined;
  all<Q extends Query<any, any>>(query: Q, ...args: ArgsOf<Q>): RowOf<Q>[];
  all<R = Row>(sql: string, params?: SqlParams): R[];
  /** 逐行迭代（大结果集）；迭代期间不得在同一执行器上执行其他语句。 */
  iterate<Q extends Query<any, any>>(query: Q, ...args: ArgsOf<Q>): IterableIterator<RowOf<Q>>;
  iterate<R = Row>(sql: string, params?: SqlParams): IterableIterator<R>;
  /** 执行单条写语句（= rusqlite `execute`）。 */
  run(query: Query<any, any> | string, params?: SqlParams): RunResult;
  /** 执行多条语句（= rusqlite `execute_batch`）；无参数绑定，只用于 DDL/脚本。 */
  exec(sql: string): void;
}

// ------------------------------------------------------------------ 事务

/**
 * 事务开始方式，与 rusqlite `TransactionBehavior` 对应：`deferred`（`transaction()` 默认）、
 * `immediate`（`transaction_with_behavior(Immediate)` / `BEGIN IMMEDIATE`）、`exclusive`。
 */
export type TransactionBehavior = 'deferred' | 'immediate' | 'exclusive';

export interface TransactionOptions {
  /** 默认 `deferred`（与 rusqlite `Connection::transaction()` 相同）。写事务应显式用 `immediate`。 */
  readonly behavior?: TransactionBehavior;
}

/** 事务内部共有的能力。 */
export interface TransactionScope extends SqlExecutor {
  /**
   * 提交成功后按注册顺序调用（发业务事件用，对应"事件在提交后发出"）。回滚时丢弃。
   * 保存点内注册的回调在保存点回滚时一并丢弃。回调抛错不影响已提交的数据，
   * 全部回调执行完后以 {@link AfterCommitError} 抛给事务调用方。
   */
  afterCommit(callback: () => void): void;
  /**
   * 同步保存点（= rusqlite `savepoint()`）：`fn` 正常返回则 RELEASE，抛错则
   * ROLLBACK TO + RELEASE 后重新抛出。`fn` 不得返回 Promise。
   */
  savepoint<T>(fn: (sp: TransactionScope) => T): T;
}

/** {@link DatabaseHandle.transaction} 传给回调的同步事务。 */
export type SyncTransaction = TransactionScope;

/**
 * 异步事务句柄：绑定一条**独占连接**（不是库句柄的主连接），跨 `await` 保持原子性，
 * 期间其他代码在主连接上的读不受影响（WAL），写被拒绝（{@link StorageError} `BUSY`）
 * 或在 {@link DatabaseHandle.write} 中排队等待。同一库同时最多一个异步事务（单写者）。
 */
export interface AsyncTransaction extends TransactionScope {
  /** `begin` 后为 true；提交、回滚、中止后为 false，此后任何语句抛 `TX_CLOSED`。 */
  readonly active: boolean;
  /** 提交并依次运行 afterCommit 回调（异步回调会被等待）。 */
  commit(): Promise<void>;
  /** 回滚；对已结束的事务是空操作。 */
  rollback(): Promise<void>;
}

export interface AsyncTransactionOptions extends TransactionOptions {
  /** 中止即回滚：未提交前触发则回滚并使后续语句抛 `ABORTED`（对应 Rust 取消点 drop 事务）。 */
  readonly signal?: AbortSignal;
}

// ------------------------------------------------------------------ 批次

export interface BatchStatement {
  readonly query: Query<any, any> | string;
  readonly params?: SqlParams;
}

// ------------------------------------------------------------------ 库句柄

export interface DatabaseHandle extends SqlExecutor {
  /** 注册名，或 openFile 时调用方给的标签。 */
  readonly name: string;
  /** 数据库文件绝对路径。 */
  readonly path: string;

  /**
   * 同步事务（better-sqlite3 原生事务，期间不会让出事件循环）。`fn` 返回值即结果；
   * 抛错回滚并重抛；返回 Promise 视为编程错误（回滚并抛 `ASYNC_IN_SYNC_TX`）。
   * 若该库正有异步事务持有写者槽，立即抛 `BUSY`（不阻塞事件循环）——异步代码请用 {@link write}。
   */
  transaction<T>(fn: (tx: SyncTransaction) => T, options?: TransactionOptions): T;

  /** 等待写者槽后执行同步事务（异步代码中写库的推荐方式）。默认 `immediate`。 */
  write<T>(fn: (tx: SyncTransaction) => T, options?: AsyncTransactionOptions): Promise<T>;

  /** 开启异步事务（等待写者槽，FIFO）。调用方负责 commit/rollback。默认 `immediate`。 */
  begin(options?: AsyncTransactionOptions): Promise<AsyncTransaction>;

  /**
   * `begin` + 回调 + 提交：回调 resolve 则提交并运行 afterCommit；reject 或 signal 中止
   * 则回滚并重抛。默认 `immediate`。
   */
  withTransaction<T>(fn: (tx: AsyncTransaction) => Promise<T>, options?: AsyncTransactionOptions): Promise<T>;

  /** 在一个 `immediate` 事务里依次执行全部语句，任何一条失败整体回滚。 */
  batch(statements: readonly BatchStatement[]): RunResult[];

  /** `PRAGMA wal_checkpoint(<mode>)`，返回 `[busy, log, checkpointed]`。 */
  checkpoint(mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): readonly [number, number, number];

  /** SQLite 在线备份（= rusqlite `backup::Backup` 全量 step）到目标文件。 */
  backupTo(destinationPath: string): Promise<void>;
}

// ------------------------------------------------------------------ 连接配置

/** 每条连接打开后按顺序执行的 PRAGMA（与 Rust `with_init` / 构造函数一致）。 */
export interface ConnectionProfile {
  readonly foreignKeys?: boolean;
  readonly journalMode?: 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF';
  readonly synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  /** 毫秒。rusqlite `Connection::open` 默认 5000。 */
  readonly busyTimeoutMs?: number;
  readonly autoVacuum?: 'NONE' | 'FULL' | 'INCREMENTAL';
  /** 只读打开（文件必须存在）。 */
  readonly readonly?: boolean;
}

/** 预置配置名：注册库各一份；`workspace` = chat_v2 工作区 `ws_<id>.db`；`plain` = 裸 `Connection::open`。 */
export type ConnectionProfileName = DatabaseName | 'workspace' | 'plain';

export interface OpenFileOptions {
  /** 诊断标签。 */
  readonly label?: string;
  /** 预置配置名或自定义配置。默认 `plain`。 */
  readonly profile?: ConnectionProfileName | ConnectionProfile;
  /** 文件不存在时报错而不是创建。 */
  readonly mustExist?: boolean;
  /**
   * 打开前是否递归创建父目录。默认 `true`（保持既有 `openFile` 行为）。
   * `false` 时：父目录必须已存在，但**允许创建缺失的库文件**；父目录缺失由 SQLite
   * 报 `SQLITE_CANTOPEN`（对应 Rust `Connection::open`，不 mkdir）。
   */
  readonly createParentDirs?: boolean;
}

// ------------------------------------------------------------------ 维护屏障

/**
 * 维护屏障（备份/恢复/数据空间切换前）：拒绝新的借用（`MAINTENANCE`），等待在途异步事务结束，
 * 执行 `wal_checkpoint(TRUNCATE)` 并关闭全部连接；`release()` 后恢复按需打开。
 * 对应 Rust 各 `enter_maintenance_mode` / `exit_maintenance_mode`。
 */
export interface MaintenanceLease {
  readonly databases: readonly DatabaseName[];
  release(): void;
}

export interface MaintenanceOptions {
  /** 等待在途异步事务的上限，超时抛 `MAINTENANCE_DRAIN_TIMEOUT` 并恢复原状态。默认 30000。 */
  readonly drainTimeoutMs?: number;
}

/**
 * 维护屏障参与者（线程/子进程持有自己连接的组件）。
 *
 * `enterMaintenance` 必须停止接受新工作、等待在途工作完成并关闭线程内连接；
 * `exitMaintenance` 同步放行并按需惰性重开。F3 在关闭主线程连接前调用 enter，
 * 释放后按注册逆序调用 exit。备份/恢复/数据空间切换期间不允许新注册。
 */
export interface MaintenanceParticipant {
  /** 参与的库；省略表示所有库。 */
  readonly databases?: readonly DatabaseName[];
  enterMaintenance(): void | Promise<void>;
  /** 必须同步完成（terminate 可 fire-and-forget，后续按需重建）。 */
  exitMaintenance(): void;
}

// ------------------------------------------------------------------ 迁移

/** 单库迁移结果（= Rust `DatabaseMigrationReport`）。 */
export interface DatabaseMigrationReport {
  readonly id: CoordinatedDatabaseName;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly appliedCount: number;
  readonly success: boolean;
  readonly durationMs: number;
  readonly error: string | null;
}

/** 全量迁移结果（= Rust `MigrationReport`）。 */
export interface MigrationReport {
  readonly databases: readonly DatabaseMigrationReport[];
  readonly success: boolean;
  readonly totalDurationMs: number;
  readonly error: string | null;
}

/**
 * 启动迁移的全局失败（Rust `initialize_with_report` 返回 Err，`lib.rs:1194-1306`）。
 * 单库失败不在此列：它们留在 {@link MigrationReport} 与组件健康里。
 */
/** {@link StorageService.startupCoreRecovery}。 */
export interface StartupCoreRecovery {
  readonly reason: string;
  /** storage 持有维护屏障的核心库，按 mistakes → vfs → chat_v2 → llm_usage 排列。 */
  readonly databases: readonly CoordinatedDatabaseName[];
}

export interface StartupMigrationFailure {
  /** Rust `e.to_string()`：`Migration error: …`（非迁移错误为原文）。 */
  readonly error: string;
  /** `MigrationError` 的 kind；非迁移错误为 `null`。 */
  readonly kind: string | null;
  /** `MigrationError::RecoveredFromBackup`（lib.rs:1204-1258）。 */
  readonly recovered: boolean;
  /**
   * 是否强制维护：`recovered` 恒为 true；其余按
   * `should_force_maintenance_mode_on_init_failure`（schema 指纹漂移不强制）。
   */
  readonly maintenanceForced: boolean;
}

export interface MigrationService {
  /** = `MigrationCoordinator::run_all()`：按依赖顺序迁移四个核心库（含迁移前快照、失败单库恢复）。 */
  runAll(): Promise<MigrationReport>;
  /**
   * = `MigrationCoordinator::migrate_single(id)`（Rust `with_audit_db(None).migrate_single(Mistakes)`
   * 同一入口）：只迁移指定库，不检查依赖、不做迁移前全库快照/全库恢复。
   *
   * 内部完整保留该库的 repair、refinery checksum 修复、verifier 与 schema fingerprint 校验；
   * 失败 reject（不吞错、不伪造 report）。审计配置沿用 `createStorageService({ auditDbPath })`，
   * `null` 对应 Rust `with_audit_db(None)`。
   */
  migrateSingle(name: CoordinatedDatabaseName): Promise<DatabaseMigrationReport>;
  /** 当前版本（`refinery_schema_history` 最大 version；无表为 0）。 */
  currentVersion(name: CoordinatedDatabaseName | 'browser'): number;
  /** 是否有待执行迁移。 */
  needsMigration(name: CoordinatedDatabaseName): boolean;
}

// ------------------------------------------------------------------ 服务

/** `ctx.storage`。 */
export interface StorageService {
  readonly locations: StorageLocations;
  /** 注册库的文件路径（不打开）。 */
  pathOf(name: DatabaseName): string;
  /**
   * 获取注册库句柄（首次调用时打开并应用该库的 PRAGMA）。同名返回同一实例。
   * 维护屏障期间抛 `MAINTENANCE`。`browser` 首次打开时执行其 refinery 迁移（同 Rust 懒加载）。
   */
  database(name: DatabaseName): DatabaseHandle;
  /**
   * 打开任意 SQLite 文件（工作区库、导入文件、备份快照）。调用方负责 {@link close}。
   *
   * 桌面：每次调用都开一条独立连接并应用 `options.profile`；同一文件（包括注册库文件）可以同时有多个句柄，
   * 并发由 SQLite 文件锁和 `busy_timeout` 协调。
   *
   * 移动端每个库文件只有一条连接（`locking_mode=EXCLUSIVE` + WAL，OPFS 不加文件锁，第二条连接看不到第一条的提交，
   * checkpoint 时会互相覆盖；V06-06），因此：
   * - `path` 是注册库文件（`pathOf(name)`）时，返回与 `database(name)` 共用连接的句柄：`options.profile` 不生效，
   *   以注册库的 PRAGMA 为准；注册句柄上有异步事务时，经它的同步调用立即抛 `BUSY`（桌面的另一条连接会按
   *   `busy_timeout` 等锁）；维护屏障期间抛 `MAINTENANCE`；`close()` 只作废这个句柄，不关闭共用的连接。
   * - 其他文件已被一个未关闭的 `openFile` 句柄打开时，立即抛 `StorageError('BUSY')`（`sqliteCode: 'SQLITE_BUSY'`），
   *   不等待也不重试；先 `close()` 前一个句柄才能再打开。
   *
   * 两端都要跑的代码：同一文件同一时刻只持有一个句柄，注册库直接用 `database(name)`。
   */
  openFile(path: string, options?: OpenFileOptions): DatabaseHandle;
  /** 关闭 openFile 打开的句柄（注册库由服务管理，不能经此关闭）。 */
  close(handle: DatabaseHandle): void;
  /**
   * `batch_operations.rs:17-33`：归档 `created_at` 早于 `daysOld` 天且非 `archived`
   * 的错题，返回影响行数（mistakes 库上的单个 deferred 事务）。
   */
  batchArchiveOldMistakes(daysOld: number): number;
  /** `batch_operations.rs:35-49`：删除 `chat_messages` 中失去父错题的行，返回删除行数。 */
  batchCleanupOrphanedMessages(): number;
  enterMaintenance(names?: readonly DatabaseName[], options?: MaintenanceOptions): Promise<MaintenanceLease>;
  readonly migrations: MigrationService;
  /**
   * 本进程第一次 `migrations.runAll()`（启动迁移）的报告；尚未运行、恢复模式跳过或全局失败时为 `null`。
   * 之后的 `runAll()` 不覆盖它（Rust 启动事件只描述 setup 那一次）。
   */
  startupMigrationReport(): MigrationReport | null;
  /** 启动迁移的全局失败；成功、未运行或只有单库失败时为 `null`。 */
  startupMigrationFailure(): StartupMigrationFailure | null;
  /**
   * 启动维护态（本进程不会自行解除）：启动迁移全局失败且强制维护，或进入核心恢复模式时给出原因，否则 `null`。
   * kernel 据此让降级插件的维护占位命令返回 MAINTENANCE 错误。
   */
  startupMaintenance(): { reason: string } | null;
  /**
   * 核心恢复启动模式（lib.rs:1312-1318）：启动迁移 Ok 但 vfs / mistakes 被阻断。storage 在业务插件装配前
   * 已对 `databases` 进入维护屏障并持有到卸载；`reason` 为直接阻断（非依赖闭包）的原因。未进入时为 `null`。
   */
  startupCoreRecovery(): StartupCoreRecovery | null;
  /**
   * 注册启动收尾钩子。必须在组合根调用 {@link runStartupFinalizers} 之前注册；注册顺序即无依赖
   * 钩子的执行顺序。`after` 声明依赖（被依赖者先执行）。
   *
   * 用途（D2）：L21 恢复收尾、F2 startupGate 的“迁移/恢复完成后”动作。F3 不 import 业务插件，
   * 只负责排序与执行。
   */
  registerFinalizer(name: string, fn: () => void | Promise<void>, options?: StartupFinalizerOptions): void;
  /**
   * 执行全部已注册 finalizer：按 `after` 拓扑排序，逐个 `await`；失败立即停止并抛
   * {@link StartupFinalizerError}（保留失败名称、原始 cause 与已完成列表），registry 保持
   * failed 状态且**不自动重试**。再次调用会跳过已成功的钩子并重试失败的钩子；失败后的注册
   * （late/duplicate/invalid）只抛结构化错误，绝不执行 callback。组合根应在全部插件 apply
   * 后调用一次，成功后再 `startupGate.markStartupReady()`。
   */
  runStartupFinalizers(): Promise<StartupFinalizerReport>;
  /** 当前已注册的 finalizer 名称（注册顺序；只读快照）。 */
  finalizerNames(): readonly string[];
  /**
   * 注册维护屏障参与者（如 worker 线程内自持的数据库连接）。返回注销函数；
   * 维护屏障期间拒绝注册。参与者的 `databases` 与 `StorageService.enterMaintenance(names)`
   * 的 names 有交集时才会被调用。
   */
  registerMaintenanceParticipant(name: string, participant: MaintenanceParticipant): () => void;
}

// ------------------------------------------------------------------ 错误

export { StorageError, StartupFinalizerError, AfterCommitError, unsupportedOnPlatform, UNSUPPORTED_ON_PLATFORM_PREFIX } from './errors.ts';
export type { StorageErrorCode, SqlPhase } from './errors.ts';

/** 启动 finalizer 注册选项。`after` 中的名称必须也已注册（运行时校验）。 */
export interface StartupFinalizerOptions {
  readonly after?: readonly string[];
}

/** `runStartupFinalizers()` 的结果。重试时 `completed` 包含上次已成功的钩子。 */
export interface StartupFinalizerReport {
  readonly completed: readonly string[];
  readonly skipped: readonly string[];
}

// ------------------------------------------------------------------ 公共工具服务

/**
 * F3 公共工具：feature flags（`dstu-storage/src/feature_flags.rs`）。
 *
 * 消费方：L19-mcp-browser 的 `get_feature_flags` / `update_feature_flag`（当前该插件仍有本地副本，
 * 接入后应改为 `ctx.featureFlags`）。`store` 由调用方提供（通常是 F4 `ctx.settings`），F3 不反向依赖
 * settings（settings 依赖 storage，直接注入会形成环）。
 */
export interface FeatureFlagsService {
  /** `FeatureFlagManager::new(app_version)` + `with_user_id` + `load_from_database`。 */
  load(
    store: FeatureFlagSettingsStore,
    appVersion: string,
    options?: { debug?: boolean; userId?: string | null },
  ): FeatureFlagManager;
  /** `FeatureFlagManager::save_to_database`。 */
  save(manager: FeatureFlagManager, store: FeatureFlagSettingsStore): void;
  newFlag(name: string, description: string, category: string): FeatureFlag;
  enable(flag: FeatureFlag): FeatureFlag;
  disable(flag: FeatureFlag): FeatureFlag;
  setGradual(flag: FeatureFlag, percentage: number): FeatureFlag;
  setUserSpecific(flag: FeatureFlag, users: string[]): FeatureFlag;
  withDependencies(flag: FeatureFlag, dependencies: string[]): FeatureFlag;
  withVersionRange(flag: FeatureFlag, min: string | null, max: string | null): FeatureFlag;
}

/**
 * F3 公共工具：注入预算（`dstu-storage/src/injection_budget.rs`）。
 *
 * 消费方：L02-llm-manager 的 `get_injection_budget_config` / `simulate_budget_allocation`
 * 已消费 `ctx.injectionBudget`；持久化 usize 的无损解码由 L02 承担，分配仍由本服务所有。
 */
export interface InjectionBudgetService {
  defaultConfig(): BudgetConfig;
  createManager(config: BudgetConfig): InjectionBudgetManager;
  newItem(type: InjectionType, content: string, priority: Priority, source: string): InjectionItem;
}

/** Additive precise owner entry; existing number-valued service declarations stay compatible. */
export interface ExactInjectionBudgetService extends InjectionBudgetService {
  defaultExactConfig(): ExactBudgetConfig;
  createExactManager(config: ExactBudgetConfig): ExactInjectionBudgetManager;
}

/**
 * F3 公共工具：笔记资源路径安全（`file_manager.rs:865-912`）。
 *
 * 消费方：L10-notes 的笔记资源仓储（当前用本地 `assetsDir`，接入后应改为 `ctx.noteAssets`）。
 */
export interface NoteAssetsService {
  /** `validate_note_asset_path_segment`：拒绝空段、路径分隔符、`.`/`..`、盘符与绝对路径。 */
  validateSegment(label: string, value: string): void;
  /** `portable_relative_path`：反斜杠转正斜杠。 */
  portableRelativePath(value: string): string;
  /** `resolve_note_assets_dir`：`<writableDir>/notes_assets/<subject>/<noteId>`，越界即拒绝。 */
  resolveDir(writableDir: string, subject: string, noteId: string): string;
}

/**
 * F3 公共工具：`FileManager::adjust_image_quality_{bytes,base64}` 的策略入口
 * （`file_manager.rs:74-167`）。
 *
 * 消费方：L12-vfs-index 的 PDF 图片压缩。调用方传入真实 `ctx.nativeImage`；F3 负责
 * high/unknown/auto 阈值、500KB no-op、invalid 回退与参数顺序，不复制 codec。
 * main 的 `ctx.nativeImage` 目前只有 `dimensions`/`decodeRgba`；
 * `resizeAndEncodeJpeg` 在 F7 候选分支 `ds-mig/F7-native`，合入 main 后 L12 才能直接接线。
 * 真实 JPEG 等价测试保持 pending。
 */
export interface ImageQualityService {
  /** Rust `adjust_image_quality_bytes(bytes, quality)`；`codec` 传 `ctx.nativeImage`。 */
  adjustImageQualityBytes(
    bytes: Uint8Array,
    visionQuality: string,
    codec: ImageQualityCodec,
  ): Promise<Uint8Array>;
  /** Rust `adjust_image_quality_base64(base64, quality)`；invalid base64 原字符串返回。 */
  adjustImageQualityBase64(
    base64Data: string,
    visionQuality: string,
    codec: ImageQualityCodec,
  ): Promise<string>;
}

/**
 * F3 LLM 用量记录入口（`dstu-storage/src/llm_usage/mod.rs:78-340`），写入 F3 自有的 `llm_usage.db`。
 *
 * 语义同 Rust：collector（`UsageCollector`，50 条 / 5 秒批量单事务写入）未就绪时记录进入
 * 有界待写队列（上限 1000，满了丢最旧并 warn），collector 就绪后的下一次记录先冲刷队列。
 * `success=false` 且 `errorMessage=null` 时落库 `"Unknown error"`；可空 token 字段 null 落库 NULL（无测量）。
 * 消费方：L02-llm-manager（`ctx.reflect.get('llmUsage')`）、L03 chat-pipeline。
 */
export interface LlmUsageService {
  /** mod.rs:32 `cache_debug_enabled`：`CHAT_V2_CACHE_DEBUG=1`。 */
  cacheDebugEnabled(): boolean;
  /** mod.rs:252 `record_llm_usage_cache_ext_with_identity`。 */
  recordLlmUsageCacheExtWithIdentity(call: import('./llm-usage.ts').LlmUsageCacheExtIdentityCall): void;
  /** mod.rs:195 `record_llm_usage_cache_ext`（variant/run = None）。 */
  recordLlmUsageCacheExt(call: import('./llm-usage.ts').LlmUsageCacheExtCall & { sessionId: string | null }): void;
  /** mod.rs:160 `record_llm_usage_ext`（cache_write = None）。 */
  recordLlmUsageExt(call: import('./llm-usage.ts').LlmUsageExtCall & { sessionId: string | null }): void;
  /** mod.rs:126 `record_llm_usage`（adapter / token_source = None）。 */
  recordLlmUsage(call: import('./llm-usage.ts').LlmUsageCall & { sessionId: string | null }): void;
  /** mod.rs:78 `record_usage_record`：已构造好的 `UsageRecord`。 */
  recordUsageRecord(record: import('./llm-usage.ts').UsageRecord): void;
}

/**
 * F3 `FileManager` 路径入口（`file_manager.rs:169/237`），基于活动槽目录（`build_app_state(active_app_data_dir)`）。
 * 消费方：L02-llm-manager（OCR 图片路径）、translation（`temp/` 目录）、anki 媒体（持久数据）。
 */
export interface FileManagerPathsService {
  /**
   * 持久数据（数据库、笔记资源、备份根、Anki 媒体等）的目录：只用活动槽目录，不可写时抛 `AppError.file_system`，
   * 不回退到别处（RF-W07-persistent-app-data-no-silent-relocation；实现见 `file-manager.ts`）。
   */
  getPersistentAppDataDir(): string;
  /** 临时、可再生数据（OCR 暂存、翻译 `temp/`、导出 staging）：活动槽 → `dirs::data_dir()/DeepStudent` → `temp_dir()/deep_student_data`。 */
  getTempAppDataDir(): string;
  /**
   * `get_writable_app_data_dir`：与 {@link getTempAppDataDir} 相同的回退链。
   * @deprecated 持久数据用 {@link getPersistentAppDataDir}，临时数据用 {@link getTempAppDataDir}。
   */
  getWritableAppDataDir(): string;
  /** `resolve_image_path`：相对 `<活动槽>/images` 解析，带路径遍历防护。 */
  resolveImagePath(path: string): string;
}

/**
 * `unified_file_manager::is_virtual_uri`（unified_file_manager.rs:413）的服务形态：
 * 实现即本文件导出的 {@link isVirtualUri}，trim 后按 content/asset/ph/image/camera scheme
 * 或 primary:/secondary:/raw: SAF 前缀（大小写不敏感）判定。纯函数，恢复模式下同样可用。
 * 消费方：L13 vfs `mindmap_import` 的 originalPath 回退（builtin_resource_executor.rs:2901）。
 */
export interface VirtualFilePolicyService {
  isVirtualUri(path: string): boolean;
}

// ------------------------------------------------------------------ ctx 增强

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** F3：存储服务。 */
    storage: StorageService;
    dataSpace: DataSpaceService;
    storageStartupSync: StorageStartupSyncService;
    featureFlags: FeatureFlagsService;
    injectionBudget: ExactInjectionBudgetService;
    noteAssets: NoteAssetsService;
    imageQuality: ImageQualityService;
    llmUsage: LlmUsageService;
    fileManagerPaths: FileManagerPathsService;
    virtualFilePolicy: VirtualFilePolicyService;
  }
}
