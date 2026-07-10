/**
 * P2 / O4 — useTilingDivider 中缝拖拽测试
 * 覆盖：软区阻尼、释放 settle、双击复位 50/50、拖动态 class、
 * rAF 合帧、Esc / pointercancel 回退
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  useTilingDivider,
  TILING_DIVIDER_ACTIVE_CLASS,
  type UseTilingDividerResult,
} from '@/features/workbench/components/window-shell/useTilingDivider';
import {
  softClampTilingRatio,
  tilingPairKey,
} from '@/features/workbench/core/tiling';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import { resetPrefersReducedMotionCacheForTests } from '@/features/workbench/core/pointerEngine';

const LEFT_ID = 'winL';
const RIGHT_ID = 'winR';
const KEY = tilingPairKey(LEFT_ID, RIGHT_ID);

// ---- rAF 手动队列 ----
let rafCallbacks: Map<number, FrameRequestCallback>;
let rafSeq: number;
let nowMs: number;

function flushRaf(advanceMs = 16): void {
  const pending = Array.from(rafCallbacks.entries());
  rafCallbacks.clear();
  nowMs += advanceMs;
  for (const [, cb] of pending) cb(nowMs);
}

/** 推进 settle tween 至完成（多次 flush） */
function flushSettle(): void {
  for (let i = 0; i < 20 && rafCallbacks.size > 0; i++) {
    flushRaf(40);
  }
}

function pointerEvent(
  type: string,
  init: { clientX?: number; pointerId?: number; button?: number },
): PointerEvent {
  const e = new MouseEvent(type, {
    clientX: init.clientX ?? 0,
    button: init.button ?? 0,
    bubbles: true,
  }) as any;
  if (e.pointerId === undefined) {
    Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 });
  }
  return e as PointerEvent;
}

const apiRef: { current: UseTilingDividerResult | null } = { current: null };

const Harness: React.FC = () => {
  const divider = useTilingDivider(LEFT_ID, RIGHT_ID);
  apiRef.current = divider;
  return <div data-testid="wb-divider" onPointerDown={divider.onPointerDown} />;
};

function startDrag(el: Element, clientX: number, pointerId = 1): void {
  act(() => {
    apiRef.current!.onPointerDown({
      nativeEvent: pointerEvent('pointerdown', { clientX, pointerId }),
      currentTarget: el,
      pointerId,
      clientX,
      button: 0,
      preventDefault: () => {},
    } as unknown as React.PointerEvent);
  });
}

/** 无位移的点按（用于双击） */
function clickDivider(el: Element, clientX: number, pointerId: number): void {
  startDrag(el, clientX, pointerId);
  act(() => {
    window.dispatchEvent(pointerEvent('pointerup', { clientX, pointerId }));
  });
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafSeq = 0;
  nowMs = 1000;
  resetPrefersReducedMotionCacheForTests();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafSeq, cb);
    return rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id);
  });
  vi.stubGlobal('performance', { now: () => nowMs });
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
  useWindowStore.getState().setDesktopSize({ w: 1600, h: 1000 });
  useWindowStore.getState().setTilingRatio(KEY, 0.5);
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPrefersReducedMotionCacheForTests();
  document.body.innerHTML = '';
});

