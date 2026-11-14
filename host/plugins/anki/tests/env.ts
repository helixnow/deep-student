/**
 * 本 lane 的测试宿主：真实 F3 storage（含 mistakes 迁移）+ 最小 paths 服务。
 * 默认同时安装真实 L15 `review` 插件（FSRS 事务面与库快照），测试替身只用于
 * 其他 lane 尚未合入的服务，且集中在本文件（`tests/` 允许）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import type { CoordinatedDatabaseName, DatabaseMigrationReport } from '../../../platform/storage/api.ts';
import { regex as nativeRegex } from '../../../platform/native/regex/index.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { createNodeCrypto } from '../../../platform/crypto/index.ts';
import anki from '../index.ts';
import review from '../../review/index.ts';

// 本 lane 的钩子都在建库/清库，门禁三槽并发下同步 SQLite 会超过默认 10s 钩子超时。
// 只放宽钩子等待时间，不改任何断言。
vi.setConfig({ hookTimeout: 120_000 });

/** 测试 fixture 的迁移范围；`'all'` 保持原四库 `runAll` 行为。 */
export type AnkiTestMigrationScope = 'all' | readonly CoordinatedDatabaseName[];

export interface AnkiTestEnv {
  readonly host: TestHost;
  readonly storage: StorageServiceImpl;
  readonly dir: string;
  /** 模板拷贝后的真实重验结果（`'all'` 为 `runAll` 各库记录）。 */
  readonly migrationReports: readonly DatabaseMigrationReport[];
  dispose(): Promise<void>;
}

/**
 * 每个测试进程/每种 scope 只跑一次迁移，之后各 env 拷贝该目录。完整迁移是长时间同步
 * SQLite 工作，逐例重复会阻塞 vitest worker，门禁里表现为 `Timeout calling "onTaskUpdate"`。
 * 单库 scope 与 Rust `with_audit_db(None).migrate_single(Mistakes)` 对齐，模板按 scope 隔离。
 */
const templateDirs = new Map<string, Promise<string>>();
function scopeKey(scope: AnkiTestMigrationScope): string {
  return scope === 'all' ? 'all' : [...new Set(scope)].sort().join(',');
}
function scopeDatabases(scope: AnkiTestMigrationScope): readonly CoordinatedDatabaseName[] | null {
  return scope === 'all' ? null : [...new Set(scope)];
}
function migratedTemplateDir(scope: AnkiTestMigrationScope): Promise<string> {
  const key = scopeKey(scope);
  let template = templateDirs.get(key);
  if (template === undefined) {
    template = (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-plugin-template-'));
      const databases = scopeDatabases(scope);
      const storage = createStorageService({
        baseDir: dir,
        dataLocalDir: path.join(dir, 'local'),
        ...(databases === null ? {} : { auditDbPath: null }),
      });
      try {
        if (databases === null) {
          const report = await storage.migrations.runAll();
          if (!report.success) throw new Error(`mistakes 迁移失败: ${JSON.stringify(report)}`);
        } else {
          for (const name of databases) await storage.migrations.migrateSingle(name);
        }
      } finally {
        storage.dispose();
      }
      process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
      return dir;
    })();
    templateDirs.set(key, template);
  }
  return template;
}

export async function createAnkiTestEnv(
  options: {
    migrate?: boolean;
    /** 迁移范围；默认 `'all'`（四库 runAll）。单库 scope 使用 `migrateSingle` 且关闭 audit。 */
    migrationScope?: AnkiTestMigrationScope;
    /** 默认安装真实 L15 review；fail-closed 用例可显式关闭。 */
    withReview?: boolean;
    provide?: Record<string, unknown> | ((storage: StorageServiceImpl) => Record<string, unknown>);
  } = {},
): Promise<AnkiTestEnv> {
  const scope = options.migrationScope ?? 'all';
  const databases = scopeDatabases(scope);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-plugin-'));
  if (options.migrate !== false) fs.cpSync(await migratedTemplateDir(scope), dir, { recursive: true });
  const storage = createStorageService({
    baseDir: dir,
    dataLocalDir: path.join(dir, 'local'),
    ...(databases === null ? {} : { auditDbPath: null }),
  });
  let migrationReports: readonly DatabaseMigrationReport[] = [];
  try {
    if (options.migrate !== false) {
      if (databases === null) {
        // 拷贝的模板库已迁移；这里仍走真实 runAll，只做校验，不再逐条执行迁移 SQL。
        const report = await storage.migrations.runAll();
        if (!report.success) throw new Error(`mistakes 迁移失败: ${JSON.stringify(report)}`);
        migrationReports = report.databases;
      } else {
        // 单库 scope：模板已迁移；拷贝后用同一 migrateSingle 重验，不落全库快照/依赖/恢复。
        const reports: DatabaseMigrationReport[] = [];
        for (const name of databases) reports.push(await storage.migrations.migrateSingle(name));
        migrationReports = reports;
      }
    }
    const extra = typeof options.provide === 'function'
      ? options.provide(storage)
      : options.provide;
    const withReview = options.withReview !== false;
    const host = await createTestHost({
      app: { dataDir: dir },
      plugins: withReview ? [anki, review] : [anki],
      provide: {
        paths: {
          appDataDir: dir,
          os: { temp: os.tmpdir() },
          deviceId: async () => 'anki-test-device',
          dataSpaceDeviceId: async () => 'anki-test-device',
        },
        storage,
        crypto: createNodeCrypto(),
        // 真实 F4 settings（同一 mistakes 库）；本 lane 不再自写 settings 表。
        settings: createSettingsService({
          db: () => storage.database('mistakes'),
          secureStore: () => null,
          secrets: { isSensitiveKey: () => false },
        }),
        nativeRegex,
        ...extra,
      },
    });
    return {
      host,
      storage,
      dir,
      migrationReports,
      async dispose() {
        try {
          await host.dispose();
        } finally {
          storage.dispose();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    storage.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
