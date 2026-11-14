/**
 * V04-01 自动备份调度器（Rust `backup_config.rs:276–711`）：假计时器 + 注入时钟，真实 F3 存储服务、
 * 真实备份/ZIP 流程，设置读写走 `ctx.settings`。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import { ZipFileReader } from '../../../platform/zip/index.ts';
import {
  AUTO_BACKUP_CHECK_INTERVAL_MS, AUTO_BACKUP_INITIAL_DELAY_MS, AUTO_BACKUP_RUNNING, createAutoBackupScheduler,
  type AutoBackupScheduler,
} from '../src/auto-backup-scheduler.ts';
import type { BackupVerifyResult } from '../src/backup-manager.ts';
import { Jobs } from '../src/jobs.ts';
import { Operations } from '../src/operations.ts';
import { createBackupHost, createDatabaseFile } from './helpers.ts';

/** 只替换调度器剥离密钥后的那一次校验；createBackup 内部的校验走模块内绑定，不受影响。 */
const portableVerify = vi.hoisted(() => ({ result: null as BackupVerifyResult | null }));
vi.mock('../src/backup-manager.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/backup-manager.ts')>();
  return {
    ...actual,
    verifyWithAssets: async (...args: Parameters<typeof actual.verifyWithAssets>) =>
      portableVerify.result ?? actual.verifyWithAssets(...args),
  };
});

const T0 = parseRfc3339('2026-11-07T00:00:00+00:00')!.epochNanos;
const MS = 1_000_000n;
const SECOND = 1_000_000_000n;
const HOUR = 3_600n * SECOND;
/** 首次检查时刻：T0 + 120 秒。 */
const T1 = T0 + 120n * SECOND;
const CONFIG_KEY = 'backup.config';
const STATUS_KEY = 'backup.auto_backup_status';
const LAST_KEY = 'backup.last_auto_backup_time';

interface Env {
  host: TestHost;
  settings: Map<string, string>;
  jobs: Jobs;
  scheduler: AutoBackupScheduler;
  spawned: Promise<unknown>[];
  logs: Array<{ level: string; text: string }>;
  activeDir: string;
  backupsDir: string;
  /** 注入时钟；`advance` 同步推进它和假计时器，单独改它只改变调度器看到的当前时间。 */
  clock: { now: bigint };
  advance(ms: number): Promise<void>;
  drain(): Promise<void>;
}

const hosts: TestHost[] = [];
const storages: StorageServiceImpl[] = [];
const schedulers: AutoBackupScheduler[] = [];
afterEach(async () => {
  portableVerify.result = null;
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  vi.useRealTimers();
  if (AUTO_BACKUP_RUNNING.isRunning()) AUTO_BACKUP_RUNNING.release();
  for (const host of hosts.splice(0)) await host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
});

async function setup(config: Record<string, unknown> | null = null): Promise<Env> {
  let storage!: StorageServiceImpl;
  const { host, settings } = await createBackupHost({
    storageFactory: dataDir => {
      storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      return storage;
    },
  });
  storages.push(storage);
  hosts.push(host);
  const activeDir = storage.locations.activeDir;
  createDatabaseFile(join(activeDir, 'databases', 'vfs.db'));
  createDatabaseFile(join(activeDir, 'mistakes.db'));
  createDatabaseFile(join(activeDir, 'llm_usage.db'));
  createDatabaseFile(join(activeDir, 'chat_v2.db'));
  if (config !== null) settings.set(CONFIG_KEY, JSON.stringify(config));

  const spawned: Promise<unknown>[] = [];
  host.ctx.provide('backgroundTasks', {
    get size() { return 0; },
    spawn<T>(task: () => Promise<T>): Promise<T> {
      const pending = task();
      spawned.push(pending);
      return pending;
    },
    async shutdown() {},
  });
  const logs: Array<{ level: string; text: string }> = [];
  host.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
    logs.push({ level: String(message.type), text: message.args.map(String).join(' ') });
  } });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const clock = { now: T0 };
  const jobs = new Jobs(host.ctx);
  const scheduler = createAutoBackupScheduler({
    ctx: host.ctx, jobs, operations: new Operations({ ctx: host.ctx }), now: () => clock.now,
  });
  schedulers.push(scheduler);
  return {
    host, settings, jobs, scheduler, spawned, logs, activeDir, clock,
    backupsDir: join(host.app.dataDir, 'recovery', 'backups'),
    async advance(ms: number) {
      clock.now += BigInt(ms) * MS;
      await vi.advanceTimersByTimeAsync(ms);
    },
    async drain() {
      for (let settled = 0; settled < spawned.length;) {
        const batch = spawned.slice(settled);
        await Promise.all(batch);
        settled += batch.length;
      }
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

function enabled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { backupDirectory: null, autoBackupEnabled: true, autoBackupIntervalHours: 24, maxBackupCount: 5, slimBackup: false, ...overrides };
}

function status(env: Env): Record<string, unknown> | null {
  const raw = env.settings.get(STATUS_KEY);
  return raw === undefined ? null : JSON.parse(raw) as Record<string, unknown>;
}

function autoZips(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith('auto-backup-') && name.endsWith('.zip')).sort() : [];
}

