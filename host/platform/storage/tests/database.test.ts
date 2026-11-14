import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AfterCommitError, defineQuery, StorageError } from '../api.ts';
import { Connection } from '../connection.ts';
import { SqliteDatabase } from '../database.ts';
import { planParams } from '../params.ts';
import { PROFILES } from '../profiles.ts';

let dir: string;
const handles: SqliteDatabase[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-storage-'));
});
afterEach(() => {
  for (const h of handles.splice(0)) {
    try {
      h.close();
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(name = 'vfs', profile = PROFILES.vfs): SqliteDatabase {
  const h = new SqliteDatabase({ name, path: path.join(dir, `${name}.db`), profile });
  handles.push(h);
  h.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT, flag INTEGER)');
  return h;
}

describe('connection profiles (PRAGMA parity with Rust)', () => {
  const cases: Array<[keyof typeof PROFILES, { fk: number; journal: string; sync: number; busy: number; autoVacuum?: number }]> = [
    ['mistakes', { fk: 1, journal: 'wal', sync: 2, busy: 3000 }],
    ['vfs', { fk: 1, journal: 'wal', sync: 1, busy: 5000 }],
    // auto_vacuum 在 journal_mode=WAL 之后设置：WAL 切换已写出库头，新值需 VACUUM 才生效（Rust 同序，结果同为 0）
    ['chat_v2', { fk: 1, journal: 'wal', sync: 1, busy: 10000, autoVacuum: 0 }],
    ['llm_usage', { fk: 1, journal: 'wal', sync: 1, busy: 3000 }],
    ['audit', { fk: 1, journal: 'delete', sync: 2, busy: 5000 }],
    ['browser', { fk: 1, journal: 'wal', sync: 1, busy: 3000 }],
    ['sync_state', { fk: 1, journal: 'delete', sync: 2, busy: 5000 }],
    ['workspace', { fk: 1, journal: 'wal', sync: 2, busy: 5000 }],
    ['plain', { fk: 1, journal: 'delete', sync: 2, busy: 5000 }],
  ];
  for (const [name, expected] of cases) {
    it(name, () => {
      const c = new Connection(path.join(dir, `${name}.db`), { label: name, profile: PROFILES[name] });
      try {
        expect(c.pragmaValue('foreign_keys')).toBe(expected.fk);
        expect(c.pragmaValue('journal_mode')).toBe(expected.journal);
        expect(c.pragmaValue('synchronous')).toBe(expected.sync);
        expect(c.pragmaValue('busy_timeout')).toBe(expected.busy);
        if (expected.autoVacuum !== undefined) expect(c.pragmaValue('auto_vacuum')).toBe(expected.autoVacuum);
      } finally {
        c.close();
      }
    });
  }
  it('bundled SQLite is new enough (Rust requires >= 3.51.3 for the WAL-reset fix)', () => {
    const c = new Connection(':memory:', { label: 'm', profile: PROFILES.plain });
    const v = String(c.pluck('SELECT sqlite_version()')).split('.').map(Number);
    c.close();
    expect(v[0]! * 1_000_000 + v[1]! * 1000 + v[2]!).toBeGreaterThanOrEqual(3_051_003);
  });
});

describe('parameters (rusqlite binding semantics)', () => {
  it('plans numbered, anonymous and named parameters by SQLite index', () => {
    expect(planParams('SELECT ?1, ?2, ?1').count).toBe(2);
    expect(planParams("SELECT '?1', \"?\", ?, -- ?\n ?").count).toBe(2);
    expect(planParams('SELECT :a, @b, :a, ?').slots.map((s) => [s.index, s.key])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, null],
    ]);
  });
  it('binds positional arrays to ?NNN and reuses them', () => {
    const db = open();
    expect(db.get('SELECT ?1 AS a, ?2 AS b, ?1 AS c', [5, 'x'])).toEqual({ a: 5, b: 'x', c: 5 });
    expect(db.get('SELECT ? AS a, ? AS b', [1, 2])).toEqual({ a: 1, b: 2 });
    expect(db.get('SELECT :x AS x', { x: 'n' })).toEqual({ x: 'n' });
    expect(db.get('SELECT :x AS x', ['by-index'])).toEqual({ x: 'by-index' });
  });
  it('binds booleans as 0/1 and Uint8Array as BLOB; rejects undefined and wrong counts', () => {
    const db = open();
    db.run('INSERT INTO t (id, v, flag) VALUES (?1, ?2, ?3)', [1, 'a', true]);
    expect(db.pluck('SELECT flag FROM t WHERE id = 1')).toBe(1);
    expect(db.pluck('SELECT ?1', [new Uint8Array([1, 2])])).toEqual(Buffer.from([1, 2]));
    expect(() => db.run('INSERT INTO t (id) VALUES (?1)', [undefined as unknown as null])).toThrow(StorageError);
    expect(() => db.get('SELECT ?1, ?2', [1])).toThrow(/Wrong number of parameters/);
  });
  it('binds a plain Uint8Array exactly like a Buffer: only the view range, in every slot kind', () => {
    const db = open();
    db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY, data BLOB)');
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    const cases: Array<[string, Uint8Array]> = [
      ['buffer', Buffer.from([1, 2, 3])],
      ['plain', new Uint8Array([1, 2, 3])],
      ['offset view', view],
      ['buffer view', Buffer.from(backing.buffer, 2, 3)],
    ];
    let id = 0;
    for (const [label, value] of cases) {
      id += 1;
      db.run('INSERT INTO b (id, data) VALUES (?1, ?2)', [id, value]);
      id += 1;
      db.run('INSERT INTO b (id, data) VALUES (?, ?)', [id, value]);
      id += 1;
      db.run('INSERT INTO b (id, data) VALUES (:id, :data)', { id, data: value });
      for (const row of db.all<{ t: string; h: string }>('SELECT typeof(data) AS t, hex(data) AS h FROM b WHERE id > ?1', [id - 3])) {
        expect([label, row]).toEqual([label, { t: 'blob', h: '010203' }]);
      }
    }
    db.run('INSERT INTO b (id, data) VALUES (?1, ?2)', [100, new Uint8Array(0)]);
    expect(db.get('SELECT typeof(data) AS t, length(data) AS n FROM b WHERE id = 100')).toEqual({ t: 'blob', n: 0 });
    expect(db.pluck('SELECT ?1 = ?2', [view, Buffer.from([1, 2, 3])])).toBe(1);
    expect(() => db.run('INSERT INTO b (id, data) VALUES (?1, ?2)', [101, new Uint16Array([1]) as unknown as Uint8Array]))
      .toThrow(StorageError);
  });
  it('one() throws NO_ROWS with the rusqlite message; get() returns undefined', () => {
    const db = open();
    expect(db.get('SELECT * FROM t WHERE id = 99')).toBeUndefined();
    try {
      db.one('SELECT * FROM t WHERE id = 99');
      expect.unreachable();
    } catch (error) {
      expect((error as StorageError).code).toBe('NO_ROWS');
      expect((error as StorageError).message).toBe('Query returned no rows');
    }
  });
  it('wraps SQLite errors with sqliteCode and sqlite3_errmsg text', () => {
    const db = open();
    db.run('INSERT INTO t (id, v) VALUES (1, ?1)', ['a']);
    try {
      db.run('INSERT INTO t (id, v) VALUES (1, ?1)', ['b']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).sqliteCode).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');
      expect((error as StorageError).message).toBe('UNIQUE constraint failed: t.id');
    }
  });
  it('tags prepare failures with phase=prepare', () => {
    const db = open();
    try {
      db.get('SELECT * FROM table_that_does_not_exist');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).phase).toBe('prepare');
      expect((error as StorageError).code).toBe('SQLITE');
      expect((error as StorageError).database).toBe('vfs');
    }
  });
  it('tags binding failures with phase=bind', () => {
    const db = open();
    try {
      db.run('INSERT INTO t (id) VALUES (?1)', [undefined as unknown as null]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).phase).toBe('bind');
      expect((error as StorageError).code).toBe('INVALID_PARAM');
    }
    try {
      db.get('SELECT ?1, ?2', [1]);
      expect.unreachable();
    } catch (error) {
      expect((error as StorageError).phase).toBe('bind');
      expect((error as StorageError).message).toMatch(/Wrong number of parameters/);
    }
  });
  it('tags execution failures with phase=execute and keeps sqliteCode', () => {
    const db = open();
    db.run('INSERT INTO t (id, v) VALUES (1, ?1)', ['a']);
    try {
      db.run('INSERT INTO t (id, v) VALUES (1, ?1)', ['b']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).phase).toBe('execute');
      expect((error as StorageError).sqliteCode).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');
      expect((error as StorageError).message).toBe('UNIQUE constraint failed: t.id');
    }
  });
  it('typed named queries and safeIntegers', () => {
    const db = open();
    const big = defineQuery<{ v: bigint }, { x: bigint }>('SELECT :v AS x', { options: { safeIntegers: true } });
    expect(db.get(big, { v: 9007199254740993n })).toEqual({ x: 9007199254740993n });
    const small = defineQuery<void, { n: number }>('SELECT 1 AS n');
    expect(db.get(small)).toEqual({ n: 1 });
    expect([...db.iterate<{ n: number }>('SELECT 1 AS n UNION ALL SELECT 2')].map((r) => r.n)).toEqual([1, 2]);
  });
});

