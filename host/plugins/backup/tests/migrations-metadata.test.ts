import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createMigrationWorker } from '../../../platform/storage/node.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { CoreMigrationReport } from '../../../platform/storage/migration/backup.ts';
import { MigrationCoordinator } from '../../../platform/storage/migration/coordinator.ts';
import { MigrationError } from '../../../platform/storage/migration/errors.ts';
import { CHAT_V2_MIGRATIONS } from '../../../platform/storage/migration/definitions/chat_v2.ts';
import { VFS_MIGRATIONS, VFS_SCHEMA_VERSION } from '../../../platform/storage/migration/definitions/vfs.ts';
import {
  DATABASE_DEPENDENCIES, DATABASE_IDS, latestVersion, migrationVersions, pendingCount,
} from '../src/migrations.ts';
import {
  aggregateSchemaRegistry, checkDependencies, type SchemaRegistry,
} from '../repository/schema-registry.ts';

const BASELINES = { vfs: 28, chat_v2: 14, mistakes: 6, llm_usage: 3 } as const;

/** 仅准备目录；被测方法是正式 runAll 所调用的 MigrationCoordinator.checkDependencies。 */
function withCoordinator(run: (coordinator: MigrationCoordinator) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dstu-dependency-report-'));
  try { run(new MigrationCoordinator({ appDataDir: root, auditDbPath: null })); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

/** Rust 的 run_all → aggregate_schema_registry：真实迁移和真实文件，绝不伪造 refinery 历史。 */
async function withMigratedRegistry(run: (registry: SchemaRegistry, coordinator: MigrationCoordinator) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dstu-registry-migrated-'));
  const migrations = createMigrationWorker({ baseDir: root });
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  try {
    const report = await migrations.runAll({ appDataDir: root, auditDbPath: null });
    expect(report.success, report.error ?? 'migration should succeed').toBe(true);
    // 与 Governance.refreshSchemaRegistry 相同的生产聚合函数，opener 返回的均为真实 F3 handle。
    const registry = aggregateSchemaRegistry(root, {
      open: path => storage.openFile(path, { label: 'registry-regression', mustExist: true }),
      close: db => storage.close(db as DatabaseHandle),
    }, toRfc3339);
    run(registry, new MigrationCoordinator({ appDataDir: root, auditDbPath: null }));
  } finally {
    // F3 先 drain/关闭线程，之后才允许销毁目标目录。
    await migrations.close();
    storage.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

it('test_database_dependencies_definition', () => {
  expect(DATABASE_DEPENDENCIES.vfs).toEqual([]);
  expect(DATABASE_DEPENDENCIES.llm_usage).toEqual([]);
  expect(DATABASE_DEPENDENCIES.chat_v2).toEqual(['vfs']);
  expect(DATABASE_DEPENDENCIES.mistakes).toEqual(['vfs']);
});

it('test_database_ordering_satisfies_dependencies', () => {
  expect(DATABASE_IDS).toHaveLength(4);
  const position = (id: string) => DATABASE_IDS.indexOf(id as never);
  expect(position('vfs')).toBeLessThan(position('chat_v2'));
  expect(position('vfs')).toBeLessThan(position('mistakes'));
});

it('test_all_migration_sets_count', () => {
  expect(DATABASE_IDS).toHaveLength(4);
  for (const id of DATABASE_IDS) expect(migrationVersions(id)).toBeDefined();
});

it('test_migration_set_properties', () => {
  for (const id of DATABASE_IDS) {
    const versions = migrationVersions(id)!;
    expect(versions.length).toBeGreaterThanOrEqual(BASELINES[id]);
    expect(latestVersion(id)).toBe(versions[versions.length - 1]);
  }
  expect(migrationVersions('vfs')!.length).toBeGreaterThanOrEqual(28);
  expect(migrationVersions('chat_v2')!.length).toBeGreaterThanOrEqual(14);
  expect(migrationVersions('mistakes')!.length).toBeGreaterThanOrEqual(6);
  expect(migrationVersions('llm_usage')!.length).toBeGreaterThanOrEqual(3);
  // Rust migration_tests.rs:1342-1371 / tests.rs:1041-1082 检查正式 MigrationSet，
  // L21 自己的版本数组不等于迁移执行器所用集合，因此保留上方消费侧断言并另查真实 F3。
  withCoordinator(coordinator => {
    const sets = coordinator.sets;
    for (const id of ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const) {
      expect(sets[id].databaseName, id).toBe(id);
      expect(sets[id].count(), id).toBeGreaterThanOrEqual(BASELINES[id]);
    }
    expect(sets.vfs.count()).toBe(VFS_MIGRATIONS.length);
    expect(sets.vfs.latestVersion()).toBe(VFS_SCHEMA_VERSION);
    expect(sets.chat_v2.count()).toBe(CHAT_V2_MIGRATIONS.length);
    expect(sets.chat_v2.latestVersion()).toBe(20261111);
    expect(sets.mistakes.latestVersion()).toBeGreaterThanOrEqual(20260207);
    expect(sets.llm_usage.latestVersion()).toBeGreaterThanOrEqual(20260201);
  });
});

it('test_migration_versions_ordered', () => {
  for (const id of DATABASE_IDS) {
    let previous = 0;
    for (const version of migrationVersions(id)!) {
      expect(version).toBeGreaterThan(previous);
      previous = version;
    }
  }
});

it('test_no_broken_symlink_migration_files', () => {
  const root = join(process.cwd(), 'resources/app', 'migrations');
  expect(existsSync(root)).toBe(true);
  const sqlFiles: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith('.sql')) sqlFiles.push(path);
    }
  };
  collect(root);
  expect(sqlFiles.length).toBeGreaterThan(0);

  const problems: string[] = [];
  for (const path of sqlFiles) {
    if (lstatSync(path).isSymbolicLink()) {
      problems.push(`${path} 是符号链接（migrations/ 下禁止符号链接，Windows 检出会损坏）`);
      continue;
    }
    const content = readFileSync(path, 'utf8');
    const trimmed = content.trim();
    if (trimmed.startsWith('../') || trimmed.startsWith('..\\')) {
      problems.push(`${path} 疑似损坏的符号链接文本`);
      continue;
    }
    const nonEmpty = trimmed.split('\n').filter(line => line.trim() !== '');
    if (nonEmpty.length === 1 && nonEmpty[0]!.trimEnd().endsWith('.sql')) {
      problems.push(`${path} 疑似损坏的符号链接文本（单行指向 .sql）`);
      continue;
    }
    if (!content.includes(';')) problems.push(`${path} 不含任何 SQL 语句分号 ';'`);
  }
  expect(problems).toEqual([]);
});

it('test_dependency_not_satisfied_error', () => {
  // Rust migration_tests.rs:890-907 / tests.rs:512-528：空迁移报告，不是 SchemaRegistry。
  withCoordinator(coordinator => {
    const report = new CoreMigrationReport();
    let failure: unknown;
    try { coordinator.checkDependencies('chat_v2', report); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MigrationError);
    expect(failure).toMatchObject({
      detail: { kind: 'DependencyNotSatisfied', database: 'chat_v2', dependency: 'vfs' },
    });
  });
});

it('test_dependency_satisfied_success', () => {
  // Rust migration_tests.rs:917-934：VFS 成功记录足以满足 ChatV2 的迁移依赖。
  withCoordinator(coordinator => {
    const report = new CoreMigrationReport();
    report.add({
      id: 'vfs', fromVersion: 0, toVersion: 20260203, appliedCount: coordinator.sets.vfs.count(),
      success: true, durationMs: 100, error: null,
    });
    expect(() => coordinator.checkDependencies('chat_v2', report)).not.toThrow();
  });
});

it('test_pending_migrations_count', () => {
  const total = DATABASE_IDS.reduce((sum, id) => sum + pendingCount(id, 0), 0);
  const declared = DATABASE_IDS.reduce((sum, id) => sum + migrationVersions(id)!.length, 0);
  expect(total).toBe(declared);
  expect(total).toBeGreaterThan(0);
});

it('test_needs_migration_check', () => {
  for (const id of DATABASE_IDS) expect(pendingCount(id, 0)).toBeGreaterThan(0);
});

it('test_no_migration_needed_after_run', () => {
  for (const id of DATABASE_IDS) expect(pendingCount(id, latestVersion(id))).toBe(0);
});

it('test_schema_registry_aggregation', async () => {
  await withMigratedRegistry(registry => {
    // Rust tests.rs:710-729；保留原 TS 的最新版本精确断言。
    expect(registry.databases.size).toBe(4);
    expect(registry.global_version).toBeGreaterThan(0);
    for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
      const status = registry.databases.get(id);
      expect(status, id).toBeDefined();
      expect(status!.schema_version, id).toBeGreaterThan(0);
      expect(status!.schema_version, id).toBe(latestVersion(id));
    }
  });
});

