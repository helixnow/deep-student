/**
 * {@link DatabaseHandle} 实现：主连接（同步读写）+ 写者槽 + 异步事务专用连接 + 维护屏障。
 *
 * 并发模型（Node 单线程）：
 * - 同步 API 在主连接上执行，不让出事件循环，天然无交错。
 * - 异步事务跨 `await`，用独立连接承载，避免其他代码的语句混入事务。同一库同一时刻最多一个
 *   异步事务（写者槽，FIFO）。持有期间主连接上的写会被立即拒绝（`BUSY`）——若让 SQLite 在
 *   主连接上 busy-wait，会阻塞事件循环导致持锁的异步事务永远无法推进。
 * - `write()` 在写者槽上排队后执行同步事务，是异步代码中写库的推荐方式。
 */
import {
  AfterCommitError,
  StorageError,
  type AsyncTransaction,
  type AsyncTransactionOptions,
  type BatchStatement,
  type ConnectionProfile,
  type DatabaseHandle,
  type Query,
  type Row,
  type RunResult,
  type SqlExecutor,
  type SqlParams,
  type SyncTransaction,
  type TransactionBehavior,
  type TransactionOptions,
  type TransactionScope,
} from './api.ts';
import { Connection } from './connection.ts';
import { storageLog } from './logging.ts';
import { abortError, WriterSlot } from './writer-slot.ts';

type AnyQuery = Query<any, any> | string;

/** `database/maintenance.rs:32-33`：屏障内拒绝新连接时的统一错误文案。 */
export const MAINTENANCE_REFUSAL_MESSAGE =
  '处于维护屏障（备份/恢复进行中），拒绝发放新数据库连接以防写入被静默丢弃';

export { WriterSlot };

// ------------------------------------------------------------------ 事务作用域

/**
 * 事务作用域：在给定连接上执行语句，收集 afterCommit 回调，提供保存点。
 * `guard` 在每条语句前调用（检查事务是否仍活跃）。
 */
class Scope implements TransactionScope {
  readonly callbacks: Array<() => void | Promise<void>> = [];
  private savepointDepth = 0;

  protected readonly conn: () => Connection;
  private readonly guardFn: (() => void) | undefined;
  private readonly spPrefix: string;

  constructor(
    conn: () => Connection,
    guardFn: (() => void) | undefined,
    spPrefix: string,
  ) {
    this.conn = conn;
    this.guardFn = guardFn;
    this.spPrefix = spPrefix;
  }

  protected guard(): void {
    this.guardFn?.();
  }

  /** 事务作用域始终在事务内（journal 的 autocommit 边界检查）。 */
  get inTransaction(): boolean {
    return true;
  }

  get<R = any>(query: AnyQuery, params?: SqlParams): R {
    this.guard();
    return this.conn().get<R>(query, params) as R;
  }
  one<R = any>(query: AnyQuery, params?: SqlParams): R {
    this.guard();
    return one(this.conn(), query, params) as R;
  }
  pluck<T>(query: AnyQuery, params?: SqlParams): T | undefined {
    this.guard();
    return this.conn().pluck<T>(query, params);
  }
  all<R = any>(query: AnyQuery, params?: SqlParams): R[] {
    this.guard();
    return this.conn().all<R>(query, params);
  }
  iterate<R = any>(query: AnyQuery, params?: SqlParams): IterableIterator<R> {
    this.guard();
    return this.conn().iterate<R>(query, params);
  }
  run(query: AnyQuery, params?: SqlParams): RunResult {
    this.guard();
    return this.conn().run(query, params);
  }
  exec(sql: string): void {
    this.guard();
    this.conn().exec(sql);
  }

  afterCommit(callback: () => void): void {
    this.guard();
    this.callbacks.push(callback);
  }

  savepoint<T>(fn: (sp: TransactionScope) => T): T {
    this.guard();
    const depth = ++this.savepointDepth;
    const name = `${this.spPrefix}_sp${depth}`;
    const conn = this.conn();
    conn.exec(`SAVEPOINT ${name}`);
    const child = new Scope(this.conn, () => this.guard(), name);
    let result: T;
    try {
      result = fn(child);
      if (isPromiseLike(result)) {
        throw new StorageError('ASYNC_IN_SYNC_TX', 'savepoint callback must be synchronous');
      }
    } catch (error) {
      if (conn.inTransaction) {
        conn.exec(`ROLLBACK TO ${name}`);
        conn.exec(`RELEASE ${name}`);
      }
      this.savepointDepth--;
      throw error;
    }
    conn.exec(`RELEASE ${name}`);
    this.savepointDepth--;
    this.callbacks.push(...child.callbacks);
    return result;
  }
}

