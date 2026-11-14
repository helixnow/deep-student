import { createRequire } from 'node:module';
import type { SqlExecutor } from '../../../platform/storage/api.ts';

interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  run(...params: unknown[]): unknown;
}

interface DatabaseSync {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

type DatabaseSyncConstructor = new (path: string) => DatabaseSync;

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: DatabaseSyncConstructor;
};

/**
 * 测试用 `node:sqlite` → F3 `SqlExecutor` 薄适配器。
 * 生产代码只经 F3 `ctx.storage`；这里仅覆盖 vfs_resolver 用到的查询面。
 */
export interface VfsTestDb {
  db: DatabaseSync;
  executor: SqlExecutor;
  close(): void;
}

export function inMemoryVfsDb(): VfsTestDb {
  const db = new DatabaseSync(':memory:');
  const params = (value: unknown): unknown[] => {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  };
  const executor = {
    get: (sql: string, value?: unknown) => db.prepare(sql).get(...params(value)),
    one: (sql: string, value?: unknown) => {
      const row = db.prepare(sql).get(...params(value));
      if (row === undefined) throw new Error('Query returned no rows');
      return row;
    },
    pluck: (sql: string, value?: unknown) => {
      const row = db.prepare(sql).get(...params(value)) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return Object.values(row)[0];
    },
    all: (sql: string, value?: unknown) => db.prepare(sql).all(...params(value)),
    iterate: (sql: string, value?: unknown) => db.prepare(sql).iterate(...params(value)),
    run: (sql: string, value?: unknown) => db.prepare(sql).run(...params(value)),
    exec: (sql: string) => { db.exec(sql); },
  } as unknown as SqlExecutor;
  return { db, executor, close: () => { db.close(); } };
}
