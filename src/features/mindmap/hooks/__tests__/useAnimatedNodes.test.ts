/**
 * useAnimatedNodes — 布局坐标插值
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import {
  ANIMATION_NODE_HARD_LIMIT,
  ANIMATION_NODE_SOFT_LIMIT,
  ANIMATION_SOFT_DURATION_SCALE,
  easeOutCubic,
  lerp,
  positionsEqual,
  resolveAnimationDuration,
  useAnimatedNodes,
  NODE_SPAWN_CLASS,
  NODE_SPAWN_DURATION_MS,
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

  it('新增节点位置直接就位，并短暂标注 CSS 入场类', () => {
    const from = [node('a', 0, 0)];
    const to = [node('a', 0, 0), node('b', 50, 50)];

    const { result, rerender } = renderHook(
      ({ n }) => useAnimatedNodes(n, { duration: 200 }),
      { initialProps: { n: from } },
    );

    rerender({ n: to });
    // 位置不插值（无 spawnOrigin 时原位入场），但追加入场类交给 CSS 动画
    expect(result.current[1].position).toEqual({ x: 50, y: 50 });
    expect(result.current[1].className).toContain(NODE_SPAWN_CLASS);
    // 已有节点不受影响，复用目标引用
    expect(result.current[0]).toBe(to[0]);
    expect(rafCbs.length).toBe(0);
  });

  it('入场类在 NODE_SPAWN_DURATION_MS 后剥离（避免虚拟化重挂载重播）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const from = [node('a', 0, 0)];
      const to = [node('a', 0, 0), node('b', 50, 50)];

      const { result, rerender } = renderHook(
        ({ n }) => useAnimatedNodes(n, { duration: 200 }),
        { initialProps: { n: from } },
      );

      rerender({ n: to });
      expect(result.current[1].className).toContain(NODE_SPAWN_CLASS);

      act(() => {
        vi.advanceTimersByTime(NODE_SPAWN_DURATION_MS + 40);
      });
      // 过期后重发目标数组引用，入场类消失
      expect(result.current).toBe(to);
      expect(result.current[1].className).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('提供 getSpawnOrigin 时新节点从起点插值滑入目标位置', () => {
    const from = [node('a', 0, 0)];
    const to = [node('a', 0, 0), node('b', 100, 40)];

    const { result, rerender } = renderHook(
      ({ n }) =>
        useAnimatedNodes(n, {
          duration: 200,
          getSpawnOrigin: () => ({ x: 0, y: 0 }),
        }),
      { initialProps: { n: from } },
    );

    rerender({ n: to });
    // bootstrap 帧停在生长起点
    expect(result.current[1].position).toEqual({ x: 0, y: 0 });
    expect(result.current[1].className).toContain(NODE_SPAWN_CLASS);
    expect(rafCbs.length).toBeGreaterThan(0);

    act(() => {
      flushRaf(0);
    });
    act(() => {
      flushRaf(200);
    });
    expect(result.current[1].position).toEqual({ x: 100, y: 40 });
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

  it('超过硬阈值的大图直接返回目标（跳过动画）', () => {
    const count = ANIMATION_NODE_HARD_LIMIT + 1;
    const from = Array.from({ length: count }, (_, i) => node(`n${i}`, 0, i));
    const to = Array.from({ length: count }, (_, i) => node(`n${i}`, 100, i));

    const { result, rerender } = renderHook(
      ({ n }) => useAnimatedNodes(n, { duration: 200 }),
      { initialProps: { n: from } },
    );

    rerender({ n: to });
    expect(result.current).toBe(to);
    expect(rafCbs.length).toBe(0);
  });
});

describe('resolveAnimationDuration 大图降级策略', () => {
  it('小图保持原时长', () => {
    expect(resolveAnimationDuration(200, 10)).toBe(200);
    expect(resolveAnimationDuration(200, ANIMATION_NODE_SOFT_LIMIT)).toBe(200);
  });

  it('软阈值以上压缩时长', () => {
    expect(resolveAnimationDuration(200, ANIMATION_NODE_SOFT_LIMIT + 1))
      .toBe(Math.round(200 * ANIMATION_SOFT_DURATION_SCALE));
    expect(resolveAnimationDuration(200, ANIMATION_NODE_HARD_LIMIT))
      .toBe(Math.round(200 * ANIMATION_SOFT_DURATION_SCALE));
  });

  it('硬阈值以上返回 0（跳过动画）', () => {
    expect(resolveAnimationDuration(200, ANIMATION_NODE_HARD_LIMIT + 1)).toBe(0);
  });

  it('阈值常量契约', () => {
    expect(ANIMATION_NODE_SOFT_LIMIT).toBe(300);
    expect(ANIMATION_NODE_HARD_LIMIT).toBe(800);
  });
});
