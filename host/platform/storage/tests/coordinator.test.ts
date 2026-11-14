/**
 * 移植 `dstu-storage/src/migration/coordinator.rs` 的 #[cfg(test)] 中需要完整协调器的测试。
 * 测试名包含原 Rust 函数名；私有方法经下标访问（对应 Rust 同模块测试对私有方法的调用）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoordinatedDatabaseName } from '../api.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { CoreMigrationReport } from '../migration/backup.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';
import { MigrationSet } from '../migration/definitions.ts';
import { DEFAULT_MIGRATIONS_DIR } from '../migration/definitions/index.ts';
import { MigrationError } from '../migration/errors.ts';
import {
  buildMigrationScratch,
  computeSchemaFingerprint,
  ensureSchemaFingerprintTable,
  filterCanonicalSchemaToScope,
  hashCanonicalSchema,
  isKnownChatV2PriorScopeFingerprint,
  verifySchemaFingerprint,
  type SchemaFingerprint,
} from '../migration/fingerprint.ts';
import { RepairHelpers } from '../migration/helpers.ts';
import { Migration, Runner } from '../migration/refinery.ts';
import { extractCreateTableIfNotExists } from '../migration/sql-text.ts';

const DIR = DEFAULT_MIGRATIONS_DIR;
const readSql = (file: string) => fs.readFileSync(path.join(DIR, file), 'utf8');
const quiet = () => undefined;

const CHAT_V2_SESSION_TAGS_SYNC_VERSION = 20260711;
const CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION = 20260528;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION = 20260721;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION = 20260720;
const CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_SCOPE_VERSION = 20260719;
const SCHEMA_FINGERPRINT_TABLE = '__governance_schema_fingerprints';
const FAULT_MARKER_PAYLOAD = 'governance-fault-marker';

const opened: Connection[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) c.close();
  for (const d of tempDirs.splice(0)) {
    fs.chmodSync(d, 0o755);
    fs.rmSync(d, { recursive: true, force: true });
  }
  // Yield between synchronous SQLite cases so Vitest can receive RPC replies.
  await setImmediate();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-coord-'));
  tempDirs.push(dir);
  return dir;
}

function open(file: string): Connection {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Connection(file, { label: path.basename(file), profile: PROFILES.plain });
  opened.push(conn);
  return conn;
}

function close(conn: Connection): void {
  const i = opened.indexOf(conn);
  if (i >= 0) opened.splice(i, 1);
  conn.close();
}

// ------------------------------------------------------------------ fault_injection.rs

/** `fault_injection.rs`：按 (scope = 规范化数据目录, point) 计数的确定性注入。 */
const failpoints = new Map<string, { remaining: number; hits: number }>();
const scopeKey = (dir: string) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};
function arm(dir: string, point: string, times: number) {
  const key = `${scopeKey(dir)}::${point}`;
  failpoints.set(key, { remaining: times, hits: 0 });
  return {
    hits: () => failpoints.get(key)?.hits ?? 0,
    disarm: () => failpoints.delete(key),
  };
}
function failpointHook(dir: string): (point: string) => void {
  return (point) => {
    const state = failpoints.get(`${scopeKey(dir)}::${point}`);
    if (state !== undefined && state.remaining > 0) {
      state.remaining--;
      state.hits++;
      throw MigrationError.database(`[failpoint] injected deterministic failure at '${point}'`);
    }
  };
}

// ------------------------------------------------------------------ 协调器辅助

interface Privates {
  runRefineryMigrations(conn: Connection, h: RepairHelpers, id: CoordinatedDatabaseName): { appliedCount: number; schemaRepaired: boolean };
  makeAlterColumnsSafe(h: RepairHelpers, runner: Runner): void;
  repairRefineryChecksums(conn: Connection, id: CoordinatedDatabaseName, runner: Runner): void;
  verifyMigrations(conn: Connection, id: CoordinatedDatabaseName, set: MigrationSet, version: number, applied: number, repaired: boolean): void;
  failpoint(point: string): void;
}
const priv = (c: MigrationCoordinator) => c as unknown as Privates;

/** `create_test_coordinator`：`with_audit_db(None)`。 */
function createTestCoordinator(): { coordinator: MigrationCoordinator; dir: string } {
  const dir = tempDir();
  return { coordinator: new MigrationCoordinator({ appDataDir: dir, auditDbPath: null, log: quiet, failpoint: failpointHook(dir) }), dir };
}

const helpers = (conn: Connection) => new RepairHelpers(conn, quiet);
const isRecorded = (conn: Connection, version: number) => helpers(conn).isMigrationRecorded(version);
const fp = (conn: Connection, c: MigrationCoordinator, id: CoordinatedDatabaseName, set: MigrationSet, version: number, allow: boolean) =>
  verifySchemaFingerprint(conn, id, set, version, allow, quiet);

function expectVerificationFailed(fn: () => void, contains?: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).detail.kind).toBe('VerificationFailed');
    if (contains !== undefined) expect((error as MigrationError).message).toContain(contains);
    return;
  }
  throw new Error('expected VerificationFailed');
}

/** `build_v0944_vfs`：VFS 记账到 V20260808（按 runner 真实 name/checksum）。 */
function buildV0944Vfs(c: MigrationCoordinator): Connection {
  // Rust coordinator.rs:5551 uses an in-memory historical fixture.
  const conn = new Connection(':memory:', { label: 'vfs', profile: PROFILES.plain });
  opened.push(conn);
  const runner = c.createRunner('vfs');
  const h = helpers(conn);
  h.ensureRefineryHistoryTable();
  for (const m of runner.getMigrations().filter((m) => m.version <= 20260808)) {
    conn.exec(m.sql!);
    h.markMigrationComplete(runner, m.version);
  }
  return conn;
}

function insertV0944Note(conn: Connection, noteId: string): void {
  conn.run(
    `INSERT INTO resources
             (id, hash, type, storage_mode, ref_count, data, created_at, updated_at)
             VALUES (?1, ?2, 'note', 'inline', 1, 'legacy body', 1, 1)`,
    [`res_${noteId}`, `hash_${noteId}`],
  );
  conn.run(
    `INSERT INTO notes
             (id, resource_id, title, tags, is_favorite, created_at, updated_at)
             VALUES (?1, ?2, 'legacy note', '[]', 0,
                     '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z')`,
    [noteId, `res_${noteId}`],
  );
}

function markMistakesVersion(conn: Connection, version: number, name: string): void {
  conn.run(
    `INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (?1, ?2, '2026-06-30T00:00:00Z', '0')`,
    [version, name],
  );
}

const HISTORY_DDL =
  'CREATE TABLE IF NOT EXISTS refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT)';

