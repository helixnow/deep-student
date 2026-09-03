/**
 * todoShellNav — ⌘/Ctrl+1..8 视图跳转热键门禁
 *
 * 资格判定分承载环境：
 * - legacy 页面：宿主可见即消费；
 * - workbench 窗口：宿主可见之外还要求所在窗口聚焦（data-focused）——
 *   桌面上仅仅开着一扇（未聚焦的）待办窗不得截走 mod+数字，
 *   此时该组合仍归命令面板的全局导航（mod+1 跳转智能对话等）。
 */
import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => [] }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
  emit: async () => {},
}));

import { useTodoViewHotkeys } from '@/features/todo/components/todoShellNav';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';

const HotkeyHost: React.FC = () => {
  const ref = useRef<HTMLDivElement>(null);
  useTodoViewHotkeys(ref);
  return <div ref={ref} data-testid="hotkey-host" />;
};

/** jsdom 的 getClientRects 恒为空；把宿主打成「可见」 */
function markHostVisible(): void {
  const host = screen.getByTestId('hotkey-host');
  (host as HTMLElement).getClientRects = () =>
    [{ width: 100, height: 100 }] as unknown as DOMRectList;
}

function pressModDigit2(): boolean {
  // fireEvent 返回 false 表示事件被 preventDefault（即被待办热键消费）
  return fireEvent.keyDown(document.body, { code: 'Digit2', ctrlKey: true });
}

function resetFilterView(): void {
  useTodoStore.setState((s) => ({ filter: { ...s.filter, view: 'all' } }));
}

describe('todoShellNav 热键门禁', () => {
  beforeEach(() => {
    resetFilterView();
  });

  afterEach(() => {
    resetFilterView();
  });

  it('legacy 承载：可见宿主消费 mod+2 → 切到今日视图', () => {
    render(<HotkeyHost />);
    markHostVisible();

    const notConsumed = pressModDigit2();

    expect(notConsumed).toBe(false);
    expect(useTodoStore.getState().filter.view).toBe('today');
  });

  it('宿主不可见（离场层/未激活视图）：不消费，放行给命令面板', () => {
    render(<HotkeyHost />);
    // 不 markHostVisible：jsdom 默认 getClientRects 为空 = 不可见

    const notConsumed = pressModDigit2();

    expect(notConsumed).toBe(true);
    expect(useTodoStore.getState().filter.view).toBe('all');
  });

  it('workbench 窗口承载：窗口未聚焦时不消费', () => {
    render(
      <section data-wb-window="">
        <HotkeyHost />
      </section>,
    );
    markHostVisible();

    const notConsumed = pressModDigit2();

    expect(notConsumed).toBe(true);
    expect(useTodoStore.getState().filter.view).toBe('all');
  });

  it('workbench 窗口承载：窗口聚焦时消费', () => {
    render(
      <section data-wb-window="" data-focused="">
        <HotkeyHost />
      </section>,
    );
    markHostVisible();

    const notConsumed = pressModDigit2();

    expect(notConsumed).toBe(false);
    expect(useTodoStore.getState().filter.view).toBe('today');
  });
});
