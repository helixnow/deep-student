/**
 * R4 `ACCEPTANCE.md` B01/B02/B03/B04/B08/B09/B11 的生产入口回归测试。
 *
 * 每个用例都经 `host.invoke` 或已发布的备份服务执行，不复制命令实现。
 */
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { CommandError } from '../../../kernel/api.ts';
import { Connection } from '../../../platform/storage/connection.ts';
import { StorageError, type DatabaseHandle } from '../../../platform/storage/api.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { OperationGuardError } from '../api.ts';
import type {} from '../api.ts';
import { INCREMENTAL_BACKUP_REMOVED_MESSAGE, loadManifest } from '../src/manifest.ts';
import {
  createBackupHost, createDatabaseFile, createRealStorage, hostBackupRoot, partialManifest,
  waitForJob, writeBackup,
} from './helpers.ts';

const hosts: TestHost[] = [];
const storages: StorageServiceImpl[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
});

const REFINERY = `CREATE TABLE refinery_schema_history (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_on TEXT NOT NULL, checksum TEXT NOT NULL
)`;

interface RealEnv {
  host: TestHost;
  activeDir: string;
  root: string;
}

async function setupRealHost(
  decorate?: (storage: Record<string, unknown>) => Record<string, unknown>,
): Promise<RealEnv> {
  const storageFactory = (dataDir: string, activeDir: string) => {
    const storage = createRealStorage(activeDir, dataDir);
    return decorate?.(storage) ?? storage;
  };
  const created = await createBackupHost({ storageFactory });
  const host = created.host;
  hosts.push(host);
  const activeDir = join(host.app.dataDir, 'slots', 'slotA');
  createDatabaseFile(join(activeDir, 'databases', 'vfs.db'), `${REFINERY};
    INSERT INTO refinery_schema_history(version, name, applied_on, checksum)
    VALUES (20260130, 'init', '2026-01-30T00:00:00Z', 'checksum-vfs');
    CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT)`);
  createDatabaseFile(join(activeDir, 'mistakes.db'));
  createDatabaseFile(join(activeDir, 'llm_usage.db'));
  createDatabaseFile(join(activeDir, 'chat_v2.db'));
  return { host, activeDir, root: hostBackupRoot(host) };
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error('expected rejection'); }, error => error);
}

/**
 * 真实 F3 `StorageServiceImpl`：B02 的维护态借用/释放必须走平台维护屏障，
 * 不能用 `createRealStorage` 的 fake `enterMaintenance`。
 */
async function setupStorageServiceHost(
  decorate?: (storage: StorageServiceImpl) => void,
): Promise<{ host: TestHost; storage: StorageServiceImpl; activeDir: string; root: string }> {
  let storage!: StorageServiceImpl;
  const created = await createBackupHost({
    storageFactory: (dataDir) => {
      storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      decorate?.(storage);
      return storage;
    },
  });
  storages.push(storage);
  const host = created.host;
  hosts.push(host);
  const activeDir = storage.locations.activeDir;
  createDatabaseFile(join(activeDir, 'databases', 'vfs.db'), `${REFINERY};
    INSERT INTO refinery_schema_history(version, name, applied_on, checksum)
    VALUES (20260130, 'init', '2026-01-30T00:00:00Z', 'checksum-vfs');
    CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT)`);
  createDatabaseFile(join(activeDir, 'mistakes.db'));
  createDatabaseFile(join(activeDir, 'llm_usage.db'));
  createDatabaseFile(join(activeDir, 'chat_v2.db'));
  return { host, storage, activeDir, root: hostBackupRoot(host) };
}

// ------------------------------------------------------------------ B01

it('B01 run_backup business failure reaches the frontend as a contract string', async () => {
  const { host } = await setupRealHost();
  const rejection = await rejectionOf(host.invoke('data_governance_run_backup', {
    backupType: 'incremental',
  }));
  expect(typeof rejection).toBe('string');
  expect(rejection).toBe(INCREMENTAL_BACKUP_REMOVED_MESSAGE);
});

