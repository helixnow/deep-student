/**
 * [R11-autosync2] 自动同步定时档位 + 触发前置检查 fail-close + 手动互斥
 *
 * 与 src/stores/__tests__/autoSyncStore.test.ts（R07 基线：启动延迟/退避/
 * 无配置跳过）不重复，本文件只覆盖 R11 新增面：
 * 1. 档位调度：15m/1h/6h 档位常量、动态间隔求值、档位切换即时重排
 *    （reschedule）、长档位下失败退避不得比常规轮询更频繁；
 * 2. fail-close 错误分类：租约被占（E_SYNC_LEASE_HELD）/ 后端互斥忙 /
 *    未配置加密密码一律静默跳过并记状态，绝不误计失败进入退避；
 * 3. 与手动同步互斥：前端全局锁不被自动同步窃取；后端
 *    BACKUP_GLOBAL_LIMITER 的两条「正在进行中」文案与前端分类器的
 *    跨层契约（从 Rust 源码原文提取，防止后端改文案后前端静默失配）；
 * 4. UI/locale 契约：SyncSettingsSection 档位接线与上次结果展示、
 *    sync.json zh/en autoSync 键对齐且 outcome 键覆盖全部结果值。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  AUTO_SYNC_BUSY_MARKERS,
  AUTO_SYNC_DEFAULT_INTERVAL_PRESET,
  AUTO_SYNC_INTERVAL_MS,
  AUTO_SYNC_INTERVAL_PRESETS,
  AUTO_SYNC_LEASE_HELD_MARKERS,
  AUTO_SYNC_MAX_BACKOFF_MS,
  AUTO_SYNC_UNCONFIGURED_MARKERS,
  classifyAutoSyncSkip,
  createAutoSyncScheduler,
  performAutoSyncOnce,
  useAutoSyncStore,
  useGlobalSyncStore,
  type AutoSyncIntervalPreset,
  type AutoSyncOutcome,
} from '@/stores/syncStatusStore';
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

/** 让 performAutoSyncOnce 通过全部前置检查、直达 runSync 调用点 */
function arrangeConfiguredCloud() {
  mockLoadConfig.mockResolvedValue(webdavConfig);
  mockCredentialStatus.mockResolvedValue(allCredentialsConfigured);
  mockDetectPruneGap.mockResolvedValue({ has_gap: false } as never);
}

// ============================================================================
// 1. 档位调度
// ============================================================================

