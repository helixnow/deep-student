/**
 * 桌面 better-sqlite3 与 rusqlite / 移动端 sqlite-wasm 的整数差异。
 * - 绑定：better-sqlite3 默认把所有 JS number 绑定为 REAL，TEXT 列写出 "5.0"、无类型列和 JSON 函数写出 REAL，
 *   旧版 Rust 按 i64 读取时报 InvalidColumnType，serde 把 `5.0` 解成整数也会失败。
 * - `lastInsertRowid`：超过 2^53 时 better-sqlite3 默认给出丢精度的 number，移动端给 bigint。
 */
import { describe, expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';

const withMemory = (body: (conn: Connection) => void): void => {
  const conn = new Connection(':memory:', { label: 'bind', profile: PROFILES.plain });
  try {
    body(conn);
  } finally {
    conn.close();
  }
};

describe('V06-L5: desktop binds integral JS numbers as INTEGER, like rusqlite i64 / bool', () => {
  it('integers and booleans land as INTEGER in untyped, TEXT and JSON positions', () => {
    withMemory((conn) => {
      conn.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a, b TEXT, c INTEGER, d REAL)');
      conn.run('INSERT INTO t(id, a, b, c, d) VALUES (1, ?, ?, ?, ?)', [5, 5, 5, 5]);
      conn.run('INSERT INTO t(id, a, b, c, d) VALUES (2, :v, :v, :v, :v)', { v: true });
      conn.run('INSERT INTO t(id, a, b, c, d) VALUES (3, ?1, ?1, ?1, ?1)', [-(2 ** 40)]);
      conn.run('INSERT INTO t(id, a, b, c, d) VALUES (4, ?1, ?1, ?1, ?1)', [-0]);
      expect(conn.all('SELECT typeof(a) ta, a, typeof(b) tb, b, typeof(c) tc, typeof(d) td FROM t ORDER BY id')).toEqual([
        { ta: 'integer', a: 5, tb: 'text', b: '5', tc: 'integer', td: 'real' },
        { ta: 'integer', a: 1, tb: 'text', b: '1', tc: 'integer', td: 'real' },
        { ta: 'integer', a: -(2 ** 40), tb: 'text', b: String(-(2 ** 40)), tc: 'integer', td: 'real' },
        { ta: 'integer', a: 0, tb: 'text', b: '0', tc: 'integer', td: 'real' },
      ]);
      expect(conn.pluck(`SELECT json_object('n', ?, 'f', ?, 'ts', ?)`, [5, false, 1_767_225_600_123])).toBe(
        '{"n":5,"f":0,"ts":1767225600123}',
      );
    });
  });

  it('integral parameters match TEXT columns holding the same digits, as with rusqlite', () => {
    withMemory((conn) => {
      conn.exec('CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)');
      conn.run('INSERT INTO kv(k, v) VALUES (?, ?)', ['n', '42']);
      expect(conn.pluck('SELECT k FROM kv WHERE v = ?', [42])).toBe('n');
    });
  });

  it('fractional, non-finite, beyond-int64 numbers and bigint keep their existing binding', () => {
    withMemory((conn) => {
      expect(conn.get('SELECT typeof(?) t, ? v', [5.5, 5.5])).toEqual({ t: 'real', v: 5.5 });
      expect(conn.get('SELECT typeof(?1) t, ?1 || \'\' s', [2 ** 63])).toEqual({ t: 'real', s: '9.2233720368547758e+18' });
      expect(conn.get('SELECT typeof(?1) t, ?1 || \'\' s', [Number.POSITIVE_INFINITY])).toEqual({ t: 'real', s: 'Inf' });
      expect(conn.get('SELECT typeof(?1) t, ?1 v', [-(2 ** 63)])).toEqual({ t: 'integer', v: -(2 ** 63) });
      expect(conn.get('SELECT typeof(?1) t, ?1 || \'\' s', [9_007_199_254_740_993n])).toEqual({ t: 'integer', s: '9007199254740993' });
    });
  });
});

describe('V06-L6: lastInsertRowid is exact, number within 2^53 and bigint beyond (same as mobile)', () => {
  it('plain inserts, RETURNING statements and huge explicit rowids', () => {
    withMemory((conn) => {
      conn.exec('CREATE TABLE r(id INTEGER PRIMARY KEY, v TEXT)');
      expect(conn.run('INSERT INTO r(v) VALUES (?)', ['a'])).toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(conn.run('INSERT INTO r(id, v) VALUES (?, ?)', [2n ** 60n, 'big'])).toEqual({ changes: 1, lastInsertRowid: 2n ** 60n });
      expect(conn.run('INSERT INTO r(id, v) VALUES (?, ?) RETURNING id', [Number.MAX_SAFE_INTEGER, 'edge'])).toEqual({
        changes: 1, lastInsertRowid: Number.MAX_SAFE_INTEGER,
      });
      expect(conn.run('INSERT INTO r(v) VALUES (?) RETURNING id', ['next'])).toEqual({ changes: 1, lastInsertRowid: 2n ** 60n + 1n });
      expect(conn.pluck('SELECT id FROM r WHERE v = ?', ['a'])).toBe(1);
      expect(conn.get('SELECT id FROM r WHERE v = ?', ['next'])).toEqual({ id: Number(2n ** 60n + 1n) });
    });
  });
});
