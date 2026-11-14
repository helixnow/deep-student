/**
 * 移动端迁移失败的文本与桌面 coordinator 相同（`MigrationError` 的 Display）：同一个坏状态分别交给桌面
 * `MigrationCoordinator.migrateSingle` 和移动端 `migrateMobileDatabase`，比较失败文本。移动端的受阻原因
 * （`startup.ts` 的 `migrationFailureReason`）直接拼接这段文本。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Connection } from '../../storage/connection.ts';
import { setStorageLogger } from '../../storage/logging.ts';
import { MigrationCoordinator } from '../../storage/migration/coordinator.ts';
import { DEFAULT_MIGRATIONS_DIR } from '../../storage/migration/definitions/index.ts';
import { PROFILES } from '../../storage/profiles.ts';
import type { MobileConnection } from '../connection.ts';
import { migrateMobileDatabase } from '../migrations.ts';

const temps: string[] = [];
const open: Connection[] = [];
afterEach(() => {
  for (const conn of open.splice(0)) conn.close();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  setStorageLogger(null);
});

function sources(db: string): Record<string, string> {
  const dir = path.join(DEFAULT_MIGRATIONS_DIR, db);
  return Object.fromEntries(fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

/** 新建 llm_usage 库迁移到最新，再用 `damage` 弄坏，返回桌面第二次迁移的失败文本。 */
function desktopFailure(damage: (conn: Connection) => void): string {
  setStorageLogger(() => ({ target: 'test', info() {}, warn() {}, error() {}, debug() {}, trace() {} }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-mobile-migration-error-'));
  temps.push(dir);
  const coordinator = new MigrationCoordinator({ appDataDir: dir, auditDbPath: null });
  expect(coordinator.migrateSingle('llm_usage').success).toBe(true);
  const conn = new Connection(coordinator.getDatabasePath('llm_usage'), { label: 'llm_usage', profile: PROFILES.plain, mustExist: true });
  try {
    damage(conn);
  } finally {
    conn.close();
  }
  try {
    coordinator.migrateSingle('llm_usage');
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('desktop migration unexpectedly succeeded');
}

function mobileFailure(damage: (conn: Connection) => void): { error: string | null; success: boolean; fromVersion: number; toVersion: number; appliedCount: number } {
  const conn = new Connection(':memory:', { label: 'llm_usage', profile: PROFILES.plain });
  open.push(conn);
  const files = sources('llm_usage');
  expect(migrateMobileDatabase('llm_usage', conn as unknown as MobileConnection, files).success).toBe(true);
  damage(conn);
  return migrateMobileDatabase('llm_usage', conn as unknown as MobileConnection, files);
}

const LATEST = 20260826;

describe('mobile migration failures read like the desktop coordinator', () => {
  it('recovers already-applied columns whose migration history row is missing', () => {
    // Mobile now safely replays this legacy state instead of retaining the old duplicate-column defect.
    const damage = (conn: Connection) => conn.run('DELETE FROM refinery_schema_history WHERE version = ?', [LATEST]);
    const desktop = desktopFailure(damage);
    expect(desktop).toMatch(/^Refinery error: .*duplicate column name: variant_id/);
    const mobile = mobileFailure(damage);
    expect(mobile.success).toBe(true);
    expect(mobile.error).toBeNull();
  });

  it('a contract verification failure carries the "Verification failed for migration N: " prefix', () => {
    const damage = (conn: Connection) => conn.run('DROP INDEX idx_llm_usage_logs_run_id');
    const desktop = desktopFailure(damage);
    expect(desktop).toBe(`Verification failed for migration ${LATEST}: Index 'idx_llm_usage_logs_run_id' not found`);
    const mobile = mobileFailure(damage);
    expect(mobile.success).toBe(false);
    expect(mobile.error).toBe(desktop);
  });

  /** Fails `SELECT MAX(version)` from the `failFrom`-th call on (1-based). */
  function failingVersionReads(conn: Connection, failFrom: number): MobileConnection {
    let calls = 0;
    return new Proxy(conn, {
      get(target, key, receiver) {
        if (key !== 'pluck') return Reflect.get(target, key, receiver);
        return (sql: string, ...rest: unknown[]) => {
          if (sql.startsWith('SELECT MAX(version)') && ++calls >= failFrom) throw new Error('disk I/O error');
          return (target.pluck as (...args: unknown[]) => unknown).call(target, sql, ...rest);
        };
      },
    }) as unknown as MobileConnection;
  }

  it('a failure while reading the history version is a "Database error: "', () => {
    const conn = new Connection(':memory:', { label: 'llm_usage', profile: PROFILES.plain });
    open.push(conn);
    const files = sources('llm_usage');
    expect(migrateMobileDatabase('llm_usage', conn as unknown as MobileConnection, files).success).toBe(true);
    expect(() => migrateMobileDatabase('llm_usage', failingVersionReads(conn, 1), files)).toThrow('Database error: disk I/O error');
  });

  it('when the version cannot be re-read after a failure, the report keeps the original error and the pre-migration counts', () => {
    const conn = new Connection(':memory:', { label: 'llm_usage', profile: PROFILES.plain });
    open.push(conn);
    const files = sources('llm_usage');
    expect(migrateMobileDatabase('llm_usage', conn as unknown as MobileConnection, files).success).toBe(true);
    conn.run('DELETE FROM refinery_schema_history WHERE version = ?', [LATEST]);
    conn.exec(`CREATE TRIGGER reject_migration BEFORE INSERT ON refinery_schema_history BEGIN SELECT RAISE(ABORT, 'history write failed'); END;`);
    const fromVersion = conn.pluck<number>('SELECT MAX(version) FROM refinery_schema_history');
    const report = migrateMobileDatabase('llm_usage', failingVersionReads(conn, 2), files);
    expect(report).toMatchObject({ success: false, fromVersion, toVersion: fromVersion, appliedCount: 0 });
    expect(report.error).toMatch(/^Refinery error: .*history write failed/);
  });
});
