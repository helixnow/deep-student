/**
 * AIMD 自适应并发：连续成功缓慢 +1，遇限流（429）减半并冷却。用于帧说明（VLM）批量调用。
 *
 * Adapted from wangke-agent `src/utils/concurrency.ts`
 * (https://github.com/BA7MLV/wangke-agent).
 * MIT License — Copyright (c) 2026 BA7MLV. Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated
 * documentation files, to deal in the Software without restriction, subject to the
 * condition that the above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software. THE SOFTWARE IS
 * PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */

export class AdaptiveLimit {
  private limit: number;
  private streak = 0;
  cooldownUntil = 0;

  constructor(
    initial: number,
    private readonly min = 1,
    private readonly max = 8,
    private readonly growEvery = 4,
  ) {
    this.limit = Math.max(min, Math.min(max, Math.round(initial)));
  }

  get current(): number {
    return this.limit;
  }

  onSuccess(): void {
    this.streak++;
    if (this.streak >= this.growEvery && this.limit < this.max) {
      this.limit++;
      this.streak = 0;
    }
  }

  onRateLimit(cooldownMs = 2000): void {
    this.limit = Math.max(this.min, Math.floor(this.limit / 2));
    this.streak = 0;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldownMs);
  }
}

/** 提取错误文本：兼容 Error、字符串与后端 AppError 对象（`{error_type, message}`） */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; error_type?: unknown };
    const msg = typeof o.message === 'string' ? o.message : '';
    const type = typeof o.error_type === 'string' ? o.error_type : '';
    if (msg || type) return `${type} ${msg}`.trim();
    try {
      return JSON.stringify(e);
    } catch {
      return '';
    }
  }
  return '';
}

/** 粗略识别限流错误（后端错误多以字符串透传） */
export function isRateLimitError(e: unknown): boolean {
  return /\b429\b|rate.?limit|too many requests|限流|请求过于频繁/i.test(errorText(e));
}

/** 不可重试错误（鉴权/参数/未配置模型），避免白白重试 */
export function isFatalError(e: unknown): boolean {
  if (e && typeof e === 'object') {
    const type = (e as { error_type?: unknown }).error_type;
    if (type === 'Configuration' || type === 'Authentication') return true;
  }
  return /\b(400|401|403)\b|unauthorized|forbidden|invalid api key|未配置|未找到可用|not configured/i.test(
    errorText(e),
  );
}

/**
 * 自适应并发池：在途任务数不超过 limiter.current，冷却期暂停派发。
 * 任务自身负责兜底（不抛错）；`signal` 中止后不再派发新任务，等在途任务结束即返回。
 * 任务抛出的限流错误会触发 limiter 降速，其余错误按成功计数（由任务自行降级）。
 */
export function adaptivePool<T>(
  items: T[],
  limiter: AdaptiveLimit,
  fn: (item: T, i: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let inflight = 0;
  return new Promise((resolve) => {
    const tick = () => {
      const stop = signal?.aborted || next >= items.length;
      if (stop) {
        if (inflight === 0) resolve();
        return;
      }
      const wait = limiter.cooldownUntil - Date.now();
      if (wait > 0) {
        if (inflight === 0) setTimeout(tick, wait);
        return;
      }
      while (inflight < limiter.current && next < items.length && !signal?.aborted) {
        const idx = next++;
        inflight++;
        fn(items[idx], idx).then(
          () => {
            inflight--;
            limiter.onSuccess();
            tick();
          },
          (e) => {
            inflight--;
            if (isRateLimitError(e)) limiter.onRateLimit();
            tick();
          },
        );
      }
    };
    tick();
  });
}
