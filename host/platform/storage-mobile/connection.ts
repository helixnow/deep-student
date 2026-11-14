/**
 * 单条 SQLite WASM 连接：打开 + PRAGMA、语句缓存、参数绑定、列值转换、错误转换、事务原语。
 * 对外语义对齐桌面 `host/platform/storage/connection.ts`（better-sqlite3），差异逐条注明。
 *
 * 移动端不变式（`DESIGN.md` S2/S3，Chromium 实测）：
 * - `opfs-sahpool` 的 xLock 不互斥、xCheckReservedLock 恒报“已有保留锁”：同一文件只能有一条连接，
 *   且回滚日志在崩溃后不会被重放（库损坏）。因此每条连接先进入 `locking_mode=EXCLUSIVE`，并一律使用
 *   WAL（EXCLUSIVE 下 WAL 不需要共享内存，崩溃后按提交帧恢复）。
 * - 桌面 better-sqlite3 以 `SQLITE_DEFAULT_FOREIGN_KEYS=1`、`DEFAULT_PAGE_SIZE=4096` 编译，WASM 包分别为
 *   0 / 8192；这里在 profile 之前显式设置，保持外键语义与库文件格式一致。
 */
import type {
  ConnectionProfile,
  Query,
  QueryOptions,
  RunResult,
  SqlParams,
  SqlPhase,
  SqlValue,
  TransactionBehavior,
} from '../storage/api.ts';
import { StorageError } from '../storage/errors.ts';
import { forEachBinding, planParams, type ParamPlan } from '../storage/params.ts';
import type { SqliteDatabase, SqliteModule, SqliteStatement, SqliteThrown } from './sqlite-wasm.ts';

const STATEMENT_CACHE_CAPACITY = 256;
const DESKTOP_PAGE_SIZE = 4096;
export const MEMORY_DATABASE = ':memory:';

interface CachedStatement {
  readonly stmt: SqliteStatement;
  readonly plan: ParamPlan;
  readonly columns: readonly string[];
  readonly readonly: boolean;
  busy: boolean;
}

type AnyQuery = Query<any, any> | string;

function isSqliteThrown(error: unknown): error is SqliteThrown {
  return typeof error === 'object' && error !== null && typeof (error as SqliteThrown).resultCode === 'number';
}

export interface MobileConnectionOptions {
  readonly label: string;
  readonly profile: ConnectionProfile;
  /** `VACUUM INTO` 目标已存在时先删除（桌面在线备份覆盖目标文件）。 */
  readonly unlink?: (path: string) => void;
}

/** 连接打开后实际生效的模式（供启动报告与测试断言）。 */
export interface AppliedPragmas {
  readonly lockingMode: string;
  readonly journalMode: string;
  readonly foreignKeys: number;
  readonly pageSize: number;
}

export class MobileConnection {
  readonly label: string;
  readonly path: string;
  readonly applied: AppliedPragmas;
  private db: SqliteDatabase | undefined;
  private readonly sqlite3: SqliteModule;
  private readonly cache = new Map<string, CachedStatement>();
  private readonly unlink: ((path: string) => void) | undefined;

  constructor(sqlite3: SqliteModule, db: SqliteDatabase, path: string, options: MobileConnectionOptions) {
    this.sqlite3 = sqlite3;
    this.db = db;
    this.path = path;
    this.label = options.label;
    this.unlink = options.unlink;
    try {
      this.applied = this.applyProfile(options.profile);
    } catch (error) {
      this.close();
      throw openFailure(error);
    }
  }

  private applyProfile(profile: ConnectionProfile): AppliedPragmas {
    const lockingMode = String(this.pragmaValue('locking_mode = EXCLUSIVE'));
    // 只对尚未写入任何页的新库生效；已存在的库保持原页大小。
    this.exec(`PRAGMA page_size = ${DESKTOP_PAGE_SIZE}`);
    this.exec(`PRAGMA foreign_keys = ${profile.foreignKeys === false ? 'OFF' : 'ON'}`);
    const journalMode = String(this.pragmaValue('journal_mode = WAL'));
    // 内存库（迁移 scratch）没有文件，SQLite 只给 memory 日志；WAL 不变式针对的是 pool 里会崩溃恢复的库文件。
    if (journalMode !== 'wal' && !(this.path === MEMORY_DATABASE && journalMode === 'memory')) {
      throw new StorageError('SQLITE', `journal_mode=WAL was not accepted (got "${journalMode}")`, { database: this.label, sqliteCode: 'SQLITE_ERROR', phase: 'execute' });
    }
    if (profile.synchronous !== undefined) this.exec(`PRAGMA synchronous = ${profile.synchronous}`);
    if (profile.busyTimeoutMs !== undefined) this.exec(`PRAGMA busy_timeout = ${profile.busyTimeoutMs}`);
    if (profile.autoVacuum !== undefined) this.exec(`PRAGMA auto_vacuum = ${profile.autoVacuum}`);
    return {
      lockingMode,
      journalMode,
      foreignKeys: Number(this.pragmaValue('foreign_keys')),
      pageSize: Number(this.pragmaValue('page_size')),
    };
  }

