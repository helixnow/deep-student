/**
 * P6 — WindowSwitcher 组件测试：
 * 会话展示（图标条 + 选中标题）、鼠标 hover/点击、失效窗口过滤
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { WindowSwitcher } from '@/features/workbench/components/WindowSwitcher';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import { useWorkbenchOverlay } from '@/features/workbench/core/shortcuts';
import { makeWindow, seedWindows, resetWorkbenchState, focusedWindowId } from './p6-testUtils';

beforeEach(() => resetWorkbenchState());
afterEach(() => {
  cleanup();
  resetWorkbenchState();
});

function seedAndOpen(index = 1) {
  seedWindows([
    makeWindow({ id: 'a', title: 'Alpha', lastFocusedAt: 300 }),
    makeWindow({ id: 'b', title: 'Beta', lastFocusedAt: 200 }),
    makeWindow({ id: 'c', title: 'Gamma', lastFocusedAt: 100, minimized: true }),
  ]);
  act(() => { useWorkbenchOverlay.getState().openSwitcher(['a', 'b', 'c'], index); });
}

describe('WindowSwitcher', () => {
  it('会话关闭时不渲染', () => {
    seedWindows([makeWindow({ id: 'a' })]);
    render(<WindowSwitcher />);
    expect(document.querySelector('[data-wb-switcher-root]')).toBeNull();
  });

  it('会话开启：按会话顺序渲染全部窗口，选中项高亮并显示标题', () => {
    seedAndOpen(1);
    render(<WindowSwitcher />);

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.getAttribute('aria-selected')))
      .toEqual(['false', 'true', 'false']);
    // 选中窗口标题展示在下方（勿用 getByText：a11y announcer 会同文案）
    expect(document.querySelector('.wb-switcher-title')?.textContent).toBe('Beta');
    // 玻璃条使用契约类
    expect(document.querySelector('[data-wb-switcher-root] .wb-glass')).not.toBeNull();
  });

  it('鼠标 hover 更新选中项', () => {
    seedAndOpen(1);
    render(<WindowSwitcher />);
    fireEvent.mouseEnter(screen.getAllByRole('option')[2]);
    expect(useWorkbenchOverlay.getState().switcherIndex).toBe(2);
    expect(document.querySelector('.wb-switcher-title')?.textContent).toBe('Gamma');
  });

  it('点击项直接聚焦并结束会话', () => {
    seedAndOpen(1);
    render(<WindowSwitcher />);
    fireEvent.click(screen.getAllByRole('option')[2]);
    expect(useWorkbenchOverlay.getState().switcherOpen).toBe(false);
    expect(focusedWindowId()).toBe('c');
    // 最小化窗口被点击后恢复
    expect(useWindowStore.getState().windows.c.minimized).toBe(false);
  });

  it('会话快照中已关闭的窗口被过滤', () => {
    seedAndOpen(0);
    act(() => { useWindowStore.getState().closeWindow('b'); });
    render(<WindowSwitcher />);
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('全部窗口关闭后自然不渲染', () => {
    seedAndOpen(0);
    act(() => {
      useWindowStore.getState().closeWindow('a');
      useWindowStore.getState().closeWindow('b');
      useWindowStore.getState().closeWindow('c');
    });
    render(<WindowSwitcher />);
    expect(document.querySelector('[data-wb-switcher-root]')).toBeNull();
  });
});