it('B01 get_audit_logs invalid status reaches the frontend as a contract string', async () => {
  const { host } = await setupRealHost();
  const rejection = await rejectionOf(host.invoke('data_governance_get_audit_logs', {
    status: 'invalid',
  }));
  expect(typeof rejection).toBe('string');
  expect(rejection).toBe('无效的状态过滤值: invalid。可选值: Completed, Failed, Partial');
});

it('B01 cleanup_audit_logs invalid token settles as a contract string', async () => {
  const { host } = await setupRealHost();
  const rejection = await rejectionOf(host.invoke('data_governance_cleanup_audit_logs', {
    confirmationToken: 'not-a-token',
  }));
  expect(typeof rejection).toBe('string');
  expect(rejection).toBe('审计清理令牌格式无效，需要 AUDIT_CLEANUP_{unix_timestamp}');
});

it('B01 get_database_status unknown id settles as a contract string', async () => {
  const { host } = await setupRealHost();
  const rejection = await rejectionOf(host.invoke('data_governance_get_database_status', {
    databaseId: 'missing_db',
  }));
  expect(typeof rejection).toBe('string');
  expect(rejection).toBe('未知的数据库 ID: missing_db。可选值: vfs, chat_v2, mistakes, llm_usage');
});

it('B01 delete_backup invalid id settles as a contract string before touching the guard', async () => {
  const { host, root } = await setupRealHost();
  mkdirSync(root, { recursive: true });
  const rejection = await rejectionOf(host.invoke('data_governance_delete_backup', {
    backupId: '../escape',
  }));
  expect(typeof rejection).toBe('string');
  expect(rejection).toBe('backup_id 包含非法路径片段');
});

// ------------------------------------------------------------------ B02

it('B02 run_backup freezes the real storage maintenance barrier for the whole staging phase', async () => {
  let hostRef: TestHost | null = null;
  let heldHandle: DatabaseHandle | null = null;
  let statusDuringBarrier: Record<string, unknown> | null = null;
  let borrowError: unknown = null;
  let heldWriteError: unknown = null;
  let probed = false;

  const { host, storage } = await setupStorageServiceHost((instance) => {
    const baseOpen = instance.openFile.bind(instance);
    instance.openFile = (path, options) => {
      const handle = baseOpen(path, options);
      // 只在真实备份 staging 的数据库快照打开点做探针；不替换 enterMaintenance。
      if (!probed && String(options?.label ?? '').startsWith('backup:')) {
        probed = true;
        try { instance.database('vfs'); }
        catch (error) { borrowError = error; }
        try { heldHandle!.run('INSERT INTO probe(value) VALUES (?)', ['during']); }
        catch (error) { heldWriteError = error; }
        const original = handle.backupTo.bind(handle);
        handle.backupTo = async (destination: string) => {
          statusDuringBarrier = await hostRef!.invoke(
            'data_governance_get_maintenance_status',
          ) as Record<string, unknown>;
          return original(destination);
        };
      }
      return handle;
    };
  });
  hostRef = host;
  // 备份开始前取得的句柄：维护屏障期间写入必须被真实平台拒绝。
  heldHandle = storage.database('vfs');

  const started = await host.invoke('data_governance_run_backup', { includeAssets: false }) as {
    job_id: string;
  };
  const job = await waitForJob(host, started.job_id);
  expect(job.status, String(job.error ?? job.message ?? '')).toBe('completed');
  expect(probed).toBe(true);
  expect(borrowError).toBeInstanceOf(StorageError);
  expect((borrowError as StorageError).code).toBe('MAINTENANCE');
  expect(heldWriteError).toBeInstanceOf(StorageError);
  expect((heldWriteError as StorageError).code).toBe('MAINTENANCE');
  expect(statusDuringBarrier).not.toBeNull();
  expect(statusDuringBarrier!.is_in_maintenance_mode).toBe(true);
  expect(statusDuringBarrier!.blocked_components).toEqual(
    expect.arrayContaining(['main', 'manager', 'vfs', 'chat_v2', 'llm_usage']),
  );
  // 屏障退出后同一句柄恢复可写。
  heldHandle!.run('INSERT INTO probe(value) VALUES (?)', ['after']);
  expect(heldHandle!.pluck('SELECT COUNT(*) FROM probe')).toBe(1);
});

