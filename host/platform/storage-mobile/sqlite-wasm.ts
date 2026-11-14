/**
 * `@sqlite.org/sqlite-wasm` 中移动端存储用到的最小结构类型。
 *
 * 该包只安装在 `mobile/`（依赖隔离），Host 源码不能 import 它；这里按 oo1 / capi 的实际形状
 * 声明结构类型，由移动端外壳把真实模块经 {@link SqliteRuntime} 服务注入。
 */
import type { CoordinatedDatabaseName } from '../storage/api.ts';

export type SqliteBindable = null | number | bigint | string | Uint8Array;

export interface SqliteStatement {
  readonly pointer: number | undefined;
  readonly columnCount: number;
  readonly parameterCount: number;
  bind(index: number, value: SqliteBindable): this;
  clearBindings(): this;
  step(): boolean;
  reset(alsoClearBinds?: boolean): this;
  finalize(): number | undefined;
  getColumnName(index: number): string;
  /** `asType` 为 `capi.SQLITE_*` 列类型常量；BLOB 返回拷贝出的 `Uint8Array`。 */
  get(index: number, asType?: number): unknown;
}

export interface SqliteDatabase {
  /** 关闭后为 `undefined`。 */
  readonly pointer?: number;
  readonly filename: string;
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /** `sqlite3_changes64()`；`sixtyFour` 为 true 时返回 bigint。 */
  changes(total?: boolean, sixtyFour?: boolean): number | bigint;
}

export interface SqliteCapi {
  readonly SQLITE_INTEGER: number;
  readonly SQLITE_FLOAT: number;
  readonly SQLITE_TEXT: number;
  readonly SQLITE_BLOB: number;
  readonly SQLITE_NULL: number;
  sqlite3_libversion(): string;
  sqlite3_column_type(stmt: number, index: number): number;
  sqlite3_column_int64(stmt: number, index: number): bigint;
  sqlite3_stmt_readonly(stmt: number): number;
  sqlite3_get_autocommit(db: number): number;
  sqlite3_last_insert_rowid(db: number): bigint | number;
  sqlite3_errmsg(db: number): string;
  sqlite3_extended_errcode(db: number): number;
  sqlite3_js_rc_str(rc: number): string | undefined;
}

export interface SqliteModule {
  readonly capi: SqliteCapi;
  readonly wasm: { heap8u(): Uint8Array };
}

/** SQLite WASM 抛出的错误（oo1 `SQLite3Error`）的结构。 */
export interface SqliteThrown {
  readonly resultCode?: number;
  readonly message?: string;
}

/**
 * 移动端外壳提供的 SQLite 运行时（服务名 `sqliteRuntime`）：已初始化的 WASM 模块、
 * 打开库文件的方式（OPFS `opfs-sahpool`），以及与桌面字节一致的迁移 SQL。
 */
export interface SqliteRuntime {
  readonly sqlite3: SqliteModule;
  /** 打开（必要时创建）库文件；路径是 OPFS pool 内的绝对虚拟路径。 */
  open(path: string): SqliteDatabase;
  /** 打开一个不占 pool 槽位、不碰 OPFS 的内存库（迁移指纹的 scratch 回放）；pool 被锁住时也可用。 */
  openMemory(): SqliteDatabase;
  /** 文件是否存在于 pool 中。 */
  exists(path: string): boolean;
  /** 删除 pool 中的文件（不存在时为空操作）。 */
  unlink(path: string): void;
  /** 导出整个库文件的字节（`VACUUM INTO` 之后的备份文件下载 / 分享）。 */
  exportFile(path: string): Uint8Array;
  /**
   * 把一个 SQLite 数据库文件的字节写入 pool（覆盖同名文件），返回写入字节数。
   * 数据库连接必须先关闭：sahpool 对已打开文件的导入结果未定义。
   * 用于备份恢复（ZIP 导入）与 0.15.x 原生 Android 数据的首次迁移。
   * 可选：测试宿主的最小运行时不必实现（生产 `mobile/src/worker/sqlite-runtime.ts` 实现）。
   */
  importDb?(path: string, bytes: Uint8Array): Promise<number>;
  /**
   * 迁移 SQL：库名 → 文件名（如 `V20260130__init.sql`）→ 文件内容（UTF-8 原文，不做任何改写）。
   * 与桌面 `resources/app/migrations/<库>/` 一一对应。
   */
  readonly migrations: Readonly<Record<CoordinatedDatabaseName, Readonly<Record<string, string>>>>;
}
