import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCountdown } from '@/hooks/useCountdown';

function mountCountdown(duration = 1000) {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const onTimeout = vi.fn();
  const hook = renderHook(
    ({ target, onTimeout }) => useCountdown(target, onTimeout),
    { initialProps: { target: Date.now() + duration, onTimeout } },
  );
  const queuedTick = intervals.mock.calls.at(-1)?.[0];
  if (typeof queuedTick !== 'function') throw new Error('Countdown interval was not registered');
  return { ...hook, onTimeout, queuedTick };
}

describe('countdown callback ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T00:00:00Z'));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fires once when the current deadline expires', () => {
    const { result, onTimeout } = mountCountdown();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.remaining).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('rejects a queued tick immediately after reset, before React commits', () => {
    const { result, onTimeout, queuedTick } = mountCountdown();
    act(() => {
      vi.setSystemTime(Date.now() + 2000);
      result.current.reset();
      queuedTick();
    });
    expect(onTimeout).not.toHaveBeenCalled();
    expect(result.current.remaining).toBe(0);
  });

  it('rejects a queued tick immediately after pause, before React commits', () => {
    const { result, onTimeout, queuedTick } = mountCountdown();
    act(() => {
      vi.setSystemTime(Date.now() + 2000);
      result.current.pause();
      queuedTick();
    });
    expect(onTimeout).not.toHaveBeenCalled();
    expect(result.current.isPaused).toBe(true);
  });

  it('does not deliver an old deadline to the replacement callback', () => {
    const { onTimeout, queuedTick, rerender } = mountCountdown();
    const replacement = vi.fn();
    vi.setSystemTime(Date.now() + 2000);
    rerender({ target: Date.now() + 10000, onTimeout: replacement });
    act(() => { queuedTick(); });
    expect(onTimeout).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(10000); });
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it('rejects a queued callback after unmount', () => {
    const { onTimeout, queuedTick, unmount } = mountCountdown();
    unmount();
    vi.setSystemTime(Date.now() + 2000);
    act(() => { queuedTick(); });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('preserves the first pause timestamp when pause is called twice', () => {
    const { result, onTimeout } = mountCountdown(10000);
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { result.current.pause(); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { result.current.pause(); });
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => { result.current.resume(); });
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
