/**
 * useViewportFollowContainerResize — 窗口 floating → 平铺后导图画布不再空白。
 *
 * 复现：26 节点导图在大窗口 fit 为 translate(409,370) scale(0.245)，窗口平铺到
 * 434×320 后视口不变，整图落在可视区外（onlyRenderVisibleElements 剔除全部节点）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  RESIZE_REFIT_DEBOUNCE_MS,
  anchorViewportToResize,
  useViewportFollowContainerResize,
  viewportsMatch,
  type FollowViewport,
} from '../useViewportFollowContainerResize';

describe('anchorViewportToResize', () => {
  it('keeps the previously centred content centred after the container shrinks', () => {
    const prev = { width: 818, height: 740 };
    const next = { width: 434, height: 320 };
    const viewport = { x: 409, y: 370, zoom: 0.245 };
    const anchored = anchorViewportToResize(viewport, prev, next);
    // 原中心（flow 原点在屏幕 409,370 = 旧容器中心）应落在新容器中心
    expect(anchored).toEqual({ x: 217, y: 160, zoom: 0.245 });
  });
});

describe('viewportsMatch', () => {
  it('tolerates sub-pixel noise but not real pans / zooms', () => {
    const a = { x: 10, y: 20, zoom: 0.5 };
    expect(viewportsMatch(a, { x: 10.2, y: 19.8, zoom: 0.5 })).toBe(true);
    expect(viewportsMatch(a, { x: 30, y: 20, zoom: 0.5 })).toBe(false);
    expect(viewportsMatch(a, { x: 10, y: 20, zoom: 0.6 })).toBe(false);
    expect(viewportsMatch(a, null)).toBe(false);
  });
});

describe('useViewportFollowContainerResize', () => {
  let roCallback: (() => void) | null = null;
  const OriginalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    vi.useFakeTimers();
    roCallback = null;
    globalThis.ResizeObserver = class {
      constructor(cb: () => void) { roCallback = cb; }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.ResizeObserver = OriginalResizeObserver;
  });

  function setup(initialViewport: FollowViewport, autoFit: FollowViewport | null) {
    const element = document.createElement('div');
    let size = { width: 818, height: 740 };
    Object.defineProperty(element, 'offsetWidth', { get: () => size.width });
    Object.defineProperty(element, 'offsetHeight', { get: () => size.height });
    let viewport = initialViewport;
    const setViewport = vi.fn((next: FollowViewport) => { viewport = next; });
    const refit = vi.fn(() => true);
    const autoFitViewportRef = { current: autoFit };
    renderHook(() => useViewportFollowContainerResize({
      containerRef: { current: element },
      autoFitViewportRef,
      enabled: true,
      adapter: { getViewport: () => viewport, setViewport, refit },
    }));
    const resize = (width: number, height: number) => {
      size = { width, height };
      roCallback?.();
    };
    return {
      resize,
      setViewport,
      refit,
      autoFitViewportRef,
      getViewport: () => viewport,
      pan: (next: FollowViewport) => { viewport = next; },
    };
  }

  it('re-fits after the window is tiled when the viewport is still the auto-fit one', () => {
    const fitted = { x: 409, y: 370, zoom: 0.245 };
    const h = setup(fitted, fitted);

    h.resize(434, 320);
    // 立即中心锚定，内容不会被推出可视区
    expect(h.setViewport).toHaveBeenCalledWith({ x: 217, y: 160, zoom: 0.245 });
    expect(h.refit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RESIZE_REFIT_DEBOUNCE_MS);
    expect(h.refit).toHaveBeenCalledTimes(1);
  });

  it('debounces refit across a burst of resize events (drag-resize / tiling transition)', () => {
    const fitted = { x: 409, y: 370, zoom: 0.245 };
    const h = setup(fitted, fitted);

    h.resize(700, 600);
    vi.advanceTimersByTime(50);
    h.resize(560, 450);
    vi.advanceTimersByTime(50);
    h.resize(434, 320);
    expect(h.getViewport()).toEqual({ x: 217, y: 160, zoom: 0.245 });
    vi.advanceTimersByTime(RESIZE_REFIT_DEBOUNCE_MS);
    expect(h.refit).toHaveBeenCalledTimes(1);
  });

  it('only centre-anchors (no refit, zoom kept) when the user has panned/zoomed', () => {
    const h = setup({ x: 100, y: 50, zoom: 1.2 }, { x: 409, y: 370, zoom: 0.245 });

    h.resize(434, 320);
    expect(h.getViewport()).toEqual({ x: 100 - 192, y: 50 - 210, zoom: 1.2 });
    vi.advanceTimersByTime(RESIZE_REFIT_DEBOUNCE_MS * 2);
    expect(h.refit).not.toHaveBeenCalled();
    expect(h.autoFitViewportRef.current).toBeNull();
  });

  it('skips the pending refit if the user moves the canvas during the debounce', () => {
    const fitted = { x: 409, y: 370, zoom: 0.245 };
    const h = setup(fitted, fitted);

    h.resize(434, 320);
    h.pan({ x: 0, y: 0, zoom: 0.5 });
    vi.advanceTimersByTime(RESIZE_REFIT_DEBOUNCE_MS);
    expect(h.refit).not.toHaveBeenCalled();
  });

  it('ignores hidden / zero-size phases and anchors against the last visible size', () => {
    const fitted = { x: 409, y: 370, zoom: 0.245 };
    const h = setup(fitted, fitted);

    h.resize(0, 0); // 最小化 / display:none
    expect(h.setViewport).not.toHaveBeenCalled();
    h.resize(434, 320);
    expect(h.setViewport).toHaveBeenCalledWith({ x: 217, y: 160, zoom: 0.245 });
  });
});
