/**
 * [L20-engine port] `sync_weird_tests.rs` W.51-W.70 (storage/batch side).
 *
 * Uses ad-hoc F3 file handles for the multi-connection and reopen cases, and
 * the original Rust fixture tables (renamed `test_items` where the public
 * test-fixture allowance is needed). Assertions are unchanged.
 *
 * Not ported here, with the reason recorded in TESTMAP/BLOCKERS:
 * - W.52 needs a real concurrent writer thread with busy-timeout semantics.
 * - W.54 only checks "does not panic"; W.58 only prints.
 * - W.57 needs the unpublished tombstone API.
 * - W.64 only prints.
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

function newPath(name: string): string {
  const dir = join(root, `case-${handles.length}`);
  mkdirSync(dir, { recursive: true });
  caseDirs.push(dir);
  return join(dir, `${name}.db`);
}

function open(path: string): DatabaseHandle {
  const db = storage.openFile(path, { profile: 'plain' });
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
    score REAL NOT NULL DEFAULT 0.0,
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
  // sync_weird_tests.rs:16-17 new_db() is open_in_memory(). The explicit
  // multi-connection/reopen cases below still call open(newPath(...)).
  const db = storage.openFile(':memory:', { profile: 'plain', label: 'weird-batch' });
  handles.push(db);
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
  data: unknown,
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
  root = mkdtempSync(join(tmpdir(), 'l23-weird-batch-sync-'));
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

describe('sync weird W.51-W.56: files, reconnects and crash safety', () => {
  it('w51_multiple_connections_to_same_file', () => {
    const path = newPath('multi');
    const first = open(path);
    first.exec(`
      CREATE TABLE test_items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
        operation TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
      );
    `);
    storage.close(first);
    handles.splice(handles.indexOf(first), 1);

    const second = open(path);
    apply(second, [mkChange('n1', 'Insert', {
      id: 'n1', title: 't', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    storage.close(second);
    handles.splice(handles.indexOf(second), 1);

    const third = open(path);
    expect(getTitle(third, 'n1')).toBe('t');
  });

  it('w53_negative_sync_version_tolerated', () => {
    const db = newDb();
    db.run(
      "INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES ('test_items', 'n1', 'INSERT', -1)",
    );
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0)).toBe(0);
  });

  it('w55_readonly_connection_rejected', () => {
    const path = newPath('readonly');
    const writable = open(path);
    writable.exec(`
      CREATE TABLE test_items (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, deleted_at TEXT);
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT,
        changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0
      );
    `);
    storage.close(writable);
    handles.splice(handles.indexOf(writable), 1);

    const readonly = storage.openFile(path, { profile: { readonly: true } });
    handles.push(readonly);
    const change = mkChange('n1', 'Insert', {
      id: 'n1', title: 't', updated_at: nowTs(), deleted_at: null,
    }, nowTs());
    // Rust :1559-1560 requires an Err from apply, not a panic in fixture setup.
    // Check the engine's database-error boundary rather than accepting any throw.
    expect(() => apply(readonly, [change])).toThrow(/^Database error: .*readonly database/i);
  });

  it('w56_crash_after_commit_preserves_changes', () => {
    const path = newPath('crash');
    const first = open(path);
    first.exec(`
      CREATE TABLE test_items (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT,
        changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0
      );
    `);
    apply(first, [mkChange('n1', 'Insert', {
      id: 'n1', title: 'survives_crash', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    storage.close(first);
    handles.splice(handles.indexOf(first), 1);

    const second = open(path);
    expect(getTitle(second, 'n1')).toBe('survives_crash');
  });

  it('w59_wall_clock_jump_backward_between_events', () => {
    const db = newDb();
    const future = new Date(Date.now() + 30_000).toISOString();
    apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: 'future_me', updated_at: future, deleted_at: null,
    }, future)]);
    const now = nowTs();
    apply(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'corrected_now', updated_at: now, deleted_at: null,
    }, now)]);
    expect(getTitle(db, 'n1')).toBe('future_me');
  });
});

describe('sync weird W.60-W.68: registry, idempotency and conflict reuse', () => {
  it('w60_llm_usage_daily_malformed_record_id', () => {
    const db = open(newPath('llm'));
    db.exec(`
      CREATE TABLE llm_usage_daily (
        date TEXT NOT NULL, caller_type TEXT NOT NULL,
        model TEXT NOT NULL, provider TEXT NOT NULL,
        tokens INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (date, caller_type, model, provider)
      );
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, operation TEXT,
        changed_at TEXT DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0
      );
    `);
    const result = apply(db, [{
      ...mkChange('garbage-no-underscores', 'Delete', {}, nowTs(), 'llm_usage_daily'),
      database_name: 'llm_usage',
    } as EngineChange]);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
  });

  it('w61_identical_edits_from_two_devices_no_conflict', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'base', ?1)", [tsAgo(100)]);
    db.run("UPDATE test_items SET title='both_same', updated_at=?1 WHERE id='n1'", [tsAgo(50)]);
    const { conflict } = applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'both_same', updated_at: tsAgo(20), deleted_at: null,
    }, tsAgo(20))]);
    expect(conflict.conflicts_saved).toBe(0);
    expect(getTitle(db, 'n1')).toBe('both_same');
  });

  it('w62_empty_vs_whitespace_title_distinct', () => {
    const db = newDb();
    apply(db, [mkChange('e', 'Insert', {
      id: 'e', title: '', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    apply(db, [mkChange('w', 'Insert', {
      id: 'w', title: '   ', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(getTitle(db, 'e')).toBe('');
    expect(getTitle(db, 'w')).toBe('   ');
  });

  it('w63_all_changes_without_suppress_flag', () => {
    const db = newDb();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 5; i += 1) {
      changes.push({
        ...mkChange(`n${i}`, 'Insert', {
          id: `n${i}`, title: `v${i}`, updated_at: nowTs(), deleted_at: null,
        }, nowTs()),
        suppress_change_log: null,
      } as EngineChange);
    }
    apply(db, changes);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0))
      .toBeGreaterThanOrEqual(5);
  });

  it('w65_extremely_long_record_id', () => {
    const db = newDb();
    const longId = 'k'.repeat(10_000);
    apply(db, [mkChange(longId, 'Insert', {
      id: longId, title: 't', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(getTitle(db, longId)).toBe('t');
  });

  it('w66_many_small_batches_sequential', () => {
    const db = newDb();
    for (let batch = 0; batch < 50; batch += 1) {
      const changes: EngineChange[] = [];
      for (let i = 0; i < 10; i += 1) {
        const id = `b${batch}_${i}`;
        const stamp = tsAgo(5000 - (batch * 10 + i));
        changes.push(mkChange(id, 'Insert', {
          id, title: `b${batch}_i${i}`, updated_at: stamp, deleted_at: null,
        }, stamp));
      }
      apply(db, changes);
    }
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(500);
  });

  it('w67_existing_conflict_table_is_reused', () => {
    const db = newDb();
    db.exec(`
      CREATE TABLE __sync_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL, record_id TEXT NOT NULL,
        side TEXT NOT NULL, data_json TEXT NOT NULL,
        winning_device_id TEXT, losing_device_id TEXT,
        detected_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT, resolution TEXT
      );
      INSERT INTO __sync_conflicts (table_name, record_id, side, data_json)
      VALUES ('test_items', 'preexisting', 'local', '{}');
    `);
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'base', ?1)", [tsAgo(100)]);
    db.run("UPDATE test_items SET title='local', updated_at=?1 WHERE id='n1'", [tsAgo(50)]);
    applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'cloud', updated_at: tsAgo(30), deleted_at: null,
    }, tsAgo(30))], 'cloud', 'local');
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0)).toBe(3);
  });

  it('w68_resolved_conflicts_dont_block_new_ones', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'base', ?1)", [tsAgo(200)]);
    db.run("UPDATE test_items SET title='local_1', updated_at=?1 WHERE id='n1'", [tsAgo(100)]);
    applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'cloud_1', updated_at: tsAgo(90), deleted_at: null,
    }, tsAgo(90))], 'cloud', 'local');
    db.exec("UPDATE __sync_conflicts SET resolved_at=datetime('now'), resolution='keep_local' WHERE record_id='n1'");
    db.run("UPDATE test_items SET title='local_2', updated_at=?1 WHERE id='n1'", [tsAgo(50)]);
    applyWithGuard(db, [mkChange('n1', 'Update', {
      id: 'n1', title: 'cloud_2', updated_at: tsAgo(40), deleted_at: null,
    }, tsAgo(40))], 'cloud', 'local');
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_conflicts') ?? 0)).toBe(4);
    expect(Number(db.pluck(
      'SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL',
    ) ?? 0)).toBe(2);
  });
});

describe('sync weird W.69-W.70 and force-exact: large batches', () => {
  it('w69_ten_thousand_tiny_records', () => {
    const db = newDb();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const id = `t${String(i).padStart(5, '0')}`;
      const stamp = tsAgo(20_000 - i);
      changes.push(mkChange(id, 'Insert', {
        id, title: 'x', updated_at: stamp, deleted_at: null,
      }, stamp));
    }
    const started = performance.now();
    const result = apply(db, changes);
    const elapsed = performance.now() - started;
    expect(result.success_count).toBe(10_000);
    expect(result.failure_count).toBe(0);
    expect(result.applied_keys.size).toBe(10_000);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(10_000);
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it('apply_results_preserve_prior_keys_after_savepoint_rollback', () => {
    const db = newDb();
    db.exec('PRAGMA foreign_keys = OFF; ALTER TABLE test_items ADD COLUMN parent_id TEXT REFERENCES test_items(id);');
    const initialTs = tsAgo(300);
    const updateTs = tsAgo(200);
    const result = apply(db, [
      mkChange('shared', 'Insert', {
        id: 'shared', title: 'kept', updated_at: initialTs,
      }, initialTs),
      mkChange('shared', 'Update', {
        id: 'shared', title: 'rolled back', parent_id: 'missing', updated_at: updateTs,
      }, updateTs),
      mkChange('next', 'Insert', {
        id: 'next', title: 'next', updated_at: updateTs,
      }, updateTs),
    ]);
    expect(result.success_count).toBe(2);
    expect(result.failure_count).toBe(1);
    expect(result.skipped_count).toBe(0);
    expect(result.applied_keys.size).toBe(2);
    expect(result.applied_keys.has('test_items\u001fshared')).toBe(true);
    expect(result.applied_keys.has('test_items\u001fnext')).toBe(true);
    expect(result.failures[0]?.record_id).toBe('shared');
    expect(getTitle(db, 'shared')).toBe('kept');
    expect(getTitle(db, 'next')).toBe('next');
    expect(Number(db.pluck('SELECT COUNT(*) FROM __sync_quarantine') ?? 0)).toBe(1);
  });

  it('force_exact_results_are_validated_before_finalize', () => {
    for (const invalid of [false, true]) {
      const db = newDb();
      db.exec('PRAGMA foreign_keys = OFF; ALTER TABLE test_items ADD COLUMN parent_id TEXT REFERENCES test_items(id);');
      const stamp = tsAgo(300);
      const changes: EngineChange[] = [
        mkChange('parent', 'Insert', {
          id: 'parent', title: 'parent', updated_at: stamp,
        }, stamp),
        mkChange('child', 'Insert', {
          id: 'child', title: 'child', updated_at: stamp,
          parent_id: invalid ? 'missing' : 'parent',
        }, stamp),
      ];
      let finalized = false;
      let threw = false;
      try {
        host.ctx.sync.applyDownloadedChangesForceExactWithHooks(db, changes, context, {
          finalize: (_tx, result) => {
            finalized = true;
            expect(result.success_count).toBe(2);
            expect(result.failure_count).toBe(0);
            expect(result.applied_keys.size).toBe(2);
          },
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(invalid);
      expect(finalized).toBe(!invalid);
      expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(invalid ? 0 : 2);
    }
  });

  it('w70_seven_devices_cross_edit', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'base', ?1)", [tsAgo(1000)]);
    const changes: EngineChange[] = [];
    for (let dev = 0; dev < 7; dev += 1) {
      const stamp = tsAgo(500 - dev * 50);
      changes.push(mkChange('n1', 'Update', {
        id: 'n1', title: `dev_${dev}`, counter: dev, updated_at: stamp, deleted_at: null,
      }, stamp));
    }
    apply(db, changes);
    expect(getTitle(db, 'n1')).toBe('dev_6');
    expect(db.pluck("SELECT counter FROM test_items WHERE id='n1'")).toBe(6);
  });
});
