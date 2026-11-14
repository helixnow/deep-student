/**
 * V07 P3-1 的前提：移动端写 `__governance_schema_fingerprints` 时，必须与桌面逐字节相同，库在两端之间搬（备份导入）才不会被
 * 当成 schema 漂移。这里锁定两件事（同一份迁移 SQL，桌面 better-sqlite3 vs 移动端 Node 版 sqlite-wasm）：
 * - 移动端迁出的库，按桌面 `computeSchemaFingerprint` 算出的指纹与规范 schema，等于桌面迁移协调器写下的那一行；
 * - 在移动端 scratch（`MobileStorageService.openScratch()`，WASM `:memory:`）里重放迁移得到的托管对象名（scope）与 schema，
 *   与桌面 scratch 相同——移动端可以用自己的 scratch，不必引入 better-sqlite3。
 * 移动端迁移路径实际写入指纹要等 W14 的 `fingerprint.ts` scratch 注入与 `migrations.ts` 接线（见 W31-PROGRESS.md 第三轮）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoordinatedDatabaseName } from '../../../host/platform/storage/api.ts';
import type { Connection } from '../../../host/platform/storage/connection.ts';
import { MigrationCoordinator } from '../../../host/platform/storage/migration/coordinator.ts';
import { SCHEMA_FINGERPRINT_TABLE, computeSchemaFingerprint, computeSchemaFingerprintScope } from '../../../host/platform/storage/migration/fingerprint.ts';
import { openFileDatabase } from '../../../host/platform/storage/service.ts';
import type { MobileConnection } from '../../../host/platform/storage-mobile/connection.ts';
import { MOBILE_MIGRATION_ORDER } from '../../../host/platform/storage-mobile/migrations.ts';
import { MobileStorageService } from '../../../host/platform/storage-mobile/service.ts';
import { nodeRuntime, nodeSqlite, type NodeRuntime } from './support/sqlite-node.ts';

interface StoredFingerprint {
  readonly version: number;
  readonly fingerprint: string;
  readonly canonical: string | null;
}

/** `fingerprint.ts` 只用 `pluck` / `all` / `get` / `run` / `exec`，移动端连接按结构满足。 */
const asConnection = (conn: MobileConnection) => conn as unknown as Connection;

let dir: string;
let coordinator: MigrationCoordinator;
let mobile: MobileStorageService;
let runtime: NodeRuntime;
const desktop = new Map<CoordinatedDatabaseName, StoredFingerprint>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'w31-fingerprint-'));
  coordinator = new MigrationCoordinator({ appDataDir: dir, auditDbPath: null, log: () => undefined });
  const report = await coordinator.runAll();
  expect(report.success).toBe(true);
  for (const id of MOBILE_MIGRATION_ORDER) {
    const db = openFileDatabase(coordinator.getDatabasePath(id), { profile: 'plain', label: id, mustExist: true });
    try {
      const version = db.pluck<number>('SELECT MAX(version) FROM refinery_schema_history')!;
      const row = db.get<{ fingerprint: string; canonical_schema: string | null }>(
        `SELECT fingerprint, canonical_schema FROM ${SCHEMA_FINGERPRINT_TABLE} WHERE database_id = ?1 AND schema_version = ?2`,
        [id, version],
      );
      expect(row, `${id} desktop fingerprint row`).toBeDefined();
      desktop.set(id, { version, fingerprint: row!.fingerprint, canonical: row!.canonical_schema });
    } finally {
      db.close();
    }
  }
  runtime = nodeRuntime(await nodeSqlite());
  mobile = new MobileStorageService({ runtime, baseDir: '/data' });
  expect((await mobile.migrations.runAll()).success).toBe(true);
}, 120_000);

afterAll(() => {
  mobile?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('schema fingerprints: mobile matches what the desktop coordinator records', () => {
  it.each(MOBILE_MIGRATION_ORDER)('%s: the mobile-migrated database has the desktop fingerprint and canonical schema', (id) => {
    const stored = desktop.get(id)!;
    expect(mobile.migrations.currentVersion(id)).toBe(stored.version);
    const conn = mobile.database(id).rawConnection();
    const actual = computeSchemaFingerprint(asConnection(conn), coordinator.sets[id], stored.version);
    expect(actual.canonicalSchema).toBe(stored.canonical);
    expect(actual.hash).toBe(stored.fingerprint);
  });

  it.each(MOBILE_MIGRATION_ORDER)('%s: replaying the migrations in a WASM :memory: scratch gives the desktop scope and schema', (id) => {
    const stored = desktop.get(id)!;
    const set = coordinator.sets[id];
    const opened = runtime.opened.length;
    const scratch = mobile.openScratch();
    try {
      expect(scratch.applied).toMatchObject({ journalMode: 'memory', lockingMode: 'exclusive', foreignKeys: 1, pageSize: 4096 });
      expect(runtime.opened.length, 'the scratch must not take a pool slot').toBe(opened);
      for (const migration of set.migrations) {
        if (migration.refineryVersion <= stored.version) scratch.exec(migration.sql);
      }
      const names = (sql: string) => scratch.all<{ name: string }>(sql).map(row => row.name);
      const desktopScope = computeSchemaFingerprintScope(set, stored.version);
      // 与 fingerprint.ts `computeScopeFromScratch` 相同的三条查询。
      expect(names(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'refinery_schema_history' AND name != '${SCHEMA_FINGERPRINT_TABLE}' ORDER BY name`).sort())
        .toEqual([...desktopScope.tables].sort());
      expect(names("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name").sort()).toEqual([...desktopScope.indexes].sort());
      expect(names("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").sort()).toEqual([...desktopScope.triggers].sort());
      expect(computeSchemaFingerprint(asConnection(scratch), set, stored.version, desktopScope).hash).toBe(stored.fingerprint);
    } finally {
      scratch.close();
    }
  });
});
