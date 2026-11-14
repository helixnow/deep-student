/**
 * [L20-engine port] `sync_pathological_tests.rs` P.01-P.40 (apply side).
 *
 * The Rust fixture table `items` is renamed `test_items` (and the auxiliary
 * `a`/`b`/`big` tables become `test_a`/`test_b`/`test_big`) so the published
 * engine's explicit test-fixture allowance can be used without reimplementing
 * RowSync registration. All apply/LWW/conflict/echo assertions are unchanged.
 *
 * P.20 and P.36 below retain their original workloads and monotonic
 * performance assertions independently of the test-runner timeout.
 *
 * P.11-P.15 are ported separately in pathological_pragma_sync.test.ts.
 * P.40 retains the real apply and COUNT observations without fixing their values.
 */

import { mkdtempSync, rmSync } from 'node:fs';
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

function unused(service: string): object {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`test unexpectedly entered ${service}.${String(key)}`);
    },
  });
}

function newHandle(): DatabaseHandle {
  // Rust sync_pathological_tests.rs:16 and the ad-hoc fixtures use open_in_memory.
  const db = storage.openFile(':memory:', { profile: 'plain', label: `pathological-${handles.length}` });
  handles.push(db);
  return db;
}

const CHANGE_LOG_SCHEMA = `
  CREATE TABLE __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER DEFAULT 0
  );
`;

