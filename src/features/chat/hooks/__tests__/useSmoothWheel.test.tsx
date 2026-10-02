import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeWheelDeltaY, useSmoothWheel } from '../useSmoothWheel';

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

describe('normalizeWheelDeltaY', () => {
  it('passes pixel-mode deltas through unchanged', () => {
    expect(normalizeWheelDeltaY({ deltaMode: PIXEL, deltaY: -37.5 })).toBe(-37.5);
  });

  it('scales line-mode deltas by an approximate line height', () => {
    expect(normalizeWheelDeltaY({ deltaMode: LINE, deltaY: -3 })).toBe(-48);
    expect(normalizeWheelDeltaY({ deltaMode: LINE, deltaY: 1 })).toBe(16);
  });

  it('scales page-mode deltas by the viewport height', () => {
    expect(normalizeWheelDeltaY({ deltaMode: PAGE, deltaY: -1, clientHeight: 800 })).toBe(-800);
  });

  it('falls back to a sane height when page mode has no clientHeight', () => {
    const result = normalizeWheelDeltaY({ deltaMode: PAGE, deltaY: -1 });
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeLessThan(0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 挂载探针：把 hook 挂到受控节点上 */
function Probe({
  target,
  onUserScrollUp,
}: {
  target: HTMLElement;
  onUserScrollUp?: () => void;
}) {
  useSmoothWheel(target, { onUserScrollUp });
  return null;
}

function wheel(target: HTMLElement, init: WheelEventInit) {
  target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }));
}

describe('useSmoothWheel', () => {
  it('registers the wheel listener as passive so native scrolling is never blocked', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const addSpy = vi.spyOn(host, 'addEventListener');

    render(<Probe target={host} />);

    const wheelCall = addSpy.mock.calls.find(([type]) => type === 'wheel');
    expect(wheelCall).toBeDefined();
    expect(wheelCall?.[2]).toEqual({ passive: true });
  });

  it('does not run an easing loop that would fight the browser scroll timeline', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');

    const { unmount } = render(<Probe target={host} />);
    for (let i = 0; i < 5; i += 1) wheel(host, { deltaY: -120 });

    // 旧实现每步 wheel 都排一个 rAF 缓动帧；新实现一次都不排
    expect(rafSpy).not.toHaveBeenCalled();
    act(() => unmount());
  });

  // 注意：passive 监听器里的 preventDefault 是浏览器空操作，所以这条断言
  // 单独用变异测试抓不到"偷偷加了 preventDefault"——真正拦住那种改动的是上面
  // passive: true 的断言（被动注册会让 preventDefault 失效）。这里留作纵深防御。
  it('never calls preventDefault, leaving scroll to the browser', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<Probe target={host} />);

    const event = new WheelEvent('wheel', {
      deltaY: -120,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('reports upward scroll intent with a normalized pixel delta', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onUserScrollUp = vi.fn();
    render(<Probe target={host} onUserScrollUp={onUserScrollUp} />);

    wheel(host, { deltaY: -120 });
    expect(onUserScrollUp).toHaveBeenCalledTimes(1);
  });

  it('reports intent for trackpad-style fractional upward deltas', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onUserScrollUp = vi.fn();
    render(<Probe target={host} onUserScrollUp={onUserScrollUp} />);

    // 触控板 deltaY 常为小数，向上滚同样必须能表达
    wheel(host, { deltaY: -3.14 });
    expect(onUserScrollUp).toHaveBeenCalledTimes(1);
  });

  it('normalizes line-mode upward deltas before deciding intent', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onUserScrollUp = vi.fn();
    render(<Probe target={host} onUserScrollUp={onUserScrollUp} />);

    wheel(host, { deltaMode: LINE, deltaY: -1 });
    expect(onUserScrollUp).toHaveBeenCalledTimes(1);
  });

  it('ignores downward scrolls and sub-pixel jitter', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onUserScrollUp = vi.fn();
    render(<Probe target={host} onUserScrollUp={onUserScrollUp} />);

    wheel(host, { deltaY: 120 });
    wheel(host, { deltaY: -0.2 });
    expect(onUserScrollUp).not.toHaveBeenCalled();
  });

  it('ignores horizontal-dominant wheel gestures', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onUserScrollUp = vi.fn();
    render(<Probe target={host} onUserScrollUp={onUserScrollUp} />);

    wheel(host, { deltaX: -200, deltaY: -5 });
    expect(onUserScrollUp).not.toHaveBeenCalled();
  });

  it('does not report when disabled', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onUserScrollUp = vi.fn();

    const DisabledProbe = () => {
      useSmoothWheel(host, { enabled: false, onUserScrollUp });
      return null;
    };
    render(<DisabledProbe />);

    wheel(host, { deltaY: -120 });
    expect(onUserScrollUp).not.toHaveBeenCalled();
  });

  it('stops listening after unmount', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onUserScrollUp = vi.fn();

    const { unmount } = render(<Probe target={host} onUserScrollUp={onUserScrollUp} />);
    act(() => unmount());

    wheel(host, { deltaY: -120 });
    expect(onUserScrollUp).not.toHaveBeenCalled();
  });
});