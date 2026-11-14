/**
 * 移动端外壳的 SQLite 绑定：初始化 SQLite WASM、安装 OPFS `opfs-sahpool` VFS，并把
 * `resources/app/migrations/` 的 SQL 原文（`?raw`，不做任何改写）交给 Host 的存储插件。
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqliteRuntime } from '../../../host/platform/storage-mobile/index.ts';
import type { CoordinatedDatabaseName } from '../../../host/platform/storage/api.ts';
import { StorageError } from '../../../host/platform/storage/errors.ts';
import { MEMORY_DATABASE } from '../../../host/platform/storage-mobile/connection.ts';
export { isLostBackingTransactionError, runWithTransactionRecovery } from './transaction-recovery.ts';

const SQL_FILES = import.meta.glob<string>('../../../resources/app/migrations/{vfs,chat_v2,mistakes,llm_usage}/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function groupMigrations(): Record<CoordinatedDatabaseName, Record<string, string>> {
  const out: Record<CoordinatedDatabaseName, Record<string, string>> = { vfs: {}, chat_v2: {}, mistakes: {}, llm_usage: {} };
  for (const [path, sql] of Object.entries(SQL_FILES)) {
    const [database, file] = path.split('/').slice(-2) as [CoordinatedDatabaseName, string];
    out[database][file] = sql;
  }
  return out;
}

export interface SqliteRuntimeTimings {
  readonly wasmInitMs: number;
  readonly poolInstallMs: number;
  /** 安装 pool 的尝试次数（1 = 一次成功）。 */
  readonly poolAttempts: number;
  /** 重试用尽后 pool 仍被占用时的原始错误；此时库全部按“被锁定”打开失败。 */
  readonly poolError: string | null;
}

/** OPFS 中的 pool 目录；同一来源下只能被一个 Worker 持有（S2）。 */
export const POOL_DIRECTORY = '.deep-student';
const POOL_CAPACITY = 32;

/**
 * pool 被占用时的重试间隔：共 7 次重试、累计等待 9.5 秒。
 * 依据：S2 spike 中前一个 Worker 释放同步访问句柄后，新 Worker 在 10 秒轮询窗口内能装上 pool
 * （mobile/tests/storage-spike.spec.ts 的 S2 用例）；V06-07 建议总时长 10–15 秒。
 */
export const POOL_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 800, 1600, 3200, 3200];

/** `createSyncAccessHandle()` 因句柄被占用而失败时的 DOMException 名（Chromium / WebKit）。 */
const POOL_BUSY_ERRORS: ReadonlySet<string> = new Set(['NoModificationAllowedError', 'InvalidStateError']);

export function isPoolBusy(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return typeof name === 'string' && POOL_BUSY_ERRORS.has(name);
}

/** 重试用尽后 pool 仍被占用。 */
export class PoolBusyError extends Error {
  readonly attempts: number;
  constructor(attempts: number, cause: unknown) {
    super(`OPFS pool ${POOL_DIRECTORY} is still held by another worker after ${attempts} attempts: ${describe(cause)}`, { cause });
    this.name = 'PoolBusyError';
    this.attempts = attempts;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 只对“被占用”重试；其他安装错误立即抛出。 */
export async function installWithRetry<T>(
  install: (attempt: number) => Promise<T>,
  options: { delays?: readonly number[]; wait?: (ms: number) => Promise<void> } = {},
): Promise<{ value: T; attempts: number }> {
  const delays = options.delays ?? POOL_RETRY_DELAYS_MS;
  const wait = options.wait ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await install(attempt), attempts: attempt };
    } catch (error) {
      if (!isPoolBusy(error)) throw error;
      const delay = delays[attempt - 1];
      if (delay === undefined) throw new PoolBusyError(attempt, error);
      await wait(delay);
    }
  }
}

/**
 * pool 拿不到时交给存储插件的运行时：每次开库都按桌面“库被另一进程锁住”的错误失败
 * （better-sqlite3 打开超时后的 `SQLITE_BUSY: database is locked`）。存储插件因此把核心库记为迁移失败、
 * 进入核心恢复屏障，Host 照常就绪，原因经迁移状态事件与 MAINTENANCE 错误给到前端；重新加载即重试。
 */
