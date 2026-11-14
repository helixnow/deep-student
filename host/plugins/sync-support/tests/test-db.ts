/**
 * better-sqlite3 测试适配器（仅测试文件使用）。
 *
 * 与 F3 `SqlExecutor` 的契约保持一致：支持 `?` / `?1` 位置参数与数组绑定，
 * `Query` 的 `safeIntegers` 选项直接透传。原生模块加载失败必须使测试失败；
 * 涉及原生 ABI 的复核请跑 `npm run test:host:electron`。
 */
import { createRequire } from 'node:module';
import type {
  DatabaseHandle,
  Query,
  SqlExecutor,
  SqlParams,
} from '../../../platform/storage/api.ts';

type RawStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  pluck(value: boolean): RawStatement;
  safeIntegers(value: boolean): RawStatement;
};
type RawDatabase = {
  prepare(sql: string): RawStatement;
  exec(sql: string): void;
  close(): void;
};

const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => RawDatabase;

/** `SqlParam` 的 boolean 绑定为 0/1（better-sqlite3 不接受 boolean）。 */
function bindValues(values: readonly unknown[]): unknown[] {
  return values.map(value => (typeof value === 'boolean' ? (value ? 1 : 0) : value));
}

function bindArgs(params: SqlParams | undefined): unknown[] {
  if (params === undefined) return [];
  return bindValues(Array.isArray(params) ? params : [params]);
}

/** 把 `?1 ?2 ?3 ?3` 展开为 better-sqlite3 接受的位置参数。 */
function planSql(sql: string, params: SqlParams | undefined): { sql: string; args: unknown[] } {
  if (!Array.isArray(params)) return { sql, args: bindArgs(params) };
  const matches = [...sql.matchAll(/\?(\d+)/g)];
  if (matches.length === 0) return { sql, args: bindValues(params) };
  const args: unknown[] = [];
  for (const match of matches) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= params.length) throw new RangeError('Missing named parameter');
    args.push(params[index]);
  }
  return { sql: sql.replace(/\?\d+/g, '?'), args: bindValues(args) };
}

export interface TestDatabase extends DatabaseHandle {
  raw: RawDatabase;
}

export function openTestDatabase(path = ':memory:'): TestDatabase {
  const raw = new Database(path);
  const prepare = (
    query: Query<any, any> | string,
    params: SqlParams | undefined,
  ): { stmt: RawStatement; args: unknown[] } => {
    const sql = typeof query === 'string' ? query : query.sql;
    const plan = planSql(sql, params);
    const stmt = raw.prepare(plan.sql);
    if (typeof query !== 'string' && query.options?.safeIntegers === true) stmt.safeIntegers(true);
    return { stmt, args: plan.args };
  };

  const executor: SqlExecutor = {
    get(query: any, ...args: any[]): any {
      const params = args.length > 0 && args[0] !== undefined ? args[0] as SqlParams : undefined;
      const { stmt, args: bound } = prepare(query, params);
      return stmt.get(...bound);
    },
    one(query: any, ...args: any[]): any {
      const row = this.get(query, ...args);
      if (row === undefined) throw new Error('Query returned no rows');
      return row;
    },
    pluck(query: any, ...args: any[]): any {
      const params = args.length > 0 && args[0] !== undefined ? args[0] as SqlParams : undefined;
      const { stmt, args: bound } = prepare(query, params);
      return stmt.pluck(true).get(...bound);
    },
    all(query: any, ...args: any[]): any[] {
      const params = args.length > 0 && args[0] !== undefined ? args[0] as SqlParams : undefined;
      const { stmt, args: bound } = prepare(query, params);
      return stmt.all(...bound);
    },
    iterate(query: any, ...args: any[]): IterableIterator<any> {
      const params = args.length > 0 && args[0] !== undefined ? args[0] as SqlParams : undefined;
      const { stmt, args: bound } = prepare(query, params);
      return stmt.iterate(...bound);
    },
    run(query: any, ...args: any[]): any {
      const params = args.length > 0 && args[0] !== undefined ? args[0] as SqlParams : undefined;
      const { stmt, args: bound } = prepare(query, params);
      return stmt.run(...bound);
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
  };

  const runTransaction = <T>(fn: (tx: SqlExecutor) => T, options?: { behavior?: string }): T => {
    raw.exec(`BEGIN ${options?.behavior === 'immediate' ? 'IMMEDIATE' : ''}`);
    try {
      const value = fn(executor);
      raw.exec('COMMIT');
      return value;
    } catch (error) {
      raw.exec('ROLLBACK');
      throw error;
    }
  };

  const handle: TestDatabase = {
    ...executor,
    name: 'test',
    path,
    raw,
    transaction<T>(fn: (tx: SqlExecutor) => T, options?: { behavior?: string }): T {
      return runTransaction(fn, options);
    },
    async write<T>(fn: (tx: SqlExecutor) => T): Promise<T> {
      return runTransaction(fn, { behavior: 'immediate' });
    },
    async begin(): Promise<any> {
      throw new Error('begin not implemented in test adapter');
    },
    async withTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      throw new Error('withTransaction not implemented in test adapter');
    },
    batch(): any[] {
      throw new Error('batch not implemented in test adapter');
    },
    checkpoint(): readonly [number, number, number] {
      return [0, 0, 0];
    },
    async backupTo(): Promise<void> {
      throw new Error('backupTo not implemented in test adapter');
    },
  } as unknown as TestDatabase;
  return handle;
}
