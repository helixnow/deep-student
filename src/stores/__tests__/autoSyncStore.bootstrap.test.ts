/**
 * 自动同步「重启后不进设置页也要恢复排程」红灯测试（0824 Wave2-D R2 / 测试 B）
 *
 * 背景：ensureAutoSyncSchedulerStarted 此前只由设置页组件
 * （SyncSettingsSection / SyncTab）挂载时调用。用户开启自动同步后重启应用、
 * 但不打开设置页时，没有任何代码启动调度器——持久化的 enabled:true 形同虚设。
 *
 * 修复（App 级主启动点）：App 在 useAutoSyncStore 的 persist hydration 完成后
 * 调用 ensureAutoSyncSchedulerStarted()（hasHydrated() 已真则立即调，否则挂
 * onFinishHydration 回调）。本文件不渲染 SyncSettingsSection/SyncTab，直接
 * 验证 App 将使用的启动路径：
 * 1.（行为）rehydrate enabled:true 后调用 ensureAutoSyncSchedulerStarted，
 *    调度器内部 timer 必须存在，且到达启动延迟后确实执行了一轮；
 * 2.（反事实说明）只 rehydrate 不调用 ensure → timer 不存在。这正是修复前
 *    重启后的真实状态：store 自己不会启动调度器，必须有 App 级调用方；
 * 3.（App 接线契约）App.tsx 必须在 hydration 完成后调用
 *    ensureAutoSyncSchedulerStarted——修复前 App.tsx 没有这个调用（应红），
 *    修复后存在（应绿）。本轮只写测试不执行。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// performAutoSyncOnce 动态 import 这两个模块；整体 mock 掉以隔离 Tauri 链。
// 未配置（config=null）→ 单轮结果为 skipped_unconfigured（fail-close 不误跑）。
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

/** 模拟「上次会话开着自动同步」的持久化快照，然后触发 rehydrate。 */
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

describe('auto-sync bootstrap after restart (settings pages never mounted)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 先停掉可能由前一个用例启动的单例调度器，再回到干净基线
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
    // setEnabled(false) 会 stop() 单例调度器，清掉挂着的定时器
    useAutoSyncStore.getState().setEnabled(false);
    vi.useRealTimers();
  });

  it('rehydrated enabled:true + ensureAutoSyncSchedulerStarted leaves a live startup timer', async () => {
    seedPersistedAutoSync(true);
    await useAutoSyncStore.persist.rehydrate();
    expect(useAutoSyncStore.getState().enabled).toBe(true);

    // App 启动路径：hydration 完成后调用 ensure（本测试直接调用同一函数）
    const timersBefore = vi.getTimerCount();
    ensureAutoSyncSchedulerStarted();

    // 调度器内部 timer 必须存在（startupDelay 的 setTimeout 已挂上）。
    // 修复前的重启场景没有任何代码走到这一步——见下一个用例的反事实断言。
    expect(vi.getTimerCount()).toBe(timersBefore + 1);

    // 到达启动延迟后确实执行了一轮：未配置云存储 → fail-close 跳过，
    // 结果写回 store；且下一轮已按 15m 档位重新排上（timer 仍存在）。
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_STARTUP_DELAY_MS);
    expect(useAutoSyncStore.getState().lastOutcome).toBe('skipped_unconfigured');
    expect(useAutoSyncStore.getState().lastRunAtMs).not.toBeNull();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('counterfactual: rehydrate alone never schedules — without an app-level ensure call there is no timer', async () => {
    // 这是修复前「重启后不进设置页」的真实状态：persist 恢复了 enabled:true，
    // 但 store 自身不会启动调度器，timer 不存在，自动同步永远不会跑。
    seedPersistedAutoSync(true);
    const timersBefore = vi.getTimerCount();

    await useAutoSyncStore.persist.rehydrate();

    expect(useAutoSyncStore.getState().enabled).toBe(true);
    expect(vi.getTimerCount()).toBe(timersBefore);

    // 即使等再久也不会有任何一轮被执行
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_STARTUP_DELAY_MS * 10);
    expect(useAutoSyncStore.getState().lastOutcome).toBeNull();
  });

  it('app wiring contract: App.tsx starts the scheduler after persist hydration', () => {
    // 修复前 App.tsx 不调用 ensureAutoSyncSchedulerStarted（本用例红）；
    // 修复后 App 必须：hasHydrated() 已真 → 立即调；否则 onFinishHydration
    // 回调里调（不得在 hydration 前调，否则会用默认 enabled:false 误判 no-op）。
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');

    expect(appSource).toContain('ensureAutoSyncSchedulerStarted()');
    expect(appSource).toMatch(/hasHydrated\(\)/);
    expect(appSource).toMatch(/onFinishHydration\(/);
  });

  it('ensureAutoSyncSchedulerStarted stays a no-op when the persisted toggle is off', async () => {
    // 防「常开化」回归：关着的开关重启后绝不能被 App 级启动点偷偷拉起。
    seedPersistedAutoSync(false);
    await useAutoSyncStore.persist.rehydrate();
    expect(useAutoSyncStore.getState().enabled).toBe(false);

    const timersBefore = vi.getTimerCount();
    ensureAutoSyncSchedulerStarted();
    expect(vi.getTimerCount()).toBe(timersBefore);

    await vi.advanceTimersByTimeAsync(AUTO_SYNC_STARTUP_DELAY_MS * 10);
    expect(useAutoSyncStore.getState().lastOutcome).toBeNull();
  });
});
