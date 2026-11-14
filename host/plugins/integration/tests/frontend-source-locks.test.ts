import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * `sync_r11_autosync.rs` 的前端源码锁 / `sync_r10_protocol_locks.rs` 的用户指南文档锁。
 *
 * 这些 Rust 用例锁的是前端 `src/` 与用户文档，不是 Rust 运行时行为；迁移后
 * 用同一套源码/文档断言，确保前端 store、设置界面与运维指南不会悄悄漂移。
 */
const read = (path: string): string => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

const STORE = 'src/stores/syncStatusStore.ts';
const SETTINGS_UI = 'src/features/settings/components/SyncSettingsSection.tsx';
const USER_GUIDE = 'docs/user-guide/16-数据管理与云同步.md';

/** TS 后端对应 Rust `commands_sync.rs` 与 `dstu-sync/src/data_governance/sync/mod.rs`。 */
const SYNC_COMMANDS = 'host/plugins/sync/src/run-sync.ts';
const SYNC_ENGINE_E2EE = ['host/plugins/sync/src/payload.ts', 'host/plugins/sync/src/file-transfer.ts'];

it('r11_autosync_run_sync_commands_use_immediate_try_acquire', () => {
  // sync_r11_autosync.rs:108-116：同步命令立即失败（不排队）且 busy 文案不变。
  const commands = read(SYNC_COMMANDS);
  expect(commands).toContain('ports.limiter.tryAcquire()');
  expect(commands).toContain('另一个数据治理任务（同步/备份/恢复）正在进行中');

  const store = read(STORE);

  // 同步命令 busy 文案与 OperationGuard busy 文案必须留在分类表里；
  // 自动同步据此把「排队/被占」归为跳过而不是失败。
  expect(store).toContain("'另一个数据治理任务'");
  expect(store).toContain("'已有数据治理操作正在运行'");
  expect(store).toContain('AUTO_SYNC_BUSY_MARKERS');
});

it('r11_autosync_failclose_markers_stay_in_sync_across_layers', () => {
  const store = read(STORE);

  // 租约被占：稳定错误码与独立 skipped 结果。
  expect(store).toContain("'E_SYNC_LEASE_HELD'");
  expect(store).toContain('skipped_lease_held');

  // 未配置加密密码：稳定 code 与引擎文案片段两侧对齐（:151-155 引擎侧）。
  for (const file of SYNC_ENGINE_E2EE) expect(read(file), file).toContain('未配置加密密码');
  expect(store).toContain("'E_SYNC_E2EE_PASSWORD_REQUIRED'");
  expect(store).toContain("'未配置加密密码'");

  // fail-close：未配置归为静默跳过，且自动同步单轮不弹通知。
  expect(store).toContain('skipped_unconfigured');
  expect(store).not.toContain('showGlobalNotification');
});

it('r11_autosync_interval_tiers_and_default_off_are_pinned', () => {
  const store = read(STORE);

  expect(store).toContain("'15m': 15 * 60_000");
  expect(store).toContain("'1h': 60 * 60_000");
  expect(store).toContain("'6h': 6 * 60 * 60_000");
  expect(store).toContain("AUTO_SYNC_DEFAULT_INTERVAL_PRESET: AutoSyncIntervalPreset = '15m'");
  expect(store).toContain('enabled: false');

  for (const field of [
    'enabled: state.enabled',
    'intervalPreset: state.intervalPreset',
    'lastOutcome: state.lastOutcome',
    'lastRunAtMs: state.lastRunAtMs',
  ]) {
    expect(store, `持久化 partialize 缺少字段: ${field}`).toContain(field);
  }

  // 长档位下失败退避封顶必须不低于档位间隔。
  expect(store).toContain('Math.max(maxBackoffMs, intervalMs)');
});

it('r11_autosync_settings_ui_exposes_tiers_and_last_run_status', () => {
  const ui = read(SETTINGS_UI);

  expect(ui).toContain('setAutoSyncIntervalPreset');
  for (const tier of ['15m', '1h', '6h']) {
    expect(ui, `档位选项缺少 ${tier}`).toContain(`t('sync:autoSync.interval.${tier}')`);
  }
  expect(ui).toContain("t('sync:autoSync.lastRun')");
  expect(ui).toContain('autoSyncOutcomeLabels[autoSyncLastOutcome]');
});

it('p2_1_marker_upgrade_unlock_guide_doc_lock', () => {
  const guide = read(USER_GUIDE);

  // 运维解锁章节与 FAQ 仍是 P2-1 信任边界的唯一缓解。
  expect(guide).toContain('云端目录的加密标记与「密码不一致」解锁');
  expect(guide).toContain('但我确定自己的密码没错');

  // 代码侧最低可观测性：L23 的 v1 旧标记升级仍走独立 LegacyV1 认领路径。
  const syncManager = read('host/plugins/sync-providers/src/sync_manager.ts');
  expect(syncManager).toContain("claimMarkerWithPassword(password, 'LegacyV1')");
});
