/**
 * [L20-engine port] `sync_comprehensive_tests.rs` checksum/restore/prune/field merge.
 *
 * Engine cases call the published `ctx.sync` surface:
 * `getDatabaseSyncState`, `resetSyncBaselineAfterRestore` and `hasPruneGap`.
 * The field-merge cases use the production `mergeField` re-export.
 * The classification/trigger/edge-case modules need the unpublished
 * `classification` registry;
 * `review_plan_merge_tests` is a self-contained SQL harness, not the engine.
 * All assertions are unchanged.
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
import { mergeField } from '../../sync/api.ts';

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
  const db = storage.openFile(join(dir, 'comprehensive.db'), { profile: 'plain' });
  handles.push(db);
  return db;
}

function checksumDb(): DatabaseHandle {
  const db = newHandle();
  db.exec(`
    CREATE TABLE IF NOT EXISTS __change_log (
      id INTEGER PRIMARY KEY,
      table_name TEXT,
      record_id TEXT,
      operation TEXT,
      changed_at TEXT DEFAULT (datetime('now')),
      sync_version INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS test_table (
      id TEXT PRIMARY KEY,
      title TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      device_id TEXT,
      local_version INTEGER DEFAULT 0,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS refinery_schema_history (
      version INTEGER PRIMARY KEY,
      applied_on TEXT
    );
    INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
  `);
  return db;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-comprehensive-sync-'));
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

describe('sync comprehensive checksum', () => {
  it('test_checksum_compiles_and_runs', () => {
    const db = checksumDb();
    const state = host.ctx.sync.getDatabaseSyncState(db, 'vfs');
    expect(state.schema_version).toBe(1);
    expect(Number(state.data_version)).toBe(0);
    expect(state.checksum.length).toBeGreaterThan(0);
  });

  it('test_checksum_on_empty_db', () => {
    const db = checksumDb();
    db.exec('DELETE FROM __change_log');
    const state = host.ctx.sync.getDatabaseSyncState(db, 'vfs');
    expect(Number(state.data_version)).toBe(0);
  });

  it('test_checksum_reflects_sync_version', () => {
    const db = checksumDb();
    db.exec(`INSERT INTO __change_log (table_name, record_id, operation, sync_version)
      VALUES ('test_table', 'r1', 'INSERT', 42)`);
    const state = host.ctx.sync.getDatabaseSyncState(db, 'vfs');
    expect(Number(state.data_version)).toBe(42);
  });
});

describe('sync comprehensive restore baseline', () => {
  it('test_reset_baseline_touches_local_version', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, title TEXT, device_id TEXT,
        local_version INTEGER DEFAULT 0, sync_version INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
      );
      INSERT INTO resources (id, title, local_version, sync_version) VALUES ('res_1', 'test', 5, 2);
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, operation TEXT,
        changed_at TEXT, sync_version INTEGER DEFAULT 0
      );
      INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', 'res_1', 'INSERT');
      CREATE TABLE __sync_conflicts (
        id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, side TEXT,
        data_json TEXT, data_hash TEXT DEFAULT '', detected_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT, resolution TEXT
      );
    `);
    const [truncated, resetCount] = host.ctx.sync.resetSyncBaselineAfterRestore(db);
    expect(truncated).toBeGreaterThan(0);
    expect(resetCount).toBeGreaterThan(0);
    expect(db.pluck("SELECT local_version FROM resources WHERE id='res_1'")).toBe(5);
    expect(db.pluck("SELECT sync_version FROM resources WHERE id='res_1'")).toBe(5);
  });

  it('test_reset_baseline_multiple_tables', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, title TEXT, device_id TEXT,
        local_version INTEGER DEFAULT 0, sync_version INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
      );
      INSERT INTO notes (id, title, local_version, sync_version) VALUES ('n1', 'note1', 3, 0);
      INSERT INTO notes (id, title, local_version, sync_version) VALUES ('n2', 'note2', 7, 0);
      CREATE TABLE questions (
        id TEXT PRIMARY KEY, title TEXT, device_id TEXT,
        local_version INTEGER DEFAULT 0, sync_version INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
      );
      INSERT INTO questions (id, title, local_version, sync_version) VALUES ('q1', 'q1', 1, 0);
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, operation TEXT,
        changed_at TEXT, sync_version INTEGER DEFAULT 0
      );
      INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', 'n1', 'INSERT');
      INSERT INTO __change_log (table_name, record_id, operation) VALUES ('questions', 'q1', 'INSERT');
      CREATE TABLE __sync_conflicts (
        id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, side TEXT,
        data_json TEXT, data_hash TEXT DEFAULT '', detected_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT, resolution TEXT
      );
    `);
    const [, resetCount] = host.ctx.sync.resetSyncBaselineAfterRestore(db);
    expect(resetCount).toBeGreaterThanOrEqual(3);
    expect([
      db.pluck("SELECT local_version FROM notes WHERE id='n1'"),
      db.pluck("SELECT sync_version FROM notes WHERE id='n1'"),
    ]).toEqual([3, 3]);
    expect([
      db.pluck("SELECT local_version FROM notes WHERE id='n2'"),
      db.pluck("SELECT sync_version FROM notes WHERE id='n2'"),
    ]).toEqual([7, 7]);
    expect([
      db.pluck("SELECT local_version FROM questions WHERE id='q1'"),
      db.pluck("SELECT sync_version FROM questions WHERE id='q1'"),
    ]).toEqual([1, 1]);
  });

  it('test_reset_baseline_table_without_local_version_is_skipped', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE no_sync (id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO no_sync (id, title) VALUES ('ns_1', 'test');
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, operation TEXT,
        changed_at TEXT, sync_version INTEGER DEFAULT 0
      );
      CREATE TABLE __sync_conflicts (
        id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, side TEXT,
        data_json TEXT, data_hash TEXT DEFAULT '', detected_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT, resolution TEXT
      );
    `);
    const [, resetCount] = host.ctx.sync.resetSyncBaselineAfterRestore(db);
    expect(resetCount).toBe(0);
    expect(Number(db.pluck("SELECT COUNT(*) FROM no_sync WHERE id='ns_1'") ?? 0)).toBe(1);
  });

  it('test_reset_baseline_empty_db_does_not_panic', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, operation TEXT,
        changed_at TEXT, sync_version INTEGER DEFAULT 0
      );
      CREATE TABLE __sync_conflicts (
        id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, side TEXT,
        data_json TEXT, data_hash TEXT DEFAULT '', detected_at TEXT DEFAULT (datetime('now')),
        resolved_at TEXT, resolution TEXT
      );
    `);
    expect(host.ctx.sync.resetSyncBaselineAfterRestore(db)).toEqual([0, 0]);
  });
});

describe('sync comprehensive prune gap', () => {
  it('test_gap_detected_when_since_far_behind', () => {
    expect(host.ctx.sync.hasPruneGap(100n, 500n)).toBe(true);
  });

  it('test_gap_not_detected_when_ahead', () => {
    expect(host.ctx.sync.hasPruneGap(500n, 100n)).toBe(false);
  });

  it('test_gap_not_detected_when_equal', () => {
    expect(host.ctx.sync.hasPruneGap(200n, 200n)).toBe(false);
  });

  it('test_gap_not_detected_at_zero', () => {
    expect(host.ctx.sync.hasPruneGap(0n, 500n)).toBe(false);
  });

  it('test_gap_not_detected_when_no_min_available', () => {
    expect(host.ctx.sync.hasPruneGap(100n, null)).toBe(false);
  });

  it('test_gap_boundary_exact_match', () => {
    expect(host.ctx.sync.hasPruneGap(500n, 500n)).toBe(false);
  });

  it('test_gap_large_distance', () => {
    expect(host.ctx.sync.hasPruneGap(10n, 50_000n)).toBe(true);
  });
});

describe('sync comprehensive field merge', () => {
  // sync_comprehensive_tests.rs:421-454: preserve all three return-value assertions.
  it('test_ref_count_falls_back_to_conflict', () => {
    const [result, merged, conflict] = mergeField('resources', 'ref_count', 5, 3);
    expect(result).toBe(3);
    expect(merged).toBe(false);
    expect(conflict).toBe(true);
  });

  it('test_ref_count_equal_is_identity', () => {
    const [result, merged, conflict] = mergeField('resources', 'ref_count', 7, 7);
    expect(result).toBe(7);
    expect(merged).toBe(false);
    expect(conflict).toBe(false);
  });

  it('test_ref_count_zero_identity', () => {
    const [result, merged, conflict] = mergeField('resources', 'ref_count', 0, 0);
    expect(result).toBe(0);
    expect(merged).toBe(false);
    expect(conflict).toBe(false);
  });

  it('test_blobs_ref_count_falls_back_to_conflict', () => {
    const [result, merged, conflict] = mergeField('blobs', 'ref_count', 10, 3);
    expect(result).toBe(3);
    expect(merged).toBe(false);
    expect(conflict).toBe(true);
  });

  it('test_tag_union_with_overlap', () => {
    const [result, merged] = mergeField('notes', 'tags', ['a', 'b', 'c'], ['b', 'c', 'd']);
    // Rust :466 as_array().unwrap() must reject non-array values, including strings.
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
    expect(merged).toBe(true);
  });

  it('test_tag_union_disjoint', () => {
    const [result, merged] = mergeField('notes', 'tags', ['x', 'y'], ['a', 'b']);
    // Rust :479 as_array().unwrap().
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(4);
    expect(merged).toBe(true);
  });

  it('test_tag_union_identical', () => {
    const [, merged] = mergeField('notes', 'tags', ['a', 'b'], ['a', 'b']);
    expect(merged).toBe(false);
  });

  it('test_tag_union_empty', () => {
    const [result, merged] = mergeField('notes', 'tags', [], []);
    expect(result).toEqual([]);
    expect(merged).toBe(false);
  });

  // sync_comprehensive_tests.rs:520-626: original inputs and return-value assertions.
  it('test_max_value_reverse', () => {
    const [result, merged] = mergeField('review_plans', 'total_reviews', 3, 15);
    expect(result).toBe(15);
    expect(merged).toBe(true);
  });

  it('test_estimated_pomodoros_falls_back_to_lww_conflict', () => {
    const [result, merged, conflict] = mergeField('todo_items', 'estimated_pomodoros', 3, 4);
    expect(result).toBe(4);
    expect(merged).toBe(false);
    expect(conflict).toBe(true);
  });

  it('test_estimated_pomodoros_lower_remote_is_not_bounced_by_max', () => {
    const [result, merged, conflict] = mergeField('todo_items', 'estimated_pomodoros', 5, 0);
    expect(result).toBe(0);
    expect(merged).toBe(false);
    expect(conflict).toBe(true);
  });

  it('test_boolean_or_true_wins', () => {
    const [result, merged] = mergeField('notes', 'is_favorite', false, true);
    expect(result).toBe(true);
    expect(merged).toBe(true);
  });

  it('test_boolean_or_both_false', () => {
    const [result, merged] = mergeField('notes', 'is_favorite', false, false);
    expect(result).toBe(false);
    expect(merged).toBe(false);
  });

  it('test_free_text_conflict_uses_remote_candidate', () => {
    const [result, merged, conflict] = mergeField('questions', 'user_note', 'Hello', 'World');
    expect(result).toBe('World');
    expect(merged).toBe(false);
    expect(conflict).toBe(true);
  });

  it('test_free_text_empty_local_still_flags_conflict_when_values_differ', () => {
    const [result, merged, conflict] = mergeField('questions', 'user_note', '', 'World');
    expect(result).toBe('World');
    expect(merged).toBe(false);
    expect(conflict).toBe(true);
  });

  it('test_free_text_does_not_auto_concatenate', () => {
    const [result, merged, conflict] = mergeField('questions', 'user_note', 'Hello World', 'Hello');
    expect(result).toBe('Hello');
    expect(merged).toBe(false);
    expect(conflict).toBe(true);
  });
});

describe('sync comprehensive review plan merge', () => {
  it('test_review_plan_question_id_conflict_uses_upsert', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE review_plans (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL UNIQUE,
        ease_factor REAL NOT NULL DEFAULT 2.5,
        interval_days INTEGER NOT NULL DEFAULT 0,
        repetitions INTEGER NOT NULL DEFAULT 0,
        total_reviews INTEGER NOT NULL DEFAULT 0,
        total_correct INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        device_id TEXT,
        local_version INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
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
    `);

    // Device A creates plan rp_a for question q1.
    db.run(
      `INSERT INTO review_plans (id, question_id, ease_factor, interval_days, total_reviews, total_correct)
       VALUES ('rp_a', 'q1', 2.5, 1, 5, 4)`,
    );

    // Device B independently creates plan rp_b for the same question q1.
    // This hits UNIQUE(question_id); the sync layer must UPSERT instead.
    db.run(
      `INSERT INTO review_plans (id, question_id, ease_factor, interval_days, total_reviews, total_correct)
       VALUES ('rp_b', 'q1', 2.8, 3, 10, 8)
       ON CONFLICT(question_id) DO UPDATE SET
          ease_factor = (ease_factor + excluded.ease_factor) / 2.0,
          interval_days = MAX(interval_days, excluded.interval_days),
          total_reviews = total_reviews + excluded.total_reviews,
          total_correct = total_correct + excluded.total_correct,
          id = (CASE WHEN excluded.id > id THEN excluded.id ELSE id END)`,
    );

    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM review_plans WHERE question_id = 'q1'",
    ) ?? 0)).toBe(1);
  });
});