describe('useTilingDivider', () => {
  it('拖动中缝 rAF 合帧直写 DOM，松手才 commit store', () => {
    // 挂载左右窗 DOM，供 divider 直写
    const left = document.createElement('div');
    left.setAttribute('data-wb-window-id', LEFT_ID);
    const right = document.createElement('div');
    right.setAttribute('data-wb-window-id', RIGHT_ID);
    document.body.append(left, right);

    render(<Harness />);
    const el = screen.getByTestId('wb-divider');
    startDrag(el, 800);
    expect(apiRef.current!.isDragging()).toBe(true);

    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 1000 }));
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 1120 }));
    });
    // 未 flush：store 与 DOM 均未变
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5);
    act(() => flushRaf());
    // 过程帧：store 仍为旧值；DOM 已按 soft ratio 直写
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5);
    expect(left.style.width).not.toBe('');
    // 1120/1600 = 0.7 → leftW = round((1600-24)*0.7)
    expect(parseFloat(left.style.width)).toBe(Math.round((1600 - 24) * 0.7));

    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 1120 }));
    });
    expect(apiRef.current!.isDragging()).toBe(false);
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.7);
    expect(apiRef.current!.ratio).toBe(0.7);
  });

  it('软区阻尼：越硬界 DOM 映射衰减，释放 settle 回硬约束', () => {
    const left = document.createElement('div');
    left.setAttribute('data-wb-window-id', LEFT_ID);
    const right = document.createElement('div');
    right.setAttribute('data-wb-window-id', RIGHT_ID);
    document.body.append(left, right);

    render(<Harness />);
    const el = screen.getByTestId('wb-divider');
    startDrag(el, 800);

    // raw = 50/1600 ≈ 0.03125 → softClamp 逼近 0.2 但不硬切
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 50 }));
      flushRaf();
    });
    const softLow = softClampTilingRatio(50 / 1600);
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5); // 过程不写 store
    expect(softLow).toBeGreaterThan(0.2);
    expect(softLow).toBeLessThan(0.25);
    expect(parseFloat(left.style.width)).toBe(Math.round((1600 - 24) * softLow));

    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 1590 }));
      flushRaf();
    });
    const softHigh = softClampTilingRatio(1590 / 1600);
    expect(softHigh).toBeLessThan(0.8);
    expect(softHigh).toBeGreaterThan(0.75);

    act(() => {
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 1590 }));
      flushSettle();
    });
    // 释放 settle 到硬上限
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.8);
  });

  it('松手时未 flush 的最后一个点同步落盘', () => {
    render(<Harness />);
    const el = screen.getByTestId('wb-divider');
    startDrag(el, 800);
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 960 }));
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 960 }));
    });
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.6);
    expect(apiRef.current!.isDragging()).toBe(false);
  });

  it('Esc 取消回退到起始比例', () => {
    const left = document.createElement('div');
    left.setAttribute('data-wb-window-id', LEFT_ID);
    document.body.append(left);
    render(<Harness />);
    const el = screen.getByTestId('wb-divider');
    startDrag(el, 800);
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 1120 }));
      flushRaf();
    });
    // 过程未写 store
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5);
    expect(apiRef.current!.isDragging()).toBe(false);
  });

  it('pointercancel 回退到起始比例', () => {
    render(<Harness />);
    const el = screen.getByTestId('wb-divider');
    startDrag(el, 800);
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 400 }));
      flushRaf();
    });
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5);
    act(() => {
      window.dispatchEvent(pointerEvent('pointercancel', {}));
    });
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5);
  });

  it('非主键不启动拖拽', () => {
    render(<Harness />);
    const el = screen.getByTestId('wb-divider');
    act(() => {
      apiRef.current!.onPointerDown({
        nativeEvent: pointerEvent('pointerdown', { clientX: 800, button: 2 }),
        currentTarget: el,
        pointerId: 1,
        clientX: 800,
        button: 2,
        preventDefault: () => {},
      } as unknown as React.PointerEvent);
    });
    expect(apiRef.current!.isDragging()).toBe(false);
  });

  it('getDesktopOffset 参与 clientX → 桌面坐标换算', () => {
    const OffsetHarness: React.FC = () => {
      const divider = useTilingDivider(LEFT_ID, RIGHT_ID, {
        getDesktopOffset: () => ({ x: 200, y: 0 }),
      });
      apiRef.current = divider;
      return <div data-testid="wb-divider-offset" onPointerDown={divider.onPointerDown} />;
    };
    render(<OffsetHarness />);
    const el = screen.getByTestId('wb-divider-offset');
    startDrag(el, 1000);
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 1160 }));
      flushRaf();
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 1160 }));
    });
    // (1160 - 200) / 1600 = 0.6
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.6);
  });

  it('卸载时清理监听，后续 move 不再写 store', () => {
    const utils = render(<Harness />);
    const el = screen.getByTestId('wb-divider');
    startDrag(el, 800);
    utils.unmount();
    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 1120 }));
      flushRaf();
    });
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5);
  });

  it('双击中缝复位 50/50', () => {
    useWindowStore.getState().setTilingRatio(KEY, 0.7);
    render(<Harness />);
    const el = screen.getByTestId('wb-divider');

    clickDivider(el, 800, 1);
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.7);

    nowMs += 50;
    clickDivider(el, 800, 2);
    act(() => flushSettle());
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5);
  });

  it('拖动态挂/摘 wb-tile-divider-active', () => {
    render(<Harness />);
    const el = screen.getByTestId('wb-divider');
    expect(el.classList.contains(TILING_DIVIDER_ACTIVE_CLASS)).toBe(false);

    startDrag(el, 800);
    expect(el.classList.contains(TILING_DIVIDER_ACTIVE_CLASS)).toBe(true);

    act(() => {
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 900 }));
      flushRaf();
      window.dispatchEvent(pointerEvent('pointerup', { clientX: 900 }));
    });
    expect(el.classList.contains(TILING_DIVIDER_ACTIVE_CLASS)).toBe(false);
  });

  it('reduced-motion 下 settle 直接跳变', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((q: string) => ({
        matches: String(q).includes('prefers-reduced-motion'),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })),
    );
    resetPrefersReducedMotionCacheForTests();
    useWindowStore.getState().setTilingRatio(KEY, 0.7);
    render(<Harness />);
    const el = screen.getByTestId('wb-divider');
    clickDivider(el, 800, 1);
    nowMs += 50;
    clickDivider(el, 800, 2);
    // 无 settle rAF，立即 0.5
    expect(rafCallbacks.size).toBe(0);
    expect(useWindowStore.getState().tilingRatios[KEY]).toBe(0.5);
  });
});