it('test_schema_registry_aggregation_after_migration', async () => {
  await withMigratedRegistry((registry, coordinator) => {
    // Rust migration_tests.rs:1160-1192：全局版本、状态存在、正版本、正式集合最新版本。
    expect(registry.databases.size).toBe(4);
    expect(registry.global_version).toBeGreaterThan(0);
    for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
      const status = registry.databases.get(id);
      expect(status, id).toBeDefined();
      expect(status!.schema_version, id).toBeGreaterThan(0);
      expect(status!.schema_version, id).toBe(coordinator.sets[id].latestVersion());
      // 保留原 TS 消费侧版本表断言；额外防止其与实际 F3/SQLite 历史漂移。
      expect(status!.schema_version, id).toBe(latestVersion(id));
    }
  });
});

it('test_schema_registry_dependency_check', async () => {
  await withMigratedRegistry(registry => {
    // Rust tests.rs:741-755：依赖检查必须消费实际迁移后的聚合结果。
    expect(() => checkDependencies(registry)).not.toThrow();
  });
});

it('test_schema_registry_dependency_check_passes', async () => {
  await withMigratedRegistry(registry => {
    // Rust migration_tests.rs:1203 起的同一真实迁移/聚合/依赖链。
    expect(() => checkDependencies(registry)).not.toThrow();
  });
});


