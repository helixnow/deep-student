/**
 * Pre-storage 独立开库（W13）。
 *
 * F3 的 purge 在 `DataSpaceStartup.start()` 内、`ctx.storage` 发布之前执行；
 * L20 的 `storageStartupSync` provider 只 inject `paths`，因此拿不到 `ctx.storage`。
 * 本工厂是这一阶段的公开接缝：只打开调用方给出的文件（不打开业务库、不跑迁移、
 * 不解析/改写 `slots/state.json`），PRAGMA 与 Rust `SyncStateStore::open_default`
 * 用同一份 `PROFILES.sync_state`，并暴露同步 `SqlExecutor` 与 rusqlite 形状的
 * 事务原语（`begin` 默认 deferred = `unchecked_transaction()`）。
 *
 * 复用现有 {@link Connection} 与 {@link PROFILES}，不复制 schema、不实现业务逻辑；
 * 打开/关闭/错误行为与 `Connection` 完全一致。
 *
 * `setBusyHandler`（WP-164，= rusqlite `Connection::busy_handler`，dstu-sync `state.rs:626-657`）
 * 只是把 F7 `nativeSqliteBusy` 用在本句柄自己的连接上；本工厂不 inject 任何服务，
 * 由调用方经 `options.nativeSqliteBusy` 传入（插件里即 `ctx.nativeSqliteBusy`）。
 */
import {
  StorageError,
  type ConnectionProfile,
  type ConnectionProfileName,
  type Query,
  type RunResult,
  type SqlExecutor,
  type SqlParams,
  type TransactionBehavior,
} from './api.ts';
import { Connection } from './connection.ts';
import type { NativeSqliteBusy, SqliteBusyHandler } from '../native/api.ts';
import { PROFILES } from './profiles.ts';

type AnyQuery = Query<any, any> | string;

export interface OpenStartupDatabaseOptions {
  /** 诊断标签（`StorageError.database`）。默认取 profile 名（默认 `'sync_state'`）；自定义 profile 时为 `'startup'`。 */
  readonly label?: string;
  /** 预置配置名或自定义配置，PRAGMA 顺序同 `Connection`。默认 `'sync_state'`。 */
  readonly profile?: ConnectionProfileName | ConnectionProfile;
  /**
   * F7 `nativeSqliteBusy`（`ctx.nativeSqliteBusy`，或 worker 线程里 F7 的同一实现）。
   * 只有调用 {@link StartupDatabase.setBusyHandler} 时才需要；省略时打开/SQL 行为不变。
   */
  readonly nativeSqliteBusy?: NativeSqliteBusy;
}

/**
 * 启动期（pre-storage）独立数据库句柄。
 *
 * 事务方法与 rusqlite 逐项对应：`begin()`（默认 `deferred`）/ `commit()` / `rollback()`。
 * 调用方负责在 `finally` 中 {@link close}。
 */
