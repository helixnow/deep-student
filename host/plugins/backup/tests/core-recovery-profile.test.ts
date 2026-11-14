/**
 * 核心恢复启动模式全组合根：迁移本身返回 Ok，但 vfs 被阻断（mistakes / chat_v2 经依赖闭包一并阻断）。
 * Rust `lib.rs:1098-1141` 照常发带警告的迁移状态事件，`1312-1318` 随后因 `requires_core_recovery()`
 * 提前结束 setup。Host 不能“不装配”插件，改为 storage 在业务插件装配前对被阻断的核心库建立维护屏障。
 *
 * 场景用真实数据造出：活动槽的 vfs.db 不是 SQLite 文件，迁移失败且没有迁移前快照可恢复，
 * 协调器走单库失败分支（`coordinator.ts` markBlocked），与故障点 `before_db_migration::vfs` +
 * `before_restore` 组合到达的是同一分支；故障点只能注入到独立协调器，官方 profile 的组合根够不到。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
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

it('official profile boots into core recovery maintenance when vfs is blocked by a single-database migration failure', async () => {
  root = mkdtempSync(join(tmpdir(), 'dstu-core-recovery-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  const dataDir = join(root, 'app');
  const activeDir = join(dataDir, 'slots', 'slotA');
  mkdirSync(join(activeDir, 'databases'), { recursive: true });
  writeFileSync(join(activeDir, 'databases', 'vfs.db'), Buffer.alloc(8192, 0x5a));

  host = await createTestHost({
    app: { dataDir, platform: 'linux' },
    acl: CapabilityAcl.fromDirectory('linux'),
    shell: () => null,
  });
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  const sink = startupEventSink(host);
  await host.ctx.storage.runStartupFinalizers();
  host.ctx.get('startupGate')!.markStartupReady();

  // 迁移返回 Ok（不是全局失败），报告里 vfs 失败、chat_v2 / mistakes 因依赖跳过、llm_usage 成功。
  const report = host.ctx.storage.startupMigrationReport()!;
  expect(host.ctx.storage.startupMigrationFailure()).toBeNull();
  expect(report.success).toBe(false);
  const byId = new Map(report.databases.map(db => [db.id, db]));
  const vfsReason = byId.get('vfs')!.error!;
  expect(vfsReason).toMatch(/^Database 'vfs' migration failed: Database error: file is not a database\./);
  expect(byId.get('llm_usage')!.success).toBe(true);
  const dependencyReason = "Skipped because dependency 'vfs' is blocked";
  expect(byId.get('chat_v2')!.error).toBe(dependencyReason);
  expect(byId.get('mistakes')!.error).toBe(dependencyReason);

  // lib.rs:1133-1140 警告载荷，逐字段：global_version 只聚合未阻断的库（with_health 跳过 blocked），
  // warnings 为非 audit 组件问题原因去重后的列表（init.rs:230-239）。V03-02 方案 A：只派发给 Host 内部。
  expectNothingSentToWebview(host, sink);
  expect(sink.migration).toEqual([{
    success: true,
    global_version: byId.get('llm_usage')!.toVersion,
    migrations_applied: report.databases.reduce((sum, db) => sum + db.appliedCount, 0),
    duration_ms: report.totalDurationMs,
    warnings: [vfsReason, dependencyReason],
    has_warnings: true,
  }]);
  // Ok 分支不写 `.last_migration_error`（只有 Err 分支 persist）。
  expect(existsSync(join(activeDir, '.last_migration_error'))).toBe(false);

  // storage 已在业务插件装配前进入维护屏障，并给出原因；kernel 的维护占位命令因此生效。
  expect(host.ctx.storage.startupMaintenance()).toEqual({ reason: vfsReason });
  expect(() => host!.ctx.storage.database('vfs')).toThrow('Database vfs is in maintenance mode');
  expect(() => host!.ctx.storage.database('mistakes')).toThrow('Database mistakes is in maintenance mode');
  expect(loaded.degraded.map(entry => entry.id)).toContain('dstu.notes');
  await expect(host.invoke('notes_list', {})).rejects.toEqual({
    error_type: 'Database',
    message: 'MAINTENANCE_MODE: notes is temporarily unavailable',
    details: { code: 'MAINTENANCE', component: 'notes', reason: vfsReason },
  });

  // backup 复用 storage 的屏障报告维护态（不重复进入）；未阻断的 llm_usage 照常可用。
  expect(await host.invoke('data_governance_get_maintenance_status')).toMatchObject({
    is_in_maintenance_mode: true,
    blocked_components: ['main', 'manager', 'vfs', 'chat_v2'],
  });
  expect(() => host!.ctx.storage.database('llm_usage')).not.toThrow();
  await expect(host.invoke('llm_usage_summary', {})).resolves.toMatchObject({ totalRequests: 0 });
  expect(await host.invoke('get_startup_recovery_status')).toMatchObject({ recovery_required: false });
  for (const id of ['dstu.platform.storage', 'dstu.backup', 'dstu.shell']) {
    expect(loaded.degraded.map(entry => entry.id)).not.toContain(id);
  }
}, 180_000);
