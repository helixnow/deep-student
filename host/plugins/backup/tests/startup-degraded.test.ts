/**
 * D2 降级维护启动（Rust `lib.rs:1098-1419`）：恢复激活失败、全局迁移失败、迁移失败后已恢复、
 * schema 指纹漂移。启动 finalizer 不再让 Host 失败；按 Rust 持久化 `.last_migration_error`、派发
 * `data-governance-migration-status` 失败载荷（V03-02 方案 A：仅 Host 内部，不推 webview），
 * 并在需要时建立持续到 Host 卸载的全组件维护屏障。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { DataSpaceManager } from '../../../platform/storage/data-space.ts';
import { StorageError } from '../../../platform/storage/api.ts';
import { CORE_BACKUP_ROOT_DIR_NAME } from '../../../platform/storage/migration/backup.ts';
import { MigrationError } from '../../../platform/storage/migration/errors.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import type { Logger } from '../../../platform/log/api.ts';
import { createStartupGate } from '../../../../electron/startup-gate.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import plugin from '../index.ts';
import { restoreActivationMarkerPath } from '../src/restore-commands.ts';
import { expectNothingSentToWebview, startupEventSink } from './startup-event-sink.ts';

const FINALIZERS = ['backup.restore-activation', 'backup.resumable-jobs'];
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const FAIL_CLOSED = ['main', 'manager', 'vfs', 'chat_v2', 'llm_usage'];

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

type Migration = 'ok' | 'global-failure' | 'recovered' | 'drift';

interface SetupOptions {
  migration?: Migration;
  /** 安装真实 vfs-repos + notes（迁移成功时），验证业务命令在维护期的错误。 */
  business?: boolean;
  workspace?: { enterMaintenanceMode(): Promise<void>; exitMaintenanceMode(): void };
}

async function setup(options: SetupOptions = {}) {
  const host = await createTestHost();
  hosts.push(host);
  const root = host.app.dataDir;
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const paths = createPaths({
    dataDir: root, platform,
    env: {
      HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), LOCALAPPDATA: root,
      APPDATA: join(root, 'config'), XDG_DATA_HOME: root, XDG_CONFIG_HOME: join(root, 'config'),
      XDG_CACHE_HOME: join(root, 'cache'), DEVICE_ID: 'old-device',
    },
  });
  const logger = host.ctx.logger('startup-degraded-test');
  const log: Logger = {
    target: 'startup-degraded-test', error: logger.error.bind(logger), warn: logger.warn.bind(logger),
    info: logger.info.bind(logger), debug: logger.debug.bind(logger), trace: logger.debug.bind(logger),
  };
  const secrets = createSecretsService({ os: paths.os, log, keystore: null });
  const storage = createStorageService({ baseDir: root, dataLocalDir: paths.os.dataLocal });
  host.ctx.effect(() => () => storage.dispose());
  const dataSpace = new DataSpaceManager(root, secrets.publication);
  mkdirSync(dataSpace.slotDir('slotA'), { recursive: true });
  mkdirSync(dataSpace.slotDir('slotB'), { recursive: true });
  const gate = createStartupGate();
  host.ctx.provide('storage', storage);
  host.ctx.provide('paths', paths);
  host.ctx.provide('secrets', secrets);
  host.ctx.provide('settings', createSettingsService({
    db: () => storage.database('mistakes'), secureStore: () => secrets.openStore(root), secrets,
  }));
  host.ctx.provide('dataSpace', dataSpace);
  host.ctx.provide('startupGate', gate);
  if (options.workspace !== undefined) host.ctx.provide('agentWorkspace', options.workspace);

  const migration = options.migration ?? 'ok';
  if (migration === 'global-failure') {
    writeFileSync(join(storage.locations.activeDir, CORE_BACKUP_ROOT_DIR_NAME), 'not a directory');
  } else if (migration === 'recovered') {
    storage.coordinator = () => ({
      runAll: async () => { throw new MigrationError({ kind: 'RecoveredFromBackup', originalError: 'V9 failed', restoredCount: 4 }); },
    }) as never;
  } else if (migration === 'drift') {
    storage.coordinator = () => ({
      runAll: async () => {
        throw new MigrationError({ kind: 'VerificationFailed', version: 20260524, reason: 'Schema fingerprint drift detected at v20260524 (db: mistakes).' });
      },
    }) as never;
  }
  // 与 storage 插件 apply 相同：全局失败已记录在 storage 上，启动继续。
  const outcome = await storage.migrations.runAll().then(() => 'ok', () => 'failed');
  expect(outcome).toBe(migration === 'ok' ? 'ok' : 'failed');
  if (options.business) {
    await host.install(vfsReposPlugin);
    await host.install(notesPlugin);
  }
  await host.install(plugin);
  const activeDir = storage.locations.activeDir;
  const sink = startupEventSink(host);
  return { host, storage, gate, activeDir, sink };
}