describe('auto sync interval presets (R11-autosync2)', () => {
  it('exposes exactly the 15m/1h/6h tiers with the documented durations', () => {
    expect(AUTO_SYNC_INTERVAL_PRESETS).toEqual({
      '15m': 15 * 60_000,
      '1h': 60 * 60_000,
      '6h': 6 * 60 * 60_000,
    });
  });

  it('defaults to the 15m tier (R07 behavior unchanged) with the switch off', () => {
    expect(AUTO_SYNC_DEFAULT_INTERVAL_PRESET).toBe('15m');
    expect(AUTO_SYNC_INTERVAL_MS).toBe(AUTO_SYNC_INTERVAL_PRESETS['15m']);
    // 默认关不变：加档位不得顺手改默认开关
    expect(useAutoSyncStore.getInitialState().enabled).toBe(false);
    expect(useAutoSyncStore.getInitialState().intervalPreset).toBe('15m');
  });

  describe('scheduler with a dynamic interval getter', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-evaluates the interval on every (re)schedule', async () => {
      let preset: AutoSyncIntervalPreset = '15m';
      let finishSecondRun!: (outcome: AutoSyncOutcome) => void;
      const secondRun = new Promise<AutoSyncOutcome>((resolve) => {
        finishSecondRun = resolve;
      });
      const run = vi
        .fn<[], Promise<AutoSyncOutcome>>()
        .mockResolvedValueOnce('success')
        .mockImplementationOnce(() => secondRun)
        .mockResolvedValue('success');
      const scheduler = createAutoSyncScheduler({
        isEnabled: () => true,
        runAutoSync: run,
        startupDelayMs: 1_000,
        intervalMs: () => AUTO_SYNC_INTERVAL_PRESETS[preset],
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);

      // 第一轮结束后按 15m 档排程
      expect(scheduler.computeNextDelayMs()).toBe(15 * 60_000);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(run).toHaveBeenCalledTimes(2);

      // 第二轮结束前切到 1h 档：本轮结束时的排程即用新间隔
      preset = '1h';
      finishSecondRun('success');
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.computeNextDelayMs()).toBe(60 * 60_000);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(45 * 60_000);
      expect(run).toHaveBeenCalledTimes(3);

      scheduler.stop();
    });

    it('reschedule() re-arms a pending timer with the new tier immediately', async () => {
      let preset: AutoSyncIntervalPreset = '6h';
      const run = vi
        .fn<[], Promise<AutoSyncOutcome>>()
        .mockResolvedValue('success');
      const scheduler = createAutoSyncScheduler({
        isEnabled: () => true,
        runAutoSync: run,
        startupDelayMs: 1_000,
        intervalMs: () => AUTO_SYNC_INTERVAL_PRESETS[preset],
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);

      // 定时器按 6h 档挂起中；用户切到 15m 档并 reschedule
      preset = '15m';
      scheduler.reschedule();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(run).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });

    it('reschedule() is a no-op when nothing is pending', () => {
      const run = vi
        .fn<[], Promise<AutoSyncOutcome>>()
        .mockResolvedValue('success');
      const scheduler = createAutoSyncScheduler({
        isEnabled: () => false,
        runAutoSync: run,
        intervalMs: () => AUTO_SYNC_INTERVAL_PRESETS['15m'],
      });

      expect(scheduler.isScheduled()).toBe(false);
      scheduler.reschedule();
      expect(scheduler.isScheduled()).toBe(false);
    });

    it('failure backoff on the 6h tier never retries more often than the tier itself', async () => {
      const sixHours = AUTO_SYNC_INTERVAL_PRESETS['6h'];
      expect(sixHours).toBeGreaterThan(AUTO_SYNC_MAX_BACKOFF_MS);

      const run = vi
        .fn<[], Promise<AutoSyncOutcome>>()
        .mockResolvedValue('failure');
      const scheduler = createAutoSyncScheduler({
        isEnabled: () => true,
        runAutoSync: run,
        startupDelayMs: 1_000,
        intervalMs: () => sixHours,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scheduler.getConsecutiveFailures()).toBe(1);
      // min(6h * 2, max(2h, 6h)) = 6h：失败后的重试不得快于常规轮询
      expect(scheduler.computeNextDelayMs()).toBe(sixHours);

      scheduler.stop();
    });

    it('setIntervalPreset persists the tier and survives alongside enabled', () => {
      useAutoSyncStore.getState().setIntervalPreset('6h');
      try {
        expect(useAutoSyncStore.getState().intervalPreset).toBe('6h');
        const raw = localStorage.getItem('dstu-auto-sync');
        const parsed = JSON.parse(raw ?? '{}') as {
          state?: { intervalPreset?: string; enabled?: boolean };
        };
        expect(parsed.state?.intervalPreset).toBe('6h');
        // 改档位绝不顺手打开开关
        expect(parsed.state?.enabled).toBe(false);
      } finally {
        useAutoSyncStore.getState().setIntervalPreset('15m');
      }
    });
  });
});

// ============================================================================
// 2. fail-close 错误分类
// ============================================================================

