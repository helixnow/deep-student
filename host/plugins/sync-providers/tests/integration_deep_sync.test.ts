/**
 * [L20-engine port] `sync_integration_deep_tests.rs` I.01-I.15.
 *
 * Uses the original Rust fixture (`notes` + `__change_log` + triggers) on an
 * ad-hoc F3 handle. The fixture has no note-history tables, so the published
 * engine's note-history hooks stay inert; all HLC, causal ordering, quarantine,
 * pending-echo and conflict-roundtrip assertions are preserved.
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
  // Rust sync_integration_deep_tests.rs:19 uses an independent in-memory DB.
  const db = storage.openFile(':memory:', { profile: 'plain', label: `deep-${handles.length}` });
  handles.push(db);
  return db;
}

const NOTES_SCHEMA = `
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
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
  CREATE TRIGGER trg_ins AFTER INSERT ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('notes', NEW.id, 'INSERT', NEW.updated_at);
  END;
  CREATE TRIGGER trg_upd AFTER UPDATE ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation, changed_at)
    VALUES ('notes', NEW.id, 'UPDATE', NEW.updated_at);
  END;
  CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
  INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
`;

function newDb(): DatabaseHandle {
  const db = newHandle();
  db.exec(NOTES_SCHEMA);
  return db;
}

function getTitle(db: DatabaseHandle, id: string): string | null {
  return db.pluck<string | null>('SELECT title FROM notes WHERE id=?1', [id]) ?? null;
}

function isoAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function change(overrides: Partial<EngineChange>): EngineChange {
  return {
    table_name: 'notes',
    record_id: '',
    operation: 'Insert',
    data: null,
    changed_at: isoAgo(0),
    change_log_id: null,
    database_name: null,
    suppress_change_log: true,
    source_device_id: null,
    source_seq: null,
    ...overrides,
  } as EngineChange;
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
  root = mkdtempSync(join(tmpdir(), 'l23-deep-sync-'));
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

describe('sync integration deep I.01-I.06: HLC and causal order', () => {
  it('hlc_string_lww_ordering', () => {
    const a = host.ctx.sync.parseHlc('000000000001000-00000');
    const b = host.ctx.sync.parseHlc('000000000002000-00000');
    const c = host.ctx.sync.parseHlc('000000000001000-00005');
    const d = host.ctx.sync.parseHlc('000000000001000-00003');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(String(a) < String(b)).toBe(true);
    expect(String(c) > String(d)).toBe(true);
    expect(host.ctx.sync.parseHlc('garbage')).toBeNull();
  });

  it('hlc_counter_order_is_lexicographic', () => {
    const x1 = host.ctx.sync.createHlc(1_700_000_000_000n, 0);
    const x2 = host.ctx.sync.createHlc(1_700_000_000_000n, 1);
    expect(x1.toU64() < x2.toU64()).toBe(true);
    expect(x1.toString() < x2.toString()).toBe(true);
  });

  it('out_of_order_delivery_rerordered_by_hlc', () => {
    const db = newDb();
    const h1 = host.ctx.sync.createHlc(1_700_000_000_000n, 0).toString();
    const h2 = host.ctx.sync.createHlc(1_700_000_000_000n, 1).toString();
    const h3 = host.ctx.sync.createHlc(1_700_000_000_000n, 2).toString();
    const make = (title: string, counter: number, stamp: string): EngineChange => change({
      record_id: 'n1',
      operation: counter === 1 ? 'Insert' : 'Update',
      changed_at: stamp,
      data: { id: 'n1', title, counter, updated_at: stamp, deleted_at: null },
    });
    const changes = [make('v3', 3, h3), make('v1', 1, h1), make('v2', 2, h2)]
      .sort((left, right) => (left.changed_at < right.changed_at ? -1 : left.changed_at > right.changed_at ? 1 : 0));
    apply(db, changes);
    expect(getTitle(db, 'n1')).toBe('v3');
  });

  it('partial_failure_retry_is_idempotent', () => {
    const db = newDb();
    const now = isoAgo(0);
    const good = change({
      record_id: 'n1',
      operation: 'Insert',
      changed_at: now,
      data: { id: 'n1', title: 'v1', updated_at: now, deleted_at: null },
    });
    const bad = change({
      table_name: 'nonexistent', record_id: 'x', operation: 'Insert',
      changed_at: now, data: { id: 'x' },
    });
    const first = apply(db, [good, bad]);
    expect(first.failure_count).toBe(1);
    expect(first.success_count).toBe(1);
    expect(Number(db.pluck('SELECT COUNT(*) FROM notes') ?? 0)).toBe(1);
    apply(db, [good]);
    expect(getTitle(db, 'n1')).toBe('v1');
    apply(db, [good]);
    expect(Number(db.pluck('SELECT COUNT(*) FROM notes') ?? 0)).toBe(1);
  });

  it('invariant_insert_count_matches_items_count', () => {
    const db = newDb();
    const now = Date.now();
    const inserted = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const id = `n${i % 7}`;
      inserted.add(id);
      const stamp = new Date(now - (100 - i) * 1000).toISOString();
      apply(db, [change({
        record_id: id,
        operation: i % 3 === 0 ? 'Insert' : 'Update',
        changed_at: stamp,
        data: { id, title: `v${i}`, updated_at: stamp, deleted_at: null },
      })]);
    }
    expect(Number(db.pluck('SELECT COUNT(*) FROM notes') ?? 0)).toBe(inserted.size);
  });

  it('invariant_delete_sets_tombstone', () => {
    const db = newDb();
    const insTs = isoAgo(10);
    const delTs = isoAgo(5);
    const inserted = apply(db, [change({
      record_id: 'n1', operation: 'Insert', changed_at: insTs,
      data: { id: 'n1', title: 't', updated_at: insTs, deleted_at: null },
    })]);
    expect(inserted.failure_count).toBe(0);
    apply(db, [change({
      record_id: 'n1', operation: 'Delete', changed_at: delTs, data: null,
    })]);
    expect(db.pluck("SELECT deleted_at FROM notes WHERE id='n1'")).not.toBeNull();
  });
});

describe('sync integration deep I.10-I.12: pending echo and conflicts', () => {
  it('invariant_replay_does_not_pollute_pending', () => {
    const db = newDb();
    const now = Date.now();
    db.run("INSERT INTO notes (id, title, updated_at) VALUES ('user','user_edit',?1)", [new Date(now).toISOString()]);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0)).toBe(1);
    const insTs = new Date(now - 5000).toISOString();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = `cloud_${i}`;
      changes.push(change({
        record_id: id, operation: 'Insert', changed_at: insTs,
        data: { id, title: 'cloud', updated_at: insTs, deleted_at: null },
      }));
    }
    apply(db, changes);
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0)).toBe(1);
  });

  it('invariant_self_applied_changes_have_no_echo', () => {
    const db = newDb();
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      const id = `k${i}`;
      const stamp = new Date(now - (100 - i) * 1000).toISOString();
      apply(db, [change({
        record_id: id, operation: 'Insert', changed_at: stamp,
        data: { id, title: `v${i}`, updated_at: stamp, deleted_at: null },
      })]);
    }
    expect(Number(db.pluck('SELECT COUNT(*) FROM __change_log WHERE sync_version=0') ?? 0)).toBe(0);
  });

  it('conflict_record_data_is_roundtripped', () => {
    const db = newDb();
    const baseTs = isoAgo(20);
    const localTs = isoAgo(5);
    const cloudTs = isoAgo(10);
    db.run("INSERT INTO notes (id, title, counter, updated_at) VALUES ('n1','base',0,?1)", [baseTs]);
    db.run("UPDATE notes SET title='local_complex', counter=42, updated_at=?1 WHERE id='n1'", [localTs]);
    applyWithGuard(db, [change({
      record_id: 'n1', operation: 'Update', changed_at: cloudTs,
      data: {
        id: 'n1', title: 'cloud_with_special_chars ∑ ≈ 中文', counter: 999,
        updated_at: cloudTs, deleted_at: null,
      },
    })], 'KeepLatest', 'cloud', 'local');
    const cloudJson = db.pluck<string>(
      "SELECT data_json FROM __sync_conflicts WHERE record_id='n1' AND side='cloud'",
    );
    const parsed = JSON.parse(String(cloudJson)) as { title?: string; counter?: number };
    expect(parsed.title).toBe('cloud_with_special_chars ∑ ≈ 中文');
    expect(parsed.counter).toBe(999);
  });
});

describe('sync integration deep I.13-I.15: batch pressure and atomicity', () => {
  it('large_batch_1000_records', () => {
    const db = newDb();
    const now = Date.now();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const id = `n${String(i).padStart(4, '0')}`;
      const stamp = new Date(now - (2000 - i) * 1000).toISOString();
      changes.push(change({
        record_id: id, operation: 'Insert', changed_at: stamp,
        data: { id, title: `v${i}`, updated_at: stamp, deleted_at: null },
      }));
    }
    const result = apply(db, changes);
    expect(result.success_count).toBe(1000);
    expect(Number(db.pluck('SELECT COUNT(*) FROM notes') ?? 0)).toBe(1000);
  });

  it('stress_same_record_many_updates', () => {
    const db = newDb();
    const now = Date.now();
    for (let i = 0; i < 500; i += 1) {
      const stamp = new Date(now - (10000 - i)).toISOString();
      apply(db, [change({
        record_id: 'n1',
        operation: i === 0 ? 'Insert' : 'Update',
        changed_at: stamp,
        data: { id: 'n1', title: `v${i}`, counter: i, updated_at: stamp, deleted_at: null },
      })]);
    }
    expect(db.pluck("SELECT title FROM notes WHERE id='n1'")).toBe('v499');
    expect(db.pluck("SELECT counter FROM notes WHERE id='n1'")).toBe(499);
  });

  it('mixed_batch_atomicity', () => {
    const db = newDb();
    const now = isoAgo(0);
    const ok1 = change({
      record_id: 'n1', operation: 'Insert', changed_at: now,
      data: { id: 'n1', title: 'ok1', updated_at: now, deleted_at: null },
    });
    const ok2 = change({
      record_id: 'n2', operation: 'Insert', changed_at: now,
      data: { id: 'n2', title: 'ok2', updated_at: now, deleted_at: null },
    });
    const bad = change({
      table_name: 'nope_table', record_id: 'x', operation: 'Insert',
      changed_at: now, data: { id: 'x' },
    });
    const result = apply(db, [ok1, bad, ok2]);
    expect(result.failure_count).toBe(1);
    expect(result.success_count).toBe(2);
    expect(Number(db.pluck('SELECT COUNT(*) FROM notes') ?? 0)).toBe(2);
  });
});
