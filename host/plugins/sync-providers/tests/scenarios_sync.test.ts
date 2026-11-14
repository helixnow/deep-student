/**
 * [L20-engine port] `sync_scenarios_tests.rs` scenarios 01-30.
 *
 * These tests use the published `ctx.sync` engine against an ad-hoc F3 SQLite
 * handle with the original Rust fixture schema (`notes` + `__change_log` +
 * triggers). Only the real sync plugin is installed: the fixture has no
 * note-history tables, so the L10 note-history hooks stay inert exactly as the
 * Rust integration test runs the library outside `cfg(test)`. No apply,
 * conflict or replay algorithm is reimplemented here.
 *
 * Scenario 07 renames `children` to `test_children` so the public engine's
 * test-fixture table allowance (the Rust `#[cfg(test)]` / debug fixture
 * counterpart) is exercised; the FK violation and quarantine assertions are
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
  const db = storage.openFile(join(dir, 'scenario.db'), { profile: 'plain' });
  handles.push(db);
  return db;
}

const FIXTURE_SCHEMA = `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER DEFAULT 0
  );
  CREATE TRIGGER trg_notes_ins AFTER INSERT ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', NEW.id, 'INSERT');
  END;
  CREATE TRIGGER trg_notes_upd AFTER UPDATE ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', NEW.id, 'UPDATE');
  END;
  CREATE TRIGGER trg_notes_del AFTER DELETE ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', OLD.id, 'DELETE');
  END;
  CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
  INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
`;

function newTestDb(): DatabaseHandle {
  const db = newHandle();
  db.exec(FIXTURE_SCHEMA);
  return db;
}

function insertNote(db: DatabaseHandle, id: string, title: string, content: string, updatedAt: string): void {
  db.run(
    "INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?1,?2,?3,'2026-01-01T00:00:00Z',?4)",
    [id, title, content, updatedAt],
  );
}

function updateNote(db: DatabaseHandle, id: string, newTitle: string, updatedAt: string): void {
  db.run('UPDATE notes SET title=?1, updated_at=?2 WHERE id=?3', [newTitle, updatedAt, id]);
}

function markAllSynced(db: DatabaseHandle): void {
  db.run('UPDATE __change_log SET sync_version=?1 WHERE sync_version=0', [Math.floor(Date.now() / 1000)]);
}

function pendingCount(db: DatabaseHandle): number {
  return Number(db.pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0);
}

function getTitle(db: DatabaseHandle, id: string): string | null {
  return db.pluck<string | null>('SELECT title FROM notes WHERE id=?1', [id]) ?? null;
}

function getDeletedAt(db: DatabaseHandle, id: string): string | null {
  return db.pluck<string | null>('SELECT deleted_at FROM notes WHERE id=?1', [id]) ?? null;
}

function countNotes(db: DatabaseHandle): number {
  return Number(db.pluck<number>('SELECT COUNT(*) FROM notes') ?? 0);
}

function tableExists(db: DatabaseHandle, table: string): boolean {
  return Number(db.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table]) ?? 0) !== 0;
}

function conflictCount(db: DatabaseHandle): number {
  return tableExists(db, '__sync_conflicts') ? Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts') ?? 0) : 0;
}

function conflictCountFor(db: DatabaseHandle, id: string): number {
  return tableExists(db, '__sync_conflicts')
    ? Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts WHERE record_id=?1', [id]) ?? 0)
    : 0;
}

function change(overrides: Partial<EngineChange>): EngineChange {
  return {
    table_name: 'notes',
    record_id: '',
    operation: 'Insert',
    data: null,
    changed_at: '2026-05-01T10:00:00Z',
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: null,
    source_seq: null,
    ...overrides,
  } as EngineChange;
}

function buildInsertChange(id: string, title: string, updatedAt: string): EngineChange {
  return change({
    record_id: id,
    operation: 'Insert',
    data: {
      id, title, content: '', tags: '[]', is_favorite: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: updatedAt, deleted_at: null,
    },
    changed_at: updatedAt,
  });
}

function buildUpdateChange(id: string, title: string, updatedAt: string): EngineChange {
  return change({
    record_id: id,
    operation: 'Update',
    data: {
      id, title, content: '', tags: '[]', is_favorite: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: updatedAt, deleted_at: null,
    },
    changed_at: updatedAt,
  });
}

function buildDeleteChange(id: string, changedAt: string): EngineChange {
  return change({ record_id: id, operation: 'Delete', data: null, changed_at: changedAt });
}

const context = { deviceId: DEVICE_ID, allowSyncTestFixtureTables: true } as const;

function apply(db: DatabaseHandle, changes: readonly EngineChange[]) {
  return host.ctx.sync.applyDownloadedChanges(db, changes, context);
}

function applyWithGuard(
  db: DatabaseHandle,
  changes: readonly EngineChange[],
  policy: 'KeepCloud' | 'KeepLocal' | 'KeepLatest',
  cloudDeviceId: string | null = null,
  localDeviceId: string | null = null,
) {
  return host.ctx.sync.applyDownloadedChangesWithConflictGuard(db, changes, context, {
    policy,
    cloudDeviceId,
    localDeviceId,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-scenarios-sync-'));
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

describe('sync scenarios 01-10: apply basics and isolation', () => {
  it('scenario_01_fresh_insert_applies_cleanly', () => {
    const db = newTestDb();
    const result = apply(db, [buildInsertChange('n1', 'hello', '2026-05-01T10:00:00Z')]);
    expect(result.success_count).toBe(1);
    expect(getTitle(db, 'n1')).toBe('hello');
  });

  it('scenario_02_update_without_local_changes_overwrites', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'old', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    apply(db, [buildUpdateChange('n1', 'new', '2026-05-01T10:00:00Z')]);
    expect(getTitle(db, 'n1')).toBe('new');
  });

  it('scenario_03_delete_soft_deletes_when_tombstone_column_exists', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'x', 'y', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    apply(db, [buildDeleteChange('n1', '2026-05-01T10:00:00Z')]);
    expect(getDeletedAt(db, 'n1')).not.toBeNull();
    expect(countNotes(db)).toBe(1);
  });

  it('scenario_04_delete_idempotent', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'x', 'y', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    const deletion = buildDeleteChange('n1', '2026-05-01T10:00:00Z');
    apply(db, [deletion]);
    const again = apply(db, [deletion]);
    expect(again.failure_count).toBe(0);
  });

  it('scenario_05_explicit_null_on_not_null_column_is_quarantined', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'local_title', 'local_content', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    const cloud = buildUpdateChange('n1', 'cloud_title', '2026-05-01T10:00:00Z');
    cloud.data = { ...(cloud.data as Record<string, unknown>), content: null };
    const result = apply(db, [cloud]);
    expect(result.failure_count).toBe(1);
    expect(db.pluck("SELECT content FROM notes WHERE id='n1'")).toBe('local_content');
    expect(getTitle(db, 'n1')).toBe('local_title');
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_quarantine WHERE record_id=\'n1\'') ?? 0)).toBe(1);
  });

  it('scenario_06_suppress_change_log_echo_is_exact', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', 'c', '2026-05-01T09:00:00Z');
    updateNote(db, 'n1', 'user_edit', '2026-05-01T09:30:00Z');
    expect(pendingCount(db)).toBeGreaterThanOrEqual(2);

    const cloud = buildInsertChange('n1', 'cloud_value', '2026-05-01T10:00:00Z');
    cloud.suppress_change_log = true;
    apply(db, [cloud]);

    const userPending = Number(db.pluck(
      `SELECT COUNT(*) FROM __change_log
       WHERE record_id='n1' AND operation='UPDATE' AND sync_version = 0`,
    ) ?? 0);
    expect(userPending).toBeGreaterThanOrEqual(1);
  });

  it('scenario_07_transaction_rollback_on_fk_violation', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE parents (id TEXT PRIMARY KEY);
      CREATE TABLE test_children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES parents(id)
      );
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
      );
      PRAGMA foreign_keys = ON;
    `);
    const result = apply(db, [change({
      table_name: 'test_children', record_id: 'c1', operation: 'Insert',
      data: { id: 'c1', parent_id: 'p_does_not_exist' },
    })]);
    expect(result.failure_count).toBe(1);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_children') ?? 0)).toBe(0);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_quarantine') ?? 0)).toBe(1);
  });

  it('scenario_08_reject_writes_to_internal_tables', () => {
    const db = newTestDb();
    const result = apply(db, [change({
      table_name: '__change_log', record_id: '1', operation: 'Insert', data: { id: 1 },
    })]);
    expect(result.failure_count).toBe(1);
    expect(result.success_count).toBe(0);
  });

  it('scenario_09_reject_writes_to_sqlite_system_tables', () => {
    const db = newTestDb();
    const result = apply(db, [change({
      table_name: 'sqlite_master', record_id: 'x', operation: 'Insert', data: { name: 'hack' },
    })]);
    expect(result.failure_count).toBe(1);
    expect(result.success_count).toBe(0);
  });

  it('scenario_10_unknown_table_returns_error', () => {
    const db = newTestDb();
    const result = apply(db, [change({
      table_name: 'nonexistent', record_id: 'x', operation: 'Insert', data: { id: 'x' },
    })]);
    expect(result.failure_count).toBe(1);
    expect(result.success_count).toBe(0);
  });
});

describe('sync scenarios 11-20: conflict guard', () => {
  it('scenario_11_no_local_change_no_conflict', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    const { conflict } = applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud_new', '2026-05-01T10:00:00Z')],
      'KeepLatest', 'remote_dev', 'local_dev',
    );
    expect(conflict.conflicts_saved).toBe(0);
    expect(getTitle(db, 'n1')).toBe('cloud_new');
  });

  it('scenario_12_concurrent_edit_keeplatest_newer_cloud_wins', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'n1', 'local_edit', '2026-05-01T10:00:00Z');
    expect(pendingCount(db)).toBeGreaterThan(0);

    const { conflict } = applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud_edit', '2026-05-01T11:00:00Z')],
      'KeepLatest', 'cloud_dev', 'local_dev',
    );
    expect(conflict.rejected).toBe(0);
    expect(getTitle(db, 'n1')).toBe('cloud_edit');
    expect(conflictCountFor(db, 'n1')).toBe(2);
  });

  it('scenario_13_concurrent_edit_keeplatest_newer_local_wins', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'n1', 'local_newer', '2026-05-01T12:00:00Z');
    const { conflict } = applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud_older', '2026-05-01T11:00:00Z')],
      'KeepLatest', 'cloud_dev', 'local_dev',
    );
    expect(conflict.rejected).toBe(1);
    expect(getTitle(db, 'n1')).toBe('local_newer');
    expect(conflictCountFor(db, 'n1')).toBe(2);
  });

  it('scenario_14_keepcloud_always_wins_but_records_loser', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'n1', 'local_very_new', '2026-06-01T00:00:00Z');
    const { conflict } = applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud_older', '2026-05-01T11:00:00Z')],
      'KeepCloud', 'cloud_dev', 'local_dev',
    );
    expect(getTitle(db, 'n1')).toBe('cloud_older');
    expect(conflict.conflicts_saved).toBe(2);
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='n1' AND side='local'",
    ) ?? 0)).toBe(1);
  });

  it('scenario_15_keeplocal_cloud_data_still_saved', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'n1', 'local_old', '2026-05-01T10:00:00Z');
    const { conflict } = applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud_new', '2026-06-01T00:00:00Z')],
      'KeepLocal', 'cloud_dev', 'local_dev',
    );
    expect(conflict.rejected).toBe(1);
    expect(getTitle(db, 'n1')).toBe('local_old');
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='n1' AND side='cloud'",
    ) ?? 0)).toBe(1);
  });

  it('scenario_16_delete_vs_local_update_conflict', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'keep_me', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'n1', 'local_still_alive', '2026-05-01T10:00:00Z');
    const { conflict } = applyWithGuard(
      db, [buildDeleteChange('n1', '2026-05-01T09:30:00Z')],
      'KeepLatest', 'cloud_dev', 'local_dev',
    );
    expect(conflict.rejected).toBe(1);
    expect(getDeletedAt(db, 'n1')).toBeNull();
    expect(getTitle(db, 'n1')).toBe('local_still_alive');
    expect(conflictCountFor(db, 'n1')).toBeGreaterThanOrEqual(1);
  });

  it('scenario_17_identical_data_no_conflict', () => {
    const db = newTestDb();
    db.run(
      `INSERT INTO notes (id, title, content, tags, is_favorite, created_at, updated_at)
       VALUES ('n1','same','','[]',0,'2026-01-01T00:00:00Z','2026-05-01T09:00:00Z')`,
    );
    const { conflict } = applyWithGuard(db, [change({
      record_id: 'n1',
      operation: 'Update',
      data: {
        id: 'n1', title: 'same', content: '', tags: '[]', is_favorite: 0,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
      },
      changed_at: '2026-05-01T10:00:00Z',
      database_name: 'vfs',
    })], 'KeepLatest');
    expect(conflict.conflicts_saved).toBe(0);
  });

  it('scenario_18_keeplatest_cloud_newer_with_small_skew_wins', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'n1', 'local', '2026-05-01T10:00:00Z');
    const { conflict } = applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud', '2026-05-01T10:00:01Z')], 'KeepLatest',
    );
    expect(getTitle(db, 'n1')).toBe('cloud');
    expect(conflict.rejected).toBe(0);
    expect(conflict.applied).toBe(1);
  });

  it('scenario_19_three_way_conflict_sequence', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'v0', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'n1', 'v1', '2026-05-01T10:00:00Z');
    updateNote(db, 'n1', 'v2', '2026-05-01T10:05:00Z');
    const { conflict } = applyWithGuard(
      db, [buildUpdateChange('n1', 'v_cloud', '2026-05-01T10:02:00Z')], 'KeepLatest',
    );
    expect(getTitle(db, 'n1')).toBe('v2');
    expect(conflict.rejected).toBe(1);
  });

  it('scenario_20_multiple_records_mixed_outcomes', () => {
    const db = newTestDb();
    insertNote(db, 'a', 'a0', 'x', '2026-05-01T09:00:00Z');
    insertNote(db, 'b', 'b0', 'x', '2026-05-01T09:00:00Z');
    insertNote(db, 'c', 'c0', 'x', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'a', 'a_local', '2026-05-01T12:00:00Z');
    updateNote(db, 'b', 'b_local', '2026-05-01T10:00:00Z');
    const { conflict } = applyWithGuard(db, [
      buildUpdateChange('a', 'a_cloud', '2026-05-01T11:00:00Z'),
      buildUpdateChange('b', 'b_cloud', '2026-05-01T11:00:00Z'),
      buildUpdateChange('c', 'c_cloud', '2026-05-01T11:00:00Z'),
    ], 'KeepLatest');
    expect(getTitle(db, 'a')).toBe('a_local');
    expect(getTitle(db, 'b')).toBe('b_cloud');
    expect(getTitle(db, 'c')).toBe('c_cloud');
    expect(conflict.rejected).toBe(1);
    expect(conflictCount(db)).toBe(4);
  });
});

describe('sync scenarios 21-30: prune gap, replay and batch behavior', () => {
  it('scenario_21_prune_gap_detection_triggers', () => {
    expect(host.ctx.sync.hasPruneGap(100n, 200n)).toBe(true);
    expect(host.ctx.sync.hasPruneGap(0n, 200n)).toBe(false);
    expect(host.ctx.sync.hasPruneGap(100n, null)).toBe(false);
    expect(host.ctx.sync.hasPruneGap(200n, 100n)).toBe(false);
  });

  it('scenario_22_replay_same_change_twice_idempotent', () => {
    const db = newTestDb();
    const insert = buildInsertChange('n1', 'hello', '2026-05-01T10:00:00Z');
    apply(db, [insert]);
    apply(db, [insert]);
    expect(countNotes(db)).toBe(1);
    expect(getTitle(db, 'n1')).toBe('hello');
  });

  it('scenario_23_replay_insert_then_update_sequence', () => {
    const db = newTestDb();
    apply(db, [
      buildInsertChange('n1', 'v1', '2026-05-01T10:00:00Z'),
      buildUpdateChange('n1', 'v2', '2026-05-01T10:05:00Z'),
    ]);
    expect(getTitle(db, 'n1')).toBe('v2');
  });

  it('scenario_24_replay_insert_then_delete_sequence', () => {
    const db = newTestDb();
    apply(db, [
      buildInsertChange('n1', 'v1', '2026-05-01T10:00:00Z'),
      buildDeleteChange('n1', '2026-05-01T10:05:00Z'),
    ]);
    expect(getDeletedAt(db, 'n1')).not.toBeNull();
  });

  it('scenario_25_replay_in_reverse_order_still_converges', () => {
    const db = newTestDb();
    const older = buildInsertChange('n1', 'v1', '2026-05-01T10:00:00Z');
    const newer = buildUpdateChange('n1', 'v2', '2026-05-01T10:05:00Z');
    apply(db, [newer, older]);
    const finalTitle = getTitle(db, 'n1');
    expect(finalTitle === 'v1' || finalTitle === 'v2').toBe(true);
  });

  it('scenario_26_upsert_preserves_row_identity', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'v1', 'x', '2026-05-01T09:00:00Z');
    const rowid1 = db.pluck<number>("SELECT rowid FROM notes WHERE id='n1'");
    markAllSynced(db);
    apply(db, [buildUpdateChange('n1', 'v2', '2026-05-01T10:00:00Z')]);
    const rowid2 = db.pluck<number>("SELECT rowid FROM notes WHERE id='n1'");
    expect(rowid2).toBe(rowid1);
  });

  it('scenario_27_large_batch_transactional', () => {
    const db = newTestDb();
    const changes = Array.from({ length: 500 }, (_, index) =>
      buildInsertChange(`n${String(index).padStart(3, '0')}`, `title_${index}`, '2026-05-01T10:00:00Z'));
    const result = apply(db, changes);
    expect(result.success_count).toBe(500);
    expect(countNotes(db)).toBe(500);
  });

  it('scenario_28_large_batch_partial_failure_rolls_back_all', () => {
    const db = newTestDb();
    const changes = Array.from({ length: 10 }, (_, index) => {
      const id = `c${index}`;
      return change({
        record_id: id,
        operation: 'Insert',
        data: {
          id, title: `note ${index}`, content: 'ok', tags: '[]', is_favorite: 0,
          created_at: '2026-05-01T09:00:00Z', updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
        },
      });
    });
    changes.push(change({
      table_name: 'unknown_table', record_id: 'bad', operation: 'Insert', data: { id: 'bad' },
    }));
    const result = apply(db, changes);
    expect(result.success_count).toBe(10);
    expect(result.failure_count).toBe(1);
    expect(countNotes(db)).toBe(10);
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __sync_quarantine WHERE record_id='bad'",
    ) ?? 0)).toBe(1);
  });

  it('scenario_29_millis_sync_version_normalized', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'test1', '', '2024-01-01T00:00:00Z');
    const rawMillis = 1_704_067_200_000;
    db.run('UPDATE __change_log SET sync_version=?1 WHERE record_id=?2', [rawMillis, 'n1']);
    const state = host.ctx.sync.getDatabaseSyncState(db, 'vfs');
    expect(state.data_version).toBeGreaterThan(0n);
    expect(state.data_version < 10_000_000_000n).toBe(true);
    expect(state.data_version).toBe(1_704_067_200n);
  });

  it('scenario_30_empty_batch_is_noop', () => {
    const db = newTestDb();
    const result = apply(db, []);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(0);
    const { conflict } = applyWithGuard(db, [], 'KeepLatest');
    expect(conflict.applied).toBe(0);
    expect(conflict.rejected).toBe(0);
  });
});

describe('sync scenarios 41-50: JSON, identifiers, unicode and long values', () => {
  it('scenario_41_deep_nested_json_in_text_column', () => {
    const db = newTestDb();
    const deepJson = '{"a":{"b":{"c":[1,2,{"d":"e"}]}}}';
    apply(db, [change({
      record_id: 'n1',
      operation: 'Insert',
      data: {
        id: 'n1', title: 'deep', content: deepJson, tags: '[]', is_favorite: 0,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-05-01T10:00:00Z',
      },
    })]);
    expect(db.pluck("SELECT content FROM notes WHERE id='n1'")).toBe(deepJson);
  });

  it('scenario_42_special_chars_in_record_id', () => {
    const db = newTestDb();
    const ids = ['hello world', 'with/slash', 'quotes"here', '中文 id'];
    for (const id of ids) {
      apply(db, [buildInsertChange(id, 't', '2026-05-01T10:00:00Z')]);
    }
    expect(countNotes(db)).toBe(ids.length);
  });

  it('scenario_43_reject_injection_via_table_name', () => {
    const db = newTestDb();
    const result = apply(db, [change({
      table_name: 'notes"; DROP TABLE notes; --',
      record_id: 'x',
      operation: 'Insert',
      data: { id: 'x' },
    })]);
    expect(result.failure_count).toBe(1);
    expect(result.success_count).toBe(0);
    expect(countNotes(db)).toBe(0);
  });

  it('scenario_44_reject_injection_via_column_name', () => {
    const db = newTestDb();
    apply(db, [change({
      record_id: 'n1',
      operation: 'Insert',
      data: {
        id: 'n1',
        'title"; DROP TABLE notes; --': 'hack',
        content: '', tags: '[]', is_favorite: 0,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-05-01T10:00:00Z',
      },
    })]);
    expect(tableExists(db, 'notes')).toBe(true);
    expect(countNotes(db)).toBe(0);
  });

  it('scenario_45_unicode_content_preserved', () => {
    const db = newTestDb();
    const content = '中文 🎉 Hello العربية עברית ñoño';
    apply(db, [change({
      record_id: 'n1',
      operation: 'Insert',
      data: {
        id: 'n1', title: content, content: '', tags: '[]', is_favorite: 0,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-05-01T10:00:00Z',
      },
    })]);
    expect(getTitle(db, 'n1')).toBe(content);
  });

  it('scenario_46_upsert_does_not_retrigger_change_log', () => {
    const db = newTestDb();
    apply(db, [buildInsertChange('n1', 'v1', '2026-05-01T10:00:00Z')]);
    expect(pendingCount(db)).toBe(0);
  });

  it('scenario_47_local_user_edit_during_download_preserved', () => {
    const db = newTestDb();
    apply(db, [buildInsertChange('cloud1', 'cloud_val', '2026-05-01T10:00:00Z')]);
    insertNote(db, 'local1', 'local_val', '', '2026-05-01T10:05:00Z');
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __change_log WHERE sync_version=0 AND record_id='local1'",
    ) ?? 0)).toBe(1);
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __change_log WHERE sync_version=0 AND record_id='cloud1'",
    ) ?? 0)).toBe(0);
  });

  it('scenario_48_conflict_table_survives_db_close_reopen', () => {
    const dir = join(root, 'case-persist');
    mkdirSync(dir, { recursive: true });
    caseDirs.push(dir);
    const path = join(dir, 'test.db');
    const first = storage.openFile(path, { profile: 'plain' });
    handles.push(first);
    first.exec(FIXTURE_SCHEMA);
    insertNote(first, 'n1', 'base', '', '2026-05-01T09:00:00Z');
    updateNote(first, 'n1', 'local_edit', '2026-05-01T10:00:00Z');
    applyWithGuard(
      first, [buildUpdateChange('n1', 'cloud_edit', '2026-05-01T11:00:00Z')],
      'KeepLatest', 'cloud_dev', 'local_dev',
    );
    storage.close(first);

    const reopened = storage.openFile(path, { profile: 'plain' });
    handles.push(reopened);
    expect(Number(reopened.pluck(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='n1'",
    ) ?? 0)).toBe(2);
  });

  it('scenario_49_very_long_field_value', () => {
    const db = newTestDb();
    const huge = 'x'.repeat(10 * 1024 * 1024);
    apply(db, [change({
      record_id: 'n1',
      operation: 'Insert',
      data: {
        id: 'n1', title: huge, content: '', tags: '[]', is_favorite: 0,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-05-01T10:00:00Z',
      },
    })]);
    expect(getTitle(db, 'n1')).toBe(huge);
  });

  it('scenario_50_mixed_sequence_with_conflicts_and_new', () => {
    const db = newTestDb();
    for (let i = 0; i < 10; i += 1) {
      insertNote(db, `existing_${i}`, 'base', '', '2026-05-01T09:00:00Z');
    }
    markAllSynced(db);
    for (let i = 0; i < 5; i += 1) {
      updateNote(db, `existing_${i}`, 'local_edit', '2026-05-01T12:00:00Z');
    }
    const changes: EngineChange[] = [];
    for (let i = 0; i < 10; i += 1) {
      changes.push(buildUpdateChange(`existing_${i}`, 'cloud_edit', '2026-05-01T11:00:00Z'));
    }
    for (let i = 0; i < 40; i += 1) {
      changes.push(buildInsertChange(`new_${i}`, 'new', '2026-05-01T11:00:00Z'));
    }
    const { apply: applied, conflict } = applyWithGuard(
      db, changes, 'KeepLatest', 'cloud_dev', 'local_dev',
    );
    expect(conflict.rejected).toBe(5);
    expect(applied.success_count).toBeGreaterThanOrEqual(45);
    expect(countNotes(db)).toBe(50);
    for (let i = 0; i < 5; i += 1) {
      expect(getTitle(db, `existing_${i}`)).toBe('local_edit');
    }
    for (let i = 5; i < 10; i += 1) {
      expect(getTitle(db, `existing_${i}`)).toBe('cloud_edit');
    }
  });
});

describe('sync scenarios 52-56 / 60: delete, empty timestamps and conflict rows', () => {
  it('scenario_52_delete_of_nonexistent_is_safe', () => {
    const db = newTestDb();
    const result = apply(db, [buildDeleteChange('never_existed', '2026-05-01T10:00:00Z')]);
    expect(result.failure_count).toBe(0);
    expect(countNotes(db)).toBe(0);
  });

  it('scenario_53_empty_string_updated_at_handled', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', '', '');
    markAllSynced(db);
    updateNote(db, 'n1', 'local', '');
    const { conflict } = applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud', '2026-05-01T10:00:00Z')], 'KeepLatest',
    );
    expect(conflict.rejected).toBeLessThanOrEqual(1);
  });

  it('scenario_54_multiple_conflict_rounds_accumulate', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', '', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'n1', 'local_1', '2026-05-01T12:00:00Z');
    applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud_1', '2026-05-01T11:00:00Z')],
      'KeepLatest', 'cloud_dev', 'local_dev',
    );
    expect(conflictCountFor(db, 'n1')).toBe(2);

    updateNote(db, 'n1', 'local_2', '2026-05-01T14:00:00Z');
    applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud_2', '2026-05-01T13:00:00Z')],
      'KeepLatest', 'cloud_dev', 'local_dev',
    );
    expect(conflictCountFor(db, 'n1')).toBe(4);
  });

  it('scenario_55_downloaded_delete_of_already_deleted_record', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'x', '', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    db.run("UPDATE notes SET deleted_at='2026-05-01T10:00:00Z' WHERE id='n1'");
    const result = apply(db, [buildDeleteChange('n1', '2026-05-01T11:00:00Z')]);
    expect(result.failure_count).toBe(0);
    expect(getDeletedAt(db, 'n1')).not.toBeNull();
  });

  it('scenario_56_restore_from_conflict_table', () => {
    const db = newTestDb();
    insertNote(db, 'n1', 'base', '', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'n1', 'local', '2026-05-01T10:00:00Z');
    applyWithGuard(
      db, [buildUpdateChange('n1', 'cloud', '2026-06-01T00:00:00Z')],
      'KeepLatest', 'cloud_dev', 'local_dev',
    );
    const local = JSON.parse(String(db.pluck(
      "SELECT data_json FROM __sync_conflicts WHERE record_id='n1' AND side='local'",
    ))) as { title?: string };
    expect(local.title).toBe('local');
    const cloud = JSON.parse(String(db.pluck(
      "SELECT data_json FROM __sync_conflicts WHERE record_id='n1' AND side='cloud'",
    ))) as { title?: string };
    expect(cloud.title).toBe('cloud');
  });

  it('scenario_60_conflict_guard_preserves_atomicity_on_failure', () => {
    const db = newTestDb();
    insertNote(db, 'a', 'base_a', '', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    updateNote(db, 'a', 'local_a', '2026-05-01T12:00:00Z');
    const { apply: applied, conflict } = applyWithGuard(db, [
      buildUpdateChange('a', 'cloud_a_older', '2026-05-01T11:00:00Z'),
      change({
        table_name: 'nonexistent_table', record_id: 'b', operation: 'Insert', data: { id: 'b' },
      }),
    ], 'KeepLatest', 'cloud', 'local');
    expect(applied.failure_count).toBe(1);
    expect(conflict.rejected).toBe(1);
    expect(conflictCount(db)).toBe(2);
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __sync_quarantine WHERE record_id='b'",
    ) ?? 0)).toBe(1);
    expect(getTitle(db, 'a')).toBe('local_a');
  });
});
