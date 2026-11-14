import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createTestHost } from './host-fixture.ts';
import { countUnresolvedConflicts, listUnresolvedConflictRows } from '../repository/conflicts.ts';
import sync from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-conflicts-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.openFile(':memory:');
});
afterEach(() => { storage.dispose(); rmSync(root, { recursive: true, force: true }); });

function conflictsDb(db: DatabaseHandle) {
  db.exec(`CREATE TABLE __sync_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL, record_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('local','cloud')), data_json TEXT NOT NULL,
    data_hash TEXT NOT NULL DEFAULT '', winning_device_id TEXT, losing_device_id TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT, resolution TEXT
  );`);
}
function insert(db: DatabaseHandle, table: string, id: string, side: string, resolved: string | null = null) {
  db.run(`INSERT INTO __sync_conflicts (table_name, record_id, side, data_json, resolved_at)
    VALUES (?1, ?2, ?3, '{}', ?4)`, [table, id, side, resolved]);
}
it('count_and_list_share_group_semantics', () => {
  conflictsDb(conn);
  insert(conn, 'notes', 'a', 'local');
  insert(conn, 'notes', 'a', 'cloud');
  insert(conn, 'notes', 'b', 'cloud');
  insert(conn, 'notes', 'c', 'local', '2026-01-01T00:00:00Z');
  insert(conn, 'notes', 'c', 'cloud', '2026-01-01T00:00:00Z');
  insert(conn, 'tags', 'a', 'local');

  const count = countUnresolvedConflicts(conn);
  const rows = listUnresolvedConflictRows(conn);
  const groups = new Set(rows.map(row => `${row.table_name}\u001f${row.record_id}`));
  expect(count).toEqual({ groups: 3, rows: 4 });
  expect(groups.size).toBe(count.groups);
  expect(rows.length).toBe(count.rows);
});
it('count_unresolved_conflicts_reports_groups_and_rows', () => {
  conflictsDb(conn);
  insert(conn, 'notes', 'a', 'local'); insert(conn, 'notes', 'a', 'cloud');
  insert(conn, 'notes', 'b', 'cloud');
  insert(conn, 'notes', 'c', 'local', '2026-01-01T00:00:00Z');
  insert(conn, 'notes', 'c', 'cloud', '2026-01-01T00:00:00Z');
  insert(conn, 'tags', 'a', 'local');
  expect(countUnresolvedConflicts(conn)).toEqual({ groups: 3, rows: 4 });
});
it('count_unresolved_conflicts_is_zero_without_table_or_rows', () => {
  expect(countUnresolvedConflicts(conn)).toEqual({ groups: 0, rows: 0 });
  conflictsDb(conn);
  expect(countUnresolvedConflicts(conn)).toEqual({ groups: 0, rows: 0 });
  insert(conn, 'notes', 'a', 'local', '2026-01-01T00:00:00Z');
  expect(countUnresolvedConflicts(conn)).toEqual({ groups: 0, rows: 0 });
});
it('aggregates existing databases and preserves count query-error fallback through IPC', async () => {
  const vfs = storage.database('vfs');
  conflictsDb(vfs);
  insert(vfs, 'notes', 'a', 'local'); insert(vfs, 'notes', 'a', 'cloud');
  const chat = storage.database('chat_v2');
  conflictsDb(chat); insert(chat, 'notes', 'a', 'local');
  storage.database('mistakes').exec('CREATE TABLE __sync_conflicts (id INTEGER)');
  const host = await createTestHost({ plugins: [sync], provide: { storage, paths: { deviceId: async () => 'test-device' } } });
  try {
    expect(await host.invoke('data_governance_count_record_conflicts')).toEqual({
      per_database: { vfs: { groups: 1, rows: 2 }, chat_v2: { groups: 1, rows: 1 } },
      total_groups: 2, total_rows: 3,
    });
  } finally { await host.dispose(); }
});
it('discards quarantine rows without changing business data and retains exact errors', async () => {
  const db = storage.database('vfs');
  db.exec('CREATE TABLE __sync_quarantine (id INTEGER PRIMARY KEY); INSERT INTO __sync_quarantine VALUES (1), (2)');
  db.exec("CREATE TABLE notes (id TEXT); INSERT INTO notes VALUES ('keep')");
  const host = await createTestHost({ plugins: [sync], provide: { storage, paths: { deviceId: async () => 'test-device' } } });
  try {
    await expect(host.invoke('data_governance_discard_quarantine', { databaseName: 'bad', quarantineId: 1 })).rejects.toBe('未知数据库: bad');
    await expect(host.invoke('data_governance_discard_quarantine', { databaseName: 'vfs', quarantineId: 1 })).resolves.toBe(true);
    await expect(host.invoke('data_governance_discard_quarantine', { databaseName: 'vfs', quarantineId: 1 })).resolves.toBe(false);
    await expect(host.invoke('data_governance_discard_quarantine', { databaseName: 'chat_v2', quarantineId: 1 })).resolves.toBe(false);
    await expect(host.invoke('data_governance_discard_all_quarantine')).resolves.toEqual({ success: 1, failed: 0, errors: [] });
    expect(db.pluck('SELECT COUNT(*) FROM notes')).toBe(1);
    db.exec("CREATE TRIGGER reject_discard BEFORE DELETE ON __sync_quarantine BEGIN SELECT RAISE(ABORT, 'blocked'); END; INSERT INTO __sync_quarantine VALUES (3)");
    await expect(host.invoke('data_governance_discard_quarantine', { databaseName: 'vfs', quarantineId: 3 })).rejects.toBe('丢弃隔离记录失败: blocked');
    await expect(host.invoke('data_governance_discard_all_quarantine')).rejects.toBe('批量清除失败: blocked');
    expect(db.pluck('SELECT COUNT(*) FROM __sync_quarantine')).toBe(1);
  } finally { await host.dispose(); }
});
