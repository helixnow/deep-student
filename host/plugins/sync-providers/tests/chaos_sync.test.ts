/**
 * [L20-engine port] `sync_chaos_tests.rs` convergence scenarios.
 *
 * The Rust harness uses StdRng seeds; this port keeps the same action mix,
 * cursor/global-sort exchange rules, assertions and seeds with a deterministic
 * in-file PRNG. Every apply calls the published `ctx.sync.applyDownloadedChanges`
 * engine on the `test_items` fixture table.
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

let root: string;
let storage: StorageService;
let host: TestHost;
let caseCounter = 0;
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

function newDb(deviceId: string): DatabaseHandle {
  // Match the Rust fixture's in-memory SQLite; a disk DB makes the long chaos
  // sessions slow enough to trip Vitest's worker RPC timeout.
  const label = `chaos-${caseCounter++}`;
  const db = storage.openFile(':memory:', { profile: 'plain', label });
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
      INSERT INTO __change_log (table_name, record_id, operation, changed_at)
      VALUES ('test_items', NEW.id, 'INSERT', NEW.updated_at);
    END;
    CREATE TRIGGER trg_items_upd AFTER UPDATE ON test_items BEGIN
      INSERT INTO __change_log (table_name, record_id, operation, changed_at)
      VALUES ('test_items', NEW.id, 'UPDATE', NEW.updated_at);
    END;
    CREATE TRIGGER trg_items_del AFTER DELETE ON test_items BEGIN
      INSERT INTO __change_log (table_name, record_id, operation, changed_at)
      VALUES ('test_items', OLD.id, 'DELETE', OLD.updated_at);
    END;
    CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
    INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
  `);
  db.run(
    "INSERT INTO __change_log (table_name, record_id, operation) VALUES ('__meta', ?1, 'INSERT')",
    [deviceId],
  );
  return db;
}

function rfc3339(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

function localInsertOrUpdate(db: DatabaseHandle, id: string, label: string, counter: number, tsSec: number): void {
  db.run(
    `INSERT INTO test_items (id, label, counter, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, NULL)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, counter = excluded.counter,
                                   updated_at = excluded.updated_at, deleted_at = NULL`,
    [id, label, counter, rfc3339(tsSec)],
  );
}

function localDelete(db: DatabaseHandle, id: string, tsSec: number): void {
  const timestamp = rfc3339(tsSec);
  db.run(
    'UPDATE test_items SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL',
    [timestamp, id],
  );
}

function drainPendingChanges(db: DatabaseHandle, _deviceId: string): EngineChange[] {
  const rows = db.all<{
    id: number;
    table_name: string;
    record_id: string;
    operation: string;
    changed_at: string;
  }>("SELECT id, table_name, record_id, operation, changed_at FROM __change_log WHERE sync_version = 0 AND table_name != '__meta' ORDER BY id");
  const changes: EngineChange[] = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    const operation = row.operation === 'INSERT'
      ? 'Insert' as const
      : row.operation === 'UPDATE' ? 'Update' as const : row.operation === 'DELETE' ? 'Delete' as const : null;
    if (operation === null) continue;
    let data: EngineChange['data'] = null;
    if (operation !== 'Delete') {
      const record = db.get<{
        id: string;
        label: string;
        counter: number;
        updated_at: string;
        deleted_at: string | null;
      }>('SELECT id, label, counter, updated_at, deleted_at FROM test_items WHERE id = ?1', [row.record_id]);
      if (record !== undefined) {
        data = {
          id: record.id,
          label: record.label,
          counter: record.counter,
          updated_at: record.updated_at,
          deleted_at: record.deleted_at,
        };
      }
    }
    db.run('UPDATE __change_log SET sync_version = ?1 WHERE id = ?2', [nowSeconds, row.id]);
    changes.push({
      table_name: row.table_name,
      record_id: row.record_id,
      operation,
      data,
      changed_at: row.changed_at,
      change_log_id: null,
      database_name: 'test',
      suppress_change_log: true,
      source_device_id: null,
      source_seq: null,
    });
  }
  return changes;
}

function apply(db: DatabaseHandle, changes: readonly EngineChange[]): void {
  host.ctx.sync.applyDownloadedChanges(db, changes, {
    deviceId: 'device-local',
    allowSyncTestFixtureTables: true,
  });
}

function itemsSignature(db: DatabaseHandle): string {
  const rows = db.all<{
    id: string;
    label: string;
    counter: number;
    deleted_at: string | null;
  }>('SELECT id, label, counter, deleted_at FROM test_items ORDER BY id');
  return JSON.stringify(rows.map(row => [row.id, row.label, row.counter, row.deleted_at !== null]));
}

/** Yield so Vitest's worker RPC watchdog can observe long synchronous sessions. */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function itemsToMap(db: DatabaseHandle): Map<string, [string, number, boolean]> {
  const rows = db.all<{
    id: string;
    label: string;
    counter: number;
    deleted_at: string | null;
  }>('SELECT id, label, counter, deleted_at FROM test_items');
  return new Map(rows.map(row => [row.id, [row.label, row.counter, row.deleted_at !== null]] as const));
}

