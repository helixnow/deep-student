/**
 * Generative UI action rate-limit — 防止同一 actionId 双击 / 连点 stampede。
 * 每个 wrap 实例自带 last-fired / in-flight，不使用进程级全局 map。
 */

import type { GenerativeActionDefinition } from '../types';

export const GENERATIVE_ACTION_COOLDOWN_MS = 400;

export class GenerativeActionRateLimitError extends Error {
  readonly actionId: string;
  readonly cooldownMs: number;

  constructor(actionId: string, cooldownMs: number) {
    super(`Action "${actionId}" is rate-limited (cooldown ${cooldownMs}ms)`);
    this.name = 'GenerativeActionRateLimitError';
    this.actionId = actionId;
    this.cooldownMs = cooldownMs;
  }
}

export interface WrapActionWithRateLimitOptions {
  cooldownMs?: number;
  clock?: () => number;
}

interface ActionRateLimitGate {
  wrap(def: GenerativeActionDefinition): GenerativeActionDefinition;
}

/**
 * 工厂：同一 limiter 下多次 wrap 共享 last-fired / in-flight。
 * `wrapActionWithRateLimit` 每次调用会创建独立 limiter。
 */
export function createActionRateLimiter(
  options?: WrapActionWithRateLimitOptions,
): ActionRateLimitGate {
  const cooldownMs = options?.cooldownMs ?? GENERATIVE_ACTION_COOLDOWN_MS;
  const clock = options?.clock ?? Date.now;
  let lastFired: number | undefined;
  let inFlight = false;

  return {
    wrap(def: GenerativeActionDefinition): GenerativeActionDefinition {
      return {
        ...def,
        handler: async (payload) => {
          const now = clock();
          if (inFlight || (lastFired !== undefined && now - lastFired < cooldownMs)) {
            throw new GenerativeActionRateLimitError(def.id, cooldownMs);
          }

          // 接受本次 invoke 即记为 successful start（含后续 handler throw）。
          inFlight = true;
          lastFired = now;
          try {
            return await def.handler(payload);
          } finally {
            inFlight = false;
          }
        },
      };
    },
  };
}

/**
 * 用 per-wrapper 冷却 + in-flight 标志包装 handler。
 * 冷却从最近一次被接受的 invoke 起算；handler 抛错仍占用冷却，避免重试踩踏。
 */
export function wrapActionWithRateLimit(
  def: GenerativeActionDefinition,
  options?: WrapActionWithRateLimitOptions,
): GenerativeActionDefinition {
  return createActionRateLimiter(options).wrap(def);
}