const ITEMS_SCHEMA = `
  CREATE TABLE test_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    counter INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  ${CHANGE_LOG_SCHEMA}
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

function nowTs(): string {
  return new Date().toISOString();
}

function tsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function mkChange(
  id: string,
  operation: 'Insert' | 'Update' | 'Delete',
  data: Record<string, unknown>,
  changedAt: string,
  table = 'test_items',
): EngineChange {
  return {
    table_name: table,
    record_id: id,
    operation,
    data: operation === 'Delete' ? null : data,
    changed_at: changedAt,
    change_log_id: null,
    database_name: 'test',
    suppress_change_log: true,
    source_device_id: null,
    source_seq: null,
  } as EngineChange;
}

function getTitle(db: DatabaseHandle, id: string): string | null {
  return db.pluck<string | null>('SELECT title FROM test_items WHERE id=?1', [id]) ?? null;
}

function unknownFields(db: DatabaseHandle, id: string): Record<string, unknown> | null {
  const stored = db.pluck<string | null>(
    "SELECT fields_json FROM __sync_unknown_fields WHERE table_name='test_items' AND record_id=?1", [id]) ?? null;
  return stored === null ? null : JSON.parse(stored) as Record<string, unknown>;
}

function deletedAt(db: DatabaseHandle, id: string, table = 'test_items'): string | null {
  return db.pluck<string | null>(`SELECT deleted_at FROM ${table} WHERE id=?1`, [id]) ?? null;
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
  root = mkdtempSync(join(tmpdir(), 'l23-pathological-sync-'));
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
});

afterAll(async () => {
  await host?.dispose();
  (storage as StorageService & { dispose(): void } | undefined)?.dispose();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('sync pathological P.01-P.05: HLC updated_at and lifecycle', () => {
  it('p01_hlc_as_updated_at_lww_comparison', () => {
    const db = newDb();
    const base = 1_700_000_000_000n;
    const hlc1 = host.ctx.sync.createHlc(base, 0).toString();
    const hlc2 = host.ctx.sync.createHlc(base + 10n, 0).toString();
    apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: 'a1', updated_at: hlc1, deleted_at: null,
    }, hlc1)]);
    apply(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'b1', updated_at: hlc2, deleted_at: null,
    }, hlc2)]);
    expect(getTitle(db, 'n1')).toBe('b1');
  });

  it('p02_older_hlc_rejected_by_lww', () => {
    const db = newDb();
    const base = 1_700_000_000_000n;
    const late = host.ctx.sync.createHlc(base + 100n, 0).toString();
    const early = host.ctx.sync.createHlc(base, 0).toString();
    apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: 'late', updated_at: late, deleted_at: null,
    }, late)]);
    apply(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'early', updated_at: early, deleted_at: null,
    }, early)]);
    expect(getTitle(db, 'n1')).toBe('late');
  });

  it('p03_full_lifecycle_then_revive', () => {
    const db = newDb();
    apply(db, [
      mkChange('n1', 'Insert', {
        id: 'n1', title: 'born', updated_at: tsAgo(100), deleted_at: null,
      }, tsAgo(100)),
      mkChange('n1', 'Update', {
        id: 'n1', title: 'grew', updated_at: tsAgo(80), deleted_at: null,
      }, tsAgo(80)),
      mkChange('n1', 'Delete', {}, tsAgo(60)),
      mkChange('n1', 'Update', {
        id: 'n1', title: 'reborn', updated_at: tsAgo(40), deleted_at: null,
      }, tsAgo(40)),
    ]);
    expect(getTitle(db, 'n1')).toBe('reborn');
    expect(deletedAt(db, 'n1')).toBeNull();
  });

  it('p04_chaotic_delete_update_interleaving', () => {
    const db = newDb();
    const changes: EngineChange[] = [mkChange('n1', 'Insert', {
      id: 'n1', title: 'v0', updated_at: tsAgo(1000), deleted_at: null,
    }, tsAgo(1000))];
    for (let i = 0; i < 5; i += 1) {
      changes.push(mkChange('n1', 'Delete', {}, tsAgo(900 - i * 100)));
      changes.push(mkChange('n1', 'Update', {
        id: 'n1', title: `v${i + 1}`, updated_at: tsAgo(850 - i * 100), deleted_at: null,
      }, tsAgo(850 - i * 100)));
    }
    apply(db, changes);
    expect(getTitle(db, 'n1')).toBe('v5');
    expect(deletedAt(db, 'n1')).toBeNull();
  });

  it('p05_mixed_conflict_guard_and_plain_apply', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'base', ?1)", [tsAgo(200)]);
    db.run("UPDATE test_items SET title='local', updated_at=?1 WHERE id='n1'", [tsAgo(100)]);

    applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'cloud_c1', updated_at: tsAgo(50), deleted_at: null,
    }, tsAgo(50))], 'cloud', 'local');
    apply(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'cloud_c2', updated_at: tsAgo(10), deleted_at: null,
    }, tsAgo(10))]);

    expect(getTitle(db, 'n1')).toBe('cloud_c2');
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='n1'",
    ) ?? 0)).toBeGreaterThanOrEqual(2);
  });
});

describe('sync pathological P.06-P.10: UPSERT, delete payload, conflicts', () => {
  it('p06_mass_update_on_empty_db_becomes_insert', () => {
    const db = newDb();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 100; i += 1) {
      changes.push(mkChange(`n${i}`, 'Update', {
        id: `n${i}`, title: `v${i}`, updated_at: tsAgo(10_000 - i), deleted_at: null,
      }, tsAgo(10_000 - i)));
    }
    apply(db, changes);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(100);
  });

  it('p07_delete_with_payload_ignored', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 't', ?1)", [tsAgo(100)]);
    apply(db, [{
      ...mkChange('n1', 'Delete', {}, tsAgo(50)),
      data: { id: 'n1', title: 'should_not_be_applied', updated_at: tsAgo(50) },
    } as EngineChange]);
    expect(getTitle(db, 'n1')).toBe('t');
    expect(deletedAt(db, 'n1')).not.toBeNull();
  });

  it('p08_empty_batch_does_not_create_conflict_table', () => {
    const db = newDb();
    const { apply: applied, conflict } = applyWithGuard(db, []);
    expect(applied.success_count).toBe(0);
    expect(conflict.applied).toBe(0);
  });

  it('p09_corrupted_conflict_table_recovers', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'base', ?1)", [tsAgo(100)]);
    db.run("UPDATE test_items SET title='local', updated_at=?1 WHERE id='n1'", [tsAgo(50)]);
    applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'cloud', updated_at: tsAgo(30), deleted_at: null,
    }, tsAgo(30))], 'cloud', 'local');

    db.exec('ALTER TABLE __sync_conflicts DROP COLUMN winning_device_id');

    db.run("UPDATE test_items SET title='local2', updated_at=?1 WHERE id='n1'", [tsAgo(20)]);
    expect(() => applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'cloud2', updated_at: tsAgo(15), deleted_at: null,
    }, tsAgo(15))], 'cloud', 'local')).not.toThrow();
  });

  it('p10_massive_conflict_batch', () => {
    const db = newDb();
    for (let i = 0; i < 1000; i += 1) {
      db.run('INSERT INTO test_items (id, title, updated_at) VALUES (?1, ?2, ?3)', [
        `k${String(i).padStart(4, '0')}`, `local_${i}`, tsAgo(5000 - i),
      ]);
    }
    for (let i = 0; i < 1000; i += 1) {
      db.run('UPDATE test_items SET title=?1, updated_at=?2 WHERE id=?3', [
        `local_edit_${i}`, tsAgo(100), `k${String(i).padStart(4, '0')}`,
      ]);
    }
    const changes: EngineChange[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const id = `k${String(i).padStart(4, '0')}`;
      const stamp = tsAgo(200 + i);
      changes.push(mkChange(id, 'Update', {
        id, title: `cloud_${i}`, updated_at: stamp, deleted_at: null,
      }, stamp));
    }
    const started = Date.now();
    const { conflict } = applyWithGuard(db, changes, 'cloud', 'local');
    const elapsed = Date.now() - started;
    expect(conflict.rejected).toBe(1000);
    expect(conflict.conflicts_saved).toBe(2000);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});

describe('sync pathological P.16-P.19: change_log boundaries', () => {
  it('p16_missing_change_log_table_tolerated', () => {
    const db = newHandle();
    db.exec(`CREATE TABLE test_items (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT
    );`);
    const result = apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: 't', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(result.success_count).toBe(1);
    expect(getTitle(db, 'n1')).toBe('t');
  });

  it('p17_suppress_granularity', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'user_insert', ?1)", [tsAgo(100)]);
    db.run("UPDATE test_items SET title='user_update', updated_at=?1 WHERE id='n1'", [tsAgo(50)]);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0)).toBe(2);

    apply(db, [mkChange('n2', 'Insert', {
      id: 'n2', title: 'cloud', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __change_log WHERE sync_version=0 AND record_id='n1'",
    ) ?? 0)).toBe(2);
  });

  it('p18_out_of_order_replay_no_pending_pollution', () => {
    const db = newDb();
    const changes: EngineChange[] = [];
    for (let i = 49; i >= 0; i -= 1) {
      changes.push(mkChange(`n${i}`, 'Insert', {
        id: `n${i}`, title: `v${i}`, updated_at: tsAgo(5000 - i * 10), deleted_at: null,
      }, tsAgo(5000 - i * 10)));
    }
    apply(db, changes);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0)).toBe(0);
  });

  it('p19_change_log_with_id_zero_still_works', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'user', ?1)", [tsAgo(100)]);
    db.run("UPDATE __change_log SET id=0 WHERE record_id='n1'");
    expect(() => apply(db, [mkChange('n2', 'Insert', {
      id: 'n2', title: 't', updated_at: nowTs(), deleted_at: null,
    }, nowTs())])).not.toThrow();
  });
});

describe('sync pathological P.20: archived change log performance', () => {
  it('p20_large_synced_changelog_does_not_slow_sync', () => {
    const db = newDb();
    db.exec(`
      CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
      INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
    `);
    db.transaction(tx => {
      for (let i = 0; i < 10_000; i += 1) {
        tx.run(
          "INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES ('test_items', ?1, 'INSERT', 1)",
          [`archived_${i}`],
        );
      }
    }, { behavior: 'deferred' });

    // Rust :866 starts Instant before constructing the single fresh change.
    const started = performance.now();
    const change = mkChange('fresh', 'Insert', {
      id: 'fresh', title: 't', updated_at: nowTs(), deleted_at: null,
    }, nowTs());
    apply(db, [change]);
    const elapsed = performance.now() - started;
    console.info(`P.20 elapsed_ms=${elapsed}`);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('sync pathological P.21-P.27: tombstones and schemas', () => {
  it('p21_manual_hard_delete_then_tombstone', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 't', ?1)", [tsAgo(100)]);
    db.run("DELETE FROM test_items WHERE id='n1'");
    apply(db, [mkChange('n1', 'Delete', {}, tsAgo(50))]);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(0);
  });

  it('p22_manual_revive_then_incoming_delete', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at, deleted_at) VALUES ('n1', 't', ?1, ?1)", [tsAgo(200)]);
    db.run("UPDATE test_items SET deleted_at=NULL, updated_at=?1 WHERE id='n1'", [tsAgo(100)]);
    apply(db, [mkChange('n1', 'Delete', {}, tsAgo(150))]);
    expect(deletedAt(db, 'n1')).toBeNull();
  });

  it('p23_mixed_device_delete_update', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'base', ?1)", [tsAgo(1000)]);
    apply(db, [
      mkChange('n1', 'Update', {
        id: 'n1', title: 'b_update', updated_at: tsAgo(100), deleted_at: null,
      }, tsAgo(100)),
      mkChange('n1', 'Delete', {}, tsAgo(50)),
    ]);
    expect(deletedAt(db, 'n1')).not.toBeNull();
    expect(getTitle(db, 'n1')).toBe('b_update');
  });

  it('p24_rogue_deleted_at_value', () => {
    const db = newDb();
    db.run(
      "INSERT INTO test_items (id, title, updated_at, deleted_at) VALUES ('n1', 't', ?1, 'INVALID_TS_STR')",
      [tsAgo(100)],
    );
    apply(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'revived', updated_at: tsAgo(50), deleted_at: null,
    }, tsAgo(50))]);
    expect(deletedAt(db, 'n1')).toBeNull();
    expect(getTitle(db, 'n1')).toBe('revived');
  });

  it('p25_two_tables_in_one_batch', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE test_items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE test_notes (id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
      ${CHANGE_LOG_SCHEMA}
    `);
    apply(db, [
      mkChange('i1', 'Insert', {
        id: 'i1', title: 'item', updated_at: nowTs(), deleted_at: null,
      }, nowTs(), 'test_items'),
      mkChange('n1', 'Insert', {
        id: 'n1', content: 'note', updated_at: nowTs(), deleted_at: null,
      }, nowTs(), 'test_notes'),
    ]);
    expect(db.pluck("SELECT title FROM test_items WHERE id='i1'")).toBe('item');
    expect(db.pluck("SELECT content FROM test_notes WHERE id='n1'")).toBe('note');
  });

  it('p26_same_record_id_in_different_tables', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE test_a (id TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE test_b (id TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
      ${CHANGE_LOG_SCHEMA}
    `);
    apply(db, [
      mkChange('shared_id', 'Insert', {
        id: 'shared_id', v: 'in_a', updated_at: nowTs(), deleted_at: null,
      }, nowTs(), 'test_a'),
      mkChange('shared_id', 'Insert', {
        id: 'shared_id', v: 'in_b', updated_at: nowTs(), deleted_at: null,
      }, nowTs(), 'test_b'),
    ]);
    expect(db.pluck("SELECT v FROM test_a WHERE id='shared_id'")).toBe('in_a');
    expect(db.pluck("SELECT v FROM test_b WHERE id='shared_id'")).toBe('in_b');
  });

  it('p27_table_with_many_columns', () => {
    const db = newHandle();
    const columns = ['id TEXT PRIMARY KEY', 'updated_at TEXT NOT NULL'];
    for (let i = 0; i < 100; i += 1) columns.push(`c${i} TEXT DEFAULT ''`);
    db.exec(`CREATE TABLE test_big (${columns.join(', ')}); ${CHANGE_LOG_SCHEMA}`);

    const payload: Record<string, unknown> = { id: 'n1', updated_at: nowTs() };
    for (let i = 0; i < 100; i += 1) payload[`c${i}`] = `val_${i}`;
    apply(db, [mkChange('n1', 'Insert', payload, nowTs(), 'test_big')]);
    expect(db.pluck("SELECT c50 FROM test_big WHERE id='n1'")).toBe('val_50');
  });
});

describe('sync pathological P.28-P.35: conflict semantics and payload shape', () => {
  it('p28_array_order_matters_in_tags', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, tags, updated_at) VALUES ('n1', 't', ?1, ?2)", ['["a","b"]', tsAgo(100)]);
    db.run("UPDATE test_items SET tags=?1, updated_at=?2 WHERE id='n1'", ['["a","b","c"]', tsAgo(50)]);
    const { conflict } = applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 't', tags: '["b","a","c"]', updated_at: tsAgo(30), deleted_at: null,
    }, tsAgo(30))]);
    expect(conflict.conflicts_saved).toBeGreaterThan(0);
  });

  it('p29_tags_string_vs_array_empty_compared_equal', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, tags, updated_at) VALUES ('n1', 't', '[]', ?1)", [tsAgo(100)]);
    db.run("UPDATE test_items SET title='local', updated_at=?1 WHERE id='n1'", [tsAgo(50)]);
    const { conflict } = applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'local', tags: [], updated_at: tsAgo(30), deleted_at: null,
    }, tsAgo(30))]);
    expect(conflict.conflicts_saved).toBe(0);
  });

  it('p30_meta_fields_ignored_in_conflict', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE test_items (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL, deleted_at TEXT,
        last_synced_at TEXT, sync_version INTEGER DEFAULT 0,
        remote_id TEXT
      );
      ${CHANGE_LOG_SCHEMA}
    `);
    db.run(
      "INSERT INTO test_items (id, title, updated_at, last_synced_at, remote_id) VALUES ('n1', 'same', ?1, ?2, 'local_rid')",
      [tsAgo(100), tsAgo(90)],
    );
    db.run("UPDATE test_items SET updated_at=?1 WHERE id='n1'", [tsAgo(50)]);
    const { conflict } = applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'same', updated_at: tsAgo(30), deleted_at: null,
      last_synced_at: 'some_other_time', remote_id: 'cloud_rid',
    }, tsAgo(30))]);
    expect(conflict.conflicts_saved).toBe(0);
  });

  it('p31_payload_with_operation_field', () => {
    const db = newDb();
    const result = apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: 't', operation: 'weird', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    // Deliberate deviation from Rust, which rejects the change: columns this schema does not know are
    // kept in `__sync_unknown_fields`, so an older client does not drop a newer client's data.
    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(0);
    expect(getTitle(db, 'n1')).toBe('t');
    expect(unknownFields(db, 'n1')).toEqual({ operation: 'weird' });
  });

  it('p32_record_id_case_sensitive', () => {
    const db = newDb();
    apply(db, [mkChange('Case', 'Insert', {
      id: 'Case', title: 'upper', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    apply(db, [mkChange('case', 'Insert', {
      id: 'case', title: 'lower', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(2);
  });

  it('p33_same_id_different_case_in_batch', () => {
    const db = newDb();
    apply(db, [
      mkChange('NORMALIZE', 'Insert', {
        id: 'NORMALIZE', title: 'upper', updated_at: tsAgo(100), deleted_at: null,
      }, tsAgo(100)),
      mkChange('normalize', 'Insert', {
        id: 'normalize', title: 'lower', updated_at: tsAgo(50), deleted_at: null,
      }, tsAgo(50)),
    ]);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(2);
  });

  it('p34_heterogeneous_payload_shapes', () => {
    const db = newDb();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 100; i += 1) {
      const payload: Record<string, unknown> = {
        id: `n${i}`, updated_at: tsAgo(5000 - i), deleted_at: null,
      };
      if (i % 2 === 0) payload.title = `t${i}`;
      if (i % 3 === 0) payload.counter = i;
      if (i % 5 === 0) payload.tags = `["t${i}"]`;
      changes.push(mkChange(`n${i}`, 'Insert', payload, tsAgo(5000 - i)));
    }
    apply(db, changes);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(100);
  });

  it('p35_payload_with_many_unknown_columns', () => {
    const db = newDb();
    const payload: Record<string, unknown> = {
      id: 'n1', updated_at: nowTs(), deleted_at: null,
    };
    for (let i = 0; i < 200; i += 1) payload[`unknown_${i}`] = i;
    const result = apply(db, [mkChange('n1', 'Insert', payload, nowTs())]);
    // Same deliberate deviation as P.31: unknown columns are kept, not rejected.
    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(0);
    const kept = unknownFields(db, 'n1');
    expect(Object.keys(kept ?? {})).toHaveLength(200);
    expect(kept?.unknown_0).toBe(0);
    expect(kept?.unknown_199).toBe(199);
  });
});

describe('sync pathological P.36: sequential single-change performance', () => {
  it('p36_5000_sequential_single_changes', () => {
    const db = newDb();
    db.exec(`
      CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
      INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
    `);
    const started = performance.now();
    for (let i = 0; i < 5000; i += 1) {
      const id = `r${String(i).padStart(5, '0')}`;
      const ts = tsAgo(10_000 - i);
      apply(db, [mkChange(id, 'Insert', {
        id, title: 't', updated_at: ts, deleted_at: null,
      }, ts)]);
    }
    const elapsed = performance.now() - started;
    const count = db.one<{ count: number }>('SELECT COUNT(*) AS count FROM test_items').count;
    expect(count).toBe(5000);
    console.info(`P.36 5000 sequential applies: elapsed_ms=${elapsed}`);
    expect(elapsed).toBeLessThan(60_000);
    // Runner allowance only; the original <60s assertion above stays strict.
  }, 120_000);
});

describe('sync pathological P.37-P.39: invariants and repeated conflicts', () => {
  it('p37_change_log_count_invariant', () => {
    const db = newDb();
    for (let i = 0; i < 100; i += 1) {
      apply(db, [mkChange(`n${i}`, 'Insert', {
        id: `n${i}`, title: 't', updated_at: tsAgo(5000 - i), deleted_at: null,
      }, tsAgo(5000 - i))]);
    }
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(100);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log') ?? 0)).toBe(100);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0)).toBe(0);
  });

  it('p38_single_record_full_stress', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('hot', 'base', ?1)", [tsAgo(10_000)]);
    for (let round = 0; round < 50; round += 1) {
      db.run('UPDATE test_items SET title=?1, updated_at=?2 WHERE id=?3', [
        `local_round_${round}`, tsAgo(5000 - round * 100), 'hot',
      ]);
      applyWithGuard(db, [mkChange('hot', 'Update', {
        id: 'hot', title: `cloud_${round}`, updated_at: tsAgo(5100 - round * 100), deleted_at: null,
      }, tsAgo(5100 - round * 100))], 'cloud', 'local');
    }
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0)).toBe(100);
    expect(getTitle(db, 'hot')).toBe('local_round_49');
  });

  it('p39_double_delete_preserves_earlier_tombstone', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE test_notes (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT
      );
      ${CHANGE_LOG_SCHEMA}
    `);
    db.run("INSERT INTO test_notes (id, title, updated_at) VALUES ('n1', 't', ?1)", [tsAgo(200)]);

    const deleteChange = (changedAt: string): EngineChange => ({
      table_name: 'test_notes', record_id: 'n1', operation: 'Delete', data: null,
      changed_at: changedAt, change_log_id: null, database_name: null,
      suppress_change_log: true, source_device_id: null, source_seq: null,
    } as EngineChange);

    const first = apply(db, [deleteChange(tsAgo(100))]);
    expect(first.failure_count).toBe(0);
    const firstDeleted = deletedAt(db, 'n1', 'test_notes');

    const second = apply(db, [deleteChange(tsAgo(150))]);
    expect(second.failure_count).toBe(0);
    expect(deletedAt(db, 'n1', 'test_notes')).toBe(firstDeleted);
  });
});

describe('sync pathological P.40: bulk payload and record identity', () => {
  it('p40_bulk_payload_id_record_id_mismatch', () => {
    const db = newDb();
    db.exec(`
      CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
      INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
    `);
    const changes: EngineChange[] = [];
    for (let i = 0; i < 10; i += 1) {
      changes.push(mkChange(`rec_${i}`, 'Insert', {
        id: `payload_${i}`, title: 't', updated_at: tsAgo(100 - i), deleted_at: null,
      }, tsAgo(100 - i)));
    }
    const result = apply(db, changes);
    console.info('P.40 result:', result);
    // A normal return corresponds to Rust's Ok, even when rows were isolated
    // as business failures. Both query_row(...).unwrap() observations still run.
    const payloadCount = db.one<{ count: number }>("SELECT COUNT(*) AS count FROM test_items WHERE id LIKE 'payload_%'").count;
    const recordCount = db.one<{ count: number }>("SELECT COUNT(*) AS count FROM test_items WHERE id LIKE 'rec_%'").count;
    console.info(`P.40 payload_%: ${payloadCount}, rec_%: ${recordCount}`);
  });
});
