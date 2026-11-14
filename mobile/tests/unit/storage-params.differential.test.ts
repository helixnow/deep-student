/**
 * 参数绑定：同一组 SQL + 参数在桌面 `Connection`（better-sqlite3 + `bindArgs`）与移动端 `MobileConnection`
 * （SQLite WASM 按参数索引 `bind`）上执行，返回值或 StorageError（code / phase / database / message）逐条相等。
 * 两边的个数 / 类型校验共用 `host/platform/storage/params.ts` 的 `forEachBinding`。
 * 整数的存储类（V06-L5：桌面按 REAL 绑定）在 W07 的修复进 INT 前不在这里比较。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlParams } from '../../../host/platform/storage/api.ts';
import { Connection } from '../../../host/platform/storage/connection.ts';
import { PROFILES } from '../../../host/platform/storage/profiles.ts';
import type { MobileConnection } from '../../../host/platform/storage-mobile/connection.ts';
import { errorShape, mobileConnection, nodeSqlite } from './support/sqlite-node.ts';

type Sqlite = Awaited<ReturnType<typeof nodeSqlite>>;
type AnyConnection = Pick<Connection | MobileConnection, 'run' | 'get'>;

let sqlite3: Sqlite;
let dir: string;

beforeAll(async () => {
  sqlite3 = await nodeSqlite();
  dir = mkdtempSync(join(tmpdir(), 'w31-params-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LABEL = 'params';
const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5]);

interface BindCase {
  readonly name: string;
  readonly run: (conn: AnyConnection) => unknown;
}

const get = (sql: string, params?: SqlParams) => (conn: AnyConnection) => conn.get(sql, params);

const CASES: readonly BindCase[] = [
  { name: '?NNN binds by parameter index', run: get('SELECT ?2 AS a, ?1 AS b', ['x', 'y']) },
  { name: 'a repeated named parameter takes one slot', run: get('SELECT :a AS a, ? AS b, :a AS c', ['named', 'anonymous']) },
  { name: 'a record binds :, @ and $ names', run: get('SELECT :a AS a, @b AS b, $c AS c', { a: 'one', b: 'two', c: null }) },
  { name: 'booleans bind as 1 / 0', run: get('SELECT ? AS t, ? AS f', [true, false]) },
  { name: 'bigint beyond 2^53 round-trips with safeIntegers', run: c => c.get({ sql: 'SELECT ? AS v', options: { safeIntegers: true } }, [2n ** 60n + 1n]) },
  { name: 'a Uint8Array view binds exactly its range', run: get('SELECT hex(?) AS h, length(?) AS n', [BYTES.subarray(2, 5), BYTES.subarray(1)]) },
  { name: 'markers in strings, quoted identifiers and comments are not parameters', run: get(`SELECT '?1 :a' AS "q?", ? AS v -- ?\n/* :b */`, [7]) },
  { name: 'too few positional values', run: get('SELECT ?1, ?2', [1]) },
  { name: 'too many positional values', run: get('SELECT ?', [1, 2]) },
  { name: 'no values for a parameterised statement', run: get('SELECT ?') },
  { name: 'a record for an anonymous ?', run: get('SELECT ?', { a: 1 }) },
  { name: 'a record without the named value', run: get('SELECT :a, :b', { a: 1 }) },
  { name: 'an undefined positional value', run: get('SELECT ?, ?', [1, undefined as never]) },
  { name: 'an unsupported value type', run: get('SELECT ?', [{} as never]) },
  { name: 'run() validates the same way', run: c => c.run('SELECT ?', []) },
];

function outcome(run: () => unknown): unknown {
  try {
    return { ok: run() };
  } catch (error) {
    return { err: errorShape(error) };
  }
}

describe('parameter binding matches the desktop driver', () => {
  it.each(CASES)('$name', ({ run }) => {
    const d = new Connection(join(dir, 'desktop.db'), { label: LABEL, profile: PROFILES.plain });
    const m = mobileConnection(sqlite3, '/w31-params.db', LABEL, PROFILES.plain);
    try {
      const desktop = outcome(() => run(d));
      expect(outcome(() => run(m))).toEqual(desktop);
    } finally {
      d.close();
      m.close();
    }
  });

  it('the error cases are INVALID_PARAM in the bind phase with the rusqlite-style messages', () => {
    const m = mobileConnection(sqlite3, '/w31-params-errors.db', LABEL, PROFILES.plain);
    try {
      const shapes = CASES.slice(7).map(({ run }) => outcome(() => run(m)) as { err?: { code: string; phase: string; message: string } });
      expect(shapes.map(shape => [shape.err?.code, shape.err?.phase])).toEqual(Array(shapes.length).fill(['INVALID_PARAM', 'bind']));
      expect(shapes.map(shape => shape.err?.message)).toEqual([
        'Wrong number of parameters passed to query. Got 1, needed 2',
        'Wrong number of parameters passed to query. Got 2, needed 1',
        'Wrong number of parameters passed to query. Got 0, needed 1',
        'Anonymous "?" parameters require an array of values',
        'SQL parameter "b" is undefined',
        'SQL parameter #2 is undefined',
        'SQL parameter #1 has unsupported type object',
        'Wrong number of parameters passed to query. Got 0, needed 1',
      ]);
    } finally {
      m.close();
    }
  });
});
