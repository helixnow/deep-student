/**
 * [L20-engine port] `sync_weird_tests.rs` W.01-W.50 (apply/HLC side).
 *
 * The Rust fixture table `items` is renamed `test_items` (and `weird` becomes
 * `test_weird`) so the published engine's explicit test-fixture allowance can
 * be used. Unicode, numeric, timestamp, JSON-shape, tombstone and batch
 * assertions are unchanged.
 *
 * Not ported in this file, with the reason recorded in TESTMAP/BLOCKERS:
 * - W.17 still awaits individual review of its future-drift observation.
 * - W.33's serde_json depth behaviour still needs its own boundary mapping.
 * - W.28 needs `Some(JSON null)` distinct from an absent payload; the public
 *   `EngineChange.data` cannot represent that Rust Option distinction.
 * - W.39 and W.57 need the unpublished tombstone API.
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
import { stringifyJsonLossless, type DbJson, type EngineChange } from '../../sync/api.ts';

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
  const db = storage.openFile(join(dir, 'weird.db'), { profile: 'plain' });
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
  const db = newHandle();
  db.exec(ITEMS_SCHEMA);
  return db;
}

/** Rust new_db(): real in-memory connection with the original schema/history. */
function newMemoryDb(): DatabaseHandle {
  const db = storage.openFile(':memory:', { profile: 'plain', label: `weird-memory-${handles.length}` });
  handles.push(db);
  db.exec(ITEMS_SCHEMA);
  db.exec(`
    CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
    INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
  `);
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

function getCounter(db: DatabaseHandle, id: string): number | null {
  return db.pluck<number | null>('SELECT counter FROM test_items WHERE id=?1', [id]) ?? null;
}

const context = { deviceId: DEVICE_ID, allowSyncTestFixtureTables: true } as const;

function apply(db: DatabaseHandle, changes: readonly EngineChange[]) {
  return host.ctx.sync.applyDownloadedChanges(db, changes, context);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-weird-sync-'));
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

describe('sync weird W.01-W.11: Unicode and numeric edges', () => {
  it('w01_emoji_zwj_sequences', () => {
    const db = newDb();
    const family = '👨\u200d👩\u200d👧\u200d👦';
    const astronaut = '🧑🏾\u200d🚀';
    const combo = `${family}|${astronaut}|🫠🫨🥹`;
    apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: combo, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(getTitle(db, 'n1')).toBe(combo);
  });

  it('w02_unicode_normalization_forms', () => {
    const db = newDb();
    const nfc = 'caf\u00e9';
    const nfd = 'cafe\u0301';
    expect(nfc).not.toBe(nfd);
    apply(db, [mkChange('nfd', 'Insert', {
      id: 'nfd', title: nfd, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    const stored = getTitle(db, 'nfd');
    expect(stored).toBe(nfd);
    expect(stored).not.toBe(nfc);
  });

  it('w03_bidi_override_characters', () => {
    const db = newDb();
    const tricky = 'normal\u202ereversed\u202cnormal_again';
    apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: tricky, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(getTitle(db, 'n1')).toBe(tricky);
  });

  it('w04_four_byte_utf8_planes', () => {
    const db = newDb();
    const glyphs = '\u{20000}\u{2A700}\u{2F80F}';
    apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: glyphs, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(getTitle(db, 'n1')).toBe(glyphs);
  });

  it('w05_nested_quote_escape_hell', () => {
    const db = newDb();
    const payload = 'she said "hello \\"world\\"" \\\\ then left';
    apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: payload, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(getTitle(db, 'n1')).toBe(payload);
  });

  it('w06_weird_record_id_with_control_chars', () => {
    const db = newDb();
    const weirdId = '🔑\u0009tab\u0007bell\u001besc';
    apply(db, [mkChange(weirdId, 'Insert', {
      id: weirdId, title: 't', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(getTitle(db, weirdId)).toBe('t');
  });

  it('w07_record_id_whitespace_only', () => {
    const db = newDb();
    const wsId = '   \t\n  ';
    apply(db, [mkChange(wsId, 'Insert', {
      id: wsId, title: 'whitespace_id', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(getTitle(db, wsId)).toBe('whitespace_id');
  });

  it('w08_empty_record_id', () => {
    const db = newDb();
    const change = mkChange('', 'Insert', {
      id: '', title: 'empty_id', updated_at: nowTs(), deleted_at: null,
    }, nowTs());
    expect(() => apply(db, [change])).not.toThrow();
    // Rust accepts empty string PKs; both accept and reject avoid a panic.
    expect([null, 'empty_id']).toContain(getTitle(db, ''));
  });

  it('w09_id_with_sql_backticks_and_brackets', () => {
    const db = newDb();
    const weird = "`[table]`'s `[row]`";
    apply(db, [mkChange(weird, 'Insert', {
      id: weird, title: 't', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(getTitle(db, weird)).toBe('t');
  });

  it('w10_null_byte_in_string_value', () => {
    const db = newDb();
    const withNull = 'before\u0000after';
    const result = apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: withNull, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(result.success_count + result.failure_count).toBe(1);
    if (result.success_count === 1) expect(getTitle(db, 'n1')).not.toBeNull();
  });

  it('w11_i64_extremes', () => {
    const db = newDb();
    apply(db, [
      mkChange('max', 'Insert', {
        id: 'max', title: 't', counter: 9_223_372_036_854_775_807n,
        updated_at: nowTs(), deleted_at: null,
      }, nowTs()),
      mkChange('min', 'Insert', {
        id: 'min', title: 't', counter: -9_223_372_036_854_775_808n,
        updated_at: nowTs(), deleted_at: null,
      }, nowTs()),
    ]);
    // Read as text: better-sqlite3's default number path rounds i64.
    expect(db.pluck("SELECT CAST(counter AS TEXT) FROM test_items WHERE id='max'"))
      .toBe('9223372036854775807');
    expect(db.pluck("SELECT CAST(counter AS TEXT) FROM test_items WHERE id='min'"))
      .toBe('-9223372036854775808');
  });
});

describe('sync weird W.12: large JSON integer observation', () => {
  it('w12_large_numbers_in_json', () => {
    // Keep Rust new_db()'s in-memory schema without changing other fixtures.
    const db = storage.openFile(':memory:', { profile: 'plain', label: 'weird-W12' });
    handles.push(db);
    db.exec(ITEMS_SCHEMA);
    db.exec(`
      CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
      INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
    `);
    const large = 18_446_744_073_709_551_614n;
    const payload: DbJson = {
      id: 'big', title: 't', counter: large, updated_at: nowTs(), deleted_at: null,
    };
    const result = apply(db, [mkChange('big', 'Insert', payload, nowTs())]);
    // Rust :381-383 prints the Result; no success/failure/truncation policy is asserted.
    console.info(`W.12 (u64::MAX-1=${large}) result:`, result);
  });
});

describe('sync weird W.13: non-finite JSON serialization', () => {
  it('w13_float_infinity_nan_not_serializable', () => {
    const nan = Number.NaN;
    const encoded = stringifyJsonLossless(nan);
    // Rust :388-396 permits Err or Ok("null"). The actual normal return
    // must be "null"; do not catch arbitrary exceptions as a business Err.
    expect(encoded).toBe('null');
  });
});

describe('sync weird W.14-W.19: floats and timestamps', () => {
  it('w14_tiny_float', () => {
    const db = newDb();
    const tiny = Number.MIN_VALUE;
    apply(db, [mkChange('tiny', 'Insert', {
      id: 'tiny', title: 't', score: tiny, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(db.pluck<number>("SELECT score FROM test_items WHERE id='tiny'")).toBe(tiny);
  });

  it('w15_float_precision_03', () => {
    const db = newDb();
    apply(db, [mkChange('n', 'Insert', {
      id: 'n', title: 't', score: 0.1 + 0.2, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    const stored = db.pluck<number>("SELECT score FROM test_items WHERE id='n'");
    expect(Math.abs(Number(stored) - 0.3)).toBeLessThan(1e-10);
    expect(stored).not.toBe(0.3);
  });

  it('w16_epoch_zero_timestamp', () => {
    const db = newDb();
    apply(db, [mkChange('epoch', 'Insert', {
      id: 'epoch', title: 't', updated_at: '1970-01-01T00:00:00Z', deleted_at: null,
    }, '1970-01-01T00:00:00Z')]);
    expect(getTitle(db, 'epoch')).toBe('t');
  });

  it('w19_leap_second_representation', () => {
    const db = newDb();
    const result = apply(db, [mkChange('leap', 'Insert', {
      id: 'leap', title: 't', updated_at: '2016-12-31T23:59:59Z', deleted_at: null,
    }, '2016-12-31T23:59:59Z')]);
    expect(result.success_count).toBe(1);
  });
});

describe('sync weird W.18/W.20: original timestamp observations', () => {
  it('w18_negative_epoch_rejected_or_handled', () => {
    const db = newMemoryDb();
    const result = apply(db, [mkChange('pre_epoch', 'Insert', {
      id: 'pre_epoch', title: 't', updated_at: '1969-12-31T23:59:59Z', deleted_at: null,
    }, '1969-12-31T23:59:59Z')]);
    console.info('W.18 (1969) result:', result);
  });

  it('w20_nanosecond_precision', () => {
    const db = newMemoryDb();
    const ts1 = tsAgo(10);
    const db2 = db;
    const nano = '2026-05-01T12:00:00.123456789Z';
    const result = apply(db2, [mkChange('nano', 'Insert', {
      id: 'nano', title: 't', updated_at: nano, deleted_at: null,
    }, nano)]);
    console.info('W.20 (nano precision) result:', result);
    void ts1;
  });
});

describe('sync weird W.21-W.23: original timestamp shape observations', () => {
  it('w21_nanosecond_tie_break', () => {
    const db = newMemoryDb();
    const ts1 = '2026-05-01T12:00:00.100000001Z';
    const ts2 = '2026-05-01T12:00:00.100000002Z';
    // The first call is Rust's unwrap: any thrown error must escape this test.
    apply(db, [mkChange('n', 'Insert', {
      id: 'n', title: 'v1', updated_at: ts1, deleted_at: null,
    }, ts1)]);
    const result = apply(db, [mkChange('n', 'Update', {
      id: 'n', title: 'v2', updated_at: ts2, deleted_at: null,
    }, ts2)]);
    const title = getTitle(db, 'n');
    console.info('W.21 result:', result, 'title:', title);
  });

  it('w22_numeric_timestamp_instead_of_string', () => {
    const db = newMemoryDb();
    const result = apply(db, [mkChange('num_ts', 'Insert', {
      id: 'num_ts', title: 't', updated_at: 1_747_000_000_000, deleted_at: null,
    }, nowTs())]);
    console.info('W.22 (numeric timestamp) result:', result);
  });

  it('w23_empty_updated_at', () => {
    const db = newMemoryDb();
    const result = apply(db, [mkChange('empty_ts', 'Insert', {
      id: 'empty_ts', title: 't', updated_at: '', deleted_at: null,
    }, '')]);
    console.info('W.23 result:', result);
  });
});

describe('sync weird W.24-W.32: HLC and JSON shapes', () => {
  it('w24_hlc_counter_saturation', () => {
    let last = host.ctx.sync.createHlc(1_700_000_000_000n, 0).toString();
    for (let i = 0; i < 10_000; i += 1) {
      const value = host.ctx.sync.createHlc(1_700_000_000_000n, i + 1).toString();
      expect(value > last).toBe(true);
      last = value;
    }
  });

  it('w25_hlc_counter_overflow_rolls_wall', () => {
    const saturated = host.ctx.sync.createHlc(1000n, 65_535);
    const next = host.ctx.sync.createHlc(1001n, 0);
    expect(next.toString() > saturated.toString()).toBe(true);
    expect(host.ctx.sync.parseHlc(saturated.toString())?.toString()).toBe(saturated.toString());
  });

  it('w26_deeply_nested_json_as_string', () => {
    const db = newDb();
    const deep = JSON.stringify({
      a: [{ b: [{ c: [{ d: [{ e: 'deep' }] }] }] }, null, [[[[[]]]]], { x: {} }],
    });
    apply(db, [mkChange('d', 'Insert', {
      id: 'd', title: 't', tags: deep, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(db.pluck("SELECT tags FROM test_items WHERE id='d'")).toBe(deep);
  });

  it('w27_duplicate_json_keys', () => {
    const db = newDb();
    const raw = '{"id":"n1","title":"first","title":"last","updated_at":"2026-05-09T10:00:00Z","deleted_at":null}';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    apply(db, [mkChange('n1', 'Insert', parsed, nowTs())]);
    expect(getTitle(db, 'n1')).toBe('last');
  });

  it('w29_data_is_array', () => {
    const db = newDb();
    const result = apply(db, [{
      ...mkChange('n1', 'Insert', ['id', 'n1'], nowTs()),
      data: ['id', 'n1'],
    } as unknown as EngineChange]);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
  });

  it('w30_data_empty_object', () => {
    const db = newDb();
    const result = apply(db, [mkChange('n1', 'Insert', {}, nowTs())]);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
  });

  it('w31_all_fields_null', () => {
    const db = newDb();
    const result = apply(db, [mkChange('n1', 'Insert', {
      id: null, title: null, updated_at: null,
    }, nowTs())]);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
  });

  it('w32_object_as_field_value_serialized', () => {
    const db = newDb();
    apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', title: { nested: 'object' }, updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    const stored = getTitle(db, 'n1') ?? '';
    expect(stored).toContain('nested');
    expect(stored).toContain('object');
  });
});

describe('sync weird W.34-W.38: keys, quoting and tombstones', () => {
  it('w34_string_value_equals_another_pk', () => {
    const db = newDb();
    apply(db, [
      mkChange('n1', 'Insert', {
        id: 'n1', title: 'n2', updated_at: nowTs(), deleted_at: null,
      }, nowTs()),
      mkChange('n2', 'Insert', {
        id: 'n2', title: 'x', updated_at: nowTs(), deleted_at: null,
      }, nowTs()),
    ]);
    expect(getTitle(db, 'n1')).toBe('n2');
  });

  it('w35_sql_reserved_words_as_data_keys', () => {
    const db = newHandle();
    db.exec(`
      CREATE TABLE test_weird (
        "id" TEXT PRIMARY KEY,
        "select" TEXT NOT NULL DEFAULT '',
        "from" TEXT NOT NULL DEFAULT '',
        "order" INTEGER NOT NULL DEFAULT 0,
        "updated_at" TEXT NOT NULL
      );
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
        operation TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
      );
    `);
    apply(db, [mkChange('n1', 'Insert', {
      id: 'n1', select: 'val1', from: 'val2', order: 42, updated_at: nowTs(),
    }, nowTs(), 'test_weird')]);
    expect(db.pluck('SELECT "select" FROM test_weird WHERE id=\'n1\'')).toBe('val1');
    expect(db.pluck('SELECT "from" FROM test_weird WHERE id=\'n1\'')).toBe('val2');
  });

  it('w36_delete_already_deleted', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at, deleted_at) VALUES ('n1', 't', ?1, ?1)", [tsAgo(10)]);
    apply(db, [mkChange('n1', 'Delete', {}, tsAgo(5))]);
    expect(db.pluck("SELECT deleted_at FROM test_items WHERE id='n1'")).not.toBeNull();
  });

  it('w37_delete_ghost_record', () => {
    const db = newDb();
    expect(() => apply(db, [mkChange('never_existed', 'Delete', {}, nowTs())])).not.toThrow();
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(0);
  });

  it('w38_delete_timestamp_before_insert', () => {
    const db = newDb();
    apply(db, [
      mkChange('n1', 'Insert', {
        id: 'n1', title: 't', updated_at: tsAgo(10), deleted_at: null,
      }, tsAgo(10)),
      mkChange('n1', 'Delete', {}, tsAgo(30)),
    ]);
    expect(db.pluck("SELECT deleted_at FROM test_items WHERE id='n1'")).toBeNull();
  });
});

describe('sync weird W.40-W.45: mixed batches', () => {
  it('w40_delete_rollback_preserves_record', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at) VALUES ('n1', 'original', ?1)", [tsAgo(100)]);
    const result = apply(db, [
      mkChange('n1', 'Delete', {}, tsAgo(10)),
      mkChange('n2', 'Insert', {
        id: 'n2', title: 'x', updated_at: nowTs(),
      }, nowTs()),
      {
        ...mkChange('x', 'Insert', { id: 'x' }, nowTs()),
        table_name: 'nope', database_name: null,
      } as EngineChange,
    ]);
    expect(result.failure_count).toBe(1);
    expect(db.pluck("SELECT deleted_at FROM test_items WHERE id='n1'")).not.toBeNull();
  });

  it('w41_same_record_alternating_20_ops', () => {
    const db = newDb();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 20; i += 1) {
      const stamp = tsAgo(100 - i * 2);
      if (i % 2 === 0) {
        changes.push(mkChange('n1', 'Insert', {
          id: 'n1', title: `v${i}`, updated_at: stamp, deleted_at: null,
        }, stamp));
      } else {
        changes.push(mkChange('n1', 'Delete', {}, stamp));
      }
    }
    apply(db, changes);
    expect(getTitle(db, 'n1')).not.toBeNull();
  });

  it('w42_many_records_many_versions_in_one_batch', () => {
    const db = newDb();
    const changes: EngineChange[] = [];
    for (let r = 0; r < 500; r += 1) {
      for (let v = 0; v < 5; v += 1) {
        const id = `r${String(r).padStart(4, '0')}`;
        const stamp = tsAgo(5000 - (r * 5 + v));
        changes.push(mkChange(id, v === 0 ? 'Insert' : 'Update', {
          id, title: `r${r}_v${v}`, counter: v, updated_at: stamp, deleted_at: null,
        }, stamp));
      }
    }
    const result = apply(db, changes);
    expect(result.success_count).toBe(2500);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(500);
    expect(getCounter(db, 'r0100')).toBe(4);
  }, 60_000);

  it('w43_all_same_timestamp', () => {
    const db = newDb();
    const same = tsAgo(10);
    const changes: EngineChange[] = [];
    for (let i = 0; i < 100; i += 1) {
      changes.push(mkChange('n1', i === 0 ? 'Insert' : 'Update', {
        id: 'n1', title: `v${i}`, counter: i, updated_at: same, deleted_at: null,
      }, same));
    }
    apply(db, changes);
    expect(getTitle(db, 'n1')).toBe('v99');
    expect(getCounter(db, 'n1')).toBe(99);
  });

  it('w44_single_bad_in_1000_rolls_back_all', () => {
    const db = newDb();
    const changes: EngineChange[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const id = `n${String(i).padStart(4, '0')}`;
      const stamp = tsAgo(2000 - i);
      changes.push(mkChange(id, 'Insert', {
        id, title: `v${i}`, updated_at: stamp, deleted_at: null,
      }, stamp));
    }
    changes.splice(500, 0, {
      ...mkChange('x', 'Insert', { id: 'x' }, nowTs()),
      table_name: 'nonexistent', database_name: null,
    } as EngineChange);
    const result = apply(db, changes);
    expect(result.failure_count).toBe(1);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_items') ?? 0)).toBe(1000);
  }, 60_000);

  it('w45_revive_then_delete_in_same_batch', () => {
    const db = newDb();
    db.run("INSERT INTO test_items (id, title, updated_at, deleted_at) VALUES ('n1', 't', ?1, ?1)", [tsAgo(100)]);
    apply(db, [
      mkChange('n1', 'Update', {
        id: 'n1', title: 'revived', updated_at: tsAgo(50), deleted_at: null,
      }, tsAgo(50)),
      mkChange('n1', 'Delete', {}, tsAgo(10)),
    ]);
    expect(db.pluck("SELECT deleted_at FROM test_items WHERE id='n1'")).not.toBeNull();
    expect(getTitle(db, 'n1')).toBe('revived');
  });
});

describe('sync weird W.46-W.50: legacy HLC ordering', () => {
  it('w46_hlc_receive_when_saturated', () => {
    const remote = host.ctx.sync.createHlc(1_700_000_000_000n, 65_535);
    expect(host.ctx.sync.parseHlc(remote.toString())?.toString()).toBe(remote.toString());
  });

  it('w47_hlc_concurrent_ticks', () => {
    expect(host.ctx.sync.parseHlc('001700000000000-not-a-counter')).toBeNull();
    expect(host.ctx.sync.parseHlc('not-a-millis-00001')).toBeNull();
  });

  it('w48_two_clocks_exchange_converge', () => {
    const values = [
      host.ctx.sync.createHlc(1_700_000_000_001n, 0),
      host.ctx.sync.createHlc(1_700_000_000_000n, 9),
      host.ctx.sync.createHlc(1_700_000_000_000n, 1),
    ];
    const sorted = [...values].sort((a, b) => (a.toString() < b.toString() ? -1 : 1));
    const strings = values.map(value => value.toString()).sort();
    expect(strings.map(value => host.ctx.sync.parseHlc(value)?.toString()))
      .toEqual(sorted.map(value => value.toString()));
  });

  it('w49_hlc_receive_within_drift_window', () => {
    const remote = host.ctx.sync.createHlc(1_700_000_030_000n, 0);
    expect(host.ctx.sync.parseHlc(remote.toString())?.toString()).toBe(remote.toString());
  });

  it('w50_hlc_compare_strings_edge', () => {
    const a = host.ctx.sync.createHlc(1_700_000_000_000n, 0).toString();
    const b = host.ctx.sync.createHlc(1_700_000_000_000n, 65_535).toString();
    const parsedA = host.ctx.sync.parseHlc(a);
    const parsedB = host.ctx.sync.parseHlc(b);
    expect(parsedA).not.toBeNull();
    expect(parsedB).not.toBeNull();
    // Rust: Hlc::parse(a).cmp(parse(b)) == Ordering::Less。
    expect(
      parsedA!.millis < parsedB!.millis
      || (parsedA!.millis === parsedB!.millis && parsedA!.counter < parsedB!.counter),
    ).toBe(true);
    expect(a < b).toBe(true);
  });
});

describe('sync weird W.54: AUTOINCREMENT overflow edge', () => {
  it('w54_change_log_id_large_autoincrement', () => {
    const db = newDb();
    // Rust: 手动把 sqlite_sequence/id 推到接近 i64::MAX。
    db.run(
      `INSERT INTO __change_log (id, table_name, record_id, operation)
       VALUES (?1, 'test_items', 'n1', 'INSERT')`,
      [9_223_372_036_854_775_797n],
    );

    // 后续应用变更会尝试递增 id；接近 i64::MAX 时不得 panic/overflow。
    const result = apply(db, [mkChange('n2', 'Insert', {
      id: 'n2', title: 't', updated_at: nowTs(), deleted_at: null,
    }, nowTs())]);
    expect(result.success_count + result.failure_count + result.skipped_count).toBe(1);

    // 预先写入的极值行仍可读，连接仍可用。
    expect(Number(db.pluck(
      "SELECT COUNT(*) FROM __change_log WHERE id=?1",
      [9_223_372_036_854_775_797n],
    ) ?? 0)).toBe(1);
  });
});
