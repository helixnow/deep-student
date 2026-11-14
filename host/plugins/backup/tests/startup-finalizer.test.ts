/** D2：通过插件注册的 F3 finalizer 消费恢复激活标记，不直接调用被测 helper。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { DataSpaceManager } from '../../../platform/storage/data-space.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import type { Logger } from '../../../platform/log/api.ts';
import { StartupFinalizerRegistry } from '../../../platform/storage/startup-finalizers.ts';
import { createStartupGate } from '../../../../electron/startup-gate.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import syncSupportPlugin from '../../sync-support/index.ts';
import plugin from '../index.ts';
import { persistRestoreActivationMarker, restoreActivationMarkerPath } from '../src/restore-commands.ts';
import { bindStartupFinalizer } from '../src/startup-finalizers.ts';
import { createDatabaseFile } from './helpers.ts';
import { expectNothingSentToWebview, startupEventSink } from './startup-event-sink.ts';

const FINALIZER = 'backup.restore-activation';
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

async function setup(activated = false, installBackup = true) {
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
  const logger = host.ctx.logger('startup-finalizer-test');
  const log: Logger = {
    target: 'startup-finalizer-test', error: logger.error.bind(logger), warn: logger.warn.bind(logger),
    info: logger.info.bind(logger), debug: logger.debug.bind(logger), trace: logger.debug.bind(logger),
  };
  const secrets = createSecretsService({ os: paths.os, log, keystore: null });
  const storage = createStorageService({ baseDir: root, dataLocalDir: paths.os.dataLocal });
  host.ctx.effect(() => () => storage.dispose());
  const dataSpace = new DataSpaceManager(root, secrets.publication);
  mkdirSync(dataSpace.slotDir('slotA'), { recursive: true });
  mkdirSync(dataSpace.slotDir('slotB'), { recursive: true });
  if (activated) {
    // 模拟 F3 已在启动迁移前完成 pending-slot 切换；读取 storage.locations 前固定活动槽。
    createDatabaseFile(join(dataSpace.slotDir('slotB'), 'chat_v2.db'));
    dataSpace.markRestoreCutoverPending('slotB', 'activation-backup');
    const state = dataSpace.readState();
    state.active = 'slotB';
    state.pending = null;
    dataSpace.writeState(state);
  }
  const gate = createStartupGate();
  host.ctx.provide('storage', storage);
  host.ctx.provide('paths', paths);
  host.ctx.provide('secrets', secrets);
  host.ctx.provide('settings', createSettingsService({
    db: () => storage.database('mistakes'), secureStore: () => secrets.openStore(root), secrets,
  }));
  host.ctx.provide('dataSpace', dataSpace);
  host.ctx.provide('startupGate', gate);
  if (activated) {
    expect((await storage.migrations.runAll()).success).toBe(true);
    // 同步状态变更使用真实 L20 owner；notes/L11 依赖也安装正式插件，不复制 SQL。
    await host.install(vfsReposPlugin);
    await host.install(notesPlugin);
    await host.install(syncSupportPlugin);
  }
  if (installBackup) await host.install(plugin);
  return { host, storage, paths, dataSpace, gate };
}

const BACKUP_FINALIZERS = [FINALIZER, 'backup.resumable-jobs', 'backup.auto-backup-scheduler'];
const BACKUP_ID = 'dstu.backup';

/** 损坏的激活标记：回调一旦执行就发 restore_activation_failed 并让 mistakes 进入维护。 */
function corruptActivationMarker(storage: { locations: { activeDir: string } }): void {
  writeFileSync(restoreActivationMarkerPath(storage.locations.activeDir), '{bad json');
}

it('V09-P1-3: unloading backup before startup finalizers stops its callbacks', async () => {
  const { host, storage } = await setup();
  await host.unload(BACKUP_ID);
  for (const name of BACKUP_FINALIZERS) expect(storage.finalizerNames()).not.toContain(name);
  corruptActivationMarker(storage);
  const sink = startupEventSink(host);
  await expect(storage.runStartupFinalizers()).resolves.toBeDefined();
  expect(sink.migration).toEqual([]);
  expect(() => storage.database('mistakes')).not.toThrow();
});