it('B02 borrows an existing main-database maintenance lease without releasing the external owner', async () => {
  const { host, storage } = await setupStorageServiceHost();
  const external = await storage.enterMaintenance(['mistakes']);

  const started = await host.invoke('data_governance_run_backup', { includeAssets: false }) as {
    job_id: string;
  };
  const job = await waitForJob(host, started.job_id);
  expect(job.status, String(job.error ?? job.message ?? '')).toBe('completed');

  // 外部 fail-close 的 lease 仍由原 owner 持有；借用的屏障不得解除它。
  expect(() => storage.database('mistakes')).toThrow(/is in maintenance mode/);
  external.release();
  expect(() => storage.database('mistakes')).not.toThrow();
});

it('B02 retries a failed barrier release once and surfaces the original error', async () => {
  let exitAttempts = 0;
  const { host, storage } = await setupStorageServiceHost((instance) => {
    const baseEnter = instance.enterMaintenance.bind(instance);
    instance.enterMaintenance = async (names, options) => {
      const lease = await baseEnter(names, options);
      return {
        databases: lease.databases,
        release: () => {
          exitAttempts += 1;
          if (exitAttempts === 1) throw new Error('transient exit failure');
          lease.release();
        },
      };
    };
  });

  const started = await host.invoke('data_governance_run_backup', { includeAssets: false }) as {
    job_id: string;
  };
  const job = await waitForJob(host, started.job_id);

  expect(job.status).toBe('failed');
  expect(String(job.error ?? job.message ?? '')).toContain(
    '退出备份快照屏障失败: 数据库: transient exit failure',
  );
  // Rust `release(mut self)` 返回 Err 后立即 Drop，恢复尝试共 2 次。
  expect(exitAttempts).toBe(2);
  const status = await host.invoke('data_governance_get_maintenance_status') as {
    is_in_maintenance_mode: boolean;
  };
  expect(status.is_in_maintenance_mode).toBe(false);
  expect(() => storage.database('mistakes')).not.toThrow();
});

// Rust commands_backup.rs:2003-2018 / 2807-2818、commands_zip.rs:427-516：
// `let result = staging; barrier.release()?; result?` —— staging 失败也必须先释放屏障，
// 释放失败时以释放错误为准。
const stagingEntries = [
  ['data_governance_run_backup', { includeAssets: false }],
  ['data_governance_backup_tiered', { tiers: ['core'], includeAssets: false }],
  ['data_governance_backup_and_export_zip', { outputPath: '__OUT__', includeAssets: false }],
] as const;

for (const [command, baseArgs] of stagingEntries) {
  for (const releaseFails of [false, true]) {
    it(`B02 ${command} releases the barrier after a staging failure (release fails: ${releaseFails})`, async () => {
      let exitAttempts = 0;
      const { host, storage } = await setupStorageServiceHost((instance) => {
        const baseOpen = instance.openFile.bind(instance);
        instance.openFile = (path, options) => {
          const handle = baseOpen(path, options);
          if (String(options?.label ?? '').startsWith('backup:')) {
            handle.backupTo = async () => { throw new Error('injected staging failure'); };
          }
          return handle;
        };
        const baseEnter = instance.enterMaintenance.bind(instance);
        instance.enterMaintenance = async (names, options) => {
          const lease = await baseEnter(names, options);
          return {
            databases: lease.databases,
            release: () => {
              exitAttempts += 1;
              if (releaseFails && exitAttempts === 1) throw new Error('transient exit failure');
              lease.release();
            },
          };
        };
      });
      const args = 'outputPath' in baseArgs
        ? { ...baseArgs, outputPath: join(host.app.dataDir, 'b02-out.zip') } : baseArgs;

      const started = await host.invoke(command, args) as { job_id: string };
      const job = await waitForJob(host, started.job_id);
      const message = String(job.error ?? job.message ?? '');

      expect(job.status).toBe('failed');
      if (releaseFails) {
        expect(message).toContain('退出备份快照屏障失败: 数据库: transient exit failure');
        expect(message).not.toContain('injected staging failure');
        expect(exitAttempts).toBe(2);
      } else {
        expect(message).toContain('injected staging failure');
        expect(exitAttempts).toBe(1);
      }
      const status = await host.invoke('data_governance_get_maintenance_status') as {
        is_in_maintenance_mode: boolean;
      };
      expect(status.is_in_maintenance_mode).toBe(false);
      expect(() => storage.database('mistakes')).not.toThrow();
      expect(() => storage.database('vfs')).not.toThrow();
    });
  }
}

