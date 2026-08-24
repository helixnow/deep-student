/**
 * StatusBar SB2/SB3：信号项、学习中心 flyout、Esc、due payload、焦点陷阱、
 * 聚焦应用 / 窗口菜单、时钟与今日日程 flyout、菜单栏 autohide
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

import { workbenchBus } from '../../core/workbenchBus';
import { useWorkbenchOverlay } from '../../core/shortcuts';
import { useWindowStore, resetWindowStoreForTests } from '../../core/windowStore';
import { CommandPaletteProvider, useCommandPalette } from '@/command-palette';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import {
  getFlashcardsDueCount,
  refreshFlashcardsDueCount,
  stopFlashcardsDueWatcher,
} from '../../apps/system/flashcardsDueSource';
import {
  getActiveAnkiTaskCount,
  refreshAnkiTaskCount,
  stopAnkiTaskWatcher,
} from '../../apps/system/ankiTaskSource';
import { resetTodoAgendaSourceForTests } from '../../apps/system/todoAgendaSource';
import { StatusBar } from '../StatusBar';
import { formatStatusBarTime } from '../StatusBarItems';
import { formatMenuBarClock } from '../StatusBarClock';
import {
  MENUBAR_AUTOHIDE_SETTING_KEY,
  resetMenuBarAutohideForTests,
  useMenuBarAutohideStore,
} from '../menuBarAutohideStore';
import { closeAppsPanel, isAppsPanelOpen } from '../appsPanelStore';

const { invokeMock, startDraggingMock, toggleMaximizeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => [] as unknown),
  startDraggingMock: vi.fn(async () => undefined),
  toggleMaximizeMock: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    startDragging: startDraggingMock,
    toggleMaximize: toggleMaximizeMock,
  }),
}));

const FLASHCARDS_DUE_PAYLOAD = { screen: 'session', mode: 'due' } as const;
const FLASHCARDS_DUE_ACTIVATE = {
  typeId: 'flashcards',
  instanceKey: '',
  action: 'startReview',
  payload: FLASHCARDS_DUE_PAYLOAD,
  fallbackLaunch: {
    typeId: 'flashcards',
    reason: 'api',
    payload: FLASHCARDS_DUE_PAYLOAD,
  },
} as const;

let launchSpy: ReturnType<typeof vi.spyOn>;
let activateSpy: ReturnType<typeof vi.spyOn>;

const CommandPaletteStateProbe: React.FC = () => {
  const { isOpen } = useCommandPalette();
  return <output data-testid="command-palette-state">{String(isOpen)}</output>;
};

beforeEach(async () => {
  launchSpy = vi.spyOn(workbenchBus, 'launch').mockReturnValue(null);
  activateSpy = vi.spyOn(workbenchBus, 'activate').mockResolvedValue(true);
  stopFlashcardsDueWatcher();
  stopAnkiTaskWatcher();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ due: 0 });
  startDraggingMock.mockReset();
  toggleMaximizeMock.mockReset();
  await refreshFlashcardsDueCount();
  await refreshAnkiTaskCount();
  usePomodoroStore.setState({
    mode: 'idle',
    status: 'paused',
    timeLeft: 1500,
  });
  useWorkbenchOverlay.setState({ exposeOpen: false });
  resetWindowStoreForTests();
  resetMenuBarAutohideForTests();
});

afterEach(() => {
  vi.useRealTimers();
  launchSpy.mockRestore();
  activateSpy.mockRestore();
  stopFlashcardsDueWatcher();
  stopAnkiTaskWatcher();
  resetTodoAgendaSourceForTests();
  usePomodoroStore.setState({
    mode: 'idle',
    status: 'paused',
    timeLeft: 1500,
  });
  useWorkbenchOverlay.setState({ exposeOpen: false });
  resetWindowStoreForTests();
  resetMenuBarAutohideForTests();
});

describe('formatStatusBarTime', () => {
  it('格式化为 m:ss', () => {
    expect(formatStatusBarTime(754)).toBe('12:34');
    expect(formatStatusBarTime(5)).toBe('0:05');
    expect(formatStatusBarTime(0)).toBe('0:00');
  });
});

describe('StatusBar 信号项可见性', () => {
  it('无信号时不渲染番茄 / 闪卡 / 制卡项，仍显示应用和全局入口', () => {
    render(<StatusBar />);
    expect(screen.getByTestId('wb-menubar-brand')).toBeTruthy();
    // 无焦点窗口 → 聚焦应用菜单显示默认名（品牌钮只留 logo）
    expect(screen.getByText('学习桌面')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-command')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-settings')).toBeTruthy();
    expect(screen.queryByTestId('wb-menubar-pomodoro')).toBeNull();
    expect(screen.queryByTestId('wb-menubar-flashcards')).toBeNull();
    expect(screen.queryByTestId('wb-menubar-anki-tasks')).toBeNull();
    expect(screen.getByTestId('wb-menubar-automations')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-center')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-appmenu')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-windowmenu')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-clock')).toBeTruthy();
  });

  it('设置入口打开 settings 应用', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-settings'));
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'settings', reason: 'api' });
  });

  it('定时任务入口常驻并打开待办自动化视图', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-automations'));
    expect(activateSpy).toHaveBeenCalledWith({
      typeId: 'todo',
      instanceKey: '',
      action: 'showAutomations',
      fallbackLaunch: {
        typeId: 'todo',
        reason: 'api',
        payload: { todoView: 'automations' },
      },
    });
  });

  it('同时有运行和失败时优先显示运行数量与运行状态', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_v2_automation_summary') {
        return {
          enabledCount: 4,
          runningCount: 2,
          failedCount: 1,
          backgroundEnabled: true,
        };
      }
      return [];
    });
    render(<StatusBar />);
    const entry = await screen.findByTestId('wb-menubar-automations');
    await waitFor(() => expect(entry).toHaveTextContent('2'));
    expect(entry).toHaveAttribute('data-status', 'running');
    // running>0 → 图标脉冲；failed>0 → 红点角标
    expect(entry.querySelector('.wb-menubar-automation-iconwrap')).toHaveAttribute('data-pulse', 'true');
    expect(screen.getByTestId('wb-menubar-automations-failed-dot')).toBeTruthy();
  });

  it('命令入口打开统一搜索面板（应用 + 命令），不再弹独立命令面板', () => {
    render(
      <CommandPaletteProvider
        currentView="chat-v2"
        navigate={() => undefined}
        toggleTheme={() => undefined}
        isDarkMode={false}
        switchLanguage={() => undefined}
      >
        <StatusBar />
        <CommandPaletteStateProbe />
      </CommandPaletteProvider>,
    );

    expect(screen.getByTestId('command-palette-state')).toHaveTextContent('false');
    expect(isAppsPanelOpen()).toBe(false);
    fireEvent.click(screen.getByTestId('wb-menubar-command'));
    // 独立命令面板不打开；全部应用面板（统一搜索）打开
    expect(screen.getByTestId('command-palette-state')).toHaveTextContent('false');
    expect(isAppsPanelOpen()).toBe(true);
    closeAppsPanel();
  });

  it('品牌菜单：全部应用 / 系统设置 / 退出学习桌面', async () => {
    workbenchBus.setEnabled(true);
    render(<StatusBar />);

    // 打开品牌菜单（macOS 苹果菜单语义）
    fireEvent.click(screen.getByTestId('wb-menubar-brand'));
    const appsItem = await screen.findByTestId('wb-menubar-brand-apps');
    expect(screen.getByTestId('wb-menubar-brand-settings')).toBeInTheDocument();
    expect(screen.getByTestId('wb-menubar-brand-exit')).toBeInTheDocument();

    // 全部应用 → 打开统一搜索面板
    fireEvent.click(appsItem);
    expect(isAppsPanelOpen()).toBe(true);
    closeAppsPanel();

    // 系统设置 → launch settings 应用窗口
    fireEvent.click(screen.getByTestId('wb-menubar-brand'));
    fireEvent.click(await screen.findByTestId('wb-menubar-brand-settings'));
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'settings', reason: 'api' });

    // 退出学习桌面 → persist false + browser_close 联动 + bus 关闭
    fireEvent.click(screen.getByTestId('wb-menubar-brand'));
    fireEvent.click(await screen.findByTestId('wb-menubar-brand-exit'));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('save_setting', {
        key: 'desktop.workbenchMode',
        value: 'false',
      }),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('browser_close', {}));
    expect(workbenchBus.isEnabled()).toBe(false);
  });

  it('番茄 mode≠idle 时显示 m:ss，点击 launch pomodoro', () => {
    usePomodoroStore.setState({
      mode: 'work',
      status: 'running',
      timeLeft: 754, // 12:34
    });
    render(<StatusBar />);
    const btn = screen.getByTestId('wb-menubar-pomodoro');
    expect(btn.textContent).toContain('12:34');
    expect(btn.getAttribute('aria-label')).toMatch(/12:34/);
    expect(btn.getAttribute('aria-label')).toContain('专注剩余');
    fireEvent.click(btn);
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'pomodoro', reason: 'api' });
  });

  it('番茄休息阶段状态项文案为「休息剩余」而非「专注剩余」', () => {
    usePomodoroStore.setState({
      mode: 'short_break',
      status: 'running',
      timeLeft: 240, // 4:00
    });
    render(<StatusBar />);
    const btn = screen.getByTestId('wb-menubar-pomodoro');
    expect(btn.getAttribute('aria-label')).toContain('休息剩余');
    expect(btn.getAttribute('aria-label')).toMatch(/4:00/);
    expect(btn.getAttribute('data-status')).toBe('break');
  });

  it('番茄暂停态文案为「已暂停」（data-status=paused 供 CSS 压暗）', () => {
    usePomodoroStore.setState({
      mode: 'work',
      status: 'paused',
      timeLeft: 600, // 10:00
    });
    render(<StatusBar />);
    const btn = screen.getByTestId('wb-menubar-pomodoro');
    expect(btn.getAttribute('aria-label')).toContain('已暂停');
    expect(btn.getAttribute('aria-label')).toMatch(/10:00/);
    expect(btn.getAttribute('data-status')).toBe('paused');
  });

  it('due>0 显示闪卡数字，点击 activate flashcards due session', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fsrs_get_stats') return { due: 3 };
      return { due: 0 };
    });
    await act(async () => {
      await refreshFlashcardsDueCount();
    });
    expect(getFlashcardsDueCount()).toBe(3);

    render(<StatusBar />);
    const btn = await screen.findByTestId('wb-menubar-flashcards');
    expect(btn.textContent).toContain('3');
    expect(btn.getAttribute('aria-label')).toMatch(/3/);
    fireEvent.click(btn);
    expect(activateSpy).toHaveBeenCalledWith(FLASHCARDS_DUE_ACTIVATE);
  });

  it('制卡任务>0 显示数字，点击 launch taskDashboard', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_document_sessions') {
        return [{ activeTasks: 2 }, { activeTasks: 1 }];
      }
      return [];
    });
    await act(async () => {
      await refreshAnkiTaskCount();
    });
    expect(getActiveAnkiTaskCount()).toBe(3);

    render(<StatusBar />);
    const btn = await screen.findByTestId('wb-menubar-anki-tasks');
    expect(btn.textContent).toContain('3');
    expect(btn.getAttribute('aria-label')).toMatch(/3/);
    fireEvent.click(btn);
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'taskDashboard', reason: 'api' });
  });
});

describe('StatusBar 订阅复用', () => {
  it('挂载后通过既有 subscribe 收到计数更新（无独立轮询）', async () => {
    render(<StatusBar />);
    expect(screen.queryByTestId('wb-menubar-flashcards')).toBeNull();

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fsrs_get_stats') return { due: 2 };
      return { due: 0 };
    });
    await act(async () => {
      await refreshFlashcardsDueCount();
    });

    const btn = await screen.findByTestId('wb-menubar-flashcards');
    expect(btn.textContent).toContain('2');
  });
});

describe('StatusBar 学习中心 SB3', () => {
  it('点击图标入口开合 flyout；点遮罩关闭', async () => {
    render(<StatusBar />);
    const centerBtn = screen.getByTestId('wb-menubar-center');
    expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();

    fireEvent.click(centerBtn);
    expect(screen.getByTestId('wb-menubar-flyout')).toBeTruthy();
    expect(centerBtn.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByTestId('wb-menubar-flyout-backdrop'));
    expect(centerBtn.getAttribute('aria-expanded')).toBe('false');
    // 离场动画播完才卸载
    await waitFor(() => {
      expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();
    });
  });

  it('Esc 关闭 flyout', async () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    expect(screen.getByTestId('wb-menubar-flyout')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();
    });
  });

  it('今日复习瓷砖带 due session payload', async () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    fireEvent.click(screen.getByTestId('wb-menubar-module-flashcards'));
    expect(activateSpy).toHaveBeenCalledWith(FLASHCARDS_DUE_ACTIVATE);
    await waitFor(() => {
      expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();
    });
  });

  it('flyout 为今日节律面板，aria-labelledby 挂到标题 h2', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    const flyout = screen.getByTestId('wb-menubar-flyout');
    expect(screen.getByTestId('wb-menubar-rhythm')).toBeTruthy();
    expect(flyout.querySelector('.wb-menubar-rhythm')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-module-flashcards')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-module-pomodoro')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-module-automations')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-module-tasks')).toBeTruthy();
    expect(screen.queryByTestId('wb-menubar-module-desktop')).toBeNull();
    const labelledBy = flyout.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy!);
    expect(title?.tagName).toBe('H2');
    expect(title?.classList.contains('wb-menubar-flyout-title')).toBe(true);
    expect(title?.textContent).toMatch(/今日节律|rhythm/i);
    expect(flyout).toHaveAttribute('role', 'dialog');
    expect(flyout).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('wb-menubar-module-flashcards')).toHaveAttribute('aria-label');
    expect(screen.getByTestId('wb-menubar-module-tasks')).toHaveAttribute('aria-label');
  });

  it('节律面板展示自动化健康计数并可打开自动化视图', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_v2_automation_summary') {
        return {
          enabledCount: 4,
          runningCount: 1,
          failedCount: 2,
          backgroundEnabled: true,
        };
      }
      return [];
    });
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    const row = await screen.findByTestId('wb-menubar-module-automations');
    await waitFor(() => {
      expect(row.textContent).toMatch(/1/);
      expect(row.textContent).toMatch(/2/);
      expect(row.textContent).toMatch(/4/);
    });
    fireEvent.click(row);
    expect(activateSpy).toHaveBeenCalledWith({
      typeId: 'todo',
      instanceKey: '',
      action: 'showAutomations',
      fallbackLaunch: {
        typeId: 'todo',
        reason: 'api',
        payload: { todoView: 'automations' },
      },
    });
  });

  it('Tab / Shift+Tab 在 flyout 内循环（焦点陷阱）', async () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));

    const flyout = screen.getByTestId('wb-menubar-flyout');
    await waitFor(() => {
      expect(flyout.contains(document.activeElement)).toBe(true);
    });

    const focusables = Array.from(
      flyout.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    act(() => {
      last.focus();
    });
    expect(last).toHaveFocus();

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

  it('Expose 打开时关闭学习中心', async () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    expect(screen.getByTestId('wb-menubar-flyout')).toBeTruthy();

    act(() => {
      useWorkbenchOverlay.getState().openExpose();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();
    });
  });

  it('Windows 下 menubar 标记 chrome inset', () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });

    try {
      render(<StatusBar />);
      const bar = screen.getByTestId('wb-menubar');
      expect(bar.getAttribute('data-chrome-inset')).toBe('windows');
      expect(bar.hasAttribute('data-macos-chrome')).toBe(false);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUserAgent,
        configurable: true,
      });
    }
  });

  it('macOS 下状态栏与原生交通灯共面，并由空白区接管拖拽和双击缩放', () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });

    try {
      render(<StatusBar />);
      const bar = screen.getByTestId('wb-menubar');
      expect(bar.getAttribute('data-macos-chrome')).toBe('integrated');
      expect(bar.hasAttribute('data-chrome-inset')).toBe(false);
      expect(bar.hasAttribute('data-tauri-drag-region')).toBe(false);
      const dragRegion = screen.getByTestId('wb-menubar-drag-region');

      fireEvent.mouseDown(dragRegion, { button: 0, detail: 1 });
      expect(startDraggingMock).toHaveBeenCalledTimes(1);

      fireEvent.mouseDown(dragRegion, { button: 0, detail: 2 });
      expect(toggleMaximizeMock).toHaveBeenCalledTimes(1);

      fireEvent.mouseDown(screen.getByTestId('wb-menubar-center'), { button: 0, detail: 1 });
      expect(startDraggingMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUserAgent,
        configurable: true,
      });
    }
  });
});

describe('formatMenuBarClock', () => {
  it('zh：7月19日 周日 20:18；en：Sun Jul 19 20:18', () => {
    const date = new Date(2026, 6, 19, 20, 18);
    expect(formatMenuBarClock(date, 'zh-CN')).toBe('7月19日 周日 20:18');
    expect(formatMenuBarClock(date, 'en-US')).toBe('Sun Jul 19 20:18');
  });
});

describe('StatusBar 时钟与今日日程', () => {
  it('时钟显示当前日期时间，点击开合日程 flyout', async () => {
    render(<StatusBar />);
    const clock = screen.getByTestId('wb-menubar-clock');
    // 与 formatMenuBarClock 同源（避免跨分钟边界的偶发不一致，只断言时间样式）
    expect(clock.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(screen.queryByTestId('wb-menubar-clock-flyout')).toBeNull();

    fireEvent.click(clock);
    expect(screen.getByTestId('wb-menubar-clock-flyout')).toBeTruthy();
    expect(clock.getAttribute('aria-expanded')).toBe('true');
    // 数据源复用 todoAgendaSource：空数据 → 空态
    expect(await screen.findByTestId('wb-menubar-agenda-empty')).toBeTruthy();

    fireEvent.click(screen.getByTestId('wb-menubar-clock-backdrop'));
    expect(clock.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => {
      expect(screen.queryByTestId('wb-menubar-clock-flyout')).toBeNull();
    });
  });

  it('今日/逾期待办渲染为可点行，点击打开待办今天视图', async () => {
    const todayKey = (() => {
      const d = new Date();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    })();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'todo_list_lists') {
        return [{ id: 'list1', title: '学习清单' }];
      }
      if (cmd === 'todo_list_all_pending') {
        return [
          {
            id: 'item1',
            todoListId: 'list1',
            title: '复习线性代数',
            status: 'pending',
            priority: 'high',
            dueDate: todayKey,
            dueTime: '09:00',
            sortOrder: 0,
          },
        ];
      }
      return [];
    });
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-clock'));
    const row = await screen.findByTestId('wb-menubar-agenda-item-item1');
    expect(row.textContent).toContain('复习线性代数');
    expect(row.textContent).toContain('09:00');

    const detailedSpy = vi
      .spyOn(workbenchBus, 'activateDetailed')
      .mockResolvedValue({ delivered: true, result: { handled: true } });
    fireEvent.click(row);
    expect(detailedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        typeId: 'todo',
        action: 'showView',
        payload: { view: 'today' },
      }),
    );
    detailedSpy.mockRestore();
    await waitFor(() => {
      expect(screen.queryByTestId('wb-menubar-clock-flyout')).toBeNull();
    });
  });
});

describe('StatusBar 聚焦应用菜单', () => {
  it('无焦点窗口：显示默认名，菜单退化为全部应用入口', async () => {
    render(<StatusBar />);
    const appMenuBtn = screen.getByTestId('wb-menubar-appmenu');
    expect(appMenuBtn.textContent).toBe('学习桌面');

    fireEvent.click(appMenuBtn);
    const allApps = await screen.findByTestId('wb-menubar-app-all-apps');
    fireEvent.click(allApps);
    expect(isAppsPanelOpen()).toBe(true);
    closeAppsPanel();
  });

  it('有焦点窗口：显示所属应用名，提供新建/关闭窗口/全部关闭', async () => {
    render(<StatusBar />);
    let winA = '';
    let winB = '';
    act(() => {
      winA = useWindowStore.getState().openWindow({ typeId: 'todo' });
      winB = useWindowStore.getState().openWindow({ typeId: 'todo' });
    });
    const appMenuBtn = screen.getByTestId('wb-menubar-appmenu');
    // 未注册 appRegistry 定义时回退 typeId
    expect(appMenuBtn.textContent).toBe('todo');

    // 新建窗口 → workbenchBus.launch
    fireEvent.click(appMenuBtn);
    fireEvent.click(await screen.findByTestId('wb-menubar-app-new-window'));
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'todo', reason: 'api' });

    // 关闭窗口 → 只关焦点窗（走 requestCloseAnimated：先标 closing，动画收尾后才落库）
    fireEvent.click(appMenuBtn);
    fireEvent.click(await screen.findByTestId('wb-menubar-app-close-window'));
    await waitFor(() => {
      expect(useWindowStore.getState().windows[winB]).toBeUndefined();
    });
    expect(useWindowStore.getState().windows[winA]).toBeTruthy();

    // 全部关闭 → 同应用全关
    fireEvent.click(appMenuBtn);
    fireEvent.click(await screen.findByTestId('wb-menubar-app-close-all'));
    await waitFor(() => {
      expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
    });
    // 焦点窗清空后回落默认名
    await waitFor(() => {
      expect(appMenuBtn.textContent).toBe('学习桌面');
    });
  });
});

describe('StatusBar 窗口菜单', () => {
  it('列出全部窗口（点击聚焦）并提供平铺命令', async () => {
    render(<StatusBar />);
    let winA = '';
    let winB = '';
    act(() => {
      winA = useWindowStore.getState().openWindow({ typeId: 'todo', title: '待办 A' });
      winB = useWindowStore.getState().openWindow({ typeId: 'flashcards', title: '闪卡 B' });
    });

    const windowMenuBtn = screen.getByTestId('wb-menubar-windowmenu');
    fireEvent.click(windowMenuBtn);
    const itemA = await screen.findByTestId(`wb-menubar-window-item-${winA}`);
    expect(itemA.textContent).toContain('待办 A');
    expect(screen.getByTestId(`wb-menubar-window-item-${winB}`).textContent).toContain('闪卡 B');
    // 焦点窗（B）带勾选语义
    expect(screen.getByTestId(`wb-menubar-window-item-${winB}`).getAttribute('aria-checked')).toBe(
      'true',
    );

    // 点击窗口行 → 聚焦
    fireEvent.click(itemA);
    expect(useWindowStore.getState().focusStack.at(-1)).toBe(winA);

    // 平铺命令作用于焦点窗（windowStore 冻结 API）
    fireEvent.click(windowMenuBtn);
    fireEvent.click(await screen.findByTestId('wb-menubar-window-tile-left'));
    expect(useWindowStore.getState().windows[winA].displayMode).toBe('tiled-left');

    fireEvent.click(windowMenuBtn);
    fireEvent.click(await screen.findByTestId('wb-menubar-window-maximize'));
    expect(useWindowStore.getState().windows[winA].displayMode).toBe('maximized');
  });

  it('无窗口时显示空态且平铺命令禁用', async () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-windowmenu'));
    expect(await screen.findByTestId('wb-menubar-window-empty')).toBeDisabled();
    expect(screen.getByTestId('wb-menubar-window-tile-left')).toBeDisabled();
    expect(screen.getByTestId('wb-menubar-window-tile-right')).toBeDisabled();
    expect(screen.getByTestId('wb-menubar-window-maximize')).toBeDisabled();
  });
});

describe('StatusBar autohide', () => {
  /** get_setting 返回 'true'：启动回放不覆盖测试预置的 settingEnabled */
  const mockAutohideSettingOn = () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (
        cmd === 'get_setting' &&
        (args as { key?: string } | undefined)?.key === MENUBAR_AUTOHIDE_SETTING_KEY
      ) {
        return 'true';
      }
      return { due: 0 };
    });
  };

  it('设置开启（workbench:settings-changed 热更新）→ 默认隐藏，热区延迟滑出，离开延迟收回', () => {
    vi.useFakeTimers();
    render(<StatusBar />);
    const bar = screen.getByTestId('wb-menubar');
    expect(bar.hasAttribute('data-autohide')).toBe(false);
    expect(screen.queryByTestId('wb-menubar-hotzone')).toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('workbench:settings-changed', {
          detail: { key: MENUBAR_AUTOHIDE_SETTING_KEY, value: true },
        }),
      );
    });
    expect(bar.getAttribute('data-autohide')).toBe('true');
    expect(bar.getAttribute('data-hidden')).toBe('true');

    const hotzone = screen.getByTestId('wb-menubar-hotzone');
    fireEvent.pointerEnter(hotzone);
    // reveal 延迟 180ms：未到时仍隐藏
    expect(bar.getAttribute('data-hidden')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(bar.hasAttribute('data-hidden')).toBe(false);

    // 指针未进入菜单栏直接离开顶缘 → conceal 150ms 后隐藏
    fireEvent.pointerLeave(hotzone);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(bar.getAttribute('data-hidden')).toBe('true');
  });

  it('热区短暂划过（未满 reveal 延迟）不弹出', () => {
    vi.useFakeTimers();
    mockAutohideSettingOn();
    act(() => {
      useMenuBarAutohideStore.getState().setSettingEnabled(true);
    });
    render(<StatusBar />);
    const bar = screen.getByTestId('wb-menubar');
    const hotzone = screen.getByTestId('wb-menubar-hotzone');

    fireEvent.pointerEnter(hotzone);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerLeave(hotzone);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(bar.getAttribute('data-hidden')).toBe('true');
  });

  it('外部强制（forceAutohide）同样生效，可被后续沉浸模式复用', () => {
    render(<StatusBar />);
    const bar = screen.getByTestId('wb-menubar');
    expect(bar.hasAttribute('data-autohide')).toBe(false);
    act(() => {
      useMenuBarAutohideStore.getState().setForceAutohide(true);
    });
    expect(bar.getAttribute('data-autohide')).toBe('true');
    expect(bar.getAttribute('data-hidden')).toBe('true');
    act(() => {
      useMenuBarAutohideStore.getState().setForceAutohide(false);
    });
    expect(bar.hasAttribute('data-autohide')).toBe(false);
    expect(bar.hasAttribute('data-hidden')).toBe(false);
  });

  it('浮层打开期间保持展开（学习中心 flyout 计入 overlaysOpen）', () => {
    mockAutohideSettingOn();
    act(() => {
      useMenuBarAutohideStore.getState().setSettingEnabled(true);
    });
    render(<StatusBar />);
    const bar = screen.getByTestId('wb-menubar');
    expect(bar.getAttribute('data-hidden')).toBe('true');

    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    expect(bar.hasAttribute('data-hidden')).toBe(false);
  });
});
