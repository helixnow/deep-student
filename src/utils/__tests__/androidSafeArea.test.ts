import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PlatformModule = typeof import('../platform');

async function loadPlatform(): Promise<PlatformModule> {
  vi.resetModules();
  return import('../platform');
}

describe('Android safe area store (#472)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    delete window.__DEEP_STUDENT_SET_SAFE_AREA__;
    delete window.__DEEP_STUDENT_PENDING_SAFE_AREA__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('style');
  });

  it('publishes the fallback first, then native insets to subscribers', async () => {
    const platform = await loadPlatform();
    expect(platform.getAndroidSafeAreaInsets()).toBeNull();

    platform.initAndroidSafeArea();
    expect(platform.getAndroidSafeAreaInsets()).toEqual({ top: 24, bottom: 15, left: 0, right: 0, native: false });

    const listener = vi.fn();
    const unsubscribe = platform.subscribeAndroidSafeArea(listener);
    window.__DEEP_STUDENT_SET_SAFE_AREA__?.(30.4, 20, 0, 0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(platform.getAndroidSafeAreaInsets()).toEqual({ top: 30, bottom: 20, left: 0, right: 0, native: true });
    expect(document.documentElement.style.getPropertyValue('--android-safe-area-top')).toBe('30px');

    // 相同值不重复通知，快照引用保持稳定（useSyncExternalStore 要求）
    const snapshot = platform.getAndroidSafeAreaInsets();
    window.__DEEP_STUDENT_SET_SAFE_AREA__?.(30, 20, 0, 0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(platform.getAndroidSafeAreaInsets()).toBe(snapshot);

    // 沉浸式隐藏状态栏：top 归 0
    window.__DEEP_STUDENT_SET_SAFE_AREA__?.(0, 0, 0, 0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(platform.getAndroidSafeAreaInsets()?.top).toBe(0);

    unsubscribe();
    window.__DEEP_STUDENT_SET_SAFE_AREA__?.(28, 0, 0, 0);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('consumes insets injected before the frontend initialized', async () => {
    const platform = await loadPlatform();
    window.__DEEP_STUDENT_PENDING_SAFE_AREA__ = [32, 18, 0, 0];
    platform.initAndroidSafeArea();
    expect(platform.getAndroidSafeAreaInsets()).toEqual({ top: 32, bottom: 18, left: 0, right: 0, native: true });
    expect(window.__DEEP_STUDENT_PENDING_SAFE_AREA__).toBeUndefined();
  });

  it('clamps abnormal native values', async () => {
    const platform = await loadPlatform();
    platform.initAndroidSafeArea();
    window.__DEEP_STUDENT_SET_SAFE_AREA__?.(999, -4, Number.NaN, 12);
    expect(platform.getAndroidSafeAreaInsets()).toEqual({ top: 200, bottom: 0, left: 0, right: 12, native: true });
  });
});
