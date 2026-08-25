/**
 * 自动同步（R07-autosync）单测
 *
 * 覆盖三层：
 * 1. createAutoSyncScheduler 的时序：启动延迟、固定间隔、失败指数退避与封顶、
 *    skipped 不影响退避计数、关闭开关后停止调度；
 * 2. performAutoSyncOnce 的安全防线：无配置 / 缺凭据 / 凭据状态查询失败时
 *    绝不执行同步（fail-close），与全局同步锁互斥，断层预检 fail-close；
 * 3. useAutoSyncStore：默认关闭、持久化白名单，以及损坏 localStorage 的恢复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/cloudStorageApi', () => ({
  loadStoredCloudStorageConfigWithCredentials: vi.fn(),
  getCredentialStatus: vi.fn(),
}));

vi.mock('@/api/dataGovernance', () => ({
  DataGovernanceApi: {
    detectPruneGap: vi.fn(),
  },
  runSyncWithProgress: vi.fn(),
}));

import {
  createAutoSyncScheduler,
  performAutoSyncOnce,
  useAutoSyncStore,
  useGlobalSyncStore,
  type AutoSyncOutcome,
} from '../syncStatusStore';
import {
  loadStoredCloudStorageConfigWithCredentials,
  getCredentialStatus,
  type CloudStorageConfig,
} from '@/utils/cloudStorageApi';
import { DataGovernanceApi, runSyncWithProgress } from '@/api/dataGovernance';

const mockLoadConfig = vi.mocked(loadStoredCloudStorageConfigWithCredentials);
const mockCredentialStatus = vi.mocked(getCredentialStatus);
const mockDetectPruneGap = vi.mocked(DataGovernanceApi.detectPruneGap);
const mockRunSync = vi.mocked(runSyncWithProgress);

const webdavConfig: CloudStorageConfig = {
  provider: 'webdav',
  webdav: { endpoint: 'https://dav.example.com', username: 'u', password: '' },
};

const allCredentialsConfigured = {
  webdavPasswordConfigured: true,
  s3SecretAccessKeyConfigured: true,
  ftpPasswordConfigured: true,
  encryptionPasswordConfigured: false,
};

const noCredentialsConfigured = {
  webdavPasswordConfigured: false,
  s3SecretAccessKeyConfigured: false,
  ftpPasswordConfigured: false,
  encryptionPasswordConfigured: false,
};

describe('createAutoSyncScheduler', () => {
  const timings = {
    startupDelayMs: 1_000,
    intervalMs: 10_000,
    maxBackoffMs: 40_000,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule anything while disabled (default off)', async () => {
    const run = vi.fn<[], Promise<AutoSyncOutcome>>().mockResolvedValue('success');
    const scheduler = createAutoSyncScheduler({
      isEnabled: () => false,
      runAutoSync: run,
      ...timings,
    });

    scheduler.start();
    expect(scheduler.isScheduled()).toBe(false);
    await vi.advanceTimersByTimeAsync(timings.startupDelayMs * 10);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs first after the startup delay, then at the regular interval on success', async () => {
    const run = vi.fn<[], Promise<AutoSyncOutcome>>().mockResolvedValue('success');
    const scheduler = createAutoSyncScheduler({
      isEnabled: () => true,
      runAutoSync: run,
      ...timings,
    });

    scheduler.start();
    expect(scheduler.isScheduled()).toBe(true);

    await vi.advanceTimersByTimeAsync(timings.startupDelayMs - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(timings.intervalMs);
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.getConsecutiveFailures()).toBe(0);
  });

  it('start() is idempotent: a second call does not double-schedule', async () => {
    const run = vi.fn<[], Promise<AutoSyncOutcome>>().mockResolvedValue('success');
    const scheduler = createAutoSyncScheduler({
      isEnabled: () => true,
      runAutoSync: run,
      ...timings,
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(timings.startupDelayMs);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially on failures and caps at maxBackoffMs', async () => {
    const run = vi.fn<[], Promise<AutoSyncOutcome>>().mockResolvedValue('failure');
    const scheduler = createAutoSyncScheduler({
      isEnabled: () => true,
      runAutoSync: run,
      ...timings,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(timings.startupDelayMs);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.getConsecutiveFailures()).toBe(1);
    // 第 1 次失败后：10s * 2^1 = 20s
    expect(scheduler.computeNextDelayMs()).toBe(20_000);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    // 第 2 次失败后：10s * 2^2 = 40s（正好到上限）
    expect(scheduler.computeNextDelayMs()).toBe(40_000);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(run).toHaveBeenCalledTimes(3);
    // 第 3 次失败后：10s * 2^3 = 80s → 封顶 40s
    expect(scheduler.getConsecutiveFailures()).toBe(3);
    expect(scheduler.computeNextDelayMs()).toBe(40_000);
  });

  it('a rejected run counts as a failure', async () => {
    const run = vi
      .fn<[], Promise<AutoSyncOutcome>>()
      .mockRejectedValue(new Error('boom'));
    const scheduler = createAutoSyncScheduler({
      isEnabled: () => true,
      runAutoSync: run,
      ...timings,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(timings.startupDelayMs);
    expect(scheduler.getConsecutiveFailures()).toBe(1);
    expect(scheduler.computeNextDelayMs()).toBe(20_000);
  });

  it('a success resets the backoff counter', async () => {
    const run = vi
      .fn<[], Promise<AutoSyncOutcome>>()
      .mockResolvedValueOnce('failure')
      .mockResolvedValueOnce('success');
    const scheduler = createAutoSyncScheduler({
      isEnabled: () => true,
      runAutoSync: run,
      ...timings,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(timings.startupDelayMs);
    expect(scheduler.getConsecutiveFailures()).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.getConsecutiveFailures()).toBe(0);
    expect(scheduler.computeNextDelayMs()).toBe(timings.intervalMs);
  });

  it('skipped runs (unconfigured/busy) neither count as failures nor reset backoff', async () => {
    const run = vi
      .fn<[], Promise<AutoSyncOutcome>>()
      .mockResolvedValueOnce('failure')
      .mockResolvedValueOnce('skipped_unconfigured')
      .mockResolvedValueOnce('skipped_busy');
    const scheduler = createAutoSyncScheduler({
      isEnabled: () => true,
      runAutoSync: run,
      ...timings,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(timings.startupDelayMs);
    expect(scheduler.getConsecutiveFailures()).toBe(1);

    // skipped_unconfigured：计数保持 1，退避间隔不变
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.getConsecutiveFailures()).toBe(1);
    expect(scheduler.computeNextDelayMs()).toBe(20_000);

    // skipped_busy：同样不影响计数
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(scheduler.getConsecutiveFailures()).toBe(1);
  });

  it('stop() cancels the pending run', async () => {
    const run = vi.fn<[], Promise<AutoSyncOutcome>>().mockResolvedValue('success');
    const scheduler = createAutoSyncScheduler({
      isEnabled: () => true,
      runAutoSync: run,
      ...timings,
    });

    scheduler.start();
    scheduler.stop();
    expect(scheduler.isScheduled()).toBe(false);
    await vi.advanceTimersByTimeAsync(timings.startupDelayMs * 10);
    expect(run).not.toHaveBeenCalled();
  });

  it('stops rescheduling once the toggle turns off mid-cycle', async () => {
    let enabled = true;
    const run = vi.fn<[], Promise<AutoSyncOutcome>>().mockResolvedValue('success');
    const scheduler = createAutoSyncScheduler({
      isEnabled: () => enabled,
      runAutoSync: run,
      ...timings,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(timings.startupDelayMs);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.isScheduled()).toBe(true);

    enabled = false;
    await vi.advanceTimersByTimeAsync(timings.intervalMs);
    // 定时器触发但 tick 因开关关闭直接返回，也不再排下一轮
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.isScheduled()).toBe(false);
  });
});

describe('performAutoSyncOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGlobalSyncStore.setState({ isSyncing: false, source: null });
  });

  it('skips (fail-close) when no cloud config exists', async () => {
    mockLoadConfig.mockResolvedValue(null);

    await expect(performAutoSyncOnce()).resolves.toBe('skipped_unconfigured');
    expect(mockCredentialStatus).not.toHaveBeenCalled();
    expect(mockRunSync).not.toHaveBeenCalled();
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });

  it('skips (fail-close) when credentials for the active provider are missing', async () => {
    mockLoadConfig.mockResolvedValue(webdavConfig);
    mockCredentialStatus.mockResolvedValue(noCredentialsConfigured);

    await expect(performAutoSyncOnce()).resolves.toBe('skipped_unconfigured');
    expect(mockDetectPruneGap).not.toHaveBeenCalled();
    expect(mockRunSync).not.toHaveBeenCalled();
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });

  it('skips (fail-close) when the credential status query itself fails', async () => {
    mockLoadConfig.mockResolvedValue(webdavConfig);
    mockCredentialStatus.mockRejectedValue(new Error('secure store unavailable'));

    await expect(performAutoSyncOnce()).resolves.toBe('skipped_unconfigured');
    expect(mockRunSync).not.toHaveBeenCalled();
  });

  it('skips when another entry point is syncing, without stealing their lock', async () => {
    mockLoadConfig.mockResolvedValue(webdavConfig);
    mockCredentialStatus.mockResolvedValue(allCredentialsConfigured);
    expect(useGlobalSyncStore.getState().beginSync('manual')).toBe(true);

    await expect(performAutoSyncOnce()).resolves.toBe('skipped_busy');
    expect(mockRunSync).not.toHaveBeenCalled();
    // 手动入口的占用不能被自动同步释放
    expect(useGlobalSyncStore.getState()).toMatchObject({
      isSyncing: true,
      source: 'manual',
    });
  });

  it('fails closed on a prune gap and releases the global lock', async () => {
    mockLoadConfig.mockResolvedValue(webdavConfig);
    mockCredentialStatus.mockResolvedValue(allCredentialsConfigured);
    mockDetectPruneGap.mockResolvedValue({
      has_gap: true,
      since_version: 5,
      min_available_version: 9,
    } as never);

    await expect(performAutoSyncOnce()).resolves.toBe('failure');
    expect(mockRunSync).not.toHaveBeenCalled();
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });

  it('runs a bidirectional keep_latest sync and reports success', async () => {
    mockLoadConfig.mockResolvedValue(webdavConfig);
    mockCredentialStatus.mockResolvedValue(allCredentialsConfigured);
    mockDetectPruneGap.mockResolvedValue({ has_gap: false } as never);
    mockRunSync.mockResolvedValue({ success: true } as never);

    await expect(performAutoSyncOnce()).resolves.toBe('success');
    expect(mockRunSync).toHaveBeenCalledWith(
      'bidirectional',
      webdavConfig,
      'keep_latest',
    );
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });

  it('reports failure when the sync command fails, releasing the lock', async () => {
    mockLoadConfig.mockResolvedValue(webdavConfig);
    mockCredentialStatus.mockResolvedValue(allCredentialsConfigured);
    mockDetectPruneGap.mockResolvedValue({ has_gap: false } as never);
    mockRunSync.mockResolvedValue({ success: false } as never);

    await expect(performAutoSyncOnce()).resolves.toBe('failure');
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });
});

describe('useAutoSyncStore', () => {
  beforeEach(() => {
    useAutoSyncStore.setState({
      enabled: false,
      intervalPreset: '15m',
      lastOutcome: null,
      lastRunAtMs: null,
      consecutiveFailures: 0,
    });
  });

  it('is disabled by default', () => {
    expect(useAutoSyncStore.getState().enabled).toBe(false);
  });

  it('persists enabled, intervalPreset and last-run status (not consecutiveFailures)', () => {
    // [R11-autosync2] 持久化面扩展：档位与上次结果随 enabled 一起落盘，
    // 重启后 UI 仍能回答「上次自动同步是什么时候、结果如何」；
    // consecutiveFailures 是调度器运行时状态，仍不持久化。
    useAutoSyncStore.getState().setEnabled(true);
    try {
      const raw = localStorage.getItem('dstu-auto-sync');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw ?? '{}') as { state?: unknown };
      expect(parsed.state).toEqual({
        enabled: true,
        intervalPreset: '15m',
        lastOutcome: null,
        lastRunAtMs: null,
      });
    } finally {
      // 关闭以停掉 setEnabled(true) 启动的单例调度器，避免测试残留定时器
      useAutoSyncStore.getState().setEnabled(false);
    }
  });

  it('discards malformed persisted JSON and completes hydration with defaults', async () => {
    localStorage.setItem('dstu-auto-sync', '{"state":');

    await useAutoSyncStore.persist.rehydrate();

    expect(useAutoSyncStore.persist.hasHydrated()).toBe(true);
    expect(useAutoSyncStore.getState()).toMatchObject({
      enabled: false,
      intervalPreset: '15m',
      lastOutcome: null,
      lastRunAtMs: null,
      consecutiveFailures: 0,
    });
    expect(localStorage.getItem('dstu-auto-sync')).toBeNull();
  });

  it('sanitizes invalid fields from a current-version persisted envelope', async () => {
    localStorage.setItem('dstu-auto-sync', JSON.stringify({
      version: 2,
      state: {
        enabled: 'true',
        intervalPreset: 'daily',
        lastOutcome: 'unknown',
        lastRunAtMs: -1,
      },
    }));

    await useAutoSyncStore.persist.rehydrate();

    expect(useAutoSyncStore.getState()).toMatchObject({
      enabled: false,
      intervalPreset: '15m',
      lastOutcome: null,
      lastRunAtMs: null,
    });
  });
});
