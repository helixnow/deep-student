/**
 * [L20-engine port] `sync_proptest.rs` property tests.
 *
 * The Rust file uses `proptest` (128/64 random cases per property). This port
 * keeps the same invariants and case counts with a deterministic PRNG instead
 * of adding the `proptest` crate: every case still drives the published
 * `ctx.sync.applyDownloadedChanges*` engine against the original fixture schema,
 * and no apply/conflict algorithm is reimplemented here.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageService } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';

let root: string;
let storage: StorageService;
let host: TestHost;
let caseCounter = 0;
const handles: DatabaseHandle[] = [];

function unused(service: string): object {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`test unexpectedly entered ${service}.${String(key)}`);
    },
  });
}

function newDb(): DatabaseHandle {
  // Rust sync_proptest.rs:28 uses open_in_memory; disk fsync is not part of
  // these apply invariants and can block the worker's RPC event loop.
  const db = storage.openFile(':memory:', { profile: 'plain', label: `prop-${caseCounter++}` });
  handles.push(db);
  db.exec(`
    CREATE TABLE test_items (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
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
    CREATE TRIGGER trg_items_ins AFTER INSERT ON test_items BEGIN
      INSERT INTO __change_log (table_name, record_id, operation)
      VALUES ('test_items', NEW.id, 'INSERT');
    END;
    CREATE TRIGGER trg_items_upd AFTER UPDATE ON test_items BEGIN
      INSERT INTO __change_log (table_name, record_id, operation)
      VALUES ('test_items', NEW.id, 'UPDATE');
    END;
    CREATE TRIGGER trg_items_del AFTER DELETE ON test_items BEGIN
      INSERT INTO __change_log (table_name, record_id, operation)
      VALUES ('test_items', OLD.id, 'DELETE');
    END;
    CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
    INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
  `);
  return db;
}

function resetDb(db: DatabaseHandle): void {
  db.exec(`
    DROP TABLE IF EXISTS __sync_conflicts;
    DELETE FROM test_items;
    DELETE FROM __change_log;
  `);
}

interface PropOp {
  kind: 'Insert' | 'Update' | 'Delete';
  id: string;
  label: string;
  counter: number;
}

/** Deterministic replacement for proptest's RNG; fixed seeds keep failures reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function randomInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

const ID_POOL = ['a', 'b', 'c', 'd', 'e'] as const;
const LABEL_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomLabel(rng: () => number): string {
  const length = randomInt(rng, 17);
  let label = '';
  for (let index = 0; index < length; index += 1) label += pick(rng, [...LABEL_CHARS]);
  return label;
}

function randomOp(rng: () => number): PropOp {
  const roll = rng();
  const id = pick(rng, ID_POOL);
  if (roll < 1 / 3) return { kind: 'Insert', id, label: randomLabel(rng), counter: randomInt(rng, 100) };
  if (roll < 2 / 3) return { kind: 'Update', id, label: randomLabel(rng), counter: randomInt(rng, 100) };
  return { kind: 'Delete', id, label: '', counter: 0 };
}

function randomOps(rng: () => number, min: number, max: number): PropOp[] {
  const count = min + randomInt(rng, max - min + 1);
  const ops: PropOp[] = [];
  for (let index = 0; index < count; index += 1) ops.push(randomOp(rng));
  return ops;
}

function rfc3339(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

/** Rust `ops_to_changes`: one monotonically increasing timestamp per op. */
function opsToChanges(ops: readonly PropOp[], baseSeconds: number): EngineChange[] {
  return ops.map((op, index) => {
    const timestamp = rfc3339(baseSeconds + index);
    const base = {
      table_name: 'test_items',
      record_id: op.id,
      changed_at: timestamp,
      change_log_id: null,
      database_name: 'test',
      suppress_change_log: true,
      source_device_id: null,
      source_seq: null,
    };
    if (op.kind === 'Delete') return { ...base, operation: 'Delete' as const, data: null };
    return {
      ...base,
      operation: op.kind,
      data: {
        id: op.id,
        label: op.label,
        counter: op.counter,
        updated_at: timestamp,
        deleted_at: null,
      },
    };
  });
}

function itemsChecksum(db: DatabaseHandle): string {
  const rows = db.all<{
    id: string;
    label: string;
    counter: number;
    updated_at: string;
    deleted_at: string | null;
  }>('SELECT id, label, counter, updated_at, deleted_at FROM test_items ORDER BY id');
  const tuple = rows.map(row => [row.id, row.label, row.counter, row.updated_at, row.deleted_at]);
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex').slice(0, 32);
}

