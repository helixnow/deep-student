import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Worker, threadId } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import nativePlugin from '../../native/index.ts';
import { openStartupDatabase, type StartupDatabase } from '../node.ts';
import { Connection } from '../connection.ts';

let host: TestHost;
let dir: string;
const handles: StartupDatabase[] = [];
let worker: Worker | undefined;
let control: Int32Array | undefined;

beforeAll(async () => {
  host = await createTestHost({ plugins: [nativePlugin], contracts: { only: [] } });
});
afterAll(async () => { await host.dispose(); });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-startup-busy-')); });
afterEach(async () => {
  try {
    if (control) { Atomics.store(control, 0, 2); Atomics.notify(control, 0); }
    await worker?.terminate();
  } finally {
    worker = undefined;
    control = undefined;
    for (const db of handles.splice(0)) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function open(): StartupDatabase {
  const db = openStartupDatabase(path.join(dir, 'locks.db'), { nativeSqliteBusy: host.ctx.nativeSqliteBusy });
  handles.push(db);
  return db;
}

function holdWriteLock(): StartupDatabase {
  const writer = open();
  writer.exec('CREATE TABLE lock_probe(value INTEGER)');
  writer.begin('immediate');
  writer.run('INSERT INTO lock_probe VALUES (1)');
  return writer;
}

function startContender(file: string): Worker {
  control = new Int32Array(new SharedArrayBuffer(4));
  worker = new Worker(new URL('./fixtures/startup-busy-worker.ts', import.meta.url), {
    workerData: { path: file, control: control.buffer },
  });
  return worker;
}

async function message(target: Worker): Promise<any> {
  const [value] = await once(target, 'message', { signal: AbortSignal.timeout(10_000) });
  return value;
}

const busyError = { code: 'SQLITE', sqliteCode: 'SQLITE_BUSY', phase: 'execute', message: 'database is locked' };

describe('WP-164 StartupDatabase busy-handler public primitive', () => {
  it('[tombstone_sequence_waits_for_writer_before_reading handshake] same step waits without a read lock, then sees the writer commit', async () => {
    expect(host.ctx.get('storage')).toBeUndefined();
    const writer = holdWriteLock();
    const contender = startContender(writer.path);
    const ready = await message(contender);
    expect(ready.kind).toBe('ready');
    expect(ready.threadId).not.toBe(threadId);
    const waiting = message(contender);
    contender.postMessage('reserve');
    expect(await waiting).toEqual({ kind: 'waiting', threadId: ready.threadId, priorInvocations: 0, inTransaction: false });
    // The worker is still inside its one BEGIN IMMEDIATE step. COMMIT must not
    // be blocked by a contender read lock (state.rs:644-657).
    expect(() => writer.commit()).not.toThrow();
    const reserved = message(contender);
    Atomics.store(control!, 0, 1);
    Atomics.notify(control!, 0);
    expect(await reserved).toEqual({ kind: 'reserved', count: 1, invocations: [0], inTransaction: false });
    expect(writer.pluck('SELECT COUNT(*) FROM lock_probe')).toBe(2);
    const closed = message(contender);
    const exited = once(contender, 'exit');
    contender.postMessage('close');
    expect(await closed).toEqual({ kind: 'closed' });
    expect((await exited)[0]).toBe(0);
    worker = undefined;
    writer.begin('exclusive');
    writer.rollback();
  });

  it('false releases the same paused step with SQLITE_BUSY while the writer still owns its transaction', async () => {
    const writer = holdWriteLock();
    const contender = startContender(writer.path);
    await message(contender);
    const waiting = message(contender);
    contender.postMessage('reserve');
    expect((await waiting).kind).toBe('waiting');
    const failed = message(contender);
    Atomics.store(control!, 0, 2);
    Atomics.notify(control!, 0);
    expect(await failed).toEqual({
      kind: 'failed', code: 'SQLITE', sqliteCode: 'SQLITE_BUSY', phase: 'execute',
      invocations: [0], inTransaction: false,
    });
    expect(writer.inTransaction).toBe(true);
    writer.commit();
    expect(writer.pluck('SELECT COUNT(*) FROM lock_probe')).toBe(1);
  });

  it('true retries inside SQLite with priorInvocations starting at zero for each lock event', () => {
    holdWriteLock();
    const db = open();
    const calls: Array<[number, number]> = [];
    db.setBusyHandler(n => { calls.push([n, threadId]); return n < 2; });
    expect(db.pluck('PRAGMA busy_timeout')).toBe(0);
    expect(() => db.begin('immediate')).toThrow(expect.objectContaining(busyError));
    expect(calls).toEqual([[0, threadId], [1, threadId], [2, threadId]]);
    expect(db.inTransaction).toBe(false);
    expect(() => db.begin('immediate')).toThrow(expect.objectContaining(busyError));
    expect(calls.slice(3)).toEqual([[0, threadId], [1, threadId], [2, threadId]]);
  });

  it('replacement, null, and busy_timeout supersede the previous callback without restoring the profile timeout', () => {
    holdWriteLock();
    const db = open();
    const old: number[] = [];
    const current: number[] = [];
    db.setBusyHandler(n => { old.push(n); return false; });
    db.setBusyHandler(n => { current.push(n); return false; });
    expect(() => db.begin('immediate')).toThrow(expect.objectContaining(busyError));
    expect(old).toEqual([]);
    expect(current).toEqual([0]);
    db.setBusyHandler(null);
    expect(db.pluck('PRAGMA busy_timeout')).toBe(0);
    expect(() => db.begin('immediate')).toThrow(expect.objectContaining(busyError));
    expect(current).toEqual([0]);
    db.setBusyHandler(n => { current.push(n); return false; });
    db.exec('PRAGMA busy_timeout = 20');
    expect(db.pluck('PRAGMA busy_timeout')).toBe(20);
    expect(() => db.begin('immediate')).toThrow(expect.objectContaining(busyError));
    expect(current).toEqual([0]);
  });

  it('rusqlite busy.rs:60: a thrown callback is false, never a pending or deferred JS exception', () => {
    const writer = holdWriteLock();
    const db = open();
    const thrown = new Error('handler failed');
    let reentry: unknown;
    db.setBusyHandler(() => {
      try { db.setBusyHandler(null); } catch (error) { reentry = error; }
      throw thrown;
    });
    expect(() => db.begin('immediate')).toThrow(expect.objectContaining(busyError));
    expect(reentry).toEqual(new TypeError('This database connection is busy executing a query'));
    expect(db.pluck('SELECT 1')).toBe(1);
    expect(() => db.setBusyHandler(null)).not.toThrow();
    writer.commit();
    expect(() => db.begin('immediate')).not.toThrow();
    db.rollback();
  });

  it('a throwing handler preserves the successful wal_checkpoint row with busy=1', () => {
    const writer = open();
    writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE lock_probe(value INTEGER); INSERT INTO lock_probe VALUES (1)');
    writer.begin('immediate');
    writer.run('INSERT INTO lock_probe VALUES (2)');
    const db = open();
    const calls: number[] = [];
    db.setBusyHandler(n => { calls.push(n); throw new Error('checkpoint callback'); });
    expect(db.one<{ busy: number }>('PRAGMA wal_checkpoint(RESTART)').busy).toBe(1);
    expect(calls).toEqual([0]);
    expect(db.pluck('SELECT 1')).toBe(1);
    writer.commit();
  });

  it('close releases the transaction and callback; a fresh connection keeps its default profile', () => {
    const db = open();
    db.exec('CREATE TABLE lock_probe(value INTEGER)');
    const calls: number[] = [];
    db.setBusyHandler(n => { calls.push(n); return false; });
    db.begin('immediate');
    db.run('INSERT INTO lock_probe VALUES (1)');
    db.close();
    db.close();
    expect(() => db.setBusyHandler(null)).toThrow(new TypeError('The database connection is not open'));
    const next = open();
    expect(next.pluck('PRAGMA busy_timeout')).toBe(5000);
    next.begin('exclusive');
    expect(next.pluck('SELECT COUNT(*) FROM lock_probe')).toBe(0);
    next.rollback();
    expect(calls).toEqual([]);
  });

  it('optional provider preserves existing open calls and reports missing capability only on registration', () => {
    const db = openStartupDatabase(':memory:');
    try {
      expect(db.pluck('SELECT 1')).toBe(1);
      expect(() => db.setBusyHandler(null)).toThrow(expect.objectContaining({ code: 'INVALID_PARAM' }));
      expect(db.pluck('PRAGMA busy_timeout')).toBe(5000);
    } finally { db.close(); }
  });

  it('Connection exposes the same one-argument signature and delegates on its own native handle', () => {
    holdWriteLock();
    const db = new Connection(path.join(dir, 'locks.db'), {
      label: 'connection', profile: {}, nativeSqliteBusy: host.ctx.nativeSqliteBusy,
    });
    try {
      const calls: number[] = [];
      db.setBusyHandler(n => { calls.push(n); return false; });
      expect(() => db.begin('immediate')).toThrow(expect.objectContaining(busyError));
      expect(calls).toEqual([0]);
    } finally { db.close(); }
  });
});
