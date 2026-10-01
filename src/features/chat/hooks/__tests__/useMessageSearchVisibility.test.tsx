import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageSearchVisibility } from '../useMessageSearchVisibility';

const observers: MockObserver[] = [];
class MockObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) { observers.push(this); }
  emit(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', MockObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe('message search highlight visibility', () => {
  it('only enables highlights for rows intersecting their actual scroll viewport', () => {
    const viewport = document.createElement('div');
    viewport.setAttribute('data-overlayscrollbars-viewport', '');
    const row = document.createElement('div');
    viewport.append(row);
    const ref = { current: row };
    const { result, rerender, unmount } = renderHook(({ enabled }) => useMessageSearchVisibility(ref, enabled), {
      initialProps: { enabled: false },
    });
    expect(observers).toHaveLength(0);
    expect(result.current).toBe(false);
    rerender({ enabled: true });
    expect(result.current).toBe(false);
    expect(observers[0].options?.root).toBe(viewport);
    act(() => observers[0].emit(row, true));
    expect(result.current).toBe(true);
    act(() => observers[0].emit(row, false));
    expect(result.current).toBe(false);
    unmount();
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects when search closes and ignores stale observer delivery', () => {
    const row = document.createElement('div');
    const ref = { current: row };
    const { result, rerender } = renderHook(({ enabled }) => useMessageSearchVisibility(ref, enabled), {
      initialProps: { enabled: true },
    });
    act(() => observers[0].emit(row, true));
    rerender({ enabled: false });
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    act(() => observers[0].emit(row, true));
    expect(result.current).toBe(false);
  });

  it('preserves highlights when the host has no intersection observer', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const ref = { current: document.createElement('div') };
    const { result } = renderHook(() => useMessageSearchVisibility(ref, true));
    expect(result.current).toBe(true);
  });
});
