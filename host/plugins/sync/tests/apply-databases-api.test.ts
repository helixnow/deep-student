import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import type { EngineChange } from '../api.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-multidb-api-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const path = storage.pathOf('vfs'); mkdirSync(dirname(path), { recursive: true });
  const db = storage.openFile(path, { profile: 'plain' });
  db.exec(`CREATE TABLE todo_items(id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, deleted_at TEXT, local_version INTEGER DEFAULT 0);
    CREATE TABLE __change_log(id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT, sync_version INTEGER DEFAULT 0);`);
  const open = storage.openFile.bind(storage), timeouts: number[] = [];
  vi.spyOn(storage, 'openFile').mockImplementation((path, options) => {
    const handle = open(path, options); timeouts.push(Number(handle.pluck('PRAGMA busy_timeout'))); return handle;
  });
  const ack = vi.fn();
  const host = await createTestHost({ plugins: [plugin], provide: { storage, paths: { deviceId: async () => 'local' }, syncSupport: { state: { setCursor: ack } } } });
  cleanups.push(async () => { await host.dispose(); storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  const change: EngineChange = { database_name: 'vfs', table_name: 'todo_items', record_id: 'a', operation: 'Insert',
    data: { id: 'a', title: 'remote', updated_at: '2026-01-01T00:00:00Z' }, changed_at: '2026-01-01T00:00:00Z', source_device_id: 'peer' };
  return { storage, db, host, ack, timeouts, change };
}
it('published multi-database apply uses 5000ms connections and returns committed record keys', async () => {
  const f = await fixture();
  const result = await f.host.ctx.sync.applyDownloadedChangesToDatabases([f.change], 'UseCloud');
  expect(result).toMatchObject({ total_success: 1, total_failed: 0, db_errors: [], total_conflicts: 0 });
  expect(result.applied_keys.has('todo_items\u001fa')).toBe(true);
  expect(f.db.pluck("SELECT title FROM todo_items WHERE id='a'")).toBe('remote');
  expect(f.timeouts).toEqual([5000]); expect(f.ack).not.toHaveBeenCalled();
});

it('legacy tables without note history never enter the optional note owner feature', async () => {
  const f = await fixture();
  f.db.exec('CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT,updated_at TEXT)');
  const available = vi.spyOn(f.host.ctx.syncSupport.noteHistory, 'available').mockImplementation(() => { throw new Error('history feature is absent'); });
  try {
    const result = f.host.ctx.sync.applyDownloadedChanges(f.db, [{
      table_name: 'notes', record_id: 'legacy-note', operation: 'Insert', data: { id: 'legacy-note', title: 'legacy', updated_at: '2026-01-01T00:00:00Z' },
      changed_at: '2026-01-01T00:00:00Z', database_name: 'vfs',
    }], { deviceId: 'local' });
    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(0);
    expect(available).not.toHaveBeenCalled();
    expect(f.db.pluck("SELECT title FROM notes WHERE id='legacy-note'")).toBe('legacy');
  } finally { available.mockRestore(); }
});
it.each(['missing', 'unknown', 'ambiguous'] as const)('unpersistable target %s rejects before ack while preserving committed databases', async kind => {
  const f = await fixture();
  const invalid = { ...f.change, record_id: 'bad', database_name: kind === 'missing' ? 'chat_v2' : kind === 'unknown' ? 'unknown-db' : null,
    table_name: kind === 'ambiguous' ? 'resources' : 'chat_v2_sessions' };
  await expect(f.host.ctx.sync.applyDownloadedChangesToDatabases([f.change, invalid], 'UseCloud')).rejects.toThrow('部分数据库应用变更失败');
  expect(f.db.pluck("SELECT title FROM todo_items WHERE id='a'")).toBe('remote');
  expect(existsSync(f.storage.pathOf('chat_v2'))).toBe(false);
  expect(f.ack).not.toHaveBeenCalled();
});
it('Manual keeps the local row and persists both conflict snapshots through the public API', async () => {
  const f = await fixture();
  f.db.exec(`INSERT INTO todo_items VALUES ('a','local','2026-01-01T00:00:00Z',NULL,1);
    INSERT INTO __change_log VALUES(1,'todo_items','a','UPDATE','2026-01-01T00:00:00Z',0);`);
  const result = await f.host.ctx.sync.applyDownloadedChangesToDatabases([{ ...f.change, operation: 'Update' }], 'Manual');
  expect(result.total_conflicts).toBe(2);
  expect(f.db.pluck("SELECT title FROM todo_items WHERE id='a'")).toBe('local');
  expect(f.db.all('SELECT side FROM __sync_conflicts ORDER BY side')).toEqual([{ side: 'cloud' }, { side: 'local' }]);
});
