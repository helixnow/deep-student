/**
 * RF-W20-restore-stale-snapshot-deletes-db：单库恢复只信任本次迁移前建立的快照（或随恢复故障记录一起
 * 保存的那个快照）。Rust `coordinator.rs:965-1069` 总是取“最新”快照：本次启动按设计没建快照时
 * （版本读不出 686-700、无待迁移 702-708、本进程已建过 1071+），最新快照来自更早的启动，
 * 缺库就删掉现有数据库（1038-1045），含库就用旧数据覆盖（1004-1008）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoordinatedDatabaseName } from '../api.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { forgetStartupBackupGuard, type CoreMigrationReport } from '../migration/backup.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';
import { MigrationError } from '../migration/errors.ts';

const quiet = () => undefined;

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await setImmediate();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-rf-w20-'));
  tempDirs.push(dir);
  return dir;
}

const failpoints = new Map<string, number>();
function arm(point: string): void {
  failpoints.set(point, 1);
}

/** 新协调器 = Rust `MigrationCoordinator::new(active_dir)`；`relaunch` 时先清进程级快照 guard，模拟下一次启动。 */
function coordinatorFor(dir: string, options: { relaunch?: boolean } = {}): MigrationCoordinator {
  const coordinator = new MigrationCoordinator({
    appDataDir: dir,
    auditDbPath: null,
    log: quiet,
    failpoint: (point) => {
      const remaining = failpoints.get(point) ?? 0;
      if (remaining > 0) {
        failpoints.set(point, remaining - 1);
        throw MigrationError.database(`[failpoint] injected deterministic failure at '${point}'`);
      }
    },
  });
  if (options.relaunch === true) forgetStartupBackupGuard(coordinator.backups.startupGuardKey());
  return coordinator;
}

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const snapshotsOf = (c: MigrationCoordinator) => fs.readdirSync(c.backups.coreBackupRootDir()).filter((n) => n.startsWith('startup_')).sort();
const reasonOf = (report: CoreMigrationReport, id: CoordinatedDatabaseName) =>
  report.componentHealth.issues().find((issue) => issue.component === id)?.reason ?? '';