function one(conn: Connection, query: AnyQuery, params?: SqlParams): unknown {
  const row = conn.get(query, params);
  if (row === undefined) throw new StorageError('NO_ROWS', 'Query returned no rows', { database: conn.label });
  return row;
}

function isPromiseLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function runSyncCallbacks(callbacks: ReadonlyArray<() => void | Promise<void>>): void {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    try {
      const result = callback();
      if (isPromiseLike(result)) {
        (result as Promise<void>).catch((error: unknown) => {
          storageLog('dstu_storage::database', 'warn', `afterCommit callback rejected after commit: ${String(error)}`);
        });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AfterCommitError(errors);
}

async function runAsyncCallbacks(callbacks: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AfterCommitError(errors);
}

// ------------------------------------------------------------------ 异步事务

class AsyncTx extends Scope implements AsyncTransaction {
  private state: 'active' | 'committed' | 'rolledback' | 'aborted' = 'active';
  private readonly onAbort: (() => void) | undefined;

  private readonly connection: Connection;
  private readonly signal: AbortSignal | undefined;
  private readonly finish: () => void;

  constructor(
    connection: Connection,
    signal: AbortSignal | undefined,
    finish: () => void,
  ) {
    super(() => connection, undefined, 'dstx');
    this.connection = connection;
    this.signal = signal;
    this.finish = finish;
    if (signal !== undefined) {
      this.onAbort = () => {
        if (this.state !== 'active') return;
        this.state = 'aborted';
        this.connection.rollback();
        this.done();
      };
      signal.addEventListener('abort', this.onAbort, { once: true });
    }
  }

  get active(): boolean {
    return this.state === 'active';
  }

  protected override guard(): void {
    this.check();
  }

  private check(): void {
    if (this.state === 'aborted') throw abortError(this.signal!);
    if (this.state !== 'active') throw new StorageError('TX_CLOSED', 'Transaction is no longer active', { database: this.connection.label });
  }

  private done(): void {
    if (this.signal !== undefined && this.onAbort !== undefined) this.signal.removeEventListener('abort', this.onAbort);
    this.finish();
  }

  async commit(): Promise<void> {
    this.check();
    try {
      this.connection.commit();
    } catch (error) {
      this.state = 'rolledback';
      this.connection.rollback();
      this.done();
      throw error;
    }
    this.state = 'committed';
    this.done();
    await runAsyncCallbacks(this.callbacks);
  }

  async rollback(): Promise<void> {
    if (this.state !== 'active') return;
    this.state = 'rolledback';
    try {
      this.connection.rollback();
    } finally {
      this.done();
    }
  }
}

// ------------------------------------------------------------------ 句柄

export interface HandleOptions {
  readonly name: string;
  readonly path: string;
  readonly profile: ConnectionProfile;
  readonly mustExist?: boolean;
  /** 对应 {@link OpenFileOptions.createParentDirs}；默认 true。 */
  readonly createParentDirs?: boolean;
  /** 首次打开主连接后执行（browser 懒迁移）。 */
  readonly onFirstOpen?: (handle: SqliteDatabase) => void;
}

export class SqliteDatabase implements DatabaseHandle {
  readonly name: string;
  path: string;
  private primary: Connection | undefined;
  private txConnection: Connection | undefined;
  private readonly slot = new WriterSlot();
  private asyncTxActive = false;
  private asyncDone: Array<() => void> = [];
  private maintenance = false;
  private closed = false;
  private firstOpenDone = false;

  private readonly options: HandleOptions;

  constructor(options: HandleOptions) {
    this.options = options;
    this.name = options.name;
    this.path = options.path;
    this.conn();
  }

  private isMemory(): boolean {
    return this.path === ':memory:' || this.path === '';
  }

  /** 主连接（按需打开；维护屏障或已关闭时拒绝）。 */
  private conn(): Connection {
    if (this.closed) throw new StorageError('TX_CLOSED', `Database ${this.name} is closed`, { database: this.name });
    if (this.maintenance) {
      throw new StorageError('MAINTENANCE', `Database ${this.name} is in maintenance mode`, { database: this.name });
    }
    if (this.primary === undefined || !this.primary.open) {
      this.primary = new Connection(this.path, {
        label: this.name,
        profile: this.options.profile,
        mustExist: this.options.mustExist,
        createParentDirs: this.options.createParentDirs,
      });
      if (!this.firstOpenDone) {
        this.firstOpenDone = true;
        this.options.onFirstOpen?.(this);
      }
    }
    return this.primary;
  }

  /** 主连接上执行写语句前的检查：异步事务持有写者槽时非阻塞拒绝。 */
  private ensureWritable(query: AnyQuery): void {
    if (this.asyncTxActive && !this.conn().isReadonly(query)) this.busy();
  }

  private busy(): never {
    throw new StorageError('BUSY', `database ${this.name} is locked by an active async transaction`, {
      database: this.name,
      sqliteCode: 'SQLITE_BUSY',
    });
  }

  private readGuard(): void {
    // 内存库的异步事务与主连接共用同一条连接，期间禁止外部语句。
    if (this.asyncTxActive && this.isMemory()) this.busy();
  }

  /** 主连接当前是否处于（同步或异步）事务中。 */
  get inTransaction(): boolean {
    return this.primary?.inTransaction ?? false;
  }

  get<R = any>(query: AnyQuery, params?: SqlParams): R {
    this.readGuard();
    this.ensureWritable(query);
    return this.conn().get<R>(query, params) as R;
  }
  one<R = any>(query: AnyQuery, params?: SqlParams): R {
    this.readGuard();
    this.ensureWritable(query);
    return one(this.conn(), query, params) as R;
  }
  pluck<T>(query: AnyQuery, params?: SqlParams): T | undefined {
    this.readGuard();
    this.ensureWritable(query);
    return this.conn().pluck<T>(query, params);
  }
  all<R = any>(query: AnyQuery, params?: SqlParams): R[] {
    this.readGuard();
    this.ensureWritable(query);
    return this.conn().all<R>(query, params);
  }
  iterate<R = any>(query: AnyQuery, params?: SqlParams): IterableIterator<R> {
    this.readGuard();
    this.ensureWritable(query);
    return this.conn().iterate<R>(query, params);
  }
  run(query: AnyQuery, params?: SqlParams): RunResult {
    this.readGuard();
    this.ensureWritable(query);
    return this.conn().run(query, params);
  }
  exec(sql: string): void {
    if (this.asyncTxActive) this.busy();
    this.conn().exec(sql);
  }

  transaction<T>(fn: (tx: SyncTransaction) => T, options?: TransactionOptions): T {
    if (this.asyncTxActive) this.busy();
    return this.runSync(fn, options?.behavior ?? 'deferred');
  }

  private runSync<T>(fn: (tx: SyncTransaction) => T, behavior: TransactionBehavior): T {
    const conn = this.conn();
    if (conn.inTransaction) {
      throw new StorageError('SQLITE', 'cannot start a transaction within a transaction', {
        database: this.name,
        sqliteCode: 'SQLITE_ERROR',
      });
    }
    let open = true;
    const scope = new Scope(
      () => conn,
      () => {
        if (!open) throw new StorageError('TX_CLOSED', 'Transaction is no longer active', { database: this.name });
      },
      'dstx',
    );
    conn.begin(behavior);
    let result: T;
    try {
      result = fn(scope);
      if (isPromiseLike(result)) {
        throw new StorageError('ASYNC_IN_SYNC_TX', 'transaction callback must be synchronous; use withTransaction for async work', {
          database: this.name,
        });
      }
      conn.commit();
    } catch (error) {
      open = false;
      conn.rollback();
      throw error;
    }
    open = false;
    runSyncCallbacks(scope.callbacks);
    return result;
  }

  async write<T>(fn: (tx: SyncTransaction) => T, options?: AsyncTransactionOptions): Promise<T> {
    this.conn();
    await this.slot.acquire(options?.signal);
    try {
      if (options?.signal?.aborted === true) throw abortError(options.signal);
      return this.runSync(fn, options?.behavior ?? 'immediate');
    } finally {
      this.slot.release();
    }
  }

  async begin(options?: AsyncTransactionOptions): Promise<AsyncTransaction> {
    this.conn();
    await this.slot.acquire(options?.signal);
    let connection: Connection;
    try {
      if (options?.signal?.aborted === true) throw abortError(options.signal);
      connection = this.isMemory() ? this.conn() : this.transactionConnection();
      connection.begin(options?.behavior ?? 'immediate');
    } catch (error) {
      this.slot.release();
      throw error;
    }
    this.asyncTxActive = true;
    return new AsyncTx(connection, options?.signal, () => {
      this.asyncTxActive = false;
      this.slot.release();
      const waiters = this.asyncDone;
      this.asyncDone = [];
      for (const waiter of waiters) waiter();
    });
  }

  async withTransaction<T>(fn: (tx: AsyncTransaction) => Promise<T>, options?: AsyncTransactionOptions): Promise<T> {
    const tx = await this.begin(options);
    let result: T;
    try {
      result = await fn(tx);
      if (options?.signal?.aborted === true) throw abortError(options.signal);
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    await tx.commit();
    return result;
  }

  private transactionConnection(): Connection {
    if (this.txConnection === undefined || !this.txConnection.open) {
      this.txConnection = new Connection(this.path, {
        label: `${this.name}#tx`,
        profile: this.options.profile,
        mustExist: true,
      });
    }
    return this.txConnection;
  }

  batch(statements: readonly BatchStatement[]): RunResult[] {
    return this.transaction((tx) => statements.map((s) => tx.run(s.query, s.params)), { behavior: 'immediate' });
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): readonly [number, number, number] {
    if (this.asyncTxActive) this.busy();
    return this.conn().checkpoint(mode);
  }

  async backupTo(destinationPath: string): Promise<void> {
    await this.conn().backupTo(destinationPath);
  }

  // -------------------------------------------------------------- 服务内部

  /** 维护屏障：拒绝新借用 → 等待在途异步事务（含排队者） → checkpoint(TRUNCATE) → 关闭连接。 */
  async enterMaintenance(deadline: number): Promise<void> {
    if (this.maintenance) {
      throw new StorageError('MAINTENANCE', `Database ${this.name} is already in maintenance mode`, { database: this.name });
    }
    this.maintenance = true;
    try {
      await this.drain(deadline);
      if (this.primary !== undefined && this.primary.open && this.options.profile.journalMode === 'WAL') {
        const [busy] = this.primary.checkpoint('TRUNCATE');
        if (busy !== 0) {
          throw new StorageError('SQLITE', `wal_checkpoint(TRUNCATE) returned busy for ${this.name}`, {
            database: this.name,
            sqliteCode: 'SQLITE_BUSY',
          });
        }
      }
    } catch (error) {
      this.maintenance = false;
      throw error;
    }
    this.closeConnections();
  }

  private async drain(deadline: number): Promise<void> {
    while (this.asyncTxActive || this.slot.isHeld || this.slot.pending > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new StorageError('MAINTENANCE_DRAIN_TIMEOUT', `Timed out draining active transactions on ${this.name}`, {
          database: this.name,
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 50));
        this.asyncDone.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  exitMaintenance(): void {
    this.maintenance = false;
  }

  get inMaintenance(): boolean {
    return this.maintenance;
  }

  /**
   * `Database::switch_to_path`（database/mod.rs:869-899）：把主连接重定向到新文件。
   * 新连接使用 WAL / synchronous=NORMAL / foreign_keys=ON / busy_timeout=3000；
   * 维护屏障期间拒绝（`get_conn_safe` 的文案），异步事务持锁期间同样不能换文件。
   */
  switchTo(newPath: string): void {
    if (this.closed) throw new StorageError('TX_CLOSED', `Database ${this.name} is closed`, { database: this.name });
    if (this.maintenance) {
      throw new StorageError('MAINTENANCE', `主数据库${MAINTENANCE_REFUSAL_MESSAGE}`, { database: this.name });
    }
    if (this.asyncTxActive) this.busy();
    const next = new Connection(newPath, {
      label: this.name,
      profile: { ...this.options.profile, synchronous: 'NORMAL' },
    });
    this.closeConnections();
    this.primary = next;
    this.path = newPath;
  }

  private closeConnections(): void {
    this.txConnection?.close();
    this.txConnection = undefined;
    this.primary?.close();
    this.primary = undefined;
  }

  /** 永久关闭（openFile 句柄的 close / 服务卸载）。 */
  close(): void {
    if (this.asyncTxActive) this.busy();
    this.closeConnections();
    this.closed = true;
  }

  /** 迁移器等内部组件直接访问主连接（不受写者槽检查）。 */
  rawConnection(): Connection {
    return this.conn();
  }
}

export type { Row, SqlExecutor };
