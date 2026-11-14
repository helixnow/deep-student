import type { DatabaseHandle, DatabaseWorkerTasks, MultiDatabaseWorkerTasks } from '../../api.ts';

export const workerTasks: DatabaseWorkerTasks = {
  probe({ db, payload, threadId }) {
    const value = (payload as { value?: string }).value ?? 'default';
    db.exec('CREATE TABLE IF NOT EXISTS worker_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.run('INSERT INTO worker_probe (id, value) VALUES (?, ?)', [1, value]);
    return {
      threadId,
      value: db.pluck<string>('SELECT value FROM worker_probe WHERE id = 1'),
    };
  },
  rollback({ db }) {
    db.exec('CREATE TABLE IF NOT EXISTS worker_rollback (id INTEGER PRIMARY KEY)');
    db.transaction((tx) => {
      tx.run('INSERT INTO worker_rollback (id) VALUES (1)');
      throw new Error('business transaction failed');
    });
    return 'not reached';
  },
  async delay({ payload }) {
    const ms = Number((payload as { ms?: number }).ms ?? 0);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return 'done';
  },
  business_error() {
    throw Object.assign(new Error('missing todo'), {
      value: { code: 'VFS_NOT_FOUND', message: 'missing todo', data: { itemType: 'todo' }, traceId: 't-1' },
    });
  },
  string_error() {
    throw 'PomodoroRecord not found: pd_missing';
  },
};

let retained: DatabaseHandle | undefined;
let retainedFile: DatabaseHandle | undefined;

function openFileError(error: unknown): unknown {
  const e = error as { name: string; code?: unknown; sqliteCode?: unknown; message: string };
  return { name: e.name, code: e.code, sqliteCode: e.sqliteCode, message: e.message };
}
export const multiDatabaseWorkerTasks: MultiDatabaseWorkerTasks = {
  report_warning({ log }) {
    log('dstu_sync::data_governance', 'warn', '补全数据库 vfs 变更数据失败: missing row');
    return 'continued';
  },
  write_existing({ openExisting }) {
    const missing = openExisting('mistakes', { readonly: false });
    const db = openExisting('vfs', { readonly: false })!;
    db.run("UPDATE export_probe SET value = 'rw-existing'");
    return { missing: missing === undefined, timeout: db.pluck('PRAGMA busy_timeout'), value: db.pluck('SELECT value FROM export_probe') };
  },
  collect_existing({ openExisting, threadId }) {
    const values: Array<string | null> = [];
    const writes: string[] = [];
    for (const name of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
      const db = openExisting(name);
      values.push(db?.pluck<string>('SELECT value FROM export_probe') ?? null);
      if (db) {
        try { db.run("UPDATE export_probe SET value = 'changed'"); }
        catch (error) { writes.push(String((error as { sqliteCode: string }).sqliteCode)); }
      }
    }
    return { threadId, values, writes };
  },
  retain_existing({ openExisting, payload }) {
    retained = openExisting('vfs');
    if ((payload as { fail: boolean }).fail) throw new Error('export failed');
    return retained !== undefined;
  },
  collection_write({ openFile, payload, threadId }) {
    const { file } = payload as { file: string };
    const db = openFile(file);
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, flds TEXT NOT NULL)');
    db.run('INSERT INTO notes (id, flds) VALUES (?1, ?2)', [1, 'front\u001fback']);
    const reader = openFile(file, { profile: { readonly: true, busyTimeoutMs: 5000 } });
    return {
      threadId,
      name: db.name,
      synchronous: db.pluck('PRAGMA synchronous'),
      busyTimeout: db.pluck('PRAGMA busy_timeout'),
      journalMode: db.pluck('PRAGMA journal_mode'),
      secondConnection: reader.pluck('SELECT flds FROM notes WHERE id = 1'),
    };
  },
  collection_read({ openFile, close, payload }) {
    const { file, options } = payload as { file: string; options?: Parameters<typeof openFile>[1] };
    let db: DatabaseHandle;
    try { db = openFile(file, options); }
    catch (error) { return { error: openFileError(error) }; }
    const rows = db.all('SELECT id, flds FROM notes ORDER BY id');
    close(db);
    let afterClose: unknown;
    try { db.pluck('SELECT 1'); } catch (error) { afterClose = (error as { code: string }).code; }
    return { rows, afterClose };
  },
  retain_file({ openFile, payload }) {
    const { file, fail } = payload as { file: string; fail: boolean };
    retainedFile = openFile(file);
    retainedFile.pluck('SELECT count(*) FROM notes');
    if (fail) throw new Error('apkg parse failed');
    return 'parsed';
  },
  retained_file_is_closed() {
    try { retainedFile!.pluck('SELECT 1'); return false; }
    catch (error) { return (error as { code: string }).code === 'TX_CLOSED'; }
  },
  return_handle({ openFile, payload }) {
    const { file, nested } = payload as { file: string; nested: boolean };
    const db = openFile(file);
    return nested ? { ok: true, items: [db] } : db;
  },
  async hold_write_lock({ openFile, payload, log }) {
    const { file } = payload as { file: string };
    const db = openFile(file);
    db.exec('BEGIN IMMEDIATE');
    db.run('INSERT INTO notes (id, flds) VALUES (2, ?1)', ['uncommitted']);
    log('dstu_anki::apkg', 'info', 'write lock held');
    await new Promise(() => undefined);
  },
  retained_is_closed() {
    try { retained!.pluck('SELECT 1'); return false; }
    catch (error) { return (error as { code: string }).code === 'TX_CLOSED'; }
  },
};
