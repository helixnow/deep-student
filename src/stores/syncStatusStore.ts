/**
 * 全局云同步运行状态
 *
 * 云同步有多个 UI 入口（设置页 SyncSettingsSection、数据治理面板 SyncTab 等），
 * 此前各入口用组件内 useState 各自维护 isSyncing，彼此不可见，用户可以在
 * 两个页面同时触发同步。后端已用 try_acquire 全局锁兜底（第二个请求立即
 * 失败），本 store 让所有入口共享同一份"正在同步"状态：
 * - 同步进行中时所有入口的按钮统一禁用；
 * - 重复触发在前端即被拦截，无需等后端报错。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface GlobalSyncState {
  /** 是否有同步正在进行（任意入口触发的都算） */
  isSyncing: boolean;
  /** 触发当前同步的入口标识（用于调试与提示） */
  source: string | null;
  /**
   * 尝试开始一次同步。
   * @returns true 表示成功占用；false 表示已有同步在进行，调用方应放弃本次触发
   */
  beginSync: (source: string) => boolean;
  /** 同步结束（无论成功失败）时调用，释放占用 */
  endSync: () => void;
}

export const useGlobalSyncStore = create<GlobalSyncState>((set, get) => ({
  isSyncing: false,
  source: null,
  beginSync: (source) => {
    if (get().isSyncing) {
      return false;
    }
    set({ isSyncing: true, source });
    return true;
  },
  endSync: () => set({ isSyncing: false, source: null }),
}));

// ==================== 自动同步（R07-autosync） ====================
//
// 默认关闭的自动同步开关：开启后由前端调度器在启动延迟后定时执行双向同步，
// 失败按指数退避。安全底线（fail-close）：
// - 云存储配置缺失，或系统安全存储中没有当前 provider 的凭据 → 本轮直接
//   跳过（skipped_unconfigured），绝不在半配置状态下自动运行；
// - 同步断层预检（detectPruneGap）失败或存在断层 → 视为失败进入退避；
// - 与手动入口共享 useGlobalSyncStore 全局锁，正在同步时跳过本轮。
// 本模块只做前端调度，不改 Rust 引擎，也不接入 workbench 壳层。

/** 单轮自动同步的结果，决定退避计数如何变化 */
export type AutoSyncOutcome =
  | 'success'
  | 'failure'
  /** 未配置 / 半配置（缺凭据）：没有执行同步，不计失败也不清零退避 */
  | 'skipped_unconfigured'
  /** 其他入口正在同步：没有执行同步，不影响退避计数 */
  | 'skipped_busy';

/** 调度器启动（或开关打开）后到第一轮同步的延迟 */
export const AUTO_SYNC_STARTUP_DELAY_MS = 30_000;
/** 常规轮询间隔 */
export const AUTO_SYNC_INTERVAL_MS = 15 * 60_000;
/** 失败退避上限（interval * 2^failures 封顶到该值） */
export const AUTO_SYNC_MAX_BACKOFF_MS = 2 * 60 * 60_000;

export interface AutoSyncSchedulerOptions {
  /** 每次调度前检查开关；返回 false 时不再排下一轮 */
  isEnabled: () => boolean;
  /** 执行一轮自动同步（含全部安全检查），永不 reject 更佳，reject 视为 failure */
  runAutoSync: () => Promise<AutoSyncOutcome>;
  /** 每轮结束回调（用于把结果写回 store 供 UI 展示） */
  onOutcome?: (outcome: AutoSyncOutcome, consecutiveFailures: number) => void;
  startupDelayMs?: number;
  intervalMs?: number;
  maxBackoffMs?: number;
}

export interface AutoSyncScheduler {
  /** 幂等：已排程或未开启时为 no-op */
  start: () => void;
  stop: () => void;
  /** 是否有待触发的定时器 */
  isScheduled: () => boolean;
  getConsecutiveFailures: () => number;
  /** 按当前退避计数计算下一轮间隔（导出便于测试与 UI 展示） */
  computeNextDelayMs: () => number;
}

/**
 * 创建自动同步调度器（依赖注入，便于 vitest 用假定时器验证退避行为）。
 *
 * 时序：start() → startupDelay 后第一轮 → 之后每轮结束时按结果重排：
 * - success：退避清零，下一轮 = intervalMs
 * - failure：failures+1，下一轮 = min(intervalMs * 2^failures, maxBackoffMs)
 * - skipped_*：本轮没跑，退避计数不变，下一轮 = 按当前计数正常计算
 */