  get open(): boolean {
    return this.db !== undefined;
  }

  private raw(): SqliteDatabase {
    if (this.db === undefined) throw new StorageError('TX_CLOSED', `Database ${this.label} is closed`, { database: this.label });
    return this.db;
  }

  private pointer(): number {
    const pointer = this.raw().pointer;
    if (pointer === undefined) throw new StorageError('TX_CLOSED', `Database ${this.label} is closed`, { database: this.label });
    return pointer;
  }

  get inTransaction(): boolean {
    return this.db !== undefined && this.sqlite3.capi.sqlite3_get_autocommit(this.pointer()) === 0;
  }

  close(): void {
    for (const entry of this.cache.values()) entry.stmt.finalize();
    this.cache.clear();
    const db = this.db;
    this.db = undefined;
    db?.close();
  }

  /** 驱动错误 → {@link StorageError}：message = `sqlite3_errmsg`，sqliteCode = 扩展码名（与 better-sqlite3 一致）。 */
  private toStorageError(error: unknown, phase: SqlPhase): unknown {
    if (error instanceof StorageError) {
      if (error.phase !== undefined) return error;
      return new StorageError(error.code, error.message, { sqliteCode: error.sqliteCode, database: error.database ?? this.label, cause: error.cause ?? error, phase });
    }
    if (!isSqliteThrown(error) || this.db?.pointer === undefined) return error;
    const { capi } = this.sqlite3;
    const pointer = this.db.pointer;
    const extended = capi.sqlite3_extended_errcode(pointer);
    const code = extended !== 0 ? extended : error.resultCode!;
    return new StorageError('SQLITE', capi.sqlite3_errmsg(pointer), {
      sqliteCode: capi.sqlite3_js_rc_str(code) ?? `SQLITE_UNKNOWN(${code})`,
      database: this.label,
      cause: error,
      phase,
    });
  }

  private statement(sql: string): CachedStatement {
    const hit = this.cache.get(sql);
    if (hit !== undefined && !hit.busy) {
      this.cache.delete(sql);
      this.cache.set(sql, hit);
      return hit;
    }
    let stmt: SqliteStatement;
    try {
      stmt = this.raw().prepare(sql);
    } catch (error) {
      throw this.toStorageError(error, 'prepare');
    }
    const columns = Array.from({ length: stmt.columnCount }, (_, i) => stmt.getColumnName(i));
    const entry: CachedStatement = {
      stmt,
      plan: planParams(sql),
      columns,
      readonly: this.sqlite3.capi.sqlite3_stmt_readonly(stmt.pointer!) !== 0,
      busy: false,
    };
    // 正在被迭代的同文本语句不进缓存（迭代期间再执行同一 SQL 时使用独立语句）。
    if (hit !== undefined) return entry;
    this.cache.set(sql, entry);
    if (this.cache.size > STATEMENT_CACHE_CAPACITY) {
      const oldest = this.cache.entries().next().value;
      if (oldest !== undefined && !oldest[1].busy) {
        this.cache.delete(oldest[0]);
        oldest[1].stmt.finalize();
      }
    }
    return entry;
  }

  isReadonly(query: AnyQuery): boolean {
    return this.statement(typeof query === 'string' ? query : query.sql).readonly;
  }

  /** 个数 / 类型校验与文案和桌面 `bindArgs` 共用 `forEachBinding`；按 SQLite 参数索引直接绑定。 */
  private bind(entry: CachedStatement, params: SqlParams | undefined): void {
    const { plan, stmt } = entry;
    try {
      stmt.clearBindings();
      forEachBinding(plan, params, (slot, value) => stmt.bind(slot.index, value));
    } catch (error) {
      throw this.toStorageError(error, 'bind');
    }
  }

  private column(stmt: SqliteStatement, index: number, safeIntegers: boolean): SqlValue {
    const { capi } = this.sqlite3;
    switch (capi.sqlite3_column_type(stmt.pointer!, index)) {
      case capi.SQLITE_INTEGER: {
        const value = capi.sqlite3_column_int64(stmt.pointer!, index);
        return safeIntegers ? value : Number(value);
      }
      case capi.SQLITE_FLOAT:
        return stmt.get(index, capi.SQLITE_FLOAT) as number;
      case capi.SQLITE_TEXT:
        return stmt.get(index, capi.SQLITE_TEXT) as string;
      case capi.SQLITE_BLOB:
        return (stmt.get(index, capi.SQLITE_BLOB) as Uint8Array | undefined) ?? new Uint8Array(0);
      default:
        return null;
    }
  }

  private row(entry: CachedStatement, options: QueryOptions | undefined): Record<string, SqlValue> {
    const safe = options?.safeIntegers === true;
    const out: Record<string, SqlValue> = {};
    for (let i = 0; i < entry.columns.length; i++) out[entry.columns[i]!] = this.column(entry.stmt, i, safe);
    return out;
  }