function applyChatV2Migrations(c: MigrationCoordinator, conn: Connection, through = Number.MAX_SAFE_INTEGER): void {
  for (const m of c.sets.chat_v2.migrations) if (m.refineryVersion <= through) conn.exec(m.sql);
}

function chatV2SetThrough(c: MigrationCoordinator, version: number): MigrationSet {
  return new MigrationSet('chat_v2', c.sets.chat_v2.migrations.filter((m) => m.refineryVersion <= version));
}

function seedPriorScope(c: MigrationCoordinator, conn: Connection, target: number, previous: number): SchemaFingerprint {
  ensureSchemaFingerprintTable(conn, quiet);
  const prior = computeSchemaFingerprint(conn, c.sets.chat_v2, previous);
  conn.run(
    `INSERT INTO __governance_schema_fingerprints
             (database_id, schema_version, fingerprint, verified_at, canonical_schema)
             VALUES ('chat_v2', ?1, ?2, 'poisoned-baseline', ?3)`,
    [target, prior.hash, prior.canonicalSchema],
  );
  return prior;
}

function seedHistoricalScope(c: MigrationCoordinator, conn: Connection, target: number, recordedScope: number): SchemaFingerprint {
  ensureSchemaFingerprintTable(conn, quiet);
  const scratch = buildMigrationScratch(c.sets.chat_v2, recordedScope);
  try {
    const prior = computeSchemaFingerprint(scratch, c.sets.chat_v2, recordedScope);
    conn.run(
      `INSERT INTO __governance_schema_fingerprints
             (database_id, schema_version, fingerprint, verified_at, canonical_schema)
             VALUES ('chat_v2', ?1, ?2, 'poisoned-historical-baseline', ?3)`,
      [target, prior.hash, prior.canonicalSchema],
    );
    return prior;
  } finally {
    scratch.close();
  }
}

function persisted(conn: Connection, version: number): [string, string] {
  const row = conn.get<{ fingerprint: string; canonical_schema: string }>(
    `SELECT fingerprint, canonical_schema FROM __governance_schema_fingerprints WHERE database_id='chat_v2' AND schema_version=?1`,
    [version],
  );
  return [row!.fingerprint, row!.canonical_schema];
}

/** `second_latest_version`。 */
const secondLatest = (set: MigrationSet) => set.migrations[set.migrations.length - 2]!.refineryVersion;

/** `build_db_at_version`：执行注册迁移 SQL、history checksum '0'、WAL、写 marker。 */
function buildDbAtVersion(c: MigrationCoordinator, id: CoordinatedDatabaseName, target: number): void {
  const conn = open(c.getDatabasePath(id));
  conn.pluck('PRAGMA journal_mode=WAL');
  conn.run(HISTORY_DDL);
  for (const m of c.sets[id].migrations.filter((m) => m.refineryVersion <= target)) {
    conn.exec(m.sql);
    conn.run(
      `INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum)
                 VALUES (?1, ?2, '2026-07-01T00:00:00Z', '0')`,
      [m.refineryVersion, m.name],
    );
  }
  conn.run('CREATE TABLE IF NOT EXISTS __test_marker (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  conn.run("INSERT OR REPLACE INTO __test_marker (id, payload) VALUES ('m', ?1)", [FAULT_MARKER_PAYLOAD]);
  close(conn);
}

const ORDER: CoordinatedDatabaseName[] = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];

function buildOldCoreState(c: MigrationCoordinator): Array<[CoordinatedDatabaseName, number]> {
  const targets: Array<[CoordinatedDatabaseName, number]> = [
    ['vfs', c.sets.vfs.latestVersion()],
    ['llm_usage', secondLatest(c.sets.llm_usage)],
    ['chat_v2', secondLatest(c.sets.chat_v2)],
    ['mistakes', secondLatest(c.sets.mistakes)],
  ];
  for (const [id, v] of targets) buildDbAtVersion(c, id, v);
  return targets;
}

function coreVersionTuple(c: MigrationCoordinator): Array<[CoordinatedDatabaseName, number]> {
  return ORDER.map((id) => {
    const conn = open(c.getDatabasePath(id));
    const v = c.getCurrentVersion(conn);
    close(conn);
    return [id, v];
  });
}

/** `new_schema_sentinels`。 */
function newSchemaSentinels(c: MigrationCoordinator): [boolean, boolean, boolean] {
  const chat = open(c.getDatabasePath('chat_v2'));
  const mistakes = open(c.getDatabasePath('mistakes'));
  const llm = open(c.getDatabasePath('llm_usage'));
  const result: [boolean, boolean, boolean] = [
    helpers(chat).indexExists('idx_chat_v2_sessions_status_updated'),
    helpers(mistakes).columnExists('automation_definitions', 'trusted_profile_json'),
    !helpers(llm).triggerExists('trg__change_log_usage_daily_insert'),
  ];
  for (const x of [chat, mistakes, llm]) close(x);
  return result;
}

function assertMarkersIntact(c: MigrationCoordinator, context: string): void {
  for (const id of ORDER) {
    const conn = open(c.getDatabasePath(id));
    expect(conn.pluck("SELECT payload FROM __test_marker WHERE id = 'm'"), `[${context}] ${id} marker`).toBe(FAULT_MARKER_PAYLOAD);
    close(conn);
  }
}

const latest = (c: MigrationCoordinator, id: CoordinatedDatabaseName) => c.sets[id].latestVersion();

// ------------------------------------------------------------------ 基础

