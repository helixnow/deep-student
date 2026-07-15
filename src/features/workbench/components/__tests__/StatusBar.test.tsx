/**
 * StatusBar SB2/SB3：信号项、学习中心 flyout、Esc、due payload、焦点陷阱
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

import { workbenchBus } from '../../core/workbenchBus';
import { useWorkbenchOverlay } from '../../core/shortcuts';
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
import { StatusBar } from '../StatusBar';
import { formatStatusBarTime } from '../StatusBarItems';

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

const FLASHCARDS_DUE_LAUNCH = {
  typeId: 'flashcards',
  reason: 'api',
  payload: { screen: 'session', mode: 'due' },
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
  invokeMock.mockResolvedValue([]);
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
});

afterEach(() => {
  launchSpy.mockRestore();
  activateSpy.mockRestore();
  stopFlashcardsDueWatcher();
  stopAnkiTaskWatcher();
  usePomodoroStore.setState({
    mode: 'idle',
    status: 'paused',
    timeLeft: 1500,
  });
  useWorkbenchOverlay.setState({ exposeOpen: false });
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
    expect(screen.getByText('学习桌面')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-command')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-settings')).toBeTruthy();
    expect(screen.queryByTestId('wb-menubar-pomodoro')).toBeNull();
    expect(screen.queryByTestId('wb-menubar-flashcards')).toBeNull();
    expect(screen.queryByTestId('wb-menubar-anki-tasks')).toBeNull();
    expect(screen.getByTestId('wb-menubar-automations')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-center')).toBeTruthy();
    expect(screen.queryByTestId('wb-menubar-clock')).toBeNull();
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
  });

  it('命令入口打开命令面板', () => {
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
    fireEvent.click(screen.getByTestId('wb-menubar-command'));
    expect(screen.getByTestId('command-palette-state')).toHaveTextContent('true');
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
    fireEvent.click(btn);
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'pomodoro', reason: 'api' });
  });

  it('due>0 显示闪卡数字，点击 launch flashcards due session', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fsrs_get_due') return [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      return [];
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
    expect(launchSpy).toHaveBeenCalledWith(FLASHCARDS_DUE_LAUNCH);
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
      if (cmd === 'fsrs_get_due') return [{ id: 'x' }, { id: 'y' }];
      return [];
    });
    await act(async () => {
      await refreshFlashcardsDueCount();
    });

    const btn = await screen.findByTestId('wb-menubar-flashcards');
    expect(btn.textContent).toContain('2');
  });
});

describe('StatusBar 学习中心 SB3', () => {
  it('点击图标入口开合 flyout；点遮罩关闭', () => {
    render(<StatusBar />);
    const centerBtn = screen.getByTestId('wb-menubar-center');
    expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();

    fireEvent.click(centerBtn);
    expect(screen.getByTestId('wb-menubar-flyout')).toBeTruthy();
    expect(centerBtn.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByTestId('wb-menubar-flyout-backdrop'));
    expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();
    expect(centerBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('Esc 关闭 flyout', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    expect(screen.getByTestId('wb-menubar-flyout')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();
  });

  it('今日复习瓷砖带 due session payload', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    fireEvent.click(screen.getByTestId('wb-menubar-module-flashcards'));
    expect(launchSpy).toHaveBeenCalledWith(FLASHCARDS_DUE_LAUNCH);
    expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();
  });

  it('flyout 为 2×2 网格，aria-labelledby 挂到标题 h2', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    const flyout = screen.getByTestId('wb-menubar-flyout');
    expect(flyout.querySelector('.wb-menubar-grid')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-module-flashcards')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-module-tasks')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-module-pomodoro')).toBeTruthy();
    expect(screen.getByTestId('wb-menubar-module-desktop')).toBeTruthy();
    const labelledBy = flyout.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy!);
    expect(title?.tagName).toBe('H2');
    expect(title?.classList.contains('wb-menubar-flyout-title')).toBe(true);
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

  it('Expose 打开时关闭学习中心', () => {
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId('wb-menubar-center'));
    expect(screen.getByTestId('wb-menubar-flyout')).toBeTruthy();

    act(() => {
      useWorkbenchOverlay.getState().openExpose();
    });
    expect(screen.queryByTestId('wb-menubar-flyout')).toBeNull();
  });

  it('Windows 下 menubar 标记 chrome inset', () => {
    render(<StatusBar />);
    const bar = screen.getByTestId('wb-menubar');
    // jsdom UA 多为 Windows / 默认 platform 为 windows
    expect(bar.getAttribute('data-chrome-inset')).toBe('windows');
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
