/**
 * V04-01 接线：官方 desktop profile 装配后，自动备份调度器以 F3 finalizer 注册，启动收尾后 120 秒首次检查；
 * 恢复模式下组合根跳过 finalizer，调度器不启动（Rust `lib.rs:953-959` 恢复预检后提前返回，到不了 `:1680`）；
 * 备份插件卸载后计时器随 ctx 清除（Rust `lib.rs:1680–1693` 在 setup 中 spawn 调度器）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { ContractSet } from '../../../kernel/contracts.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { HOST_PROTOCOL_VERSION, type HostToMain, type MainToHostMessage } from '../../../kernel/protocol.ts';
import { serveHostCore, type HostSession, type HostTransport } from '../../../kernel/serve.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import backupPlugin from '../index.ts';
import { createBackupHost } from './helpers.ts';

const FINALIZER = 'backup.auto-backup-scheduler';
const STATUS_KEY = 'backup.auto_backup_status';
const STATUS_WITH_DUE = JSON.stringify({
  lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextDueAt: '2026-11-08T00:00:00+00:00', lastJobId: null,
});
const STATUS_CLEARED = JSON.stringify({
  lastAttemptAt: null, lastSuccessAt: null, lastError: null, nextDueAt: null, lastJobId: null,
});

let host: TestHost | undefined;
let session: HostSession | undefined;
let root: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await host?.dispose();
  host = undefined;
  await session?.shutdown();
  session = undefined;
  vi.unstubAllEnvs();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

function stubProfileEnv(): string {
  root = mkdtempSync(join(tmpdir(), 'W30-auto-backup-profile-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  const dataDir = join(root, 'app');
  mkdirSync(join(dataDir, 'slots', 'slotA'), { recursive: true });
  return dataDir;
}

/** 主进程一侧：shell 请求一律回复 null（同 `createTestHost({ shell: () => null })`）。 */
class ShellAnsweringTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];
  send(message: HostToMain): void {
    this.sent.push(message);
    if (message.kind === 'shell-request') {
      const { id } = message;
      queueMicrotask(() => this.deliver({ kind: 'shell-result', id, ok: true, value: null }));
    }
  }
  onMessage(listener: (message: unknown) => void): void { this.listeners.push(listener); }
  onClose(): void {}
  close(): void {}
  deliver(message: MainToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

it('V04-01 the desktop profile registers the auto-backup scheduler; its first check runs 120 s after the startup finalizers', async () => {
  const dataDir = stubProfileEnv();
  host = await createTestHost({ app: { dataDir, platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux'), shell: () => null });
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded.map(entry => entry.id)).not.toContain('dstu.backup');
  const storage = host.ctx.storage;
  expect(storage.finalizerNames()).toContain(FINALIZER);

  // 默认配置关闭自动备份：首次检查只清掉 next_due_at（真实 settings 表）。
  host.ctx.settings.save(STATUS_KEY, STATUS_WITH_DUE);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const completed = (await storage.runStartupFinalizers()).completed;
  expect(completed.indexOf(FINALIZER)).toBeGreaterThan(completed.indexOf('backup.resumable-jobs'));
  host.ctx.get('startupGate')!.markStartupReady();
  await vi.advanceTimersByTimeAsync(119_999);
  await settle();
  expect(host.ctx.settings.get(STATUS_KEY)).toBe(STATUS_WITH_DUE);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(host.ctx.settings.get(STATUS_KEY)).toBe(STATUS_CLEARED);
}, 120_000);

it('V04-01 in startup recovery mode the composition root skips finalizers: the scheduler never starts and no check runs', async () => {
  const dataDir = stubProfileEnv();
  // 真实恢复路径：持久化的启动事故指针损坏（同 storage/tests/startup-gate-command.test.ts）。
  mkdirSync(join(dataDir, 'recovery'), { recursive: true });
  writeFileSync(join(dataDir, 'recovery', 'current-startup-incident.json'), '{');
  const transport = new ShellAnsweringTransport();
  const logs: string[] = [];
  session = serveHostCore(transport, {
    contracts: () => ContractSet.fromDirectory(),
    acl: () => CapabilityAcl.fromDirectory('linux'),
    onRuntime: runtime => {
      runtime.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
        logs.push(format(...(message.args as unknown[])));
      } });
    },
    load: async runtime => {
      await loadStartupProfile(runtime, { official: OFFICIAL_PROFILE_PATH });
      // 组合根的启动收尾（finalizer + gate）在假计时器下进行，调度器若启动，其 120 秒计时器可被推进。
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    },
  });
  transport.deliver({
    kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: dataDir, appVersion: '0.0.0-test', platform: 'linux', debug: true,
  });
  const runtime = (await session.ready)!;
  expect(runtime).not.toBeNull();
  expect(transport.sent.some(message => message.kind === 'ready')).toBe(true);
  expect(runtime.ctx.dataSpace.status().recovery_required).toBe(true);
  expect(runtime.ctx.get('startupGate')!.isStartupReady()).toBe(true);
  // 备份插件照常装配并注册了调度器 finalizer，只是组合根没有运行它。
  expect(runtime.degradedPlugins().map(entry => entry.id)).not.toContain('dstu.backup');
  expect(runtime.ctx.storage.finalizerNames()).toContain(FINALIZER);

  await vi.advanceTimersByTimeAsync(120_000 + 3_600_000);
  await settle();
  // 启动日志与检查（恢复模式下业务库关闭，检查只会以 warn 失败）都不应出现。
  expect(logs.filter(line => line.includes('[AutoBackup]'))).toEqual([]);
}, 120_000);