it('V09-P1-3: reinstall before startup finalizers keeps one registration bound to the new instance', async () => {
  const { host, storage } = await setup();
  await host.unload(BACKUP_ID);
  for (const name of BACKUP_FINALIZERS) expect(storage.finalizerNames()).not.toContain(name);
  await expect(host.install(plugin)).resolves.toBeDefined();
  for (const name of BACKUP_FINALIZERS) {
    expect(storage.finalizerNames().filter(entry => entry === name)).toHaveLength(1);
  }
  corruptActivationMarker(storage);
  const sink = startupEventSink(host);
  const report = await storage.runStartupFinalizers();
  expect(report.completed.indexOf('backup.resumable-jobs')).toBeGreaterThan(report.completed.indexOf(FINALIZER));
  expect(sink.migration).toEqual([
    expect.objectContaining({ success: false, restore_activation_failed: true }),
  ]);
});

it('V09-P1-3: reinstall after startup finalizers ran does not throw and does not rerun them', async () => {
  const { host, storage } = await setup();
  await storage.runStartupFinalizers();
  await host.unload(BACKUP_ID);
  for (const name of BACKUP_FINALIZERS) expect(storage.finalizerNames()).not.toContain(name);
  await expect(host.invoke('data_governance_get_backup_list')).rejects.toThrow();
  // 修复前：FINALIZER_LATE_REGISTRATION，重装整体回滚，备份命令在本进程内无法恢复。
  await expect(host.install(plugin)).resolves.toBeDefined();
  await expect(host.invoke('data_governance_get_backup_list')).resolves.toEqual([]);
  corruptActivationMarker(storage);
  const sink = startupEventSink(host);
  await storage.runStartupFinalizers();
  expect(sink.migration).toEqual([]);
  // 已完成启动：恢复/续跑跳过，调度器直接补跑，三者都不再留 registry 条目。
  for (const name of BACKUP_FINALIZERS) expect(storage.finalizerNames()).not.toContain(name);
  // 第二次卸载 + 重装同样成立。
  await host.unload(BACKUP_ID);
  await expect(host.install(plugin)).resolves.toBeDefined();
  for (const name of BACKUP_FINALIZERS) {
    expect(storage.finalizerNames()).not.toContain(name);
  }
});

it('V09-P1-3: first install after startup finalizers started skips them instead of throwing', async () => {
  const { host, storage } = await setup(false, false);
  await storage.runStartupFinalizers();
  await expect(host.install(plugin)).resolves.toBeDefined();
  expect(storage.finalizerNames()).not.toContain(FINALIZER);
  await expect(host.invoke('data_governance_get_backup_list')).resolves.toEqual([]);
});

it('V09-P1-3: unloading backup removes its finalizer entries from the registry', async () => {
  const { host, storage } = await setup();
  for (const name of BACKUP_FINALIZERS) expect(storage.finalizerNames()).toContain(name);
  await host.unload(BACKUP_ID);
  for (const name of BACKUP_FINALIZERS) expect(storage.finalizerNames()).not.toContain(name);
});

it('D2 backup registers its activation finalizer and fresh startup is a no-op', async () => {
  const { storage, paths, dataSpace, gate } = await setup();
  expect(storage.finalizerNames()).toContain(FINALIZER);
  const before = await paths.deviceId();
  expect((await storage.runStartupFinalizers()).completed).toContain(FINALIZER);
  expect(await paths.deviceId()).toBe(before);
  expect(dataSpace.restoreCutoverPending()).toBeNull();
  // ready 仍由 F1 组合根最后标记，L21 finalizer 不抢先标记。
  expect(gate.isStartupReady()).toBe(false);
});

