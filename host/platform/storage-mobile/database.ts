/**
 * 移动端 {@link DatabaseHandle}：语义对齐桌面 `host/platform/storage/database.ts` 的 `SqliteDatabase`。
 *
 * 唯一的结构差异：每个库只有一条连接（S2，`opfs-sahpool` 同文件多连接不互斥）。因此异步事务与
 * 句柄共用这条连接——行为与桌面 `:memory:` 库完全相同：异步事务期间，句柄上的任何语句
 * （包括读）立即抛 `BUSY`；异步代码应使用 {@link write} / {@link withTransaction} 排队。
 */
import type {
  AsyncTransaction,
  AsyncTransactionOptions,
  BatchStatement,
  ConnectionProfile,
  DatabaseHandle,
  Query,
  RunResult,
  SqlParams,
  SyncTransaction,
  TransactionBehavior,
  TransactionOptions,
  TransactionScope,
} from '../storage/api.ts';
import { AfterCommitError, StorageError } from '../storage/errors.ts';
import { WriterSlot, abortError } from '../storage/writer-slot.ts';
import type { MobileConnection } from './connection.ts';

type AnyQuery = Query<any, any> | string;

function isPromiseLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

function one(conn: MobileConnection, query: AnyQuery, params?: SqlParams): unknown {
  const row = conn.get(query, params);
  if (row === undefined) throw new StorageError('NO_ROWS', 'Query returned no rows', { database: conn.label });
  return row;
}

export type StorageWarn = (message: string) => void;

class Scope implements TransactionScope {
  readonly callbacks: Array<() => void | Promise<void>> = [];
  private savepointDepth = 0;
  protected readonly conn: MobileConnection;
  private readonly guardFn: (() => void) | undefined;
  private readonly spPrefix: string;

  constructor(conn: MobileConnection, guardFn: (() => void) | undefined, spPrefix: string) {
    this.conn = conn;
    this.guardFn = guardFn;
    this.spPrefix = spPrefix;
  }

  protected guard(): void {
    this.guardFn?.();
  }

  get inTransaction(): boolean {
    return true;
  }

  get<R = any>(query: AnyQuery, params?: SqlParams): R {
    this.guard();
    return this.conn.get<R>(query, params) as R;
  }
  one<R = any>(query: AnyQuery, params?: SqlParams): R {
    this.guard();
    return one(this.conn, query, params) as R;
  }
  pluck<T>(query: AnyQuery, params?: SqlParams): T | undefined {
    this.guard();
    return this.conn.pluck<T>(query, params);
  }
  all<R = any>(query: AnyQuery, params?: SqlParams): R[] {
    this.guard();
    return this.conn.all<R>(query, params);
  }
  iterate<R = any>(query: AnyQuery, params?: SqlParams): IterableIterator<R> {
    this.guard();
    return this.conn.iterate<R>(query, params);
  }
  run(query: AnyQuery, params?: SqlParams): RunResult {
    this.guard();
    return this.conn.run(query, params);
  }
  exec(sql: string): void {
    this.guard();
    this.conn.exec(sql);
  }

  afterCommit(callback: () => void): void {
    this.guard();
    this.callbacks.push(callback);
  }

  savepoint<T>(fn: (sp: TransactionScope) => T): T {
    this.guard();
    const depth = ++this.savepointDepth;
    const name = `${this.spPrefix}_sp${depth}`;
    this.conn.exec(`SAVEPOINT ${name}`);
    const child = new Scope(this.conn, () => this.guard(), name);
    let result: T;
    try {
      result = fn(child);
      if (isPromiseLike(result)) throw new StorageError('ASYNC_IN_SYNC_TX', 'savepoint callback must be synchronous');
    } catch (error) {
      if (this.conn.inTransaction) {
        this.conn.exec(`ROLLBACK TO ${name}`);
        this.conn.exec(`RELEASE ${name}`);
      }
      this.savepointDepth--;
      throw error;
    }
    this.conn.exec(`RELEASE ${name}`);
    this.savepointDepth--;
    this.callbacks.push(...child.callbacks);
    return result;
  }
}

