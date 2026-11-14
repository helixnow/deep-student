import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Worker, threadId } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStartupDatabase, type StartupDatabase } from '../node.ts';

let dir: string;
const handles: StartupDatabase[] = [];
let worker: Worker | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-busy-capability-'));
});
afterEach(async () => {
  // Cleanup also runs on an assertion failure. The native timeout is finite;
  // terminate is cleanup, not a claim of interrupting sqlite3_step.
  try { await worker?.terminate(); }
  finally {
    worker = undefined;
    for (const db of handles.splice(0)) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function open(label: string): StartupDatabase {
  const db = openStartupDatabase(path.join(dir, 'locks.db'), {
    label, profile: { busyTimeoutMs: 0, synchronous: 'FULL' },
  });
  handles.push(db);
  return db;
}

describe('WP-008 SQLite capability evidence (not the L20b busy-handler port)', () => {
  it('real worker IMMEDIATE returns BUSY without a read lock; explicit retry reads the commit', async () => {
    const writer = open('writer');
    writer.exec('CREATE TABLE lock_probe(value INTEGER)');
    expect(writer.pluck('PRAGMA journal_mode')).toBe('delete');
    worker = new Worker(new URL('./fixtures/busy-capability-worker.ts', import.meta.url), {
      workerData: { path: writer.path },
    });
    const [ready] = await once(worker, 'message');
    expect(ready.kind).toBe('ready');
    expect(ready.threadId).not.toBe(threadId);

    writer.begin('immediate');
    writer.run('INSERT INTO lock_probe VALUES (1)');
    const failed = once(worker, 'message');
    worker.postMessage('attempt');
    const [busy] = await failed;
    expect(busy).toMatchObject({
      kind: 'returned-busy', code: 'SQLITE', sqliteCode: 'SQLITE_BUSY',
      phase: 'execute', inTransaction: false, threadId: ready.threadId,
    });
    expect(writer.inTransaction).toBe(true);
    // The worker's SQL has RETURNED. This does not establish Rust's paused
    // sqlite3_busy_handler barrier, regardless of the measured elapsed time.
    console.info('WP-008 completed-call evidence', busy);
    expect(() => writer.commit()).not.toThrow();
    expect(writer.inTransaction).toBe(false);

    const read = once(worker, 'message');
    worker.postMessage('read');
    expect((await read)[0]).toEqual({ kind: 'read', value: 1, inTransaction: false });
    const closed = once(worker, 'message');
    const exited = once(worker, 'exit');
    worker.postMessage('close');
    expect((await closed)[0]).toEqual({ kind: 'closed' });
    expect((await exited)[0]).toBe(0);
    worker = undefined;
    // Successful acquisition after close proves that no worker transaction remains.
    writer.begin('exclusive');
    writer.rollback();
    expect(writer.inTransaction).toBe(false);
  });

  it('DEFERRED read-to-write BUSY leaves a read lock until rollback/close (negative control)', () => {
    const writer = open('writer');
    writer.exec('CREATE TABLE lock_probe(value INTEGER)');
    const contender = open('contender');
    expect(contender.pluck('PRAGMA journal_mode')).toBe('delete');
    writer.begin('immediate');
    writer.run('INSERT INTO lock_probe VALUES (1)');
    contender.begin('deferred');
    expect(contender.pluck('SELECT COUNT(*) FROM lock_probe')).toBe(0);
    expect(() => contender.run('INSERT INTO lock_probe VALUES (2)'))
      .toThrow(expect.objectContaining({ sqliteCode: 'SQLITE_BUSY', phase: 'execute' }));
    expect(contender.inTransaction).toBe(true);
    expect(() => writer.commit()).toThrow(expect.objectContaining({ sqliteCode: 'SQLITE_BUSY' }));
    expect(writer.inTransaction).toBe(true);
    contender.rollback();
    expect(contender.inTransaction).toBe(false);
    expect(() => writer.commit()).not.toThrow();
    expect(writer.pluck('SELECT COUNT(*) FROM lock_probe')).toBe(1);

    contender.begin('immediate');
    contender.run('INSERT INTO lock_probe VALUES (3)');
    contender.close();
    writer.begin('exclusive');
    expect(writer.pluck('SELECT COUNT(*) FROM lock_probe')).toBe(1);
    writer.rollback();
  });
});