function stagingDirs(env: Env): string[] {
  return readdirSync(env.activeDir).filter(name => name.startsWith('auto-backup-staging-'));
}

async function zipManifest(path: string): Promise<Record<string, unknown>> {
  const reader = await ZipFileReader.open(path);
  try { return JSON.parse((await reader.readEntry(reader.find('manifest.json')!)).toString('utf8')) as Record<string, unknown>; }
  finally { await reader.close(); }
}

async function firstCheck(env: Env): Promise<void> {
  env.scheduler.start();
  await env.advance(AUTO_BACKUP_INITIAL_DELAY_MS);
  await env.drain();
}

it('V04-01 the first check runs 120 s after start, then 3600 s after the previous check', async () => {
  const env = await setup();
  env.scheduler.start();
  expect(env.logs.some(log => log.text === '[AutoBackup] 自动备份调度器已启动')).toBe(true);
  await env.advance(AUTO_BACKUP_INITIAL_DELAY_MS - 1);
  expect(env.spawned).toHaveLength(0);
  await env.advance(1);
  expect(env.spawned).toHaveLength(1);
  await env.drain();
  await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS - 1);
  expect(env.spawned).toHaveLength(1);
  await env.advance(1);
  expect(env.spawned).toHaveLength(2);
  // start() 只生效一次。
  env.scheduler.start();
  await env.drain();
  await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS);
  expect(env.spawned).toHaveLength(3);
});

it('V04-01 a due check without a previous time publishes auto-backup-YYYYmmdd-HHMMSS.zip and writes the Rust status', async () => {
  const env = await setup(enabled());
  await firstCheck(env);

  const zipName = 'auto-backup-20261107-000200.zip';
  expect(autoZips(env.backupsDir)).toEqual([zipName]);
  expect(env.settings.get(LAST_KEY)).toBe('2026-11-07T00:02:00+00:00');
  const jobId = status(env)!.lastJobId as string;
  expect(env.settings.get(STATUS_KEY)).toBe(JSON.stringify({
    lastAttemptAt: '2026-11-07T00:02:00+00:00',
    lastSuccessAt: '2026-11-07T00:02:00+00:00',
    lastError: null,
    nextDueAt: '2026-11-08T00:02:00+00:00',
    lastJobId: jobId,
  }));
  expect(env.jobs.getJob(jobId)).toMatchObject({
    kind: 'export', status: 'completed', message: `自动备份完成: ${zipName}`,
    result: {
      success: true, output_path: zipName, resolved_path: null,
      message: '自动便携归档已发布（未加密 ZIP 不含密钥材料，导入后不能整槽恢复；恢复后需重新输入 API 凭据）',
      error: null, duration_ms: null,
      stats: { automatic: true, recovery_kind: 'partial_archive', restorable: false },
      requires_restart: false, checkpoint_path: null, resumable_job_id: null,
    },
  });
  const progress = (env.host.eventsNamed('backup-job-progress') as Array<Record<string, unknown>>)
    .filter(event => event.job_id === jobId && event.status === 'running')
    .map(event => [event.phase, event.progress, event.message, event.processed_items, event.total_items]);
  expect(progress).toEqual([
    ['scan', 2, '自动灾备：正在建立一致性快照', 0, 4],
    ['verify', 65, '一致性屏障已解除；资产与数据库必须同属一个快照，因此快照阶段无法进一步缩短', 2, 4],
    ['compress', 80, '一致性屏障已解除；正在压缩并发布自动备份', 3, 4],
  ]);
  expect(await zipManifest(join(env.backupsDir, zipName))).toMatchObject({ key_policy: 'excluded_portable' });
  // 暂存目录、快照屏障与全局租约都已释放。
  expect(stagingDirs(env)).toEqual([]);
  expect(() => env.host.ctx.storage.database('mistakes')).not.toThrow();
  env.host.ctx.backup.tryAcquireOperation('backup').release();
  expect(env.logs.map(log => log.text)).toEqual(expect.arrayContaining([
    '[AutoBackup] 开始执行自动备份...', `[AutoBackup] 自动备份完成: ${zipName}`,
  ]));
});

