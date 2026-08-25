/**
 * P2 — SnapPreview 吸附预览测试
 * 覆盖：zone → 轮廓 frame 映射、wb-snap-preview 类、120ms fade-in/out、独立 fixed 层
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SnapPreview } from '@/features/workbench/components/SnapPreview';
import { useWindowStore } from '@/features/workbench/core/windowStore';

// ---- rAF 手动队列 ----
let rafCallbacks: Map<number, FrameRequestCallback>;
let rafSeq: number;
function flushRaf(): void {
  const pending = Array.from(rafCallbacks.values());
  rafCallbacks.clear();
  for (const cb of pending) cb(performance.now());
}

beforeEach(() => {
  vi.useFakeTimers();
  rafCallbacks = new Map();
  rafSeq = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafSeq, cb);
    return rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id);
  });
  useWindowStore.getState().setDesktopSize({ w: 1600, h: 1000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SnapPreview', () => {
  it('zone=left 渲染半屏轮廓（wb-snap-preview + fixed + pointer-events:none）', () => {
    render(<SnapPreview zone="left" margin={8} />);
    const el = screen.getByTestId('wb-snap-preview');
    expect(el.className).toContain('wb-snap-preview');
    expect(el.getAttribute('data-zone')).toBe('left');
    // computeTiledFrame('tiled-left', {1600×1000, m=8}) = {8, 8, 788, 984}
    expect(el.style.position).toBe('fixed');
    expect(el.style.pointerEvents).toBe('none');
    expect(el.style.zIndex).toBe('var(--wb-z-snap-preview)');
    expect(el.style.width).toBe('788px');
    expect(el.style.height).toBe('984px');
    expect(el.style.transform).toBe('translate3d(8px, 8px, 0)');
  });

  it('fade-in：data-wb-snap-visible 初始 false，两帧后 true（opacity 由 CSS 驱动）', () => {
    render(<SnapPreview zone="right" margin={8} />);
    const el = screen.getByTestId('wb-snap-preview');
    expect(el.getAttribute('data-wb-snap-visible')).toBe('false');
    expect(el.style.opacity).toBe(''); // 不再写 inline opacity/transition
    expect(el.style.transition).toBe('');
    act(() => flushRaf()); // 第一帧
    act(() => flushRaf()); // 第二帧 → visible
    expect(el.getAttribute('data-wb-snap-visible')).toBe('true');
  });

  it('top-maximize 轮廓填满桌面', () => {
    render(<SnapPreview zone="top-maximize" margin={8} />);
    const el = screen.getByTestId('wb-snap-preview');
    expect(el.style.width).toBe('1600px');
    expect(el.style.height).toBe('1000px');
    expect(el.style.transform).toBe('translate3d(0px, 0px, 0)');
  });

  it('四分屏 zone 轮廓正确（br）', () => {
    render(<SnapPreview zone="br" margin={8} />);
    const el = screen.getByTestId('wb-snap-preview');
    // computeTiledFrame('tiled-br') = {804, 504, 788, 488}
    expect(el.style.width).toBe('788px');
    expect(el.style.height).toBe('488px');
    expect(el.style.transform).toBe('translate3d(804px, 504px, 0)');
  });

  it('zone=null 初始不渲染任何 DOM', () => {
    render(<SnapPreview zone={null} margin={8} />);
    expect(screen.queryByTestId('wb-snap-preview')).toBeNull();
  });

  it('zone → null：fade-out 后卸载，期间保留最后轮廓', () => {
    const { rerender } = render(<SnapPreview zone="left" margin={8} />);
    act(() => flushRaf());
    act(() => flushRaf());
    expect(screen.getByTestId('wb-snap-preview').getAttribute('data-wb-snap-visible')).toBe('true');

    rerender(<SnapPreview zone={null} margin={8} />);
    const el = screen.getByTestId('wb-snap-preview');
    expect(el.getAttribute('data-wb-snap-visible')).toBe('false');
    expect(el.style.width).toBe('788px'); // 保留最后 frame
    act(() => {
      // FADE_UNMOUNT_FALLBACK_MS=200（token 读不到时）
      vi.advanceTimersByTime(220);
    });
    expect(screen.queryByTestId('wb-snap-preview')).toBeNull();
  });

  it('zone 快速切换不卸载，轮廓跟随新 zone', () => {
    const { rerender } = render(<SnapPreview zone="left" margin={8} />);
    act(() => flushRaf());
    act(() => flushRaf());
    rerender(<SnapPreview zone="right" margin={8} />);
    const el = screen.getByTestId('wb-snap-preview');
    expect(el.getAttribute('data-zone')).toBe('right');
    expect(el.style.transform).toBe('translate3d(804px, 8px, 0)');
    act(() => flushRaf());
    act(() => flushRaf());
    expect(el.getAttribute('data-wb-snap-visible')).toBe('true');
  });

  it('desktopOffset 参与 fixed 定位换算', () => {
    render(<SnapPreview zone="left" margin={8} desktopOffset={{ x: 240, y: 40 }} />);
    const el = screen.getByTestId('wb-snap-preview');
    expect(el.style.transform).toBe('translate3d(248px, 48px, 0)');
  });

  it('margin=0（关闭平铺间距）轮廓贴边', () => {
    render(<SnapPreview zone="left" margin={0} />);
    const el = screen.getByTestId('wb-snap-preview');
    expect(el.style.transform).toBe('translate3d(0px, 0px, 0)');
    expect(el.style.width).toBe('800px');
    expect(el.style.height).toBe('1000px');
  });
});

describe('⌥ 扩热区角标', () => {
  const badge = () => document.querySelector('[data-wb-snap-alt-badge]');

  it('Alt 按下显示角标（⌥ + 提示文案），松开消失', () => {
    render(<SnapPreview zone="left" margin={8} />);
    expect(badge()).toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    });
    const el = badge();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain('⌥');
    expect(el!.textContent).toContain('热区已扩大');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    });
    expect(badge()).toBeNull();
  });

  it('拖拽指针流 e.altKey 兜底同步（Alt 先于预览按下 / keyup 丢失）', () => {
    render(<SnapPreview zone="right" margin={8} />);
    // Alt 在预览挂载前已按下 → 首个 pointermove 补齐状态
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { altKey: true }));
    });
    expect(badge()).not.toBeNull();

    // keyup 丢失（如焦点被吃）：无 Alt 的指针流也能复位
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { altKey: false }));
    });
    expect(badge()).toBeNull();
  });

  it('窗口失焦复位角标', () => {
    render(<SnapPreview zone="left" margin={8} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    });
    expect(badge()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(badge()).toBeNull();
  });

  it('离开热区（zone→null）后角标不随 fade-out 残留', () => {
    const { rerender } = render(<SnapPreview zone="left" margin={8} />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    });
    expect(badge()).not.toBeNull();

    rerender(<SnapPreview zone={null} margin={8} />);
    // fade-out 期间轮廓仍在，但角标立即隐藏
    expect(screen.getByTestId('wb-snap-preview')).toBeInTheDocument();
    expect(badge()).toBeNull();
  });
});