/** F1 `finishStartup`：finalizer 全部成功后才标记 gate。 */
async function finishStartup(storage: { runStartupFinalizers(): Promise<{ completed: readonly string[] }> }, gate: { markStartupReady(): void }) {
  const report = await storage.runStartupFinalizers();
  gate.markStartupReady();
  return report;
}

function persistedError(activeDir: string): { error: string; timestamp: string } {
  return JSON.parse(readFileSync(join(activeDir, '.last_migration_error'), 'utf8')) as { error: string; timestamp: string };
}

function expectMaintenance(storage: { database(name: never): unknown }, name: string): void {
  let caught: unknown;
  try { storage.database(name as never); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(StorageError);
  expect(caught).toMatchObject({ code: 'MAINTENANCE', database: name });
}

/** 维护期命令必须 settle（返回或报错），不能挂起。 */
async function settles<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('command hung')), 10_000); });
  try {
    return await Promise.race([promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })), timeout]);
  } finally { clearTimeout(timer); }
}

it('restore activation failure: Host finishes startup, emits lib.rs:1180-1189 payload and fails closed', async () => {
  const workspaceCalls: string[] = [];
  const workspace = {
    enterMaintenanceMode: async () => { workspaceCalls.push('enter'); },
    exitMaintenanceMode: () => { workspaceCalls.push('exit'); },
  };
  const { host, storage, gate, activeDir, sink } = await setup({ business: true, workspace });
  const marker = restoreActivationMarkerPath(activeDir);
  writeFileSync(marker, '{bad json');

  const report = await finishStartup(storage, gate);
  expect(report.completed).toEqual(expect.arrayContaining(FINALIZERS));
  expect(gate.isStartupReady()).toBe(true);

  const events = sink.migration;
  expectNothingSentToWebview(host, sink);
  expect(events).toHaveLength(2);
  // lib.rs:1115-1123：迁移成功事件先发，随后才是恢复激活失败。
  expect(events[0]).toMatchObject({ success: true, warnings: [] });
  const failure = events[1] as Record<string, unknown>;
  expect(Object.keys(failure).sort()).toEqual(['degraded_mode', 'error', 'maintenance_mode_forced', 'restore_activation_failed', 'success']);
  expect(failure).toEqual({
    success: false,
    error: expect.stringContaining('解析恢复激活标记失败:'),
    degraded_mode: true,
    maintenance_mode_forced: true,
    restore_activation_failed: true,
  });
  const persisted = persistedError(activeDir);
  expect(persisted.error).toBe(failure.error);
  expect(persisted.timestamp).toMatch(RFC3339);
  expect(readFileSync(marker, 'utf8')).toBe('{bad json');

  for (const name of ['mistakes', 'vfs', 'chat_v2', 'llm_usage']) expectMaintenance(storage, name);
  expect(workspaceCalls).toEqual(['enter']);
  expect(await host.invoke('data_governance_get_maintenance_status')).toMatchObject({
    is_in_maintenance_mode: true, blocked_components: [...FAIL_CLOSED, 'workspaces'],
  });
  // 依赖 VFS 的业务命令明确报错，不挂起、不伪造成功。
  const listed = await settles(host.invoke('notes_list'));
  expect(listed.ok).toBe(false);
  expect(String((listed as { error: unknown }).error)).toMatch(/maintenance|维护/);
  expect(existsSync(marker)).toBe(true);
}, 120_000);

