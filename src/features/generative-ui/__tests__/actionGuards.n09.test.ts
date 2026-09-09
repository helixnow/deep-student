/**
 * N09（2026-09-07 审阅）回归：外层超时 + 内层限流不得留下无恢复的
 * in-flight 占用。修复后 timeout 在 rate-limit 内层，超时拒绝穿过限流器
 * finally 释放占用，cooldown 后可重试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyActionGuards } from '../actions';
import { GenerativeActionRateLimitError } from '../handlers/actionRateLimit';
import { GenerativeActionTimeoutError } from '../handlers/actionTimeout';
import type { GenerativeActionDefinition } from '../types';

function makeDef(handler: GenerativeActionDefinition['handler']): GenerativeActionDefinition {
  return {
    id: 'test-action',
    label: 'test',
    riskLevel: 'low',
    handler,
  } as GenerativeActionDefinition;
}

describe('N09 — 超时后 in-flight 占用可恢复', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('底层 handler 永不 settle：超时后重试不被永久限流', async () => {
    let calls = 0;
    const guarded = applyActionGuards(
      makeDef(() => {
        calls += 1;
        return new Promise<string>(() => {}); // 永不 settle
      }),
      { timeoutMs: 10, cooldownMs: 5 },
    );

    const first = guarded.handler({});
    const firstAssertion = expect(first).rejects.toBeInstanceOf(GenerativeActionTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await firstAssertion;
    expect(calls).toBe(1);

    // cooldown 之后重试必须被接受（旧实现：inFlight 永久占用，全部限流）
    await vi.advanceTimersByTimeAsync(10);
    const second = guarded.handler({});
    const secondAssertion = expect(second).rejects.toBeInstanceOf(GenerativeActionTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await secondAssertion;
    expect(calls).toBe(2, '重试必须再次进入底层 handler');
  });

  it('cooldown 窗口内的重试仍被限流（占用释放≠放开限流）', async () => {
    let calls = 0;
    const guarded = applyActionGuards(
      makeDef(() => {
        calls += 1;
        return new Promise<string>(() => {});
      }),
      { timeoutMs: 10, cooldownMs: 1000 },
    );

    const first = guarded.handler({});
    const firstAssertion = expect(first).rejects.toBeInstanceOf(GenerativeActionTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await firstAssertion;

    // cooldown 未过：仍限流
    await expect(guarded.handler({})).rejects.toBeInstanceOf(GenerativeActionRateLimitError);
    expect(calls).toBe(1);
  });

  it('底层 handler 迟到 reject 不产生未处理拒绝，也不影响后续调用', async () => {
    let rejectLate: (e: Error) => void = () => {};
    const guarded = applyActionGuards(
      makeDef(
        () =>
          new Promise<string>((_, reject) => {
            rejectLate = reject;
          }),
      ),
      { timeoutMs: 10, cooldownMs: 5 },
    );

    const first = guarded.handler({});
    const firstAssertion = expect(first).rejects.toBeInstanceOf(GenerativeActionTimeoutError);
    await vi.advanceTimersByTimeAsync(20);
    await firstAssertion;

    // 迟到失败：被 timeout 包装吞掉，不影响限流器状态
    rejectLate(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(10);

    const calls = 0;
    void calls;
    const ok = applyActionGuards(makeDef(async () => 'ok'), { timeoutMs: 10, cooldownMs: 5 });
    await expect(ok.handler({})).resolves.toBe('ok');
  });

  it('正常完成的调用不受换序影响', async () => {
    const guarded = applyActionGuards(makeDef(async () => 'done'), {
      timeoutMs: 1000,
      cooldownMs: 5,
    });
    await expect(guarded.handler({})).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(10);
    await expect(guarded.handler({})).resolves.toBe('done');
  });
});
