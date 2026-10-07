import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppMenu, AppMenuContent, AppMenuItem, AppMenuTrigger } from './AppMenu';

/**
 * 下拉菜单上下都放不下时（导图「更多操作」这类长菜单在学习桌面窗口里）：
 * 之前整体贴到视口底部、盖住自己的触发按钮和顶部状态栏；现在落在空间大的一侧并限高滚动。
 */
function renderTallMenu(triggerTop: number, triggerHeight = 28) {
  render(
    <AppMenu>
      <AppMenuTrigger asChild>
        <button type="button">更多</button>
      </AppMenuTrigger>
      <AppMenuContent>
        <AppMenuItem>展开全部</AppMenuItem>
      </AppMenuContent>
    </AppMenu>
  );
  const trigger = screen.getByRole('button', { name: '更多' });
  // 定位锚点是 AppMenu 的容器（触发器的父元素）
  (trigger.parentElement as HTMLElement).getBoundingClientRect = () => ({
    x: 900, y: triggerTop, left: 900, right: 930, top: triggerTop, bottom: triggerTop + triggerHeight,
    width: 30, height: triggerHeight, toJSON: () => ({}),
  }) as DOMRect;
  fireEvent.click(trigger, { detail: 1 });
  const menu = screen.getByRole('menu');
  Object.defineProperties(menu, {
    offsetWidth: { configurable: true, value: 200 },
    offsetHeight: { configurable: true, value: 756 },
    scrollHeight: { configurable: true, value: 756 },
  });
  fireEvent.resize(window);
  return { menu, trigger };
}

describe('AppMenu dropdown placement when the menu is taller than either side', () => {
  it('stays below the trigger and constrains its height instead of covering the trigger', () => {
    const vh = window.innerHeight;
    const { menu } = renderTallMenu(80);
    const top = 80 + 28 + 6;
    expect(menu).toHaveStyle({ top: `${top}px` });
    expect(menu).toHaveClass('app-menu-constrained');
    expect(menu.style.getPropertyValue('--app-menu-available-height')).toBe(`${Math.floor(vh - 8 - top)}px`);
  });

  it('keeps the old behaviour when the menu fits below', () => {
    render(
      <AppMenu>
        <AppMenuTrigger asChild>
          <button type="button">短菜单</button>
        </AppMenuTrigger>
        <AppMenuContent>
          <AppMenuItem>一项</AppMenuItem>
        </AppMenuContent>
      </AppMenu>
    );
    const trigger = screen.getByRole('button', { name: '短菜单' });
    (trigger.parentElement as HTMLElement).getBoundingClientRect = () => ({
      x: 100, y: 80, left: 100, right: 130, top: 80, bottom: 108, width: 30, height: 28, toJSON: () => ({}),
    }) as DOMRect;
    fireEvent.click(trigger, { detail: 1 });
    const menu = screen.getByRole('menu');
    Object.defineProperties(menu, {
      offsetWidth: { configurable: true, value: 160 },
      offsetHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 120 },
    });
    fireEvent.resize(window);
    expect(menu).toHaveStyle({ top: '114px' });
    expect(menu).not.toHaveClass('app-menu-constrained');
  });
});
