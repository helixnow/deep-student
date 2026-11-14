/**
 * [L20-engine port] `sync_adversarial_tests.rs` A.01-A.40.
 *
 * The Rust fixture table `items` is renamed `test_items` so the published
 * engine's explicit test-fixture allowance can be used without reimplementing
 * RowSync registration. Clock-drift, zombie/tombstone, LWW, retention-gap,
 * schema-drift, echo, injection and conflict-table assertions are unchanged.
 *
 * A.13 preserves Rust's real apply call and no-panic invariant without
 * constraining its returned ApplyResult or SQLite affinity outcome.
 * A.14 is ported separately in device_identity.test.ts.
 * A.33 preserves the apply call and two COUNT reads as observations, not a
 * requirement to accept the payload or write either id.
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
  const db = storage.openFile(join(dir, 'adversarial.db'), { profile: 'plain' });
  handles.push(db);
  return db;
}

const ITEMS_SCHEMA = `
  CREATE TABLE test_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    counter INTEGER NOT NULL DEFAULT 0,
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

function insertRaw(
  db: DatabaseHandle, id: string, title: string, body: string, updatedAt: string,
): void {
  db.run(
    'INSERT INTO test_items (id, title, body, updated_at) VALUES (?1,?2,?3,?4)',
    [id, title, body, updatedAt],
  );
}

interface ItemRow {
  title: string;
  body: string;
  counter: number;
  deleted_at: string | null;
  updated_at: string;
}

function getItem(db: DatabaseHandle, id: string): ItemRow | null {
  return db.one<ItemRow>(
    'SELECT title, body, counter, deleted_at, updated_at FROM test_items WHERE id=?1',
    [id],
  ) ?? null;
}

function unknownFields(db: DatabaseHandle, id: string): Record<string, unknown> | null {
  const stored = db.pluck<string | null>(
    "SELECT fields_json FROM __sync_unknown_fields WHERE table_name='test_items' AND record_id=?1", [id]) ?? null;
  return stored === null ? null : JSON.parse(stored) as Record<string, unknown>;
}

function markAllSynced(db: DatabaseHandle): void {
  db.run('UPDATE __change_log SET sync_version=1 WHERE sync_version=0');
}

function buildChange(
  id: string,
  operation: 'Insert' | 'Update' | 'Delete',
  payload: Record<string, unknown>,
  changedAt: string,
): EngineChange {
  return {
    table_name: 'test_items',
    record_id: id,
    operation,
    data: operation === 'Delete' ? null : payload,
    changed_at: changedAt,
    change_log_id: null,
    database_name: 'test',
    suppress_change_log: true,
    source_device_id: null,
    source_seq: null,
  } as EngineChange;
}

const context = { deviceId: DEVICE_ID, allowSyncTestFixtureTables: true } as const;

function apply(db: DatabaseHandle, changes: readonly EngineChange[]) {
  return host.ctx.sync.applyDownloadedChanges(db, changes, context);
}

function applyWithGuard(
  db: DatabaseHandle,
  changes: readonly EngineChange[],
  cloudDeviceId: string | null = null,
  localDeviceId: string | null = null,
) {
  return host.ctx.sync.applyDownloadedChangesWithConflictGuard(db, changes, context, {
    policy: 'KeepLatest', cloudDeviceId, localDeviceId,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-adversarial-sync-'));
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

describe('sync adversarial A.01-A.05: untrusted clocks', () => {
  it('adv_01_clock_rewind_by_attacker', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'local_fresh', 'current', '2026-05-01T12:00:00Z');
    markAllSynced(db);
    const malicious = '2026-04-28T12:00:00Z';
    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'attacker_injected', body: 'hacker_overwrite',
      updated_at: malicious, deleted_at: null,
    }, malicious)]);
    const row = getItem(db, 'n1');
    expect(row?.title).toBe('local_fresh');
    expect(row?.body).toBe('current');
  });

  it('adv_02_clock_ahead_is_rejected_by_drift_guard', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'legit', 'current', '2026-05-01T12:00:00Z');
    markAllSynced(db);
    const farFuture = '2036-05-01T12:00:00Z';
    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'attacker_10yr', updated_at: farFuture, deleted_at: null,
    }, farFuture)]);
    const row = getItem(db, 'n1');
    expect(row?.title).toBe('legit');
    expect(row?.updated_at).toBe('2026-05-01T12:00:00Z');
  });

  it('adv_03_same_second_concurrent_writes', () => {
    const same = '2026-05-01T12:00:00Z';
    const dataA = { id: 'n1', title: 'a_write', body: '', updated_at: same, deleted_at: null };
    const dataB = { id: 'n1', title: 'b_write', body: '', updated_at: same, deleted_at: null };

    const db1 = newDb();
    apply(db1, [buildChange('n1', 'Insert', dataA, same)]);
    apply(db1, [buildChange('n1', 'Update', dataB, same)]);
    const title1 = getItem(db1, 'n1')?.title;

    const db2 = newDb();
    apply(db2, [buildChange('n1', 'Insert', dataB, same)]);
    apply(db2, [buildChange('n1', 'Update', dataA, same)]);
    const title2 = getItem(db2, 'n1')?.title;

    expect(title1).toBe(title2);
  });

  it('adv_04_timestamp_format_variants', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'local', '', '2026-05-01 12:00:00');
    markAllSynced(db);
    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'cloud', updated_at: '2026-05-01T12:00:00Z', deleted_at: null,
    }, '2026-05-01T12:00:00Z')]);
    expect(getItem(db, 'n1')?.title).toBe('local');
  });

  it('adv_05_timezone_handling', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'local', '', '2026-05-02T04:00:00+08:00');
    markAllSynced(db);
    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'cloud_earlier',
      updated_at: '2026-05-01T19:00:00Z', deleted_at: null,
    }, '2026-05-01T19:00:00Z')]);
    expect(getItem(db, 'n1')?.title).toBe('local');
  });
});

describe('sync adversarial A.06-A.09: zombies and row-level LWW', () => {
  it('adv_06_zombie_prevention_stale_upsert_after_delete', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'original', '', '2026-02-01T00:00:00Z');
    markAllSynced(db);
    db.run("UPDATE test_items SET deleted_at=?1, updated_at=?1 WHERE id='n1'", ['2026-05-01T12:00:00Z']);
    markAllSynced(db);

    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'zombie_resurrection',
      updated_at: '2026-02-15T00:00:00Z', deleted_at: null,
    }, '2026-02-15T00:00:00Z')]);

    const row = getItem(db, 'n1');
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.title).not.toBe('zombie_resurrection');
  });

  it('adv_07_legitimate_revive_with_newer_timestamp', () => {
    const db = newDb();
    const originalTs = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const deleteTs = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const reviveTs = new Date(Date.now() - 60_000).toISOString();
    insertRaw(db, 'n1', 'original', '', originalTs);
    markAllSynced(db);
    db.run("UPDATE test_items SET deleted_at=?1, updated_at=?1 WHERE id='n1'", [deleteTs]);
    markAllSynced(db);

    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'revived', updated_at: reviveTs, deleted_at: null,
    }, reviveTs)]);

    const row = getItem(db, 'n1');
    expect(row?.deleted_at).toBeNull();
    expect(row?.title).toBe('revived');
  });

  it('adv_08_row_level_lww_loses_orthogonal_field_edits', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'base_title', 'base_body', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    db.run("UPDATE test_items SET body='local_body_edit', updated_at=?1 WHERE id='n1'", ['2026-05-01T10:00:00Z']);

    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'cloud_title_edit', body: 'base_body',
      updated_at: '2026-05-01T11:00:00Z', deleted_at: null,
    }, '2026-05-01T11:00:00Z')]);

    const row = getItem(db, 'n1');
    expect(row?.title).toBe('cloud_title_edit');
    expect(row?.body).toBe('base_body');
  });

  it('adv_09_field_level_merge_loss_documented', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'initial', '', '2024-01-01T00:00:00Z');
    markAllSynced(db);
    db.run("UPDATE test_items SET title='title_from_a', updated_at=?1 WHERE id='n1'", ['2024-01-02T00:00:00Z']);

    const result = apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'initial', counter: 99,
      updated_at: '2024-01-03T00:00:00Z', deleted_at: null,
    }, '2024-01-03T00:00:00Z')]);
    expect(result.success_count).toBeGreaterThanOrEqual(1);

    const row = getItem(db, 'n1');
    expect(row?.title).toBe('initial');
    expect(row?.counter).toBe(99);
  });
});

describe('sync adversarial A.10-A.13: retention gap and schema drift', () => {
  it('adv_10_prune_gap_detection', () => {
    expect(host.ctx.sync.hasPruneGap(100n, 500n)).toBe(true);
    expect(host.ctx.sync.hasPruneGap(0n, 500n)).toBe(false);
    expect(host.ctx.sync.hasPruneGap(500n, 500n)).toBe(false);
    expect(host.ctx.sync.hasPruneGap(600n, 500n)).toBe(false);
    expect(host.ctx.sync.hasPruneGap(100n, null)).toBe(false);
  });

  it('adv_11_payload_missing_fields_preserves_local', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'base_title', 'base_body', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', updated_at: '2026-05-01T11:00:00Z',
    }, '2026-05-01T11:00:00Z')]);
    const row = getItem(db, 'n1');
    expect(row?.title).toBe('base_title');
    expect(row?.body).toBe('base_body');
  });

  it('adv_12_payload_unknown_columns_rejected', () => {
    const db = newDb();
    const result = apply(db, [buildChange('n1', 'Insert', {
      id: 'n1', title: 't', body: '', updated_at: '2026-05-01T11:00:00Z',
      deleted_at: null, future_field_that_does_not_exist: 'hello',
    }, '2026-05-01T11:00:00Z')]);
    // Deliberate deviation from Rust, which rejects the change: columns this schema does not know are
    // kept in `__sync_unknown_fields`, so an older client does not drop a newer client's data.
    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(0);
    expect(getItem(db, 'n1')?.title).toBe('t');
    expect(unknownFields(db, 'n1')).toEqual({ future_field_that_does_not_exist: 'hello' });
  });

  it('adv_13_payload_type_mismatch', () => {
    const db = newDb();
    // Rust :570-587 discards the Result; only panic is forbidden. Keep the
    // string bound to the real INTEGER column, with no test-side coercion,
    // success/count/value assertion, or catch that could swallow a panic.
    void apply(db, [buildChange('n1', 'Insert', {
      id: 'n1', title: 't', counter: 'not_a_number',
      updated_at: '2026-05-01T11:00:00Z', deleted_at: null,
    }, '2026-05-01T11:00:00Z')]);
  });
});

describe('sync adversarial A.15-A.20: echo, size and pathological ids', () => {
  it('adv_15_echo_loop_prevention', () => {
    const db = newDb();
    const change = buildChange('n1', 'Insert', {
      id: 'n1', title: 'hello', body: '',
      updated_at: '2026-05-01T11:00:00Z', deleted_at: null,
    }, '2026-05-01T11:00:00Z');
    apply(db, [change]);
    const before = Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0);
    apply(db, [change]);
    const after = Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0);
    expect(after).toBe(before);
  });

  it('adv_16_large_single_record', () => {
    const db = newDb();
    const huge = 'x'.repeat(5 * 1024 * 1024);
    apply(db, [buildChange('n1', 'Insert', {
      id: 'n1', title: 'huge', body: huge,
      updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
    }, '2026-05-01T10:00:00Z')]);
    expect(getItem(db, 'n1')?.body.length).toBe(huge.length);
  });

  it('adv_17_high_frequency_conflicts', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'base', '', '2026-01-01T00:00:00Z');
    markAllSynced(db);
    db.run("UPDATE test_items SET title='local_edit', updated_at=?1 WHERE id='n1'", ['2026-05-01T12:00:00Z']);

    for (let i = 0; i < 100; i += 1) {
      const stamp = `2026-05-01T11:00:${String(Math.min(i, 59)).padStart(2, '0')}Z`;
      applyWithGuard(db, [buildChange('n1', 'Update', {
        id: 'n1', title: `cloud_edit_${i}`, updated_at: stamp, deleted_at: null,
      }, stamp)], 'cloud', 'local');
    }

    expect(getItem(db, 'n1')?.title).toBe('local_edit');
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0)).toBe(101);
    expect(Number(db.pluck(
      'SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL',
    ) ?? 0)).toBe(101);
  });

  it('adv_18_json_special_numeric_values', () => {
    const db = newDb();
    apply(db, [buildChange('n1', 'Insert', {
      id: 'n1', title: 'nan_check', counter: 0,
      updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
    }, '2026-05-01T10:00:00Z')]);
    expect(getItem(db, 'n1')?.counter).toBe(0);
  });

  it('adv_19_very_long_record_id', () => {
    const db = newDb();
    const longId = 'x'.repeat(2000);
    apply(db, [buildChange(longId, 'Insert', {
      id: longId, title: 't', updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
    }, '2026-05-01T10:00:00Z')]);
    expect(getItem(db, longId)).not.toBeNull();
  });

  it('adv_20_binary_like_string_in_text_column', () => {
    const db = newDb();
    const weird = '\u0000\u007f\ufeff\u200b';
    apply(db, [buildChange('n1', 'Insert', {
      id: 'n1', title: weird, updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
    }, '2026-05-01T10:00:00Z')]);
    expect(getItem(db, 'n1')?.title).toBe(weird);
  });
});

describe('sync adversarial A.21-A.27: LWW boundaries and batch order', () => {
  it('adv_21_local_missing_updated_at_allows_cloud', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, body, updated_at) VALUES ('n1', 'local', '', 'garbage_ts')");
    markAllSynced(db);
    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'cloud', updated_at: '2026-05-01T12:00:00Z', deleted_at: null,
    }, '2026-05-01T12:00:00Z')]);
    expect(getItem(db, 'n1')?.title).toBe('cloud');
  });

  it('adv_22_cloud_garbage_updated_at', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'local', '', '2026-05-01T10:00:00Z');
    markAllSynced(db);
    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'cloud', updated_at: 'not_a_timestamp', deleted_at: null,
    }, 'not_a_timestamp')]);
    expect(getItem(db, 'n1')?.title).toBe('local');
  });

  it('adv_23_insert_nonexistent_passes_lww', () => {
    const db = newDb();
    apply(db, [buildChange('n1', 'Insert', {
      id: 'n1', title: 'new', updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
    }, '2026-05-01T10:00:00Z')]);
    expect(getItem(db, 'n1')?.title).toBe('new');
  });

  it('adv_24_payload_missing_updated_at_is_rejected', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'local_newer', '', '2026-06-01T00:00:00Z');
    markAllSynced(db);
    const result = apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'cloud_without_ts', deleted_at: null,
    }, '2026-05-01T10:00:00Z')]);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
    expect(getItem(db, 'n1')?.title).toBe('local_newer');
  });

  it('adv_25_conflict_tie_break_same_timestamp', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'local', '', '2026-05-01T12:00:00Z');
    markAllSynced(db);
    db.run("UPDATE test_items SET title='local_edit', updated_at=?1 WHERE id='n1'", ['2026-05-01T12:00:00Z']);
    const { conflict } = applyWithGuard(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'cloud_edit', updated_at: '2026-05-01T12:00:00Z', deleted_at: null,
    }, '2026-05-01T12:00:00Z')], 'cloud_dev', 'local_dev');
    expect(getItem(db, 'n1')?.title).toBe('local_edit');
    expect(conflict.conflicts_saved).toBeGreaterThanOrEqual(1);
  });

  it('adv_26_batch_apply_same_record_multiple_changes', () => {
    const db = newDb();
    const c1 = buildChange('n1', 'Insert', {
      id: 'n1', title: 'v1', body: '', counter: 1,
      updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
    }, '2026-05-01T10:00:00Z');
    const c2 = buildChange('n1', 'Update', {
      id: 'n1', title: 'v2', body: '', counter: 2,
      updated_at: '2026-05-01T11:00:00Z', deleted_at: null,
    }, '2026-05-01T11:00:00Z');
    const c3 = buildChange('n1', 'Update', {
      id: 'n1', title: 'v3', body: '', counter: 3,
      updated_at: '2026-05-01T12:00:00Z', deleted_at: null,
    }, '2026-05-01T12:00:00Z');
    apply(db, [c3, c1, c2]);
    const row = getItem(db, 'n1');
    expect(row?.title).toBe('v3');
    expect(row?.counter).toBe(3);
  });

  it('adv_27_millisecond_granularity', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'local', '', '2026-05-01T12:00:00.001Z');
    markAllSynced(db);
    apply(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'cloud', updated_at: '2026-05-01T12:00:00.002Z', deleted_at: null,
    }, '2026-05-01T12:00:00.002Z')]);
    expect(getItem(db, 'n1')?.title).toBe('cloud');
  });
});

describe('sync adversarial A.28-A.32: injection and determinism', () => {
  it('adv_28_table_name_injection_blocked', () => {
    const db = newDb();
    const result = apply(db, [{
      ...buildChange('n1', 'Insert', { id: 'n1' }, '2026-05-01T10:00:00Z'),
      table_name: 'test_items; DROP TABLE test_items; --',
      database_name: null,
    } as EngineChange]);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(0);
  });

  it('adv_29_double_quotes_in_field_value', () => {
    const db = newDb();
    const tricky = 'value with "double quotes" and \'single\' and -- comment';
    apply(db, [buildChange('n1', 'Insert', {
      id: 'n1', title: tricky, updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
    }, '2026-05-01T10:00:00Z')]);
    expect(getItem(db, 'n1')?.title).toBe(tricky);
  });

  it('adv_30_malicious_column_name_in_payload', () => {
    const db = newDb();
    try {
      apply(db, [buildChange('n1', 'Insert', {
        id: 'n1', title: 't', updated_at: '2026-05-01T10:00:00Z',
        '; DROP TABLE test_items; --': 'hack',
      }, '2026-05-01T10:00:00Z')]);
    } catch { /* Rust ignores the apply Result here */ }
    // The hostile name is never used as an identifier: the table survives and the value is kept
    // as opaque data in `__sync_unknown_fields` (Rust rejects the change, leaving 0 rows).
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(1);
    expect(getItem(db, 'n1')?.title).toBe('t');
    expect(unknownFields(db, 'n1')).toEqual({ '; DROP TABLE test_items; --': 'hack' });
  });

  it('adv_31_tags_field_semantic_equality', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, tags, updated_at) VALUES ('n1', 't', ?1, ?2)", [
      '["a","b"]', '2026-05-01T09:00:00Z',
    ]);
    db.run("UPDATE test_items SET title='local_edit', updated_at=?1 WHERE id='n1'", ['2026-05-01T10:00:00Z']);
    const { conflict } = applyWithGuard(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'local_edit', tags: '["a","b"]',
      updated_at: '2026-05-01T11:00:00Z', deleted_at: null,
    }, '2026-05-01T11:00:00Z')]);
    expect(conflict.conflicts_saved).toBe(0);
  });

  it('adv_32_deterministic_batch_apply', () => {
    const db1 = newDb();
    const db2 = newDb();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 50; i += 1) {
      const stamp = `2026-05-01T${String(i).padStart(2, '0')}:00:00Z`;
      const id = i % 2 === 0 ? 'n1' : 'n2';
      changes.push(buildChange(id, i < 25 ? 'Insert' : 'Update', {
        id, title: `v${i}`, updated_at: stamp, deleted_at: null,
      }, stamp));
    }
    apply(db1, changes);
    apply(db2, changes);
    expect(getItem(db1, 'n1')?.title).toBe(getItem(db2, 'n1')?.title);
    expect(getItem(db1, 'n2')?.title).toBe(getItem(db2, 'n2')?.title);
  });
});

