/**
 * O16 — useResizeScrollAnchor 缩放稳定滚动锚点测试
 *
 * jsdom 无布局引擎：滚动几何用 defineProperty 伪造，
 * ResizeObserver 用可手动触发的 stub 替换。
 */
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import {
  useResizeScrollAnchor,
  computeAnchoredScrollTop,
  findMessageViewport,
} from '../useResizeScrollAnchor';

// ---- ResizeObserver stub（记录回调，支持手动触发） ----

type RoCallback = (entries: unknown[], observer: unknown) => void;
let roCallbacks: RoCallback[] = [];
let observedTargets: Element[] = [];

class StubResizeObserver {
  private readonly cb: RoCallback;
  constructor(cb: RoCallback) {
    this.cb = cb;
    roCallbacks.push(cb);
  }
  observe(target: Element) {
    observedTargets.push(target);
  }
  unobserve() {}
  disconnect() {
    roCallbacks = roCallbacks.filter((cb) => cb !== this.cb);
  }
}

function fireResize(): void {
  for (const cb of [...roCallbacks]) cb([], undefined);
}

// ---- 伪造可滚动 viewport ----

interface FakeViewport {
  el: HTMLElement;
  set: (metrics: { scrollHeight?: number; clientHeight?: number; scrollTop?: number }) => void;
  scrollTop: () => number;
  emitScroll: () => void;
}

function makeDom(): { root: HTMLElement; viewport: FakeViewport } {
  const root = document.createElement('div');
  const viewportEl = document.createElement('div');
  viewportEl.setAttribute('data-overlayscrollbars-viewport', '');
  const log = document.createElement('div');
  log.setAttribute('role', 'log');
  viewportEl.appendChild(log);
  root.appendChild(viewportEl);
  document.body.appendChild(root);

  let scrollHeight = 1000;
  let clientHeight = 400;
  let scrollTop = 600; // 吸底：distanceToBottom = 0

  Object.defineProperty(viewportEl, 'scrollHeight', {
    get: () => scrollHeight,
    configurable: true,
  });
  Object.defineProperty(viewportEl, 'clientHeight', {
    get: () => clientHeight,
    configurable: true,
  });
  Object.defineProperty(viewportEl, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });

  return {
    root,
    viewport: {
      el: viewportEl,
      set: (metrics) => {
        if (metrics.scrollHeight !== undefined) scrollHeight = metrics.scrollHeight;
        if (metrics.clientHeight !== undefined) clientHeight = metrics.clientHeight;
        if (metrics.scrollTop !== undefined) scrollTop = metrics.scrollTop;
      },
      scrollTop: () => scrollTop,
      emitScroll: () => viewportEl.dispatchEvent(new Event('scroll')),
    },
  };
}

const Harness: React.FC<{ root: HTMLElement }> = ({ root }) => {
  const ref = useRef<HTMLElement | null>(root);
  useResizeScrollAnchor(ref);
  return null;
};

beforeEach(() => {
  roCallbacks = [];
  observedTargets = [];
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('computeAnchoredScrollTop', () => {
  it('keeps the distance-to-bottom invariant', () => {
    expect(computeAnchoredScrollTop({ scrollHeight: 1000, clientHeight: 400 }, 0)).toBe(600);
    expect(computeAnchoredScrollTop({ scrollHeight: 1000, clientHeight: 400 }, 200)).toBe(400);
  });

  it('clamps to zero when content is shorter than the target distance', () => {
    expect(computeAnchoredScrollTop({ scrollHeight: 300, clientHeight: 400 }, 50)).toBe(0);
  });
});

describe('findMessageViewport', () => {
  it('resolves the scroll viewport that owns the message log', () => {
    const { root, viewport } = makeDom();
    expect(findMessageViewport(root)).toBe(viewport.el);
  });

  it('returns null when no message log is mounted (empty state / skeleton)', () => {
    const root = document.createElement('div');
    expect(findMessageViewport(root)).toBeNull();
  });
});

describe('useResizeScrollAnchor', () => {
  it('keeps the view pinned to bottom across a window resize', () => {
    const { root, viewport } = makeDom();
    render(<Harness root={root} />);
    expect(observedTargets).toContain(root);

    // 缩放：窗口变矮、内容重排变长 → 保持吸底（距底 0）
    viewport.set({ clientHeight: 300, scrollHeight: 1100 });
    fireResize();
    expect(viewport.scrollTop()).toBe(1100 - 300); // 800，仍在底部
  });

  it('preserves the reading position (distance-to-bottom) when scrolled up', () => {
    const { root, viewport } = makeDom();
    render(<Harness root={root} />);

    // 用户上滚到距底 200 处，scroll 事件刷新锚点基准
    viewport.set({ scrollTop: 400 });
    viewport.emitScroll();

    // 缩放后校正：scrollHeight/clientHeight 变化，距底 200 保持不变
    viewport.set({ clientHeight: 500, scrollHeight: 1200 });
    fireResize();
    expect(viewport.scrollTop()).toBe(1200 - 500 - 200); // 500
  });

  it('does nothing when the content does not overflow', () => {
    const { root, viewport } = makeDom();
    render(<Harness root={root} />);

    viewport.set({ scrollHeight: 250, clientHeight: 400, scrollTop: 0 });
    fireResize();
    expect(viewport.scrollTop()).toBe(0);
  });

  it('detaches listeners on unmount', () => {
    const { root, viewport } = makeDom();
    const { unmount } = render(<Harness root={root} />);
    unmount();

    expect(roCallbacks).toHaveLength(0);

    // 卸载后 resize/scroll 不再校正
    viewport.set({ scrollTop: 123, clientHeight: 300, scrollHeight: 1100 });
    fireResize();
    expect(viewport.scrollTop()).toBe(123);
  });
});