describe('coordinator.rs basics', () => {
  it('test_new_coordinator', () => {
    const { coordinator, dir } = createTestCoordinator();
    expect(coordinator.appDataDir).toBe(dir);
  });

  it('test_database_paths', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    expect(c.getDatabasePath('vfs')).toBe(path.join(dir, 'databases', 'vfs.db'));
    expect(c.getDatabasePath('chat_v2')).toBe(path.join(dir, 'chat_v2.db'));
    expect(c.getDatabasePath('mistakes')).toBe(path.join(dir, 'mistakes.db'));
    expect(c.getDatabasePath('llm_usage')).toBe(path.join(dir, 'llm_usage.db'));
  });

  it('test_migration_report', () => {
    const report = new CoreMigrationReport();
    expect(report.success).toBe(true);
    expect(report.databases).toHaveLength(0);
    report.add({ id: 'vfs', fromVersion: 0, toVersion: 1, appliedCount: 1, success: true, durationMs: 100, error: null });
    expect(report.success).toBe(true);
    expect(report.databases).toHaveLength(1);
    report.add({ id: 'chat_v2', fromVersion: 0, toVersion: 0, appliedCount: 0, success: false, durationMs: 50, error: 'Test error' });
    expect(report.success).toBe(false);
    expect(report.databases).toHaveLength(2);
  });

  it('test_needs_migration_nonexistent_db', () => {
    const { coordinator: c } = createTestCoordinator();
    for (const id of ORDER) expect(c.needsMigration(id)).toBe(true);
  });

  it('test_pending_migrations_count_empty', () => {
    const { coordinator: c } = createTestCoordinator();
    const expected = ORDER.reduce((n, id) => n + c.sets[id].count(), 0);
    expect(c.pendingMigrationsCount()).toBe(expected);
  });

  it('test_get_current_version_no_table', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    expect(c.getCurrentVersion(open(path.join(dir, 'test.db')))).toBe(0);
  });

  it('test_check_dependencies_success', () => {
    const { coordinator: c } = createTestCoordinator();
    const report = new CoreMigrationReport();
    expect(() => c.checkDependencies('vfs', report)).not.toThrow();
    report.add({ id: 'vfs', fromVersion: 0, toVersion: 1, appliedCount: 1, success: true, durationMs: 100, error: null });
    expect(() => c.checkDependencies('chat_v2', report)).not.toThrow();
  });

  it('test_check_dependencies_failure', () => {
    const { coordinator: c } = createTestCoordinator();
    try {
      c.checkDependencies('chat_v2', new CoreMigrationReport());
      expect.unreachable();
    } catch (error) {
      expect((error as MigrationError).detail).toEqual({ kind: 'DependencyNotSatisfied', database: 'chat_v2', dependency: 'vfs' });
    }
  });
});

// ------------------------------------------------------------------ VFS v0.9.44 / V20260824

describe('coordinator.rs VFS upgrade paths', () => {
  it('test_v0944_vfs_upgrade_adds_nullable_note_props_without_touching_rows', () => {
    const { coordinator: c } = createTestCoordinator();
    const conn = buildV0944Vfs(c);
    insertV0944Note(conn, 'note_v0944');
    const h = helpers(conn);
    expect(h.columnExists('notes', 'props')).toBe(false);
    priv(c).runRefineryMigrations(conn, h, 'vfs');
    expect(h.columnExists('notes', 'props')).toBe(true);
    expect(conn.pluck("SELECT props FROM notes WHERE id = 'note_v0944'")).toBeNull();
    expect(h.isMigrationRecorded(20260824)).toBe(true);
  }, 120_000);

  it('test_v20260824_duplicate_column_rerun_is_repaired_and_preserves_props', () => {
    const { coordinator: c } = createTestCoordinator();
    const conn = buildV0944Vfs(c);
    insertV0944Note(conn, 'note_partial');
    conn.run('ALTER TABLE notes ADD COLUMN props TEXT');
    conn.run(`UPDATE notes SET props = '{"status":"draft"}' WHERE id = 'note_partial'`);
    priv(c).runRefineryMigrations(conn, helpers(conn), 'vfs');
    expect(conn.pluck("SELECT props FROM notes WHERE id = 'note_partial'")).toBe('{"status":"draft"}');
    expect(isRecorded(conn, 20260824)).toBe(true);
  }, 120_000);

  it('test_sparse_vfs_full_migrate_entry_never_reports_success_without_init_objects', () => {
    const { coordinator: c } = createTestCoordinator();
    const dbPath = c.getDatabasePath('vfs');
    const sparse = open(dbPath);
    for (const [name, statement] of extractCreateTableIfNotExists(readSql('vfs/V20260130__init.sql'))) {
      if (name === 'resources' || name === 'notes') sparse.exec(statement);
    }
    const h = helpers(sparse);
    h.ensureRefineryHistoryTable();
    h.markMigrationComplete(c.createRunner('vfs'), 20260130);
    close(sparse);

    let report: ReturnType<MigrationCoordinator['migrateSingle']> | undefined;
    let entryError: unknown;
    try {
      report = c.migrateSingle('vfs');
    } catch (error) {
      entryError = error;
    }
    const conn = open(dbPath);
    const has = (type: string, name: string) =>
      conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2)', [type, name]) === 1;
    const complete = has('index', 'idx_folders_parent') && has('table', 'questions_fts') && has('view', 'trash_view');
    if (report !== undefined) {
      expect(complete).toBe(true);
      expect(report.success).toBe(true);
    } else if (!complete) {
      expect(entryError).toBeDefined();
      expectVerificationFailed(() => priv(c).verifyMigrations(conn, 'vfs', c.sets.vfs, c.getCurrentVersion(conn), 0, false));
    }
  }, 120_000);
});

// ------------------------------------------------------------------ 指纹

function mistakesInitDb(c: MigrationCoordinator, dir: string): Connection {
  const conn = open(path.join(dir, 'mistakes.db'));
  conn.exec(readSql('mistakes/V20260130__init.sql'));
  return conn;
}

