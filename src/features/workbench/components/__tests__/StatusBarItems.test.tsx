import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { workbenchBus } from '../../core/workbenchBus';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { StatusBarItems } from '../StatusBarItems';

describe('StatusBarItems 顶栏发现性与无障碍文案', () => {
  let launchSpy: ReturnType<typeof vi.spyOn>;
  let activateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    launchSpy = vi.spyOn(workbenchBus, 'launch').mockReturnValue(null);
    activateSpy = vi.spyOn(workbenchBus, 'activate').mockResolvedValue(true);
    usePomodoroStore.setState({
      mode: 'idle',
      status: 'paused',
      timeLeft: 1500,
      sessionCountUp: undefined,
    });
  });

  afterEach(() => {
    launchSpy.mockRestore();
    activateSpy.mockRestore();
  });

  it('无启用定时任务时提供面向学习者的清晰引导提示，而非生硬的「0 个启用」', () => {
    render(
      <StatusBarItems
        dueCount={0}
        taskCount={0}
        automation={{
          enabledCount: 0,
          runningCount: 0,
          failedCount: 0,
          backgroundEnabled: true,
        }}
      />,
    );
    const btn = screen.getByTestId('wb-menubar-automations');
    expect(btn.getAttribute('title')).toContain('定时学习任务');
    expect(btn.getAttribute('title')).not.toBe('0 个启用');
    expect(btn.getAttribute('aria-label')).toContain('定时学习任务');
    expect(screen.queryByTestId('wb-menubar-automations-tag')).toBeNull();
  });

  it('到期闪卡与制卡任务提供语义短标签与明确操作提示', () => {
    render(<StatusBarItems dueCount={5} taskCount={2} automation={null} />);

    const flashcardsBtn = screen.getByTestId('wb-menubar-flashcards');
    expect(screen.getByTestId('wb-menubar-flashcards-tag').textContent).toBe('待复习');
    expect(flashcardsBtn.getAttribute('aria-label')).toContain('到期闪卡');
    expect(flashcardsBtn.getAttribute('aria-label')).toContain('5');
    expect(flashcardsBtn.getAttribute('title')).toContain('点击立即复习');

    const tasksBtn = screen.getByTestId('wb-menubar-anki-tasks');
    expect(screen.getByTestId('wb-menubar-anki-tasks-tag').textContent).toBe('制卡中');
    expect(tasksBtn.getAttribute('aria-label')).toContain('制卡任务');
    expect(tasksBtn.getAttribute('aria-label')).toContain('2');

    fireEvent.click(tasksBtn);
    expect(launchSpy).toHaveBeenCalledWith({ typeId: 'taskDashboard', reason: 'api' });
  });

  it('番茄钟在不同阶段提供对应语义短标签（专注 / 休息 / 已暂停）与完整说明', () => {
    usePomodoroStore.setState({ mode: 'work', status: 'running', timeLeft: 900 });
    const { rerender } = render(<StatusBarItems dueCount={0} taskCount={0} automation={null} />);

    expect(screen.getByTestId('wb-menubar-pomodoro-tag').textContent).toBe('专注');
    expect(screen.getByTestId('wb-menubar-pomodoro').getAttribute('aria-label')).toContain('番茄钟');
    expect(screen.getByTestId('wb-menubar-pomodoro').getAttribute('aria-label')).toContain('专注剩余');

    usePomodoroStore.setState({ mode: 'short_break', status: 'running', timeLeft: 300 });
    rerender(<StatusBarItems dueCount={0} taskCount={0} automation={null} />);
    expect(screen.getByTestId('wb-menubar-pomodoro-tag').textContent).toBe('休息');
    expect(screen.getByTestId('wb-menubar-pomodoro').getAttribute('aria-label')).toContain('休息剩余');

    usePomodoroStore.setState({ mode: 'work', status: 'paused', timeLeft: 420 });
    rerender(<StatusBarItems dueCount={0} taskCount={0} automation={null} />);
    expect(screen.getByTestId('wb-menubar-pomodoro-tag').textContent).toBe('已暂停');
    expect(screen.getByTestId('wb-menubar-pomodoro').getAttribute('aria-label')).toContain('已暂停');
  });

  it('定时任务在运行与异常态展示语义短标签与结构化悬浮摘要', () => {
    const { rerender } = render(
      <StatusBarItems
        dueCount={0}
        taskCount={0}
        automation={{
          enabledCount: 3,
          runningCount: 1,
          failedCount: 0,
          backgroundEnabled: true,
        }}
      />,
    );
    const btn = screen.getByTestId('wb-menubar-automations');
    expect(screen.getByTestId('wb-menubar-automations-tag').textContent).toBe('运行中');
    expect(btn.getAttribute('title')).toContain('定时学习任务');
    expect(btn.getAttribute('title')).toContain('1 个运行中');
    expect(btn.getAttribute('title')).toContain('点击管理');

    rerender(
      <StatusBarItems
        dueCount={0}
        taskCount={0}
        automation={{
          enabledCount: 3,
          runningCount: 0,
          failedCount: 2,
          backgroundEnabled: true,
        }}
      />,
    );
    expect(screen.getByTestId('wb-menubar-automations-tag').textContent).toBe('需关注');
    expect(btn.getAttribute('data-status')).toBe('error');
    expect(screen.getByTestId('wb-menubar-automations-failed-dot')).toBeTruthy();

    fireEvent.click(btn);
    expect(activateSpy).toHaveBeenCalled();
  });
});