  private prepared(query: AnyQuery, params: SqlParams | undefined): { entry: CachedStatement; options: QueryOptions | undefined } {
    const entry = this.statement(typeof query === 'string' ? query : query.sql);
    this.bind(entry, params);
    return { entry, options: typeof query === 'string' ? undefined : query.options };
  }

  /**
   * 失败的 `step()` 之后，oo1 的 `reset()` 会把同一个结果码再抛一次；错误必须先按本次的
   * `sqlite3_extended_errcode` / `sqlite3_errmsg` 包装，再复位语句。复位抛出别的错误时报告那个错误。
   */
  private step(entry: CachedStatement): boolean {
    try {
      return entry.stmt.step();
    } catch (error) {
      const wrapped = this.toStorageError(error, 'execute');
      try {
        entry.stmt.reset();
      } catch (repeat) {
        if (resultCode(repeat) !== resultCode(error)) throw this.toStorageError(repeat, 'execute');
      }
      throw wrapped;
    }
  }

  get<R>(query: AnyQuery, params?: SqlParams): R | undefined {
    const { entry, options } = this.prepared(query, params);
    try {
      return this.step(entry) ? (this.row(entry, options) as R) : undefined;
    } finally {
      entry.stmt.reset();
    }
  }

  pluck<T>(query: AnyQuery, params?: SqlParams): T | undefined {
    const { entry, options } = this.prepared(query, params);
    try {
      if (!this.step(entry)) return undefined;
      if (entry.columns.length === 0) {
        throw new StorageError('INVALID_PARAM', 'The pluck() method is only for statements that return data', { database: this.label, phase: 'execute' });
      }
      return this.column(entry.stmt, 0, options?.safeIntegers === true) as T;
    } finally {
      entry.stmt.reset();
    }
  }

  all<R>(query: AnyQuery, params?: SqlParams): R[] {
    const { entry, options } = this.prepared(query, params);
    const rows: R[] = [];
    try {
      while (this.step(entry)) rows.push(this.row(entry, options) as R);
      return rows;
    } finally {
      entry.stmt.reset();
    }
  }

  *iterate<R>(query: AnyQuery, params?: SqlParams): IterableIterator<R> {
    const { entry, options } = this.prepared(query, params);
    entry.busy = true;
    try {
      while (this.step(entry)) yield this.row(entry, options) as R;
    } finally {
      entry.busy = false;
      entry.stmt.reset();
      if (this.cache.get(typeof query === 'string' ? query : query.sql) !== entry) entry.stmt.finalize();
    }
  }

  run(query: AnyQuery, params?: SqlParams): RunResult {
    const { entry } = this.prepared(query, params);
    try {
      while (this.step(entry)) { /* 与 better-sqlite3 `run` 相同：执行到完成，丢弃结果行 */ }
    } finally {
      entry.stmt.reset();
    }
    const { capi } = this.sqlite3;
    const rowid = BigInt(capi.sqlite3_last_insert_rowid(this.pointer()));
    const changes = Number(this.raw().changes(false, true));
    return { changes, lastInsertRowid: rowid >= BigInt(Number.MIN_SAFE_INTEGER) && rowid <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rowid) : rowid };
  }

  /** = rusqlite `execute_batch`（sqlite3_exec 语义）。 */
  exec(sql: string): void {
    try {
      this.raw().exec(sql);
    } catch (error) {
      throw this.toStorageError(error, 'execute');
    }
  }

  pragmaValue(pragma: string): SqlValue {
    return this.pluck<SqlValue>(`PRAGMA ${pragma}`) ?? null;
  }

  begin(behavior: TransactionBehavior): void {
    this.exec(`BEGIN ${behavior.toUpperCase()}`);
  }

  commit(): void {
    this.exec('COMMIT');
  }

  rollback(): void {
    if (this.open && this.inTransaction) this.exec('ROLLBACK');
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'): readonly [number, number, number] {
    const row = this.get<Record<string, number>>(`PRAGMA wal_checkpoint(${mode})`);
    const values = Object.values(row ?? {}).map(Number);
    return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
  }

  /**
   * 桌面用 SQLite 在线备份 API；WASM 包未导出 `sqlite3_backup_*`，这里用 `VACUUM INTO`
   * 生成一致快照（同样不阻塞其它读，结果是紧凑后的库文件）。
   */
  async backupTo(destination: string): Promise<void> {
    this.unlink?.(destination);
    this.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  }
}

/** 打开时应用 PRAGMA 失败：与桌面 `Connection` 构造函数相同，一律记为 `execute` 阶段。 */
function openFailure(error: unknown): unknown {
  if (!(error instanceof StorageError) || error.phase === 'execute') return error;
  return new StorageError(error.code, error.message, { sqliteCode: error.sqliteCode, database: error.database, cause: error.cause ?? error, phase: 'execute' });
}

function resultCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { resultCode?: unknown }).resultCode : undefined;
}
