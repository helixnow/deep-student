import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { once } from 'node:events';
import { Worker, threadId } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqliteBusy } from '../sqlite-busy/index.ts';

let dir: string;
let file: string;
const handles: Database.Database[] = [];
let worker: Worker | undefined;
let control: Int32Array | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-sqlite-busy-'));
  file = path.join(dir, 'locks.db');
});
afterEach(async () => {
  try {
    if (control) { Atomics.store(control, 0, 2); Atomics.notify(control, 0); }
    await worker?.terminate();
  } finally {
    worker = undefined;
    control = undefined;
    for (const db of handles.splice(0)) if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function open(timeout = 0): Database.Database {
  const db = new Database(file, { timeout });
  handles.push(db);
  return db;
}

function holdWriteLock(): Database.Database {
  const writer = open();
  writer.exec('CREATE TABLE IF NOT EXISTS lock_probe(value INTEGER)');
  writer.exec('BEGIN IMMEDIATE');
  writer.exec('INSERT INTO lock_probe VALUES (1)');
  return writer;
}

function startContender(): Worker {
  control = new Int32Array(new SharedArrayBuffer(4));
  worker = new Worker(new URL('./fixtures/sqlite-busy-worker.ts', import.meta.url), {
    workerData: { path: file, control: control.buffer },
  });
  return worker;
}

function message<T>(target: Worker, timeoutMs = 10_000): Promise<T> {
  return Promise.race([
    once(target, 'message').then(([value]) => value as T),
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`no worker message within ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
    }),
  ]);
}

const exposeGc = (): (() => void) => {
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
};

async function collected(ref: WeakRef<object>): Promise<boolean> {
  const gc = exposeGc();
  for (let i = 0; i < 20; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
    gc();
    await new Promise(resolve => setImmediate(resolve));
    if (ref.deref() === undefined) return true;
  }
  return false;
}

describe('nativeSqliteBusy (sqlite3_busy_handler on the better-sqlite3 connection)', () => {
  it('[state.rs tombstone_sequence_waits_for_writer_before_reading handshake] contender waits inside the handler without a read lock; writer commits; release reads the commit', async () => {
    const writer = holdWriteLock();
    const contender = startContender();
    const ready = await message<{ kind: string; threadId: number }>(contender);
    expect(ready.kind).toBe('ready');
    expect(ready.threadId).not.toBe(threadId);

    const waiting = message<Record<string, unknown>>(contender);
    contender.postMessage('reserve');
    // Received while the worker's sqlite3_step is still inside the callback.
    expect(await waiting).toEqual({ kind: 'waiting', threadId: ready.threadId, priorInvocations: 0, inTransaction: false });
    expect(() => writer.exec('COMMIT')).not.toThrow();

    const reserved = message<Record<string, unknown>>(contender);
    Atomics.store(control!, 0, 1);
    Atomics.notify(control!, 0);
    expect(await reserved).toEqual({ kind: 'reserved', count: 1, invocations: [0], inTransaction: false });
    expect(writer.prepare('SELECT COUNT(*) FROM lock_probe').pluck().get()).toBe(2);

    const closed = message<{ kind: string }>(contender);
    contender.postMessage('close');
    expect((await closed).kind).toBe('closed');
  });

  it('cancel: handler returning false while the writer still holds the lock fails the step with SQLITE_BUSY', async () => {
    const writer = holdWriteLock();
    const contender = startContender();
    await message(contender);
    const waiting = message<{ kind: string }>(contender);
    contender.postMessage('reserve');
    expect((await waiting).kind).toBe('waiting');
    const failed = message<Record<string, unknown>>(contender);
    Atomics.store(control!, 0, 2);
    Atomics.notify(control!, 0);
    expect(await failed).toEqual({ kind: 'failed', code: 'SQLITE_BUSY', invocations: [0], inTransaction: false });
    expect(writer.inTransaction).toBe(true);
    writer.exec('COMMIT');
  });

  it('true keeps SQLite retrying with increasing priorInvocations; false ends with SQLITE_BUSY on the same thread', () => {
    holdWriteLock();
    const contender = open(5000);
    const calls: Array<[number, number]> = [];
    sqliteBusy.setBusyHandler(contender, (priorInvocations) => {
      calls.push([priorInvocations, threadId]);
      return priorInvocations < 3;
    });
    // Installing the handler replaced the 5000 ms timeout.
    expect(contender.pragma('busy_timeout', { simple: true })).toBe(0);
    expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
    expect(calls).toEqual([[0, threadId], [1, threadId], [2, threadId], [3, threadId]]);
    expect(contender.inTransaction).toBe(false);
  });

  it('null removes the handler: contention fails immediately without calling it and busy_timeout is not restored', () => {
    holdWriteLock();
    const contender = open(5000);
    const calls: number[] = [];
    sqliteBusy.setBusyHandler(contender, (n) => { calls.push(n); return false; });
    sqliteBusy.setBusyHandler(contender, null);
    expect(contender.pragma('busy_timeout', { simple: true })).toBe(0);
    expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
    expect(calls).toEqual([]);
  });

  it('PRAGMA busy_timeout replaces the handler', () => {
    holdWriteLock();
    const contender = open();
    const calls: number[] = [];
    sqliteBusy.setBusyHandler(contender, (n) => { calls.push(n); return true; });
    contender.pragma('busy_timeout = 20');
    expect(contender.pragma('busy_timeout', { simple: true })).toBe(20);
    expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
    expect(calls).toEqual([]);
  });

  it('a throwing handler is false for that step (rusqlite busy.rs:60 catch_unwind→false): SQLITE_BUSY, the thrown value is never rethrown', () => {
    holdWriteLock();
    const contender = open();
    const thrown = new Error('handler failed');
    const calls: number[] = [];
    let reentry: unknown;
    sqliteBusy.setBusyHandler(contender, (n) => {
      calls.push(n);
      try { sqliteBusy.setBusyHandler(contender, null); } catch (error) { reentry = error; }
      throw thrown;
    });
    let failure: unknown;
    try { contender.exec('BEGIN IMMEDIATE'); } catch (error) { failure = error; }
    expect(failure).toEqual(expect.objectContaining({ code: 'SQLITE_BUSY', message: 'database is locked' }));
    expect(failure).not.toBe(thrown);
    expect(calls).toEqual([0]);
    expect(reentry).toEqual(new TypeError('This database connection is busy executing a query'));
    expect(contender.inTransaction).toBe(false);
    // No JS exception is left pending: the next statement and the next N-API call into the binding succeed.
    expect(contender.prepare('SELECT 1').pluck().get()).toBe(1);
    expect(() => sqliteBusy.setBusyHandler(contender, null)).not.toThrow();
  });

  it('a throwing handler leaves SQLite\'s own result: PRAGMA wal_checkpoint(RESTART) returns its row with busy = 1', () => {
    const writer = open();
    expect(writer.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
    writer.exec('CREATE TABLE lock_probe(value INTEGER)');
    writer.exec('INSERT INTO lock_probe VALUES (1)');
    writer.exec('BEGIN IMMEDIATE');
    writer.exec('INSERT INTO lock_probe VALUES (2)');
    const contender = open();
    const calls: number[] = [];
    sqliteBusy.setBusyHandler(contender, (n) => { calls.push(n); throw new Error('handler failed'); });
    const rows = contender.pragma('wal_checkpoint(RESTART)') as Array<Record<string, number>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.busy).toBe(1);
    expect(calls).toEqual([0]);
    expect(writer.inTransaction).toBe(true);
    writer.exec('COMMIT');
  });

  it('a non-boolean return is false, not a truthy wait, and is not reported as an error', () => {
    holdWriteLock();
    const contender = open();
    const calls: number[] = [];
    sqliteBusy.setBusyHandler(contender, ((n: number) => { calls.push(n); return 1; }) as unknown as (n: number) => boolean);
    expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
    expect(calls).toEqual([0]);
    expect(contender.prepare('SELECT 1').pluck().get()).toBe(1);
  });

  it('after a throwing handler, a replacement handler is installed and called on the next contention', () => {
    holdWriteLock();
    const contender = open();
    sqliteBusy.setBusyHandler(contender, () => { throw new Error('old'); });
    expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
    const calls: number[] = [];
    sqliteBusy.setBusyHandler(contender, (n) => { calls.push(n); return n < 1; });
    expect(() => contender.exec('BEGIN IMMEDIATE')).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
    expect(calls).toEqual([0, 1]);
  });

  for (const release of ['replace', 'null', 'close'] as const) {
    it(`${release} releases the native reference to the handler`, async () => {
      const contender = open();
      const ref = (() => {
        const handler = (): boolean => false;
        sqliteBusy.setBusyHandler(contender, handler);
        return new WeakRef(handler);
      })();
      // Only the native reference keeps the handler alive here.
      expect(await collected(ref)).toBe(false);
      if (release === 'replace') sqliteBusy.setBusyHandler(contender, () => true);
      else if (release === 'null') sqliteBusy.setBusyHandler(contender, null);
      else contender.close();
      expect(await collected(ref)).toBe(true);
    });
  }

  it('rejects a closed connection and a non-function handler with the binding errors', () => {
    const contender = open();
    expect(() => sqliteBusy.setBusyHandler(contender, 5 as unknown as null)).toThrow(new TypeError('Expected a function or null'));
    contender.close();
    expect(() => sqliteBusy.setBusyHandler(contender, () => true)).toThrow(new TypeError('The database connection is not open'));
  });
});