function conflictCount(db: DatabaseHandle, recordId: string): number {
  return Number(db.pluck<number>(
    "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id = ?1 AND side = 'local'",
    [recordId],
  ) ?? 0);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-proptest-sync-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  host = await createTestHost();
  host.ctx.provide('storage', storage);
  host.ctx.provide('paths', { deviceId: async () => 'device-local' });
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
  vi.setConfig({ testTimeout: 180_000 });
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

describe('sync proptest properties', () => {
  it('prop_idempotent_apply', () => {
    const rng = mulberry32(0x1d3a_0001);
    const dbA = newDb();
    const dbB = newDb();
    for (let run = 0; run < 128; run += 1) {
      resetDb(dbA);
      resetDb(dbB);
      const changes = opsToChanges(randomOps(rng, 0, 30), 1_700_000_000);
      host.ctx.sync.applyDownloadedChanges(dbA, changes, { deviceId: 'device-local', allowSyncTestFixtureTables: true });
      const sumOnce = itemsChecksum(dbA);
      for (let repeat = 0; repeat < 3; repeat += 1) {
        host.ctx.sync.applyDownloadedChanges(dbB, changes, { deviceId: 'device-local', allowSyncTestFixtureTables: true });
      }
      expect(itemsChecksum(dbB)).toBe(sumOnce);
    }
  });

  it('prop_conflict_guard_never_loses_data', () => {
    const rng = mulberry32(0x1d3a_0002);
    for (let run = 0; run < 64; run += 1) {
      const db = newDb();
      const preOps = randomOps(rng, 1, 10);
      const cloudOps = randomOps(rng, 1, 10);
      host.ctx.sync.applyDownloadedChanges(db, opsToChanges(preOps, 1_700_000_000), {
        deviceId: 'local_dev',
        allowSyncTestFixtureTables: true,
      });
      const ids = db.all<{ id: string }>('SELECT id FROM test_items WHERE deleted_at IS NULL')
        .map(row => row.id);
      for (const id of ids) {
        db.run(
          "UPDATE test_items SET label = 'local_edit', counter = counter + 1, updated_at = ?1 WHERE id = ?2",
          ['2026-05-01T12:00:00Z', id],
        );
      }
      const localLabels = new Map(
        db.all<{ id: string; label: string }>('SELECT id, label FROM test_items WHERE deleted_at IS NULL')
          .map(row => [row.id, row.label] as const),
      );
      const cloudChanges = opsToChanges(cloudOps, 1_800_000_000);
      host.ctx.sync.applyDownloadedChangesWithConflictGuard(
        db,
        cloudChanges,
        { deviceId: 'local_dev', allowSyncTestFixtureTables: true },
        { policy: 'KeepCloud', cloudDeviceId: 'cloud_dev', localDeviceId: 'local_dev' },
      );
      for (const [id, label] of localLabels) {
        const cloudTouched = cloudOps.some(op => op.id === id);
        if (cloudTouched) {
          expect(conflictCount(db, id), `id=${id} label=${label} run=${run}`).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('prop_convergence_after_global_sort', () => {
    const rng = mulberry32(0x1d3a_0003);
    const dbA = newDb();
    const dbB = newDb();
    for (let run = 0; run < 64; run += 1) {
      resetDb(dbA);
      resetDb(dbB);
      const changes = [
        ...opsToChanges(randomOps(rng, 1, 8), 1_700_000_000),
        ...opsToChanges(randomOps(rng, 1, 8), 1_700_001_000),
      ].sort((left, right) => left.changed_at.localeCompare(right.changed_at));
      host.ctx.sync.applyDownloadedChanges(dbA, changes, { deviceId: 'a', allowSyncTestFixtureTables: true });
      host.ctx.sync.applyDownloadedChanges(dbB, changes, { deviceId: 'b', allowSyncTestFixtureTables: true });
      expect(itemsChecksum(dbB)).toBe(itemsChecksum(dbA));
    }
  });

  it('prop_invalid_change_is_isolated', () => {
    const rng = mulberry32(0x1d3a_0004);
    for (let run = 0; run < 64; run += 1) {
      const ops = randomOps(rng, 1, 20);
      const head = ops.slice(0, Math.floor(ops.length / 2));
      const headChanges = opsToChanges(head, 1_700_000_000);
      const tailChanges = opsToChanges(ops, 1_700_001_000);

      const db = newDb();
      host.ctx.sync.applyDownloadedChanges(db, headChanges, { deviceId: 'device-local', allowSyncTestFixtureTables: true });
      host.ctx.sync.applyDownloadedChanges(db, tailChanges, { deviceId: 'device-local', allowSyncTestFixtureTables: true });

      const withoutBad = newDb();
      host.ctx.sync.applyDownloadedChanges(withoutBad, headChanges, { deviceId: 'device-local', allowSyncTestFixtureTables: true });
      host.ctx.sync.applyDownloadedChanges(withoutBad, tailChanges, { deviceId: 'device-local', allowSyncTestFixtureTables: true });
      const sumWithoutBad = itemsChecksum(withoutBad);

      const bad: EngineChange = {
        table_name: 'nonexistent_table',
        record_id: 'bad',
        operation: 'Insert',
        data: { id: 'bad' },
        changed_at: '2026-05-01T10:00:00Z',
        change_log_id: null,
        database_name: null,
        suppress_change_log: true,
        source_device_id: null,
        source_seq: null,
      };
      const result = host.ctx.sync.applyDownloadedChanges(
        db,
        [...tailChanges, bad],
        { deviceId: 'device-local', allowSyncTestFixtureTables: true },
      );
      expect(result.failure_count, `run=${run}`).toBe(1);
      expect(itemsChecksum(db)).toBe(sumWithoutBad);
    }
  });

  it('prop_insert_and_update_equivalent_when_record_exists', () => {
    const rng = mulberry32(0x1d3a_0005);
    const dbA = newDb();
    const dbB = newDb();
    for (let run = 0; run < 128; run += 1) {
      resetDb(dbA);
      resetDb(dbB);
      const id = pick(rng, ID_POOL);
      const label = randomLabel(rng);
      const counter = randomInt(rng, 1000);
      const initial: EngineChange = {
        table_name: 'test_items',
        record_id: id,
        operation: 'Insert',
        data: { id, label: 'initial', counter: 0, updated_at: '2026-01-01T00:00:00Z' },
        changed_at: '2026-01-01T00:00:00Z',
        change_log_id: null,
        database_name: 'test',
        suppress_change_log: true,
        source_device_id: null,
        source_seq: null,
      };
      host.ctx.sync.applyDownloadedChanges(dbA, [initial], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
      host.ctx.sync.applyDownloadedChanges(dbB, [initial], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

      const timestamp = '2026-05-01T10:00:00Z';
      const data = { id, label, counter, updated_at: timestamp };
      const insertChange: EngineChange = {
        table_name: 'test_items',
        record_id: id,
        operation: 'Insert',
        data,
        changed_at: timestamp,
        change_log_id: null,
        database_name: 'test',
        suppress_change_log: true,
        source_device_id: null,
        source_seq: null,
      };
      const updateChange: EngineChange = { ...insertChange, operation: 'Update' };
      host.ctx.sync.applyDownloadedChanges(dbA, [insertChange], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
      host.ctx.sync.applyDownloadedChanges(dbB, [updateChange], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
      expect(itemsChecksum(dbB)).toBe(itemsChecksum(dbA));
    }
  });

  it('prop_delete_is_idempotent', () => {
    const rng = mulberry32(0x1d3a_0006);
    for (let run = 0; run < 64; run += 1) {
      const db = newDb();
      const count = 1 + randomInt(rng, 7);
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) ids.push(pick(rng, ID_POOL));
      for (const id of ids) {
        host.ctx.sync.applyDownloadedChanges(db, [{
          table_name: 'test_items',
          record_id: id,
          operation: 'Insert',
          data: { id, label: 'hi', counter: 1, updated_at: '2026-01-01T00:00:00Z' },
          changed_at: '2026-01-01T00:00:00Z',
          change_log_id: null,
          database_name: 'test',
          suppress_change_log: true,
          source_device_id: null,
          source_seq: null,
        }], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
      }
      for (const id of ids) {
        const deletion: EngineChange = {
          table_name: 'test_items',
          record_id: id,
          operation: 'Delete',
          data: null,
          changed_at: '2026-05-01T10:00:00Z',
          change_log_id: null,
          database_name: 'test',
          suppress_change_log: true,
          source_device_id: null,
          source_seq: null,
        };
        for (let repeat = 0; repeat < 3; repeat += 1) {
          host.ctx.sync.applyDownloadedChanges(db, [deletion], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
        }
      }
      expect(Number(db.pluck<number>('SELECT COUNT(*) FROM test_items WHERE deleted_at IS NULL') ?? 0))
        .toBe(0);
    }
  });
});
