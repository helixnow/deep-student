/**
 * [L20-engine port] `sync_r02_hardening_tests.rs`.
 *
 * Two devices exchange real pending→enriched payloads for notes tag/favorite
 * merge, a composite-PK hard-delete LWW ledger, and slow-clock conflict
 * deduplication. The Rust fixture table `items` becomes `test_items` to use
 * the published engine's explicit test-fixture allowance; assertions are
 * unchanged.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageService } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';

const DEVICE_ID = 'device-local';
let root: string;
let storage: StorageService;
let host: TestHost;
const handles: DatabaseHandle[] = [];
const caseDirs: string[] = [];

function unused(service: string): object {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`test unexpectedly entered ${service}.${String(key)}`);
    },
  });
}

function newHandle(): DatabaseHandle {
  const dir = join(root, `case-${handles.length}`);
  mkdirSync(dir, { recursive: true });
  caseDirs.push(dir);
  const db = storage.openFile(join(dir, 'hardening.db'), { profile: 'plain' });
  handles.push(db);
  return db;
}

const NOTES_SCHEMA = `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL DEFAULT '',
    tags TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER DEFAULT 0
  );
  CREATE TRIGGER trg_notes_ins AFTER INSERT ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('notes', NEW.id, 'INSERT', NEW.updated_at);
  END;
  CREATE TRIGGER trg_notes_upd AFTER UPDATE ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('notes', NEW.id, 'UPDATE', NEW.updated_at);
  END;
`;

function newNotesDb(): DatabaseHandle {
  const db = newHandle();
  db.exec(NOTES_SCHEMA);
  return db;
}

function newCompositeDb(): DatabaseHandle {
  const db = newHandle();
  db.exec(`
    CREATE TABLE test_items (
      id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, tag_id)
    );
    CREATE TABLE __change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      sync_version INTEGER DEFAULT 0
    );
  `);
  return db;
}

function insertNote(
  db: DatabaseHandle, id: string, body: string, tags: string, favorite: number, updatedAt: string,
): void {
  db.run(
    'INSERT INTO notes (id, body, tags, is_favorite, updated_at) VALUES (?1,?2,?3,?4,?5)',
    [id, body, tags, favorite, updatedAt],
  );
}

function noteRow(db: DatabaseHandle, id: string): { tags: string; favorite: number; updatedAt: string } {
  const row = db.one<{ tags: string; is_favorite: number; updated_at: string }>(
    'SELECT tags, is_favorite, updated_at FROM notes WHERE id=?1', [id],
  );
  return { tags: row.tags, favorite: Number(row.is_favorite), updatedAt: row.updated_at };
}

function markAllSynced(db: DatabaseHandle): void {
  db.run('UPDATE __change_log SET sync_version=?1 WHERE sync_version=0', [Math.floor(Date.now() / 1000)]);
}

function pendingCount(db: DatabaseHandle): number {
  return Number(db.pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0);
}

function outboundChanges(db: DatabaseHandle, deviceId: string): EngineChange[] {
  const pending = host.ctx.sync.getPendingChanges(db, null, null);
  const changes = host.ctx.sync.enrichChangesWithData(db, pending.entries, null);
  for (const change of changes) change.source_device_id = deviceId;
  return changes;
}

const context = { deviceId: DEVICE_ID, allowSyncTestFixtureTables: true } as const;

function applyFromCloud(
  db: DatabaseHandle,
  changes: readonly EngineChange[],
  cloudDevice: string,
  localDevice: string,
) {
  return host.ctx.sync.applyDownloadedChangesWithConflictGuard(db, changes, context, {
    policy: 'KeepLatest', cloudDeviceId: cloudDevice, localDeviceId: localDevice,
  });
}

function change(overrides: Partial<EngineChange>): EngineChange {
  return {
    table_name: 'notes', record_id: '', operation: 'Update', data: null,
    changed_at: '2026-03-01T00:00:00Z', change_log_id: null,
    database_name: 'vfs', suppress_change_log: true,
    source_device_id: null, source_seq: null,
    ...overrides,
  } as EngineChange;
}

function junctionDeleteChange(recordId: string, changedAt: string, device: string, seq: number): EngineChange {
  return change({
    table_name: 'test_items', record_id: recordId, operation: 'Delete',
    data: null, changed_at: changedAt, source_device_id: device, source_seq: seq,
  });
}

function junctionRowCount(db: DatabaseHandle): number {
  return Number(db.pluck("SELECT COUNT(*) FROM test_items WHERE id='n1' AND tag_id='t1'") ?? 0);
}

function deleteVersionCount(db: DatabaseHandle, recordId: string): number {
  const exists = Number(db.pluck<number>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_delete_versions')",
  ) ?? 0) !== 0;
  if (!exists) return 0;
  return Number(db.pluck<number>(
    "SELECT COUNT(*) FROM __sync_delete_versions WHERE table_name='test_items' AND record_id=?1",
    [recordId],
  ) ?? 0);
}

function slowClockUpsert(body: string, payloadTs: string, changedAt: string, seq: number): EngineChange {
  return change({
    record_id: 'note-slow', operation: 'Update', changed_at: changedAt,
    data: { id: 'note-slow', body, tags: '[]', is_favorite: 0, updated_at: payloadTs },
    source_device_id: 'device-slow', source_seq: seq,
  });
}

function cloudSideConflictCount(db: DatabaseHandle): number {
  return Number(db.pluck<number>(
    `SELECT COUNT(*) FROM __sync_conflicts
     WHERE table_name='notes' AND record_id='note-slow' AND side='cloud' AND resolved_at IS NULL`,
  ) ?? 0);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-hardening-sync-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  host = await createTestHost();
  host.ctx.provide('storage', storage);
  host.ctx.provide('paths', { deviceId: async () => DEVICE_ID });
  host.ctx.provide('secrets', { backup: createBackupCrypto() });
  host.ctx.provide('nativeCompression', compression);
  host.ctx.provide('backup', unused('backup'));
  host.ctx.provide('syncProvider', unused('syncProvider'));
  host.ctx.provide('syncSupport', unused('syncSupport'));
  host.ctx.provide('vfsDatabase', { isInMaintenanceMode: () => false });
  host.ctx.provide('notes', unused('notes'));
  host.ctx.provide('vfsRepo', unused('vfsRepo'));
  // These engine-only cases never enter the mastery rebuild/import path.
  host.ctx.provide('mastery', unused('mastery'));
  await host.install(sync);
});

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { storage.close(handle); } catch { /* already closed */ }
  }
  for (const dir of caseDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await host?.dispose();
  (storage as StorageService & { dispose(): void } | undefined)?.dispose();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('sync R02 hardening', () => {
  it('r02x_two_device_tag_union_converges_when_both_sides_have_pending', () => {
    const devA = newNotesDb();
    const devB = newNotesDb();
    insertNote(devA, 'note-1', 'shared', '["alpha"]', 1, '2026-03-01T10:00:00Z');
    insertNote(devB, 'note-1', 'shared', '["beta"]', 0, '2026-03-01T09:00:00Z');
    expect(pendingCount(devA)).toBe(1);
    expect(pendingCount(devB)).toBe(1);

    const fromA = outboundChanges(devA, 'device-a');
    const fromB = outboundChanges(devB, 'device-b');
    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);

    const { apply: resultB, conflict: conflictB } = applyFromCloud(devB, fromA, 'device-a', 'device-b');
    const { apply: resultA, conflict: conflictA } = applyFromCloud(devA, fromB, 'device-b', 'device-a');
    expect(resultB.success_count).toBe(1);
    expect(conflictB.conflicts_saved).toBeGreaterThan(0);
    expect(resultA.success_count).toBe(0);
    expect(conflictA.rejected).toBe(1);

    const rowA = noteRow(devA, 'note-1');
    const rowB = noteRow(devB, 'note-1');
    expect(rowA.tags).toBe('["alpha","beta"]');
    expect(rowB.tags).toBe('["alpha","beta"]');
    expect(rowA.favorite).toBe(1);
    expect(rowB.favorite).toBe(1);
    expect(rowA.updatedAt).toBe('2026-03-01T10:00:00Z');
    expect(rowB.updatedAt).toBe('2026-03-01T10:00:00Z');

    const nextFromB = outboundChanges(devB, 'device-b');
    expect(nextFromB.length).toBeGreaterThan(0);
    for (const outbound of nextFromB) {
      const data = outbound.data as { tags?: string };
      expect(data.tags).toBe('["alpha","beta"]');
    }
  });

  it('r02x_local_win_fold_lands_in_next_upload_payload', () => {
    const db = newNotesDb();
    insertNote(db, 'note-fold', 'shared', '["local"]', 0, '2026-03-02T12:00:00Z');
    const before = pendingCount(db);
    expect(before).toBe(1);

    const cloud = change({
      record_id: 'note-fold', operation: 'Update', changed_at: '2026-03-02T11:00:00Z',
      data: {
        id: 'note-fold', body: 'shared', tags: ['remote'], is_favorite: 1,
        updated_at: '2026-03-02T11:00:00Z',
      },
      database_name: 'vfs', source_device_id: 'device-cloud', source_seq: 1,
    });
    const { apply: result, conflict } = applyFromCloud(db, [cloud], 'device-cloud', 'device-local');
    expect(result.success_count).toBe(0);
    expect(conflict.rejected).toBe(1);
    expect(pendingCount(db)).toBeGreaterThan(before);

    const outbound = outboundChanges(db, 'device-local');
    expect(outbound.length).toBeGreaterThan(0);
    for (const item of outbound) {
      expect(item.table_name).toBe('notes');
      expect(item.record_id).toBe('note-fold');
      const data = item.data as { tags?: string; is_favorite?: number; updated_at?: string };
      expect(data.tags).toBe('["local","remote"]');
      expect(data.is_favorite).toBe(1);
      expect(data.updated_at).toBe('2026-03-02T12:00:00Z');
    }
    expect(db.pluck("SELECT body FROM notes WHERE id='note-fold'")).toBe('shared');
  });

  it('r02x_composite_pk_stale_delete_rejected_fresh_delete_applies', () => {
    const db = newCompositeDb();
    const recordId = JSON.stringify({ id: 'n1', tag_id: 't1' });
    db.run("INSERT INTO test_items (id, tag_id, updated_at) VALUES ('n1','t1','2026-04-01T13:00:00Z')");

    const stale = junctionDeleteChange(recordId, '2026-04-01T12:00:00Z', 'device-stale', 1);
    const staleResult = applyFromCloud(db, [stale], 'device-stale', 'device-local');
    expect(staleResult.apply.success_count).toBe(0);
    expect(staleResult.apply.skipped_count).toBe(1);
    expect(junctionRowCount(db)).toBe(1);
    expect(deleteVersionCount(db, recordId)).toBe(0);

    const fresh = junctionDeleteChange(recordId, '2026-04-01T14:00:00Z', 'device-fresh', 2);
    const freshResult = applyFromCloud(db, [fresh], 'device-fresh', 'device-local');
    expect(freshResult.apply.success_count).toBe(1);
    expect(junctionRowCount(db)).toBe(0);
    expect(deleteVersionCount(db, recordId)).toBe(1);

    const lateUpsert = change({
      table_name: 'test_items', record_id: recordId, operation: 'Update',
      changed_at: '2026-04-01T12:30:00Z',
      data: { id: 'n1', tag_id: 't1', updated_at: '2026-04-01T12:30:00Z' },
      database_name: 'vfs', source_device_id: 'device-stale', source_seq: 3,
    });
    const lateResult = applyFromCloud(db, [lateUpsert], 'device-stale', 'device-local');
    expect(lateResult.apply.success_count).toBe(0);
    expect(junctionRowCount(db)).toBe(0);
  });

  it('r02x_slow_clock_loser_recorded_once_across_redeliveries', () => {
    const db = newNotesDb();
    insertNote(db, 'note-slow', 'newer-local', '[]', 0, '2026-05-01T13:00:00Z');
    markAllSynced(db);

    const v1a = slowClockUpsert('slow-v1', '2026-05-01T12:00:00Z', '2026-05-01T12:00:00Z', 1);
    const v1b = slowClockUpsert('slow-v1', '2026-05-01T12:00:00Z', '2026-05-01T11:59:00Z', 2);
    const v1c = slowClockUpsert('slow-v1', '2026-05-01T11:00:00Z', '2026-05-01T11:00:00Z', 3);

    const dup = applyFromCloud(db, [v1a, { ...v1a }], 'device-slow', 'device-local');
    expect(dup.apply.success_count).toBe(0);
    expect(cloudSideConflictCount(db)).toBe(1);

    for (const payload of [v1a, v1b, v1c]) {
      for (let i = 0; i < 3; i += 1) {
        const result = applyFromCloud(db, [payload], 'device-slow', 'device-local');
        expect(result.apply.success_count).toBe(0);
      }
    }
    expect(cloudSideConflictCount(db)).toBe(1);

    const v2 = slowClockUpsert('slow-v2', '2026-05-01T12:30:00Z', '2026-05-01T12:30:00Z', 4);
    expect(applyFromCloud(db, [v2], 'device-slow', 'device-local').apply.success_count).toBe(0);
    expect(cloudSideConflictCount(db)).toBe(2);
    applyFromCloud(db, [v2], 'device-slow', 'device-local');
    expect(cloudSideConflictCount(db)).toBe(2);

    const echo = slowClockUpsert('newer-local', '2026-05-01T12:45:00Z', '2026-05-01T12:45:00Z', 5);
    expect(applyFromCloud(db, [echo], 'device-slow', 'device-local').apply.success_count).toBe(0);
    expect(cloudSideConflictCount(db)).toBe(2);
    expect(db.pluck("SELECT body FROM notes WHERE id='note-slow'")).toBe('newer-local');

    const row = db.one<{ data_json: string; losing_device_id: string | null }>(
      `SELECT data_json, losing_device_id FROM __sync_conflicts
       WHERE table_name='notes' AND record_id='note-slow' AND side='cloud' ORDER BY id LIMIT 1`,
    );
    expect(row.data_json).toContain('slow-v1');
    expect(row.losing_device_id).toBe('device-slow');
  });
});