describe('synchronous transactions', () => {
  it('commits, rolls back on throw, and rejects async callbacks', () => {
    const db = open();
    db.transaction((tx) => {
      tx.run('INSERT INTO t (id, v) VALUES (1, ?1)', ['a']);
    });
    expect(() =>
      db.transaction((tx) => {
        tx.run('INSERT INTO t (id, v) VALUES (2, ?1)', ['b']);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(1);
    expect(() => db.transaction(async () => undefined)).toThrow(/must be synchronous/);
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(1);
  });
  it('uses the requested BEGIN behavior', () => {
    const db = open();
    const other = new Connection(db.path, { label: 'other', profile: { ...PROFILES.vfs, busyTimeoutMs: 0 } });
    try {
      db.transaction(
        () => {
          // immediate 事务已持有 RESERVED 锁：另一连接的写立即 BUSY
          expect(() => other.run('INSERT INTO t (id) VALUES (50)')).toThrow(/locked/);
        },
        { behavior: 'immediate' },
      );
    } finally {
      other.close();
    }
  });
  it('savepoints roll back only their own work and their afterCommit callbacks', () => {
    const db = open();
    const events: string[] = [];
    db.transaction((tx) => {
      tx.run('INSERT INTO t (id) VALUES (1)');
      tx.afterCommit(() => events.push('outer'));
      expect(() =>
        tx.savepoint((sp) => {
          sp.run('INSERT INTO t (id) VALUES (2)');
          sp.afterCommit(() => events.push('inner-rolled-back'));
          throw new Error('inner');
        }),
      ).toThrow('inner');
      tx.savepoint((sp) => {
        sp.run('INSERT INTO t (id) VALUES (3)');
        sp.afterCommit(() => events.push('inner-kept'));
      });
      expect(events).toEqual([]);
    });
    expect(db.all<{ id: number }>('SELECT id FROM t ORDER BY id').map((r) => r.id)).toEqual([1, 3]);
    expect(events).toEqual(['outer', 'inner-kept']);
  });
  it('afterCommit runs only after commit; callback errors surface as AfterCommitError with data committed', () => {
    const db = open();
    const seen: number[] = [];
    expect(() =>
      db.transaction((tx) => {
        tx.run('INSERT INTO t (id) VALUES (1)');
        tx.afterCommit(() => {
          seen.push(db.pluck<number>('SELECT COUNT(*) FROM t')!);
          throw new Error('emit failed');
        });
        tx.afterCommit(() => seen.push(2));
      }),
    ).toThrow(AfterCommitError);
    expect(seen).toEqual([1, 2]);
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(1);
    const rolled: string[] = [];
    expect(() =>
      db.transaction((tx) => {
        tx.afterCommit(() => rolled.push('x'));
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(rolled).toEqual([]);
  });
  it('a transaction scope is unusable after it ends', () => {
    const db = open();
    let leaked: { run(sql: string): unknown } | undefined;
    db.transaction((tx) => {
      leaked = tx;
    });
    expect(() => leaked!.run('INSERT INTO t (id) VALUES (9)')).toThrow(/no longer active/);
  });
  it('batch is atomic', () => {
    const db = open();
    expect(() =>
      db.batch([
        { query: 'INSERT INTO t (id) VALUES (1)' },
        { query: 'INSERT INTO t (id) VALUES (1)' },
      ]),
    ).toThrow(StorageError);
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(0);
    expect(db.batch([{ query: 'INSERT INTO t (id) VALUES (?1)', params: [1] }]).map((r) => r.changes)).toEqual([1]);
  });
});

describe('async transaction handle', () => {
  it('stays atomic across awaits on its own connection; primary reads see committed data only', async () => {
    const db = open();
    const tx = await db.begin();
    tx.run('INSERT INTO t (id) VALUES (1)');
    await new Promise((r) => setTimeout(r, 5));
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(0);
    expect(tx.pluck('SELECT COUNT(*) FROM t')).toBe(1);
    await tx.commit();
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(1);
    expect(tx.active).toBe(false);
    expect(() => tx.run('INSERT INTO t (id) VALUES (2)')).toThrow(/no longer active/);
  });
  it('rejects primary-connection writes non-blockingly while active; write() queues behind it', async () => {
    const db = open();
    const tx = await db.begin();
    expect(() => db.run('INSERT INTO t (id) VALUES (5)')).toThrow(expect.objectContaining({ code: 'BUSY' }));
    expect(() => db.transaction(() => undefined)).toThrow(expect.objectContaining({ code: 'BUSY' }));
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(0); // 读不受影响
    const order: string[] = [];
    const queued = db.write((w) => {
      order.push('write');
      w.run('INSERT INTO t (id) VALUES (2)');
    });
    tx.run('INSERT INTO t (id) VALUES (1)');
    order.push('tx-commit');
    await tx.commit();
    await queued;
    expect(order).toEqual(['tx-commit', 'write']);
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(2);
  });
  it('withTransaction rolls back on throw and runs async afterCommit hooks only after commit', async () => {
    const db = open();
    await expect(
      db.withTransaction(async (tx) => {
        tx.run('INSERT INTO t (id) VALUES (1)');
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(0);
    const events: string[] = [];
    const result = await db.withTransaction(async (tx) => {
      tx.run('INSERT INTO t (id) VALUES (1)');
      tx.afterCommit(() => {
        events.push(`committed:${db.pluck('SELECT COUNT(*) FROM t')}`);
      });
      await Promise.resolve();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(events).toEqual(['committed:1']);
  });
  it('AbortSignal rolls back an open transaction and fails subsequent statements with ABORTED', async () => {
    const db = open();
    const controller = new AbortController();
    const events: string[] = [];
    const running = db.withTransaction(
      async (tx) => {
        tx.run('INSERT INTO t (id) VALUES (1)');
        tx.afterCommit(() => events.push('never'));
        await new Promise((r) => setTimeout(r, 20));
        tx.run('INSERT INTO t (id) VALUES (2)');
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error('user cancelled')), 5);
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
    expect(events).toEqual([]);
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(0);
    // 写者槽已释放
    await db.write((w) => w.run('INSERT INTO t (id) VALUES (3)'));
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(1);
  });
  it('an already-aborted signal never acquires the slot', async () => {
    const db = open();
    const controller = new AbortController();
    controller.abort();
    await expect(db.begin({ signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(db.write(() => 1, { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('queued begin() is FIFO and cancellable while waiting', async () => {
    const db = open();
    const first = await db.begin();
    const controller = new AbortController();
    const cancelled = db.begin({ signal: controller.signal });
    const second = db.begin();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' });
    await first.rollback();
    const tx2 = await second;
    tx2.run('INSERT INTO t (id) VALUES (7)');
    await tx2.commit();
    expect(db.pluck('SELECT id FROM t')).toBe(7);
  });
});

describe('maintenance barrier', () => {
  it('drains async transactions, checkpoints, closes, then reopens on release', async () => {
    const db = open();
    const tx = await db.begin();
    tx.run('INSERT INTO t (id) VALUES (1)');
    const entering = db.enterMaintenance(Date.now() + 5000);
    expect(() => db.get('SELECT 1')).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));
    await tx.commit();
    await entering;
    expect(fs.existsSync(`${db.path}-wal`) ? fs.statSync(`${db.path}-wal`).size : 0).toBe(0);
    db.exitMaintenance();
    expect(db.pluck('SELECT COUNT(*) FROM t')).toBe(1);
  });
  it('times out when a transaction never finishes and restores normal operation', async () => {
    const db = open();
    const tx = await db.begin();
    await expect(db.enterMaintenance(Date.now() + 60)).rejects.toMatchObject({ code: 'MAINTENANCE_DRAIN_TIMEOUT' });
    expect(db.inMaintenance).toBe(false);
    await tx.rollback();
    expect(db.pluck('SELECT 1')).toBe(1);
  });
  it('maintenance_barrier_fails_closed_for_all_connection_paths', async () => {
    const db = open();
    db.exec("CREATE TABLE barrier_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO barrier_probe (value) VALUES ('before');");
    db.exitMaintenance();
    expect(db.inMaintenance).toBe(false);

    await db.enterMaintenance(Date.now() + 5000);
    expect(db.inMaintenance).toBe(true);
    expect(() => db.get('SELECT value FROM barrier_probe')).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));
    expect(() => db.run("INSERT INTO barrier_probe (value) VALUES ('during')")).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));
    expect(() => db.rawConnection()).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));
    await expect(db.enterMaintenance(Date.now() + 5000)).rejects.toMatchObject({ code: 'MAINTENANCE' });

    db.exitMaintenance();
    expect(db.inMaintenance).toBe(false);
    expect(db.pluck('SELECT COUNT(*) FROM barrier_probe')).toBe(1);
    expect(db.pluck('SELECT value FROM barrier_probe WHERE id = 1')).toBe('before');
  });
});

describe('bundled sqlite version', () => {
  it('bundled_sqlite_contains_wal_reset_corruption_fix', () => {
    const db = open();
    const [major, minor, patch] = String(db.pluck('SELECT sqlite_version()')).split('.').map(Number);
    expect((major ?? 0) * 1_000_000 + (minor ?? 0) * 1_000 + (patch ?? 0)).toBeGreaterThanOrEqual(3_051_003);
  });
});

describe('online backup', () => {
  it('copies a consistent snapshot', async () => {
    const db = open();
    db.run('INSERT INTO t (id, v) VALUES (1, ?1)', ['x']);
    const dest = path.join(dir, 'backup', 'vfs.db');
    await db.backupTo(dest);
    const c = new Connection(dest, { label: 'b', profile: PROFILES.plain, mustExist: true });
    expect(c.pluck('SELECT v FROM t WHERE id = 1')).toBe('x');
    c.close();
  });
});