describe('classifyAutoSyncSkip (fail-close classification)', () => {
  it('classifies the stable lease code and phrases as skipped_lease_held', () => {
    expect(
      classifyAutoSyncSkip('[E_SYNC_LEASE_HELD] 同步租约被其他设备持有'),
    ).toBe('skipped_lease_held');
    expect(classifyAutoSyncSkip('同步租约被其他设备占用，请稍后再试')).toBe(
      'skipped_lease_held',
    );
    expect(classifyAutoSyncSkip('sync target lease is held by device-b')).toBe(
      'skipped_lease_held',
    );
  });

  it('classifies both backend mutual-exclusion rejections as skipped_busy', () => {
    expect(
      classifyAutoSyncSkip(
        '另一个数据治理任务（同步/备份/恢复）正在进行中，请稍后再试。',
      ),
    ).toBe('skipped_busy');
    expect(
      classifyAutoSyncSkip('已有数据治理操作正在运行（当前 Backup，operation_id=x）'),
    ).toBe('skipped_busy');
  });

  it('classifies the missing-encryption-password engine error as skipped_unconfigured', () => {
    expect(
      classifyAutoSyncSkip(
        '云端根目录已存在端到端加密标记（.encryption-marker），但本机未配置加密密码。',
      ),
    ).toBe('skipped_unconfigured');
    expect(
      classifyAutoSyncSkip('[E_SYNC_E2EE_PASSWORD_REQUIRED] rewritten missing password'),
    ).toBe('skipped_unconfigured');
  });

  it('returns null for unknown errors (they stay failures and back off)', () => {
    expect(classifyAutoSyncSkip('network timed out')).toBeNull();
    expect(classifyAutoSyncSkip('')).toBeNull();
    // 密码错误 ≠ 未配置：错密码是需要用户处理的失败，不得静默吞掉
    expect(classifyAutoSyncSkip('解密失败：密码错误或数据损坏')).toBeNull();
  });
});

