/**
 * WindowResizeHandles 测试：八向命中区渲染 / 光标类名 / 禁用态 / 按键过滤。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';

import { WindowResizeHandles, RESIZE_DIRECTIONS } from '../WindowResizeHandles';

afterEach(() => cleanup());

describe('渲染', () => {
  it('渲染 8 个透明命中区，均对无障碍树隐藏', () => {
    const { container } = render(
      <WindowResizeHandles onResizePointerDown={vi.fn()} />,
    );
    const handles = container.querySelectorAll('[data-wb-resize]');
    expect(handles).toHaveLength(8);
    for (const dir of RESIZE_DIRECTIONS) {
      const el = container.querySelector(`[data-wb-resize="${dir}"]`) as HTMLElement;
      expect(el).toBeTruthy();
      // 光标样式由 wb-shell-rz-<dir> 类承载（WindowShell.css）
      expect(el.classList.contains('wb-shell-rz')).toBe(true);
      expect(el.classList.contains(`wb-shell-rz-${dir}`)).toBe(true);
      expect(el.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('disabled（tiled/maximized）时不渲染任何把手', () => {
    const { container } = render(
      <WindowResizeHandles disabled onResizePointerDown={vi.fn()} />,
    );
    expect(container.querySelectorAll('[data-wb-resize]')).toHaveLength(0);
  });
});

describe('指针交互', () => {
  it('主键按下上抛方向；非主键忽略', () => {
    const spy = vi.fn();
    const { container } = render(<WindowResizeHandles onResizePointerDown={spy} />);
    const se = container.querySelector('[data-wb-resize="se"]') as HTMLElement;
    // jsdom 无 PointerEvent；用 MouseEvent 构造 pointerdown 以携带 button
    fireEvent(se, new MouseEvent('pointerdown', { bubbles: true, button: 2 }));
    expect(spy).not.toHaveBeenCalled();
    fireEvent(se, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('se');
  });
});
