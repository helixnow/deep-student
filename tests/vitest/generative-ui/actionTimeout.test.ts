import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GenerativeActionDefinition } from '@/features/generative-ui/types';
import {
  GENERATIVE_ACTION_TIMEOUT_MS,
  GenerativeActionTimeoutError,
  wrapActionWithTimeout,
} from '@/features/generative-ui/handlers/actionTimeout';

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

describe('wrapActionWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the handler result when it settles within the timeout', async () => {
    vi.useFakeTimers();
    const undo = () => undefined;
    const wrapped = wrapActionWithTimeout(
      makeDef({
        handler: (_payload) =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ undo }), 1_000);
          }),
      }),
    );

    const promise = wrapped.handler({ source: 'test' });
    const settled = promise.then((result) => result);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(settled).resolves.toEqual({ undo });
  });

  it('rejects with GenerativeActionTimeoutError and correct fields', async () => {
    vi.useFakeTimers();
    const wrapped = wrapActionWithTimeout(
      makeDef({
        id: 'foo',
        handler: () => new Promise(() => {}),
      }),
    );

    const promise = wrapped.handler();
    const pending = promise.then(
      () => {
        throw new Error('expected timeout rejection');
      },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(GENERATIVE_ACTION_TIMEOUT_MS);
    const error = await pending;

    expect(error).toBeInstanceOf(GenerativeActionTimeoutError);
    expect(error).toMatchObject({
      name: 'GenerativeActionTimeoutError',
      actionId: 'foo',
      timeoutMs: GENERATIVE_ACTION_TIMEOUT_MS,
      message: 'Action "foo" timed out after 15000ms',
    });
  });

  it('honors custom timeoutMs', async () => {
    vi.useFakeTimers();
    const wrapped = wrapActionWithTimeout(
      makeDef({
        id: 'slow',
        handler: () => new Promise(() => {}),
      }),
      { timeoutMs: 250 },
    );

    const promise = wrapped.handler();
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(249);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).rejects.toMatchObject({
      name: 'GenerativeActionTimeoutError',
      actionId: 'slow',
      timeoutMs: 250,
      message: 'Action "slow" timed out after 250ms',
    });
  });

  it('rethrows the original error when the handler fails before timeout', async () => {
    vi.useFakeTimers();
    const boom = new Error('handler exploded');
    const wrapped = wrapActionWithTimeout(
      makeDef({
        handler: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(boom), 50);
          }),
      }),
    );

    const promise = wrapped.handler();
    const pending = promise.then(
      () => {
        throw new Error('expected handler rejection');
      },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe(boom);
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

    const wrapped = wrapActionWithTimeout(def);

    expect(wrapped.id).toBe('keep-me');
    expect(wrapped.label).toBe('Keep Label');
    expect(wrapped.riskLevel).toBe('high');
    expect(wrapped.undo).toBe(undo);
    expect(wrapped.handler).not.toBe(def.handler);
  });
});