const IDS = ['k1', 'k2', 'k3', 'k4', 'k5'] as const;
const LABELS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as const;

async function runChaosSession(seed: number, maxSteps: number, networkFaultRate: number): Promise<[string, string, number, number]> {
  const rng = mulberry32(seed);
  const dbA = newDb('dev_a');
  const dbB = newDb('dev_b');
  const cloud: Array<{ source: string; change: EngineChange }> = [];
  let aCursor = 0;
  let bCursor = 0;
  let aOps = 0;
  let bOps = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    if (step % 50 === 0) await yieldToEventLoop();
    const actionRoll = Math.floor(rng() * 100);
    const onA = rng() < 0.5;
    const timestamp = 1_700_000_000 + step;
    if (actionRoll <= 25) {
      const id = IDS[Math.floor(rng() * IDS.length)]!;
      const label = LABELS[Math.floor(rng() * LABELS.length)]!;
      const counter = Math.floor(rng() * 1000);
      if (onA) { localInsertOrUpdate(dbA, id, label, counter, timestamp); aOps += 1; }
      else { localInsertOrUpdate(dbB, id, label, counter, timestamp); bOps += 1; }
    } else if (actionRoll <= 40) {
      const id = IDS[Math.floor(rng() * IDS.length)]!;
      if (onA) { localDelete(dbA, id, timestamp); aOps += 1; }
      else { localDelete(dbB, id, timestamp); bOps += 1; }
    } else if (actionRoll <= 90) {
      if (rng() < networkFaultRate) continue;
      if (onA) {
        for (const change of drainPendingChanges(dbA, 'dev_a')) cloud.push({ source: 'dev_a', change });
        const toApply = cloud.slice(aCursor).filter(entry => entry.source === 'dev_b').map(entry => entry.change);
        aCursor = cloud.length;
        apply(dbA, toApply);
      } else {
        for (const change of drainPendingChanges(dbB, 'dev_b')) cloud.push({ source: 'dev_b', change });
        const toApply = cloud.slice(bCursor).filter(entry => entry.source === 'dev_a').map(entry => entry.change);
        bCursor = cloud.length;
        apply(dbB, toApply);
      }
    }
  }

  for (let round = 0; round < 10; round += 1) {
    const aChanges = drainPendingChanges(dbA, 'dev_a');
    const bChanges = drainPendingChanges(dbB, 'dev_b');
    const hadNew = aChanges.length > 0 || bChanges.length > 0;
    for (const change of aChanges) cloud.push({ source: 'dev_a', change });
    for (const change of bChanges) cloud.push({ source: 'dev_b', change });
    cloud.sort((left, right) => {
      const byTime = left.change.changed_at.localeCompare(right.change.changed_at);
      if (byTime !== 0) return byTime;
      const bySource = left.source.localeCompare(right.source);
      if (bySource !== 0) return bySource;
      return left.change.record_id.localeCompare(right.change.record_id);
    });
    apply(dbA, cloud.filter(entry => entry.source === 'dev_b').map(entry => entry.change));
    apply(dbB, cloud.filter(entry => entry.source === 'dev_a').map(entry => entry.change));
    if (!hadNew) break;
  }

  return [itemsSignature(dbA), itemsSignature(dbB), aOps, bOps];
}