it('V04-01 unloading the backup plugin clears the scheduler timer: no check fires afterwards', async () => {
  const created = await createBackupHost();
  host = created.host;
  created.settings.set(STATUS_KEY, STATUS_WITH_DUE);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const storage = host.ctx.get('storage') as unknown as { runStartupFinalizers(): Promise<{ completed: readonly string[] }> };
  expect((await storage.runStartupFinalizers()).completed).toContain(FINALIZER);
  await host.unload('dstu.backup');
  await vi.advanceTimersByTimeAsync(10 * 3_600_000);
  await settle();
  expect(created.settings.get(STATUS_KEY)).toBe(STATUS_WITH_DUE);
});

it('V04-01 the same plugin without unload does run its first check (control for the unload case)', async () => {
  const created = await createBackupHost();
  host = created.host;
  created.settings.set(STATUS_KEY, STATUS_WITH_DUE);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const storage = host.ctx.get('storage') as unknown as { runStartupFinalizers(): Promise<{ completed: readonly string[] }> };
  await storage.runStartupFinalizers();
  await vi.advanceTimersByTimeAsync(120_000);
  await settle();
  expect(created.settings.get(STATUS_KEY)).toBe(STATUS_CLEARED);
});

it('V09-P1-3 / V04-01 reinstalling backup after the startup finalizers ran starts the new scheduler once, 120 s later', async () => {
  const created = await createBackupHost();
  host = created.host;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const storage = host.ctx.get('storage') as unknown as {
    runStartupFinalizers(): Promise<{ completed: readonly string[] }>; finalizerNames(): string[];
  };
  await storage.runStartupFinalizers();
  await host.unload('dstu.backup');
  expect(storage.finalizerNames()).not.toContain(FINALIZER);
  created.settings.set(STATUS_KEY, STATUS_WITH_DUE);
  await host.install(backupPlugin);
  // 启动已完成：新调度器直接补跑，不保留已卸载实例的 registry 条目。
  expect(storage.finalizerNames()).not.toContain(FINALIZER);
  await vi.advanceTimersByTimeAsync(119_999);
  await settle();
  expect(created.settings.get(STATUS_KEY)).toBe(STATUS_WITH_DUE);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(created.settings.get(STATUS_KEY)).toBe(STATUS_CLEARED);
});

it('V09-P1-3 / V04-01 backup unloaded while the startup finalizers ran, then reinstalled, still starts the scheduler', async () => {
  const created = await createBackupHost();
  host = created.host;
  await host.unload('dstu.backup');
  const storage = host.ctx.get('storage') as unknown as { runStartupFinalizers(): Promise<unknown>; finalizerNames(): string[] };
  await storage.runStartupFinalizers();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  created.settings.set(STATUS_KEY, STATUS_WITH_DUE);
  await host.install(backupPlugin);
  expect(storage.finalizerNames()).not.toContain(FINALIZER);
  await vi.advanceTimersByTimeAsync(120_000);
  await settle();
  expect(created.settings.get(STATUS_KEY)).toBe(STATUS_CLEARED);
});