it('D2 activation failure preserves the marker, enters maintenance and still leaves ready to F1', async () => {
  // 架构裁定 D2（对齐 lib.rs:1169-1190）：激活失败进入降级维护启动，不再让 finalizer 失败。
  const { host, storage, gate } = await setup();
  const marker = restoreActivationMarkerPath(storage.locations.activeDir);
  writeFileSync(marker, '{bad json');
  const sink = startupEventSink(host);
  expect((await storage.runStartupFinalizers()).completed).toContain(FINALIZER);
  expect(readFileSync(marker, 'utf8')).toBe('{bad json');
  expect(sink.migration).toEqual([{
    success: false, error: expect.stringContaining('解析恢复激活标记失败:'),
    degraded_mode: true, maintenance_mode_forced: true, restore_activation_failed: true,
  }]);
  expectNothingSentToWebview(host, sink);
  expect(() => storage.database('mistakes')).toThrow('Database mistakes is in maintenance mode');
  expect(gate.isStartupReady()).toBe(false);
});

it('D2 registered finalizer rotates real identity and sync state once after cutover', async () => {
  const { host, storage, paths, dataSpace, gate } = await setup(true);
  const active = storage.locations.activeDir;
  expect(active).toBe(dataSpace.slotDir('slotB'));
  const before = await paths.deviceId();
  const sync = host.ctx.syncSupport.state;
  sync.setCursor('instance', 'uploader', 17n);
  sync.markLegacyProcessed('instance', 'legacy-object');
  sync.setTombstoneWatermark('instance', 'uploader', 'notes', 42n);
  persistRestoreActivationMarker(active, {
    backup_id: 'activation-backup', snapshot_epoch: 'epoch-1', created_at: '2026-01-01T00:00:00+00:00',
  });
  expect((await storage.runStartupFinalizers()).completed).toContain(FINALIZER);
  const after = await paths.deviceId();
  expect(after).not.toBe(before);
  expect(readFileSync(paths.deviceIdFile, 'utf8').trim()).toBe(after);
  expect(sync.deviceRotationsForNew(after)).toEqual([[before, 'backup_restore_activation']]);
  expect(sync.getCursor('instance', 'uploader')).toBe(0n);
  expect(sync.isLegacyProcessed('instance', 'legacy-object')).toBe(false);
  expect(sync.getTombstoneWatermark('instance', 'uploader', 'notes')).toBe(0n);
  expect(existsSync(restoreActivationMarkerPath(active))).toBe(false);
  expect(dataSpace.restoreCutoverPending()).toBeNull();
  await storage.runStartupFinalizers();
  expect(sync.deviceRotationsForNew(after)).toEqual([[before, 'backup_restore_activation']]);
  gate.markStartupReady();
  expect(await host.invoke('data_governance_get_maintenance_status')).toMatchObject({
    is_in_maintenance_mode: false, blocked_components: [],
  });
}, 120_000);

it('V09-P1-3 a binding that misses the startup finalizers skips by default and runs right away with late:"run"', async () => {
  const host = await createTestHost();
  hosts.push(host);
  const registry = new StartupFinalizerRegistry();
  host.ctx.provide('storage', {
    registerFinalizer: registry.register.bind(registry),
    runStartupFinalizers: registry.run.bind(registry),
    finalizerNames: registry.names.bind(registry),
  } as never);
  await registry.run();
  const calls: string[] = [];
  expect(bindStartupFinalizer(host.ctx, 'late.skip', () => { calls.push('skip'); })).toBe(false);
  expect(bindStartupFinalizer(host.ctx, 'late.run', () => { calls.push('run'); }, { late: 'run' })).toBe(false);
  expect(bindStartupFinalizer(host.ctx, 'late.reject', () => Promise.reject(new Error('boom')), { late: 'run' })).toBe(false);
  await Promise.resolve();
  expect(calls).toEqual(['run']);
  expect(registry.names()).toEqual([]);
});
