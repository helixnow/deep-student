/**
 * WindowTitleBar 打磨轮测试：三键 aria 标签 / 绿灯状态语义 /
 * 长标题溢出 tooltip / 双击涟漪 + zoom。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { WindowTitleBar } from '../WindowTitleBar';
import type { DisplayMode } from '../../core/types';

function renderBar(overrides: Partial<React.ComponentProps<typeof WindowTitleBar>> = {}) {
  const props = {
    windowId: 'w1',
    title: '测试窗口',
    focused: true,
    displayMode: 'floating' as DisplayMode,
    onClose: vi.fn(),
    onMinimize: vi.fn(),
    onZoom: vi.fn(),
    onTileAction: vi.fn(),
    ...overrides,
  };
  const utils = render(<WindowTitleBar {...props} />);
  return { ...utils, props };
}

afterEach(() => cleanup());

describe('三键 aria 标签', () => {
  it('关闭 / 最小化 / 缩放键有可读 aria-label', () => {
    renderBar();
    expect(screen.getByRole('button', { name: '关闭窗口' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '最小化窗口' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '缩放窗口' })).toBeTruthy();
  });

  it('managed 态（maximized/tiled）绿灯语义切换为「还原窗口」', () => {
    renderBar({ displayMode: 'maximized' });
    expect(screen.getByRole('button', { name: '还原窗口' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '缩放窗口' })).toBeNull();
  });

  it('三键点击各自回调且不触发 zoom（stopPropagation）', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '最小化窗口' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onMinimize).toHaveBeenCalledTimes(1);
    expect(props.onZoom).not.toHaveBeenCalled();
  });
});

describe('长标题溢出', () => {
  const defineSize = (scrollWidth: number, clientWidth: number) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => scrollWidth,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => clientWidth,
    });
  };
  const restoreSize = () => {
    delete (HTMLElement.prototype as any).scrollWidth;
    delete (HTMLElement.prototype as any).clientWidth;
  };

  it('溢出时标题打 data-wb-title-overflow 标记，标题栏带完整标题 tooltip', () => {
    defineSize(400, 120);
    try {
      const { container } = renderBar({ title: '一个非常非常非常长的窗口标题' });
      const text = container.querySelector('[data-wb-window-title]') as HTMLElement;
      expect(text.hasAttribute('data-wb-title-overflow')).toBe(true);
      const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
      expect(bar.getAttribute('title')).toBe('一个非常非常非常长的窗口标题');
    } finally {
      restoreSize();
    }
  });

  it('未溢出时不打标记、无 tooltip', () => {
    defineSize(80, 120);
    try {
      const { container } = renderBar();
      const text = container.querySelector('[data-wb-window-title]') as HTMLElement;
      expect(text.hasAttribute('data-wb-title-overflow')).toBe(false);
      const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
      expect(bar.hasAttribute('title')).toBe(false);
    } finally {
      restoreSize();
    }
  });
});

describe('双击标题栏', () => {
  it('双击空白区触发 zoom 并生成涟漪', () => {
    const { container, props } = renderBar();
    const bar = container.querySelector('[data-wb-titlebar]') as HTMLElement;
    fireEvent.doubleClick(bar, { clientX: 60, clientY: 12 });
    expect(props.onZoom).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.wb-title-ripple')).toBeTruthy();
  });
});
