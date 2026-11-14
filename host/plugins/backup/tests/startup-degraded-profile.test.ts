/**
 * D2 全组合根：官方 profile 在启动迁移全局失败时仍完成装配、跑完 finalizer 并可标记 ready，
 * 随后处于维护模式（Rust `lib.rs:1259-1306` + `1312-1318`）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { importProfile, loadStartupProfile, OFFICIAL_PROFILE_PATH, resolveProfile } from '../../../kernel/profile.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { CORE_BACKUP_ROOT_DIR_NAME } from '../../../platform/storage/migration/backup.ts';
import { expectNothingSentToWebview, startupEventSink } from './startup-event-sink.ts';

let host: TestHost | undefined;
let root: string | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  vi.unstubAllEnvs();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it('official profile boots into degraded maintenance on a global startup migration failure', async () => {
  root = mkdtempSync(join(tmpdir(), 'dstu-d2-profile-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  const dataDir = join(root, 'app');
  const activeDir = join(dataDir, 'slots', 'slotA');
  mkdirSync(activeDir, { recursive: true });
  writeFileSync(join(activeDir, CORE_BACKUP_ROOT_DIR_NAME), 'not a directory');

  const acl = CapabilityAcl.fromDirectory('linux');
  host = await createTestHost({
    app: { dataDir, platform: 'linux' },
    acl,
    shell: () => null,
  });
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  const failure = host.ctx.storage.startupMigrationFailure();
  expect(failure).toMatchObject({ recovered: false, maintenanceForced: true });

  // F1 finishStartup：finalizer 全部成功 → markStartupReady。
  const sink = startupEventSink(host);
  await host.ctx.storage.runStartupFinalizers();
  host.ctx.get('startupGate')!.markStartupReady();

  expect(sink.migration).toEqual([{
    success: false, error: failure!.error, degraded_mode: true, maintenance_mode_forced: true,
  }]);
  expectNothingSentToWebview(host, sink);
  expect(await host.invoke('data_governance_get_maintenance_status')).toMatchObject({
    is_in_maintenance_mode: true,
  });
  expect(await host.invoke('get_startup_recovery_status')).toMatchObject({ recovery_required: false });
  expect(() => host!.ctx.storage.database('mistakes')).toThrow('Database mistakes is in maintenance mode');
  // 未迁移的业务库让部分业务插件在 apply 时降级（Rust 此时同样不初始化业务组件）；
  // 平台核心与数据治理必须在线，前端恢复 UI 才能接管。
  const degraded = loaded.degraded.map((entry) => entry.id);
  for (const id of ['dstu.platform.storage', 'dstu.platform.paths', 'dstu.platform.log', 'dstu.backup', 'dstu.shell']) {
    expect(degraded).not.toContain(id);
  }

  // 降级插件声明的命令由维护占位命令接管：前端拿到可理解的 MAINTENANCE 错误，而不是 "command not found"。
  expect(degraded).toContain('dstu.notes');
  await expect(host.invoke('notes_list', {})).rejects.toEqual({
    error_type: 'Database',
    message: 'MAINTENANCE_MODE: notes is temporarily unavailable',
    details: { code: 'MAINTENANCE', component: 'notes', reason: failure!.error },
  });
  await expect(host.invoke('chat_v2_list_sessions', {})).rejects.toBe('MAINTENANCE_MODE: chat is temporarily unavailable');
  const installs = await importProfile(await resolveProfile(OFFICIAL_PROFILE_PATH));
  const placeholders = installs.filter((entry) => degraded.includes(entry.plugin.meta.id))
    .flatMap((entry) => entry.plugin.meta.commands ?? []);
  expect(placeholders.length).toBeGreaterThan(100);
  const notMaintenance: string[] = [];
  for (const cmd of placeholders) {
    const error: unknown = await host.invoke(cmd, {}).then(() => 'resolved', (e: unknown) => e);
    // 本平台 capability 未授权的命令仍按 ACL 拒绝（占位不绕过 ACL）。
    const denial = acl.denial(cmd, { window: 'main', webview: 'main' }, true);
    if (denial !== null) {
      if (error !== denial) notMaintenance.push(`${cmd}: expected ACL denial, got ${JSON.stringify(error)}`);
      continue;
    }
    const text = typeof error === 'string' ? error : JSON.stringify(error);
    if (!text.includes('MAINTENANCE_MODE')) notMaintenance.push(`${cmd}: ${text}`);
  }
  expect(notMaintenance).toEqual([]);
}, 180_000);
