/**
 * Per-engine OCR 熔断器（移植 `dstu-llm/src/ocr_circuit_breaker.rs`）。
 *
 * - Closed：请求正常通过，滑动窗口统计失败；
 * - Open：窗口内失败率达到阈值后熔断，所有请求立即拒绝；
 * - HalfOpen：冷却期后只放行一次试探请求（探针）。
 *
 * Rust 用 `Instant` 计时；这里通过注入 `now()`（默认 `performance.now`）保持相同语义，
 * 单元测试可以推进虚拟时钟而不真的 sleep。
 */
import { logInfo, logWarn } from './logging.ts';

export type CircuitState = 'Closed' | 'Open' | 'HalfOpen';

export const FAILURE_THRESHOLD = 3;
export const COOLDOWN_DURATION_MS = 60_000;
/** 滑动窗口：仅统计此时间范围内的失败。 */
export const SLIDING_WINDOW_MS = 300_000;
/**
 * HalfOpen 探针超时。调用方若在 allowRequest 与 recordSuccess/recordFailure
 * 之间提前返回（配置错误、任务取消等），探针会永久占位；超过此时长未上报
 * 结果即视为探针丢失，允许新探针。
 */
export const PROBE_TIMEOUT_MS = 120_000;

export interface OcrCircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
  windowMs?: number;
  probeTimeoutMs?: number;
  now?: () => number;
}

export class OcrCircuitBreaker {
  private state: CircuitState = 'Closed';
  private failureTimestamps: number[] = [];
  private lastFailureTime: number | null = null;
  /** HalfOpen 状态下是否已有试探请求正在进行。 */
  private probeInFlight = false;
  /** 当前探针的启动时间（用于探针超时回收）。 */
  private probeStartedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly windowMs: number;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: OcrCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.threshold ?? FAILURE_THRESHOLD);
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_DURATION_MS;
    this.windowMs = options.windowMs ?? SLIDING_WINDOW_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
  }

  /** 兼容 Rust 的 `with_config(threshold, cooldown, window)`。 */
  static withConfig(
    threshold: number,
    cooldownMs: number,
    windowMs: number,
    now?: () => number,
  ): OcrCircuitBreaker {
    return new OcrCircuitBreaker({ threshold, cooldownMs, windowMs, now });
  }

  allowRequest(): boolean {
    switch (this.state) {
      case 'Closed':
        return true;
      case 'Open':
        if (this.lastFailureTime !== null) {
          if (this.now() - this.lastFailureTime >= this.cooldownMs) {
            logInfo('[CircuitBreaker] 冷却期已过，进入 HalfOpen 试探状态');
            this.state = 'HalfOpen';
            this.probeInFlight = true;
            this.probeStartedAt = this.now();
            return true;
          }
          return false;
        }
        this.state = 'Closed';
        this.failureTimestamps = [];
        return true;
      case 'HalfOpen': {
        const probeLost = this.probeStartedAt === null
          || this.now() - this.probeStartedAt >= this.probeTimeoutMs;
        if (this.probeInFlight && !probeLost) return false;
        if (this.probeInFlight) logWarn('[CircuitBreaker] HalfOpen 探针超时未上报结果，允许新探针');
        this.probeInFlight = true;
        this.probeStartedAt = this.now();
        return true;
      }
    }
  }

  recordSuccess(): void {
    if (this.state !== 'Closed') logInfo(`[CircuitBreaker] 请求成功，从 ${this.state} 恢复到 Closed`);
    this.state = 'Closed';
    this.failureTimestamps = [];
    this.lastFailureTime = null;
    this.probeInFlight = false;
    this.probeStartedAt = null;
  }

  recordFailure(): void {
    const now = this.now();
    this.lastFailureTime = now;

    switch (this.state) {
      case 'Closed': {
        this.failureTimestamps.push(now);
        const cutoff = now - this.windowMs;
        this.failureTimestamps = this.failureTimestamps.filter((timestamp) => timestamp >= cutoff);
        if (this.failureTimestamps.length >= this.failureThreshold) {
          logWarn(`[CircuitBreaker] 窗口内 ${this.failureTimestamps.length} 次失败（阈值 ${this.failureThreshold}），触发熔断 → Open`);
          this.state = 'Open';
        }
        break;
      }
      case 'HalfOpen':
        logWarn('[CircuitBreaker] HalfOpen 试探失败，回到 Open 状态');
        this.state = 'Open';
        this.probeInFlight = false;
        this.probeStartedAt = null;
        break;
      case 'Open':
        break;
    }
  }

  /**
   * 释放 HalfOpen 探针但不计成功/失败。用于 allowRequest 之后、真正发起 OCR
   * 调用之前因配置错误/参数问题提前返回的路径。
   */
  cancelProbe(): void {
    if (this.state === 'HalfOpen') {
      this.probeInFlight = false;
      this.probeStartedAt = null;
    }
  }

  currentState(): CircuitState {
    return this.state;
  }
}

/** Per-engine 熔断器注册表。 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, OcrCircuitBreaker>();

  getOrCreate(engineId: string): OcrCircuitBreaker {
    const existing = this.breakers.get(engineId);
    if (existing !== undefined) return existing;
    const created = new OcrCircuitBreaker();
    this.breakers.set(engineId, created);
    return created;
  }

  getDefault(): OcrCircuitBreaker {
    return this.getOrCreate('default');
  }
}

/** 全局 per-engine 熔断器注册表（Rust `OCR_CIRCUIT_BREAKERS`）。 */
export const OCR_CIRCUIT_BREAKERS = new CircuitBreakerRegistry();

/** 向后兼容的全局默认熔断器（Rust `OCR_CIRCUIT_BREAKER`）。 */
export const OCR_CIRCUIT_BREAKER = OCR_CIRCUIT_BREAKERS.getDefault();
