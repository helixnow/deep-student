import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GenerativeActionDefinition } from '@/features/generative-ui/types';
import { createActionRateLimiter } from '@/features/generative-ui';
import {
  GENERATIVE_ACTION_COOLDOWN_MS,
  GenerativeActionRateLimitError,
  wrapActionWithRateLimit,
} from '@/features/generative-ui/handlers/actionRateLimit';

function makeDef(
  overrides: Partial<GenerativeActionDefinition> & Pick<GenerativeActionDefinition, 'handler'>,
): GenerativeActionDefinition {
  return {
    id: 'demo-action',
    label: 'Demo',
    riskLevel: 'medium',
    ...overrides,
  };
}

function expectRateLimited(error: unknown, actionId: string, cooldownMs: number) {
  expect(error).toBeInstanceOf(GenerativeActionRateLimitError);
  expect(error).toMatchObject({
    name: 'GenerativeActionRateLimitError',
    actionId,
    cooldownMs,
  });
}

describe('wrapActionWithRateLimit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects an immediate second call after a successful invoke', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const wrapped = wrapActionWithRateLimit(makeDef({ handler }));

    await expect(wrapped.handler({ source: 'test' })).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);

    const second = wrapped.handler({ source: 'test' });
    await expect(second).rejects.toBeInstanceOf(GenerativeActionRateLimitError);
    const error = await second.then(
      () => {
        throw new Error('expected rate-limit rejection');
      },
      (err: unknown) => err,
    );
    expectRateLimited(error, 'demo-action', GENERATIVE_ACTION_COOLDOWN_MS);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('allows a third call after the cooldown elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const handler = vi.fn(() => undefined);
    const wrapped = wrapActionWithRateLimit(makeDef({ handler }));

    await wrapped.handler();
    await expect(wrapped.handler()).rejects.toBeInstanceOf(GenerativeActionRateLimitError);

    vi.setSystemTime(1_000 + GENERATIVE_ACTION_COOLDOWN_MS);
    await expect(wrapped.handler()).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('shares cooldown state across definitions wrapped by one limiter', async () => {
    let now = 0;
    const limiter = createActionRateLimiter({ cooldownMs: 100, clock: () => now });
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const first = limiter.wrap(makeDef({ id: 'first', handler: firstHandler }));
    const second = limiter.wrap(makeDef({ id: 'second', handler: secondHandler }));

    await first.handler();
    await expect(second.handler()).rejects.toMatchObject({
      actionId: 'second',
      cooldownMs: 100,
    });

    now = 100;
    await second.handler();
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it('rejects an overlapping in-flight second call', async () => {
    let release!: (value?: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(() => gate);

    const wrapped = wrapActionWithRateLimit(makeDef({ id: 'slow', handler }));

    const first = wrapped.handler();
    const second = wrapped.handler();

    await expect(second).rejects.toMatchObject({
      name: 'GenerativeActionRateLimitError',
      actionId: 'slow',
      cooldownMs: GENERATIVE_ACTION_COOLDOWN_MS,
    });
    expect(handler).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBeUndefined();
  });

  it('honors custom cooldownMs', async () => {
    let now = 0;
    const clock = () => now;
    const handler = vi.fn(() => undefined);
    const wrapped = wrapActionWithRateLimit(makeDef({ id: 'custom', handler }), {
      cooldownMs: 100,
      clock,
    });

    await wrapped.handler();

    now = 99;
    const early = wrapped.handler();
    await expect(early).rejects.toMatchObject({
      name: 'GenerativeActionRateLimitError',
      actionId: 'custom',
      cooldownMs: 100,
      message: 'Action "custom" is rate-limited (cooldown 100ms)',
    });
    expect(handler).toHaveBeenCalledTimes(1);

    now = 100;
    await expect(wrapped.handler()).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('still applies cooldown when the inner handler throws', async () => {
    let now = 5_000;
    const boom = new Error('handler exploded');
    const handler = vi.fn(() => {
      throw boom;
    });
    const wrapped = wrapActionWithRateLimit(makeDef({ handler }), {
      clock: () => now,
    });

    await expect(wrapped.handler()).rejects.toBe(boom);

    now = 5_000 + GENERATIVE_ACTION_COOLDOWN_MS - 1;
    await expect(wrapped.handler()).rejects.toBeInstanceOf(GenerativeActionRateLimitError);
    expect(handler).toHaveBeenCalledTimes(1);

    now = 5_000 + GENERATIVE_ACTION_COOLDOWN_MS;
    await expect(wrapped.handler()).rejects.toBe(boom);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('preserves id, label, and riskLevel', () => {
    const undo = () => undefined;
    const def = makeDef({
      id: 'keep-me',
      label: 'Keep Label',
      riskLevel: 'high',
      undo,
      handler: () => undefined,
    });

    const wrapped = wrapActionWithRateLimit(def);

    expect(wrapped.id).toBe('keep-me');
    expect(wrapped.label).toBe('Keep Label');
    expect(wrapped.riskLevel).toBe('high');
    expect(wrapped.undo).toBe(undo);
    expect(wrapped.handler).not.toBe(def.handler);
  });
});
