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
import {
  persist,
  type PersistStorage,
  type StorageValue,
} from 'zustand/middleware';

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

// ==================== 自动同步（R07-autosync / R11-autosync2） ====================
//
// 默认关闭的自动同步开关：开启后由前端调度器在启动延迟后按所选档位定时执行
// 双向同步，失败按指数退避。安全底线（fail-close，静默跳过、绝不弹错打扰）：
// - 云存储配置缺失，或系统安全存储中没有当前 provider 的凭据 → 本轮直接
//   跳过（skipped_unconfigured），绝不在半配置状态下自动运行；
// - 引擎报「未配置加密密码」（云端要求 E2EE 但本机无密码）→ 同样归为
//   skipped_unconfigured，不进入失败退避；
// - 同步租约被其他设备占用（R11-lease，稳定错误码 E_SYNC_LEASE_HELD）→
//   跳过（skipped_lease_held），等下一轮租约自然过期后再试；
// - 同步断层预检（detectPruneGap）失败或存在断层 → 视为失败进入退避；
// - 与手动入口共享 useGlobalSyncStore 全局锁，正在同步时跳过本轮；后端
//   BACKUP_GLOBAL_LIMITER 的「正在进行中」拒绝同样归为 skipped_busy。
// 每轮结果（时间/结果/连续失败数）写回 useAutoSyncStore 供 UI 展示。
// 本模块只做前端调度，不改 Rust 引擎，也不接入 workbench 壳层。

/** 单轮自动同步的结果，决定退避计数如何变化 */
export type AutoSyncOutcome =
  | 'success'
  | 'failure'
  /** 未配置 / 半配置（缺凭据或加密密码）：没有执行同步，不计失败也不清零退避 */
  | 'skipped_unconfigured'
  /** 其他入口正在同步（前端全局锁或后端全局互斥拒绝）：不影响退避计数 */
  | 'skipped_busy'
  /** 同步租约被其他设备占用：没有写入云端，不计失败也不清零退避 */
  | 'skipped_lease_held';

/** 自动同步定时档位（R11-autosync2）。默认 15 分钟，与 R07 行为一致。 */
export type AutoSyncIntervalPreset = '15m' | '1h' | '6h';

/** 各档位对应的轮询间隔（毫秒） */
export const AUTO_SYNC_INTERVAL_PRESETS: Record<AutoSyncIntervalPreset, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
};

export const AUTO_SYNC_DEFAULT_INTERVAL_PRESET: AutoSyncIntervalPreset = '15m';

/** 调度器启动（或开关打开）后到第一轮同步的延迟 */
export const AUTO_SYNC_STARTUP_DELAY_MS = 30_000;
/** 常规轮询间隔（默认档位；实际间隔由 intervalPreset 决定） */
export const AUTO_SYNC_INTERVAL_MS =
  AUTO_SYNC_INTERVAL_PRESETS[AUTO_SYNC_DEFAULT_INTERVAL_PRESET];
/**
 * 失败退避上限。若所选档位间隔比该值更长（如 6h 档），以档位间隔为准——
 * 失败后的重试永远不会比常规轮询更频繁。
 */
export const AUTO_SYNC_MAX_BACKOFF_MS = 2 * 60 * 60_000;

// ---------------------------------------------------------------------------
// 触发前置检查的错误分类（fail-close：可识别的「不该跑」错误静默跳过）
// ---------------------------------------------------------------------------

/**
 * 同步租约被占的稳定标记。
 *
 * `E_SYNC_LEASE_HELD` 是与 R11-lease（后端 sync target 租约）约定的稳定
 * 错误码（已在 FIX-QUEUE 登记）：后端租约被占错误文案必须包含该 token。
 * 其余为兜底的人话片段，避免后端先行发布时自动同步把租约冲突误计为失败。
 */
export const AUTO_SYNC_LEASE_HELD_MARKERS: readonly string[] = [
  'E_SYNC_LEASE_HELD',
  '同步租约被其他设备',
  'sync target lease is held',
];

/**
 * 后端全局互斥（BACKUP_GLOBAL_LIMITER / DataGovernanceOperationGuard）的
 * 「正在进行中」拒绝文案片段。这些拒绝说明另一个数据治理任务正在运行，
 * 语义上等同于前端全局锁被占：跳过本轮，不计失败。
 */
export const AUTO_SYNC_BUSY_MARKERS: readonly string[] = [
  '另一个数据治理任务',
  '已有数据治理操作正在运行',
];

/**
 * 半配置（云端要求加密但本机无密码）的引擎稳定文案片段，
 * 与 SyncTab 的 classifySyncError missing_password 分支一致。
 */
