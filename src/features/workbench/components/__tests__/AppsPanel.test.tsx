/**
 * L4 AppsPanel：打开 / 搜索 / 启动 / 关闭 / 焦点陷阱 / 网格方向键
 */
import React from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AppDefinition, AppWindowProps } from '../../core/types';
import { appRegistry } from '../../core/appRegistry';
import { useWindowStore } from '../../core/windowStore';
import { workbenchBus } from '../../core/workbenchBus';
import { AppsPanel, getGridColumnCount } from '../AppsPanel';
import {
  APPS_DOCK_TYPE_ID,
  closeAppsPanel,
  isAppsPanelOpen,
  openAppsPanel,
} from '../appsPanelStore';
import { Dock } from '../Dock';
import { setDockPinned } from '../DockPinnedStore';

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

function windowsOf(typeId: string) {
  return Object.values(useWindowStore.getState().windows).filter((w) => w.typeId === typeId);
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  workbenchBus.setEnabled(true);
  appRegistry.register(makeApp('chat'));
  appRegistry.register(makeApp('files'));
  appRegistry.register(makeApp('pomodoro'));
  appRegistry.register(makeApp('skills'));
});

beforeEach(() => {
  resetStore();
  setDockPinned(['chat']);
  closeAppsPanel();
});

afterEach(() => {
  closeAppsPanel();
  vi.useRealTimers();
});

describe('appsPanelStore', () => {
  it('openAppsPanel / closeAppsPanel 切换开合', () => {
    expect(isAppsPanelOpen()).toBe(false);
    openAppsPanel();
    expect(isAppsPanelOpen()).toBe(true);
    closeAppsPanel();
    expect(isAppsPanelOpen()).toBe(false);
  });

  it('__apps__ 伪 typeId 未注册进 appRegistry', () => {
    expect(appRegistry.get(APPS_DOCK_TYPE_ID)).toBeUndefined();
    expect(appRegistry.list().some((a) => a.typeId === APPS_DOCK_TYPE_ID)).toBe(false);
  });
});