describe('coordinator.rs schema fingerprint', () => {
  it('test_verify_migrations_persists_schema_fingerprint', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = mistakesInitDb(c, dir);
    conn.run(HISTORY_DDL);
    conn.run("INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260130, 'init', '2026-02-07T00:00:00Z', '0')");
    priv(c).verifyMigrations(conn, 'mistakes', c.sets.mistakes, 20260130, 1, false);
    expect(
      conn.pluck(`SELECT COUNT(*) FROM ${SCHEMA_FINGERPRINT_TABLE} WHERE database_id = ?1 AND schema_version = ?2`, ['mistakes', 20260130]),
    ).toBe(1);
  });

  it('test_verify_migrations_detects_schema_fingerprint_drift', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = mistakesInitDb(c, dir);
    fp(conn, c, 'mistakes', c.sets.mistakes, 20260130, false);
    conn.run('ALTER TABLE anki_cards ADD COLUMN drift_marker INTEGER');
    expectVerificationFailed(() => fp(conn, c, 'mistakes', c.sets.mistakes, 20260130, false), 'Schema fingerprint drift detected');
    fp(conn, c, 'mistakes', c.sets.mistakes, 20260130, true);
  });

  it('test_newer_history_does_not_create_or_update_fingerprint', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'chat_v2.db'));
    applyChatV2Migrations(c, conn);
    const older = chatV2SetThrough(c, CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION);
    fp(conn, c, 'chat_v2', older, CHAT_V2_SESSION_TAGS_SYNC_VERSION, false);
    expect(conn.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [SCHEMA_FINGERPRINT_TABLE])).toBe(0);
    ensureSchemaFingerprintTable(conn, quiet);
    const sentinelSchema = 'table:sentinel\n';
    const sentinelHash = hashCanonicalSchema(sentinelSchema);
    conn.run(
      `INSERT INTO __governance_schema_fingerprints (database_id, schema_version, fingerprint, verified_at, canonical_schema)
             VALUES ('chat_v2', ?1, ?2, 'sentinel-time', ?3)`,
      [CHAT_V2_SESSION_TAGS_SYNC_VERSION, sentinelHash, sentinelSchema],
    );
    fp(conn, c, 'chat_v2', older, CHAT_V2_SESSION_TAGS_SYNC_VERSION, false);
    expect(
      conn.get(
        `SELECT fingerprint, verified_at, canonical_schema FROM __governance_schema_fingerprints WHERE database_id='chat_v2' AND schema_version=?1`,
        [CHAT_V2_SESSION_TAGS_SYNC_VERSION],
      ),
    ).toEqual({ fingerprint: sentinelHash, verified_at: 'sentinel-time', canonical_schema: sentinelSchema });
  });

  it('test_known_chat_v2_prior_scope_fingerprint_is_recovered', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'chat_v2.db'));
    applyChatV2Migrations(c, conn);
    const prior = seedPriorScope(c, conn, CHAT_V2_SESSION_TAGS_SYNC_VERSION, CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION);
    const current = computeSchemaFingerprint(conn, c.sets.chat_v2, CHAT_V2_SESSION_TAGS_SYNC_VERSION);
    expect(prior.hash).not.toBe(current.hash);
    fp(conn, c, 'chat_v2', c.sets.chat_v2, CHAT_V2_SESSION_TAGS_SYNC_VERSION, false);
    expect(persisted(conn, CHAT_V2_SESSION_TAGS_SYNC_VERSION)).toEqual([current.hash, current.canonicalSchema]);
  });

  it('test_known_chat_v2_recovery_rejects_changed_trigger_sql', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'chat_v2.db'));
    applyChatV2Migrations(c, conn);
    seedPriorScope(c, conn, CHAT_V2_SESSION_TAGS_SYNC_VERSION, CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION);
    conn.exec(`DROP TRIGGER trg__change_log_session_tags_insert;
             CREATE TRIGGER trg__change_log_session_tags_insert
             AFTER INSERT ON chat_v2_session_tags BEGIN SELECT 1; END;`);
    expectVerificationFailed(() => fp(conn, c, 'chat_v2', c.sets.chat_v2, CHAT_V2_SESSION_TAGS_SYNC_VERSION, false), 'Schema fingerprint drift detected');
  });

  it('test_known_chat_v2_recovery_rejects_unrelated_managed_schema_drift', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'chat_v2.db'));
    applyChatV2Migrations(c, conn);
    seedPriorScope(c, conn, CHAT_V2_SESSION_TAGS_SYNC_VERSION, CHAT_V2_SESSION_TAGS_PREVIOUS_VERSION);
    conn.run('ALTER TABLE chat_v2_sessions ADD COLUMN external_drift_marker TEXT');
    expectVerificationFailed(() => fp(conn, c, 'chat_v2', c.sets.chat_v2, CHAT_V2_SESSION_TAGS_SYNC_VERSION, false), 'Schema fingerprint drift detected');
  });

  it('test_known_chat_v2_v20260721_prior_scope_fingerprint_is_recovered_and_stable', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'chat_v2.db'));
    applyChatV2Migrations(c, conn, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION);
    const prior = seedPriorScope(c, conn, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION, CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION);
    const current = computeSchemaFingerprint(conn, c.sets.chat_v2, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION);
    expect(prior.hash).not.toBe(current.hash);
    fp(conn, c, 'chat_v2', c.sets.chat_v2, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION, false);
    expect(persisted(conn, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION)).toEqual([current.hash, current.canonicalSchema]);
    fp(conn, c, 'chat_v2', c.sets.chat_v2, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION, false);
  });

  it('test_known_chat_v2_v20260721_recovers_v20260719_historical_scope_fingerprint', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'chat_v2.db'));
    applyChatV2Migrations(c, conn, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION);
    const historical = seedHistoricalScope(c, conn, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION, CHAT_V2_WORKSPACE_DELETION_JOURNAL_LEGACY_SCOPE_VERSION);
    const current = computeSchemaFingerprint(conn, c.sets.chat_v2, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION);
    expect(historical.hash).not.toBe(current.hash);
    fp(conn, c, 'chat_v2', c.sets.chat_v2, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION, false);
    expect(persisted(conn, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION)).toEqual([current.hash, current.canonicalSchema]);
  });

  const journalDrifts: Array<[string, string]> = [
    ['test_known_chat_v2_v20260721_recovery_rejects_changed_journal_table_sql', 'ALTER TABLE __file_deletion_journal ADD COLUMN external_drift_marker TEXT'],
    [
      'test_known_chat_v2_v20260721_recovery_rejects_changed_journal_index_sql',
      `DROP INDEX idx__file_deletion_journal_recovery;
             CREATE INDEX idx__file_deletion_journal_recovery
             ON __file_deletion_journal(state, prepared_at);`,
    ],
    [
      'test_known_chat_v2_v20260721_recovery_rejects_changed_journal_trigger_sql',
      `DROP TRIGGER trg__workspace_deletion_queue_published;
             CREATE TRIGGER trg__workspace_deletion_queue_published
             AFTER DELETE ON __workspace_deletion_queue BEGIN SELECT 1; END;`,
    ],
    [
      'test_known_chat_v2_v20260721_recovery_rejects_malformed_stored_hash',
      `UPDATE __governance_schema_fingerprints SET fingerprint='not-a-sha256'
             WHERE database_id='chat_v2' AND schema_version=${CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION}`,
    ],
  ];
  for (const [name, mutation] of journalDrifts) {
    it(name, () => {
      const { coordinator: c, dir } = createTestCoordinator();
      const conn = open(path.join(dir, 'chat_v2.db'));
      applyChatV2Migrations(c, conn);
      seedPriorScope(c, conn, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION, CHAT_V2_WORKSPACE_DELETION_JOURNAL_PREVIOUS_VERSION);
      conn.exec(mutation);
      expectVerificationFailed(() => fp(conn, c, 'chat_v2', c.sets.chat_v2, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION, false));
    });
  }

  it('test_known_chat_v2_prior_scope_recovery_rejects_unlisted_versions_and_databases', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'chat_v2.db'));
    applyChatV2Migrations(c, conn);
    const v19 = computeSchemaFingerprint(conn, c.sets.chat_v2, 20260719);
    const v20 = computeSchemaFingerprint(conn, c.sets.chat_v2, 20260720);
    expect(isKnownChatV2PriorScopeFingerprint(conn, 'chat_v2', c.sets.chat_v2, 20260720, v19.hash, v19.canonicalSchema, v20, quiet)).toBe(false);
    const v21 = computeSchemaFingerprint(conn, c.sets.chat_v2, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION);
    expect(
      isKnownChatV2PriorScopeFingerprint(conn, 'mistakes', c.sets.chat_v2, CHAT_V2_WORKSPACE_DELETION_JOURNAL_VERSION, v20.hash, v20.canonicalSchema, v21, quiet),
    ).toBe(false);
  });

  it('test_schema_fingerprint_ignores_runtime_managed_objects', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = mistakesInitDb(c, dir);
    fp(conn, c, 'mistakes', c.sets.mistakes, 20260130, false);
    conn.exec(`
            CREATE TABLE IF NOT EXISTS runtime_documents (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_runtime_documents_body ON runtime_documents(body);
            CREATE INDEX IF NOT EXISTS idx_rag_sub_libraries_runtime_name ON rag_sub_libraries(name);`);
    fp(conn, c, 'mistakes', c.sets.mistakes, 20260130, false);
  });

  it('test_schema_fingerprint_rebaselines_legacy_broad_scope_record', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = mistakesInitDb(c, dir);
    fp(conn, c, 'mistakes', c.sets.mistakes, 20260130, false);
    const canonical = conn.pluck<string>(
      `SELECT canonical_schema FROM ${SCHEMA_FINGERPRINT_TABLE} WHERE database_id = ?1 AND schema_version = ?2`,
      ['mistakes', 20260130],
    )!;
    const legacyBroad = `${canonical}table:runtime_documents\ncol:0:id:TEXT:0::1\nidx:idx_rag_sub_libraries_runtime_name:CREATE INDEX idx_rag_sub_libraries_runtime_name ON rag_sub_libraries(name)\n`;
    const current = computeSchemaFingerprint(conn, c.sets.mistakes, 20260130);
    expect(filterCanonicalSchemaToScope(legacyBroad, current.scope)).toBe(current.canonicalSchema);
    conn.run(
      `UPDATE ${SCHEMA_FINGERPRINT_TABLE} SET fingerprint = ?1, canonical_schema = ?2 WHERE database_id = ?3 AND schema_version = ?4`,
      [hashCanonicalSchema(legacyBroad), legacyBroad, 'mistakes', 20260130],
    );
    fp(conn, c, 'mistakes', c.sets.mistakes, 20260130, false);
  });
});

