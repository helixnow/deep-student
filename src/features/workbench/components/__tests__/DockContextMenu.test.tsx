/**
 * O6 — DockContextMenu：打开/新建、前台勾选、固定、关闭全部
 */
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { AppDefinition, AppWindowProps } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { workbenchBus } from '../../core/workbenchBus';
import { Dock } from '../Dock';
import { getDockPinned, setDockPinned } from '../DockPinnedStore';

const NullApp: React.FC<AppWindowProps> = () => null;

function makeApp(typeId: string, over?: Partial<AppDefinition>): AppDefinition {
  return {
    typeId,
    nameKey: `workbench:app.${typeId}`,
    icon: <span data-testid={`icon-${typeId}`}>{typeId[0]}</span>,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 400, h: 300 },
    minSize: { w: 200, h: 150 },
    render: React.lazy(async () => ({ default: NullApp })),
    ...over,
  };
}

function resetStore() {
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize: { w: 1600, h: 900 },
  });
}

function openWin(typeId: string, instanceKey: string, title = '') {
  return useWindowStore.getState().openWindow({ typeId, instanceKey, title });
}

function windowsOf(typeId: string) {
  return Object.values(useWindowStore.getState().windows).filter((w) => w.typeId === typeId);
}

/** DockItem aria-label 运行中会追加「运行中」等后缀，按前缀匹配 */
function dockButton(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^${name}(,|$)`) });
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  workbenchBus.setEnabled(true);
  appRegistry.register(makeApp('chat'));
  appRegistry.register(makeApp('files', { instanceMode: 'single' }));
});

beforeEach(() => {
  resetStore();
  setDockPinned([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DockContextMenu', () => {
  it('无实例时显示「打开」并 launch', () => {
    setDockPinned(['chat']);
    render(<Dock />);
    fireEvent.contextMenu(dockButton('chat'));
    fireEvent.click(screen.getByText('打开'));
    expect(windowsOf('chat')).toHaveLength(1);
  });

  it('多实例时显示「新建窗口」', () => {
    openWin('chat', 'a', 'A');
    openWin('chat', 'b', 'B');
    render(<Dock />);
    fireEvent.contextMenu(dockButton('chat'));
    expect(screen.getByText('新建窗口')).toBeInTheDocument();
    fireEvent.click(screen.getByText('新建窗口'));
    expect(windowsOf('chat')).toHaveLength(3);
  });

  it('single 已运行时「打开」禁用', () => {
    openWin('files', 'f', '资源库');
    render(<Dock />);
    fireEvent.contextMenu(dockButton('files'));
    const openItem = screen.getByText('打开').closest('button');
    expect(openItem).toBeDisabled();
  });

  it('前台窗口带 checked 标记', () => {
    const idA = openWin('chat', 'a', '会话 A');
    openWin('chat', 'b', '会话 B');
    useWindowStore.getState().focusWindow(idA);
    render(<Dock />);
    fireEvent.contextMenu(dockButton('chat'));
    const menu = screen.getByRole('menu');
    const itemA = within(menu).getByText('会话 A').closest('button');
    const itemB = within(menu).getByText('会话 B').closest('button');
    expect(itemA).toHaveClass('app-menu-item-checked');
    expect(itemB).not.toHaveClass('app-menu-item-checked');
  });

  it('固定 / 取消固定', () => {
    openWin('chat', 'a');
    render(<Dock />);
    fireEvent.contextMenu(dockButton('chat'));
    fireEvent.click(screen.getByText('固定到 Dock'));
    expect(getDockPinned()).toEqual(['chat']);
  });

  it('关闭全部窗口', async () => {
    openWin('chat', 'a');
    openWin('chat', 'b');
    render(<Dock />);
    fireEvent.contextMenu(dockButton('chat'));
    fireEvent.click(screen.getByText('关闭全部窗口'));
    await waitFor(() => expect(windowsOf('chat')).toHaveLength(0));
  });
});
