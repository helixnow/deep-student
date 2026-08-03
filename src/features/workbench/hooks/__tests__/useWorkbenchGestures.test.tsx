/**
 * O19 手势 hook 测试：捏合（ctrl+wheel）会话合成 / 双指滑动主轴判定 /
 * 滚轮归一化 / useWheelStep 步进 / 全局光标锁栈
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useWorkbenchGestures,
  useWheelStep,
  normalizeWheelDelta,
  lockWorkbenchCursor,
  getActiveWorkbenchCursor,
  resetWorkbenchCursorForTests,
  type WorkbenchPinchGesture,
  type WorkbenchSwipeGesture,
} from '../useWorkbenchGestures';

function makeTarget(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function wheel(
  el: HTMLElement,
  init: WheelEventInit & { deltaMode?: number },
): void {
  el.dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }),
  );
}

describe('useWorkbenchGestures', () => {
  let target: HTMLElement;

  beforeEach(() => {
    target = makeTarget();
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    target.remove();
  });

  it('ctrl+wheel 合成 pinch start/update/end 会话，scale 按指数累计', () => {
    const events: WorkbenchPinchGesture[] = [];
    renderHook(() =>
      useWorkbenchGestures({ target, onPinch: (g) => events.push({ ...g }) }),
    );

    // deltaY=-100 → factor exp(1)
    wheel(target, { ctrlKey: true, deltaY: -100, clientX: 40, clientY: 30 });
    vi.advanceTimersByTime(20); // rAF flush

    expect(events.map((e) => e.phase)).toEqual(['start', 'update']);
    expect(events[0].scale).toBe(1);
    expect(events[1].scale).toBeCloseTo(Math.E, 3);

    // 二次事件继续累计
    wheel(target, { ctrlKey: true, deltaY: -100 });
    vi.advanceTimersByTime(20);
    expect(events[2].phase).toBe('update');
    expect(events[2].scale).toBeCloseTo(Math.E * Math.E, 2);

    // 静默期合成 end
    vi.advanceTimersByTime(300);
    expect(events[events.length - 1].phase).toBe('end');
    expect(events[events.length - 1].scale).toBeCloseTo(Math.E * Math.E, 2);
  });

  it('pinch 阻止默认行为（浏览器缩放），普通 wheel 不阻止', () => {
    renderHook(() => useWorkbenchGestures({ target, onPinch: () => {} }));

    const pinchEvent = new WheelEvent('wheel', {
      ctrlKey: true,
      deltaY: -50,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(pinchEvent);
    expect(pinchEvent.defaultPrevented).toBe(true);

    const plainEvent = new WheelEvent('wheel', {
      deltaY: -50,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(plainEvent);
    expect(plainEvent.defaultPrevented).toBe(false);
  });

  it('像素级 wheel 合成 swipe 会话并锁定主轴与方向', () => {
    const events: WorkbenchSwipeGesture[] = [];
    renderHook(() =>
      useWorkbenchGestures({ target, onSwipe: (g) => events.push({ ...g }) }),
    );

    wheel(target, { deltaX: 30, deltaY: 4, deltaMode: 0 });
    vi.advanceTimersByTime(20);

    expect(events[0].phase).toBe('start');
    expect(events[0].axis).toBeNull();
    expect(events[1].phase).toBe('update');
    expect(events[1].deltaX).toBe(30);
    expect(events[1].axis).toBe('x');
    expect(events[1].direction).toBe('left');

    vi.advanceTimersByTime(300);
    expect(events[events.length - 1].phase).toBe('end');
  });

  it('行模式 wheel（鼠标滚轮）不启动 swipe 会话', () => {
    const events: WorkbenchSwipeGesture[] = [];
    renderHook(() =>
      useWorkbenchGestures({ target, onSwipe: (g) => events.push({ ...g }) }),
    );
    wheel(target, { deltaY: 3, deltaMode: 1 });
    vi.advanceTimersByTime(400);
    expect(events).toHaveLength(0);
  });

  it('卸载时进行中的会话正常收尾（emit end）并移除监听', () => {
    const events: WorkbenchPinchGesture[] = [];
    const { unmount } = renderHook(() =>
      useWorkbenchGestures({ target, onPinch: (g) => events.push({ ...g }) }),
    );
    wheel(target, { ctrlKey: true, deltaY: -100 });
    vi.advanceTimersByTime(20);
    unmount();
    expect(events[events.length - 1].phase).toBe('end');

    const before = events.length;
    wheel(target, { ctrlKey: true, deltaY: -100 });
    vi.advanceTimersByTime(400);
    expect(events).toHaveLength(before);
  });

  it('isGestureActive 反映会话状态', () => {
    const { result } = renderHook(() =>
      useWorkbenchGestures({ target, onPinch: () => {} }),
    );
    expect(result.current.isGestureActive()).toBe(false);
    wheel(target, { ctrlKey: true, deltaY: -10 });
    expect(result.current.isGestureActive()).toBe(true);
    vi.advanceTimersByTime(400);
    expect(result.current.isGestureActive()).toBe(false);
  });
});

describe('normalizeWheelDelta', () => {
  it('行 / 页模式换算为 px', () => {
    const line = normalizeWheelDelta(
      new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 }),
    );
    expect(line.dy).toBe(48);
    expect(line.isPixelMode).toBe(false);

    const pixel = normalizeWheelDelta(
      new WheelEvent('wheel', { deltaY: 120, deltaMode: 0 }),
    );
    expect(pixel.dy).toBe(120);
    expect(pixel.isPixelMode).toBe(true);
  });
});

describe('useWheelStep', () => {
  let target: HTMLElement;

  beforeEach(() => {
    target = makeTarget();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    target.remove();
  });

  it('累计跨过阈值触发 ±1 步进并保留余量', () => {
    const steps: number[] = [];
    renderHook(() =>
      useWheelStep({ target, onStep: (s) => steps.push(s), stepSize: 80 }),
    );

    wheel(target, { deltaY: 100 });
    expect(steps).toEqual([1]); // 余量 +20

    wheel(target, { deltaY: -200 });
    expect(steps).toEqual([1, -1, -1]); // 20-200=-180 → 两步

    // 静默重置余量
    vi.advanceTimersByTime(400);
    wheel(target, { deltaY: 79 });
    expect(steps).toEqual([1, -1, -1]);
  });

  it('默认消费掉 wheel（preventDefault）', () => {
    renderHook(() => useWheelStep({ target, onStep: () => {} }));
    const event = new WheelEvent('wheel', {
      deltaY: 10,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('lockWorkbenchCursor', () => {
  afterEach(() => {
    resetWorkbenchCursorForTests();
  });

  it('锁定 / 嵌套 / 释放恢复上一层，全部释放后移除属性', () => {
    const rootEl = document.documentElement;
    expect(rootEl.hasAttribute('data-wb-cursor')).toBe(false);

    const releaseOuter = lockWorkbenchCursor('grabbing');
    expect(rootEl.getAttribute('data-wb-cursor')).toBe('grabbing');
    expect(getActiveWorkbenchCursor()).toBe('grabbing');

    const releaseInner = lockWorkbenchCursor('col-resize');
    expect(rootEl.getAttribute('data-wb-cursor')).toBe('col-resize');

    releaseInner();
    expect(rootEl.getAttribute('data-wb-cursor')).toBe('grabbing');

    releaseOuter();
    expect(rootEl.hasAttribute('data-wb-cursor')).toBe(false);
    expect(getActiveWorkbenchCursor()).toBeNull();
  });

  it('乱序释放与幂等释放安全', () => {
    const rootEl = document.documentElement;
    const releaseA = lockWorkbenchCursor('grabbing');
    const releaseB = lockWorkbenchCursor('ns-resize');

    releaseA(); // 先释放栈底
    expect(rootEl.getAttribute('data-wb-cursor')).toBe('ns-resize');
    releaseA(); // 幂等
    expect(rootEl.getAttribute('data-wb-cursor')).toBe('ns-resize');

    releaseB();
    expect(rootEl.hasAttribute('data-wb-cursor')).toBe(false);
  });
});