describe('performAutoSyncOnce fail-close outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGlobalSyncStore.setState({ isSyncing: false, source: null });
  });

  it('maps a rejected lease-held error to skipped_lease_held and releases the lock', async () => {
    arrangeConfiguredCloud();
    mockRunSync.mockRejectedValue(
      new Error('[E_SYNC_LEASE_HELD] 同步租约被其他设备持有：device-b'),
    );

    await expect(performAutoSyncOnce()).resolves.toBe('skipped_lease_held');
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });

  it('maps a lease-held error_message in a failed result to skipped_lease_held', async () => {
    arrangeConfiguredCloud();
    mockRunSync.mockResolvedValue({
      success: false,
      error_message: 'sync target lease is held by another device',
    } as never);

    await expect(performAutoSyncOnce()).resolves.toBe('skipped_lease_held');
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });

  it('maps the backend busy rejection to skipped_busy (backend half of the manual mutex)', async () => {
    arrangeConfiguredCloud();
    mockRunSync.mockRejectedValue(
      '另一个数据治理任务（同步/备份/恢复）正在进行中，请稍后再试。',
    );

    await expect(performAutoSyncOnce()).resolves.toBe('skipped_busy');
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });

  it('maps the missing-encryption-password rejection to skipped_unconfigured', async () => {
    arrangeConfiguredCloud();
    mockRunSync.mockRejectedValue(
      new Error(
        '云端根目录已存在端到端加密标记（.encryption-marker），但本机未配置加密密码。',
      ),
    );

    await expect(performAutoSyncOnce()).resolves.toBe('skipped_unconfigured');
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });

  it('still reports unknown errors as failure (backoff applies)', async () => {
    arrangeConfiguredCloud();
    mockRunSync.mockRejectedValue(new Error('connection reset by peer'));

    await expect(performAutoSyncOnce()).resolves.toBe('failure');
    expect(useGlobalSyncStore.getState().isSyncing).toBe(false);
  });

  it('skipped_lease_held does not change the backoff counter in the scheduler', async () => {
    vi.useFakeTimers();
    try {
      const run = vi
        .fn<[], Promise<AutoSyncOutcome>>()
        .mockResolvedValueOnce('failure')
        .mockResolvedValueOnce('skipped_lease_held');
      const scheduler = createAutoSyncScheduler({
        isEnabled: () => true,
        runAutoSync: run,
        startupDelayMs: 1_000,
        intervalMs: 10_000,
        maxBackoffMs: 40_000,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scheduler.getConsecutiveFailures()).toBe(1);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(run).toHaveBeenCalledTimes(2);
      // 租约被占既不计失败也不清零退避
      expect(scheduler.getConsecutiveFailures()).toBe(1);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records skip outcomes into useAutoSyncStore for the UI (status visibility)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T08:00:00Z'));
    try {
      useAutoSyncStore.setState({
        lastOutcome: null,
        lastRunAtMs: null,
        consecutiveFailures: 0,
      });
      const scheduler = createAutoSyncScheduler({
        isEnabled: () => true,
        runAutoSync: async () => 'skipped_lease_held',
        startupDelayMs: 1_000,
        intervalMs: 10_000,
        onOutcome: (outcome, consecutiveFailures) => {
          useAutoSyncStore.setState({
            lastOutcome: outcome,
            lastRunAtMs: Date.now(),
            consecutiveFailures,
          });
        },
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(useAutoSyncStore.getState().lastOutcome).toBe('skipped_lease_held');
      expect(useAutoSyncStore.getState().lastRunAtMs).toBe(
        new Date('2026-08-24T08:00:01Z').getTime(),
      );
      expect(useAutoSyncStore.getState().consecutiveFailures).toBe(0);

      scheduler.stop();
    } finally {
      vi.useRealTimers();
      useAutoSyncStore.setState({
        lastOutcome: null,
        lastRunAtMs: null,
        consecutiveFailures: 0,
      });
    }
  });
});

// ============================================================================
// 3. 与手动同步互斥
// ============================================================================

describe('mutual exclusion with manual sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGlobalSyncStore.setState({ isSyncing: false, source: null });
  });

  it('skips while a manual sync holds the frontend lock, never stealing or releasing it', async () => {
    mockLoadConfig.mockResolvedValue(webdavConfig);
    mockCredentialStatus.mockResolvedValue(allCredentialsConfigured);
    expect(useGlobalSyncStore.getState().beginSync('sync-settings')).toBe(true);

    await expect(performAutoSyncOnce()).resolves.toBe('skipped_busy');
    expect(mockRunSync).not.toHaveBeenCalled();
    // 手动入口的占用在自动同步跳过后必须原样保留
    expect(useGlobalSyncStore.getState()).toMatchObject({
      isSyncing: true,
      source: 'sync-settings',
    });
    useGlobalSyncStore.getState().endSync();
  });

  const rustCommandsSyncSource = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/data_governance/commands_sync.rs'),
    'utf-8',
  );
  const rustBackupCommonSource = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/backup_common.rs'),
    'utf-8',
  );

  it('cross-layer contract: the backend try_acquire busy message matches a busy marker', () => {
    // commands_sync.rs 的同步命令 busy 拒绝原文
    const backendBusyMessage =
      '另一个数据治理任务（同步/备份/恢复）正在进行中，请稍后再试。';
    expect(rustCommandsSyncSource).toContain(backendBusyMessage);
    expect(
      AUTO_SYNC_BUSY_MARKERS.some((marker) =>
        backendBusyMessage.includes(marker),
      ),
    ).toBe(true);
  });

  it('cross-layer contract: the operation-guard busy message matches a busy marker', () => {
    // backup_common.rs DataGovernanceOperationGuard::try_acquire 的拒绝原文
    const guardBusyMessage = '已有数据治理操作正在运行';
    expect(rustBackupCommonSource).toContain(guardBusyMessage);
    expect(
      AUTO_SYNC_BUSY_MARKERS.some((marker) =>
        guardBusyMessage.includes(marker),
      ),
    ).toBe(true);
  });

  it('cross-layer contract: the missing-password marker matches the engine wording', () => {
    const rustSyncModSource = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/data_governance/sync/mod.rs'),
      'utf-8',
    );
    const rustCloudSource = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/cloud_storage/mod.rs'),
      'utf-8',
    );
    for (const marker of AUTO_SYNC_UNCONFIGURED_MARKERS) {
      expect(
        rustSyncModSource.includes(marker) || rustCloudSource.includes(marker),
        `引擎必须保留自动同步半配置标记 ${marker}`,
      ).toBe(true);
    }
  });
});