it('global migration failure: degraded maintenance startup with lib.rs:1284-1289 payload, activation skipped', async () => {
  const { host, storage, gate, activeDir, sink } = await setup({ migration: 'global-failure' });
  const marker = restoreActivationMarkerPath(activeDir);
  writeFileSync(marker, '{bad json');
  const failure = storage.startupMigrationFailure();
  expect(failure).not.toBeNull();

  const report = await finishStartup(storage, gate);
  expect(report.completed).toEqual(expect.arrayContaining(FINALIZERS));
  expect(sink.migration).toEqual([{
    success: false, error: failure!.error, degraded_mode: true, maintenance_mode_forced: true,
  }]);
  expectNothingSentToWebview(host, sink);
  expect(failure!.error.startsWith('Migration error: IO error: ')).toBe(true);
  expect(persistedError(activeDir).error).toBe(failure!.error);
  // Rust 只在 initialize_with_report Ok 分支提交恢复激活。
  expect(readFileSync(marker, 'utf8')).toBe('{bad json');

  for (const name of ['mistakes', 'vfs', 'chat_v2', 'llm_usage']) expectMaintenance(storage, name);
  const status = await host.invoke('data_governance_get_maintenance_status') as Record<string, unknown>;
  expect(status).toMatchObject({ is_in_maintenance_mode: true, blocked_components: FAIL_CLOSED });
  expect((status.component_issues as Array<{ component: string; status: string }>).map((issue) => [issue.component, issue.status]))
    .toEqual([['vfs', 'blocked'], ['mistakes', 'blocked'], ['chat_v2', 'blocked'], ['llm_usage', 'blocked']]);
  // 迁移状态命令仍可读取持久化的真实错误（commands.rs:794-800 回退路径）。
  const migration = await settles(host.invoke('data_governance_get_migration_status'));
  expect(migration.ok).toBe(true);
}, 120_000);

it('recovered migration failure: lib.rs:1212-1218 payload, core components blocked, maintenance', async () => {
  const { host, storage, gate, activeDir, sink } = await setup({ migration: 'recovered' });
  await finishStartup(storage, gate);
  const error = 'Migration error: Migration failed but recovered from backup: V9 failed (restored 4 databases)';
  expectNothingSentToWebview(host, sink);
  expect(sink.migration).toEqual([{
    success: false,
    recovered: true,
    error,
    maintenance_mode_forced: true,
    message: '数据库升级失败，已恢复到升级前状态并进入只读维护模式。请先导出备份或更新应用后重试。',
  }]);
  expect(persistedError(activeDir).error).toBe(error);
  expect(storage.componentHealth.blockedComponents()).toEqual(['vfs', 'mistakes', 'chat_v2', 'llm_usage']);
  expectMaintenance(storage, 'mistakes');
  expect(await host.invoke('data_governance_get_maintenance_status')).toMatchObject({
    is_in_maintenance_mode: true, blocked_components: FAIL_CLOSED,
  });
});

it('schema fingerprint drift: degraded payload without forced maintenance; databases stay usable', async () => {
  const { host, storage, gate, activeDir, sink } = await setup({ migration: 'drift' });
  await finishStartup(storage, gate);
  const error = 'Migration error: Verification failed for migration 20260524: Schema fingerprint drift detected at v20260524 (db: mistakes).';
  expectNothingSentToWebview(host, sink);
  expect(sink.migration).toEqual([{
    success: false, error, degraded_mode: true, maintenance_mode_forced: false,
  }]);
  expect(persistedError(activeDir).error).toBe(error);
  expect(() => storage.database('mistakes')).not.toThrow();
  expect(await host.invoke('data_governance_get_maintenance_status')).toMatchObject({
    is_in_maintenance_mode: false,
    blocked_components: [],
    component_issues: [{ component: 'mistakes', status: 'degraded', reason: error, dependency: null }],
  });
});

it('a fail-close barrier that cannot be established still fails startup (lib.rs:1410-1415)', async () => {
  const { storage, gate, activeDir } = await setup();
  writeFileSync(restoreActivationMarkerPath(activeDir), '{bad json');
  const held = await storage.enterMaintenance(['mistakes']);
  try {
    await expect(storage.runStartupFinalizers()).rejects.toMatchObject({
      name: 'StartupFinalizerError',
      finalizer: 'backup.restore-activation',
      cause: { message: expect.stringMatching(/^无法建立完整数据治理维护屏障: 主数据库: /) },
    });
    expect(gate.isStartupReady()).toBe(false);
  } finally { held.release(); }
});