function writeMarker(file: string, payload: string): void {
  const conn = new Connection(file, { label: 'marker', profile: PROFILES.plain });
  try {
    conn.run('CREATE TABLE IF NOT EXISTS __user_marker (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    conn.run("INSERT OR REPLACE INTO __user_marker (id, payload) VALUES ('m', ?1)", [payload]);
  } finally {
    conn.close();
  }
}

function readMarker(file: string): unknown {
  const conn = new Connection(file, { label: 'marker', profile: PROFILES.plain });
  try {
    return conn.pluck("SELECT payload FROM __user_marker WHERE id = 'm'");
  } finally {
    conn.close();
  }
}

/** 首次安装：没有任何库，迁移前快照的 `copied_files` 为空。 */
async function freshInstall(dir: string): Promise<{ firstRunSnapshot: string }> {
  const first = coordinatorFor(dir);
  const report = await first.runAll();
  expect(report.success, report.error ?? '').toBe(true);
  const snapshots = snapshotsOf(first);
  expect(snapshots).toHaveLength(1);
  const metadata = JSON.parse(fs.readFileSync(path.join(first.backups.coreBackupRootDir(), snapshots[0]!, 'metadata.json'), 'utf8'));
  expect(metadata.copied_files).toEqual([]);
  return { firstRunSnapshot: snapshots[0]! };
}

function corrupt(file: string): string {
  for (const side of ['-wal', '-shm']) fs.rmSync(`${file}${side}`, { force: true });
  fs.writeFileSync(file, Buffer.alloc(8192, 0x5a));
  return sha256(file);
}

describe('RF-W20 single-database restore trusts only this run\'s snapshot', () => {
  it(`RF-W20-restore-stale-snapshot-deletes-db: a corrupt vfs.db next to the first-run snapshot is kept in place and stays blocked on every later start (Rust deletes it)`, async () => {
    const dir = tempDir();
    const { firstRunSnapshot } = await freshInstall(dir);
    const vfs = coordinatorFor(dir).getDatabasePath('vfs');
    const corruptHash = corrupt(vfs);

    // Rust: 版本读不出 → 不建快照（686-700）→ 最新快照是首启那个 copied_files=[] → vfs.db 被当作“迁移前不存在”删除（1038-1045），
    // 报告却写 "Restored this database from the startup snapshot."；下一次启动迁移新建空 vfs.db，用户进入空资料库。
    const second = coordinatorFor(dir, { relaunch: true });
    const report = await second.runAll();
    expect(report.componentHealth.isBlocked('vfs')).toBe(true);
    expect(fs.existsSync(vfs), 'vfs.db must still exist').toBe(true);
    expect(sha256(vfs), 'vfs.db must not be replaced, truncated or migrated').toBe(corruptHash);
    const reason = reasonOf(report, 'vfs');
    expect(reason).toMatch(/^Database 'vfs' migration failed: Database error: file is not a database\. /);
    expect(reason).not.toContain('Restored');
    expect(reason).toContain(`the database file was kept in place at ${vfs} (not deleted or overwritten)`);
    expect(reason).toContain('No earlier snapshot contains this database.');
    // 没有可重试的恢复，不写恢复故障记录；也没有新快照。
    expect(fs.existsSync(second.backups.restoreFailureJournalPath())).toBe(false);
    expect(snapshotsOf(second)).toEqual([firstRunSnapshot]);

    const third = await coordinatorFor(dir, { relaunch: true }).runAll();
    expect(third.componentHealth.isBlocked('vfs'), 'the next start must not open an empty library').toBe(true);
    expect(sha256(vfs)).toBe(corruptHash);
  }, 120_000);

  it(`RF-W20-restore-stale-snapshot-deletes-db: a failure with no pending migrations never rolls the database back to an earlier startup's snapshot (Rust overwrites it)`, async () => {
    const dir = tempDir();
    await freshInstall(dir);
    // 上一次有待迁移项的启动留下的快照：四个库都在里面。
    const earlier = coordinatorFor(dir, { relaunch: true });
    await earlier.backups.backupCoreDatabasesOncePerStartup();
    const [earlierSnapshot] = snapshotsOf(earlier).slice(-1);
    const chat = earlier.getDatabasePath('chat_v2');
    writeMarker(chat, 'written after the earlier snapshot');

    const next = coordinatorFor(dir, { relaunch: true });
    arm('before_db_migration::chat_v2');
    const report = await next.runAll();
    expect(report.componentHealth.blockedComponents()).toEqual(['chat_v2']);
    expect(readMarker(chat), 'data written since the earlier snapshot must survive').toBe('written after the earlier snapshot');
    const reason = reasonOf(report, 'chat_v2');
    expect(reason).toMatch(/^Database 'chat_v2' migration failed: Database error: \[failpoint\] injected deterministic failure at 'before_db_migration::chat_v2'\. /);
    expect(reason).toContain(`the database file was kept in place at ${chat} (not deleted or overwritten)`);
    expect(reason).toContain(`The newest earlier snapshot containing it, migration_core_backups/${earlierSnapshot}, was not applied automatically.`);
  }, 120_000);

  it(`RF-W20-restore-stale-snapshot-deletes-db: the WAL and SHM of a database without a trusted snapshot are left alone`, async () => {
    const dir = tempDir();
    const earlier = coordinatorFor(dir);
    await earlier.backups.backupCoreDatabasesOncePerStartup();
    const vfs = earlier.getDatabasePath('vfs');
    fs.mkdirSync(path.dirname(vfs), { recursive: true });
    writeMarker(vfs, 'live');
    const before = sha256(vfs);
    fs.writeFileSync(`${vfs}-wal`, 'committed-wal-frames');
    fs.writeFileSync(`${vfs}-shm`, 'shm');

    const later = coordinatorFor(dir);
    const outcome = await later.backups.restoreDatabaseFromLatestCoreBackup('vfs');
    expect(outcome).toEqual({ kind: 'untouched', path: vfs, olderSnapshot: null });
    expect(fs.readFileSync(`${vfs}-wal`, 'utf8')).toBe('committed-wal-frames');
    expect(fs.readFileSync(`${vfs}-shm`, 'utf8')).toBe('shm');
    expect(sha256(vfs)).toBe(before);
  });

  it(`RF-W20-restore-stale-snapshot-deletes-db: a restore failure records this run's snapshot, and the retry after a restart restores from exactly that snapshot`, async () => {
    const dir = tempDir();
    await freshInstall(dir);
    const chat = coordinatorFor(dir).getDatabasePath('chat_v2');
    writeMarker(chat, 'before the failing start');

    // 有待迁移项的启动（llm_usage.db 缺失）：建快照，chat_v2 迁移失败，恢复也失败。
    const failing = coordinatorFor(dir, { relaunch: true });
    fs.rmSync(failing.getDatabasePath('llm_usage'));
    arm('before_db_migration::chat_v2');
    arm('before_restore');
    const report = await failing.runAll();
    const [runSnapshot] = snapshotsOf(failing).slice(-1);
    expect(snapshotsOf(failing)).toHaveLength(2);
    expect(reasonOf(report, 'chat_v2')).toContain('Restoring this database also failed');
    const journal = JSON.parse(fs.readFileSync(failing.backups.restoreFailureJournalPath(), 'utf8'));
    // Rust 的四个字段与顺序不变；附加的 snapshot 字段旧版 serde 会忽略。
    expect(Object.keys(journal.failures[0])).toEqual(['database', 'migration_error', 'restore_error', 'failed_at', 'snapshot']);
    expect(journal.failures[0]).toMatchObject({ database: 'ChatV2', snapshot: runSnapshot });

    writeMarker(chat, 'changed by the failed migration');
    const restarted = coordinatorFor(dir, { relaunch: true });
    const retry = await restarted.runAll();
    expect(retry.success, retry.error ?? '').toBe(true);
    expect(fs.existsSync(restarted.backups.restoreFailureJournalPath())).toBe(false);
    expect(readMarker(chat)).toBe('before the failing start');
  }, 120_000);

  it(`RF-W20-restore-stale-snapshot-deletes-db: a persisted failure without a recorded snapshot (written by the Rust version) never deletes the database from the latest snapshot`, async () => {
    const dir = tempDir();
    await freshInstall(dir);
    const manager = coordinatorFor(dir).backups;
    const vfs = coordinatorFor(dir).getDatabasePath('vfs');
    writeMarker(vfs, 'user notes');
    const before = sha256(vfs);
    manager.recordRestoreFailure('vfs', 'migration boom', 'restore boom');

    // Rust 重试同样取最新快照（573-584），即首启 copied_files=[] 的那个 → 删除 vfs.db 并报告重试成功。
    const restarted = coordinatorFor(dir, { relaunch: true });
    const report = await restarted.runAll();
    expect(report.componentHealth.isBlocked('vfs')).toBe(true);
    expect(sha256(vfs)).toBe(before);
    const reason = reasonOf(report, 'vfs');
    expect(reason).toMatch(/^Database 'vfs' remains blocked: migration failed \(migration boom\); restoring the trusted startup snapshot failed again \(/);
    expect(reason).toContain(`Database error: No trusted snapshot is recorded for this failure; the database file was kept in place at ${vfs} (not deleted or overwritten)`);
    expect(restarted.backups.loadRestoreFailureJournal().map((f) => f.database)).toEqual(['vfs']);
  }, 120_000);

  it(`RF-W20-restore-stale-snapshot-deletes-db: a persisted failure whose recorded snapshot is gone keeps the database and says which snapshot is missing`, async () => {
    const dir = tempDir();
    await freshInstall(dir);
    const manager = coordinatorFor(dir).backups;
    const vfs = coordinatorFor(dir).getDatabasePath('vfs');
    writeMarker(vfs, 'user notes');
    const before = sha256(vfs);
    const gone = 'startup_20200101T000000.000Z_1';
    manager.recordRestoreFailure('vfs', 'migration boom', 'restore boom', gone);

    const restarted = coordinatorFor(dir, { relaunch: true });
    const report = await restarted.runAll();
    expect(report.componentHealth.isBlocked('vfs')).toBe(true);
    expect(sha256(vfs)).toBe(before);
    expect(reasonOf(report, 'vfs')).toContain(
      `Database error: The recorded snapshot migration_core_backups/${gone} no longer exists; the database file was kept in place at ${vfs} (not deleted or overwritten)`,
    );
    expect(restarted.backups.loadRestoreFailureJournal()).toMatchObject([{ database: 'vfs', snapshot: gone }]);
  }, 120_000);
});
