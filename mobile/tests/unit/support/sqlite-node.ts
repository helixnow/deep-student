/**
 * Node 中的 SQLite WASM（`@sqlite.org/sqlite-wasm` 的 node 构建，与移动端同一版本同一份 wasm）：
 * 构造真实的 `MobileConnection` / `MobileStorageService`，与桌面 better-sqlite3 实现做差分。
 *
 * Node 构建没有 OPFS；库文件放在 Emscripten 内存文件系统的根目录（不建子目录，路径里的 `/` 换成 `_`）。
 * 默认 VFS `unix-none` 不加锁；需要真实锁冲突（BUSY）时用 `unix`。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { ConnectionProfile, CoordinatedDatabaseName } from '../../../../host/platform/storage/api.ts';
import { StorageError } from '../../../../host/platform/storage/errors.ts';
import { MobileConnection } from '../../../../host/platform/storage-mobile/connection.ts';
import type { SqliteDatabase, SqliteModule, SqliteRuntime } from '../../../../host/platform/storage-mobile/sqlite-wasm.ts';

export const REPO = join(import.meta.dirname, '../../../..');

type NodeSqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;

let module: Promise<NodeSqlite> | undefined;

/** 每个测试文件（fork）一份模块实例。 */
export function nodeSqlite(): Promise<NodeSqlite> {
  const init = sqlite3InitModule as unknown as (options: { print(): void; printErr(): void }) => Promise<NodeSqlite>;
  module ??= init({ print: () => undefined, printErr: () => undefined });
  return module;
}

export function asModule(sqlite3: NodeSqlite): SqliteModule {
  return sqlite3 as unknown as SqliteModule;
}

let counter = 0;

/** 内存文件系统中的唯一库文件名。 */
export function uniqueFile(label: string): string {
  return `/w31-${label}-${process.pid}-${++counter}.db`;
}

export function openRaw(sqlite3: NodeSqlite, file: string, vfs?: string): SqliteDatabase {
  return new sqlite3.oo1.DB({ filename: file, flags: 'c', ...(vfs ? { vfs } : {}) }) as unknown as SqliteDatabase;
}

export function mobileConnection(sqlite3: NodeSqlite, file: string, label: string, profile: ConnectionProfile, vfs?: string): MobileConnection {
  return new MobileConnection(asModule(sqlite3), openRaw(sqlite3, file, vfs), file, { label, profile });
}

/** 核心库迁移 SQL：与 `mobile/src/worker/sqlite-runtime.ts` 打包的文件相同（文件名 → 原文）。 */
export function coreMigrations(): Record<CoordinatedDatabaseName, Record<string, string>> {
  const out = { vfs: {}, chat_v2: {}, mistakes: {}, llm_usage: {} } as Record<CoordinatedDatabaseName, Record<string, string>>;
  for (const db of Object.keys(out) as CoordinatedDatabaseName[]) {
    const dir = join(REPO, 'resources/app/migrations', db);
    for (const name of readdirSync(dir).filter(file => file.endsWith('.sql')).sort()) out[db][name] = readFileSync(join(dir, name), 'utf8');
  }
  return out;
}

export interface NodeRuntime extends SqliteRuntime {
  /** 每次 `open` 的路径（含重复打开）。 */
  readonly opened: string[];
  /** 直接写入 pool 路径上的文件内容（制造损坏的库文件）。 */
  put(path: string, bytes: Uint8Array): void;
}

/** `MobileStorageService` 用的运行时：pool 路径 → 内存文件系统中的扁平文件名。 */
export function nodeRuntime(sqlite3: NodeSqlite, options: { migrations?: SqliteRuntime['migrations']; vfs?: string; prefix?: string } = {}): NodeRuntime {
  const prefix = options.prefix ?? `/rt-${process.pid}-${++counter}`;
  const flat = (path: string) => `${prefix}${path.replaceAll('/', '_')}`;
  const files = new Set<string>();
  const opened: string[] = [];
  return {
    sqlite3: asModule(sqlite3),
    opened,
    open(path) {
      opened.push(path);
      files.add(path);
      return openRaw(sqlite3, flat(path), options.vfs);
    },
    openMemory: () => openRaw(sqlite3, ':memory:'),
    exists: path => files.has(path),
    unlink: (path) => { files.delete(path); },
    put(path, bytes) {
      files.add(path);
      sqlite3.capi.sqlite3_js_posix_create_file(flat(path), bytes);
    },
    exportFile: () => { throw new Error('exportFile is not used by these tests'); },
    migrations: options.migrations ?? coreMigrations(),
  };
}

export interface ErrorShape {
  readonly storageError: boolean;
  readonly name?: string;
  readonly code?: string;
  readonly sqliteCode?: string;
  readonly phase?: string;
  readonly database?: string;
  readonly message: string;
}

/** 比较用的错误形状：`StorageError` 的结构化字段；不是 `StorageError` 时记下构造器名。 */
export function errorShape(error: unknown): ErrorShape {
  if (error instanceof StorageError) {
    return { storageError: true, code: error.code, sqliteCode: error.sqliteCode, phase: error.phase, database: error.database, message: error.message };
  }
  const e = error as { constructor?: { name?: string }; message?: unknown };
  return { storageError: false, name: e?.constructor?.name, message: String(e?.message ?? error) };
}

export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
