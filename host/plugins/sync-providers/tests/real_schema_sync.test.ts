/**
 * [L20-engine port] `sync_real_schema_tests.rs` real_61-real_70.
 *
 * Uses the Rust file's real VFS schema (resources/notes/exam_sheets/questions,
 * FK chain, change-log triggers, FTS trigger) on an ad-hoc F3 handle. The
 * `parents`/`children` fixture in real_64b is renamed with the `test_` prefix
 * to use the published engine's explicit test-fixture allowance; the FK
 * assertions are unchanged. real_69 only records behaviour in Rust (no
 * assertion beyond apply success) and is ported as the same no-throw check.
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
  const db = storage.openFile(join(dir, 'real-schema.db'), { profile: 'plain' });
  handles.push(db);
  return db;
}

const REAL_VFS_SCHEMA = `
  CREATE TABLE resources (
    id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
    source_id TEXT, source_table TEXT, storage_mode TEXT NOT NULL DEFAULT 'inline',
    data TEXT, metadata_json TEXT, ref_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
  );
  CREATE INDEX idx_resources_hash ON resources(hash);
  CREATE INDEX idx_resources_type ON resources(type);

  CREATE TABLE notes (
    id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    FOREIGN KEY (resource_id) REFERENCES resources(id)
  );

  CREATE TABLE exam_sheets (
    id TEXT PRIMARY KEY, resource_id TEXT, exam_name TEXT, status TEXT NOT NULL,
    temp_id TEXT NOT NULL, metadata_json TEXT NOT NULL, preview_json TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (resource_id) REFERENCES resources(id)
  );

  CREATE TABLE questions (
    id TEXT PRIMARY KEY NOT NULL, exam_id TEXT NOT NULL, content TEXT NOT NULL,
    answer TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    FOREIGN KEY (exam_id) REFERENCES exam_sheets(id)
  );

  CREATE TABLE __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
    changed_at TEXT NOT NULL DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0
  );
  CREATE INDEX idx__change_log_sync_version ON __change_log(sync_version);

  CREATE TRIGGER trg__cl_resources_ins AFTER INSERT ON resources BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', NEW.id, 'INSERT');
  END;
  CREATE TRIGGER trg__cl_resources_upd AFTER UPDATE ON resources BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', NEW.id, 'UPDATE');
  END;
  CREATE TRIGGER trg__cl_resources_del AFTER DELETE ON resources BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('resources', OLD.id, 'DELETE');
  END;
  CREATE TRIGGER trg__cl_notes_ins AFTER INSERT ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', NEW.id, 'INSERT');
  END;
  CREATE TRIGGER trg__cl_notes_upd AFTER UPDATE ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', NEW.id, 'UPDATE');
  END;
  CREATE TRIGGER trg__cl_notes_del AFTER DELETE ON notes BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('notes', OLD.id, 'DELETE');
  END;
  CREATE TRIGGER trg__cl_exam_ins AFTER INSERT ON exam_sheets BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('exam_sheets', NEW.id, 'INSERT');
  END;
  CREATE TRIGGER trg__cl_exam_upd AFTER UPDATE ON exam_sheets BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('exam_sheets', NEW.id, 'UPDATE');
  END;
  CREATE TRIGGER trg__cl_q_ins AFTER INSERT ON questions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('questions', NEW.id, 'INSERT');
  END;
  CREATE TRIGGER trg__cl_q_upd AFTER UPDATE ON questions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('questions', NEW.id, 'UPDATE');
  END;
  CREATE TRIGGER trg__cl_q_del AFTER DELETE ON questions BEGIN
    INSERT INTO __change_log (table_name, record_id, operation) VALUES ('questions', OLD.id, 'DELETE');
  END;

  CREATE TABLE questions_fts_rebuild_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT);
  CREATE TRIGGER trg_questions_fts_upd AFTER UPDATE ON questions BEGIN
    INSERT INTO questions_fts_rebuild_log (at) VALUES (datetime('now'));
  END;

  CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
  INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
`;

const LLM_USAGE_SCHEMA = `
  CREATE TABLE llm_usage_daily (
    date TEXT NOT NULL, caller_type TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY (date, caller_type, model, provider)
  );
  CREATE TABLE __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
    changed_at TEXT NOT NULL DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0
  );
  CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
  INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
`;

function newRealVfsSchema(): DatabaseHandle {
  const db = newHandle();
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(REAL_VFS_SCHEMA);
  return db;
}

function newLlmUsageSchema(): DatabaseHandle {
  const db = newHandle();
  db.exec(LLM_USAGE_SCHEMA);
  return db;
}

function nowMs(): number {
  return Date.now();
}

function insertResource(db: DatabaseHandle, id: string, hash: string, refCount: number): void {
  const now = nowMs();
  db.run(
    `INSERT INTO resources (id, hash, type, storage_mode, ref_count, created_at, updated_at)
     VALUES (?1,?2,'note','inline',?3,?4,?4)`,
    [id, hash, refCount, now],
  );
}

function insertNote(db: DatabaseHandle, id: string, resourceId: string, title: string): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO notes (id, resource_id, title, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?4)`,
    [id, resourceId, title, now],
  );
}

function markAllSynced(db: DatabaseHandle): void {
  db.run('UPDATE __change_log SET sync_version=?1 WHERE sync_version=0', [Math.floor(Date.now() / 1000)]);
}

function change(
  tableName: string,
  recordId: string,
  operation: 'Insert' | 'Update' | 'Delete',
  data: Record<string, unknown> | null,
  changedAt: string,
  databaseName: string | null = 'vfs',
): EngineChange {
  return {
    table_name: tableName,
    record_id: recordId,
    operation,
    data: operation === 'Delete' ? null : data,
    changed_at: changedAt,
    change_log_id: null,
    database_name: databaseName,
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
  root = mkdtempSync(join(tmpdir(), 'l23-real-schema-sync-'));
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

describe('sync real schema 61-65: foreign keys and triggers', () => {
  it('real_61_fk_violation_rolls_back_batch', () => {
    const db = newRealVfsSchema();
    const result = apply(db, [change('notes', 'note1', 'Insert', {
      id: 'note1', resource_id: 'res_nonexistent', title: 'orphan', tags: '[]',
      is_favorite: 0, created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:00:00Z',
    }, '2026-05-01T10:00:00Z')]);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
    expect(Number(db.pluck('SELECT COUNT(*) FROM notes') ?? 0)).toBe(0);
  });

  it('real_62_cascade_insert_order_independence', () => {
    const db = newRealVfsSchema();
    const child = change('notes', 'note1', 'Insert', {
      id: 'note1', resource_id: 'res1', title: 'hello', tags: '[]', is_favorite: 0,
      created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:00:00Z',
    }, '2026-05-01T10:00:00Z');
    const parent = change('resources', 'res1', 'Insert', {
      id: 'res1', hash: 'h_unique_1', type: 'note', storage_mode: 'inline',
      ref_count: 1, created_at: 1_735_689_600_000, updated_at: 1_735_689_600_000,
    }, '2026-05-01T10:00:00Z');
    expect(() => apply(db, [child, parent])).not.toThrow();
    expect(Number(db.pluck('SELECT COUNT(*) FROM notes') ?? 0)).toBe(1);
  });

  it('real_63_three_level_cascade', () => {
    const db = newRealVfsSchema();
    const res = change('resources', 'res1', 'Insert', {
      id: 'res1', hash: 'h1', type: 'exam', storage_mode: 'inline',
      ref_count: 1, created_at: 1, updated_at: 1,
    }, '2026-05-01T10:00:00Z');
    const exam = change('exam_sheets', 'exam1', 'Insert', {
      id: 'exam1', resource_id: 'res1', status: 'completed', temp_id: 't1',
      metadata_json: '{}', preview_json: '{}', created_at: '2026-05-01T10:00:00Z',
      updated_at: '2026-05-01T10:00:00Z', is_favorite: 0,
    }, '2026-05-01T10:00:00Z');
    const q1 = change('questions', 'q1', 'Insert', {
      id: 'q1', exam_id: 'exam1', content: '问题1',
      created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:00:00Z',
    }, '2026-05-01T10:00:00Z');
    const q2 = change('questions', 'q2', 'Insert', {
      id: 'q2', exam_id: 'exam1', content: '问题2',
      created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:00:00Z',
    }, '2026-05-01T10:00:00Z');
    apply(db, [q2, q1, exam, res]);
    expect(Number(db.pluck('SELECT COUNT(*) FROM questions') ?? 0)).toBe(2);
    expect(Number(db.pluck('SELECT COUNT(*) FROM exam_sheets') ?? 0)).toBe(1);
  });

  it('real_64_soft_delete_resource_while_referenced_is_allowed', () => {
    const db = newRealVfsSchema();
    insertResource(db, 'res1', 'h1', 1);
    insertNote(db, 'n1', 'res1', 'keep me');
    markAllSynced(db);
    const future = new Date(Date.now() + 1000).toISOString();
    expect(() => apply(db, [change('resources', 'res1', 'Delete', null, future)])).not.toThrow();
    expect(db.pluck("SELECT deleted_at FROM resources WHERE id='res1'")).not.toBeNull();
    expect(Number(db.pluck('SELECT COUNT(*) FROM resources') ?? 0)).toBe(1);
    expect(Number(db.pluck("SELECT COUNT(*) FROM notes WHERE id='n1'") ?? 0)).toBe(1);
  });

  it('real_64b_physical_delete_blocked_by_fk', () => {
    const db = newHandle();
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`
      CREATE TABLE test_parents (id TEXT PRIMARY KEY);
      CREATE TABLE test_children (
        id TEXT PRIMARY KEY, parent_id TEXT NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES test_parents(id)
      );
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
        operation TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
      );
      INSERT INTO test_parents (id) VALUES ('p1');
      INSERT INTO test_children (id, parent_id) VALUES ('c1', 'p1');
    `);
    const result = apply(db, [change('test_parents', 'p1', 'Delete', null, '2026-05-01T10:00:00Z', null)]);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
    expect(Number(db.pluck('SELECT COUNT(*) FROM test_parents') ?? 0)).toBe(1);
  });

  it('real_65_fts_trigger_fires_but_batch_stays_transactional', () => {
    const db = newRealVfsSchema();
    insertResource(db, 'res1', 'h1', 1);
    apply(db, [change('exam_sheets', 'exam1', 'Insert', {
      id: 'exam1', resource_id: 'res1', status: 'completed', temp_id: 't',
      metadata_json: '{}', preview_json: '{}', created_at: '2026-05-01T09:00:00Z',
      updated_at: '2026-05-01T09:00:00Z', is_favorite: 0,
    }, '2026-05-01T09:00:00Z')]);

    const inserts: EngineChange[] = [];
    for (let i = 0; i < 100; i += 1) {
      inserts.push(change('questions', `q${String(i).padStart(3, '0')}`, 'Insert', {
        id: `q${String(i).padStart(3, '0')}`, exam_id: 'exam1', content: `content ${i}`,
        created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T10:00:00Z',
      }, '2026-05-01T10:00:00Z'));
    }
    apply(db, inserts);

    const updates: EngineChange[] = [];
    for (let i = 0; i < 100; i += 1) {
      updates.push(change('questions', `q${String(i).padStart(3, '0')}`, 'Update', {
        id: `q${String(i).padStart(3, '0')}`, exam_id: 'exam1', content: `updated content ${i}`,
        created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-01T11:00:00Z',
      }, '2026-05-01T11:00:00Z'));
    }
    expect(() => apply(db, updates)).not.toThrow();
    expect(Number(db.pluck('SELECT COUNT(*) FROM questions_fts_rebuild_log') ?? 0))
      .toBeGreaterThanOrEqual(100);
  });
});

describe('sync real schema 66-70: ref_count, integer timestamps and composites', () => {
  it('real_66_ref_count_is_recomputed_not_delta_merged', () => {
    const dbA = newRealVfsSchema();
    const dbB = newRealVfsSchema();
    insertResource(dbA, 'res1', 'h1', 1);
    insertResource(dbB, 'res1', 'h1', 1);
    markAllSynced(dbA);
    markAllSynced(dbB);
    dbA.run("UPDATE resources SET ref_count=2, updated_at=?1 WHERE id='res1'", [nowMs()]);
    dbB.run("UPDATE resources SET ref_count=2, updated_at=?1 WHERE id='res1'", [nowMs() + 1000]);

    const { conflict } = applyWithGuard(dbA, [change('resources', 'res1', 'Update', {
      id: 'res1', hash: 'h1', type: 'note', storage_mode: 'inline',
      ref_count: 2, created_at: 1, updated_at: nowMs() + 1000,
      __sync_field_deltas: { ref_count: 1 },
    }, '2026-05-01T10:00:00Z')], 'dev_b', 'dev_a');

    expect(dbA.pluck("SELECT ref_count FROM resources WHERE id='res1'")).toBe(0);
    expect(conflict.conflicts_saved).toBeGreaterThan(0);
  });

  it('real_67_integer_updated_at_handled_correctly', () => {
    const db = newRealVfsSchema();
    const localTs = 1_735_000_000_000;
    db.run(
      `INSERT INTO resources (id, hash, type, storage_mode, ref_count, created_at, updated_at)
       VALUES ('res1','h1','note','inline',1,?1,?1)`,
      [localTs],
    );
    markAllSynced(db);
    db.run("UPDATE resources SET data='local_data', updated_at=?1 WHERE id='res1'", [localTs + 1000]);
    const cloudTs = localTs + 5000;
    const cloudIso = new Date(cloudTs).toISOString();
    const { conflict } = applyWithGuard(db, [change('resources', 'res1', 'Update', {
      id: 'res1', hash: 'h1', type: 'note', storage_mode: 'inline',
      ref_count: 1, data: 'cloud_data', created_at: localTs, updated_at: cloudTs,
    }, cloudIso)]);
    expect(db.pluck("SELECT data FROM resources WHERE id='res1'")).not.toBeNull();
    expect(conflict).toBeDefined();
  });

  it('real_68_composite_primary_key_upsert', () => {
    const db = newLlmUsageSchema();
    db.run(
      `INSERT INTO llm_usage_daily (date, caller_type, model, provider, prompt_tokens, completion_tokens, request_count, updated_at)
       VALUES ('2026-05-01','chat','gpt-4','openai',100,50,1,'2026-05-01T12:00:00Z')`,
    );
    const recordId = JSON.stringify({
      date: '2026-05-01', caller_type: 'chat', model: 'gpt-4', provider: 'openai',
    });
    const result = apply(db, [change('llm_usage_daily', recordId, 'Update', {
      date: '2026-05-01', caller_type: 'chat', model: 'gpt-4', provider: 'openai',
      prompt_tokens: 200, completion_tokens: 100, request_count: 2,
      updated_at: '2026-05-01T13:00:00Z',
    }, '2026-05-01T13:00:00Z', 'llm_usage')]);
    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
    expect(db.pluck(
      "SELECT prompt_tokens FROM llm_usage_daily WHERE date='2026-05-01' AND caller_type='chat' AND model='gpt-4' AND provider='openai'",
    )).toBe(100);
    expect(db.pluck(
      "SELECT completion_tokens FROM llm_usage_daily WHERE date='2026-05-01' AND caller_type='chat' AND model='gpt-4' AND provider='openai'",
    )).toBe(50);
    expect(Number(db.pluck('SELECT COUNT(*) FROM llm_usage_daily') ?? 0)).toBe(1);
  });

  it('real_69_delete_resource_after_child_was_deleted_by_another_device', () => {
    const db = newRealVfsSchema();
    insertResource(db, 'res1', 'h1', 1);
    insertNote(db, 'note1', 'res1', 'hi');
    markAllSynced(db);
    expect(() => apply(db, [
      change('resources', 'res1', 'Delete', null, '2026-05-01T10:00:01Z'),
      change('notes', 'note1', 'Delete', null, '2026-05-01T10:00:00Z'),
    ])).not.toThrow();
  });

  it('real_70_many_notes_one_resource_concurrent_update', () => {
    const db = newRealVfsSchema();
    insertResource(db, 'res1', 'h1', 10);
    for (let i = 0; i < 10; i += 1) insertNote(db, `n${i}`, 'res1', 'base');
    markAllSynced(db);
    for (let i = 0; i < 10; i += 1) {
      db.run('UPDATE notes SET title=?1, updated_at=?2 WHERE id=?3', [
        `local_${i}`, `2026-05-01T12:0${i}:00Z`, `n${i}`,
      ]);
    }
    const changes: EngineChange[] = [];
    for (let i = 0; i < 10; i += 1) {
      changes.push(change('notes', `n${i}`, 'Update', {
        id: `n${i}`, resource_id: 'res1', title: `cloud_${i}`, tags: '[]',
        is_favorite: 0, created_at: '2026-01-01T00:00:00Z',
        updated_at: `2026-05-01T13:0${i}:00Z`, deleted_at: null,
      }, `2026-05-01T13:0${i}:00Z`));
    }
    const { apply: applied, conflict } = applyWithGuard(db, changes, 'cloud', 'local');
    expect(applied.success_count).toBe(10);
    expect(conflict.conflicts_saved).toBe(20);
    for (let i = 0; i < 10; i += 1) {
      expect(db.pluck('SELECT title FROM notes WHERE id=?1', [`n${i}`])).toBe(`cloud_${i}`);
    }
  });
});
