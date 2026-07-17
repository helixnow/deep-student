/**
 * useAnimatedNodes — 布局坐标插值
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import {
  easeOutCubic,
  lerp,
  positionsEqual,
  useAnimatedNodes,
} from '../useAnimatedNodes';

function node(id: string, x: number, y: number, extra?: Partial<Node>): Node {
  return { id, position: { x, y }, data: {}, ...extra };
}

describe('easeOutCubic / lerp / positionsEqual', () => {
  it('easeOutCubic 边界与单调', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it('lerp 线性插值', () => {
    expect(lerp(0, 100, 0)).toBe(0);
    expect(lerp(0, 100, 1)).toBe(100);
    expect(lerp(0, 100, 0.5)).toBe(50);
  });

  it('positionsEqual 容差', () => {
    expect(positionsEqual({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(positionsEqual({ x: 1, y: 2 }, { x: 1.005, y: 2 })).toBe(true);
    expect(positionsEqual({ x: 1, y: 2 }, { x: 2, y: 2 })).toBe(false);
  });
});

describe('useAnimatedNodes', () => {
  let rafCbs: FrameRequestCallback[];
  let rafId: number;

  beforeEach(() => {
    rafCbs = [];
    rafId = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      rafId += 1;
      return rafId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      void id;
      rafCbs = [];
    });
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as MediaQueryList;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function flushRaf(now: number) {
    const cbs = [...rafCbs];
    rafCbs = [];
    for (const cb of cbs) {
      cb(now);
    }
  }

  it('坐标不变时返回目标数组引用（零开销）', () => {
    const nodes = [node('a', 0, 0), node('b', 10, 10)];
    const { result, rerender } = renderHook(
      ({ n }) => useAnimatedNodes(n, { duration: 200 }),
      { initialProps: { n: nodes } },
    );

    expect(result.current).toBe(nodes);

    const samePos = [
      node('a', 0, 0, { selected: true }),
      node('b', 10, 10),
    ];
    rerender({ n: samePos });
    expect(result.current).toBe(samePos);
  });

  it('prefers-reduced-motion 时直接返回目标值', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      return {
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as MediaQueryList;
    });

    const from = [node('a', 0, 0)];
    const to = [node('a', 100, 50)];
    const { result, rerender } = renderHook(
      ({ n }) => useAnimatedNodes(n, { duration: 200 }),
      { initialProps: { n: from } },
    );

    rerender({ n: to });
    expect(result.current).toBe(to);
    expect(result.current[0].position).toEqual({ x: 100, y: 50 });
    expect(rafCbs.length).toBe(0);
  });

  it('坐标变化时插值并最终收敛到目标', () => {
    const from = [node('a', 0, 0), node('b', 0, 0)];
    const to = [node('a', 100, 0), node('b', 0, 0)];

    const { result, rerender } = renderHook(
      ({ n }) => useAnimatedNodes(n, { duration: 200 }),
      { initialProps: { n: from } },
    );

    rerender({ n: to });

    // layoutEffect 已 bootstrap + 排队 rAF
    expect(rafCbs.length).toBeGreaterThan(0);
    expect(result.current[0].position.x).toBe(0);
    // 静止节点复用目标引用
    expect(result.current[1]).toBe(to[1]);

    act(() => {
      flushRaf(0);
    });
    // t=0 → still at from
    expect(result.current[0].position.x).toBe(0);

    act(() => {
      flushRaf(100);
    });
    const midX = result.current[0].position.x;
    expect(midX).toBeGreaterThan(0);
    expect(midX).toBeLessThan(100);
    // easeOutCubic(0.5) ≈ 0.875
    expect(midX).toBeCloseTo(lerp(0, 100, easeOutCubic(0.5)), 5);

    act(() => {
      flushRaf(200);
    });
    expect(result.current[0].position).toEqual({ x: 100, y: 0 });
    expect(result.current).toBe(to);
  });

  it('新增节点不动画，直接就位', () => {
    const from = [node('a', 0, 0)];
    const to = [node('a', 0, 0), node('b', 50, 50)];

    const { result, rerender } = renderHook(
      ({ n }) => useAnimatedNodes(n, { duration: 200 }),
      { initialProps: { n: from } },
    );

    rerender({ n: to });
    expect(result.current).toBe(to);
    expect(result.current[1].position).toEqual({ x: 50, y: 50 });
    expect(rafCbs.length).toBe(0);
  });

  it('enabled=false 时直达目标并取消动画', () => {
    const from = [node('a', 0, 0)];
    const to = [node('a', 100, 0)];

    const { result, rerender } = renderHook(
      ({ n, enabled }) => useAnimatedNodes(n, { duration: 200, enabled }),
      { initialProps: { n: from, enabled: true } },
    );

    rerender({ n: to, enabled: true });
    expect(rafCbs.length).toBeGreaterThan(0);

    rerender({ n: to, enabled: false });
    expect(result.current).toBe(to);
  });

  it('卸载时 cancelAnimationFrame', () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);

    const from = [node('a', 0, 0)];
    const to = [node('a', 100, 0)];
    const { rerender, unmount } = renderHook(
      ({ n }) => useAnimatedNodes(n, { duration: 200 }),
      { initialProps: { n: from } },
    );

    rerender({ n: to });
    unmount();
    expect(cancel).toHaveBeenCalled();
  });
});