describe('sync adversarial A.33: payload and record identity', () => {
  it('adv_33_payload_id_mismatch_with_record_id', () => {
    const db = newDb();
    // Rust :1246-1262 ignores the apply Result, then unwraps both queries.
    // Do not turn its printed observation into a required ID policy.
    void apply(db, [buildChange('n1', 'Insert', {
      id: 'n2', title: 'ambiguous', updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
    }, '2026-05-01T10:00:00Z')]);
    const countN1 = db.one<{ count: number }>("SELECT COUNT(*) AS count FROM test_items WHERE id='n1'").count;
    const countN2 = db.one<{ count: number }>("SELECT COUNT(*) AS count FROM test_items WHERE id='n2'").count;
    console.info(`adv_33 (payload id mismatch): n1_count=${countN1}, n2_count=${countN2}`);
  });
});

describe('sync adversarial A.34-A.40: conflict table and batch edges', () => {
  it('adv_34_conflict_table_query_by_record', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'base', '', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    db.run("UPDATE test_items SET title='local', updated_at=?1 WHERE id='n1'", ['2026-05-01T12:00:00Z']);
    applyWithGuard(db, [buildChange('n1', 'Update', {
      id: 'n1', title: 'cloud', updated_at: '2026-05-01T11:00:00Z', deleted_at: null,
    }, '2026-05-01T11:00:00Z')], 'cloud', 'local');
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL AND record_id='n1'",
    ) ?? 0)).toBe(2);
  });

  it('adv_35_cumulative_conflict_rounds', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'base', '', '2026-01-01T00:00:00Z');
    markAllSynced(db);
    for (let round = 0; round < 5; round += 1) {
      const localTs = `2026-${String(round + 2).padStart(2, '0')}-01T12:00:00Z`;
      db.run('UPDATE test_items SET title=?1, updated_at=?2 WHERE id=?3', [
        `local_${round}`, localTs, 'n1',
      ]);
      const cloudTs = `2026-${String(round + 2).padStart(2, '0')}-01T11:00:00Z`;
      applyWithGuard(db, [buildChange('n1', 'Update', {
        id: 'n1', title: `cloud_${round}`, updated_at: cloudTs, deleted_at: null,
      }, cloudTs)], 'cloud', 'local');
    }
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0)).toBe(10);
  });

  it('adv_36_empty_batch_noop', () => {
    const db = newDb();
    expect(apply(db, []).success_count).toBe(0);
  });

  it('adv_37_many_changes_same_record_latest_wins', () => {
    const db = newDb();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 20; i += 1) {
      const stamp = `2026-05-01T${String(i).padStart(2, '0')}:00:00Z`;
      changes.push(buildChange('n1', i === 0 ? 'Insert' : 'Update', {
        id: 'n1', title: `v${i}`, updated_at: stamp, deleted_at: null,
      }, stamp));
    }
    apply(db, changes);
    expect(getItem(db, 'n1')?.title).toBe('v19');
  });

  it('adv_38_delete_then_update_in_same_batch', () => {
    const db = newDb();
    insertRaw(db, 'n1', 'original', '', '2026-01-01T00:00:00Z');
    markAllSynced(db);
    apply(db, [
      buildChange('n1', 'Delete', {}, '2026-05-01T10:00:00Z'),
      buildChange('n1', 'Update', {
        id: 'n1', title: 'revived', updated_at: '2026-05-01T11:00:00Z', deleted_at: null,
      }, '2026-05-01T11:00:00Z'),
    ]);
    const row = getItem(db, 'n1');
    expect(row?.title).toBe('revived');
    expect(row?.deleted_at).toBeNull();
  });

  it('adv_39_update_then_delete_in_same_batch', () => {
    const db = newDb();
    apply(db, [
      buildChange('n1', 'Insert', {
        id: 'n1', title: 't', updated_at: '2026-05-01T10:00:00Z', deleted_at: null,
      }, '2026-05-01T10:00:00Z'),
      buildChange('n1', 'Delete', {}, '2026-05-01T11:00:00Z'),
    ]);
    expect(getItem(db, 'n1')?.deleted_at).not.toBeNull();
  });

  it('adv_40_delete_with_unexpected_data_field', () => {
    const db = newDb();
    insertRaw(db, 'n1', 't', '', '2026-05-01T09:00:00Z');
    markAllSynced(db);
    apply(db, [{
      ...buildChange('n1', 'Delete', {}, '2026-05-01T10:00:00Z'),
      data: { id: 'n1', title: 'should_be_ignored' },
    } as EngineChange]);
    const row = getItem(db, 'n1');
    expect(row?.title).toBe('t');
    expect(row?.deleted_at).not.toBeNull();
  });
});