export function lockedRuntime(sqlite3: SqliteRuntime['sqlite3'], cause: PoolBusyError, migrations: SqliteRuntime['migrations'], openMemory: SqliteRuntime['openMemory']): SqliteRuntime {
  const locked = (path: string) => new StorageError('SQLITE', 'database is locked', { sqliteCode: 'SQLITE_BUSY', database: path, phase: 'execute', cause });
  return {
    sqlite3,
    open: (path) => { throw locked(path); },
    openMemory,
    exists: () => false,
    unlink: () => undefined,
    exportFile: (path) => { throw locked(path); },
    importDb: async (path) => { throw locked(path); },
    migrations,
  };
}

/** oo1 `Stmt.step()` 失败时抛错前经 `config.warn` 输出的第一个参数；后面跟着 SQL 原文。 */
const STEP_FAILURE_WARNING = 'sqlite3_step() rc=';

/**
 * 交给 sqlite-wasm 的 `config.warn`：丢掉 step 失败那一行（错误本身已作为 StorageError 交给调用方，
 * 桌面 better-sqlite3 也不输出失败的 SQL），其余照常输出。
 */
export function sqliteWarn(...args: unknown[]): void {
  if (args[0] === STEP_FAILURE_WARNING) return;
  console.warn(...args);
}

type SqliteModuleWithPool = Awaited<ReturnType<typeof sqlite3InitModule>>;

export interface SqliteRuntimeDeps {
  readonly init?: () => Promise<SqliteModuleWithPool>;
  readonly wait?: (ms: number) => Promise<void>;
}

export async function createSqliteRuntime(deps: SqliteRuntimeDeps = {}): Promise<{ runtime: SqliteRuntime; timings: SqliteRuntimeTimings }> {
  const t0 = performance.now();
  // 库配置只能在初始化前经 globalThis.sqlite3ApiConfig 给出；初始化完成后库自己删掉它。
  const scope = globalThis as { sqlite3ApiConfig?: { warn: typeof sqliteWarn } };
  scope.sqlite3ApiConfig = { warn: sqliteWarn };
  let sqlite3: SqliteModuleWithPool;
  try {
    sqlite3 = await (deps.init ?? sqlite3InitModule)();
  } finally {
    delete scope.sqlite3ApiConfig;
  }
  const t1 = performance.now();
  const migrations = groupMigrations();
  const openMemory = () => new sqlite3.oo1.DB(MEMORY_DATABASE, 'c');
  let installed;
  try {
    // 每个库 = 主文件 + -wal（+ VACUUM INTO 目标）。扩容是异步的而开库是同步的，所以启动时一次预留。
    // 失败的安装 Promise 会被 sqlite-wasm 缓存，重试必须带 forceReinitIfPreviouslyFailed。
    installed = await installWithRetry(async (attempt) => {
      // 3.53.4 的类型声明漏了 forceReinitIfPreviouslyFailed（运行时支持，见 dist/index.mjs 的 installOpfsSAHPoolVfs）。
      const options: Parameters<typeof sqlite3.installOpfsSAHPoolVfs>[0] & { forceReinitIfPreviouslyFailed: boolean } = {
        name: 'dstu-opfs',
        directory: POOL_DIRECTORY,
        initialCapacity: POOL_CAPACITY,
        forceReinitIfPreviouslyFailed: attempt > 1,
      };
      const pool = await sqlite3.installOpfsSAHPoolVfs(options);
      await pool.reserveMinimumCapacity(POOL_CAPACITY);
      return pool;
    }, deps.wait ? { wait: deps.wait } : {});
  } catch (error) {
    if (!(error instanceof PoolBusyError)) throw error;
    const timings = { wasmInitMs: t1 - t0, poolInstallMs: performance.now() - t1, poolAttempts: error.attempts, poolError: error.message };
    return { runtime: lockedRuntime(sqlite3, error, migrations, openMemory), timings };
  }
  const pool = installed.value;
  const t2 = performance.now();
  const runtime: SqliteRuntime = {
    sqlite3,
    open: path => new pool.OpfsSAHPoolDb(path),
    openMemory,
    exists: path => pool.getFileNames().includes(path),
    unlink: (path) => { pool.unlink(path); },
    exportFile: path => pool.exportFile(path),
    importDb: (path, bytes) => pool.importDb(path, bytes),
    migrations,
  };
  return { runtime, timings: { wasmInitMs: t1 - t0, poolInstallMs: t2 - t1, poolAttempts: installed.attempts, poolError: null } };
}
