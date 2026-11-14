/**
 * [L20-engine port] `sync_pathological_tests.rs` P.11-P.15.
 *
 * These five cases exercise SQLite transaction/pragma interaction through the
 * published `ctx.sync.applyDownloadedChanges` engine. The Rust fixture table
 * `items` is registered here as `test_items`, the engine's public
 * `#[cfg(test)]` fixture allowance; every pragma and assertion is unchanged.
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

function newDb(): DatabaseHandle {
  const dir = join(root, `case-${caseCounter++}`);
  mkdirSync(dir, { recursive: true });
  caseDirs.push(dir);
  const db = storage.openFile(join(dir, 'pragma.db'), { profile: 'plain' });
  handles.push(db);
  db.exec(`
    CREATE TABLE test_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
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
    CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
    INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
  `);
  return db;
}

function pendingChange(id: string, timestamp = '2026-05-01T12:00:00Z'): EngineChange {
  return {
    table_name: 'test_items',
    record_id: id,
    operation: 'Insert',
    data: { id, title: 't', updated_at: timestamp, deleted_at: null },
    changed_at: timestamp,
    change_log_id: null,
    database_name: 'test',
    suppress_change_log: true,
    source_device_id: null,
    source_seq: null,
  };
}

function apply(db: DatabaseHandle, changes: readonly EngineChange[]) {
  return host.ctx.sync.applyDownloadedChanges(db, changes, {
    deviceId: 'device-local',
    allowSyncTestFixtureTables: true,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-pragma-sync-'));
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

describe('sync pathological P.11-P.15 pragma interactions', () => {
  it('p11_wal_mode_works', () => {
    const db = newDb();
    db.exec('PRAGMA journal_mode=WAL;');
    apply(db, [pendingChange('n1')]);
    expect(db.pluck<string>("SELECT title FROM test_items WHERE id='n1'")).toBe('t');
  });

  it('p12_savepoint_conflicts_with_immediate_tx', () => {
    const db = newDb();
    db.exec('SAVEPOINT outer;');
    expect(() => apply(db, [pendingChange('n1')])).toThrow();
    db.exec('RELEASE SAVEPOINT outer;');
  });

  it('p13_foreign_keys_off_still_atomic', () => {
    const db = newDb();
    db.exec('PRAGMA foreign_keys = OFF;');
    const illegal: EngineChange = {
      table_name: 'nope',
      record_id: 'x',
      operation: 'Insert',
      data: { id: 'x' },
      changed_at: '2026-05-01T12:00:00Z',
      change_log_id: null,
      database_name: null,
      suppress_change_log: true,
      source_device_id: null,
      source_seq: null,
    };
    const result = apply(db, [pendingChange('n1'), illegal]);
    expect(result.failure_count).toBe(1);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(1);
  });

  it('p14_exclusive_locking_mode', () => {
    const db = newDb();
    db.exec('PRAGMA locking_mode=EXCLUSIVE;');
    apply(db, [pendingChange('n1')]);
    expect(db.pluck<string>("SELECT title FROM test_items WHERE id='n1'")).toBe('t');
  });

  it('p15_query_only_pragma_prevents_writes', () => {
    const db = newDb();
    db.exec('PRAGMA query_only = ON;');
    expect(() => apply(db, [pendingChange('n1')])).toThrow();
  });
});
