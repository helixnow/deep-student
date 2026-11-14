import { describe, expect, it } from 'vitest';
import {
  CircuitBreakerRegistry, FAILURE_THRESHOLD, OcrCircuitBreaker,
} from '../src/ocr_circuit_breaker.ts';

/** 推进虚拟时钟，避免 Rust 用例里的 thread::sleep。 */
function clock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number): void { current += ms; },
  };
}

describe('ocr_circuit_breaker.rs', () => {
  it('test_closed_allows_requests', () => {
    const breaker = new OcrCircuitBreaker();
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.currentState()).toBe('Closed');
  });

  it('test_opens_after_threshold_failures', () => {
    const breaker = new OcrCircuitBreaker();
    for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt += 1) breaker.recordFailure();
    expect(breaker.currentState()).toBe('Open');
    expect(breaker.allowRequest()).toBe(false);
  });

  it('test_success_resets_to_closed', () => {
    const breaker = new OcrCircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.currentState()).toBe('Closed');
    expect(breaker.allowRequest()).toBe(true);
  });

  it('test_partial_failures_dont_open', () => {
    const breaker = new OcrCircuitBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.currentState()).toBe('Closed');
    expect(breaker.allowRequest()).toBe(true);
  });

  it('test_half_open_allows_only_one_probe', () => {
    const time = clock();
    const breaker = new OcrCircuitBreaker({
      threshold: 1, cooldownMs: 1, windowMs: 60_000, now: time.now,
    });
    breaker.recordFailure();
    expect(breaker.currentState()).toBe('Open');

    time.advance(5);

    // 第一个请求：进入 HalfOpen，允许通过
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.currentState()).toBe('HalfOpen');

    // 第二个请求：探针占位，拒绝
    expect(breaker.allowRequest()).toBe(false);
  });

  it('test_half_open_success_resets', () => {
    const time = clock();
    const breaker = new OcrCircuitBreaker({
      threshold: 1, cooldownMs: 1, windowMs: 60_000, now: time.now,
    });
    breaker.recordFailure();
    time.advance(5);
    expect(breaker.allowRequest()).toBe(true); // 进入 HalfOpen
    breaker.recordSuccess();
    expect(breaker.currentState()).toBe('Closed');
    expect(breaker.allowRequest()).toBe(true);
  });

  it('test_half_open_failure_reopens', () => {
    const time = clock();
    const breaker = new OcrCircuitBreaker({
      threshold: 1, cooldownMs: 1, windowMs: 60_000, now: time.now,
    });
    breaker.recordFailure();
    time.advance(5);
    expect(breaker.allowRequest()).toBe(true); // 进入 HalfOpen
    breaker.recordFailure();
    expect(breaker.currentState()).toBe('Open');
  });

  it('test_half_open_probe_timeout_recovers_leak', () => {
    // 回归 C3：探针在 allowRequest 后从未上报结果（提前返回/取消），
    // 超时后必须允许新探针，而不是永久拒绝。
    const time = clock();
    const breaker = new OcrCircuitBreaker({
      threshold: 1, cooldownMs: 1, windowMs: 60_000, probeTimeoutMs: 30, now: time.now,
    });
    breaker.recordFailure();
    time.advance(5);

    // 探针 1 获准但“丢失”（不上报结果）
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.currentState()).toBe('HalfOpen');
    // 探针未超时前：拒绝
    expect(breaker.allowRequest()).toBe(false);

    // 超过探针超时后：允许新探针
    time.advance(40);
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.currentState()).toBe('HalfOpen');

    // 新探针成功 → 恢复 Closed
    breaker.recordSuccess();
    expect(breaker.currentState()).toBe('Closed');
  });

  it('test_cancel_probe_releases_without_penalty', () => {
    // X1：HalfOpen 下 allowRequest 后因配置错误提前返回，cancelProbe 应释放探针
    // 且不改变状态/失败计数；随后应能立即获准新探针（而非等超时）。
    const time = clock();
    const breaker = new OcrCircuitBreaker({
      threshold: 1, cooldownMs: 1, windowMs: 60_000, now: time.now,
    });
    breaker.recordFailure();
    time.advance(5);
    expect(breaker.allowRequest()).toBe(true); // 进入 HalfOpen，占用探针
    expect(breaker.currentState()).toBe('HalfOpen');
    expect(breaker.allowRequest()).toBe(false); // 探针占位 → 拒绝

    breaker.cancelProbe(); // 配置错误提前返回，释放探针（不计失败）
    expect(breaker.currentState()).toBe('HalfOpen'); // 状态不变
    expect(breaker.allowRequest()).toBe(true); // 立即允许新探针
  });

  it('test_per_engine_registry', () => {
    const registry = new CircuitBreakerRegistry();
    const deepseek = registry.getOrCreate('deepseek');
    const paddle = registry.getOrCreate('paddle');

    // DeepSeek 熔断不影响 Paddle
    for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt += 1) deepseek.recordFailure();
    expect(deepseek.currentState()).toBe('Open');
    expect(paddle.currentState()).toBe('Closed');
    expect(paddle.allowRequest()).toBe(true);
    expect(deepseek.allowRequest()).toBe(false);
  });

  it('test_sliding_window_expires_old_failures', () => {
    const time = clock();
    const breaker = new OcrCircuitBreaker({
      threshold: 3, cooldownMs: 60_000, windowMs: 50, now: time.now,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    time.advance(60);
    // 旧的 2 次失败已过期，窗口内只有这 1 次
    breaker.recordFailure();
    expect(breaker.currentState()).toBe('Closed');
  });
});