it('RF-W30-auto-backup-operation-guard: the attempt holds the full data-governance guard (current operation + cross-process lock)', async () => {
  const env = await setup(enabled());
  const lockPath = join(env.host.app.dataDir, 'recovery', '.data-governance-operation.lock');
  const during: Array<{ lock: Record<string, unknown> | null; busy: string }> = [];
  env.host.ctx.backendEvents.listen('backup-job-progress', payload => {
    const event = payload as Record<string, unknown>;
    if (event.status !== 'running' || event.phase !== 'compress') return;
    let busy = '';
    try { env.host.ctx.backup.tryAcquireOperation('sync').release(); }
    catch (error) { busy = error instanceof Error ? error.message : String(error); }
    during.push({ lock: existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown> : null, busy });
  });
  await firstCheck(env);
  const jobId = status(env)!.lastJobId as string;
  expect(during).toEqual([{
    lock: expect.objectContaining({ operation_id: jobId, kind: 'auto_backup' }),
    busy: `已有数据治理操作正在运行（当前 AutoBackup，operation_id=${jobId}）`,
  }]);
  expect(existsSync(lockPath)).toBe(false);
  expect(autoZips(env.backupsDir)).toEqual(['auto-backup-20261107-000200.zip']);
});

it('V04-01 a previous backup exactly one interval old is due: publishes a ZIP and moves last time and next_due_at to this completion', async () => {
  const env = await setup(enabled());
  // 24:00:00 elapsed: num_hours() = 24 >= interval, due (the 23:59:59 control is the next case).
  env.settings.set(LAST_KEY, toRfc3339(T1 - 24n * HOUR));
  // 完成时间晚于尝试时间 5 秒：LAST 与 next_due_at 必须取完成时刻。ZIP 名在 compress 阶段之前取时间。
  env.host.ctx.backendEvents.listen('backup-job-progress', payload => {
    const event = payload as Record<string, unknown>;
    if (event.status === 'running' && event.phase === 'compress') env.clock.now += 5n * SECOND;
  });
  await firstCheck(env);

  const zipName = 'auto-backup-20261107-000200.zip';
  expect(autoZips(env.backupsDir)).toEqual([zipName]);
  expect(env.settings.get(LAST_KEY)).toBe('2026-11-07T00:02:05+00:00');
  const jobId = status(env)!.lastJobId as string;
  expect(env.settings.get(STATUS_KEY)).toBe(JSON.stringify({
    lastAttemptAt: '2026-11-07T00:02:00+00:00',
    lastSuccessAt: '2026-11-07T00:02:05+00:00',
    lastError: null,
    nextDueAt: '2026-11-08T00:02:05+00:00',
    lastJobId: jobId,
  }));
  expect(env.jobs.listJobs()).toHaveLength(1);
  expect(env.jobs.getJob(jobId)).toMatchObject({ status: 'completed', message: `自动备份完成: ${zipName}` });
});

it('V04-01 a check that is not due skips and records next_due_at = last + interval; an unchanged value is not rewritten', async () => {
  const env = await setup(enabled());
  // 23:59:59 elapsed: chrono num_hours() truncates to 23, not due.
  const last = T1 - 24n * HOUR + SECOND;
  env.settings.set(LAST_KEY, toRfc3339(last));
  const save = vi.spyOn(env.host.ctx.settings, 'save');
  await firstCheck(env);
  expect(autoZips(env.backupsDir)).toEqual([]);
  expect(env.jobs.listJobs()).toEqual([]);
  expect(status(env)).toEqual({
    lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextDueAt: toRfc3339(last + 24n * HOUR), lastJobId: null,
  });
  expect(save).toHaveBeenCalledTimes(1);

  env.settings.set(CONFIG_KEY, JSON.stringify(enabled({ autoBackupIntervalHours: 48 })));
  await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS);
  await env.drain();
  // 配置每轮重新读取：新间隔在下一轮生效。
  expect(status(env)!.nextDueAt).toBe(toRfc3339(last + 48n * HOUR));
  expect(save).toHaveBeenCalledTimes(2);
  await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS);
  await env.drain();
  expect(env.spawned).toHaveLength(3);
  expect(save).toHaveBeenCalledTimes(2);
});