async function runThreeDeviceSession(seed: number, maxSteps: number): Promise<[string, string, string]> {
  const rng = mulberry32(seed);
  const devices = [
    { name: 'dev_a', db: newDb('dev_a') },
    { name: 'dev_b', db: newDb('dev_b') },
    { name: 'dev_c', db: newDb('dev_c') },
  ];
  const cloud: Array<{ source: string; change: EngineChange }> = [];
  const ids = ['k1', 'k2', 'k3'] as const;
  const labels = ['alpha', 'beta'] as const;

  for (let step = 0; step < maxSteps; step += 1) {
    if (step % 25 === 0) await yieldToEventLoop();
    const device = devices[Math.floor(rng() * devices.length)]!;
    const timestamp = 1_700_000_000 + step;
    const action = Math.floor(rng() * 100);
    if (action <= 30) {
      localInsertOrUpdate(
        device.db,
        ids[Math.floor(rng() * ids.length)]!,
        labels[Math.floor(rng() * labels.length)]!,
        Math.floor(rng() * 100),
        timestamp,
      );
    } else if (action <= 40) {
      localDelete(device.db, ids[Math.floor(rng() * ids.length)]!, timestamp);
    } else {
      for (const change of drainPendingChanges(device.db, device.name)) cloud.push({ source: device.name, change });
      const toApply = cloud.filter(entry => entry.source !== device.name).map(entry => entry.change);
      apply(device.db, toApply);
    }
  }

  for (let round = 0; round < 10; round += 1) {
    await yieldToEventLoop();
    for (const device of devices) {
      for (const change of drainPendingChanges(device.db, device.name)) cloud.push({ source: device.name, change });
    }
    cloud.sort((left, right) => left.change.changed_at.localeCompare(right.change.changed_at));
    for (const device of devices) {
      apply(device.db, cloud.filter(entry => entry.source !== device.name).map(entry => entry.change));
    }
  }
  return [itemsSignature(devices[0]!.db), itemsSignature(devices[1]!.db), itemsSignature(devices[2]!.db)];
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-chaos-sync-'));
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

describe('sync chaos convergence', () => {
  it('chaos_short_session_converges_seed_1', async () => {
    const [a, b, aOps, bOps] = await runChaosSession(1, 100, 0);
    expect(a, `a_ops=${aOps} b_ops=${bOps}`).toBe(b);
  }, 120_000);

  it('chaos_short_session_converges_seed_42', async () => {
    const [a, b, aOps, bOps] = await runChaosSession(42, 100, 0);
    expect(a, `a_ops=${aOps} b_ops=${bOps}`).toBe(b);
  }, 120_000);

  it('chaos_medium_session_converges', async () => {
    const [a, b, aOps, bOps] = await runChaosSession(9999, 500, 0);
    expect(a, `a_ops=${aOps} b_ops=${bOps}`).toBe(b);
  }, 240_000);

  it('chaos_with_network_faults_still_converges', async () => {
    const [a, b, aOps, bOps] = await runChaosSession(7, 500, 0.3);
    expect(a, `a_ops=${aOps} b_ops=${bOps}`).toBe(b);
  }, 240_000);

  it('chaos_high_fault_rate_still_converges', async () => {
    const [a, b, aOps, bOps] = await runChaosSession(77, 800, 0.6);
    expect(a, `a_ops=${aOps} b_ops=${bOps}`).toBe(b);
  }, 240_000);

  it('chaos_many_seeds_all_converge', async () => {
    const diverged: Array<[number, number, number]> = [];
    for (let seed = 0; seed < 20; seed += 1) {
      const [a, b, aOps, bOps] = await runChaosSession(seed, 200, 0.2);
      if (a !== b) diverged.push([seed, aOps, bOps]);
    }
    expect(diverged).toEqual([]);
  }, 300_000);

  it('chaos_long_session_converges', async () => {
    const [a, b, aOps, bOps] = await runChaosSession(123456, 5000, 0.15);
    expect(a, `a_ops=${aOps} b_ops=${bOps}`).toBe(b);
  }, 300_000);

  // One case per seed keeps each synchronous task below Vitest's worker RPC
  // watchdog while preserving the Rust loop's ten seeds and assertions.
  for (let seed = 0; seed < 10; seed += 1) {
    it(`chaos_three_devices_converge seed=${seed}`, async () => {
      const [a, b, c] = await runThreeDeviceSession(seed, 300);
      expect(a, `seed=${seed} A/B`).toBe(b);
      expect(b, `seed=${seed} B/C`).toBe(c);
    }, 120_000);
  }

  it('chaos_no_runaway_conflict_accumulation', () => {
    const dbA = newDb('dev_a');
    const dbB = newDb('dev_b');
    for (let index = 0; index < 50; index += 1) {
      localInsertOrUpdate(dbA, `n${index}`, 'init', index, 1_700_000_000);
    }
    apply(dbB, drainPendingChanges(dbA, 'dev_a'));
    for (let round = 0; round < 5; round += 1) {
      for (let index = 0; index < 25; index += 1) {
        localInsertOrUpdate(dbA, `n${index}`, `devA_r${round}`, round * 100 + index, 1_700_000_010 + round * 100 + index);
      }
      for (let index = 25; index < 50; index += 1) {
        localInsertOrUpdate(dbB, `n${index}`, `devB_r${round}`, round * 100 + index, 1_700_000_020 + round * 100 + index);
      }
      apply(dbB, drainPendingChanges(dbA, 'dev_a'));
      apply(dbA, drainPendingChanges(dbB, 'dev_b'));
    }
    const pendingA = Number(dbA.pluck<number>(
      "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0 AND table_name != '__meta'",
    ) ?? 0);
    const pendingB = Number(dbB.pluck<number>(
      "SELECT COUNT(*) FROM __change_log WHERE sync_version = 0 AND table_name != '__meta'",
    ) ?? 0);
    expect(pendingA).toBe(0);
    expect(pendingB).toBe(0);
    expect(Number(dbA.pluck<number>('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(50);
    expect(Number(dbB.pluck<number>('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(50);
  }, 120_000);

  it('chaos_per_record_state_matches', () => {
    const dbA = newDb('dev_a');
    const dbB = newDb('dev_b');
    const cloud: Array<{ source: string; change: EngineChange }> = [];
    localInsertOrUpdate(dbA, 'k1', 'a_v1', 1, 1_700_000_001);
    localInsertOrUpdate(dbB, 'k2', 'b_v1', 2, 1_700_000_002);
    localInsertOrUpdate(dbA, 'k3', 'a_v3', 3, 1_700_000_003);

    for (const change of drainPendingChanges(dbA, 'dev_a')) cloud.push({ source: 'dev_a', change });
    for (const change of drainPendingChanges(dbB, 'dev_b')) cloud.push({ source: 'dev_b', change });
    cloud.sort((left, right) => left.change.changed_at.localeCompare(right.change.changed_at));
    apply(dbA, cloud.filter(entry => entry.source === 'dev_b').map(entry => entry.change));
    apply(dbB, cloud.filter(entry => entry.source === 'dev_a').map(entry => entry.change));

    localDelete(dbB, 'k1', 1_700_000_100);
    localInsertOrUpdate(dbA, 'k2', 'a_override_k2', 22, 1_700_000_101);

    for (const change of drainPendingChanges(dbA, 'dev_a')) cloud.push({ source: 'dev_a', change });
    for (const change of drainPendingChanges(dbB, 'dev_b')) cloud.push({ source: 'dev_b', change });
    cloud.sort((left, right) => left.change.changed_at.localeCompare(right.change.changed_at));
    apply(dbA, cloud.filter(entry => entry.source === 'dev_b').map(entry => entry.change));
    apply(dbB, cloud.filter(entry => entry.source === 'dev_a').map(entry => entry.change));

    const mapA = itemsToMap(dbA);
    const mapB = itemsToMap(dbB);
    expect(mapA.get('k1')?.[2]).toBe(true);
    expect(mapB.get('k1')?.[2]).toBe(true);
    expect(mapA.has('k3')).toBe(true);
    expect(mapB.has('k3')).toBe(true);
    expect(mapA.get('k2')?.[0]).toBe('a_override_k2');
    expect(mapB.get('k2')?.[0]).toBe('a_override_k2');
  }, 120_000);
});
