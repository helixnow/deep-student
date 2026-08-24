/**
 * Generative UI action timeout — 防止悬挂 handler 永久卡住 ActionBar。
 * 只停止等待，不 abort 底层 handler（handler 类型无 AbortSignal）。
 */

import type { GenerativeActionDefinition } from '../types';

export const GENERATIVE_ACTION_TIMEOUT_MS = 15_000;

export class GenerativeActionTimeoutError extends Error {
  readonly actionId: string;
  readonly timeoutMs: number;

  constructor(actionId: string, timeoutMs: number) {
    super(`Action "${actionId}" timed out after ${timeoutMs}ms`);
    this.name = 'GenerativeActionTimeoutError';
    this.actionId = actionId;
    this.timeoutMs = timeoutMs;
  }
}

export interface WrapActionWithTimeoutOptions {
  timeoutMs?: number;
}

/**
 * 用 Promise.race + setTimeout 包装 handler。
 * 先结算的一方胜出；timer 在成功与失败路径都会 clear。
 */
export function wrapActionWithTimeout(
  def: GenerativeActionDefinition,
  options?: WrapActionWithTimeoutOptions,
): GenerativeActionDefinition {
  const timeoutMs = options?.timeoutMs ?? GENERATIVE_ACTION_TIMEOUT_MS;

  return {
    ...def,
    handler: async (payload) => {
      const handlerPromise = Promise.resolve(def.handler(payload));
      // timeout 先胜出时，底层 handler 仍可能后续 reject；吞掉以免未处理拒绝。
      handlerPromise.catch(() => undefined);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new GenerativeActionTimeoutError(def.id, timeoutMs));
        }, timeoutMs);
      });
      // race 结算后 timeoutPromise 可能仍处于 pending；clear 后不应再 reject。
      timeoutPromise.catch(() => undefined);

      try {
        return await Promise.race([handlerPromise, timeoutPromise]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}
