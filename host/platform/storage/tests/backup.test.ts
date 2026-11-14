import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoordinatedDatabaseName } from '../api.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import {
  AUDIT_CREATE_TABLE_SQL,
  logChecksumRepairAudit,
  logMigrationAudit,
  logMigrationFailure,
} from '../migration/audit-log.ts';
import {
  ALL_ORDERED,
  CoreBackupManager,
  currentVersionOf,
  forgetStartupBackupGuard,
  StartupComponentHealth,
} from '../migration/backup.ts';
import { MigrationError } from '../migration/errors.ts';
import { loadSqlMigrations } from '../migration/refinery.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, '../../../../resources/app/migrations');
const LATEST: Record<CoordinatedDatabaseName, number> = Object.fromEntries(
  (['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const).map((db) => {
    const list = loadSqlMigrations(path.join(MIGRATIONS, db));
    return [db, list[list.length - 1]!.version];
  }),
) as Record<CoordinatedDatabaseName, number>;
const VERSIONS: Record<CoordinatedDatabaseName, number[]> = Object.fromEntries(
  (['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const).map((db) => [db, loadSqlMigrations(path.join(MIGRATIONS, db)).map((m) => m.version)]),
) as Record<CoordinatedDatabaseName, number[]>;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const noLog = () => undefined;

function dbPath(dir: string, id: CoordinatedDatabaseName): string {
  return id === 'vfs' ? path.join(dir, 'databases', 'vfs.db') : path.join(dir, `${id}.db`);
}

/** = Rust `pending_migrations_count`（迁移集合版本取自迁移文件，与 MigrationSet 一致）。 */
function pendingCount(dir: string): number {
  let total = 0;
  for (const id of ALL_ORDERED) {
    const file = dbPath(dir, id);
    let current = 0;
    if (fs.existsSync(file)) {
      const conn = new Connection(file, { label: id, profile: PROFILES.plain });
      try {
        current = currentVersionOf(conn);
      } finally {
        conn.close();
      }
    }
    total += VERSIONS[id].filter((v) => v > current).length;
  }
  return total;
}

function createTestCoordinator(): { manager: CoreBackupManager; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-backup-'));
  temps.push(dir);
  const manager = new CoreBackupManager({
    appDataDir: dir,
    databasePath: (id) => dbPath(dir, id),
    pendingMigrationsCount: () => pendingCount(dir),
    log: noLog,
  });
  return { manager, dir };
}

function createTestSqliteDb(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new BetterSqlite3(file);
  db.exec('CREATE TABLE IF NOT EXISTS test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  db.exec("INSERT INTO test_data (value) VALUES ('ok')");
  db.close();
}

function markLatestVersion(file: string, version: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new BetterSqlite3(file);
  db.exec(`CREATE TABLE IF NOT EXISTS refinery_schema_history (
                version INTEGER PRIMARY KEY,
                name TEXT,
                applied_on TEXT,
                checksum TEXT
            )`);
  db.prepare(
    "INSERT OR REPLACE INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (?, 'latest', '2026-02-11T00:00:00Z', 'x')",
  ).run(version);
  db.close();
}

function count(file: string, sql: string, ...params: unknown[]): number {
  const db = new BetterSqlite3(file);
  try {
    return db.prepare(sql).pluck().get(...params) as number;
  } finally {
    db.close();
  }
}

function createAllCore(dir: string): void {
  for (const id of ALL_ORDERED) createTestSqliteDb(dbPath(dir, id));
}

describe('coordinator.rs core backup', () => {
  it('test_core_backup_creates_snapshot_for_four_core_dbs', async () => {
    const { manager, dir } = createTestCoordinator();
    createAllCore(dir);
    await manager.backupCoreDatabasesOncePerStartup();
    const snapshots = fs.readdirSync(manager.coreBackupRootDir());
    expect(snapshots).toHaveLength(1);
    const snap = path.join(manager.coreBackupRootDir(), snapshots[0]!);
    expect(snapshots[0]).toMatch(/^startup_\d{8}T\d{6}\.\d{3}Z_\d+$/);
    for (const rel of ['databases/vfs.db', 'chat_v2.db', 'mistakes.db', 'llm_usage.db']) {
      expect(fs.existsSync(path.join(snap, rel))).toBe(true);
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(snap, 'metadata.json'), 'utf8'));
    expect(Object.keys(metadata)).toEqual(['created_at', 'source_dir', 'copied_files', 'schema_versions', 'purpose']);
    expect(metadata.copied_files).toEqual(['databases/vfs.db', 'chat_v2.db', 'mistakes.db', 'llm_usage.db']);
    expect(metadata.schema_versions).toEqual({ vfs: 0, chat_v2: 0, mistakes: 0, llm_usage: 0 });
    expect(metadata.created_at).toMatch(/\+00:00$/);
  });

  it('test_core_backup_only_once_in_same_process_for_same_data_dir', async () => {
    const { manager, dir } = createTestCoordinator();
    createAllCore(dir);
    await manager.backupCoreDatabasesOncePerStartup();
    await manager.backupCoreDatabasesOncePerStartup();
    expect(fs.readdirSync(manager.coreBackupRootDir())).toHaveLength(1);
  });

  it('test_core_backup_skips_when_no_pending_migrations', async () => {
    const { manager, dir } = createTestCoordinator();
    for (const id of ALL_ORDERED) markLatestVersion(dbPath(dir, id), LATEST[id]);
    forgetStartupBackupGuard(manager.startupGuardKey());
    await manager.maybeBackupCoreDatabasesBeforeMigration();
    expect(fs.existsSync(manager.coreBackupRootDir())).toBe(false);
  });

  it('test_core_backup_preflight_isolates_unreadable_database', async () => {
    const { manager, dir } = createTestCoordinator();
    fs.mkdirSync(path.join(dir, 'databases'), { recursive: true });
    fs.writeFileSync(dbPath(dir, 'vfs'), 'not a sqlite database');
    markLatestVersion(dbPath(dir, 'chat_v2'), LATEST.chat_v2);
    markLatestVersion(dbPath(dir, 'mistakes'), LATEST.mistakes);
    markLatestVersion(dbPath(dir, 'llm_usage'), LATEST.llm_usage);
    await manager.maybeBackupCoreDatabasesBeforeMigration();
    expect(fs.existsSync(manager.coreBackupRootDir())).toBe(false);
  });

  it('prune_old_core_backups keeps the newest five snapshots', async () => {
    const { manager } = createTestCoordinator();
    const root = manager.coreBackupRootDir();
    for (let i = 1; i <= 7; i++) fs.mkdirSync(path.join(root, `startup_2026010${i}T000000.000Z_1`), { recursive: true });
    manager.pruneOldCoreBackups();
    expect(fs.readdirSync(root).sort()).toEqual([3, 4, 5, 6, 7].map((i) => `startup_2026010${i}T000000.000Z_1`));
  });
});

describe('coordinator.rs core restore', () => {
  it('test_restore_without_snapshot_errors_explicitly', async () => {
    const { manager } = createTestCoordinator();
    await expect(manager.restoreFromLatestCoreBackup()).rejects.toThrow('无迁移前快照');
  });

  it('test_restore_overwrites_tampered_data_and_cleans_stale_wal_files', async () => {
    const { manager, dir } = createTestCoordinator();
    createAllCore(dir);
    await manager.backupCoreDatabasesOncePerStartup();
    const chat = dbPath(dir, 'chat_v2');
    const db = new BetterSqlite3(chat);
    db.exec("INSERT INTO test_data (value) VALUES ('tampered')");
    db.close();
    const wal = path.join(dir, 'chat_v2.db-wal');
    const shm = path.join(dir, 'chat_v2.db-shm');
    fs.writeFileSync(wal, 'stale-wal-garbage');
    fs.writeFileSync(shm, 'stale-shm-garbage');

    expect(await manager.restoreFromLatestCoreBackup()).toBe(4);
    expect(fs.existsSync(wal)).toBe(false);
    expect(fs.existsSync(shm)).toBe(false);
    expect(count(chat, "SELECT COUNT(*) FROM test_data WHERE value = 'tampered'")).toBe(0);
    expect(count(chat, "SELECT COUNT(*) FROM test_data WHERE value = 'ok'")).toBe(1);
    const check = new BetterSqlite3(chat);
    expect(check.pragma('quick_check', { simple: true })).toBe('ok');
    check.close();
  });

  it('test_single_database_restore_does_not_rewind_unrelated_databases', async () => {
    const { manager, dir } = createTestCoordinator();
    createAllCore(dir);
    await manager.backupCoreDatabasesOncePerStartup();
    for (const id of ALL_ORDERED) {
      const db = new BetterSqlite3(dbPath(dir, id));
      db.prepare('INSERT INTO test_data (value) VALUES (?)').run(`new-${id}`);
      db.close();
    }
    await manager.restoreDatabaseFromLatestCoreBackup('chat_v2');
    for (const id of ALL_ORDERED) {
      const n = count(dbPath(dir, id), 'SELECT COUNT(*) FROM test_data WHERE value = ?', `new-${id}`);
      expect(n, id).toBe(id === 'chat_v2' ? 0 : 1);
    }
  });

  it('test_restore_picks_latest_snapshot', async () => {
    const { manager, dir } = createTestCoordinator();
    const root = manager.coreBackupRootDir();
    for (const [name, payload] of [
      ['startup_20260101T000000.000Z_1', 'old-snapshot'],
      ['startup_20260702T000000.000Z_1', 'new-snapshot'],
    ] as const) {
      const snap = path.join(root, name);
      fs.mkdirSync(snap, { recursive: true });
      const db = new BetterSqlite3(path.join(snap, 'chat_v2.db'));
      db.exec('CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      db.prepare('INSERT INTO test_data (value) VALUES (?)').run(payload);
      db.close();
      fs.writeFileSync(path.join(snap, 'metadata.json'), '{"copied_files":["chat_v2.db"]}');
    }
    expect(await manager.restoreFromLatestCoreBackup()).toBe(1);
    const db = new BetterSqlite3(path.join(dir, 'chat_v2.db'));
    expect(db.prepare('SELECT value FROM test_data LIMIT 1').pluck().get()).toBe('new-snapshot');
    db.close();
  });

  it('single-database restore removes a database absent from the snapshot', async () => {
    const { manager, dir } = createTestCoordinator();
    createTestSqliteDb(dbPath(dir, 'vfs'));
    await manager.backupCoreDatabasesOncePerStartup();
    createTestSqliteDb(dbPath(dir, 'chat_v2'));
    await manager.restoreDatabaseFromLatestCoreBackup('chat_v2');
    expect(fs.existsSync(dbPath(dir, 'chat_v2'))).toBe(false);
  });
});

describe('coordinator.rs restore failure journal', () => {
  it('records failures in the Rust serde shape and retries them before migrating', async () => {
    const { manager, dir } = createTestCoordinator();
    manager.recordRestoreFailure('chat_v2', 'boom', 'restore boom');
    const file = manager.restoreFailureJournalPath();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(parsed.failures[0])).toEqual(['database', 'migration_error', 'restore_error', 'failed_at']);
    expect(parsed.failures[0].database).toBe('ChatV2');
    manager.recordRestoreFailure('chat_v2', 'boom2', 'restore boom2');
    expect(manager.loadRestoreFailureJournal()).toHaveLength(1);

    // 没有快照 → 重试仍失败 → 阻断报告（chat_v2 blocked，依赖它的无）
    const report = await manager.retryPersistedRestoreFailures(Date.now());
    expect(report).toBeDefined();
    expect(report!.success).toBe(false);
    expect(report!.databases.map((d) => d.id)).toEqual(['chat_v2']);
    expect(report!.componentHealth.isBlocked('chat_v2')).toBe(true);
    expect(report!.error).toBe('One or more databases could not be restored from the trusted startup snapshot');

    // 有快照后重试成功 → journal 清空
    createAllCore(dir);
    await manager.backupCoreDatabasesOncePerStartup();
    expect(await manager.retryPersistedRestoreFailures(Date.now())).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('vfs restore failure blocks dependents in the retry report', async () => {
    const { manager } = createTestCoordinator();
    manager.recordRestoreFailure('vfs', 'boom', 'restore boom');
    const report = await manager.retryPersistedRestoreFailures(Date.now());
    expect(report!.databases.map((d) => [d.id, d.error])).toEqual([
      ['vfs', expect.stringContaining("Database 'vfs' remains blocked")],
      ['chat_v2', "Skipped because dependency 'vfs' has an unresolved restore failure"],
      ['mistakes', "Skipped because dependency 'vfs' has an unresolved restore failure"],
    ]);
  });

  it('corrupt journal fails closed', () => {
    const { manager } = createTestCoordinator();
    fs.mkdirSync(manager.coreBackupRootDir(), { recursive: true });
    fs.writeFileSync(manager.restoreFailureJournalPath(), '{not json');
    expect(() => manager.loadRestoreFailureJournal()).toThrow('单库恢复故障记录已损坏');
  });
});

describe('preflight_disk_space_check', () => {
  it('passes on a normal temp dir', () => {
    const { manager, dir } = createTestCoordinator();
    createAllCore(dir);
    expect(() => manager.preflightDiskSpaceCheck()).not.toThrow();
  });

  function managerWithDiskSpace(availableDiskSpace: (target: string) => number): { manager: CoreBackupManager; dir: string; probed: string[] } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-backup-'));
    temps.push(dir);
    const probed: string[] = [];
    const manager = new CoreBackupManager({
      appDataDir: dir,
      databasePath: (id) => dbPath(dir, id),
      pendingMigrationsCount: () => pendingCount(dir),
      log: noLog,
      availableDiskSpace: (target) => { probed.push(target); return availableDiskSpace(target); },
    });
    return { manager, dir, probed };
  }

  it('lets the migration run when backup_common cannot determine the free space (Rust unwrap_or(u64::MAX))', () => {
    const { manager, dir, probed } = managerWithDiskSpace(() => { throw new Error('无法获取磁盘可用空间。'); });
    createAllCore(dir);
    expect(() => manager.preflightDiskSpaceCheck()).not.toThrow();
    expect(probed).toEqual([dir]);
  });

  it('rejects with InsufficientDiskSpace below twice the database size plus 50MB', () => {
    const { manager, dir } = managerWithDiskSpace(() => 10 * 1024 * 1024);
    createAllCore(dir);
    let total = 0;
    for (const id of ALL_ORDERED) total += fs.statSync(dbPath(dir, id)).size;
    let caught: unknown;
    try { manager.preflightDiskSpaceCheck(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).detail).toEqual({
      kind: 'InsufficientDiskSpace',
      availableMb: 10,
      requiredMb: Math.floor((total * 2 + 50 * 1024 * 1024) / (1024 * 1024)),
    });
  });
});

describe('StartupComponentHealth (startup_health.rs)', () => {
  it('dependency closure blocks chat_v2 and mistakes when vfs is blocked', () => {
    const h = new StartupComponentHealth();
    h.markBlocked('vfs', 'x');
    h.applyDatabaseDependencyClosure();
    expect(h.blockedComponents()).toEqual(['vfs', 'mistakes', 'chat_v2']);
    expect(h.requiresCoreRecovery()).toBe(true);
    expect(h.toJSON().components[1]).toEqual({
      component: 'mistakes',
      status: 'blocked',
      reason: "Skipped because dependency 'vfs' is blocked",
      dependency: 'vfs',
    });
  });
});

describe('migration audit logging (coordinator.rs + audit/mod.rs)', () => {
  it('writes complete / failure / checksum-repair rows in the Rust format', () => {
    const { dir } = createTestCoordinator();
    const audit = path.join(dir, 'databases', 'audit.db');
    fs.mkdirSync(path.dirname(audit), { recursive: true });
    logMigrationAudit(audit, noLog, 'vfs', 0, 20260130, 1, 12);
    logMigrationFailure(audit, noLog, 'chat_v2', 20260130, 'kaboom', 7);
    logChecksumRepairAudit(audit, noLog, 'vfs', ['v1: x']);
    const db = new BetterSqlite3(audit);
    const rows = db.prepare('SELECT * FROM __audit_log ORDER BY rowid').all() as Array<Record<string, unknown>>;
    db.close();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      operation_type: 'Migration',
      operation_data: '{"type":"Migration","from_version":0,"to_version":20260130,"applied_count":1}',
      target: 'vfs',
      status: 'Completed',
      duration_ms: 12,
      details: 'null',
      error_message: null,
    });
    expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]!.timestamp).toMatch(/\+00:00$/);
    expect(rows[1]).toMatchObject({
      status: 'Failed',
      duration_ms: 7,
      details: '{"database":"chat_v2","from_version":20260130,"error":"kaboom"}',
      error_message: 'kaboom',
      operation_data: '{"type":"Migration","from_version":20260130,"to_version":20260130,"applied_count":0}',
    });
    expect(rows[2]).toMatchObject({
      target: 'checksum_repair:vfs',
      status: 'Completed',
      duration_ms: 0,
      details: '{"action":"checksum_repair","database":"vfs","repairs":["v1: x"],"count":1}',
    });
  });

  it('closes the latest matching Started row instead of inserting (AuditRepository::save)', () => {
    const { dir } = createTestCoordinator();
    const audit = path.join(dir, 'audit.db');
    const db = new BetterSqlite3(audit);
    db.exec(AUDIT_CREATE_TABLE_SQL);
    db.prepare(
      "INSERT INTO __audit_log VALUES ('s1','2026-01-01T00:00:00+00:00','Migration','{}','vfs','Started',NULL,'null',NULL)",
    ).run();
    db.close();
    logMigrationAudit(audit, noLog, 'vfs', 1, 2, 1, 5);
    const check = new BetterSqlite3(audit);
    const rows = check.prepare('SELECT id, status, duration_ms FROM __audit_log').all();
    check.close();
    expect(rows).toEqual([{ id: 's1', status: 'Completed', duration_ms: 5 }]);
  });

  it('skips silently-but-logged when the audit directory is missing or not configured', () => {
    const { dir } = createTestCoordinator();
    const messages: string[] = [];
    logMigrationAudit(path.join(dir, 'missing', 'audit.db'), (_l, m) => messages.push(m), 'vfs', 0, 1, 1, 1);
    logMigrationAudit(undefined, (_l, m) => messages.push(m), 'vfs', 0, 1, 1, 1);
    expect(messages).toContain('Failed to open audit database for logging');
    expect(messages).toContain('Migration audit (no audit db configured)');
    expect(fs.existsSync(path.join(dir, 'missing'))).toBe(false);
  });
});