// ------------------------------------------------------------------ B03

it('B03 tryAcquireOperation is process-wide and holds the cross-process lock explicitly', async () => {
  const first = await setupRealHost();
  const second = await setupRealHost();
  const lockPath = join(first.host.app.dataDir, 'recovery', '.data-governance-operation.lock');

  const guard = first.host.ctx.backup.tryAcquireOperation('backup');
  expect(existsSync(lockPath)).toBe(true);
  let busy: unknown;
  try { second.host.ctx.backup.tryAcquireOperation('restore'); }
  catch (error) { busy = error; }
  expect(busy).toBeInstanceOf(CommandError);
  expect(busy).toBeInstanceOf(OperationGuardError);
  const failure = busy as OperationGuardError;
  expect(failure.reason).toBe('busy');
  expect(failure.code).toBe('E_DATA_GOVERNANCE_BUSY');
  expect(failure.message).toContain('已有数据治理操作正在运行');
  expect(failure.app_error).toEqual({
    error_type: 'Validation', message: failure.message, details: null,
  });
  expect(failure.value).toBe(failure.app_error);
  expect((busy as CommandError).name).toBe('CommandError');
  guard.release();
  expect(existsSync(lockPath)).toBe(false);

  const next = second.host.ctx.backup.tryAcquireOperation('prune');
  next.release();
});

it('B03 run_backup reports global permit acquisition failures with the Rust message', async () => {
  const { host } = await setupStorageServiceHost();
  const recoveryPath = join(host.app.dataDir, 'recovery');
  rmSync(recoveryPath, { recursive: true, force: true });
  writeFileSync(recoveryPath, 'not a directory');

  const started = await host.invoke('data_governance_run_backup', { includeAssets: false }) as {
    job_id: string;
  };
  const job = await waitForJob(host, started.job_id);
  const message = String(job.error ?? job.message ?? '');
  expect(job.status).toBe('failed');
  expect(message).toContain('获取全局备份锁失败:');
  expect(message).toContain(`创建数据治理跨进程锁目录失败 ${JSON.stringify(recoveryPath)}`);
  expect(message).not.toContain('备份失败:');
});

it('B03 cancelling a queued run_backup settles within the 200ms polling window', async () => {
  const { host } = await setupStorageServiceHost();
  const holder = host.ctx.backup.tryAcquireOperation('backup');
  const started = await host.invoke('data_governance_run_backup', {
    includeAssets: false,
  }) as { job_id: string };

  const waiting = host.ctx.backup.jobs.getJob(started.job_id)!;
  expect(waiting.status).toBe('running');
  expect(waiting.phase).toBe('queued');

  expect(await host.invoke('data_governance_cancel_backup', { jobId: started.job_id })).toBe(true);
  const cancelledAt = Date.now();
  const job = await waitForJob(host, started.job_id);
  const elapsed = Date.now() - cancelledAt;

  expect(job.status).toBe('cancelled');
  expect(job.phase).toBe('cancelled');
  expect(job.message).toBe('用户取消任务');
  expect(elapsed).toBeLessThan(450);
  // 取消不能提前释放仍在执行的持有者。
  expect(() => host.ctx.backup.tryAcquireOperation('restore')).toThrow(/已有数据治理操作正在运行/);
  holder.release();

  const next = host.ctx.backup.tryAcquireOperation('prune');
  next.release();
});

// ------------------------------------------------------------------ B04