// ------------------------------------------------------------------ checksum 对齐 / 兼容边界

describe('coordinator.rs refinery history reconciliation', () => {
  const llmHistory = (dir: string, name: string, checksum: string) => {
    const conn = open(path.join(dir, 'llm_usage.db'));
    conn.exec(`CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, name TEXT, applied_on TEXT, checksum TEXT);
            INSERT INTO refinery_schema_history VALUES (20260130, '${name}', '2026-01-30T00:00:00Z', '${checksum}');`);
    return conn;
  };

  it('test_unknown_checksum_drift_fails_close', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = llmHistory(dir, 'init', 'unknown-tampered-checksum');
    try {
      priv(c).repairRefineryChecksums(conn, 'llm_usage', c.createRunner('llm_usage'));
      expect.unreachable();
    } catch (error) {
      const d = (error as MigrationError).detail;
      expect(d.kind).toBe('ChecksumMismatch');
      if (d.kind === 'ChecksumMismatch') {
        expect(d.version).toBe(20260130);
        expect(d.actual).toBe('unknown-tampered-checksum');
      }
    }
    expect(conn.pluck('SELECT checksum FROM refinery_schema_history WHERE version = 20260130')).toBe('unknown-tampered-checksum');
  });

  it('test_migration_name_conflict_fails_close', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = llmHistory(dir, 'someone_elses_migration', 'not-zero');
    expect(() => priv(c).repairRefineryChecksums(conn, 'llm_usage', c.createRunner('llm_usage'))).toThrow(/名称不匹配/);
  });

  it('test_baseline_zero_checksum_is_aligned_to_real_checksum', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = llmHistory(dir, 'init', '0');
    const runner = c.createRunner('llm_usage');
    priv(c).repairRefineryChecksums(conn, 'llm_usage', runner);
    const expected = runner.getMigrations().find((m) => m.version === 20260130)!.checksum.toString();
    expect(conn.pluck('SELECT checksum FROM refinery_schema_history WHERE version = 20260130')).toBe(expected);
  });

  it('test_startup_compat_replay_respects_version_boundary', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'probe.db'));
    conn.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, smuggled TEXT);');
    const futureVersion = 20260801 + 1;
    const runner = new Runner([Migration.unapplied(`V${futureVersion}__future_alter`, 'ALTER TABLE probe ADD COLUMN smuggled TEXT;')]);
    priv(c).makeAlterColumnsSafe(helpers(conn), runner);
    expect(isRecorded(conn, futureVersion)).toBe(false);
  });

  it('test_mistakes_recorded_v20260523_document_tasks_gap_is_repaired_and_rebaselined (full coordinator path)', async () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'mistakes.db'));
    for (const f of [
      'V20260130__init.sql',
      'V20260131__add_change_log.sql',
      'V20260201__add_sync_fields.sql',
      'V20260207__add_template_preview_data.sql',
      'V20260208__add_hot_query_indexes.sql',
      'V20260209__anki_card_dedup_unique.sql',
      'V20260524__add_change_log_field_deltas.sql',
    ]) {
      conn.exec(readSql(`mistakes/${f}`));
    }
    conn.run(HISTORY_DDL);
    for (const [v, n] of [
      [20260130, 'init'],
      [20260131, 'add_change_log'],
      [20260201, 'add_sync_fields'],
      [20260207, 'add_template_preview_data'],
      [20260208, 'add_hot_query_indexes'],
      [20260209, 'anki_card_dedup_unique'],
      [20260523, 'add_missing_sync_coverage'],
      [20260524, 'add_change_log_field_deltas'],
    ] as const) {
      markMistakesVersion(conn, v, n);
    }
    fp(conn, c, 'mistakes', c.sets.mistakes, 20260524, false);
    conn.run('CREATE TABLE IF NOT EXISTS runtime_documents (id TEXT PRIMARY KEY, body TEXT)');
    const { repairRecordedMigrationSchemaGaps } = await import('../migration/repairs.ts');
    const repaired = repairRecordedMigrationSchemaGaps({
      h: helpers(conn),
      id: 'mistakes',
      runner: c.createRunner('mistakes'),
      set: c.sets.mistakes,
      migrationsDir: DIR,
    });
    expect(repaired).toBe(true);
    priv(c).verifyMigrations(conn, 'mistakes', c.sets.mistakes, 20260524, 0, repaired);
    for (const column of ['device_id', 'local_version', 'deleted_at']) {
      expect(conn.pluck("SELECT EXISTS(SELECT 1 FROM pragma_table_info('document_tasks') WHERE name=?1)", [column])).toBe(1);
    }
    expect(helpers(conn).indexExists('idx_document_tasks_device_version')).toBe(true);
    expect(helpers(conn).triggerExists('trg__change_log_document_tasks_insert')).toBe(true);
    priv(c).verifyMigrations(conn, 'mistakes', c.sets.mistakes, 20260524, 0, false);
    conn.run('ALTER TABLE anki_cards ADD COLUMN external_drift_marker TEXT');
    expectVerificationFailed(() => priv(c).verifyMigrations(conn, 'mistakes', c.sets.mistakes, 20260524, 0, false), 'Schema fingerprint drift detected');
  });
});