describe('AppsPanel', () => {
  it('打开后列出 registry 全部应用', () => {
    render(<AppsPanel />);
    expect(screen.queryByTestId('wb-apps-panel')).toBeNull();

    act(() => {
      openAppsPanel();
    });

    expect(screen.getByTestId('wb-apps-panel')).toBeInTheDocument();
    expect(screen.getByTestId('wb-apps-item-chat')).toBeInTheDocument();
    expect(screen.getByTestId('wb-apps-item-files')).toBeInTheDocument();
    expect(screen.getByTestId('wb-apps-item-pomodoro')).toBeInTheDocument();
    expect(screen.getByTestId('wb-apps-item-skills')).toBeInTheDocument();
  });

  it('搜索过滤应用名 / typeId', () => {
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    const search = screen.getByTestId('wb-apps-search');
    fireEvent.change(search, { target: { value: 'pomo' } });

    expect(screen.getByTestId('wb-apps-item-pomodoro')).toBeInTheDocument();
    expect(screen.queryByTestId('wb-apps-item-chat')).toBeNull();
    expect(screen.queryByTestId('wb-apps-item-files')).toBeNull();
  });

  it('无匹配时显示空状态', () => {
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    fireEvent.change(screen.getByTestId('wb-apps-search'), {
      target: { value: 'zzz-no-match' },
    });
    expect(screen.getByTestId('wb-apps-empty')).toBeInTheDocument();
  });

  it('点击应用 → launch(reason: api) 并关闭面板', async () => {
    const launchSpy = vi.spyOn(workbenchBus, 'launch');
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    fireEvent.click(screen.getByTestId('wb-apps-item-pomodoro'));

    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'pomodoro', reason: 'api' });
    expect(windowsOf('pomodoro')).toHaveLength(1);
    expect(isAppsPanelOpen()).toBe(false);

    await waitFor(() => {
      expect(screen.getByTestId('wb-apps-panel')).toHaveAttribute('data-wb-apps-open', 'false');
    });

    launchSpy.mockRestore();
  });

  it('Enter 启动当前选中项', () => {
    const launchSpy = vi.spyOn(workbenchBus, 'launch');
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    fireEvent.change(screen.getByTestId('wb-apps-search'), { target: { value: 'skills' } });
    fireEvent.keyDown(screen.getByTestId('wb-apps-panel'), { key: 'Enter' });

    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'skills', reason: 'api' });
    expect(isAppsPanelOpen()).toBe(false);
    launchSpy.mockRestore();
  });

  it('Esc 关闭面板', () => {
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });
    expect(isAppsPanelOpen()).toBe(true);

    fireEvent.keyDown(screen.getByTestId('wb-apps-panel'), { key: 'Escape' });
    expect(isAppsPanelOpen()).toBe(false);
  });

  it('遮罩可点关闭：禁止 inert（fireEvent 会绕过命中测试）', async () => {
    const user = userEvent.setup();
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });
    expect(isAppsPanelOpen()).toBe(true);

    const backdrop = screen.getByTestId('wb-apps-backdrop');
    // inert 使节点退出命中测试，真机点空白关不掉且事件穿透下层。
    // 勿只靠 fireEvent.click：它不走 pointer hit-test，会绿测掩盖失败。
    expect(backdrop).not.toHaveAttribute('inert');
    expect((backdrop as HTMLElement & { inert?: boolean }).inert).not.toBe(true);
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');

    await user.click(backdrop);
    expect(isAppsPanelOpen()).toBe(false);
  });

  it('↑↓ 移动选中项', () => {
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    fireEvent.click(screen.getByTestId('wb-apps-view-list'));
    const root = screen.getByTestId('wb-apps-panel');
    fireEvent.keyDown(root, { key: 'Home' });
    const firstActive = root.querySelector('[data-wb-apps-active="true"]');
    expect(firstActive).toHaveAttribute('data-wb-apps-index', '0');

    fireEvent.keyDown(root, { key: 'ArrowDown' });
    const secondActive = root.querySelector('[data-wb-apps-active="true"]');
    expect(secondActive).toHaveAttribute('data-wb-apps-index', '1');

    fireEvent.keyDown(root, { key: 'ArrowUp' });
    expect(root.querySelector('[data-wb-apps-active="true"]')).toHaveAttribute(
      'data-wb-apps-index',
      '0',
    );
  });

  it('网格视图 ←/→ 按 index ±1 移动选中项', () => {
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    const root = screen.getByTestId('wb-apps-panel');
    expect(screen.getByTestId('wb-apps-view-grid')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(root, { key: 'Home' });
    const first = root.querySelector('[data-wb-apps-active="true"]');
    expect(first).toHaveAttribute('data-wb-apps-index', '0');

    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(root.querySelector('[data-wb-apps-active="true"]')).toHaveAttribute(
      'data-wb-apps-index',
      '1',
    );

    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(root.querySelector('[data-wb-apps-active="true"]')).toHaveAttribute(
      'data-wb-apps-index',
      '0',
    );
  });

  it('列表视图忽略 ←/→，仅 ↑↓ 步进', () => {
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    fireEvent.click(screen.getByTestId('wb-apps-view-list'));
    const root = screen.getByTestId('wb-apps-panel');
    fireEvent.keyDown(root, { key: 'Home' });
    expect(root.querySelector('[data-wb-apps-active="true"]')).toHaveAttribute(
      'data-wb-apps-index',
      '0',
    );

    fireEvent.keyDown(root, { key: 'ArrowRight' });
    expect(root.querySelector('[data-wb-apps-active="true"]')).toHaveAttribute(
      'data-wb-apps-index',
      '0',
    );

    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(root.querySelector('[data-wb-apps-active="true"]')).toHaveAttribute(
      'data-wb-apps-index',
      '1',
    );
  });

  it('Tab / Shift+Tab 在 dialog 内循环（焦点陷阱）', async () => {
    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    const search = screen.getByTestId('wb-apps-search');
    await waitFor(() => {
      expect(search).toHaveFocus();
    });

    const dialog = search.closest('[role="dialog"]') as HTMLElement;
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );

    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    act(() => {
      last.focus();
    });
    expect(last).toHaveFocus();

    // capture 阶段监听：直接派发到 document
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(first).toHaveFocus();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(last).toHaveFocus();
  });

  it('关闭后面板归还打开前焦点', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    render(<AppsPanel />);
    act(() => {
      openAppsPanel();
    });

    await waitFor(() => {
      expect(screen.getByTestId('wb-apps-search')).toHaveFocus();
    });

    act(() => {
      closeAppsPanel();
    });

    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });

    trigger.remove();
  });

  it('getGridColumnCount 按首行 top 估算列数', () => {
    const list = document.createElement('div');
    const makeItem = (index: number, top: number, left: number) => {
      const el = document.createElement('button');
      el.setAttribute('data-wb-apps-index', String(index));
      el.getBoundingClientRect = () =>
        ({
          top,
          left,
          bottom: top + 40,
          right: left + 96,
          width: 96,
          height: 40,
          x: left,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
      list.appendChild(el);
    };
    // 2 列 × 2 行
    makeItem(0, 0, 0);
    makeItem(1, 0, 100);
    makeItem(2, 50, 0);
    makeItem(3, 50, 100);
    expect(getGridColumnCount(list)).toBe(2);
    expect(getGridColumnCount(null)).toBe(1);
  });
});

describe('Dock Apps 入口', () => {
  it('右侧固定按钮打开面板，不冒充普通 app', () => {
    render(
      <>
        <Dock />
        <AppsPanel />
      </>,
    );

    const btn = screen.getByTestId('wb-dock-apps-button');
    expect(btn).toHaveAttribute('data-type-id', APPS_DOCK_TYPE_ID);
    expect(appRegistry.get(APPS_DOCK_TYPE_ID)).toBeUndefined();

    fireEvent.click(btn);
    expect(isAppsPanelOpen()).toBe(true);
    expect(screen.getByTestId('wb-apps-panel')).toBeInTheDocument();
  });
});