it('B04 includeAssets=true fails the job when the produced archive is not slot-restorable', async () => {
  const { host } = await setupRealHost();
  const started = await host.invoke('data_governance_run_backup', {
    includeAssets: true, assetTypes: ['images'],
  }) as { job_id: string };
  const job = await waitForJob(host, started.job_id);
  expect(job.status).toBe('failed');
  expect(String(job.error ?? job.message ?? '')).toContain('备份失败');
  expect(String(job.error ?? job.message ?? '')).toContain('备份不是可替换数据槽的完整快照');
});

it('B04 unknown-only assetTypes fall back to the default catalog instead of an empty selection', async () => {
  const { host, root } = await setupRealHost();
  const started = await host.invoke('data_governance_run_backup', {
    includeAssets: true, assetTypes: ['not-a-real-asset-type'],
  }) as { job_id: string };
  const job = await waitForJob(host, started.job_id);
  expect(job.status, String(job.error ?? job.message ?? '')).toBe('completed');
  const result = job.result as { output_path?: string } | undefined;
  const manifest = loadManifest(join(root, String(result?.output_path), 'manifest.json'));
  expect(manifest.coverage).toBeDefined();
  // 默认目录中的资产类型进入覆盖账本（此处无目录 → absent），而不是被标记 excluded。
  expect(manifest.coverage!.domains['asset-root:images']?.status).toBe('absent');
  expect(manifest.coverage!.domains['asset-root:documents']?.status).toBe('absent');
});

// ------------------------------------------------------------------ B08

it('B08 auto_verify acquires the verify lock before listing backups', async () => {
  const { host, root } = await setupRealHost();
  mkdirSync(root, { recursive: true });
  const guard = host.ctx.backup.tryAcquireOperation('backup');
  let settled = false;
  const pending = host.invoke('data_governance_auto_verify_latest_backup');
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(settled).toBe(false);
  guard.release();
  const rejection = await rejectionOf(pending);
  expect(typeof rejection).toBe('string');
  expect(rejection).toContain('没有可用的备份');
});

// ------------------------------------------------------------------ B09

it('B09 health check opens each database read-only with a 5s busy timeout', async () => {
  const profiles: Array<unknown> = [];
  const { host } = await setupStorageServiceHost((instance) => {
    const baseOpen = instance.openFile.bind(instance);
    instance.openFile = (path, options) => {
      if (options?.label === 'health-check') profiles.push(options.profile);
      return baseOpen(path, options);
    };
  });
  const result = await host.invoke('data_governance_run_health_check') as {
    databases: Array<{ id: string; issues: string[] }>;
  };
  expect(profiles).toEqual([{ readonly: true, busyTimeoutMs: 5000 }]);
  const vfs = result.databases.find(database => database.id === 'vfs');
  expect(vfs).toBeDefined();
  expect(vfs!.issues.join('; ')).not.toContain('只读打开失败');
});

it('B09 foreign-key violation survives iterator close instead of becoming a busy error', async () => {
  const { host, activeDir } = await setupStorageServiceHost();
  const vfsPath = join(activeDir, 'databases', 'vfs.db');
  const conn = new Connection(vfsPath, { label: 'fk-violation-fixture', profile: PROFILES.plain });
  try {
    conn.exec(`
      CREATE TABLE fk_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE fk_child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES fk_parent(id));
      PRAGMA foreign_keys=OFF;
      INSERT INTO fk_child(id, parent_id) VALUES (1, 999);
    `);
  } finally { conn.close(); }

  const result = await host.invoke('data_governance_run_health_check') as {
    databases: Array<{ id: string; issues: string[] }>;
  };
  const vfs = result.databases.find(database => database.id === 'vfs');
  expect(vfs).toBeDefined();
  expect(vfs!.issues).toContain('数据库完整性检查失败: 检测到外键约束违规');
  expect(vfs!.issues.join('; ')).not.toContain('busy');
});

// ------------------------------------------------------------------ B10