it('V04-01 after the first success, hourly checks publish nothing for 23 rounds and the 24th round publishes the second ZIP', async () => {
  const env = await setup(enabled({ maxBackupCount: 2 }));
  const older = 'auto-backup-20260101-000000.zip';
  mkdirSync(env.backupsDir, { recursive: true });
  writeFileSync(join(env.backupsDir, older), older);
  utimesSync(join(env.backupsDir, older), 1_700_000_000, 1_700_000_000);
  await firstCheck(env);
  const first = 'auto-backup-20261107-000200.zip';
  expect(autoZips(env.backupsDir)).toEqual([older, first]);
  const firstJob = status(env)!.lastJobId as string;
  // 已结束的任务 60 秒后移出内存，用进度事件里出现过的任务 id 判断是否发起过新尝试。
  const attemptedJobs = (): string[] => [...new Set(
    (env.host.eventsNamed('backup-job-progress') as Array<{ job_id: string }>).map(event => event.job_id))];

  for (let round = 1; round < 24; round++) {
    await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS);
    await env.drain();
    expect(env.spawned).toHaveLength(1 + round);
    expect(autoZips(env.backupsDir)).toEqual([older, first]);
  }
  expect(attemptedJobs()).toEqual([firstJob]);
  expect(env.settings.get(LAST_KEY)).toBe('2026-11-07T00:02:00+00:00');
  expect(status(env)).toMatchObject({
    lastAttemptAt: '2026-11-07T00:02:00+00:00', lastSuccessAt: '2026-11-07T00:02:00+00:00',
    nextDueAt: '2026-11-08T00:02:00+00:00', lastJobId: firstJob,
  });

  await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS);
  await env.drain();
  expect(env.spawned).toHaveLength(25);
  const second = 'auto-backup-20261108-000200.zip';
  // max_backup_count=2 照常轮转：最旧的自动备份被删除，首个 ZIP 保留。
  expect(autoZips(env.backupsDir)).toEqual([first, second]);
  expect(env.logs).toContainEqual({ level: 'info', text: `[AutoBackup] 删除旧备份: ${join(env.backupsDir, older)}` });
  expect(env.settings.get(LAST_KEY)).toBe('2026-11-08T00:02:00+00:00');
  const current = status(env)!;
  expect(current).toEqual({
    lastAttemptAt: '2026-11-08T00:02:00+00:00', lastSuccessAt: '2026-11-08T00:02:00+00:00', lastError: null,
    nextDueAt: '2026-11-09T00:02:00+00:00', lastJobId: current.lastJobId,
  });
  expect(attemptedJobs()).toEqual([firstJob, current.lastJobId]);
  expect(env.jobs.getJob(current.lastJobId as string)).toMatchObject({ status: 'completed', message: `自动备份完成: ${second}` });
});

it('V04-01 a malformed last backup time is treated as missing: warn, then back up', async () => {
  const env = await setup(enabled());
  env.settings.set(LAST_KEY, 'yesterday');
  await firstCheck(env);
  expect(env.logs).toContainEqual({ level: 'warn', text: '[AutoBackup] 解析上次备份时间失败: input contains invalid characters' });
  expect(autoZips(env.backupsDir)).toEqual(['auto-backup-20261107-000200.zip']);
  expect(env.settings.get(LAST_KEY)).toBe('2026-11-07T00:02:00+00:00');
});

it('V04-01 a clock rolled back behind the last backup time is not due; next_due_at stays last + interval', async () => {
  const env = await setup(enabled());
  const last = T1 + 10n * HOUR;
  env.settings.set(LAST_KEY, toRfc3339(last));
  await firstCheck(env);
  expect(autoZips(env.backupsDir)).toEqual([]);
  expect(env.jobs.listJobs()).toEqual([]);
  expect(status(env)!.nextDueAt).toBe(toRfc3339(last + 24n * HOUR));
});

