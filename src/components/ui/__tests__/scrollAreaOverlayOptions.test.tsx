/**
 * ScrollArea 驱动 OverlayScrollbars 时不做多余的完整 update（每轮 update 都切换视口属性、
 * 强制整片视口子树样式重算）：
 * - options / events 引用须跨渲染稳定：overlayscrollbars-react 在 options 引用变化时重新下发选项，
 *   OverlayScrollbars 按引用比较其中的函数，判成「已变」就做一次完整 update；
 * - 挂载时初始化已完整量测，trackOffset 同步 effect 不再紧跟着 update(true)，只在 trackOffset 变化时补。
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const { hookParams, os, initialize, getInstance } = vi.hoisted(() => {
  const os = {
    instance: null as null | { update: ReturnType<typeof vi.fn>; destroy: () => void; elements: () => unknown },
    inits: 0,
  };
  // 与 overlayscrollbars-react 一致：初始化 / 取实例函数跨渲染引用稳定
  const initialize = () => {
    os.inits += 1;
    os.instance = {
      update: vi.fn(),
      destroy: () => { os.instance = null; },
      elements: () => ({ scrollbarVertical: { handle: null }, scrollbarHorizontal: { handle: null } }),
    };
  };
  const getInstance = () => os.instance;
  return { hookParams: [] as Array<{ options?: unknown; events?: unknown }>, os, initialize, getInstance };
});

vi.mock('overlayscrollbars-react', () => ({
  useOverlayScrollbars: (params: { options?: unknown; events?: unknown }) => {
    hookParams.push(params);
    return [initialize, getInstance];
  },
}));

import { ScrollArea } from '../scroll-area';

beforeEach(() => {
  hookParams.length = 0;
  os.instance = null;
  os.inits = 0;
});

describe('ScrollArea overlay options identity', () => {
  it('同样的 props 重渲染时 options / events 引用不变；选项值变化时才换新 options', () => {
    const { rerender } = render(<ScrollArea nativeScrollbars={false}>a</ScrollArea>);
    rerender(<ScrollArea nativeScrollbars={false}>b</ScrollArea>);

    expect(hookParams.length).toBeGreaterThanOrEqual(2);
    const first = hookParams[0]!;
    const last = hookParams[hookParams.length - 1]!;
    expect(last.options).toBe(first.options);
    expect(last.events).toBe(first.events);

    rerender(<ScrollArea nativeScrollbars={false} scrollHideDelay={0}>b</ScrollArea>);
    const changed = hookParams[hookParams.length - 1]!;
    expect(changed.options).not.toBe(first.options);
    expect(changed.events).toBe(first.events);
    expect((changed.options as { scrollbars: { autoHide: string } }).scrollbars.autoHide).toBe('never');
  });
});

describe('ScrollArea trackOffset 同步', () => {
  it('挂载时只初始化不补 update；trackOffset 变化才 update(true)', () => {
    const { rerender } = render(
      <ScrollArea nativeScrollbars={false} trackOffset={{ top: 8 }}>a</ScrollArea>,
    );
    expect(os.inits).toBe(1);
    const instance = os.instance!;
    expect(instance.update).not.toHaveBeenCalled();

    rerender(<ScrollArea nativeScrollbars={false} trackOffset={{ top: 8 }}>b</ScrollArea>);
    expect(instance.update).not.toHaveBeenCalled();

    rerender(<ScrollArea nativeScrollbars={false} trackOffset={{ top: 12 }}>b</ScrollArea>);
    expect(instance.update).toHaveBeenCalledTimes(1);
    expect(instance.update).toHaveBeenCalledWith(true);
  });
});

describe('ScrollArea 内容尺寸变化与溢出态恢复（G25）', () => {
  it('直接子元素高度异步增长后触发 update(true)，避免停留在 overflowYHidden', () => {
    const callbacks: Array<ResizeObserverCallback> = [];
    const observed = new Set<Element>();
    class MockResizeObserver {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        callbacks.push(cb);
      }
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    }
    const rafQueue: FrameRequestCallback[] = [];
    const origRO = globalThis.ResizeObserver;
    const origRAF = globalThis.requestAnimationFrame;
    const origCAF = globalThis.cancelAnimationFrame;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();

    try {
      const { container, unmount } = render(
        <ScrollArea nativeScrollbars={false}>
          <div data-testid="dynamic-content">loading</div>
        </ScrollArea>,
      );
      const instance = os.instance!;
      const content = container.querySelector('[data-testid="dynamic-content"]') as HTMLElement;
      expect(observed.has(content)).toBe(true);
      expect(instance.update).not.toHaveBeenCalled();

      // 首次基线回调（尺寸未变、无溢出）：不触发多余 update
      callbacks[0]!(
        [{ target: content, contentRect: { width: 600, height: 360 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(rafQueue).toHaveLength(0);
      expect(instance.update).not.toHaveBeenCalled();

      // 异步分区（如 DocumentProcessingTab -> OcrSettingsSection）加载完成撑高内容
      callbacks[0]!(
        [{ target: content, contentRect: { width: 600, height: 1480 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(rafQueue).toHaveLength(1);
      rafQueue.shift()!(16);
      expect(instance.update).toHaveBeenCalledTimes(1);
      expect(instance.update).toHaveBeenCalledWith(true);

      unmount();
      expect(observed.size).toBe(0);
    } finally {
      globalThis.ResizeObserver = origRO;
      globalThis.requestAnimationFrame = origRAF;
      globalThis.cancelAnimationFrame = origCAF;
    }
  });

  it('视口 scrollHeight > clientHeight 但仍缺少 overflowYScroll 时立即调度 update(true)', () => {
    const callbacks: Array<ResizeObserverCallback> = [];
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        callbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const rafQueue: FrameRequestCallback[] = [];
    const origRO = globalThis.ResizeObserver;
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof requestAnimationFrame;

    try {
      const viewportRef = React.createRef<HTMLDivElement>();
      render(
        <ScrollArea nativeScrollbars={false} viewportRef={viewportRef}>
          <div>tall content</div>
        </ScrollArea>,
      );
      const vp = viewportRef.current!;
      vp.setAttribute('data-overlayscrollbars-viewport', 'scrollbarHidden overflowXHidden overflowYHidden');
      Object.defineProperty(vp, 'clientHeight', { configurable: true, value: 600 });
      Object.defineProperty(vp, 'scrollHeight', { configurable: true, value: 1400 });

      callbacks[0]!(
        [{ target: vp, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(rafQueue).toHaveLength(1);
      rafQueue.shift()!(16);
      expect(os.instance!.update).toHaveBeenCalledWith(true);
    } finally {
      globalThis.ResizeObserver = origRO;
      globalThis.requestAnimationFrame = origRAF;
    }
  });
});