// Rust backup/mod.rs:5712-5731：每次 list_backups 都对坏清单 warn；verify/restore 同样经由它查找。
it.each([
  ['data_governance_verify_backup', (id: string) => ({ backupId: id })],
  ['data_governance_verify_backup_with_assets', (id: string) => ({ backupId: id })],
  ['data_governance_restore_backup', (id: string) => ({ backupId: id })],
] as const)('B10 %s warns about an unreadable sibling manifest while locating the backup', async (command, argsOf) => {
  const { host, root } = await setupRealHost();
  const warnings: string[] = [];
  host.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      if (message.type === 'warn') warnings.push(message.args.map(String).join(' '));
    },
  });
  mkdirSync(join(root, 'broken-backup'), { recursive: true });
  writeFileSync(join(root, 'broken-backup', 'manifest.json'), '{not json');

  const outcome = await host.invoke(command, argsOf('missing-backup')).then(
    value => value as Record<string, unknown>,
    error => error as unknown,
  );
  if (command === 'data_governance_restore_backup') {
    const job = await waitForJob(host, (outcome as { job_id: string }).job_id);
    expect(job.status).toBe('failed');
    expect(String(job.error ?? job.message ?? '')).toContain('备份不存在: missing-backup');
  } else {
    expect(outcome).toBe('备份不存在: missing-backup');
  }
  expect(warnings.some(text => text.includes('无法加载备份清单') && text.includes('broken-backup'))).toBe(true);
});

function captureLogs(host: TestHost): string[] {
  const logs: string[] = [];
  host.ctx.logger.exporter({
    levels: { default: 3 },
    export(message) { logs.push(`${message.type} ${message.args.map(String).join(' ')}`); },
  });
  return logs;
}

// Rust commands_zip.rs:436-453：未知层级逐项warn并忽略；合法层级继续，全部非法则保原拒绝。
it.for(['mixed', 'all-invalid'] as const)('X6-LP-0080 tiered ZIP export warns about unknown tiers (%s)', async (scenario, { signal }) => {
  const { host } = await setupStorageServiceHost();
  const logs = captureLogs(host);
  const outputPath = join(host.app.dataDir, 'tiered.zip');
  const tiers = scenario === 'mixed' ? ['CoRe', 'TYPO', 'IMPortant', 'OTHER'] : ['TYPO', 'OTHER'];
  const started = await host.invoke<{ job_id: string }>('data_governance_backup_and_export_zip', {
    outputPath, useTiered: true, tiers, includeAssets: false,
  });
  const job = await waitForJob(host, started.job_id, signal);
  if (scenario === 'mixed') {
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ success: true, output_path: outputPath, stats: { use_tiered: true } });
    const zip = await JSZip.loadAsync(readFileSync(outputPath));
    for (const id of ['vfs', 'chat_v2', 'mistakes', 'llm_usage']) expect(zip.file(`${id}.db`)).not.toBeNull();
  } else {
    expect(job.status).toBe('failed');
    expect(job.result).toMatchObject({ success: false, error: '分层备份至少需要一个有效层级' });
    expect(existsSync(outputPath)).toBe(false);
  }
  const guard = host.ctx.backup.tryAcquireOperation('backup');
  guard.release();
  expect(logs.filter(line => line.startsWith('warn [data_governance] 未知分层备份层级:'))).toEqual([
    'warn [data_governance] 未知分层备份层级: typo',
    'warn [data_governance] 未知分层备份层级: other',
  ]);
});