// ------------------------------------------------------------------ migrate_single 回归

const PARTIAL_LEGACY_MISTAKES = `
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
            );
            CREATE TABLE anki_cards (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                front TEXT NOT NULL,
                back TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT '',
                source_id TEXT NOT NULL DEFAULT '',
                card_order_in_task INTEGER DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                template_id TEXT,
                text TEXT
            );`;

describe('coordinator.rs migrate_single regressions', () => {
  it('test_migrate_single_mistakes_recovers_partial_legacy_database', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'mistakes.db'));
    conn.exec(`${PARTIAL_LEGACY_MISTAKES}
            CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, mistake_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, stable_id TEXT);
            CREATE TABLE review_chat_messages (id INTEGER PRIMARY KEY, review_analysis_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL);`);
    close(conn);
    const report = c.migrateSingle('mistakes');
    expect(report.success).toBe(true);
    expect(report.toVersion).toBe(latest(c, 'mistakes'));
    const v = open(path.join(dir, 'mistakes.db'));
    expect(v.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_sessions')")).toBe(1);
    expect(v.pluck("SELECT EXISTS(SELECT 1 FROM pragma_table_info('anki_cards') WHERE name='text')")).toBe(1);
  });

  it('test_migrate_single_mistakes_reentrant_after_recovery', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'mistakes.db'));
    conn.exec(PARTIAL_LEGACY_MISTAKES);
    close(conn);
    const first = c.migrateSingle('mistakes');
    const second = c.migrateSingle('mistakes');
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.appliedCount).toBe(0);
    expect(second.toVersion).toBe(latest(c, 'mistakes'));
  });

  it('test_reproduce_llm_usage_v20260202_failure', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'llm_usage.db'));
    for (const f of ['V20260130__init.sql', 'V20260131__add_change_log.sql', 'V20260201__add_sync_fields.sql']) conn.exec(readSql(`llm_usage/${f}`));
    conn.run(HISTORY_DDL);
    conn.run("INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260130, 'init', '2026-01-30T00:00:00Z', '0')");
    conn.run("INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260131, 'add_change_log', '2026-01-31T00:00:00Z', '0')");
    conn.run("INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (20260201, 'add_sync_fields', '2026-02-01T00:00:00Z', '0')");
    close(conn);
    expect(c.migrateSingle('llm_usage').toVersion).toBe(latest(c, 'llm_usage'));
  });

  it('test_reproduce_mistakes_v20260208_v20260209_failure', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const conn = open(path.join(dir, 'mistakes.db'));
    for (const f of ['V20260130__init.sql', 'V20260131__add_change_log.sql', 'V20260201__add_sync_fields.sql', 'V20260207__add_template_preview_data.sql']) {
      conn.exec(readSql(`mistakes/${f}`));
    }
    conn.run(HISTORY_DDL);
    for (const [v, n] of [
      [20260130, 'init'],
      [20260131, 'add_change_log'],
      [20260201, 'add_sync_fields'],
      [20260207, 'add_template_preview_data'],
    ] as const) {
      conn.run("INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?1, ?2, '2026-02-07T00:00:00Z', '0')", [v, n]);
    }
    close(conn);
    expect(c.migrateSingle('mistakes').toVersion).toBe(latest(c, 'mistakes'));
  });

  /** `build_mistakes_before_mastery_outbox`。 */
  function buildMistakesBeforeMasteryOutbox(c: MigrationCoordinator): Connection {
    buildDbAtVersion(c, 'mistakes', 20260715);
    const conn = open(c.getDatabasePath('mistakes'));
    conn.run(`INSERT INTO document_tasks (id, document_id, original_document_name, segment_index, content_segment, status, anki_generation_options_json)
             VALUES ('task-1', 'doc-1', 'doc.md', 0, 'seg', 'Completed', '{}')`);
    conn.run(`INSERT INTO anki_cards (id, task_id, front, back, created_at, updated_at)
             VALUES ('card-1', 'task-1', 'f', 'b', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`);
    conn.run(`INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, created_at, updated_at)
             VALUES ('state-1', 'card-1', 0, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`);
    conn.run(`INSERT INTO fsrs_review_logs (id, card_state_id, anki_card_id, rating, state_before, state_after, review_ms, fsrs_params_version, created_at, updated_at)
             VALUES ('log-1', 'state-1', 'card-1', 3, 0, 1, 1751328000000, 'rs-fsrs-1.2', '2026-07-01T00:00:00Z', NULL)`);
    return conn;
  }

  it('test_make_alter_columns_safe_replays_backfill_when_all_columns_exist', () => {
    const { coordinator: c } = createTestCoordinator();
    const conn = buildMistakesBeforeMasteryOutbox(c);
    conn.exec(`ALTER TABLE fsrs_review_logs ADD COLUMN mastery_synced_at TEXT;
             ALTER TABLE fsrs_review_logs ADD COLUMN mastery_revert_pending INTEGER NOT NULL DEFAULT 0;`);
    expect(conn.pluck("SELECT mastery_synced_at FROM fsrs_review_logs WHERE id = 'log-1'")).toBeNull();
    priv(c).makeAlterColumnsSafe(helpers(conn), c.createRunner('mistakes'));
    expect(isRecorded(conn, 20260720)).toBe(true);
    expect(conn.pluck("SELECT mastery_synced_at FROM fsrs_review_logs WHERE id = 'log-1'")).toBe('2026-07-01T00:00:00Z');
    expect(helpers(conn).indexExists('idx_fsrs_review_logs_mastery_pending')).toBe(true);
  });

  it('test_make_alter_columns_safe_completes_partial_columns_and_backfills', () => {
    const { coordinator: c } = createTestCoordinator();
    const conn = buildMistakesBeforeMasteryOutbox(c);
    conn.run('ALTER TABLE fsrs_review_logs ADD COLUMN mastery_synced_at TEXT');
    priv(c).makeAlterColumnsSafe(helpers(conn), c.createRunner('mistakes'));
    expect(isRecorded(conn, 20260720)).toBe(true);
    expect(conn.pluck("SELECT mastery_revert_pending FROM fsrs_review_logs WHERE id = 'log-1'")).toBe(0);
    expect(conn.pluck("SELECT mastery_synced_at FROM fsrs_review_logs WHERE id = 'log-1'")).toBe('2026-07-01T00:00:00Z');
    expect(helpers(conn).indexExists('idx_fsrs_review_logs_mastery_pending')).toBe(true);
  });

  it('test_migrate_single_recovers_alter_residue_without_skipping_backfill', () => {
    const { coordinator: c } = createTestCoordinator();
    const conn = buildMistakesBeforeMasteryOutbox(c);
    conn.exec(`ALTER TABLE fsrs_review_logs ADD COLUMN mastery_synced_at TEXT;
             ALTER TABLE fsrs_review_logs ADD COLUMN mastery_revert_pending INTEGER NOT NULL DEFAULT 0;`);
    close(conn);
    const report = c.migrateSingle('mistakes');
    expect(report.success).toBe(true);
    expect(report.toVersion).toBe(latest(c, 'mistakes'));
    const after = open(c.getDatabasePath('mistakes'));
    expect(after.pluck("SELECT mastery_synced_at FROM fsrs_review_logs WHERE id = 'log-1'")).toBe('2026-07-01T00:00:00Z');
    close(after);
    const second = c.migrateSingle('mistakes');
    expect(second.success).toBe(true);
    expect(second.appliedCount).toBe(0);
  });

  it('test_llm_usage_v20260824_recovers_column_without_history_and_reruns', () => {
    const { coordinator: c } = createTestCoordinator();
    buildDbAtVersion(c, 'llm_usage', 20260525);
    const dbPath = c.getDatabasePath('llm_usage');
    const conn = open(dbPath);
    conn.run(`INSERT INTO llm_usage_logs (id, timestamp, provider, model, caller_type, prompt_tokens, completion_tokens, total_tokens)
             VALUES ('usage-v0944', '2026-08-09T00:00:00Z', 'openai', 'gpt-4o', 'chat_v2', 10, 5, 15)`);
    conn.exec(readSql('llm_usage/V20260824__add_cache_write_tokens.sql'));
    expect(isRecorded(conn, 20260824)).toBe(false);
    close(conn);
    const report = c.migrateSingle('llm_usage');
    expect(report.success).toBe(true);
    expect(report.toVersion).toBe(latest(c, 'llm_usage'));
    const after = open(dbPath);
    expect(after.pluck('SELECT COUNT(*) FROM refinery_schema_history WHERE version = 20260824')).toBe(1);
    expect(after.pluck("SELECT cache_write_tokens FROM llm_usage_logs WHERE id = 'usage-v0944'")).toBeNull();
    after.run(`INSERT INTO llm_usage_logs (id, timestamp, provider, model, caller_type, prompt_tokens, completion_tokens, total_tokens, cache_write_tokens)
             VALUES ('usage-zero', '2026-08-25T00:00:00Z', 'anthropic', 'claude', 'chat_v2', 10, 5, 15, 0)`);
    expect(after.pluck("SELECT cache_write_tokens FROM llm_usage_logs WHERE id = 'usage-zero'")).toBe(0);
    close(after);
    const rerun = c.migrateSingle('llm_usage');
    expect(rerun.success).toBe(true);
    expect(rerun.appliedCount).toBe(0);
  });

  it('test_migration_fails_cleanly_when_database_write_locked_then_retries', () => {
    const { coordinator: c } = createTestCoordinator();
    buildDbAtVersion(c, 'mistakes', secondLatest(c.sets.mistakes));
    const probe = open(c.getDatabasePath('mistakes'));
    const oldVersion = c.getCurrentVersion(probe);
    close(probe);
    const locker = new Connection(c.getDatabasePath('mistakes'), { label: 'locker', profile: { busyTimeoutMs: 0 } });
    locker.exec('BEGIN IMMEDIATE');
    expect(() => c.migrateSingle('mistakes')).toThrow();
    locker.exec('ROLLBACK');
    locker.close();
    const check = open(c.getDatabasePath('mistakes'));
    expect(c.getCurrentVersion(check)).toBe(oldVersion);
    close(check);
    const report = c.migrateSingle('mistakes');
    expect(report.success).toBe(true);
    expect(report.toVersion).toBe(latest(c, 'mistakes'));
  }, 60_000);

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('test_migration_fails_cleanly_on_readonly_database_then_retries', () => {
    const { coordinator: c } = createTestCoordinator();
    buildDbAtVersion(c, 'llm_usage', secondLatest(c.sets.llm_usage));
    const dbPath = c.getDatabasePath('llm_usage');
    const conn = open(dbPath);
    expect(String(conn.pluck('PRAGMA journal_mode=DELETE')).toLowerCase()).toBe('delete');
    close(conn);
    fs.chmodSync(dbPath, 0o444);
    expect(() => c.migrateSingle('llm_usage')).toThrow();
    fs.chmodSync(dbPath, 0o644);
    const check = open(dbPath);
    expect(check.pluck('PRAGMA quick_check')).toBe('ok');
    close(check);
    const report = c.migrateSingle('llm_usage');
    expect(report.success).toBe(true);
    expect(report.toVersion).toBe(latest(c, 'llm_usage'));
  });
});