export const AUTO_SYNC_UNCONFIGURED_MARKERS: readonly string[] = [
  'E_SYNC_E2EE_PASSWORD_REQUIRED',
  '未配置加密密码',
];

export type AutoSyncSkipOutcome = Extract<
  AutoSyncOutcome,
  'skipped_unconfigured' | 'skipped_busy' | 'skipped_lease_held'
>;

/**
 * 把同步错误分类为「应静默跳过」的结果；无法识别的错误返回 null（照旧
 * 计为 failure 进入退避）。匹配顺序：租约 → 互斥忙 → 半配置。
 */
export function classifyAutoSyncSkip(rawError: string): AutoSyncSkipOutcome | null {
  if (AUTO_SYNC_LEASE_HELD_MARKERS.some((marker) => rawError.includes(marker))) {
    return 'skipped_lease_held';
  }
  if (AUTO_SYNC_BUSY_MARKERS.some((marker) => rawError.includes(marker))) {
    return 'skipped_busy';
  }
  if (AUTO_SYNC_UNCONFIGURED_MARKERS.some((marker) => rawError.includes(marker))) {
    return 'skipped_unconfigured';
  }
  return null;
}

export interface AutoSyncSchedulerOptions {
  /** 每次调度前检查开关；返回 false 时不再排下一轮 */
  isEnabled: () => boolean;
  /** 执行一轮自动同步（含全部安全检查），永不 reject 更佳，reject 视为 failure */
  runAutoSync: () => Promise<AutoSyncOutcome>;
  /** 每轮结束回调（用于把结果写回 store 供 UI 展示） */
  onOutcome?: (outcome: AutoSyncOutcome, consecutiveFailures: number) => void;
  startupDelayMs?: number;
  /**
   * 轮询间隔；传函数时每次排程都会重新求值（R11-autosync2：档位切换后
   * 下一轮立即按新档位计时，无需重建调度器）
   */
  intervalMs?: number | (() => number);
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
  /**
   * 档位变更后调用：若有待触发的定时器，取消并按新间隔重排。
   * 未排程（未开启或正在执行中）时为 no-op——执行中的一轮结束时本就会
   * 按最新间隔重排。
   */
  reschedule: () => void;
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
  const intervalOption = options.intervalMs ?? AUTO_SYNC_INTERVAL_MS;
  const resolveIntervalMs = () =>
    typeof intervalOption === 'function' ? intervalOption() : intervalOption;
  const maxBackoffMs = options.maxBackoffMs ?? AUTO_SYNC_MAX_BACKOFF_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let consecutiveFailures = 0;

  const computeNextDelayMs = () => {
    const intervalMs = resolveIntervalMs();
    if (consecutiveFailures === 0) return intervalMs;
    // 退避封顶取 max(maxBackoffMs, intervalMs)：长档位（如 6h）下失败重试
    // 不得比常规轮询更频繁
    return Math.min(
      intervalMs * 2 ** consecutiveFailures,
      Math.max(maxBackoffMs, intervalMs),
    );
  };

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
    reschedule: () => {
      if (timer === null) return;
      schedule(computeNextDelayMs());
    },
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
    if (result.success) return 'success';
    // 引擎在结果里报租约被占/互斥忙/半配置时同样静默跳过，不计失败
    return classifyAutoSyncSkip(result.error_message ?? '') ?? 'failure';
  } catch (err) {
    // 后端以 reject 报错（Tauri 命令层拒绝、租约被占、全局互斥忙等）：
    // 可识别的「不该跑」错误静默跳过，其余计为失败进入退避。
    const message = err instanceof Error ? err.message : String(err);
    return classifyAutoSyncSkip(message) ?? 'failure';
  } finally {
    useGlobalSyncStore.getState().endSync();
  }
}

interface AutoSyncState {
  /** 自动同步开关（默认关闭；持久化） */
  enabled: boolean;
  /** 定时档位（默认 15 分钟；持久化） */
  intervalPreset: AutoSyncIntervalPreset;
  /**
   * 最近一轮的结果与时间（持久化，重启后 UI 仍能回答
   * 「上次自动同步是什么时候、结果如何」）
   */
  lastOutcome: AutoSyncOutcome | null;
  lastRunAtMs: number | null;
  /** 连续失败次数（运行时状态，不持久化） */
  consecutiveFailures: number;
  setEnabled: (enabled: boolean) => void;
  setIntervalPreset: (preset: AutoSyncIntervalPreset) => void;
}

/** persist 切片：v1 只有 enabled；缺字段必须补默认值，禁止把 Partial 当完整快照。 */
type AutoSyncPersisted = Pick<
  AutoSyncState,
  'enabled' | 'intervalPreset' | 'lastOutcome' | 'lastRunAtMs'
>;

