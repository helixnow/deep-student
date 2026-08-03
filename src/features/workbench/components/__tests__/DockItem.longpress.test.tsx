/**
 * P2 — DockItem 长按出窗口列表：
 * 单实例长按 ~400ms 弹 DockWindowList、click 抑制、移动阈值取消、
 * 长按滑到列表项松手直接选中、「显示全部窗口」触发 App Exposé 过滤俯瞰。
 * 短按点击（focus / minimize / launch）行为不变。
 */
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import type { AppDefinition, AppWindowProps } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { useWorkbenchOverlay } from '../../core/shortcuts';
import { workbenchBus } from '../../core/workbenchBus';
import { DockItem, DOCK_LONGPRESS_DELAY } from '../DockItem';

const NullApp: React.FC<AppWindowProps> = () => null;

function makeApp(typeId: string): AppDefinition {
  return {
    typeId,
    nameKey: `workbench:app.${typeId}`,
    icon: <span>{typeId[0]}</span>,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 400, h: 300 },
    minSize: { w: 200, h: 150 },
    render: React.lazy(async () => ({ default: NullApp })),
  };
}

function resetStores() {
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize: { w: 1600, h: 900 },
  });
  useWorkbenchOverlay.setState({
    exposeOpen: false,
    exposeAppTypeId: null,
    switcherOpen: false,
    switcherIds: [],
    switcherIndex: 0,
    cheatsheetOpen: false,
    cheatsheetSticky: false,
  });
}

function openWin(typeId: string, instanceKey: string, title = '') {
  return useWindowStore.getState().openWindow({ typeId, instanceKey, title });
}

function dockButton(typeId: string): HTMLButtonElement {
  const wrap = screen.getByTestId(`wb-dock-item-${typeId}`);
  const button = wrap.querySelector('button.wb-dock-item');
  if (!button) throw new Error(`Dock button missing for ${typeId}`);
  return button as HTMLButtonElement;
}

/**
 * jsdom 无 PointerEvent：fireEvent.pointerDown 会退化成裸 Event，
 * button/clientX 等 init 全部丢失。用 MouseEvent 承载指针事件保住这些字段
 * （组件只读 button / clientX / clientY / target，MouseEvent 足够）。
 */
function firePointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: MouseEventInit = {},
) {
  fireEvent(
    el,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }),
  );
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  workbenchBus.setEnabled(true);
  appRegistry.register(makeApp('chat'));
  appRegistry.register(makeApp('note'));
});

beforeEach(() => {
  resetStores();
  // DockWindowList 退场瞬时（Esc/选中路径不必等待退场动画）
  document.documentElement.setAttribute('data-wb-material', 'minimal');
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-wb-material');
});

describe('DockItem 长按出窗口列表', () => {
  it('单实例长按 400ms 弹出列表；随后的 click 被抑制（列表保持打开、不最小化）', () => {
    vi.useFakeTimers();
    const chatId = openWin('chat', 'a', '会话 A');
    render(<DockItem typeId="chat" />);
    const button = dockButton('chat');

    firePointer(button, 'pointerdown', { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId('wb-dock-window-list')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(DOCK_LONGPRESS_DELAY);
    });
    expect(screen.getByTestId('wb-dock-window-list')).toBeInTheDocument();

    // 松手在图标上：click 不再当普通点击（否则单实例已聚焦会最小化）
    firePointer(button, 'pointerup', { clientX: 10, clientY: 10 });
    fireEvent.click(button);
    expect(screen.getByTestId('wb-dock-window-list')).toBeInTheDocument();
    expect(useWindowStore.getState().windows[chatId].minimized).toBe(false);
  });

  it('移动超过阈值取消长按（拖拽重排优先）', () => {
    vi.useFakeTimers();
    openWin('chat', 'a', '会话 A');
    render(<DockItem typeId="chat" />);
    const wrap = screen.getByTestId('wb-dock-item-chat');
    const button = dockButton('chat');

    firePointer(button, 'pointerdown', { clientX: 10, clientY: 10 });
    firePointer(wrap, 'pointermove', { clientX: 22, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(DOCK_LONGPRESS_DELAY);
    });
    expect(screen.queryByTestId('wb-dock-window-list')).toBeNull();
  });

  it('短按点击行为不变：单实例未聚焦 → 聚焦且不弹列表', () => {
    vi.useFakeTimers();
    const chatId = openWin('chat', 'a', '会话 A');
    openWin('note', 'n', '笔记'); // note 成为焦点栈顶
    render(<DockItem typeId="chat" />);
    const button = dockButton('chat');

    firePointer(button, 'pointerdown', { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    firePointer(button, 'pointerup', { clientX: 10, clientY: 10 });
    fireEvent.click(button);

    expect(screen.queryByTestId('wb-dock-window-list')).toBeNull();
    const state = useWindowStore.getState();
    expect(state.focusStack[state.focusStack.length - 1]).toBe(chatId);
  });

  it('长按开列表后按住滑到列表项上松手 → 直接选中该窗口', () => {
    vi.useFakeTimers();
    const a = openWin('chat', 'a', '会话 A');
    const b = openWin('chat', 'b', '会话 B');
    // 让 a 成为焦点栈顶，验证滑选切到 b
    useWindowStore.getState().focusWindow(a);

    render(<DockItem typeId="chat" />);
    const button = dockButton('chat');

    firePointer(button, 'pointerdown', { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(DOCK_LONGPRESS_DELAY);
    });
    const itemB = screen
      .getByTestId('wb-dock-window-list')
      .querySelector(`[data-wb-docklist-window="${b}"]`);
    expect(itemB).not.toBeNull();

    // pointerup 落在列表项上（事件冒泡到 wrap 的 onPointerUp 做落点识别）
    firePointer(itemB!, 'pointerup');
    const after = useWindowStore.getState();
    expect(after.focusStack[after.focusStack.length - 1]).toBe(b);
    expect(screen.queryByTestId('wb-dock-window-list')).toBeNull();
  });

  it('「显示全部窗口」入口触发本应用的 App Exposé 过滤俯瞰', () => {
    vi.useFakeTimers();
    openWin('chat', 'a', '会话 A');
    render(<DockItem typeId="chat" />);
    const button = dockButton('chat');

    firePointer(button, 'pointerdown', { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(DOCK_LONGPRESS_DELAY);
    });
    const showAll = screen.getByTestId('wb-docklist-show-all');
    fireEvent.click(showAll);

    expect(useWorkbenchOverlay.getState().exposeOpen).toBe(true);
    expect(useWorkbenchOverlay.getState().exposeAppTypeId).toBe('chat');
    expect(screen.queryByTestId('wb-dock-window-list')).toBeNull();
  });
});
