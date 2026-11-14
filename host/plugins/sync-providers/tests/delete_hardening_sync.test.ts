/**
 * [L20-engine port] `sync_r05_regression_tests.rs` database-side cases.
 *
 * Ports the slow-clock DELETE conflict recording, unparseable changed_at
 * quarantine and fresh-delete control onto the published L20 engine. The Rust
 * fixture `items` becomes `test_items` for the public engine's explicit
 * test-fixture allowance; the two record-upload E2EE cases stay pending
 * because they need the provider manager's upload policy, not row apply.
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

function newDb(): DatabaseHandle {
  const dir = join(root, `case-${handles.length}`);
  mkdirSync(dir, { recursive: true });
  caseDirs.push(dir);
  const db = storage.openFile(join(dir, 'delete.db'), { profile: 'plain' });
  handles.push(db);
  db.exec(`
    CREATE TABLE test_items (id TEXT PRIMARY KEY, content TEXT, updated_at TEXT);
    CREATE TABLE __change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      sync_version INTEGER DEFAULT 0
    );
  `);
  return db;
}

function insertRecord(db: DatabaseHandle, id: string, content: string, updatedAt: string): void {
  db.run('INSERT INTO test_items (id, content, updated_at) VALUES (?1,?2,?3)', [id, content, updatedAt]);
}

function deleteChange(recordId: string, changedAt: string, device: string, seq: number): EngineChange {
  return {
    table_name: 'test_items',
    record_id: recordId,
    operation: 'Delete',
    data: null,
    changed_at: changedAt,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: device,
    source_seq: seq,
  };
}

function recordCount(db: DatabaseHandle, id: string): number {
  return Number(db.pluck('SELECT COUNT(*) FROM test_items WHERE id=?1', [id]) ?? 0);
}

const context = { deviceId: DEVICE_ID, allowSyncTestFixtureTables: true } as const;

function applyWithGuard(
  db: DatabaseHandle,
  changes: readonly EngineChange[],
  cloudDevice: string,
  localDevice: string,
) {
  return host.ctx.sync.applyDownloadedChangesWithConflictGuard(db, changes, context, {
    policy: 'KeepLatest', cloudDeviceId: cloudDevice, localDeviceId: localDevice,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-delete-sync-'));
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

describe('sync R05 delete hardening', () => {
  it('r05_slow_clock_delete_losing_lww_lands_in_sync_conflicts', () => {
    const db = newDb();
    insertRecord(db, 'rec-1', 'newer-local', '2026-07-10T13:00:00Z');
    const staleDelete = deleteChange('rec-1', '2026-07-10T12:00:00Z', 'device-slow', 1);
    for (let round = 0; round < 2; round += 1) {
      const { apply } = applyWithGuard(db, [staleDelete], 'device-slow', 'device-local');
      expect(apply.success_count).toBe(0);
      expect(apply.failure_count).toBe(0);
      expect(apply.skipped_count).toBe(1);
    }
    expect(recordCount(db, 'rec-1')).toBe(1);
    expect(db.pluck("SELECT content FROM test_items WHERE id='rec-1'")).toBe('newer-local');

    const row = db.one<{
      count: number; side: string; data_json: string;
      losing_device_id: string | null; resolved_at: string | null;
    }>(
      `SELECT COUNT(*) AS count, side, data_json, losing_device_id, resolved_at
       FROM __sync_conflicts WHERE table_name='test_items' AND record_id='rec-1'`,
    );
    expect(Number(row.count)).toBe(1);
    expect(row.side).toBe('cloud');
    expect(row.data_json).toBe('null');
    expect(row.losing_device_id).toBe('device-slow');
    expect(row.resolved_at).toBeNull();
  });

  it('r05_slow_clock_delete_with_local_pending_change_records_both_sides', () => {
    const db = newDb();
    insertRecord(db, 'rec-2', 'local-pending-edit', '2026-07-10T13:00:00Z');
    db.run(
      `INSERT INTO __change_log(table_name, record_id, operation, changed_at, sync_version)
       VALUES('test_items', 'rec-2', 'UPDATE', '2026-07-10T13:00:00Z', 0)`,
    );
    const staleDelete = deleteChange('rec-2', '2026-07-10T12:00:00Z', 'device-slow', 2);
    const { apply, conflict } = applyWithGuard(db, [staleDelete], 'device-slow', 'device-local');
    expect(apply.success_count).toBe(0);
    expect(conflict.rejected).toBe(1);
    expect(conflict.conflicts_saved).toBe(2);
    expect(recordCount(db, 'rec-2')).toBe(1);

    expect(Number(db.pluck(
      `SELECT COUNT(*) FROM __sync_conflicts
       WHERE table_name='test_items' AND record_id='rec-2' AND side='cloud' AND data_json='null'`,
    ) ?? 0)).toBe(1);
    const localSnapshot = String(db.pluck(
      `SELECT data_json FROM __sync_conflicts
       WHERE table_name='test_items' AND record_id='rec-2' AND side='local'`,
    ));
    expect(localSnapshot).toContain('local-pending-edit');
  });

  it('r05_delete_with_unparseable_changed_at_goes_to_quarantine', () => {
    const db = newDb();
    insertRecord(db, 'rec-3', 'must-survive', '2026-07-10T13:00:00Z');
    const badDelete = deleteChange('rec-3', 'not-a-timestamp', 'device-bad-clock', 3);
    const first = applyWithGuard(db, [badDelete], 'device-bad-clock', 'device-local').apply;
    expect(first.success_count).toBe(0);
    expect(first.failure_count).toBe(1);
    expect(recordCount(db, 'rec-3')).toBe(1);

    const row = db.one<{
      count: number; operation: string; error: string;
      payload_json: string | null; attempts: number;
    }>(
      `SELECT COUNT(*) AS count, operation, error, payload_json, attempts
       FROM __sync_quarantine WHERE table_name='test_items' AND record_id='rec-3'`,
    );
    expect(Number(row.count)).toBe(1);
    expect(row.operation).toBe('DELETE');
    expect(row.error).toContain('changed_at');
    expect(String(row.payload_json)).toContain('not-a-timestamp');

    const second = applyWithGuard(db, [badDelete], 'device-bad-clock', 'device-local').apply;
    expect(second.failure_count).toBe(1);
    const after = db.one<{ count: number; attempts: number }>(
      `SELECT COUNT(*) AS count, attempts FROM __sync_quarantine
       WHERE table_name='test_items' AND record_id='rec-3'`,
    );
    expect(Number(after.count)).toBe(1);
    expect(Number(after.attempts)).toBe(Number(row.attempts) + 1);
    expect(recordCount(db, 'rec-3')).toBe(1);
  });

  it('r05_fresh_delete_still_applies_without_conflict_rows', () => {
    const db = newDb();
    insertRecord(db, 'rec-4', 'old-local', '2026-07-10T10:00:00Z');
    const freshDelete = deleteChange('rec-4', '2026-07-10T12:00:00Z', 'device-fast', 4);
    const { apply, conflict } = applyWithGuard(db, [freshDelete], 'device-fast', 'device-local');
    expect(apply.success_count).toBe(1);
    expect(recordCount(db, 'rec-4')).toBe(0);
    expect(conflict.rejected).toBe(0);
    const conflictRows = db.pluck<number>(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='rec-4'",
    ) ?? 0;
    expect(Number(conflictRows)).toBe(0);
  });
});
