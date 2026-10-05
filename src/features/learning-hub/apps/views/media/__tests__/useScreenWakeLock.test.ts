import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useScreenWakeLock } from '../useScreenWakeLock';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
});

describe('useScreenWakeLock', () => {
  it('holds a screen lock while active and releases it afterwards', async () => {
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ released: false, release }));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });

    const { rerender, unmount } = renderHook(({ active }) => useScreenWakeLock(active), {
      initialProps: { active: false },
    });
    expect(request).not.toHaveBeenCalled();
    rerender({ active: true });
    await flush();
    expect(request).toHaveBeenCalledWith('screen');
    rerender({ active: false });
    expect(release).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does nothing where the API is missing', () => {
    expect(() => renderHook(() => useScreenWakeLock(true)).unmount()).not.toThrow();
  });
});
