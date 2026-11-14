/**
 * [L20-engine port] `sync_regression_tests.rs` R01-R25b and R27.
 *
 * The Rust fixture table `items` is renamed `test_items` so the published
 * engine's explicit test-fixture allowance (`allowSyncTestFixtureTables`) is
 * used without reimplementing the RowSync registration. All HLC/LWW, reset
 * baseline, cleanup, batch, merge and conflict-guard assertions are otherwise
 * unchanged.
 *
 * R26 (clock-drift quarantine auto-replay) stays pending: L20 does not publish
 * `replay_quarantined_changes` on `ctx.sync`. R27 only needs public apply.
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
import type { EngineChange, JsonValue } from '../../sync/api.ts';

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
  const db = storage.openFile(join(dir, 'regression.db'), { profile: 'plain' });
  handles.push(db);
  return db;
}

const ITEMS_SCHEMA = `
  CREATE TABLE test_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    counter INTEGER NOT NULL DEFAULT 0,
    device_id TEXT,
    local_version INTEGER DEFAULT 0,
    sync_version INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER DEFAULT 0
  );
  CREATE TRIGGER trg_test_items_ins AFTER INSERT ON test_items BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('test_items', NEW.id, 'INSERT', NEW.updated_at);
  END;
  CREATE TRIGGER trg_test_items_upd AFTER UPDATE ON test_items BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('test_items', NEW.id, 'UPDATE', NEW.updated_at);
  END;
`;

function newDb(): DatabaseHandle {
  const db = newHandle();
  db.exec(ITEMS_SCHEMA);
  return db;
}

function insertItem(db: DatabaseHandle, id: string, title: string, updatedAt: string): void {
  db.run('INSERT INTO test_items (id, title, updated_at) VALUES (?1,?2,?3)', [id, title, updatedAt]);
}

function markAllSynced(db: DatabaseHandle): void {
  db.run('UPDATE __change_log SET sync_version=?1 WHERE sync_version=0', [Math.floor(Date.now() / 1000)]);
}

function countPending(db: DatabaseHandle): number {
  return Number(db.pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0);
}

function getTitle(db: DatabaseHandle, id: string): string | null {
  return db.pluck<string | null>('SELECT title FROM test_items WHERE id=?1', [id]) ?? null;
}

function change(overrides: Partial<EngineChange>): EngineChange {
  return {
    table_name: 'test_items',
    record_id: '',
    operation: 'Update',
    data: null,
    changed_at: '2024-01-01T00:00:00Z',
    change_log_id: null,
    database_name: null,
    suppress_change_log: null,
    source_device_id: null,
    source_seq: null,
    ...overrides,
  } as EngineChange;
}

function hlc(millis: bigint, counter: number): string {
  return host.ctx.sync.createHlc(millis, counter).toString();
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
  root = mkdtempSync(join(tmpdir(), 'l23-regression-sync-'));
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

describe('sync regression R01-R05: HLC compare in apply', () => {
  it('r01_hlc_same_millis_counter_tie_break_in_apply', () => {
    const db = newDb();
    const earlier = hlc(1_700_000_000_000n, 0);
    const later = hlc(1_700_000_000_000n, 1);
    insertItem(db, 'n1', 'earlier', earlier);
    markAllSynced(db);
    apply(db, [change({
      record_id: 'n1', changed_at: later,
      data: { id: 'n1', title: 'later', counter: 0, updated_at: later },
    })]);
    expect(getTitle(db, 'n1')).toBe('later');
  });

  it('r02_hlc_local_newer_counter_wins_lww', () => {
    const db = newDb();
    const localHlc = hlc(1_700_000_000_000n, 5);
    const cloudHlc = hlc(1_700_000_000_000n, 2);
    insertItem(db, 'n1', 'local-keep', localHlc);
    markAllSynced(db);
    apply(db, [change({
      record_id: 'n1', changed_at: cloudHlc,
      data: { id: 'n1', title: 'cloud-loser', counter: 0, updated_at: cloudHlc },
    })]);
    expect(getTitle(db, 'n1')).toBe('local-keep');
  });

  it('r03_hlc_drift_over_60s_future_rejected', () => {
    const db = newDb();
    const nowMs = BigInt(Date.now());
    const pastHlc = hlc(nowMs - 10_000n, 0);
    const futureHlc = hlc(nowMs + 300_000n, 0);
    insertItem(db, 'n1', 'local', pastHlc);
    markAllSynced(db);
    apply(db, [change({
      record_id: 'n1', changed_at: futureHlc,
      data: { id: 'n1', title: 'from-future', counter: 0, updated_at: futureHlc },
    })]);
    expect(getTitle(db, 'n1')).toBe('local');
  });

  it('r04_hlc_local_vs_iso_cloud_mixed_formats', () => {
    const db = newDb();
    const localHlc = hlc(1_700_000_000_000n, 0);
    const cloudIso = '2024-01-01T00:00:00Z';
    insertItem(db, 'n1', 'local-hlc', localHlc);
    markAllSynced(db);
    expect(() => apply(db, [change({
      record_id: 'n1', changed_at: cloudIso,
      data: { id: 'n1', title: 'cloud-iso', counter: 0, updated_at: cloudIso },
    })])).not.toThrow();
  });

  it('r05_hlc_burst_10000_counter_monotonic', () => {
    let last: string | null = null;
    for (let i = 0; i < 10_000; i += 1) {
      const value = hlc(1_700_000_000_000n, i);
      if (last !== null) expect(value > last).toBe(true);
      last = value;
    }
  });
});

describe('sync regression R06-R09: reset baseline bounds', () => {
  it('r06_reset_baseline_on_empty_db', () => {
    const db = newHandle();
    db.exec(`CREATE TABLE __change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
      operation TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0
    );`);
    expect(host.ctx.sync.resetSyncBaselineAfterRestore(db)).toEqual([0, 0]);
  });

  it('r07_reset_baseline_skips_tables_without_sync_columns', () => {
    const db = newHandle();
    db.exec(`CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
        operation TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0
      );
      CREATE TABLE plain_table (id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO plain_table VALUES ('x', 'alpha');
      INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
      VALUES ('x', 'x', 'INSERT', '2024-01-01T00:00:00Z', 100);`);
    const [truncated] = host.ctx.sync.resetSyncBaselineAfterRestore(db);
    expect(truncated).toBe(1);
    expect(db.pluck("SELECT name FROM plain_table WHERE id='x'")).toBe('alpha');
  });

  it('r08_reset_baseline_excludes_system_tables', () => {
    const db = newDb();
    db.exec(`CREATE TABLE __sync_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('local','cloud')), data_json TEXT NOT NULL,
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO __sync_conflicts (table_name, record_id, side, data_json, detected_at)
      VALUES ('t', 'rid', 'local', '{}', '2024-01-01');`);
    insertItem(db, 'n1', 'hello', '2024-01-01T00:00:00Z');
    host.ctx.sync.resetSyncBaselineAfterRestore(db);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0)).toBe(0);
  });

  it('r09_reset_baseline_is_idempotent', () => {
    const db = newDb();
    db.exec(`CREATE TABLE synced_items (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', local_version INTEGER DEFAULT 0,
        sync_version INTEGER DEFAULT 0, updated_at TEXT NOT NULL
      );
      INSERT INTO synced_items (id, title, local_version, sync_version, updated_at)
      VALUES ('n1', 'hello', 3, 1, '2024-01-01T00:00:00Z');
      INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
      VALUES ('synced_items', 'n1', 'UPDATE', '2024-01-01T00:00:00Z', 0);`);
    const first = host.ctx.sync.resetSyncBaselineAfterRestore(db);
    const second = host.ctx.sync.resetSyncBaselineAfterRestore(db);
    expect(db.pluck("SELECT local_version FROM synced_items WHERE id='n1'")).toBe(3);
    expect(db.pluck("SELECT sync_version FROM synced_items WHERE id='n1'")).toBe(3);
    expect(first).toEqual([1, 1]);
    expect(second).toEqual([0, 0]);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log') ?? 0)).toBe(0);
  });
});

describe('sync regression R10-R13: post-restore baseline', () => {
  it('r10_post_restore_no_pending_changes', () => {
    const db = newDb();
    for (let i = 0; i < 20; i += 1) {
      insertItem(db, `n${i}`, 'restored', '2024-01-01T00:00:00Z');
    }
    db.exec('UPDATE __change_log SET sync_version = 100 WHERE id <= 10;');
    expect(countPending(db)).toBeGreaterThan(0);
    host.ctx.sync.resetSyncBaselineAfterRestore(db);
    expect(countPending(db)).toBe(0);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(20);
  });

  it('r11_post_restore_only_new_edits_are_pending', () => {
    const db = newDb();
    for (let i = 0; i < 20; i += 1) {
      insertItem(db, `n${i}`, 'restored', '2024-01-01T00:00:00Z');
    }
    host.ctx.sync.resetSyncBaselineAfterRestore(db);
    expect(countPending(db)).toBe(0);
    db.run("UPDATE test_items SET title='user-edited', updated_at='2024-06-01T00:00:00Z' WHERE id='n5'");
    expect(countPending(db)).toBe(1);
    const row = db.get<{ table_name: string; record_id: string }>(
      'SELECT table_name, record_id FROM __change_log WHERE sync_version = 0',
    );
    expect(row?.table_name).toBe('test_items');
    expect(row?.record_id).toBe('n5');
  });

  it('r12_repeated_restore_reset_cycles', () => {
    const db = newDb();
    for (let round = 0; round < 5; round += 1) {
      for (let i = 0; i < 10; i += 1) {
        insertItem(db, `r${round}_n${i}`, 'restored', '2024-01-01T00:00:00Z');
      }
      host.ctx.sync.resetSyncBaselineAfterRestore(db);
      expect(countPending(db)).toBe(0);
    }
  });

  it('r13_post_restore_clears_unresolved_conflicts', () => {
    const db = newDb();
    db.exec(`CREATE TABLE __sync_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('local','cloud')), data_json TEXT NOT NULL,
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO __sync_conflicts (table_name, record_id, side, data_json, detected_at)
      VALUES ('test_items', 'old_conflict', 'local', '{}', '2024-01-01'),
             ('test_items', 'old_conflict2', 'cloud', '{}', '2024-01-02');`);
    insertItem(db, 'new', 'x', '2024-01-01T00:00:00Z');
    host.ctx.sync.resetSyncBaselineAfterRestore(db);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0)).toBe(0);
  });
});

describe('sync regression R14-R17: cleanup synced changes', () => {
  it('r14_archive_preserves_pending_changes', () => {
    const db = newDb();
    insertItem(db, 'n1', 'x', '2024-01-01T00:00:00Z');
    db.exec(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
      VALUES ('test_items','a','INSERT','2024-01-01T00:00:00Z',0),
             ('test_items','b','INSERT','2024-01-01T00:00:00Z',100),
             ('test_items','c','INSERT','2020-01-01T00:00:00Z',100)`);
    expect(host.ctx.sync.cleanupSyncedChanges(db, '2023-01-01T00:00:00Z')).toBe(1);
    expect(Number(db.pluck("SELECT COUNT(*) FROM __change_log WHERE record_id='a'") ?? 0)).toBe(1);
    expect(Number(db.pluck("SELECT COUNT(*) FROM __change_log WHERE record_id='b'") ?? 0)).toBe(1);
  });

  it('r15_archive_with_very_early_cutoff_noop', () => {
    const db = newDb();
    db.exec(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
      VALUES ('test_items','a','INSERT','2024-01-01T00:00:00Z',100)`);
    expect(host.ctx.sync.cleanupSyncedChanges(db, '2000-01-01T00:00:00Z')).toBe(0);
  });

  it('r16_archive_with_very_late_cutoff_deletes_all_synced', () => {
    const db = newDb();
    db.exec(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
      VALUES ('test_items','a','INSERT','2024-01-01T00:00:00Z',100),
             ('test_items','b','INSERT','2024-02-01T00:00:00Z',100),
             ('test_items','c','INSERT','2024-03-01T00:00:00Z',0)`);
    expect(host.ctx.sync.cleanupSyncedChanges(db, '2999-01-01T00:00:00Z')).toBe(2);
  });

  it('r17_archive_is_idempotent', () => {
    const db = newDb();
    db.exec(`INSERT INTO __change_log (table_name, record_id, operation, changed_at, sync_version)
      VALUES ('test_items','a','INSERT','2020-01-01T00:00:00Z',100)`);
    expect(host.ctx.sync.cleanupSyncedChanges(db, '2023-01-01T00:00:00Z')).toBe(1);
    expect(host.ctx.sync.cleanupSyncedChanges(db, '2023-01-01T00:00:00Z')).toBe(0);
  });
});

describe('sync regression R18-R20: batch boundaries and HLC order', () => {
  it('r18_apply_3000_records_crosses_batch_boundary', () => {
    const db = newDb();
    const baseMs = 1_700_000_000_000n;
    const changes: EngineChange[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const stamp = hlc(baseMs + BigInt(i), 0);
      changes.push(change({
        record_id: `r${String(i).padStart(5, '0')}`,
        operation: 'Insert',
        changed_at: stamp,
        data: {
          id: `r${String(i).padStart(5, '0')}`, title: `t${i}`, counter: i, updated_at: stamp,
        },
      }));
    }
    apply(db, changes);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(3000);
  });

  it('r19_apply_empty_noop', () => {
    const db = newDb();
    const result = apply(db, []);
    expect(result.success_count + result.failure_count + result.skipped_count).toBe(0);
  });

  it('r20_hlc_ordering_preserved_across_batch_size', () => {
    const baseMs = 1_700_000_000_000n;
    const stamps: string[] = [];
    for (let i = 0; i < 1999; i += 1) {
      const millis = i < 1000 ? baseMs + BigInt(i) : baseMs + 10_000n + BigInt(i);
      stamps.push(hlc(millis, 0));
    }
    for (let i = 1; i < stamps.length; i += 1) {
      expect((stamps[i] as string) > (stamps[i - 1] as string)).toBe(true);
      expect(host.ctx.sync.parseHlc(stamps[i] as string)).not.toBeNull();
    }
  });
});

describe('sync regression R21-R23: merge strategy timestamps', () => {
  function conflict(localUpdatedAt: string, cloudUpdatedAt: string, local: JsonValue, cloud: JsonValue) {
    return {
      database_name: 'test', table_name: 'test_items', record_id: 'n1',
      local_version: 1, cloud_version: 1,
      local_updated_at: localUpdatedAt, cloud_updated_at: cloudUpdatedAt,
      local_data: local, cloud_data: cloud,
    };
  }

  it('r21_mixed_format_cmp_is_deterministic', () => {
    const result = host.ctx.sync.applyMergeStrategy('KeepLatest', [conflict(
      hlc(1_700_000_000_000n, 99), '2024-01-01T00:00:00Z', { x: 1 }, { x: 2 },
    )]);
    expect(result.success).toBe(true);
  });

  it('r22_identical_hlc_tie_resolved_by_content_convergently', () => {
    const stamp = hlc(1_700_000_000_000n, 42);
    const a = host.ctx.sync.applyMergeStrategy('KeepLatest', [conflict(stamp, stamp, { x: 1 }, { x: 2 })]);
    expect(a.success).toBe(true);
    expect(a.used_cloud).toBe(1);
    const b = host.ctx.sync.applyMergeStrategy('KeepLatest', [conflict(stamp, stamp, { x: 2 }, { x: 1 })]);
    expect(b.success).toBe(true);
    expect(b.kept_local).toBe(1);
  });

  it('r23_hlc_not_swallowed_by_clock_skew_tolerance', () => {
    const result = host.ctx.sync.applyMergeStrategy('KeepLatest', [conflict(
      hlc(1_700_000_000_000n, 0), hlc(1_700_000_000_000n, 1), { x: 1 }, { x: 2 },
    )]);
    expect(result.used_cloud).toBe(1);
    expect(result.kept_local).toBe(0);
  });
});

describe('sync regression R24-R25b: conflict guard idempotency', () => {
  it('r24_conflict_falls_into_table', () => {
    const db = newDb();
    insertItem(db, 'n1', 'local-edit', '2024-01-01T10:00:00Z');
    const { conflict } = applyWithGuard(db, [change({
      record_id: 'n1', changed_at: '2024-01-01T11:00:00Z',
      data: { id: 'n1', title: 'cloud-edit', counter: 0, updated_at: '2024-01-01T11:00:00Z' },
    })], 'KeepLatest', 'cloud-device', 'local-device');
    expect(conflict.conflicts_saved).toBeGreaterThan(0);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('r25_conflict_guard_idempotent_on_replay', () => {
    const db = newDb();
    insertItem(db, 'n1', 'local', '2024-01-01T10:00:00Z');
    const payload = change({
      record_id: 'n1', changed_at: '2024-01-01T11:00:00Z',
      data: { id: 'n1', title: 'cloud', counter: 0, updated_at: '2024-01-01T11:00:00Z' },
    });
    applyWithGuard(db, [payload], 'KeepLatest', 'cloud', 'local');
    const afterFirst = Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0);
    applyWithGuard(db, [payload], 'KeepLatest', 'cloud', 'local');
    const afterSecond = Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0);
    expect(afterSecond).toBe(afterFirst);
    for (let i = 0; i < 10; i += 1) {
      applyWithGuard(db, [payload], 'KeepLatest', 'cloud', 'local');
    }
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0)).toBe(afterFirst);
  });

  it('r25b_resolved_does_not_block_new_identical_conflict', () => {
    const db = newDb();
    insertItem(db, 'n1', 'local', '2024-01-01T10:00:00Z');
    const payload = change({
      record_id: 'n1', changed_at: '2024-01-01T11:00:00Z',
      data: { id: 'n1', title: 'cloud', counter: 0, updated_at: '2024-01-01T11:00:00Z' },
    });
    applyWithGuard(db, [payload], 'KeepLatest', 'cloud', 'local');
    expect(Number(db.pluck(
      'SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL',
    ) ?? 0)).toBeGreaterThan(0);
    db.exec("UPDATE __sync_conflicts SET resolved_at = datetime('now'), resolution = 'keep_local' WHERE resolved_at IS NULL");
    db.run("UPDATE test_items SET title='local_again', updated_at='2024-01-02T10:00:00Z' WHERE id='n1'");
    applyWithGuard(db, [payload], 'KeepLatest', 'cloud', 'local');
    expect(Number(db.pluck(
      'SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL',
    ) ?? 0)).toBeGreaterThan(0);
  });
});

describe('sync regression R27: clock-drift DELETE quarantine', () => {
  it('r27_clock_drift_delete_quarantined', () => {
    const db = newDb();
    insertItem(db, 'n1', 'keep-me', '2026-05-01T12:00:00Z');
    markAllSynced(db);
    const futureIso = new Date(Date.now() + 300_000).toISOString();
    const result = apply(db, [change({
      record_id: 'n1',
      operation: 'Delete',
      changed_at: futureIso,
      data: null,
      source_device_id: 'device-fast-clock',
      source_seq: 8n,
    })]);

    // sync_regression_tests.rs:1157/1165/1170, unchanged assertions.
    expect(result.failure_count).toBe(1);
    expect(db.get<{ deleted_at: string | null }>("SELECT deleted_at FROM test_items WHERE id='n1'")?.deleted_at).toBeNull();
    expect(db.pluck('SELECT COUNT(*) FROM __sync_quarantine')).toBe(1);
  });
});
