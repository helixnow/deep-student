import { expect, it, vi } from 'vitest';
import { delay } from '../src/delay.ts';

it('resolves after the retry delay and removes its abort listener', async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = delay(500, undefined, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  } finally { vi.useRealTimers(); }
});

it.each([true, false])('rejects cancellation (already aborted: %s) without leaving a timer', async already => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    if (already) controller.abort();
    const pending = delay(500, undefined, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    if (!already) controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