export interface StartupDatabase extends SqlExecutor {
  /** 诊断标签（默认 `'sync_state'`）。 */
  readonly label: string;
  /** 数据库文件绝对路径。 */
  readonly path: string;
  /** 是否处于未提交事务中（`Connection.inTransaction`）。 */
  readonly inTransaction: boolean;
  /** `BEGIN <behavior>`；省略 behavior 时为 `deferred`（= rusqlite `unchecked_transaction()`）。 */
  begin(behavior?: TransactionBehavior): void;
  /** `COMMIT`。 */
  commit(): void;
  /** `ROLLBACK`；SQLite 已自动回滚时不再发语句（同 `Connection.rollback`）。 */
  rollback(): void;
  /** 关闭连接（幂等）；关闭后语句抛错。关闭同时释放已安装的 busy handler。 */
  close(): void;
  /**
   * 在本连接上安装（函数）或移除（`null`）SQLite busy handler，= rusqlite
   * `Connection::busy_handler(Some(f) | None)`；须在 profile 之后、无语句执行时调用。
   *
   * SQLite 在争用锁的**同一次** `sqlite3_step` 内、本线程上同步调用 handler：
   * `priorInvocations` 是本次锁事件的已调用次数（首次 0）；返回 `true` 继续等待，
   * 其余返回值或抛错都等同 `false`（rusqlite 0.40.1 `busy.rs:60`），该语句以原
   * `SQLITE_BUSY` 失败（`StorageError` code `SQLITE`、phase `execute`），
   * `PRAGMA wal_checkpoint` 则返回 `busy = 1` 的行；抛出的值不保留、不重抛。
   * 安装即替换 profile 的 `busy_timeout`（读回为 0）；`null` 移除且不恢复 timeout；
   * 之后的 `PRAGMA busy_timeout = N` 又会替换 handler。替换、`null`、`close()` 释放
   * 函数引用（busy_timeout 覆盖后的引用在下一次 setBusyHandler 或 close 时释放）。
   * 语义全部来自 F7 `nativeSqliteBusy`，本方法不重试、不计时。
   *
   * 打开时未传 `options.nativeSqliteBusy` → `StorageError('INVALID_PARAM')`；连接已关闭 /
   * handler 非函数非 null / handler 内重入调用 → F7 绑定的 `TypeError` 原样抛出。
   */
  setBusyHandler(handler: SqliteBusyHandler | null): void;
}

class StartupDatabaseHandle implements StartupDatabase {
  private readonly conn: Connection;

  constructor(conn: Connection) {
    this.conn = conn;
  }

  get label(): string {
    return this.conn.label;
  }

  get path(): string {
    return this.conn.path;
  }

  get inTransaction(): boolean {
    return this.conn.inTransaction;
  }

  get<R = any>(query: AnyQuery, params?: SqlParams): R {
    return this.conn.get<R>(query, params) as R;
  }

  one<R = any>(query: AnyQuery, params?: SqlParams): R {
    const row = this.conn.get(query, params);
    if (row === undefined) {
      throw new StorageError('NO_ROWS', 'Query returned no rows', { database: this.conn.label });
    }
    return row as R;
  }

  pluck<T>(query: AnyQuery, params?: SqlParams): T | undefined {
    return this.conn.pluck<T>(query, params);
  }

  all<R = any>(query: AnyQuery, params?: SqlParams): R[] {
    return this.conn.all<R>(query, params);
  }

  iterate<R = any>(query: AnyQuery, params?: SqlParams): IterableIterator<R> {
    return this.conn.iterate<R>(query, params);
  }

  run(query: AnyQuery, params?: SqlParams): RunResult {
    return this.conn.run(query, params);
  }

  exec(sql: string): void {
    this.conn.exec(sql);
  }

  begin(behavior: TransactionBehavior = 'deferred'): void {
    this.conn.begin(behavior);
  }

  commit(): void {
    this.conn.commit();
  }

  rollback(): void {
    this.conn.rollback();
  }

  close(): void {
    this.conn.close();
  }

  setBusyHandler(handler: SqliteBusyHandler | null): void {
    this.conn.setBusyHandler(handler);
  }
}

/**
 * 打开启动期独立数据库（不经过 `ctx.storage`）。
 *
 * 默认使用 `PROFILES.sync_state`（`synchronous=FULL`、`busy_timeout=5000`，与
 * `state.rs:31-36` 相同）。父目录默认递归创建、缺失库文件允许创建，与
 * `Connection`/`ctx.storage.openFile` 的既有行为一致；未调整任何 PRAGMA 顺序。
 */
export function openStartupDatabase(
  filePath: string,
  options: OpenStartupDatabaseOptions = {},
): StartupDatabase {
  const selected = options.profile ?? 'sync_state';
  const label = options.label ?? (typeof selected === 'string' ? selected : 'startup');
  const profile = typeof selected === 'string' ? PROFILES[selected] : selected;
  return new StartupDatabaseHandle(new Connection(filePath, { label, profile, nativeSqliteBusy: options.nativeSqliteBusy }));
}