it('test_database_dependencies', () => {
  expect(DATABASE_DEPENDENCIES.vfs).toEqual([]);
  expect(DATABASE_DEPENDENCIES.llm_usage).toEqual([]);
  expect(DATABASE_DEPENDENCIES.chat_v2).toEqual(['vfs']);
  expect(DATABASE_DEPENDENCIES.mistakes).toEqual(['vfs']);
});

it('test_database_ordering', () => {
  const position = (id: string) => DATABASE_IDS.indexOf(id as never);
  expect(DATABASE_IDS).toHaveLength(4);
  expect(position('vfs')).toBeLessThan(position('chat_v2'));
  expect(position('vfs')).toBeLessThan(position('mistakes'));
});

it('test_dependency_satisfied', () => {
  // Rust tests.rs:540-556 使用的成功 VFS 记录（独立保留原版本/计数夹具）。
  withCoordinator(coordinator => {
    const report = new CoreMigrationReport();
    report.add({
      id: 'vfs', fromVersion: 0, toVersion: 20260131, appliedCount: 2,
      success: true, durationMs: 100, error: null,
    });
    expect(() => coordinator.checkDependencies('chat_v2', report)).not.toThrow();
  });
});

it('test_pending_migrations_zero_after_run', () => {
  for (const id of DATABASE_IDS) expect(pendingCount(id, latestVersion(id))).toBe(0);
});