// Rust commands_zip.rs:1583/1891：初次导入与断点恢复的业务失败各有error日志，不能只更新任务。
it('X6-LP-0081 ZIP import logs initial and resumed failures through the real commands', async ({ signal }) => {
  const { host, root } = await setupStorageServiceHost();
  const logs = captureLogs(host);
  const zipPath = join(host.app.dataDir, 'invalid-manifest.zip');
  const archive = new JSZip();
  archive.file('manifest.json', '{}');
  writeFileSync(zipPath, await archive.generateAsync({ type: 'nodebuffer' }));
  const backupId = 'invalid-manifest-import';
  const target = join(root, backupId);
  const diagnostic = '解析清单失败: version 必须是字符串';
  const started = await host.invoke<{ job_id: string }>('data_governance_import_zip', { zipPath, backupId });
  const initial = await waitForJob(host, started.job_id, signal);
  expect(initial.status).toBe('failed');
  expect(initial.result).toMatchObject({ success: false, error: `ZIP 导入失败: ${diagnostic}` });
  expect(existsSync(target)).toBe(false);

  // 使用本次失败实际持久化的checkpoint，不手造Jobs状态或替换导入器。
  const resumed = await host.invoke<{ job_id: string }>('data_governance_resume_backup_job', { jobId: started.job_id });
  expect(resumed.job_id).toBe(started.job_id);
  const retried = await waitForJob(host, resumed.job_id, signal);
  expect(retried.status).toBe('failed');
  expect(retried.result).toMatchObject({ success: false, error: `ZIP 导入失败: ${diagnostic}` });
  expect(readFileSync(join(target, 'manifest.json'), 'utf8')).toBe('{}');
  const guard = host.ctx.backup.tryAcquireOperation('backup');
  guard.release();
  expect(logs.filter(line => line.startsWith('error [data_governance] ZIP 导入'))).toEqual([
    `error [data_governance] ZIP 导入任务失败: ${diagnostic}`,
    `error [data_governance] ZIP 导入失败: ${diagnostic}`,
  ]);
});

// Rust commands_backup.rs:2254 请求 info 在取消结果日志之前。
it('B10 cancel_backup logs the request before the outcome', async () => {
  const { host } = await setupRealHost();
  const logs = captureLogs(host);
  expect(await host.invoke('data_governance_cancel_backup', { jobId: 'missing-job' })).toBe(false);
  const request = logs.indexOf('info [data_governance] 请求取消备份任务: missing-job');
  const outcome = logs.indexOf('warn [data_governance] 备份任务取消请求失败（任务可能已完成或不存在）: missing-job');
  expect(request).toBeGreaterThanOrEqual(0);
  expect(outcome).toBeGreaterThan(request);
});

// Rust commands.rs:829。
it('B10 run_health_check logs its start', async () => {
  const { host } = await setupRealHost();
  const logs = captureLogs(host);
  await host.invoke('data_governance_run_health_check');
  expect(logs.find(line => line.includes('[HealthCheck]'))).toBe('info 🔍 [HealthCheck] 开始运行健康检查...');
});

// Rust commands_backup.rs:1377-1380。
it('B10 check_disk_space logs the space summary', async () => {
  const { host, root } = await setupRealHost();
  writeBackup(root, partialManifest('space-backup'), {});
  mkdirSync(join(host.app.dataDir, 'slots', 'slotB'), { recursive: true });
  const logs = captureLogs(host);
  const result = await host.invoke('data_governance_check_disk_space_for_restore', { backupId: 'space-backup' }) as {
    has_enough_space: boolean; available_bytes: number; required_bytes: number; backup_size: number;
  };
  expect(logs).toContain(
    `info [data_governance] 磁盘空间检查: backup_size=${result.backup_size}, required=${result.required_bytes}, `
    + `available=${result.available_bytes}, enough=${result.has_enough_space}`,
  );
});

// Rust commands_backup.rs:1339-1343 + backup/mod.rs:5705 BackupError::Io。
it('B11 check_disk_space prefixes a backup-list IO failure and logs it as error', async () => {
  const { host, root } = await setupRealHost();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, '..'), { recursive: true });
  writeFileSync(root, 'not a directory');
  const logs = captureLogs(host);
  const rejection = await rejectionOf(host.invoke('data_governance_check_disk_space_for_restore', {
    backupId: 'any-backup',
  }));
  expect(rejection).toBe('获取备份列表失败: IO error: Not a directory (os error 20)');
  expect(logs).toContain('error [data_governance] 获取备份列表失败: IO error: Not a directory (os error 20)');
});

// ------------------------------------------------------------------ B11