it('V04-01 rotation keeps the newest max_backup_count auto-backup ZIPs and never touches other files', async () => {
  const env = await setup(enabled({ maxBackupCount: 2 }));
  mkdirSync(join(env.backupsDir, 'backup-manual'), { recursive: true });
  const files = ['auto-backup-20260101-000000.zip', 'auto-backup-20260102-000000.zip', 'manual-backup.zip', 'notes.txt'];
  files.forEach((name, index) => {
    const path = join(env.backupsDir, name);
    writeFileSync(path, name);
    utimesSync(path, 1_700_000_000 + index, 1_700_000_000 + index);
  });
  await firstCheck(env);
  expect(readdirSync(env.backupsDir).sort()).toEqual([
    'auto-backup-20260102-000000.zip', 'auto-backup-20261107-000200.zip', 'backup-manual', 'manual-backup.zip', 'notes.txt',
  ]);
  expect(env.logs).toContainEqual({
    level: 'info', text: `[AutoBackup] 删除旧备份: ${join(env.backupsDir, 'auto-backup-20260101-000000.zip')}`,
  });
});

it('V04-01 a check is skipped while AUTO_BACKUP_RUNNING is held, and runs on the next round', async () => {
  const env = await setup(enabled());
  expect(AUTO_BACKUP_RUNNING.tryAcquire()).toBe(true);
  await firstCheck(env);
  expect(env.logs).toContainEqual({ level: 'debug', text: '[AutoBackup] 上一次备份仍在运行，跳过本次检查' });
  expect(env.jobs.listJobs()).toEqual([]);
  expect(env.settings.has(STATUS_KEY)).toBe(false);
  AUTO_BACKUP_RUNNING.release();
  await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS);
  await env.drain();
  expect(autoZips(env.backupsDir)).toEqual(['auto-backup-20261107-010200.zip']);
});

it('V04-01 waits behind a running data-governance operation; the next check is 3600 s after it finishes', async () => {
  const env = await setup(enabled());
  const guard = env.host.ctx.backup.tryAcquireOperation('restore');
  env.scheduler.start();
  await env.advance(AUTO_BACKUP_INITIAL_DELAY_MS);
  // Rust 在等待许可前已写入尝试状态。
  expect(status(env)).toMatchObject({ lastAttemptAt: '2026-11-07T00:02:00+00:00', lastSuccessAt: null, lastError: null });
  await env.advance(10_000);
  expect(env.spawned).toHaveLength(1);
  expect(autoZips(env.backupsDir)).toEqual([]);
  guard.release();
  await env.drain();
  expect(autoZips(env.backupsDir)).toEqual(['auto-backup-20261107-000210.zip']);
  await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS - 1);
  expect(env.spawned).toHaveLength(1);
  await env.advance(1);
  expect(env.spawned).toHaveLength(2);
});

it('V04-01 disabling auto backup clears next_due_at only when it was set', async () => {
  const env = await setup(enabled({ autoBackupEnabled: false }));
  env.settings.set(STATUS_KEY, JSON.stringify({
    lastAttemptAt: 'a', lastSuccessAt: 'b', lastError: 'c', nextDueAt: 'd', lastJobId: 'e',
  }));
  const save = vi.spyOn(env.host.ctx.settings, 'save');
  await firstCheck(env);
  expect(env.settings.get(STATUS_KEY)).toBe(JSON.stringify({
    lastAttemptAt: 'a', lastSuccessAt: 'b', lastError: 'c', nextDueAt: null, lastJobId: 'e',
  }));
  await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS);
  await env.drain();
  expect(save).toHaveBeenCalledTimes(1);
  expect(autoZips(env.backupsDir)).toEqual([]);
  expect(env.jobs.listJobs()).toEqual([]);
});

it('RF-W30-auto-backup-job-stuck-running: a status read failure after the job is created fails the job instead of leaving it running', async () => {
  const env = await setup(enabled());
  const realGet = env.settings.get.bind(env.settings);
  env.settings.get = (key: string) => {
    if (key === STATUS_KEY) throw new Error('disk I/O error');
    return realGet(key);
  };
  await firstCheck(env);
  const error = '数据库错误: disk I/O error';
  expect(env.jobs.listJobs()).toEqual([expect.objectContaining({
    status: 'failed', message: `读取自动备份状态失败: ${error}`,
  })]);
  expect(env.logs).toContainEqual({ level: 'warn', text: `[AutoBackup] 自动备份检查失败: ${error}` });
  expect(env.settings.has(STATUS_KEY)).toBe(false);
  expect(autoZips(env.backupsDir)).toEqual([]);
  env.host.ctx.backup.tryAcquireOperation('backup').release();
});