// ------------------------------------------------------------------ 故障注入与恢复

describe('coordinator.rs failpoint fault injection & recovery', () => {
  const cases: Array<[string, CoordinatedDatabaseName | undefined]> = [
    ['after_core_backup', undefined],
    ['before_db_migration::llm_usage', 'llm_usage'],
    ['before_db_migration::chat_v2', 'chat_v2'],
    ['after_db_migration::chat_v2', 'chat_v2'],
    ['after_db_migration::mistakes', 'mistakes'],
    ['after_verification::mistakes', 'mistakes'],
  ];
  for (const [point, failed] of cases) {
    it(`test_failpoint_injection_keeps_core_state_atomic_and_retry_succeeds [${point}]`, async () => {
      const { coordinator: c, dir } = createTestCoordinator();
      const oldTuple = buildOldCoreState(c);
      const guard = arm(dir, point, 1);
      let report: CoreMigrationReport | undefined;
      let runError: unknown;
      try {
        report = await c.runAll();
      } catch (error) {
        runError = error;
      }
      expect(guard.hits()).toBe(1);
      if (failed !== undefined) {
        expect(runError).toBeUndefined();
        expect(report!.success).toBe(false);
        expect(report!.componentHealth.isBlocked(failed)).toBe(true);
        const failedReport = report!.databases.find((d) => d.id === failed)!;
        expect(failedReport.success).toBe(false);
        expect(failedReport.error).toContain('[failpoint]');
        for (const entry of report!.databases) if (entry.id !== failed) expect(entry.success, `[${point}] ${entry.id}`).toBe(true);
        for (const [id, version] of coreVersionTuple(c)) {
          const old = oldTuple.find(([o]) => o === id)![1];
          if (id === failed) expect(version).toBe(old);
          else expect(version).toBeGreaterThanOrEqual(latest(c, id));
        }
      } else {
        expect(String((runError as Error).message)).toContain('[failpoint]');
        expect(coreVersionTuple(c)).toEqual(oldTuple);
      }
      assertMarkersIntact(c, point);
      guard.disarm();
      const retry = await c.runAll();
      expect(retry.success).toBe(true);
      for (const [id, version] of coreVersionTuple(c)) expect(version).toBeGreaterThanOrEqual(latest(c, id));
      expect(newSchemaSentinels(c)).toEqual([true, true, true]);
      assertMarkersIntact(c, `${point}(retry)`);
    }, 60_000);
  }

  it('test_vfs_failure_blocks_dependency_closure_but_not_llm_usage', async () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const oldTuple = buildOldCoreState(c);
    const guard = arm(dir, 'before_db_migration::vfs', 1);
    const report = await c.runAll();
    expect(guard.hits()).toBe(1);
    expect(report.success).toBe(false);
    for (const b of ['vfs', 'chat_v2', 'mistakes']) expect(report.componentHealth.isBlocked(b)).toBe(true);
    expect(report.componentHealth.isBlocked('llm_usage')).toBe(false);
    for (const dependent of ['chat_v2', 'mistakes']) {
      expect(report.componentHealth.issues().find((i) => i.component === dependent)!.dependency).toBe('vfs');
    }
    const current = coreVersionTuple(c);
    expect(current.find(([id]) => id === 'llm_usage')![1]).toBe(latest(c, 'llm_usage'));
    for (const blocked of ['vfs', 'chat_v2', 'mistakes'] as const) {
      expect(current.find(([id]) => id === blocked)![1]).toBe(oldTuple.find(([id]) => id === blocked)![1]);
    }
    guard.disarm();
  }, 60_000);

  it('test_chat_failure_isolated_from_mistakes_and_llm_usage', async () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const oldTuple = buildOldCoreState(c);
    const guard = arm(dir, 'before_db_migration::chat_v2', 1);
    const report = await c.runAll();
    expect(guard.hits()).toBe(1);
    expect(report.componentHealth.blockedComponents()).toEqual(['chat_v2']);
    const current = coreVersionTuple(c);
    for (const independent of ['llm_usage', 'mistakes'] as const) {
      expect(current.find(([id]) => id === independent)![1]).toBeGreaterThanOrEqual(latest(c, independent));
    }
    expect(current.find(([id]) => id === 'chat_v2')![1]).toBe(oldTuple.find(([id]) => id === 'chat_v2')![1]);
    guard.disarm();
  }, 60_000);

  it('test_failpoint_before_restore_leaves_untouched_state_consistent', async () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const oldTuple = buildOldCoreState(c);
    const migrationGuard = arm(dir, 'before_db_migration::vfs', 1);
    const restoreGuard = arm(dir, 'before_restore', 1);
    const report = await c.runAll();
    expect(migrationGuard.hits()).toBe(1);
    expect(restoreGuard.hits()).toBe(1);
    expect(report.success).toBe(false);
    expect(report.componentHealth.isBlocked('vfs')).toBe(true);
    const reason = report.componentHealth.issues().find((i) => i.component === 'vfs')!.reason!;
    expect(reason).toContain('migration failed');
    expect(reason).toContain('also failed');
    const current = coreVersionTuple(c);
    expect(current[0]).toEqual(oldTuple[0]);
    expect(current[1]![1]).toBe(latest(c, 'llm_usage'));
    expect(fs.statSync(c.backups.restoreFailureJournalPath()).isFile()).toBe(true);
    assertMarkersIntact(c, 'before_restore');
    migrationGuard.disarm();
    restoreGuard.disarm();
    const restarted = new MigrationCoordinator({ appDataDir: dir, log: quiet, failpoint: failpointHook(dir) });
    const retry = await restarted.runAll();
    expect(retry.success).toBe(true);
    expect(fs.existsSync(restarted.backups.restoreFailureJournalPath())).toBe(false);
    expect(newSchemaSentinels(restarted)).toEqual([true, true, true]);
    assertMarkersIntact(restarted, 'before_restore(retry)');
  }, 60_000);

  it('test_failpoint_after_restore_disk_recovered_despite_reported_failure', async () => {
    const { coordinator: c, dir } = createTestCoordinator();
    const oldTuple = buildOldCoreState(c);
    const migrationGuard = arm(dir, 'before_db_migration::chat_v2', 1);
    const restoreGuard = arm(dir, 'after_restore', 1);
    const report = await c.runAll();
    expect(migrationGuard.hits()).toBe(1);
    expect(restoreGuard.hits()).toBe(1);
    expect(report.success).toBe(false);
    expect(report.componentHealth.isBlocked('chat_v2')).toBe(true);
    const current = coreVersionTuple(c);
    expect(current.find(([id]) => id === 'chat_v2')![1]).toBe(oldTuple.find(([id]) => id === 'chat_v2')![1]);
    for (const independent of ['llm_usage', 'mistakes'] as const) {
      expect(current.find(([id]) => id === independent)![1]).toBe(latest(c, independent));
    }
    assertMarkersIntact(c, 'after_restore');
    migrationGuard.disarm();
    restoreGuard.disarm();
    const retry = await c.runAll();
    expect(retry.success).toBe(true);
    expect(newSchemaSentinels(c)).toEqual([true, true, true]);
  }, 60_000);

  it('test_failpoint_unarmed_is_noop_and_guard_disarms_on_drop', () => {
    const { coordinator: c, dir } = createTestCoordinator();
    expect(() => priv(c).failpoint('never_armed')).not.toThrow();
    const guard = arm(dir, 'scoped_point', 1);
    expect(() => priv(c).failpoint('scoped_point')).toThrow(MigrationError);
    guard.disarm();
    expect(() => priv(c).failpoint('scoped_point')).not.toThrow();
    const other = tempDir();
    const otherGuard = arm(other, 'scoped_point', 1);
    expect(() => priv(c).failpoint('scoped_point')).not.toThrow();
    otherGuard.disarm();
  });
});
