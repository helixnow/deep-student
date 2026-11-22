/**
 * useNodeHeightObserver — 单一共享 ResizeObserver + WeakMap 路由 + 卸载清理
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { useNodeHeightObserver } from '../../components/mindmap/nodes/useNodeHeightObserver';

interface MockROInstance {
  callback: ResizeObserverCallback;
  observed: Set<Element>;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeElementWithHeight(initialHeight: number): {
  el: HTMLDivElement;
  setHeight: (h: number) => void;
} {
  let height = initialHeight;
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetHeight', {
    configurable: true,
    get: () => height,
  });
  return {
    el,
    setHeight: (h: number) => {
      height = h;
    },
  };
}

describe('useNodeHeightObserver (shared ResizeObserver)', () => {
  let instances: MockROInstance[];

  beforeEach(() => {
    instances = [];
    class MockResizeObserver implements ResizeObserver {
      callback: ResizeObserverCallback;
      observed = new Set<Element>();
      observe = vi.fn((target: Element) => {
        this.observed.add(target);
      });
      unobserve = vi.fn((target: Element) => {
        this.observed.delete(target);
      });
      disconnect = vi.fn(() => {
        this.observed.clear();
      });

      constructor(cb: ResizeObserverCallback) {
        this.callback = cb;
        instances.push(this);
      }
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shares a single ResizeObserver across multiple nodes and routes updates via WeakMap', () => {
    const a = makeElementWithHeight(40);
    const b = makeElementWithHeight(56);
    const refA: RefObject<HTMLElement> = { current: a.el };
    const refB: RefObject<HTMLElement> = { current: b.el };
    const setHeightA = vi.fn();
    const setHeightB = vi.fn();

    const hookA = renderHook(() => useNodeHeightObserver(refA, 'node_a', setHeightA, true));
    const hookB = renderHook(() => useNodeHeightObserver(refB, 'node_b', setHeightB, true));

    // 多个节点严格复用同一个 ResizeObserver 实例，且挂载期不触发同步 offsetHeight 回流
    expect(instances).toHaveLength(1);
    const ro = instances[0];
    expect(ro.observed.has(a.el)).toBe(true);
    expect(ro.observed.has(b.el)).toBe(true);
    expect(setHeightA).not.toHaveBeenCalled();
    expect(setHeightB).not.toHaveBeenCalled();

    // 首次 ResizeObserver 批量回调（borderBoxSize 优先）上报基准高度
    ro.callback(
      [
        { target: a.el, borderBoxSize: [{ blockSize: 40, inlineSize: 120 }] } as unknown as ResizeObserverEntry,
        { target: b.el, borderBoxSize: [{ blockSize: 56, inlineSize: 140 }] } as unknown as ResizeObserverEntry,
      ],
      ro as unknown as ResizeObserver,
    );
    expect(setHeightA).toHaveBeenCalledTimes(1);
    expect(setHeightA).toHaveBeenLastCalledWith('node_a', 40);
    expect(setHeightB).toHaveBeenCalledTimes(1);
    expect(setHeightB).toHaveBeenLastCalledWith('node_b', 56);

    // 同值回流被去重拦截
    ro.callback(
      [{ target: a.el, borderBoxSize: [{ blockSize: 40, inlineSize: 120 }] } as unknown as ResizeObserverEntry],
      ro as unknown as ResizeObserver,
    );
    expect(setHeightA).toHaveBeenCalledTimes(1);

    // 高度变化时精准路由到各自节点回调（无 borderBoxSize 时回退 offsetHeight）
    a.setHeight(72);
    b.setHeight(96);
    ro.callback(
      [
        { target: a.el } as unknown as ResizeObserverEntry,
        { target: b.el } as unknown as ResizeObserverEntry,
      ],
      ro as unknown as ResizeObserver,
    );
    expect(setHeightA).toHaveBeenCalledTimes(2);
    expect(setHeightA).toHaveBeenLastCalledWith('node_a', 72);
    expect(setHeightB).toHaveBeenCalledTimes(2);
    expect(setHeightB).toHaveBeenLastCalledWith('node_b', 96);

    // 卸载节点 A：仅 unobserve(a.el)，共享观察器仍为 B 保持活跃
    hookA.unmount();
    expect(ro.unobserve).toHaveBeenCalledWith(a.el);
    expect(ro.disconnect).not.toHaveBeenCalled();

    // A 已卸载，即便残留 entry 到达也不再触发回调
    a.setHeight(120);
    ro.callback(
      [{ target: a.el } as unknown as ResizeObserverEntry],
      ro as unknown as ResizeObserver,
    );
    expect(setHeightA).toHaveBeenCalledTimes(2);

    // 卸载最后一个节点 B：unobserve + disconnect 释放共享观察器
    hookB.unmount();
    expect(ro.unobserve).toHaveBeenCalledWith(b.el);
    expect(ro.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to offsetHeight when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const a = makeElementWithHeight(48);
    const refA: RefObject<HTMLElement> = { current: a.el };
    const setHeight = vi.fn();

    renderHook(() => useNodeHeightObserver(refA, 'node_fallback', setHeight, true));

    expect(setHeight).toHaveBeenCalledTimes(1);
    expect(setHeight).toHaveBeenLastCalledWith('node_fallback', 48);
  });

  it('skips observation and reporting when disabled', () => {
    const a = makeElementWithHeight(44);
    const refA: RefObject<HTMLElement> = { current: a.el };
    const setHeight = vi.fn();

    renderHook(() => useNodeHeightObserver(refA, 'node_disabled', setHeight, false));

    expect(instances).toHaveLength(0);
    expect(setHeight).not.toHaveBeenCalled();
  });
});