it('RF-W30-auto-backup-staging-sweep: staging directories left by an interrupted run are removed under the guard before the next attempt', async () => {
  const env = await setup(enabled());
  const leftover = join(env.activeDir, 'auto-backup-staging-crashed');
  mkdirSync(join(leftover, 'backup', 'crypto'), { recursive: true });
  writeFileSync(join(leftover, 'backup', 'crypto', 'master.key'), 'secret');
  writeFileSync(join(env.activeDir, 'auto-backup-staging-note.txt'), 'not a directory');
  mkdirSync(join(env.activeDir, 'manual-staging-keep'));
  await firstCheck(env);
  expect(existsSync(leftover)).toBe(false);
  expect(existsSync(join(env.activeDir, 'manual-staging-keep'))).toBe(true);
  expect(stagingDirs(env)).toEqual(['auto-backup-staging-note.txt']);
  expect(env.logs).toContainEqual({ level: 'info', text: `[AutoBackup] 清理遗留暂存目录: ${leftover}` });
  expect(autoZips(env.backupsDir)).toEqual(['auto-backup-20261107-000200.zip']);
});

function seedSecrets(env: Env): void {
  writeFileSync(join(env.host.app.dataDir, '.master_key'), Buffer.alloc(32, 7).toString('base64'));
}

async function zipEntries(path: string): Promise<string[]> {
  const reader = await ZipFileReader.open(path);
  try { return reader.entries.map(entry => entry.name); }
  finally { await reader.close(); }
}

it('V04-01 key material is stripped from the published ZIP and the portable archive is re-verified (backup_config.rs:496-510)', async () => {
  const env = await setup(enabled());
  seedSecrets(env);
  await firstCheck(env);
  const zip = join(env.backupsDir, 'auto-backup-20261107-000200.zip');
  expect(env.logs).toContainEqual({ level: 'info', text: '[AutoBackup] 已从备份产物剥离 1 个敏感密钥条目（ZIP 不包含 API 凭据解密材料）' });
  const secretShaped = /(^|\/)(crypto|\.secure|\.master_key|\.key_seed)(\/|$)/i;
  expect((await zipEntries(zip)).filter(name => secretShaped.test(name))).toEqual([]);
  const manifest = await zipManifest(zip);
  expect((manifest.files as Array<{ path: string }>).filter(file => secretShaped.test(file.path))).toEqual([]);
  expect(env.jobs.getJob(status(env)!.lastJobId as string)).toMatchObject({ status: 'completed' });
});

it('RF-W30-auto-backup-portable-verify-result: an invalid post-strip verification fails the attempt instead of publishing the archive', async () => {
  const env = await setup(enabled());
  seedSecrets(env);
  portableVerify.result = {
    isValid: false,
    databaseErrors: ['vfs.db 校验和不匹配'],
    assetErrors: [{ path: 'assets/a.png', error_type: 'checksum_mismatch', message: '内容已变化' }],
  };
  await firstCheck(env);
  const error = '便携归档剥离密钥后校验失败: vfs.db 校验和不匹配; 资产校验失败 [assets/a.png]: 内容已变化';
  const current = status(env)!;
  expect(current).toMatchObject({ lastError: error, lastSuccessAt: null, nextDueAt: '2026-11-07T01:02:00+00:00' });
  expect(env.jobs.getJob(current.lastJobId as string)).toMatchObject({ status: 'failed', message: error });
  expect(autoZips(env.backupsDir)).toEqual([]);
  expect(env.settings.has(LAST_KEY)).toBe(false);
  expect(stagingDirs(env)).toEqual([]);
});

it('V04-01 a failed attempt writes last_error, retries in one hour and fails the job with the same message', async () => {
  const missing = '/tmp/W30-auto-backup-missing-destination';
  const env = await setup(enabled({ backupDirectory: missing }));
  await firstCheck(env);
  const error = `自定义备份目录不可用: ${missing}。为避免误导，未回退到默认目录`;
  const current = status(env)!;
  expect(current).toEqual({
    lastAttemptAt: '2026-11-07T00:02:00+00:00', lastSuccessAt: null, lastError: error,
    nextDueAt: '2026-11-07T01:02:00+00:00', lastJobId: current.lastJobId,
  });
  expect(env.settings.has(LAST_KEY)).toBe(false);
  expect(env.jobs.getJob(current.lastJobId as string)).toMatchObject({ status: 'failed', message: error, result: { error } });
  expect(env.logs).toContainEqual({ level: 'warn', text: `[AutoBackup] 自动备份检查失败: ${error}` });
  expect(existsSync(missing)).toBe(false);
  expect(stagingDirs(env)).toEqual([]);
  env.host.ctx.backup.tryAcquireOperation('backup').release();
});