function runSyncCallbacks(callbacks: ReadonlyArray<() => void | Promise<void>>, warn: StorageWarn): void {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    try {
      const result = callback();
      if (isPromiseLike(result)) {
        (result as Promise<void>).catch((error: unknown) => warn(`afterCommit callback rejected after commit: ${String(error)}`));
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

class AsyncTx extends Scope implements AsyncTransaction {
  private state: 'active' | 'committed' | 'rolledback' | 'aborted' = 'active';
  private readonly onAbort: (() => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly finish: () => void;

  constructor(conn: MobileConnection, signal: AbortSignal | undefined, finish: () => void) {
    super(conn, undefined, 'dstx');
    this.signal = signal;
    this.finish = finish;
    if (signal !== undefined) {
      this.onAbort = () => {
        if (this.state !== 'active') return;
        this.state = 'aborted';
        this.conn.rollback();
        this.done();
      };
      signal.addEventListener('abort', this.onAbort, { once: true });
    }
  }

  get active(): boolean {
    return this.state === 'active';
  }

  protected override guard(): void {
    if (this.state === 'aborted') throw abortError(this.signal!);
    if (this.state !== 'active') throw new StorageError('TX_CLOSED', 'Transaction is no longer active', { database: this.conn.label });
  }

  private done(): void {
    if (this.signal !== undefined && this.onAbort !== undefined) this.signal.removeEventListener('abort', this.onAbort);
    this.finish();
  }

  async commit(): Promise<void> {
    this.guard();
    try {
      this.conn.commit();
    } catch (error) {
      this.state = 'rolledback';
      this.conn.rollback();
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
      this.conn.rollback();
    } finally {
      this.done();
    }
  }
}

export interface MobileDatabaseOptions {
  readonly name: string;
  readonly path: string;
  readonly profile: ConnectionProfile;
  readonly open: () => MobileConnection;
  readonly warn: StorageWarn;
  /** 构造时不打开连接（维护屏障接管尚未使用、可能无法打开的库）。 */
  readonly deferOpen?: boolean;
}

export class MobileDatabase implements DatabaseHandle {
  readonly name: string;
  readonly path: string;
  private connection: MobileConnection | undefined;
  private readonly slot = new WriterSlot();
  private asyncTxActive = false;
  private asyncDone: Array<() => void> = [];
  private maintenance = false;
  private closed = false;
  private readonly options: MobileDatabaseOptions;

  constructor(options: MobileDatabaseOptions) {
    this.options = options;
    this.name = options.name;
    this.path = options.path;
    if (options.deferOpen !== true) this.conn();
  }

  private conn(): MobileConnection {
    if (this.closed) throw new StorageError('TX_CLOSED', `Database ${this.name} is closed`, { database: this.name });
    if (this.maintenance) throw new StorageError('MAINTENANCE', `Database ${this.name} is in maintenance mode`, { database: this.name });
    if (this.connection === undefined || !this.connection.open) this.connection = this.options.open();
    return this.connection;
  }

  private busy(): never {
    throw new StorageError('BUSY', `database ${this.name} is locked by an active async transaction`, { database: this.name, sqliteCode: 'SQLITE_BUSY' });
  }

  /** 单连接：异步事务期间句柄上的任何语句都会看到未提交数据，统一拒绝（同桌面 `:memory:`）。 */
  private guard(): MobileConnection {
    if (this.asyncTxActive) this.busy();
    return this.conn();
  }

  get inTransaction(): boolean {
    return this.connection?.open === true && this.connection.inTransaction;
  }

  /** 连接上实际生效的锁 / 日志模式（启动报告与测试用）。 */
  get pragmas() {
    return this.conn().applied;
  }

  get<R = any>(query: AnyQuery, params?: SqlParams): R {
    return this.guard().get<R>(query, params) as R;
  }
  one<R = any>(query: AnyQuery, params?: SqlParams): R {
    return one(this.guard(), query, params) as R;
  }
  pluck<T>(query: AnyQuery, params?: SqlParams): T | undefined {
    return this.guard().pluck<T>(query, params);
  }
  all<R = any>(query: AnyQuery, params?: SqlParams): R[] {
    return this.guard().all<R>(query, params);
  }
  iterate<R = any>(query: AnyQuery, params?: SqlParams): IterableIterator<R> {
    return this.guard().iterate<R>(query, params);
  }
  run(query: AnyQuery, params?: SqlParams): RunResult {
    return this.guard().run(query, params);
  }
  exec(sql: string): void {
    this.guard().exec(sql);
  }

  transaction<T>(fn: (tx: SyncTransaction) => T, options?: TransactionOptions): T {
    if (this.asyncTxActive) this.busy();
    return this.runSync(fn, options?.behavior ?? 'deferred');
  }

  private runSync<T>(fn: (tx: SyncTransaction) => T, behavior: TransactionBehavior): T {
    const conn = this.conn();
    if (conn.inTransaction) {
      throw new StorageError('SQLITE', 'cannot start a transaction within a transaction', { database: this.name, sqliteCode: 'SQLITE_ERROR' });
    }
    let open = true;
    const scope = new Scope(conn, () => {
      if (!open) throw new StorageError('TX_CLOSED', 'Transaction is no longer active', { database: this.name });
    }, 'dstx');
    conn.begin(behavior);
    let result: T;
    try {
      result = fn(scope);
      if (isPromiseLike(result)) {
        throw new StorageError('ASYNC_IN_SYNC_TX', 'transaction callback must be synchronous; use withTransaction for async work', { database: this.name });
      }
      conn.commit();
    } catch (error) {
      open = false;
      conn.rollback();
      throw error;
    }
    open = false;
    runSyncCallbacks(scope.callbacks, this.options.warn);
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
    let conn: MobileConnection;
    try {
      if (options?.signal?.aborted === true) throw abortError(options.signal);
      conn = this.conn();
      conn.begin(options?.behavior ?? 'immediate');
    } catch (error) {
      this.slot.release();
      throw error;
    }
    this.asyncTxActive = true;
    return new AsyncTx(conn, options?.signal, () => {
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

  batch(statements: readonly BatchStatement[]): RunResult[] {
    return this.transaction(tx => statements.map(s => tx.run(s.query, s.params)), { behavior: 'immediate' });
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): readonly [number, number, number] {
    return this.guard().checkpoint(mode);
  }

  async backupTo(destinationPath: string): Promise<void> {
    await this.guard().backupTo(destinationPath);
  }

  /** 维护屏障：拒绝新借用 → 等待在途异步事务 → checkpoint(TRUNCATE) → 关闭连接。 */
  async enterMaintenance(deadline: number): Promise<void> {
    if (this.maintenance) throw new StorageError('MAINTENANCE', `Database ${this.name} is already in maintenance mode`, { database: this.name });
    this.maintenance = true;
    try {
      while (this.asyncTxActive || this.slot.isHeld || this.slot.pending > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new StorageError('MAINTENANCE_DRAIN_TIMEOUT', `Timed out draining active transactions on ${this.name}`, { database: this.name });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(remaining, 50));
          this.asyncDone.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (this.connection?.open) this.connection.checkpoint('TRUNCATE');
    } catch (error) {
      this.maintenance = false;
      throw error;
    }
    this.connection?.close();
    this.connection = undefined;
  }

  exitMaintenance(): void {
    this.maintenance = false;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.asyncTxActive) this.busy();
    this.connection?.close();
    this.connection = undefined;
    this.closed = true;
  }

  /** 关闭连接但保留句柄（迁移器借用文件期间）；下次访问按句柄 profile 重新打开。 */
  detachConnection(): void {
    if (this.asyncTxActive || this.inTransaction) {
      throw new StorageError('BUSY', `database ${this.name} is in a transaction`, { database: this.name, sqliteCode: 'SQLITE_BUSY' });
    }
    this.connection?.close();
    this.connection = undefined;
  }

  /** 迁移器直接使用连接（不经异步事务检查）。 */
  rawConnection(): MobileConnection {
    return this.conn();
  }
}

/**
 * `openFile` 指向已注册库的文件时返回的句柄：所有操作转给注册句柄，与它共用同一条连接
 * （维护屏障、写者槽与事务状态也共用）。`close()` 只结束本句柄，不关闭共享连接。
 */
export class SharedDatabase implements DatabaseHandle {
  readonly name: string;
  readonly path: string;
  private closed = false;
  private readonly target: () => MobileDatabase;

  constructor(name: string, path: string, target: () => MobileDatabase) {
    this.name = name;
    this.path = path;
    this.target = target;
  }

  private db(): MobileDatabase {
    if (this.closed) throw new StorageError('TX_CLOSED', `Database ${this.name} is closed`, { database: this.name });
    return this.target();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get inTransaction(): boolean {
    if (this.closed) return false;
    try {
      return this.target().inTransaction;
    } catch {
      return false;
    }
  }

  get<R = any>(query: AnyQuery, params?: SqlParams): R {
    return this.db().get<R>(query, params);
  }
  one<R = any>(query: AnyQuery, params?: SqlParams): R {
    return this.db().one<R>(query, params);
  }
  pluck<T>(query: AnyQuery, params?: SqlParams): T | undefined {
    return this.db().pluck<T>(query, params);
  }
  all<R = any>(query: AnyQuery, params?: SqlParams): R[] {
    return this.db().all<R>(query, params);
  }
  iterate<R = any>(query: AnyQuery, params?: SqlParams): IterableIterator<R> {
    return this.db().iterate<R>(query, params);
  }
  run(query: AnyQuery, params?: SqlParams): RunResult {
    return this.db().run(query, params);
  }
  exec(sql: string): void {
    this.db().exec(sql);
  }
  transaction<T>(fn: (tx: SyncTransaction) => T, options?: TransactionOptions): T {
    return this.db().transaction(fn, options);
  }
  write<T>(fn: (tx: SyncTransaction) => T, options?: AsyncTransactionOptions): Promise<T> {
    return this.db().write(fn, options);
  }
  begin(options?: AsyncTransactionOptions): Promise<AsyncTransaction> {
    return this.db().begin(options);
  }
  withTransaction<T>(fn: (tx: AsyncTransaction) => Promise<T>, options?: AsyncTransactionOptions): Promise<T> {
    return this.db().withTransaction(fn, options);
  }
  batch(statements: readonly BatchStatement[]): RunResult[] {
    return this.db().batch(statements);
  }
  checkpoint(mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): readonly [number, number, number] {
    return this.db().checkpoint(mode);
  }
  backupTo(destinationPath: string): Promise<void> {
    return this.db().backupTo(destinationPath);
  }

  close(): void {
    this.closed = true;
  }
}