const AUTO_SYNC_OUTCOMES = new Set<AutoSyncOutcome>([
  'success',
  'failure',
  'skipped_unconfigured',
  'skipped_busy',
  'skipped_lease_held',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migrateAutoSyncPersisted(persisted: unknown): AutoSyncPersisted {
  const p = isRecord(persisted) ? persisted : {};
  const intervalPreset =
    p.intervalPreset === '15m' || p.intervalPreset === '1h' || p.intervalPreset === '6h'
      ? p.intervalPreset
      : AUTO_SYNC_DEFAULT_INTERVAL_PRESET;
  const lastOutcome =
    p.lastOutcome === null || AUTO_SYNC_OUTCOMES.has(p.lastOutcome as AutoSyncOutcome)
      ? p.lastOutcome as AutoSyncOutcome | null
      : null;
  return {
    enabled: p.enabled === true,
    intervalPreset,
    lastOutcome,
    lastRunAtMs:
      typeof p.lastRunAtMs === 'number'
      && Number.isFinite(p.lastRunAtMs)
      && p.lastRunAtMs >= 0
        ? p.lastRunAtMs
        : null,
  };
}

/**
 * Zustand's default JSON storage lets JSON.parse reject hydration. A broken
 * payload then leaves hasHydrated() false and repeats the same failure on every
 * launch. Discard unreadable envelopes at the storage boundary so defaults can
 * hydrate normally; the merge below separately sanitizes valid JSON.
 */
function createAutoSyncPersistStorage(): PersistStorage<AutoSyncPersisted> | undefined {
  let storage: Storage;
  try {
    if (typeof window === 'undefined') return undefined;
    storage = window.localStorage;
  } catch {
    return undefined;
  }

  const discard = (name: string) => {
    try {
      storage.removeItem(name);
    } catch {
      // Best effort: an unavailable storage backend is equivalent to no state.
    }
  };

  return {
    getItem: (name) => {
      let raw: string | null;
      try {
        raw = storage.getItem(name);
      } catch {
        return null;
      }
      if (raw === null) return null;

      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || !Object.prototype.hasOwnProperty.call(parsed, 'state')) {
          discard(name);
          return null;
        }
        return parsed as StorageValue<AutoSyncPersisted>;
      } catch {
        discard(name);
        return null;
      }
    },
    setItem: (name, value) => {
      try {
        storage.setItem(name, JSON.stringify(value));
      } catch {
        // Persistence is best effort; runtime auto-sync state remains usable.
      }
    },
    removeItem: discard,
  };
}

export const useAutoSyncStore = create<AutoSyncState>()(
  persist<AutoSyncState, [], [], AutoSyncPersisted>(
    (set) => ({
      enabled: false,
      intervalPreset: AUTO_SYNC_DEFAULT_INTERVAL_PRESET,
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
      setIntervalPreset: (preset) => {
        set({ intervalPreset: preset });
        // 已排程的下一轮立刻按新档位重排（未开启/执行中为 no-op）
        getAutoSyncScheduler().reschedule();
      },
    }),
    {
      name: 'dstu-auto-sync',
      version: 2,
      storage: createAutoSyncPersistStorage(),
      partialize: (state): AutoSyncPersisted => ({
        enabled: state.enabled,
        intervalPreset: state.intervalPreset,
        lastOutcome: state.lastOutcome,
        lastRunAtMs: state.lastRunAtMs,
      }),
      migrate: migrateAutoSyncPersisted,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...migrateAutoSyncPersisted(persistedState),
      }),
    },
  ),
);

let schedulerSingleton: AutoSyncScheduler | null = null;

function getAutoSyncScheduler(): AutoSyncScheduler {
  if (!schedulerSingleton) {
    schedulerSingleton = createAutoSyncScheduler({
      isEnabled: () => useAutoSyncStore.getState().enabled,
      // 每次排程都按当前档位求值；未知/损坏的持久化值回退默认档位
      intervalMs: () =>
        AUTO_SYNC_INTERVAL_PRESETS[useAutoSyncStore.getState().intervalPreset]
        ?? AUTO_SYNC_INTERVAL_MS,
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
 * 启动所有权在 App/服务层：App.tsx 在 useAutoSyncStore persist hydration
 * 完成后调用本函数（与 initReminderScheduler 同模式），因此"启动后自动
 * 同步"的语义是：持久化开关为开时，应用启动后调度器即开始计时，无需
 * 进入任何设置页。设置组件（SyncSettingsSection、SyncTab）挂载时的调用
 * 仅为兼容性双保险，可留可删——本函数与底层 start() 均防重，重复调用
 * 不会产生第二个定时器。
 */
export function ensureAutoSyncSchedulerStarted(): void {
  getAutoSyncScheduler().start();
}
