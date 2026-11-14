import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseWorkerPool, type DatabaseWorkerPool } from '../node.ts';
import { createStorageService, type StorageServiceImpl } from '../service.ts';
import { setStorageLogger } from '../logging.ts';

let base: string;
let service: StorageServiceImpl;
let pool: DatabaseWorkerPool | undefined;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-worker-'));
  service = createStorageService({ baseDir: base, dataLocalDir: base });
});
afterEach(async () => {
  await pool?.close();
  pool = undefined;
  service.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

function createPool(tasks: readonly string[] = ['probe', 'rollback', 'business_error', 'string_error', 'delay']): DatabaseWorkerPool {
  pool = createDatabaseWorkerPool({
    baseDir: base,
    dataLocalDir: base,
    taskModule: new URL('./fixtures/database-worker-tasks.ts', import.meta.url),
    tasks,
    size: 1,
    timeoutMs: 20_000,
  });
  return pool;
}

describe('database worker execution seam (L13b R13-02)', () => {
  it('runs sqlite work on a different thread and returns the committed value', async () => {
    const worker = createPool();
    const result = await worker.run<{ threadId: number; value: string }>('probe', { value: 'worker-wrote' }, { database: 'vfs' });
    expect(result.threadId).not.toBe(threadId);
    expect(result.value).toBe('worker-wrote');
    expect(service.database('vfs').pluck<string>('SELECT value FROM worker_probe WHERE id = 1')).toBe('worker-wrote');
  });

  it('keeps business Err payloads intact across the thread boundary', async () => {
    const worker = createPool();
    const todoError = await worker.run('business_error', null, { database: 'vfs' }).catch((error: unknown) => error);
    expect(todoError).toMatchObject({
      value: { code: 'VFS_NOT_FOUND', message: 'missing todo', data: { itemType: 'todo' }, traceId: 't-1' },
    });

    const pomodoroError = await worker.run('string_error', null, { database: 'vfs' }).catch((error: unknown) => error);
    expect(pomodoroError).toMatchObject({ value: 'PomodoroRecord not found: pd_missing' });
  });

  it('rolls back a failed task transaction inside the worker', async () => {
    const worker = createPool();
    await expect(worker.run('rollback', null, { database: 'vfs' })).rejects.toThrow('business transaction failed');
    expect(service.database('vfs').pluck<number>('SELECT COUNT(*) FROM worker_rollback')).toBe(0);
  });

  it('pause drains in-flight work, terminates workers, and holds queued tasks until resume', async () => {
    const worker = createPool();
    const first = worker.run<string>('delay', { ms: 250 }, { database: 'vfs' });
    const second = worker.run<{ value: string }>('probe', { value: 'after-maintenance' }, { database: 'vfs' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.pause();
    await expect(first).resolves.toBe('done');

    let settled = false;
    void second.finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    worker.resume();
    await expect(second).resolves.toEqual(expect.objectContaining({ value: 'after-maintenance' }));
    expect(worker.size).toBe(1);
  });

  it('is paused and resumed through the parent storage maintenance participant', async () => {
    const worker = createPool();
    service.database('vfs');
    const off = service.registerMaintenanceParticipant('worker-pool', {
      databases: ['vfs'],
      enterMaintenance: () => worker.pause(),
      exitMaintenance: () => worker.resume(),
    });
    await expect(worker.run<string>('delay', { ms: 1 }, { database: 'vfs' })).resolves.toBe('done');

    const lease = await service.enterMaintenance(['vfs']);
    expect(() => service.database('vfs')).toThrow(expect.objectContaining({ code: 'MAINTENANCE' }));
    const during = worker.run<{ value: string }>('probe', { value: 'during' }, { database: 'vfs' });
    let settled = false;
    void during.finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    lease.release();
    await expect(during).resolves.toEqual(expect.objectContaining({ value: 'during' }));
    off();
  });

  it('rejects unknown tasks before spawning work (no SQL channel)', async () => {
    const worker = createPool(['probe']);
    await expect(worker.run('SELECT * FROM anything', null, { database: 'vfs' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAM' });
    expect(worker.size).toBe(1);
  });

  it('R4-SYNC-06 opens only existing core databases inside one real worker task', async () => {
    const activeDir = service.locations.activeDir;
    for (const name of ['vfs', 'chat_v2'] as const) {
      const db = service.database(name);
      db.exec('CREATE TABLE export_probe(value TEXT)');
      db.run('INSERT INTO export_probe VALUES (?)', [name]);
    }
    const worker = createPool(['collect_existing']);
    const result = await worker.runWithDatabases<{ threadId: number; values: Array<string | null>; writes: string[] }>(
      'collect_existing', null,
      { activeDir, databases: ['vfs', 'llm_usage', 'chat_v2', 'mistakes'], timeoutMs: 0 },
    );
    expect(result.threadId).not.toBe(threadId);
    expect(result.values).toEqual(['vfs', null, 'chat_v2', null]);
    expect(result.writes).toEqual(['SQLITE_READONLY', 'SQLITE_READONLY']);
    expect(fs.existsSync(path.join(activeDir, 'llm_usage.db'))).toBe(false);
    expect(fs.existsSync(path.join(activeDir, 'mistakes.db'))).toBe(false);
    expect(service.database('vfs').pluck('SELECT value FROM export_probe')).toBe('vfs');
  });

  it('R4-SYNC-06 missing roots remain absent; open-existing failures are not hidden as missing', async () => {
    const activeDir = path.join(base, 'absent');
    const worker = createPool(['collect_existing']);
    const result = await worker.runWithDatabases<{ values: unknown[] }>('collect_existing', null, {
      activeDir, databases: ['vfs', 'llm_usage', 'chat_v2', 'mistakes'],
    });
    expect(result.values).toEqual([null, null, null, null]);
    expect(fs.existsSync(activeDir)).toBe(false);
    fs.mkdirSync(activeDir);
    fs.writeFileSync(path.join(activeDir, 'vfs.db'), 'not used: vfs lives in databases');
    fs.mkdirSync(path.join(activeDir, 'databases'));
    fs.writeFileSync(path.join(activeDir, 'databases/vfs.db'), 'not a database');
    await expect(worker.runWithDatabases('collect_existing', null, {
      activeDir, databases: ['vfs', 'llm_usage', 'chat_v2', 'mistakes'],
    })).rejects.toMatchObject({ sqliteCode: 'SQLITE_NOTADB' });
  });

  it('R4-SYNC-06 closes multi-database handles after success and failure', async () => {
    const activeDir = service.locations.activeDir;
    service.database('vfs').exec('CREATE TABLE export_probe(value TEXT)');
    const worker = createPool(['retain_existing', 'retained_is_closed']);
    for (const fail of [false, true]) {
      const run = worker.runWithDatabases('retain_existing', { fail }, { activeDir, databases: ['vfs'] });
      if (fail) await expect(run).rejects.toThrow('export failed');
      else await expect(run).resolves.toBe(true);
      expect(await worker.runWithDatabases('retained_is_closed', null, { activeDir, databases: ['vfs'] })).toBe(true);
    }
  });

  it('R4-SYNC-06 explicit read-write-existing preserves open_sync_connection mode without creating missing files', async () => {
    const activeDir = service.locations.activeDir;
    service.database('vfs').exec("CREATE TABLE export_probe(value TEXT); INSERT INTO export_probe VALUES ('initial')");
    const worker = createPool(['write_existing']);
    expect(await worker.runWithDatabases('write_existing', null, { activeDir, databases: ['vfs', 'mistakes'] }))
      .toEqual({ missing: true, timeout: 5000, value: 'rw-existing' });
    expect(fs.existsSync(path.join(activeDir, 'mistakes.db'))).toBe(false);
  });

  it('R4-SYNC-06 forwards worker warnings to the Host logger before returning the result', async () => {
    const logs: string[] = [];
    setStorageLogger(target => ({
      target, warn: message => logs.push(`${target}: ${message}`),
      debug() {}, info() {}, error() {}, trace() {},
    }));
    try {
      const worker = createPool(['report_warning']);
      expect(await worker.runWithDatabases('report_warning', null, { activeDir: base, databases: [] })).toBe('continued');
      expect(logs).toEqual(['dstu_sync::data_governance: 补全数据库 vfs 变更数据失败: missing row']);
    } finally { setStorageLogger(null); }
  });

  it('WP-140 openFile builds a task-owned collection connection in the worker with StorageService.openFile defaults', async () => {
    const file = path.join(base, 'apkg-tmp', 'nested', 'collection.anki2');
    const worker = createPool(['collection_write', 'collection_read']);
    const written = await worker.runWithDatabases<Record<string, unknown>>('collection_write', { file }, { activeDir: base, databases: [] });
    const host = service.openFile(file);
    try {
      expect(written).toEqual({
        threadId: expect.any(Number),
        name: 'collection.anki2',
        synchronous: host.pluck('PRAGMA synchronous'),
        busyTimeout: host.pluck('PRAGMA busy_timeout'),
        journalMode: 'delete',
        secondConnection: 'front\u001fback',
      });
      expect(written.threadId).not.toBe(threadId);
      expect([written.synchronous, written.busyTimeout]).toEqual([2, 5000]);
      // Committed by the worker connection, visible to an independent Host connection.
      expect(host.pluck('SELECT flds FROM notes WHERE id = 1')).toBe('front\u001fback');
      host.run("INSERT INTO notes (id, flds) VALUES (3, 'host')");
    } finally { service.close(host); }
    expect(await worker.runWithDatabases('collection_read', { file, options: { mustExist: true } }, { activeDir: base, databases: [] }))
      .toEqual({ rows: [{ id: 1, flds: 'front\u001fback' }, { id: 3, flds: 'host' }], afterClose: 'TX_CLOSED' });
  });

  it('WP-140 openFile path errors match StorageService.openFile', async () => {
    const worker = createPool(['collection_read']);
    const cases = [
      { file: path.join(base, 'missing.anki2'), options: { mustExist: true } },
      { file: path.join(base, 'no-parent', 'collection.anki2'), options: { createParentDirs: false } },
    ];
    for (const { file, options } of cases) {
      let expected: Record<string, unknown> | undefined;
      try { service.openFile(file, options); } catch (error) {
        const e = error as { name: string; code?: unknown; sqliteCode?: unknown; message: string };
        expected = { name: e.name, code: e.code, sqliteCode: e.sqliteCode, message: e.message };
      }
      expect(expected).toBeDefined();
      expect(await worker.runWithDatabases('collection_read', { file, options }, { activeDir: base, databases: [] }))
        .toEqual({ error: expected });
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it('WP-140 openFile handles close after task success and failure', async () => {
    const file = path.join(base, 'collection.anki2');
    const seed = service.openFile(file);
    seed.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, flds TEXT NOT NULL)');
    service.close(seed);
    const worker = createPool(['retain_file', 'retained_file_is_closed']);
    for (const fail of [false, true]) {
      const run = worker.runWithDatabases('retain_file', { file, fail }, { activeDir: base, databases: [] });
      if (fail) await expect(run).rejects.toThrow('apkg parse failed');
      else await expect(run).resolves.toBe('parsed');
      expect(await worker.runWithDatabases('retained_file_is_closed', null, { activeDir: base, databases: [] })).toBe(true);
    }
  });

  it('WP-140 rejects task results that carry a database handle', async () => {
    const file = path.join(base, 'collection.anki2');
    const worker = createPool(['return_handle']);
    for (const nested of [false, true]) {
      await expect(worker.runWithDatabases('return_handle', { file, nested }, { activeDir: base, databases: [] }))
        .rejects.toMatchObject({ code: 'INVALID_PARAM', message: 'database worker task result must not contain a database handle or driver connection' });
    }
  });

  it('WP-140 aborting a task terminates the worker and releases its openFile connection', async () => {
    const file = path.join(base, 'collection.anki2');
    const seed = service.openFile(file);
    seed.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, flds TEXT NOT NULL); INSERT INTO notes VALUES (1, 'kept')");
    service.close(seed);
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    setStorageLogger(target => ({
      target, info: (message) => { if (message === 'write lock held') locked(); },
      debug() {}, warn() {}, error() {}, trace() {},
    }));
    const probe = service.openFile(file, { profile: { busyTimeoutMs: 0, synchronous: 'FULL' } });
    try {
      const worker = createPool(['hold_write_lock']);
      const controller = new AbortController();
      const run = worker.runWithDatabases('hold_write_lock', { file }, { activeDir: base, databases: [], signal: controller.signal });
      await lockHeld;
      expect(() => probe.exec('BEGIN IMMEDIATE')).toThrow(expect.objectContaining({ sqliteCode: 'SQLITE_BUSY' }));
      controller.abort();
      await expect(run).rejects.toMatchObject({ code: 'ABORTED' });
      await vi.waitFor(() => { probe.exec('BEGIN IMMEDIATE'); }, { timeout: 5000 });
      probe.exec('ROLLBACK');
      expect(probe.all('SELECT id, flds FROM notes ORDER BY id')).toEqual([{ id: 1, flds: 'kept' }]);
    } finally {
      service.close(probe);
      setStorageLogger(null);
    }
  });
});
