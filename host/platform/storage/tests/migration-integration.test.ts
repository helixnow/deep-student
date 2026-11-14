/**
 * 移植自 src-tauri/src/data_governance/migration_tests.rs、
 * src-tauri/tests/migration_fixture_upgrade_gate.rs、
 * src-tauri/tests/sync_r13_migration_change_log_propagation.rs（迁移/change_log 部分）。
 * 映射见 TESTMAP.md。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoordinatedDatabaseName } from '../api.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { initAuditTable } from '../migration/audit-log.ts';
import { ALL_ORDERED, CoreMigrationReport, DATABASE_DEPENDENCIES } from '../migration/backup.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';
import type { MigrationDef } from '../migration/definitions.ts';
import { ALL_MIGRATION_SET_ORDER, loadMigrationSets } from '../migration/definitions/index.ts';
import { MigrationError } from '../migration/errors.ts';
import { MigrationVerifier } from '../migration/verifier.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../../..');
const MIGRATIONS = path.join(REPO, 'resources/app/migrations');
const SETS = loadMigrationSets(MIGRATIONS);
const DATABASE_COUNT = 4;
const TOTAL_MIGRATIONS = ALL_MIGRATION_SET_ORDER.reduce((n, id) => n + SETS[id].count(), 0);
const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3');

const temps: string[] = [];
afterEach(async () => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  // Awaiting already-resolved migration promises alone never services IPC.
  await setImmediate();
});

function createTestDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-migint-'));
  temps.push(d);
  fs.mkdirSync(path.join(d, 'databases'), { recursive: true });
  return d;
}

function coordinator(dir: string, audit = false): MigrationCoordinator {
  return new MigrationCoordinator({
    appDataDir: dir,
    migrationsDir: MIGRATIONS,
    auditDbPath: audit ? path.join(dir, 'databases', 'audit.db') : null,
  });
}

function dbPath(dir: string, id: CoordinatedDatabaseName): string {
  switch (id) {
    case 'vfs':
      return path.join(dir, 'databases', 'vfs.db');
    default:
      return path.join(dir, `${id}.db`);
  }
}

function open(file: string): Connection {
  return new Connection(file, { label: path.basename(file), profile: PROFILES.plain });
}

function withConn<T>(file: string, fn: (c: Connection) => T): T {
  const c = open(file);
  try {
    return fn(c);
  } finally {
    c.close();
  }
}

const latest = (id: CoordinatedDatabaseName) => SETS[id].latestVersion();

function def(partial: Partial<MigrationDef>): MigrationDef {
  return {
    refineryVersion: 1,
    name: 'test',
    sql: '',
    expectedTables: [],
    expectedColumns: [],
    expectedIndexes: [],
    expectedQueries: [],
    idempotent: false,
    ...partial,
  };
}

function expectVerificationFailed(fn: () => void, mention: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    const detail = (error as MigrationError).detail;
    expect(detail.kind).toBe('VerificationFailed');
    if (detail.kind === 'VerificationFailed') expect(detail.reason).toContain(mention);
    return;
  }
  throw new Error('Verification should fail');
}

/** 在独立线程持有 SQLite 锁（Rust 测试用第二条连接/线程持锁）。 */
async function holdLock(file: string, begin: string): Promise<{ release(): Promise<void> }> {
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const D = require(workerData.mod);
     const db = new D(workerData.file);
     db.exec(workerData.begin);
     parentPort.postMessage('locked');
     parentPort.on('message', () => { db.exec('ROLLBACK'); db.close(); parentPort.postMessage('released'); });`,
    { eval: true, workerData: { mod: BETTER_SQLITE3, file, begin } },
  );
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve());
    worker.once('error', reject);
  });
  return {
    release: async () => {
      const done = new Promise<void>((resolve) => worker.once('message', () => resolve()));
      worker.postMessage('release');
      await done;
      await worker.terminate();
    },
  };
}

// ============================================================================
// data_governance/migration_tests.rs
// ============================================================================

describe('data_governance/migration_tests.rs — 新数据库完整迁移流程', () => {
  it('test_full_migration_from_empty_database', async () => {
    const dir = createTestDir();
    for (const id of ALL_ORDERED) expect(fs.existsSync(dbPath(dir, id))).toBe(false);
    const report = await coordinator(dir).runAll();
    expect(report.success).toBe(true);
    expect(report.databases).toHaveLength(DATABASE_COUNT);
    expect(report.totalDurationMs).toBeGreaterThan(0);
    for (const r of report.databases) {
      expect(r.success, r.id).toBe(true);
      expect(r.fromVersion).toBe(0);
      expect(r.toVersion).toBeGreaterThan(0);
      expect(r.appliedCount, r.id).toBe(SETS[r.id].count());
    }
    for (const id of ALL_ORDERED) expect(fs.existsSync(dbPath(dir, id))).toBe(true);
  });

  it('test_no_broken_symlink_migration_files', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d)) {
        const p = path.join(d, e);
        const st = fs.lstatSync(p);
        if (st.isDirectory()) walk(p);
        else if (p.endsWith('.sql')) files.push(p);
      }
    };
    walk(MIGRATIONS);
    expect(files.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const p of files) {
      if (fs.lstatSync(p).isSymbolicLink()) {
        problems.push(`${p} 是符号链接`);
        continue;
      }
      const content = fs.readFileSync(p, 'utf8');
      const trimmed = content.trim();
      if (trimmed.startsWith('../') || trimmed.startsWith('..\\')) {
        problems.push(`${p} 疑似损坏的符号链接文本`);
        continue;
      }
      const lines = trimmed.split('\n').filter((l) => l.trim() !== '');
      if (lines.length === 1 && lines[0]!.trimEnd().endsWith('.sql')) {
        problems.push(`${p} 疑似损坏的符号链接文本（单行指向 .sql）`);
        continue;
      }
      if (!content.includes(';')) problems.push(`${p} 不含任何 SQL 语句分号 ';'`);
    }
    expect(problems).toEqual([]);
  });

  it('test_vfs_database_full_migration', () => {
    const dir = createTestDir();
    const r = coordinator(dir).migrateSingle('vfs');
    expect(r.success).toBe(true);
    expect(r.id).toBe('vfs');
    expect(r.fromVersion).toBe(0);
    expect(r.toVersion).toBe(latest('vfs'));
    expect(r.appliedCount).toBe(SETS.vfs.count());
    expect(fs.existsSync(dbPath(dir, 'vfs'))).toBe(true);
  });

  it('test_chat_v2_database_full_migration', () => {
    const dir = createTestDir();
    const c = coordinator(dir);
    c.migrateSingle('vfs');
    const r = c.migrateSingle('chat_v2');
    expect(r.success).toBe(true);
    expect(r.id).toBe('chat_v2');
    expect(r.toVersion).toBe(latest('chat_v2'));
  });

  it('test_llm_usage_database_full_migration', () => {
    const dir = createTestDir();
    const r = coordinator(dir).migrateSingle('llm_usage');
    expect(r.success).toBe(true);
    expect(r.id).toBe('llm_usage');
    expect(r.toVersion).toBe(latest('llm_usage'));
  });

  it('test_mistakes_database_full_migration', () => {
    const dir = createTestDir();
    const c = coordinator(dir);
    c.migrateSingle('vfs');
    const r = c.migrateSingle('mistakes');
    expect(r.success).toBe(true);
    expect(r.id).toBe('mistakes');
    expect(r.toVersion).toBe(latest('mistakes'));
    expect(fs.existsSync(dbPath(dir, 'mistakes'))).toBe(true);
  });
});

describe('data_governance/migration_tests.rs — run_all', () => {
  it('test_run_all_executes_in_correct_order', async () => {
    const report = await coordinator(createTestDir()).runAll();
    const idx = (id: CoordinatedDatabaseName) => report.databases.findIndex((r) => r.id === id);
    expect(idx('vfs')).toBeLessThan(idx('chat_v2'));
    expect(idx('vfs')).toBeLessThan(idx('mistakes'));
  });

  it('test_run_all_idempotency', async () => {
    const c = coordinator(createTestDir());
    const r1 = await c.runAll();
    expect(r1.success).toBe(true);
    expect(r1.databases.reduce((n, r) => n + r.appliedCount, 0)).toBe(TOTAL_MIGRATIONS);
    const r2 = await c.runAll();
    expect(r2.success).toBe(true);
    expect(r2.databases.reduce((n, r) => n + r.appliedCount, 0)).toBe(0);
  });

  it('test_run_all_stops_on_dependency_failure', () => {
    const c = coordinator(createTestDir());
    const report = new CoreMigrationReport();
    report.add({ id: 'vfs', fromVersion: 0, toVersion: 0, appliedCount: 0, success: false, durationMs: 50, error: 'Test error' });
    try {
      c.checkDependencies('chat_v2', report);
      throw new Error('Should fail when VFS migration failed');
    } catch (error) {
      const detail = (error as MigrationError).detail;
      expect(detail).toEqual({ kind: 'DependencyNotSatisfied', database: 'chat_v2', dependency: 'vfs' });
    }
  });

  it('test_pending_migrations_count', () => {
    expect(coordinator(createTestDir()).pendingMigrationsCount()).toBe(TOTAL_MIGRATIONS);
  });

  it('test_pending_migrations_zero_after_run', async () => {
    const c = coordinator(createTestDir());
    await c.runAll();
    expect(c.pendingMigrationsCount()).toBe(0);
  });
});

describe('data_governance/migration_tests.rs — 验证器', () => {
  it('test_vfs_tables_verified_after_migration', () => {
    const dir = createTestDir();
    coordinator(dir).migrateSingle('vfs');
    withConn(dbPath(dir, 'vfs'), (c) => {
      for (const t of ['resources', 'notes', 'files', 'questions', 'folders', '__change_log']) {
        expect(c.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", [t]), t).toBe(1);
      }
    });
  });

  it('test_vfs_indexes_verified_after_migration', () => {
    const dir = createTestDir();
    coordinator(dir).migrateSingle('vfs');
    withConn(dbPath(dir, 'vfs'), (c) => {
      for (const i of ['idx_resources_hash', 'idx_resources_type', 'idx_notes_resource', 'idx_questions_exam_id']) {
        expect(c.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?)", [i]), i).toBe(1);
      }
    });
  });

  it('test_chat_v2_schema_verified_after_migration', () => {
    const dir = createTestDir();
    const co = coordinator(dir);
    co.migrateSingle('vfs');
    co.migrateSingle('chat_v2');
    withConn(dbPath(dir, 'chat_v2'), (c) => {
      for (const t of ['chat_v2_sessions', 'chat_v2_messages', 'chat_v2_blocks', '__change_log']) {
        expect(c.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", [t]), t).toBe(1);
      }
      const cols = c.all<{ name: string }>('PRAGMA table_info(chat_v2_sessions)').map((r) => r.name);
      for (const col of ['id', 'mode', 'persist_status', 'workspace_id']) expect(cols).toContain(col);
    });
  });

  it('test_verifier_detects_missing_table', () => {
    const dir = createTestDir();
    withConn(path.join(dir, 'test.db'), (c) => {
      c.run('CREATE TABLE resources (id TEXT PRIMARY KEY)');
      expectVerificationFailed(() => MigrationVerifier.verify(c, def({ expectedTables: ['resources', 'nonexistent_table'] })), 'nonexistent_table');
    });
  });

  it('test_verifier_detects_missing_column', () => {
    const dir = createTestDir();
    withConn(path.join(dir, 'test.db'), (c) => {
      c.run('CREATE TABLE test_table (id TEXT PRIMARY KEY)');
      expectVerificationFailed(
        () => MigrationVerifier.verify(c, def({ expectedColumns: [['test_table', 'id'], ['test_table', 'missing_column']] })),
        'missing_column',
      );
    });
  });

  it('test_verifier_detects_missing_index', () => {
    const dir = createTestDir();
    withConn(path.join(dir, 'test.db'), (c) => {
      c.run('CREATE TABLE test_table (id TEXT PRIMARY KEY, name TEXT)');
      expectVerificationFailed(() => MigrationVerifier.verify(c, def({ expectedIndexes: ['idx_test_name'] })), 'idx_test_name');
    });
  });
});

describe('data_governance/migration_tests.rs — 依赖关系', () => {
  it('test_database_dependencies_definition', () => {
    expect(DATABASE_DEPENDENCIES.vfs).toEqual([]);
    expect(DATABASE_DEPENDENCIES.llm_usage).toEqual([]);
    expect(DATABASE_DEPENDENCIES.chat_v2).toEqual(['vfs']);
    expect(DATABASE_DEPENDENCIES.mistakes).toEqual(['vfs']);
  });

  it('test_database_ordering_satisfies_dependencies', () => {
    expect(ALL_ORDERED).toHaveLength(DATABASE_COUNT);
    expect(ALL_ORDERED.indexOf('vfs')).toBeLessThan(ALL_ORDERED.indexOf('chat_v2'));
    expect(ALL_ORDERED.indexOf('vfs')).toBeLessThan(ALL_ORDERED.indexOf('mistakes'));
  });

  it('test_dependency_not_satisfied_error', () => {
    try {
      coordinator(createTestDir()).checkDependencies('chat_v2', new CoreMigrationReport());
      throw new Error('Should fail when dependency not satisfied');
    } catch (error) {
      expect((error as MigrationError).detail).toEqual({ kind: 'DependencyNotSatisfied', database: 'chat_v2', dependency: 'vfs' });
      expect((error as Error).message).toBe('Dependency not satisfied: chat_v2 requires vfs');
    }
  });

  it('test_dependency_satisfied_success', () => {
    const report = new CoreMigrationReport();
    report.add({ id: 'vfs', fromVersion: 0, toVersion: 20260203, appliedCount: SETS.vfs.count(), success: true, durationMs: 100, error: null });
    expect(() => coordinator(createTestDir()).checkDependencies('chat_v2', report)).not.toThrow();
  });

  it('test_full_dependency_chain_migration', async () => {
    const report = await coordinator(createTestDir()).runAll();
    for (const r of report.databases) expect(r.success, r.id).toBe(true);
  });
});

describe('data_governance/migration_tests.rs — 审计日志', () => {
  it('test_audit_log_table_initialization', () => {
    const dir = createTestDir();
    withConn(path.join(dir, 'audit.db'), (c) => {
      initAuditTable(c);
      expect(c.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__audit_log')")).toBe(1);
      expect(c.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_audit_log_timestamp')")).toBe(1);
    });
  });

  it('test_migration_with_audit_logging', async () => {
    const dir = createTestDir();
    const auditPath = path.join(dir, 'databases', 'audit.db');
    withConn(auditPath, (c) => initAuditTable(c));
    await coordinator(dir, true).runAll();
    // = AuditRepository::count_by_type(conn, "Migration")
    const count = withConn(auditPath, (c) => c.pluck<number>("SELECT COUNT(*) FROM __audit_log WHERE operation_type = ?1", ['Migration']));
    expect(count).toBeGreaterThanOrEqual(DATABASE_COUNT);
  });
});

describe('data_governance/migration_tests.rs — needs_migration / 元数据', () => {
  it('test_needs_migration_check', () => {
    const c = coordinator(createTestDir());
    for (const id of ALL_ORDERED) expect(c.needsMigration(id), id).toBe(true);
  });

  it('test_no_migration_needed_after_run', async () => {
    const c = coordinator(createTestDir());
    await c.runAll();
    for (const id of ALL_ORDERED) expect(c.needsMigration(id), id).toBe(false);
  });

  it('test_all_migration_sets_count', () => {
    expect(ALL_MIGRATION_SET_ORDER).toHaveLength(DATABASE_COUNT);
  });

  it('test_migration_set_properties', () => {
    expect(SETS.vfs.databaseName).toBe('vfs');
    expect(SETS.vfs.count()).toBeGreaterThanOrEqual(28);
    expect(SETS.chat_v2.databaseName).toBe('chat_v2');
    expect(SETS.chat_v2.count()).toBeGreaterThanOrEqual(14);
    expect(SETS.mistakes.databaseName).toBe('mistakes');
    expect(SETS.mistakes.count()).toBeGreaterThanOrEqual(6);
    expect(SETS.llm_usage.databaseName).toBe('llm_usage');
    expect(SETS.llm_usage.count()).toBeGreaterThanOrEqual(3);
  });

  it('test_migration_versions_ordered', () => {
    for (const id of ALL_MIGRATION_SET_ORDER) {
      let prev = 0;
      for (const m of SETS[id].migrations) {
        expect(m.refineryVersion, id).toBeGreaterThan(prev);
        prev = m.refineryVersion;
      }
    }
  });

  it('test_get_current_version_new_database', () => {
    const dir = createTestDir();
    expect(withConn(path.join(dir, 'test.db'), (c) => coordinator(dir).getCurrentVersion(c))).toBe(0);
  });

  it('test_get_current_version_migrated_database', () => {
    const dir = createTestDir();
    const c = coordinator(dir);
    c.migrateSingle('vfs');
    expect(withConn(dbPath(dir, 'vfs'), (conn) => c.getCurrentVersion(conn))).toBe(latest('vfs'));
  });
});

const SPARSE_MISTAKES_BASE = `
  CREATE TABLE migration_progress (category TEXT PRIMARY KEY, status TEXT NOT NULL);
  CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, question_images TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '');
  CREATE TABLE document_tasks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL DEFAULT '',
      original_document_name TEXT NOT NULL DEFAULT '',
      segment_index INTEGER NOT NULL DEFAULT 0,
      content_segment TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      anki_generation_options_json TEXT NOT NULL DEFAULT '{}'
  );`;

describe('data_governance/migration_tests.rs — mistakes 旧库恢复与漂移', () => {
  it('test_mistakes_legacy_sparse_schema_recovers_to_latest', () => {
    const dir = createTestDir();
    const file = dbPath(dir, 'mistakes');
    withConn(file, (c) =>
      c.exec(`${SPARSE_MISTAKES_BASE}
        CREATE TABLE anki_cards (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, front TEXT NOT NULL, back TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '',
            card_order_in_task INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '', template_id TEXT, text TEXT
        );
        CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, mistake_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, stable_id TEXT);
        CREATE TABLE review_chat_messages (id INTEGER PRIMARY KEY, review_analysis_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL);`),
    );
    const r = coordinator(dir).migrateSingle('mistakes');
    expect(r.success).toBe(true);
    expect(r.toVersion).toBe(latest('mistakes'));
    withConn(file, (c) => {
      expect(c.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_sessions')")).toBe(1);
      expect(c.pluck("SELECT EXISTS(SELECT 1 FROM pragma_table_info('anki_cards') WHERE name='text')")).toBe(1);
    });
  });

  it('test_mistakes_legacy_recovery_is_reentrant_across_restart', () => {
    const dir = createTestDir();
    withConn(dbPath(dir, 'mistakes'), (c) =>
      c.exec(`${SPARSE_MISTAKES_BASE}
        CREATE TABLE anki_cards (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, front TEXT NOT NULL, back TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '',
            card_order_in_task INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '', template_id TEXT
        );`),
    );
    expect(coordinator(dir).migrateSingle('mistakes').success).toBe(true);
    const second = coordinator(dir).migrateSingle('mistakes');
    expect(second.success).toBe(true);
    expect(second.appliedCount).toBe(0);
    expect(second.toVersion).toBe(latest('mistakes'));
  });

  it('test_mistakes_schema_fingerprint_drift_fails_close', () => {
    const dir = createTestDir();
    const c = coordinator(dir);
    c.migrateSingle('mistakes');
    withConn(dbPath(dir, 'mistakes'), (conn) => conn.run('ALTER TABLE anki_cards ADD COLUMN drift_col TEXT'));
    expectVerificationFailed(() => c.migrateSingle('mistakes'), 'Schema fingerprint drift detected');
  });

  it('test_mistakes_missing_index_is_self_healed', () => {
    const dir = createTestDir();
    const c = coordinator(dir);
    c.migrateSingle('mistakes');
    withConn(dbPath(dir, 'mistakes'), (conn) => conn.run('DROP INDEX IF EXISTS idx_anki_cards_text'));
    expect(c.migrateSingle('mistakes').success).toBe(true);
    expect(
      withConn(dbPath(dir, 'mistakes'), (conn) => conn.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_anki_cards_text')")),
    ).toBe(1);
  });

  it('test_mistakes_preview_column_legacy_state_is_marked_without_duplicate_failure', () => {
    const dir = createTestDir();
    const file = dbPath(dir, 'mistakes');
    withConn(file, (c) => {
      for (const f of ['V20260130__init.sql', 'V20260131__add_change_log.sql', 'V20260201__add_sync_fields.sql']) {
        c.exec(fs.readFileSync(path.join(MIGRATIONS, 'mistakes', f), 'utf8'));
      }
      c.run('CREATE TABLE IF NOT EXISTS refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT)');
      for (const [v, n] of [
        [20260130, 'init'],
        [20260131, 'add_change_log'],
        [20260201, 'add_sync_fields'],
      ] as const) {
        c.run("INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?1, ?2, '2026-02-07T00:00:00Z', '0')", [v, n]);
      }
    });
    const r = coordinator(dir).migrateSingle('mistakes');
    expect(r.success).toBe(true);
    expect(r.toVersion).toBe(latest('mistakes'));
    expect(withConn(file, (c) => c.pluck('SELECT COUNT(*) FROM refinery_schema_history WHERE version = 20260207'))).toBe(1);
  });

  it('test_mistakes_sparse_schema_with_inflated_history_converges', () => {
    const dir = createTestDir();
    const c = coordinator(dir);
    const file = dbPath(dir, 'mistakes');
    withConn(file, (conn) =>
      conn.exec(`
        CREATE TABLE migration_progress (category TEXT PRIMARY KEY, status TEXT NOT NULL);
        CREATE TABLE mistakes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, question_images TEXT NOT NULL);
        CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT);
        INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
        VALUES (20260207, 'add_template_preview_data', '2026-02-07T00:00:00Z', '0');`),
    );
    c.migrateSingle('vfs');
    const r = c.migrateSingle('mistakes');
    expect(r.success).toBe(true);
    expect(r.toVersion).toBe(latest('mistakes'));
    withConn(file, (conn) => {
      expect(conn.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_sessions')")).toBe(1);
      expect(conn.pluck("SELECT EXISTS(SELECT 1 FROM pragma_table_info('anki_cards') WHERE name='text')")).toBe(1);
    });
  });

  it('test_vfs_malformed_history_record_is_cleaned_on_retry', () => {
    const dir = createTestDir();
    const c = coordinator(dir);
    c.migrateSingle('vfs');
    withConn(dbPath(dir, 'vfs'), (conn) =>
      conn.run(
        "INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (0, 'broken', '2026-02-07T00:00:00Z', '')",
      ),
    );
    expect(c.migrateSingle('vfs').success).toBe(true);
    expect(withConn(dbPath(dir, 'vfs'), (conn) => conn.pluck('SELECT COUNT(*) FROM refinery_schema_history WHERE version = 0'))).toBe(0);
  });
});

describe('data_governance/migration_tests.rs — 锁冲突恢复', () => {
  it('test_run_all_recovers_after_chat_v2_lock_failure', async () => {
    const dir = createTestDir();
    const c = coordinator(dir);
    // Rust：另一线程在 chat_v2.db 上持有 BEGIN IMMEDIATE，直到 VFS/llm_usage 完成后才释放；
    // 这里持锁覆盖整个首轮 run_all（chat_v2 写入在 busy_timeout=5000 后失败），之后释放并重试。
    const lock = await holdLock(dbPath(dir, 'chat_v2'), 'BEGIN IMMEDIATE;');
    let first: CoreMigrationReport;
    try {
      first = await c.runAll();
    } finally {
      await lock.release();
    }
    expect(first.success).toBe(false);
    const msg = first.error ?? '';
    expect(msg.includes('locked') || msg.includes('busy'), msg).toBe(true);
    expect(withConn(dbPath(dir, 'vfs'), (conn) => c.getCurrentVersion(conn))).toBe(latest('vfs'));
    const retry = await c.runAll();
    expect(retry.success, retry.error ?? '').toBe(true);
    for (const r of retry.databases) expect(r.toVersion, r.id).toBe(latest(r.id));
  }, 60_000);

  it('test_mistakes_migrate_recovers_after_lock_release', async () => {
    const dir = createTestDir();
    const c = coordinator(dir);
    c.migrateSingle('vfs');
    const lock = await holdLock(dbPath(dir, 'mistakes'), 'BEGIN EXCLUSIVE;');
    let failure: unknown;
    try {
      c.migrateSingle('mistakes');
    } catch (error) {
      failure = error;
    } finally {
      await lock.release();
    }
    expect(failure, 'migration should fail while mistakes db is locked').toBeDefined();
    const msg = String((failure as Error).message);
    expect(msg.includes('locked') || msg.includes('busy'), msg).toBe(true);
    const retry = c.migrateSingle('mistakes');
    expect(retry.success).toBe(true);
    expect(retry.toVersion).toBe(latest('mistakes'));
  }, 60_000);
});

// ============================================================================
// tests/migration_fixture_upgrade_gate.rs
// ============================================================================

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDirRecursive(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

function corruptDatabases(caseDir: string): void {
  let corrupted = 0;
  for (const p of [path.join(caseDir, 'databases', 'vfs.db'), ...['chat_v2', 'mistakes', 'llm_usage'].map((n) => path.join(caseDir, `${n}.db`))]) {
    if (!fs.existsSync(p)) continue;
    const bytes = fs.readFileSync(p);
    const out = Buffer.alloc(Math.max(512, bytes.length), 0xde);
    bytes.copy(out, 512, 512);
    fs.writeFileSync(p, out);
    fs.rmSync(`${p}-wal`, { force: true });
    fs.rmSync(`${p}-shm`, { force: true });
    corrupted++;
  }
  expect(corrupted, `fault mode requires at least one database file in ${caseDir}`).toBeGreaterThan(0);
}

async function runFixtureGate(root: string, mode: 'upgrade' | 'fault' | 'scale', maxSeconds = 300): Promise<string[]> {
  expect(fs.statSync(root).isDirectory()).toBe(true);
  const cases = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .sort();
  expect(cases.length, `fixture root ${root} contains no case directories`).toBeGreaterThan(0);
  const failures: string[] = [];
  for (const caseDir of cases) {
    const work = createTestDir();
    const dataDir = path.join(work, 'app-data');
    copyDirRecursive(caseDir, dataDir);
    if (mode === 'fault') corruptDatabases(dataDir);
    const started = Date.now();
    let ok: boolean;
    let detail: string;
    try {
      const report = await new MigrationCoordinator({ appDataDir: dataDir, migrationsDir: MIGRATIONS }).runAll();
      if (mode === 'fault') {
        ok = !report.success;
        detail = ok ? 'coordinator surfaced failure on corrupted databases' : 'coordinator reported success on corrupted databases (must fail)';
      } else if (!report.success) {
        ok = false;
        detail = `migration report not successful: ${report.error}`;
      } else {
        const mismatches = report.databases
          .filter((d) => d.toVersion !== latest(d.id))
          .map((d) => `${d.id}: reached v${d.toVersion} but latest is v${latest(d.id)}`);
        ok = mismatches.length === 0;
        detail = ok ? `upgraded ${report.databases.length} databases` : mismatches.join('; ');
      }
    } catch (error) {
      ok = mode === 'fault';
      detail = mode === 'fault' ? 'coordinator surfaced failure on corrupted databases' : `migration failed: ${String(error)}`;
    }
    const elapsed = Date.now() - started;
    if (mode === 'scale' && elapsed / 1000 > maxSeconds) {
      ok = false;
      detail += `; exceeded scale budget`;
    }
    if (!ok) failures.push(`${path.basename(caseDir)}: ${detail}`);
  }
  return failures;
}

describe('tests/migration_fixture_upgrade_gate.rs', () => {
  const repoFixtures = path.join(REPO, 'tests/fixtures/migration-upgrade/full');

  it('fixture_upgrade_gate (upgrade mode, repository fixtures)', async () => {
    expect(await runFixtureGate(repoFixtures, 'upgrade')).toEqual([]);
  }, 60_000);

  it('fixture_upgrade_gate (fault mode, repository fixtures)', async () => {
    expect(await runFixtureGate(repoFixtures, 'fault')).toEqual([]);
  }, 60_000);

  it.runIf(process.env.MIGRATION_FIXTURE_ROOT !== undefined)('fixture_upgrade_gate (MIGRATION_FIXTURE_ROOT)', async () => {
    const mode = (process.env.MIGRATION_GATE_MODE ?? 'upgrade') as 'upgrade' | 'fault' | 'scale';
    expect(['upgrade', 'fault', 'scale']).toContain(mode);
    const max = Number(process.env.MIGRATION_GATE_MAX_SECONDS ?? 300);
    expect(await runFixtureGate(process.env.MIGRATION_FIXTURE_ROOT!, mode, Number.isFinite(max) ? max : 300)).toEqual([]);
  }, 600_000);
});

// ============================================================================
// tests/sync_r13_migration_change_log_propagation.rs（迁移/change_log 部分）
// ============================================================================

const readMigration = (db: string, file: string) => fs.readFileSync(path.join(MIGRATIONS, db, file), 'utf8');

function markAllChangeLogSynced(c: Connection): void {
  c.run("UPDATE __change_log SET sync_version = strftime('%s', 'now') WHERE sync_version = 0");
}

function pendingRowsForTable(c: Connection, table: string): Array<[string, string]> {
  return c
    .all<{ record_id: string; operation: string }>(
      'SELECT record_id, operation FROM __change_log WHERE sync_version = 0 AND table_name = ?1 ORDER BY id',
      [table],
    )
    .map((r) => [r.record_id, r.operation]);
}

describe('tests/sync_r13_migration_change_log_propagation.rs', () => {
  it('v20260824_normalization_updates_enter_change_log_as_pending', async () => {
    const dir = createTestDir();
    const report = await new MigrationCoordinator({ appDataDir: dir, migrationsDir: MIGRATIONS, auditDbPath: null }).runAll();
    expect(report.success).toBe(true);
    withConn(dbPath(dir, 'mistakes'), (c) => {
      c.run(`INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status, anki_generation_options_json)
             VALUES ('task-1', 'doc-1', 'doc.md', 0, 'segment', 'Completed', '{}')`);
      c.run(`INSERT INTO anki_cards (id, task_id, front, back, tags_json, images_json, extra_fields_json, updated_at)
             VALUES ('card-dirty', 'task-1', 'dirty front', 'dirty back', NULL, '', '  ', '2026-08-10T00:00:00.000Z')`);
      c.run(`INSERT INTO anki_cards (id, task_id, front, back, tags_json, images_json, extra_fields_json)
             VALUES ('card-clean', 'task-1', 'clean front', 'clean back', '[]', '[]', '{}')`);
      markAllChangeLogSynced(c);
      const sql = readMigration('mistakes', 'V20260824__normalize_anki_card_optional_json.sql');
      c.exec(sql);
      const row = c.get<{ tags_json: string; images_json: string; extra_fields_json: string; updated_at: string }>(
        "SELECT tags_json, images_json, extra_fields_json, updated_at FROM anki_cards WHERE id = 'card-dirty'",
      );
      expect(row).toEqual({ tags_json: '[]', images_json: '[]', extra_fields_json: '{}', updated_at: '2026-08-10T00:00:00.000Z' });
      const pending = pendingRowsForTable(c, 'anki_cards');
      expect(pending.some(([id, op]) => id === 'card-dirty' && op === 'UPDATE'), JSON.stringify(pending)).toBe(true);
      expect(pending.every(([id]) => id !== 'card-clean')).toBe(true);
      // SyncManager::get_pending_changes 可见性断言属于 L20（同步引擎），见 TESTMAP。
      const maxBefore = c.pluck<number>('SELECT COALESCE(MAX(id), 0) FROM __change_log')!;
      c.exec(sql);
      expect(c.pluck('SELECT COUNT(*) FROM __change_log WHERE id > ?1', [maxBefore])).toBe(0);
    });
  });

  it('v20260824_null_source_tombstone_sweep_enters_change_log', () => {
    const dir = createTestDir();
    withConn(path.join(dir, 'mistakes.db'), (c) => {
      c.exec(readMigration('mistakes', 'V20260130__init.sql'));
      c.exec(`DROP TABLE anki_cards;
        CREATE TABLE anki_cards (
            id TEXT PRIMARY KEY, task_id TEXT, front TEXT NOT NULL, back TEXT NOT NULL,
            tags_json TEXT, images_json TEXT, is_error_card INTEGER NOT NULL DEFAULT 0,
            error_content TEXT, card_order_in_task INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            extra_fields_json TEXT, template_id TEXT, source_type TEXT, source_id TEXT, text TEXT,
            device_id TEXT, local_version INTEGER DEFAULT 0, deleted_at TEXT
        );`);
      c.exec(readMigration('mistakes', 'V20260131__add_change_log.sql'));
      c.exec(readMigration('mistakes', 'V20260724__anki_dedup_index_exclude_deleted.sql'));
      c.exec(`INSERT INTO anki_cards (id, front, back, updated_at, created_at)
              VALUES ('legacy-old', 'F', 'B', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
              INSERT INTO anki_cards (id, front, back, updated_at, created_at)
              VALUES ('legacy-new', 'F', 'B', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');`);
      markAllChangeLogSynced(c);
      c.exec(readMigration('mistakes', 'V20260824__normalize_anki_card_optional_json.sql'));
      const winner = c.get<{ deleted_at: string | null; source_type: string }>("SELECT deleted_at, source_type FROM anki_cards WHERE id = 'legacy-new'")!;
      expect(winner.deleted_at).toBeNull();
      expect(winner.source_type).toBe('');
      expect(c.pluck("SELECT deleted_at FROM anki_cards WHERE id = 'legacy-old'")).not.toBeNull();
      const pending = pendingRowsForTable(c, 'anki_cards');
      for (const id of ['legacy-old', 'legacy-new']) {
        expect(pending.some(([r, op]) => r === id && op === 'UPDATE'), `${id}: ${JSON.stringify(pending)}`).toBe(true);
      }
    });
  });

  it('gap_v20260302_folder_items_normalization_never_entered_change_log', () => {
    const dir = createTestDir();
    withConn(path.join(dir, 'vfs.db'), (c) => {
      c.exec(readMigration('vfs', 'V20260130__init.sql'));
      c.exec(readMigration('vfs', 'V20260131__add_change_log.sql'));
      c.run(`INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, updated_at)
             VALUES ('fi_legacy0001', NULL, 'note', 'note-1', 0, '2026-02-14T08:00:00Z', '2026-02-14T09:00:00Z')`);
      c.exec(readMigration('vfs', 'V20260302__normalize_folder_items_timestamps.sql'));
      expect(c.get("SELECT typeof(created_at) AS c, typeof(updated_at) AS u FROM folder_items WHERE id = 'fi_legacy0001'")).toEqual({
        c: 'integer',
        u: 'integer',
      });
      expect(c.pluck("SELECT COUNT(*) FROM __change_log WHERE table_name = 'folder_items'")).toBe(0);
    });
  });
});