export function createAutoSyncScheduler(
  options: AutoSyncSchedulerOptions,
): AutoSyncScheduler {
  const startupDelayMs = options.startupDelayMs ?? AUTO_SYNC_STARTUP_DELAY_MS;
  const intervalMs = options.intervalMs ?? AUTO_SYNC_INTERVAL_MS;
  const maxBackoffMs = options.maxBackoffMs ?? AUTO_SYNC_MAX_BACKOFF_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let consecutiveFailures = 0;

  const computeNextDelayMs = () =>
    consecutiveFailures === 0
      ? intervalMs
      : Math.min(intervalMs * 2 ** consecutiveFailures, maxBackoffMs);

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    // 定时器触发与用户关闭开关之间存在窗口：触发时再查一次开关
    if (!options.isEnabled()) return;
    if (running) return;
    running = true;
    let outcome: AutoSyncOutcome;
    try {
      outcome = await options.runAutoSync();
    } catch {
      outcome = 'failure';
    } finally {
      running = false;
    }
    if (outcome === 'success') {
      consecutiveFailures = 0;
    } else if (outcome === 'failure') {
      consecutiveFailures += 1;
    }
    options.onOutcome?.(outcome, consecutiveFailures);
    if (options.isEnabled()) {
      schedule(computeNextDelayMs());
    }
  };

  return {
    start: () => {
      if (timer !== null || running) return;
      if (!options.isEnabled()) return;
      schedule(startupDelayMs);
    },
    stop: clearTimer,
    isScheduled: () => timer !== null,
    getConsecutiveFailures: () => consecutiveFailures,
    computeNextDelayMs,
  };
}

/**
 * 默认的单轮自动同步实现。
 *
 * 依赖用动态 import 加载，避免 store 模块被引入时就拉起 Tauri API 链，
 * 也让测试可以整体 mock 掉这两个模块。
 */
export async function performAutoSyncOnce(): Promise<AutoSyncOutcome> {
  const cloudApi = await import('@/utils/cloudStorageApi');

  const config = await cloudApi.loadStoredCloudStorageConfigWithCredentials();
  if (!config) return 'skipped_unconfigured';

  // 半配置防线：安全存储里没有当前 provider 的凭据（例如配置导入了但密码
  // 没录入）时绝不自动同步；凭据状态查询失败也 fail-close 跳过本轮。
  try {
    const status = await cloudApi.getCredentialStatus();
    const credentialReady =
      (config.provider === 'webdav' && status.webdavPasswordConfigured)
      || (config.provider === 's3' && status.s3SecretAccessKeyConfigured)
      || (config.provider === 'ftp' && status.ftpPasswordConfigured);
    if (!credentialReady) return 'skipped_unconfigured';
  } catch {
    return 'skipped_unconfigured';
  }

  // 与手动入口互斥：占不到全局锁说明有同步在跑，本轮跳过
  if (!useGlobalSyncStore.getState().beginSync('auto-sync')) {
    return 'skipped_busy';
  }
  try {
    const api = await import('@/api/dataGovernance');
    // 双向同步含下载路径，同步断层预检必须 fail-close
    const gap = await api.DataGovernanceApi.detectPruneGap(config);
    if (gap.has_gap) return 'failure';
    const result = await api.runSyncWithProgress(
      'bidirectional',
      config,
      'keep_latest',
    );
    return result.success ? 'success' : 'failure';
  } catch {
    return 'failure';
  } finally {
    useGlobalSyncStore.getState().endSync();
  }
}

interface AutoSyncState {
  /** 自动同步开关（唯一持久化字段，默认关闭） */
  enabled: boolean;
  /** 最近一轮的结果（运行时状态，不持久化） */
  lastOutcome: AutoSyncOutcome | null;
  lastRunAtMs: number | null;
  consecutiveFailures: number;
  setEnabled: (enabled: boolean) => void;
}

export const useAutoSyncStore = create<AutoSyncState>()(
  persist(
    (set) => ({
      enabled: false,
      lastOutcome: null,
      lastRunAtMs: null,
      consecutiveFailures: 0,
      setEnabled: (enabled) => {
        set({ enabled });
        if (enabled) {
          getAutoSyncScheduler().start();
        } else {
          getAutoSyncScheduler().stop();
        }
      },
    }),
    {
      name: 'dstu-auto-sync',
      version: 1,
      partialize: (state) => ({ enabled: state.enabled }),
    },
  ),
);

let schedulerSingleton: AutoSyncScheduler | null = null;

function getAutoSyncScheduler(): AutoSyncScheduler {
  if (!schedulerSingleton) {
    schedulerSingleton = createAutoSyncScheduler({
      isEnabled: () => useAutoSyncStore.getState().enabled,
      runAutoSync: performAutoSyncOnce,
      onOutcome: (outcome, consecutiveFailures) => {
        useAutoSyncStore.setState({
          lastOutcome: outcome,
          lastRunAtMs: Date.now(),
          consecutiveFailures,
        });
      },
    });
  }
  return schedulerSingleton;
}

/**
 * 确保调度器已启动（幂等；开关关闭时为 no-op）。
 *
 * 由同步相关设置组件挂载时调用——不接入 workbench 壳层，因此"启动后自动
 * 同步"的语义是：持久化开关为开时，任一同步设置面加载后调度器即开始计时。
 */
export function ensureAutoSyncSchedulerStarted(): void {
  getAutoSyncScheduler().start();
}