// Rust commands.rs:912-920：无唯一键的 FK 引用在 PRAGMA 准备阶段失败，而不是读首行失败。
it('B09 health check keeps the prepare phase for a real foreign-key mismatch', async () => {
  const { host, storage } = await setupStorageServiceHost();
  storage.database('vfs').exec(`
    CREATE TABLE fk_parent (id INTEGER PRIMARY KEY, unindexed TEXT);
    CREATE TABLE fk_child (value TEXT REFERENCES fk_parent(unindexed));
  `);

  const report = await host.invoke('data_governance_run_health_check') as {
    databases: Array<{ id: string; issues: string[] }>;
  };
  const vfs = report.databases.find(db => db.id === 'vfs')!;
  expect(vfs.issues, JSON.stringify(vfs.issues)).toContain(
    '数据库完整性检查失败: foreign_key_check 准备失败: foreign key mismatch - "fk_child" referencing "fk_parent"',
  );
  expect(vfs.issues.join('; ')).not.toContain('foreign_key_check 读取失败');
});

it('B11 check_disk_space reports the canonical missing-backup message', async () => {
  const { host, root } = await setupRealHost();
  mkdirSync(root, { recursive: true });
  const rejection = await rejectionOf(host.invoke('data_governance_check_disk_space_for_restore', {
    backupId: 'missing-backup',
  }));
  expect(typeof rejection).toBe('string');
  expect(rejection).toBe('未找到备份: missing-backup');
});

it('B11 delete_backup keeps the File not found error prefix', async () => {
  const { host, root } = await setupRealHost();
  mkdirSync(root, { recursive: true });
  const rejection = await rejectionOf(host.invoke('data_governance_delete_backup', {
    backupId: 'missing-backup',
  }));
  expect(typeof rejection).toBe('string');
  expect(rejection).toContain('File not found: 备份不存在: missing-backup');
});

it('B11 check_disk_space rejects an inactive slot path that is not a directory', async () => {
  const { host, root } = await setupRealHost();
  const manifest = partialManifest('disk-target', { files: { 'persistent/a.json': 'a' } });
  writeBackup(root, manifest, { 'persistent/a.json': 'a' });
  const inactive = join(host.app.dataDir, 'slots', 'slotB');
  rmSync(inactive, { recursive: true, force: true });
  writeFileSync(inactive, 'not a directory');
  const rejection = await rejectionOf(host.invoke('data_governance_check_disk_space_for_restore', {
    backupId: 'disk-target',
  }));
  expect(typeof rejection).toBe('string');
  expect(rejection).toContain('不是目录');
});

// ------------------------------------------------------------------ X6 crypto staging

// Rust backup/mod.rs:3359-3361、3433-3437：备份不得跳过异常密钥材料并发布成功清单。
// 经 run_backup → createBackup → backupCryptoKeys，真实 F3 屏障负责失败后的释放。
it.each(['oversized-master-key', 'secure-subdirectory'] as const)(
  'X6-AP-0066 crypto staging rejects %s through run_backup without publishing a manifest',
  async (scenario) => {
    const { host, storage } = await setupStorageServiceHost();
    const masterKey = join(host.app.dataDir, '.master_key');
    const unexpected = join(host.app.dataDir, '.secure', 'nested');
    if (scenario === 'oversized-master-key') {
      writeFileSync(masterKey, 'A'.repeat(4097));
    } else {
      mkdirSync(unexpected, { recursive: true });
    }

    const started = await host.invoke('data_governance_run_backup', { includeAssets: false }) as {
      job_id: string;
    };
    const job = await waitForJob(host, started.job_id);

    expect(job.status).toBe('failed');
    const message = String(job.error ?? job.message ?? '');
    if (scenario === 'oversized-master-key') {
      expect(message).toContain(`备份 .master_key 失败: 备份密钥文件过大: ${masterKey} (4097 bytes)`);
      expect(readFileSync(masterKey, 'utf8')).toBe('A'.repeat(4097));
    } else {
      expect(message).toContain(`安全存储包含非常规条目，拒绝备份: ${unexpected}`);
      expect(existsSync(unexpected)).toBe(true);
    }
    expect(await host.invoke('data_governance_get_backup_list')).toEqual([]);
    expect(() => storage.database('mistakes')).not.toThrow();
    expect(() => storage.database('vfs')).not.toThrow();
  },
);
