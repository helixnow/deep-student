/**
 * 单条 better-sqlite3 连接的封装：打开 + PRAGMA、语句缓存、参数转换、错误转换、事务原语。
 * 只在 host/platform/storage 内部使用；业务插件看到的是 api.ts 的接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  StorageError,
  type ConnectionProfile,
  type Query,
  type QueryOptions,
  type RunResult,
  type SqlParams,
  type SqlPhase,
  type SqlValue,
  type TransactionBehavior,
} from './api.ts';
import { bindArgs, planParams, type ParamPlan } from './params.ts';
import type { NativeSqliteBusy, SqliteBusyHandler } from '../native/api.ts';

export type RawDatabase = BetterSqlite3.Database;

/** Driver-level objects that must never be posted across a worker boundary. */
export function isDriverObject(value: unknown): boolean {
  return value instanceof Connection || value instanceof BetterSqlite3;
}
type RawStatement = BetterSqlite3.Statement<unknown[], unknown>;

/** 语句缓存上限；超过后按最久未用淘汰（rusqlite `prepare_cached` 也是 LRU）。 */
const STATEMENT_CACHE_CAPACITY = 256;

interface CachedStatement {
  stmt: RawStatement;
  plan: ParamPlan;
}

/**
 * 把驱动错误包装成 {@link StorageError}；`phase` 在物理分层处传入，不在错误文案上做解析。
 * 已是 `StorageError` 的（如 `bindArgs` 的参数校验）补阶段后返回，保留原 code/sqliteCode。
 */
export function toStorageError(error: unknown, database: string, phase?: SqlPhase): unknown {
  if (error instanceof StorageError) {
    if (phase === undefined || error.phase !== undefined) return error;
    return new StorageError(error.code, error.message, {
      sqliteCode: error.sqliteCode,
      database: error.database ?? database,
      cause: error.cause ?? error,
      phase,
    });
  }
  if (error instanceof BetterSqlite3.SqliteError) {
    return new StorageError('SQLITE', error.message, {
      sqliteCode: error.code,
      database,
      cause: error,
      phase,
    });
  }
  return error;
}

/** 按 profile 顺序执行 PRAGMA（与 Rust `with_init` 中 `pragma_update` 顺序一致）。 */
export function applyProfile(db: RawDatabase, profile: ConnectionProfile): void {
  if (profile.foreignKeys !== undefined) db.pragma(`foreign_keys = ${profile.foreignKeys ? 'ON' : 'OFF'}`);
  if (profile.journalMode !== undefined) db.pragma(`journal_mode = ${profile.journalMode}`);
  if (profile.synchronous !== undefined) db.pragma(`synchronous = ${profile.synchronous}`);
  if (profile.busyTimeoutMs !== undefined) db.pragma(`busy_timeout = ${profile.busyTimeoutMs}`);
  if (profile.autoVacuum !== undefined) db.pragma(`auto_vacuum = ${profile.autoVacuum}`);
}

export interface OpenConnectionOptions {
  readonly label: string;
  readonly profile: ConnectionProfile;
  readonly mustExist?: boolean;
  /** 默认 true（递归 mkdir）；false 时父目录必须已存在，但库文件可按 SQLite 语义创建。 */
  readonly createParentDirs?: boolean;
  /** 可选 F7 provider；仅 setBusyHandler 需要，普通开库不依赖 native 服务。 */
  readonly nativeSqliteBusy?: NativeSqliteBusy;
}

export class Connection {
  readonly raw: RawDatabase;
  readonly label: string;
  readonly path: string;
  private readonly cache = new Map<string, CachedStatement>();
  private readonly busy: NativeSqliteBusy | undefined;

