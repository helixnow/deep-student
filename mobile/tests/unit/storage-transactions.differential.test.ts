/**
 * 移动端事务语义与桌面逐步对拍：同一段脚本分别跑在桌面 `SqliteDatabase`（better-sqlite3）和 `MobileDatabase`
 * （Node 版 sqlite-wasm）上，每一步的返回值或错误形状（`StorageError` 的 code / sqliteCode / message / database）、
 * 回调顺序和表内容都必须相同。
 *
 * 同步事务、保存点、afterCommit、batch 对照桌面文件库；异步事务对照桌面 `:memory:` 库——移动端每个库只有一条连接，
 * 与桌面内存库一样，异步事务期间句柄上的任何语句都按 BUSY 拒绝（桌面文件库的异步事务走第二条连接，读不受影响）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle, SyncTransaction, AsyncTransaction } from '../../../host/platform/storage/api.ts';
import { SqliteDatabase } from '../../../host/platform/storage/database.ts';
import { PROFILES } from '../../../host/platform/storage/profiles.ts';
import { openFileDatabase } from '../../../host/platform/storage/service.ts';
import { MobileDatabase } from '../../../host/platform/storage-mobile/database.ts';
import { errorShape, mobileConnection, nodeSqlite, uniqueFile } from './support/sqlite-node.ts';

type Sqlite = Awaited<ReturnType<typeof nodeSqlite>>;
type Trace = [label: string, outcome: 'ok' | 'err', value: unknown][];

const LABEL = 'txdiff';
let sqlite3: Sqlite;
let dir: string;
let n = 0;

beforeAll(async () => {
  sqlite3 = await nodeSqlite();
  dir = mkdtempSync(join(tmpdir(), 'w31-txdiff-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function desktopFile(): SqliteDatabase {
  return openFileDatabase(join(dir, `d${++n}.db`), { profile: 'plain', label: LABEL });
}

function desktopMemory(): SqliteDatabase {
  return new SqliteDatabase({ name: LABEL, path: ':memory:', profile: PROFILES.plain });
}

function mobile(): MobileDatabase {
  const file = uniqueFile('txdiff');
  return new MobileDatabase({ name: LABEL, path: file, profile: PROFILES.plain, open: () => mobileConnection(sqlite3, file, LABEL, PROFILES.plain), warn: () => undefined });
}

function step(trace: Trace, label: string, fn: () => unknown): void {
  try {
    trace.push([label, 'ok', fn()]);
  } catch (error) {
    trace.push([label, 'err', errorShape(error)]);
  }
}

async function stepAsync(trace: Trace, label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    trace.push([label, 'ok', await fn()]);
  } catch (error) {
    trace.push([label, 'err', errorShape(error)]);
  }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const rows = (db: DatabaseHandle) => db.all<{ v: string }>('SELECT v FROM t ORDER BY id').map(row => row.v);

function syncScript(db: DatabaseHandle): Trace {
  const t: Trace = [];
  const order: unknown[] = [];
  step(t, 'setup', () => db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT UNIQUE)'));

  step(t, 'commit returns the value; afterCommit runs after commit, in order', () => db.transaction((tx) => {
    tx.run("INSERT INTO t(v) VALUES ('a')");
    tx.afterCommit(() => { order.push(['cb1', db.inTransaction, db.pluck('SELECT count(*) FROM t')]); });
    tx.afterCommit(() => { order.push('cb2'); });
    order.push('body');
    return 'value';
  }));
  step(t, 'callback order', () => order.splice(0));

  const boom = new Error('boom');
  step(t, 'a throwing callback rolls back and rethrows the same error', () => {
    try {
      db.transaction((tx) => {
        tx.run("INSERT INTO t(v) VALUES ('b')");
        throw boom;
      });
    } catch (error) {
      return error === boom;
    }
    return 'no error';
  });
  step(t, 'rows after rollback', () => rows(db));
  step(t, 'not in a transaction after rollback', () => db.inTransaction);

  step(t, 'nested transaction', () => db.transaction((tx) => {
    tx.run("INSERT INTO t(v) VALUES ('n')");
    return db.transaction(() => 1);
  }));
  step(t, 'async callback', () => db.transaction((tx) => {
    tx.run("INSERT INTO t(v) VALUES ('p')");
    return Promise.resolve();
  }));
  step(t, 'rows after nested and async attempts', () => rows(db));

  let saved: SyncTransaction | undefined;
  step(t, 'capture the scope', () => db.transaction((tx) => { saved = tx; }));
  step(t, 'stale scope run', () => saved!.run("INSERT INTO t(v) VALUES ('stale')"));
  step(t, 'stale scope get', () => saved!.get('SELECT 1 AS one'));
  step(t, 'stale scope afterCommit', () => saved!.afterCommit(() => undefined));

  step(t, 'savepoints: a failed one rolls back alone and drops its callbacks; nested ones release', () => db.transaction((tx) => {
    tx.run("INSERT INTO t(v) VALUES ('s1')");
    try {
      tx.savepoint((sp) => {
        sp.run("INSERT INTO t(v) VALUES ('s2')");
        sp.afterCommit(() => { order.push('dropped'); });
        sp.run("INSERT INTO t(v) VALUES ('s1')");
      });
    } catch (error) {
      order.push(errorShape(error));
    }
    tx.savepoint((sp) => {
      sp.run("INSERT INTO t(v) VALUES ('s3')");
      sp.afterCommit(() => { order.push('kept'); });
      sp.savepoint((inner) => { inner.run("INSERT INTO t(v) VALUES ('s4')"); });
      try {
        sp.savepoint((inner) => {
          inner.run("INSERT INTO t(v) VALUES ('s5')");
          throw new Error('inner');
        });
      } catch (error) {
        order.push((error as Error).message);
      }
    });
    return tx.all('SELECT v FROM t ORDER BY id');
  }));
  step(t, 'savepoint callback order', () => order.splice(0));
  step(t, 'async savepoint callback', () => db.transaction(tx => tx.savepoint(() => Promise.resolve())));

  step(t, 'a throwing afterCommit callback: commit stands, later callbacks still run', () => db.transaction((tx) => {
    tx.run("INSERT INTO t(v) VALUES ('d')");
    tx.afterCommit(() => { throw new Error('cb failed'); });
    tx.afterCommit(() => { order.push('after failing'); });
  }));
  step(t, 'callbacks after the failure', () => order.splice(0));
  step(t, 'a new transaction from inside afterCommit', () => db.transaction((tx) => {
    tx.afterCommit(() => { order.push(db.transaction(inner => inner.run("INSERT INTO t(v) VALUES ('from-callback')").changes)); });
  }));
  step(t, 'afterCommit transaction result', () => order.splice(0));

  step(t, 'one() without rows on the handle', () => db.one('SELECT v FROM t WHERE v = ?1', ['zzz']));
  step(t, 'one() without rows in a transaction', () => db.transaction(tx => tx.one('SELECT v FROM t WHERE v = ?1', ['zzz'])));
  step(t, 'immediate', () => db.transaction(tx => tx.run("INSERT INTO t(v) VALUES ('imm')").changes, { behavior: 'immediate' }));
  step(t, 'exclusive', () => db.transaction(tx => tx.run("INSERT INTO t(v) VALUES ('exc')").changes, { behavior: 'exclusive' }));
  step(t, 'the callback commits by hand', () => db.transaction((tx) => {
    tx.run("INSERT INTO t(v) VALUES ('manual')");
    tx.exec('COMMIT');
  }));
  step(t, 'not in a transaction after the manual commit', () => db.inTransaction);

  step(t, 'batch conflict rolls back the whole batch', () => db.batch([
    { query: "INSERT INTO t(v) VALUES ('e')" },
    { query: 'INSERT INTO t(v) VALUES (?1)', params: ['e'] },
  ]));
  step(t, 'batch', () => db.batch([{ query: "INSERT INTO t(v) VALUES ('f')" }, { query: 'UPDATE t SET v = ?1 WHERE v = ?2', params: ['g', 'f'] }]));
  step(t, 'final rows', () => rows(db));
  return t;
}

async function asyncScript(db: DatabaseHandle): Promise<Trace> {
  const t: Trace = [];
  const order: unknown[] = [];
  step(t, 'setup', () => db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT UNIQUE)'));

  await stepAsync(t, 'withTransaction awaits async afterCommit callbacks', () => db.withTransaction(async (tx) => {
    tx.run("INSERT INTO t(v) VALUES ('w1')");
    await tick();
    tx.afterCommit(async () => {
      await tick();
      order.push(['async cb', db.inTransaction]);
    });
    return 'done';
  }));
  step(t, 'async callback order', () => order.splice(0));

  const tx = await db.begin();
  step(t, 'read on the handle during an async transaction', () => db.all('SELECT v FROM t'));
  step(t, 'write on the handle during an async transaction', () => db.run("INSERT INTO t(v) VALUES ('h')"));
  step(t, 'sync transaction during an async transaction', () => db.transaction(() => 1));
  step(t, 'exec during an async transaction', () => db.exec('SELECT 1'));
  step(t, 'inTransaction during an async transaction', () => db.inTransaction);
  step(t, 'the transaction sees its own write', () => {
    tx.run("INSERT INTO t(v) VALUES ('w2')");
    return tx.pluck('SELECT count(*) FROM t');
  });
  await stepAsync(t, 'commit', () => tx.commit());
  await stepAsync(t, 'commit twice', () => tx.commit());
  await stepAsync(t, 'rollback after commit', () => tx.rollback());
  step(t, 'stale async transaction', () => tx.run("INSERT INTO t(v) VALUES ('stale')"));
  step(t, 'active after commit', () => tx.active);

  const boom = new Error('boom');
  await stepAsync(t, 'withTransaction rethrows the same error after rollback', async () => {
    try {
      await db.withTransaction(async (inner) => {
        inner.run("INSERT INTO t(v) VALUES ('w3')");
        throw boom;
      });
    } catch (error) {
      return error === boom;
    }
    return 'no error';
  });
  await stepAsync(t, 'conflict inside withTransaction', () => db.withTransaction(async (inner) => {
    inner.run("INSERT INTO t(v) VALUES ('w1')");
  }));

  const controller = new AbortController();
  const aborted = await db.begin({ signal: controller.signal });
  aborted.run("INSERT INTO t(v) VALUES ('w4')");
  controller.abort(new Error('stop'));
  step(t, 'after abort', () => aborted.run("INSERT INTO t(v) VALUES ('w5')"));
  step(t, 'active after abort', () => aborted.active);
  await stepAsync(t, 'commit after abort', () => aborted.commit());
  await stepAsync(t, 'begin with an aborted signal', () => db.begin({ signal: AbortSignal.abort(new Error('early')) }));
  await stepAsync(t, 'write with an aborted signal', () => db.write(() => 1, { signal: AbortSignal.abort(new Error('early')) }));

  const events: string[] = [];
  let holder: AsyncTransaction | undefined;
  const first = db.withTransaction(async (inner) => {
    holder = inner;
    events.push('first start');
    await tick();
    inner.run("INSERT INTO t(v) VALUES ('q1')");
    events.push('first end');
  });
  const second = db.write((inner) => {
    events.push(`second sees ${String(inner.pluck("SELECT count(*) FROM t WHERE v = 'q1'"))}`);
    return inner.run("INSERT INTO t(v) VALUES ('q2')").changes;
  });
  const third = db.withTransaction(async () => { events.push('third'); });
  await stepAsync(t, 'queued writers run one at a time, in order', () => Promise.all([first, second, third]));
  step(t, 'queue order', () => events.splice(0));
  step(t, 'first holder is closed', () => holder!.active);

  await stepAsync(t, 'a failing async afterCommit callback: commit stands', () => db.withTransaction(async (inner) => {
    inner.run("INSERT INTO t(v) VALUES ('w6')");
    inner.afterCommit(async () => { throw new Error('async cb failed'); });
    inner.afterCommit(() => { order.push('after async failure'); });
  }));
  step(t, 'callbacks after the async failure', () => order.splice(0));
  await stepAsync(t, 'write() with a throwing callback', () => db.write(() => { throw new Error('write failed'); }));
  await stepAsync(t, 'the writer slot is free again', () => db.write(inner => inner.run("INSERT INTO t(v) VALUES ('w7')").changes));
  step(t, 'final rows', () => rows(db));
  return t;
}

describe('mobile transactions match the desktop handle step by step', () => {
  it('sync transactions, savepoints, afterCommit and batch (desktop file database)', () => {
    const d = desktopFile();
    const m = mobile();
    try {
      const desktopTrace = syncScript(d);
      const mobileTrace = syncScript(m);
      const at = (label: string) => desktopTrace.find(entry => entry[0] === label);
      expect(at('nested transaction')).toEqual(['nested transaction', 'err', expect.objectContaining({ code: 'SQLITE', message: 'cannot start a transaction within a transaction' })]);
      expect(at('async callback')).toEqual(['async callback', 'err', expect.objectContaining({ code: 'ASYNC_IN_SYNC_TX' })]);
      expect(at('stale scope run')).toEqual(['stale scope run', 'err', expect.objectContaining({ code: 'TX_CLOSED' })]);
      expect(at('a throwing afterCommit callback: commit stands, later callbacks still run')?.[2]).toMatchObject({ storageError: false, name: 'AfterCommitError' });
      expect(at('batch conflict rolls back the whole batch')?.[2]).toMatchObject({ sqliteCode: 'SQLITE_CONSTRAINT_UNIQUE' });
      expect(mobileTrace).toEqual(desktopTrace);
    } finally {
      d.close();
      m.close();
    }
  });

  it('async transactions, abort, the writer queue and the single-connection guard (desktop :memory: database)', async () => {
    const d = desktopMemory();
    const m = mobile();
    try {
      const desktopTrace = await asyncScript(d);
      const mobileTrace = await asyncScript(m);
      const at = (label: string) => desktopTrace.find(entry => entry[0] === label);
      expect(at('read on the handle during an async transaction')?.[2]).toMatchObject({ code: 'BUSY', sqliteCode: 'SQLITE_BUSY' });
      expect(at('after abort')?.[2]).toMatchObject({ code: 'ABORTED' });
      expect(at('commit twice')?.[2]).toMatchObject({ code: 'TX_CLOSED' });
      expect(at('queue order')).toEqual(['queue order', 'ok', ['first start', 'first end', 'second sees 1', 'third']]);
      expect(mobileTrace).toEqual(desktopTrace);
    } finally {
      d.close();
      m.close();
    }
  });
});