it('V04-01 after a failed attempt the check 3600 s later retries; once the destination exists it publishes and clears last_error', async () => {
  const env = await setup();
  // 同一失败构造（自定义目录不存在），路径放在测试宿主自己的数据目录里，创建后随宿主删除。
  const destination = join(env.host.app.dataDir, 'custom-backups');
  env.settings.set(CONFIG_KEY, JSON.stringify(enabled({ backupDirectory: destination })));
  await firstCheck(env);
  const error = `自定义备份目录不可用: ${destination}。为避免误导，未回退到默认目录`;
  const failedJob = status(env)!.lastJobId as string;
  expect(status(env)).toMatchObject({ lastError: error, lastSuccessAt: null, nextDueAt: '2026-11-07T01:02:00+00:00' });
  expect(env.jobs.getJob(failedJob)).toMatchObject({ status: 'failed', message: error });
  expect(env.settings.has(LAST_KEY)).toBe(false);

  mkdirSync(destination);
  await env.advance(AUTO_BACKUP_CHECK_INTERVAL_MS - 1);
  expect(env.spawned).toHaveLength(1);
  await env.advance(1);
  await env.drain();
  expect(env.spawned).toHaveLength(2);
  const zipName = 'auto-backup-20261107-010200.zip';
  expect(autoZips(destination)).toEqual([zipName]);
  expect(env.settings.get(LAST_KEY)).toBe('2026-11-07T01:02:00+00:00');
  const current = status(env)!;
  expect(current).toEqual({
    lastAttemptAt: '2026-11-07T01:02:00+00:00', lastSuccessAt: '2026-11-07T01:02:00+00:00', lastError: null,
    nextDueAt: '2026-11-08T01:02:00+00:00', lastJobId: current.lastJobId,
  });
  expect(current.lastJobId).not.toBe(failedJob);
  expect(env.jobs.getJob(current.lastJobId as string)).toMatchObject({ status: 'completed', message: `自动备份完成: ${zipName}` });
  expect(env.jobs.getJob(failedJob)).toMatchObject({ status: 'failed', message: error });
  expect(stagingDirs(env)).toEqual([]);
});

it('V04-01 stop() before the first check: nothing ever fires', async () => {
  const env = await setup(enabled());
  env.scheduler.start();
  await env.advance(AUTO_BACKUP_INITIAL_DELAY_MS - 1);
  env.scheduler.stop();
  await env.advance(3 * AUTO_BACKUP_CHECK_INTERVAL_MS);
  expect(env.spawned).toHaveLength(0);
  expect(env.settings.size).toBe(1);
});

it('V04-01 stop() while the attempt waits for the operation guard cancels it without leaving files, locks or failure status', async () => {
  const env = await setup(enabled());
  const guard = env.host.ctx.backup.tryAcquireOperation('restore');
  env.scheduler.start();
  await env.advance(AUTO_BACKUP_INITIAL_DELAY_MS);
  const jobId = status(env)!.lastJobId as string;
  env.scheduler.stop();
  await env.advance(200);
  await env.drain();
  expect(env.jobs.getJob(jobId)).toMatchObject({ status: 'cancelled', message: '自动备份已中止：应用正在退出' });
  expect(status(env)).toMatchObject({ lastAttemptAt: '2026-11-07T00:02:00+00:00', lastSuccessAt: null, lastError: null });
  expect(env.settings.has(LAST_KEY)).toBe(false);
  expect(env.logs.some(log => log.level === 'warn' && log.text.startsWith('[AutoBackup]'))).toBe(false);
  guard.release();
  // 取消的排队位置不会在之后补授租约。
  env.host.ctx.backup.tryAcquireOperation('backup').release();
  expect(stagingDirs(env)).toEqual([]);
  expect(AUTO_BACKUP_RUNNING.isRunning()).toBe(false);
  await env.advance(3 * AUTO_BACKUP_CHECK_INTERVAL_MS);
  expect(env.spawned).toHaveLength(1);
  expect(autoZips(env.backupsDir)).toEqual([]);
});