  constructor(filePath: string, options: OpenConnectionOptions) {
    this.label = options.label;
    this.path = filePath;
    this.busy = options.nativeSqliteBusy;
    if (options.createParentDirs !== false
      && filePath !== ':memory:'
      && options.mustExist !== true
      && options.profile.readonly !== true) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    let opened: RawDatabase | undefined;
    try {
      this.raw = opened = new BetterSqlite3(filePath, {
        readonly: options.profile.readonly === true,
        fileMustExist: options.mustExist === true || options.profile.readonly === true,
        // rusqlite `Connection::open` 默认 busy_timeout=5000；profile 可覆盖。
        timeout: 5000,
      });
      // better-sqlite3 默认开启 SQLITE_DBCONFIG_DEFENSIVE（拒绝 writable_schema、直写 FTS 影子表等），
      // rusqlite 不开启；关闭以保持与 Rust 相同的 SQL 语义。
      this.raw.unsafeMode(true);
      applyProfile(this.raw, options.profile);
    } catch (error) {
      // A profile PRAGMA can fail after open (e.g. corrupt export source). Rust drops
      // that Connection on Err; do not leave its descriptor behind on this path.
      if (opened?.open) opened.close();
      if (error instanceof BetterSqlite3.SqliteError) {
        throw toStorageError(error, options.label, 'execute');
      }
      // better-sqlite3 对“父目录不存在”抛 TypeError，而 rusqlite/SQLite 返回
      // SqliteFailure(CannotOpen)。openFile 的契约是 StorageError，这里统一成
      // SQLITE_CANTOPEN，让调用方（L03）按 SQLite 打开失败处理而不是看到驱动内部类型。
      throw new StorageError('SQLITE', error instanceof Error ? error.message : String(error), {
        sqliteCode: 'SQLITE_CANTOPEN',
        database: options.label,
        cause: error,
        phase: 'execute',
      });
    }
  }

  get open(): boolean {
    return this.raw.open;
  }

  get inTransaction(): boolean {
    return this.raw.inTransaction;
  }

  close(): void {
    this.cache.clear();
    if (this.raw.open) this.raw.close();
  }

  private statement(sql: string): CachedStatement {
    const hit = this.cache.get(sql);
    if (hit !== undefined) {
      this.cache.delete(sql);
      this.cache.set(sql, hit);
      return hit;
    }
    let stmt: RawStatement;
    try {
      stmt = this.raw.prepare(sql);
    } catch (error) {
      throw toStorageError(error, this.label, 'prepare');
    }
    const entry: CachedStatement = { stmt, plan: planParams(sql) };
    this.cache.set(sql, entry);
    if (this.cache.size > STATEMENT_CACHE_CAPACITY) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return entry;
  }

  /** 语句是否只读（`sqlite3_stmt_readonly`），用于写者槽占用时的非阻塞拒绝。 */
  isReadonly(query: Query<any, any> | string): boolean {
    return this.statement(typeof query === 'string' ? query : query.sql).stmt.readonly;
  }

  private prepared(query: Query<any, any> | string, mode: 'rows' | 'pluck'): { stmt: RawStatement; plan: ParamPlan } {
    const sql = typeof query === 'string' ? query : query.sql;
    const options: QueryOptions | undefined = typeof query === 'string' ? undefined : query.options;
    const entry = this.statement(sql);
    try {
      if (entry.stmt.reader) {
        entry.stmt.safeIntegers(options?.safeIntegers === true);
        entry.stmt.pluck(mode === 'pluck');
      }
    } catch (error) {
      throw toStorageError(error, this.label, 'bind');
    }
    return entry;
  }

  get<R>(query: Query<any, any> | string, params?: SqlParams): R | undefined {
    const { stmt, plan } = this.prepared(query, 'rows');
    const args = this.bind(plan, params);
    try {
      return stmt.get(...args) as R | undefined;
    } catch (error) {
      throw toStorageError(error, this.label, 'execute');
    }
  }

  pluck<T>(query: Query<any, any> | string, params?: SqlParams): T | undefined {
    const { stmt, plan } = this.prepared(query, 'pluck');
    const args = this.bind(plan, params);
    try {
      return stmt.get(...args) as T | undefined;
    } catch (error) {
      throw toStorageError(error, this.label, 'execute');
    }
  }

  all<R>(query: Query<any, any> | string, params?: SqlParams): R[] {
    const { stmt, plan } = this.prepared(query, 'rows');
    const args = this.bind(plan, params);
    try {
      return stmt.all(...args) as R[];
    } catch (error) {
      throw toStorageError(error, this.label, 'execute');
    }
  }

