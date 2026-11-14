/**
 * V06-01 附带问题：sqlite-wasm 的 oo1 `Stmt.step()` 失败时先经 `config.warn` 往 console 打
 * `sqlite3_step() rc= … SQL = <原文>` 再抛错。移动端运行时只丢掉这一行（错误已经是 StorageError），其余警告照常输出。
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from '../../../host/platform/storage/errors.ts';
import { MobileConnection } from '../../../host/platform/storage-mobile/connection.ts';
import type { SqliteDatabase, SqliteModule } from '../../../host/platform/storage-mobile/sqlite-wasm.ts';
import { createSqliteRuntime } from '../../src/worker/sqlite-runtime.ts';

type NodeSqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;

/** Node 版 sqlite-wasm，opfs-sahpool 换成内存文件系统上的同形实现。 */
async function nodeModuleWithPool(): Promise<NodeSqlite> {
  const init = sqlite3InitModule as unknown as (options: { print(): void; printErr(): void }) => Promise<NodeSqlite>;
  const sqlite3 = await init({ print: () => undefined, printErr: () => undefined });
  class OpfsSAHPoolDb extends sqlite3.oo1.DB {
    constructor(path: string) {
      super(path.replaceAll('/', '_'), 'c');
    }
  }
  return Object.assign(sqlite3, {
    installOpfsSAHPoolVfs: async () => ({ OpfsSAHPoolDb, getFileNames: () => [], unlink: () => true, exportFile: () => new Uint8Array(), reserveMinimumCapacity: async () => 0 }),
  }) as unknown as NodeSqlite;
}

afterEach(() => vi.restoreAllMocks());

describe('sqlite-wasm warnings in the mobile runtime', () => {
  it('a failing statement does not print its SQL; other warnings still reach the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runtime } = await createSqliteRuntime({ init: nodeModuleWithPool });
    expect((globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig).toBeUndefined();

    const file = `/w31-warn-${process.pid}.db`;
    const conn = new MobileConnection(runtime.sqlite3, runtime.open(file) as unknown as SqliteDatabase, file, { label: 'warn', profile: {} });
    conn.exec("CREATE TABLE u(a TEXT UNIQUE); INSERT INTO u VALUES ('secret-value')");
    let error: unknown;
    try {
      conn.run("INSERT INTO u VALUES ('secret-value')", []);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).sqliteCode).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(warn.mock.calls.filter(args => String(args[0]).startsWith('sqlite3_step()'))).toEqual([]);

    (runtime.sqlite3 as unknown as SqliteModule & { config: { warn(...args: unknown[]): void } }).config.warn('Ignoring inability to install the', 'x', 'sqlite3_vfs');
    expect(warn).toHaveBeenCalledWith('Ignoring inability to install the', 'x', 'sqlite3_vfs');
    conn.close();
  });
});
