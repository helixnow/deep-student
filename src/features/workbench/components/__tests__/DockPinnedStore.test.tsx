/**
 * O6 — DockPinnedStore：reorder + 订阅稳定性 + 拖拽让位动画清理
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import {
  getDockPinned,
  setDockPinned,
  toggleDockPinned,
  reorderDockPinned,
  subscribeDockPinned,
  useDockPinned,
  useDockPinnedDragReorder,
} from '../DockPinnedStore';

beforeEach(() => {
  setDockPinned([]);
  document.documentElement.removeAttribute('data-wb-material');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-wb-material');
  vi.restoreAllMocks();
});

describe('DockPinnedStore', () => {
  it('setDockPinned 去重保序', () => {
    setDockPinned(['chat', 'files', 'chat', 'todo']);
    expect(getDockPinned()).toEqual(['chat', 'files', 'todo']);
  });

  it('setDockPinned 同内容不 emit', () => {
    setDockPinned(['chat', 'files']);
    const spy = vi.fn();
    const unsub = subscribeDockPinned(spy);
    setDockPinned(['chat', 'files']);
    expect(spy).not.toHaveBeenCalled();
    unsub();
  });

  it('toggleDockPinned 固定 / 取消固定', () => {
    toggleDockPinned('chat');
    expect(getDockPinned()).toEqual(['chat']);
    toggleDockPinned('files');
    expect(getDockPinned()).toEqual(['chat', 'files']);
    toggleDockPinned('chat');
    expect(getDockPinned()).toEqual(['files']);
  });

  it('reorderDockPinned 移动项并保序', () => {
    setDockPinned(['a', 'b', 'c', 'd']);
    reorderDockPinned(0, 2);
    expect(getDockPinned()).toEqual(['b', 'c', 'a', 'd']);
    reorderDockPinned(3, 0);
    expect(getDockPinned()).toEqual(['d', 'b', 'c', 'a']);
  });

  it('reorderDockPinned 越界 / 同索引为 no-op', () => {
    setDockPinned(['a', 'b']);
    const spy = vi.fn();
    const unsub = subscribeDockPinned(spy);
    reorderDockPinned(0, 0);
    reorderDockPinned(-1, 1);
    reorderDockPinned(0, 5);
    reorderDockPinned(1.5 as number, 0);
    expect(spy).not.toHaveBeenCalled();
    expect(getDockPinned()).toEqual(['a', 'b']);
    unsub();
  });

  it('useDockPinned 订阅更新', () => {
    const { result } = renderHook(() => useDockPinned());
    expect(result.current).toEqual([]);
    act(() => setDockPinned(['chat']));
    expect(result.current).toEqual(['chat']);
    act(() => reorderDockPinned(0, 0)); // no-op
    expect(result.current).toEqual(['chat']);
    act(() => {
      setDockPinned(['files', 'chat']);
    });
    expect(result.current).toEqual(['files', 'chat']);
  });

  it('useDockPinnedDragReorder：固定项返回 data 属性与 onPointerDown', () => {
    setDockPinned(['chat']);
    const { result } = renderHook(() => useDockPinnedDragReorder('chat'));
    expect(result.current).toHaveProperty('data-wb-dock-pinned-id', 'chat');
    expect(result.current).toHaveProperty('onPointerDown');
  });

  it('useDockPinnedDragReorder：非固定项返回空对象', () => {
    setDockPinned(['files']);
    const { result } = renderHook(() => useDockPinnedDragReorder('chat'));
    expect(result.current).toEqual({});
  });

  it('拖拽启动阈值按指针类型差异化：触屏 10px 不启动 / 15px 启动；鼠标 6px 即启动', () => {
    setDockPinned(['a', 'b']);

    // 队列式 rAF：flushFrame 开头会清 rafId，同步执行的 stub 会把返回值
    // 写回 rafId 卡死后续 move 的合帧调度，必须事后手动冲刷
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const flushRaf = () => {
      while (rafQueue.length) rafQueue.shift()!(0);
    };
    // jsdom 无 WAAPI：finish 路径的 cancelElementAnimations 需要 getAnimations
    HTMLElement.prototype.getAnimations = function () {
      return [];
    };

    const listeners = new Map<string, EventListener>();
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (
        typeof listener === 'function' &&
        (type === 'pointermove' || type === 'pointerup' || type === 'pointercancel')
      ) {
        listeners.set(String(type), listener as EventListener);
      }
      return origAdd(
        type,
        listener as EventListenerOrEventListenerObject,
        options as boolean | AddEventListenerOptions,
      );
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
      if (type === 'pointermove' || type === 'pointerup' || type === 'pointercancel') {
        listeners.delete(String(type));
      }
      return origRemove(
        type,
        listener as EventListenerOrEventListenerObject,
        options as boolean | EventListenerOptions,
      );
    });

    let bindA: { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void } | null = null;

    function Harness() {
      const a = useDockPinnedDragReorder('a');
      const b = useDockPinnedDragReorder('b');
      if ('onPointerDown' in a) bindA = a as { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void };
      return (
        <div className="wb-dock">
          <div data-testid="pin-a" {...(a as React.HTMLAttributes<HTMLDivElement>)} />
          <div data-testid="pin-b" {...(b as React.HTMLAttributes<HTMLDivElement>)} />
        </div>
      );
    }

    const { getByTestId } = render(<Harness />);
    const elA = getByTestId('pin-a');
    expect(bindA).toBeTruthy();

    const down = (pointerId: number, clientX: number, pointerType: string) => {
      act(() => {
        bindA!.onPointerDown({
          button: 0,
          pointerId,
          clientX,
          pointerType,
          currentTarget: elA,
          target: elA,
        } as unknown as React.PointerEvent<HTMLElement>);
      });
    };
    const call = (type: 'pointermove' | 'pointerup', pointerId: number, clientX: number) => {
      act(() => {
        listeners.get(type)!({ pointerId, clientX } as unknown as Event);
        if (type === 'pointermove') flushRaf();
      });
    };

    // 触屏：10px（≤ 长按容差）不启动重排
    down(11, 100, 'touch');
    call('pointermove', 11, 110);
    expect(elA).not.toHaveAttribute('data-wb-dock-pinned-dragging');
    // 15px（> 14px 阈值）才启动
    call('pointermove', 11, 115);
    expect(elA).toHaveAttribute('data-wb-dock-pinned-dragging');
    call('pointerup', 11, 115);
    expect(elA).not.toHaveAttribute('data-wb-dock-pinned-dragging');

    // 鼠标：6px（> 5px 阈值）即启动，灵敏手感不变
    down(12, 100, 'mouse');
    call('pointermove', 12, 106);
    expect(elA).toHaveAttribute('data-wb-dock-pinned-dragging');
    call('pointerup', 12, 106);
    expect(getDockPinned()).toEqual(['a', 'b']); // 未跨槽，不重排
  });

  it('兄弟让位：fill none；跨槽 cancel 旧动画；drop 后清残留', () => {
    setDockPinned(['a', 'b', 'c']);

    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          getPropertyValue: (name: string) => {
            if (name === '--wb-motion-quick') return '150ms';
            if (name === '--wb-ease-overshoot') return 'cubic-bezier(0.34, 1.56, 0.64, 1)';
            return '';
          },
        }) as CSSStyleDeclaration,
    );

    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    type AnimStub = { cancel: ReturnType<typeof vi.fn>; finished: Promise<void> };
    const animCalls: Array<{ el: HTMLElement; opts: KeyframeAnimationOptions }> = [];
    const animByEl = new WeakMap<HTMLElement, AnimStub[]>();

    HTMLElement.prototype.animate = vi.fn(function (
      this: HTMLElement,
      _kf: Keyframe[],
      opts: KeyframeAnimationOptions,
    ) {
      const stub: AnimStub = { cancel: vi.fn(), finished: Promise.resolve() };
      const list = animByEl.get(this) ?? [];
      list.push(stub);
      animByEl.set(this, list);
      animCalls.push({ el: this, opts });
      return stub as unknown as Animation;
    }) as unknown as typeof HTMLElement.prototype.animate;

    HTMLElement.prototype.getAnimations = function (this: HTMLElement) {
      return (animByEl.get(this) ?? []) as unknown as Animation[];
    };

    // 透传捕获 window 上的 move/up
    const listeners = new Map<string, EventListener>();
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (
        typeof listener === 'function' &&
        (type === 'pointermove' || type === 'pointerup' || type === 'pointercancel')
      ) {
        listeners.set(String(type), listener as EventListener);
      }
      return origAdd(
        type,
        listener as EventListenerOrEventListenerObject,
        options as boolean | AddEventListenerOptions,
      );
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, options) => {
      if (type === 'pointermove' || type === 'pointerup' || type === 'pointercancel') {
        listeners.delete(String(type));
      }
      return origRemove(
        type,
        listener as EventListenerOrEventListenerObject,
        options as boolean | EventListenerOptions,
      );
    });

    let bindA: { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void } | null = null;

    function Harness() {
      const a = useDockPinnedDragReorder('a');
      const b = useDockPinnedDragReorder('b');
      const c = useDockPinnedDragReorder('c');
      if ('onPointerDown' in a) bindA = a as { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void };
      return (
        <div className="wb-dock">
          <div data-testid="pin-a" {...(a as React.HTMLAttributes<HTMLDivElement>)} />
          <div data-testid="pin-b" {...(b as React.HTMLAttributes<HTMLDivElement>)} />
          <div data-testid="pin-c" {...(c as React.HTMLAttributes<HTMLDivElement>)} />
        </div>
      );
    }

    const { getByTestId } = render(<Harness />);
    const elA = getByTestId('pin-a');
    const elB = getByTestId('pin-b');
    const elC = getByTestId('pin-c');
    expect(bindA).toBeTruthy();

    // 三项都给真实布局 rect：slotStride 取自相邻 wrap 中心差（含 gap），
    // jsdom 默认零 rect 会让 stride 计算失真
    const mockRect = (el: HTMLElement, left: number) => {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        width: 40,
        height: 40,
        top: 0,
        left,
        bottom: 40,
        right: left + 40,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    };
    mockRect(elA, 0);
    mockRect(elB, 44);
    mockRect(elC, 88);

    animCalls.length = 0;

    // 直接调 hook 的 onPointerDown，避免 jsdom pointer 事件残缺
    act(() => {
      bindA!.onPointerDown({
        button: 0,
        pointerId: 7,
        clientX: 100,
        currentTarget: elA,
        target: elA,
      } as unknown as React.PointerEvent<HTMLElement>);
    });
    expect(listeners.has('pointermove')).toBe(true);

    const call = (type: 'pointermove' | 'pointerup', clientX: number) => {
      listeners.get(type)!({ pointerId: 7, clientX } as unknown as Event);
    };

    act(() => {
      call('pointermove', 150);
    });

    expect(elA).toHaveAttribute('data-wb-dock-pinned-dragging');

    const siblingAnims = animCalls.filter((c) => c.el === elB);
    expect(siblingAnims.length).toBeGreaterThanOrEqual(1);
    // 核心：不再用 fill:forwards（否则 drop 后残留压住布局）
    expect(siblingAnims.every((c) => c.opts.fill === 'none')).toBe(true);
    expect(elB.style.transform).toContain('translate3d');

    const stubsBeforeDrop = [...(animByEl.get(elB) ?? [])];

    act(() => {
      call('pointerup', 150);
    });

    // drop：clearSiblingTransforms → cancel 全部兄弟动画 + 清 inline
    expect(stubsBeforeDrop.every((s) => s.cancel.mock.calls.length > 0)).toBe(true);
    expect(elB.style.transform).toBe('');
    expect(elA).not.toHaveAttribute('data-wb-dock-pinned-dragging');
    expect(getDockPinned()).toEqual(['b', 'a', 'c']);
  });
});