  *iterate<R>(query: Query<any, any> | string, params?: SqlParams): IterableIterator<R> {
    const { stmt, plan } = this.prepared(query, 'rows');
    const args = this.bind(plan, params);
    let iterator: IterableIterator<unknown>;
    try {
      iterator = stmt.iterate(...args);
    } catch (error) {
      throw toStorageError(error, this.label, 'execute');
    }
    try {
      while (true) {
        let next: IteratorResult<unknown>;
        try {
          next = iterator.next();
        } catch (error) {
          throw toStorageError(error, this.label, 'execute');
        }
        if (next.done === true) return;
        yield next.value as R;
      }
    } finally {
      // 提前放弃迭代时复位语句，否则连接保持 busy。
      iterator.return?.();
    }
  }

  run(query: Query<any, any> | string, params?: SqlParams): RunResult {
    const { stmt, plan } = this.prepared(query, 'rows');
    const args = this.bind(plan, params);
    try {
      // 只为拿到精确的 rowid；读语句下次使用前 prepared() 会按查询选项重设。
      stmt.safeIntegers(true);
      const result = stmt.run(...args);
      const rowid = BigInt(result.lastInsertRowid);
      const safe = rowid >= BigInt(Number.MIN_SAFE_INTEGER) && rowid <= BigInt(Number.MAX_SAFE_INTEGER);
      return { changes: result.changes, lastInsertRowid: safe ? Number(rowid) : rowid };
    } catch (error) {
      throw toStorageError(error, this.label, 'execute');
    }
  }

  /** 参数绑定校验失败统一标 `phase: 'bind'`（不解析错误文案）。 */
  private bind(plan: ParamPlan, params: SqlParams | undefined): unknown[] {
    try {
      return bindArgs(plan, params);
    } catch (error) {
      throw toStorageError(error, this.label, 'bind');
    }
  }

  /** = rusqlite `execute_batch`（sqlite3_exec 语义）。 */
  exec(sql: string): void {
    try {
      this.raw.exec(sql);
    } catch (error) {
      throw toStorageError(error, this.label, 'execute');
    }
  }

  pragmaValue(pragma: string): SqlValue {
    try {
      return this.raw.pragma(pragma, { simple: true }) as SqlValue;
    } catch (error) {
      throw toStorageError(error, this.label, 'execute');
    }
  }

  begin(behavior: TransactionBehavior): void {
    this.exec(`BEGIN ${behavior.toUpperCase()}`);
  }

  commit(): void {
    this.exec('COMMIT');
  }

  /** 回滚；SQLite 已自动回滚（`inTransaction` 为 false）时不再发 ROLLBACK。 */
  rollback(): void {
    if (this.raw.open && this.raw.inTransaction) this.exec('ROLLBACK');
  }

  /**
   * = rusqlite `Connection::busy_handler`：经 F7 `nativeSqliteBusy` 在本连接的同一个
   * `sqlite3*` 上安装/移除 `sqlite3_busy_handler`。语义（null、后续 busy_timeout 覆盖、
   * 抛错即 false、close 释放）完全由 F7 决定，这里不重试、不计时。
   */
  setBusyHandler(handler: SqliteBusyHandler | null): void {
    if (this.busy === undefined) {
      throw new StorageError('INVALID_PARAM', 'setBusyHandler requires the nativeSqliteBusy open option', {
        database: this.label,
      });
    }
    try {
      this.busy.setBusyHandler(this.raw, handler);
    } catch (error) {
      throw toStorageError(error, this.label);
    }
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): readonly [number, number, number] {
    try {
      const row = this.raw.prepare(`PRAGMA wal_checkpoint(${mode})`).raw(true).get() as [number, number, number];
      return [row[0], row[1], row[2]];
    } catch (error) {
      throw toStorageError(error, this.label, 'execute');
    }
  }

  async backupTo(destination: string): Promise<void> {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
      await this.raw.backup(destination);
    } catch (error) {
      throw toStorageError(error, this.label, 'execute');
    }
  }
}