// ============================================================================
// 4. UI / locale 契约
// ============================================================================

describe('SyncSettingsSection wiring and locale contract', () => {
  const componentSource = readFileSync(
    resolve(
      process.cwd(),
      'src/features/settings/components/SyncSettingsSection.tsx',
    ),
    'utf-8',
  );
  const zhSync = JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/locales/zh-CN/sync.json'), 'utf-8'),
  ) as { autoSync: Record<string, unknown> };
  const enSync = JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/locales/en-US/sync.json'), 'utf-8'),
  ) as { autoSync: Record<string, unknown> };

  it('wires the interval tier selector to setIntervalPreset with all three tiers', () => {
    expect(componentSource).toContain('setIntervalPreset');
    expect(componentSource).toContain("t('sync:autoSync.intervalLabel')");
    for (const tier of ['15m', '1h', '6h'] as const) {
      expect(componentSource).toContain(`t('sync:autoSync.interval.${tier}')`);
    }
    // 关闭自动同步时档位选择禁用（但不隐藏，用户仍能看到当前档位）
    expect(componentSource).toContain('disabled={!autoSyncEnabled}');
  });

  it('shows the last auto-sync time and outcome from the store', () => {
    expect(componentSource).toContain('lastRunAtMs');
    expect(componentSource).toContain('lastOutcome');
    expect(componentSource).toContain("t('sync:autoSync.lastRun')");
    expect(componentSource).toContain("t('sync:autoSync.neverRan')");
  });

  it('locale zh/en autoSync subtrees have identical key shapes', () => {
    const collectKeys = (node: unknown, prefix = ''): string[] => {
      if (node === null || typeof node !== 'object') return [prefix];
      return Object.entries(node as Record<string, unknown>).flatMap(
        ([key, value]) => collectKeys(value, prefix ? `${prefix}.${key}` : key),
      );
    };
    expect(collectKeys(zhSync.autoSync).sort()).toEqual(
      collectKeys(enSync.autoSync).sort(),
    );
  });

  it('locale outcome keys cover every AutoSyncOutcome value used by the UI', () => {
    const outcomeKeyByValue: Record<AutoSyncOutcome, string> = {
      success: 'success',
      failure: 'failure',
      skipped_unconfigured: 'skippedUnconfigured',
      skipped_busy: 'skippedBusy',
      skipped_lease_held: 'skippedLeaseHeld',
    };
    for (const locale of [zhSync, enSync]) {
      const outcome = (locale.autoSync as { outcome: Record<string, string> })
        .outcome;
      for (const key of Object.values(outcomeKeyByValue)) {
        expect(outcome[key], `missing autoSync.outcome.${key}`).toBeTruthy();
      }
      expect(
        (locale.autoSync as { interval: Record<string, string> }).interval,
      ).toMatchObject({
        '15m': expect.any(String),
        '1h': expect.any(String),
        '6h': expect.any(String),
      });
    }
  });

  it('the stable lease code marker stays first in the classification list', () => {
    // FIX-QUEUE 契约：R11-lease 的租约被占错误必须包含 E_SYNC_LEASE_HELD；
    // 前端以该稳定码为主匹配，人话片段只是兜底。
    expect(AUTO_SYNC_LEASE_HELD_MARKERS[0]).toBe('E_SYNC_LEASE_HELD');
  });
});
