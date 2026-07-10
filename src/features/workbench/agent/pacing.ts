/**
 * ACR pacing engine — R1-07 / R3-03
 *
 * createPacer：token-bucket（容量 1）+ rAF 合帧。
 * - 桶按 opIntervalMs 补充 1 token；tick(cost) 消耗 cost 个 token，不足则等待
 * - 等待结束后再经 rAF 对齐帧
 * - prefers-reduced-motion: reduce → 强制 fast（instant）
 * - dispose 取消挂起并 resolve 队列（不悬挂）
 *
 * 数值见 DESIGN §4.3；契约见 ./types.ts。
 * R3-03 体感审定：
 * - 导图/离散 op：normal 300ms、demo 600ms（不变）
 * - 打字机：normal ~42Hz(24ms)、demo ~21Hz(48ms)，批 8–40 / 4–16
 * - 列表类（todo/finder/fsrs/qbank）：LIST_INTERVAL_MS + listTickCost
 */
import type { Pacer, PacingProfile, PacingProfileName } from './types';

export const PACING_PROFILES: Record<PacingProfileName, PacingProfile> = {
  fast: {
    name: 'fast',
    opIntervalMs: 0,
    typeBatchMin: 9999,
    typeBatchMax: 9999,
    typeIntervalMs: 0,
    instant: true,
  },
  normal: {
    name: 'normal',
    opIntervalMs: 300,
    typeBatchMin: 8,
    typeBatchMax: 40,
    typeIntervalMs: 24,
    instant: false,
  },
  demo: {
    name: 'demo',
    opIntervalMs: 600,
    typeBatchMin: 4,
    typeBatchMax: 16,
    typeIntervalMs: 48,
    instant: false,
  },
};

/**
 * 列表类逐条间隔（DESIGN §4.3：normal≈150、demo≈300）。
 * 不扩展冻结的 PacingProfile；由 listTickCost 换算相对 opIntervalMs 的 tick cost。
 */
export const LIST_INTERVAL_MS: Record<PacingProfileName, number> = {
  fast: 0,
  normal: 150,
  demo: 300,
};

/** 列表类 driver 的 tick cost（相对 opIntervalMs） */
export function listTickCost(profile: PacingProfile): number {
  if (profile.instant || profile.opIntervalMs <= 0) return 0;
  const listMs = LIST_INTERVAL_MS[profile.name] ?? profile.opIntervalMs;
  return Math.max(0.05, listMs / profile.opIntervalMs);
}

function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function scheduleRaf(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(cb);
  }
  return setTimeout(cb, 0) as unknown as number;
}

function cancelRaf(id: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    try {
      cancelAnimationFrame(id);
      return;
    } catch {
      /* fallthrough */
    }
  }
  clearTimeout(id);
}

/**
 * 运行时把 pacer 降为 instant（保留原档位名）。
 * 用于 background 直落、演出窗超限、perfMonitor 连续慢帧自动降 fast。
 * 直接改 profile 对象：tick 读同一引用，无需改冻结的 Pacer 接口。
 */
export function forcePacerInstant(pacer: Pacer, reason?: string): void {
  if (pacer.profile.instant) return;
  const name = pacer.profile.name;
  Object.assign(pacer.profile, PACING_PROFILES.fast, { name });
  if (reason && typeof console !== 'undefined') {
    try {
      console.debug?.(`[acr:pacing] force instant (${reason}), kept name=${name}`);
    } catch {
      /* ignore */
    }
  }
}

export function createPacer(profile: PacingProfileName): Pacer {
  const base = PACING_PROFILES[profile] ?? PACING_PROFILES.normal;
  const forceInstant = prefersReducedMotion();
  // reduced-motion：参数走 fast，但保留请求档位名便于上层日志
  const effective: PacingProfile = forceInstant
    ? { ...PACING_PROFILES.fast, name: base.name }
    : { ...base };

  let disposed = false;
  let chain: Promise<void> = Promise.resolve();
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRaf: number | null = null;
  const pendingFinishers: Array<() => void> = [];

  // token-bucket：容量 1；初始 0 → 首次 tick 也需等待一个 refill 周期（演出间隔语义）
  const capacity = 1;
  let tokens = 0;
  let lastRefillAt = Date.now();

  const refill = (): void => {
    const interval = effective.opIntervalMs;
    if (interval <= 0) {
      tokens = capacity;
      lastRefillAt = Date.now();
      return;
    }
    const now = Date.now();
    const elapsed = now - lastRefillAt;
    if (elapsed <= 0) return;
    const gained = elapsed / interval;
    tokens = Math.min(capacity, tokens + gained);
    lastRefillAt = now;
  };

  const clearScheduled = () => {
    if (pendingTimer != null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (pendingRaf != null) {
      cancelRaf(pendingRaf);
      pendingRaf = null;
    }
  };

  const waitMsThenRaf = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (disposed) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const idx = pendingFinishers.indexOf(finish);
        if (idx >= 0) pendingFinishers.splice(idx, 1);
        resolve();
      };
      pendingFinishers.push(finish);

      const afterDelay = () => {
        pendingTimer = null;
        if (disposed) {
          finish();
          return;
        }
        pendingRaf = scheduleRaf(() => {
          pendingRaf = null;
          finish();
        });
      };

      if (ms <= 0) {
        afterDelay();
        return;
      }
      pendingTimer = setTimeout(afterDelay, ms);
    });

  /**
   * 等待直到桶内有足够 token（cost），扣减后经 rAF 合帧返回。
   * cost>1 时按「需要 cost 次 refill」等待（容量 1 时等价于 cost * opIntervalMs）。
   */
  const acquire = (cost: number): Promise<void> => {
    const need = Math.max(0, cost);
    if (need <= 0 || effective.instant || effective.opIntervalMs <= 0) {
      return waitMsThenRaf(0);
    }

    refill();
    if (tokens >= need) {
      tokens -= need;
      return waitMsThenRaf(0);
    }

    // 容量 1：不足时等待 (need - tokens) * opIntervalMs
    const deficit = need - tokens;
    const wait = deficit * effective.opIntervalMs;
    tokens = 0;
    // 预支：等待结束后视为已 refill 并消费
    lastRefillAt = Date.now() + wait;
    return waitMsThenRaf(wait).then(() => {
      // 等待结束：token 已用于本次 tick，保持 0
      tokens = 0;
      lastRefillAt = Date.now();
    });
  };

  return {
    profile: effective,
    tick(cost = 1): Promise<void> {
      if (disposed || effective.instant) {
        return Promise.resolve();
      }
      const job = chain.then(() => {
        if (disposed || effective.instant) return;
        return acquire(Math.max(0, cost));
      });
      chain = job.then(
        () => undefined,
        () => undefined,
      );
      return job;
    },
    dispose(): void {
      disposed = true;
      clearScheduled();
      const finishers = pendingFinishers.splice(0, pendingFinishers.length);
      for (const finish of finishers) finish();
      chain = Promise.resolve();
    },
  };
}
