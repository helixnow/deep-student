/**
 * 自动同步 App 级启动点的幂等契约（0824 Wave2-D R6 / 二检补漏，只写不跑）
 *
 * 背景：修复后 ensureAutoSyncSchedulerStarted 有三个潜在调用时机——
 * App.tsx 的 hasHydrated() 立即调用、onFinishHydration 回调、以及
 * SyncSettingsSection / SyncTab 挂载时的兼容性双保险；React StrictMode
 * 还会让 App 的 effect 双调用。syncStatusStore.ts 对 start() 的注释承诺
 * 「本函数与底层 start() 均防重，重复调用不会产生第二个定时器」
 * （scheduler.start 以 `timer !== null || running` 防重），但该承诺此前
 * 没有任何测试锁定：一旦防重条件被误改，每次进设置页都会多挂一个
 * 定时器，自动同步会以叠加频率重复执行。
 *
 * 本文件与 autoSyncStore.bootstrap.test.ts 使用同一套 mock 与基线清理，
 * 只锁幂等语义，不重复该文件已覆盖的启动/反事实/接线断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 与 autoSyncStore.bootstrap.test.ts 相同的隔离：performAutoSyncOnce 动态
// import 这两个模块；config=null → 单轮结果 skipped_unconfigured。
vi.mock('@/utils/cloudStorageApi', () => ({
  loadStoredCloudStorageConfigWithCredentials: vi.fn(async () => null),
  getCredentialStatus: vi.fn(),
}));

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: {
    detectPruneGap: vi.fn(),
  },
  runSyncWithProgress: vi.fn(),
}));

import {
  AUTO_SYNC_STARTUP_DELAY_MS,
  ensureAutoSyncSchedulerStarted,
  useAutoSyncStore,
} from '../syncStatusStore';

const PERSIST_KEY = 'dstu-auto-sync';

function seedPersistedAutoSync(enabled: boolean): void {
  localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({
      version: 2,
      state: {
        enabled,
        intervalPreset: '15m',
        lastOutcome: null,
        lastRunAtMs: null,
      },
    }),
  );
}

describe('ensureAutoSyncSchedulerStarted is idempotent across bootstrap call sites', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAutoSyncStore.getState().setEnabled(false);
    localStorage.clear();
    useAutoSyncStore.setState({
      enabled: false,
      intervalPreset: '15m',
      lastOutcome: null,
      lastRunAtMs: null,
      consecutiveFailures: 0,
    });
  });

  afterEach(() => {
    useAutoSyncStore.getState().setEnabled(false);
    vi.useRealTimers();
  });

  it('repeated ensure calls before the first run leave exactly one live timer', async () => {
    seedPersistedAutoSync(true);
    await useAutoSyncStore.persist.rehydrate();

    const timersBefore = vi.getTimerCount();

    // App（hasHydrated 分支）+ onFinishHydration 回调 + 设置页双保险 +
    // StrictMode 双调用：现实中同一次启动最多可叠出 4 次调用。
    ensureAutoSyncSchedulerStarted();
    ensureAutoSyncSchedulerStarted();
    ensureAutoSyncSchedulerStarted();
    ensureAutoSyncSchedulerStarted();

    expect(vi.getTimerCount()).toBe(timersBefore + 1);
  });

  it('re-ensuring after a completed round must not stack a second schedule', async () => {
    seedPersistedAutoSync(true);
    await useAutoSyncStore.persist.rehydrate();

    ensureAutoSyncSchedulerStarted();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_STARTUP_DELAY_MS);
    expect(useAutoSyncStore.getState().lastOutcome).toBe('skipped_unconfigured');

    // 一轮结束后调度器已自行重排下一轮（timer 存在）。此刻用户打开设置页
    // 再次触发 ensure：不得在已有排程之上再叠一个定时器。
    const timersAfterFirstRound = vi.getTimerCount();
    expect(timersAfterFirstRound).toBeGreaterThan(0);

    ensureAutoSyncSchedulerStarted();
    ensureAutoSyncSchedulerStarted();

    expect(vi.getTimerCount()).toBe(timersAfterFirstRound);
  });

  it('duplicate ensure calls never cause duplicate rounds to execute', async () => {
    seedPersistedAutoSync(true);
    await useAutoSyncStore.persist.rehydrate();

    ensureAutoSyncSchedulerStarted();
    ensureAutoSyncSchedulerStarted();

    await vi.advanceTimersByTimeAsync(AUTO_SYNC_STARTUP_DELAY_MS);

    // 只执行了一轮：lastRunAtMs 被写一次；若防重失效，两个定时器会背靠背
    // 各跑一轮（第二轮同为 skipped，但 lastRunAtMs 会被推进两次——这里用
    // 运行计数间接锁定：一轮结束后仅剩下一轮的单个排程）。
    expect(useAutoSyncStore.getState().lastOutcome).toBe('skipped_unconfigured');
    expect(vi.getTimerCount()).toBe(1);
  });
});
