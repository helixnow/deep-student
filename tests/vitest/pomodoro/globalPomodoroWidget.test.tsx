/**
 * GlobalPomodoroWidget 悬浮药丸可见性
 *
 * Workbench（OS 桌面）激活时番茄状态已由菜单栏 StatusBarItems 与
 * PomodoroAppWindow 投射，置顶小窗打开时小窗本身就是常驻投影——
 * 两种场景全局药丸都必须让位，任何时刻最多一重悬浮投影。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { GlobalPomodoroWidget } from '@/features/pomodoro/components/GlobalPomodoroWidget';
import { setPomodoroMiniWindowOpen } from '@/features/pomodoro/miniWindow';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';
import { useViewStore } from '@/stores/viewStore';

// react-i18next 全局 mock 无 todo 命名空间 → 文案回退为 key，本测试用 key 查询
const PILL_MAIN_LABEL = 'pomodoro.controls.enterImmersive';

function setActiveSession(): void {
  usePomodoroStore.setState({
    mode: 'work',
    // paused：避免测试期启动全局 tick interval
    status: 'paused',
    timeLeft: 900,
    phaseEndsAt: null,
    phaseStartedAt: null,
    currentTaskTitle: '写论文',
    settings: { ...DEFAULT_POMODORO_SETTINGS },
    isImmersive: false,
  });
}

describe('GlobalPomodoroWidget 药丸可见性', () => {
  beforeEach(() => {
    setActiveSession();
    useViewStore.setState({ currentView: 'chat-v2', previousView: null });
  });

  afterEach(() => {
    usePomodoroStore.setState({ mode: 'idle', status: 'paused', isImmersive: false });
    setPomodoroMiniWindowOpen(false);
  });

  it('legacy 视图（非 todo）+ 活跃会话：显示药丸', () => {
    render(<GlobalPomodoroWidget />);
    expect(screen.getByLabelText(PILL_MAIN_LABEL)).toBeInTheDocument();
  });

  it('workbench 激活时不显示药丸（状态由菜单栏 / 番茄窗投射）', () => {
    render(<GlobalPomodoroWidget workbenchActive />);
    expect(screen.queryByLabelText(PILL_MAIN_LABEL)).toBeNull();
  });

  it('todo 页与 idle 态维持既有隐藏行为', () => {
    useViewStore.setState({ currentView: 'todo' });
    const { unmount } = render(<GlobalPomodoroWidget />);
    expect(screen.queryByLabelText(PILL_MAIN_LABEL)).toBeNull();
    unmount();

    useViewStore.setState({ currentView: 'chat-v2' });
    usePomodoroStore.setState({ mode: 'idle' });
    render(<GlobalPomodoroWidget />);
    expect(screen.queryByLabelText(PILL_MAIN_LABEL)).toBeNull();
  });

  it('置顶小窗打开时药丸让位；小窗关闭（含被直接关掉）后恢复', () => {
    // 初始即打开小窗：药丸不渲染（避免依赖 AnimatePresence 退场时序）
    setPomodoroMiniWindowOpen(true);
    render(<GlobalPomodoroWidget />);
    expect(screen.queryByLabelText(PILL_MAIN_LABEL)).toBeNull();

    // 小窗被用户/系统直接关闭 → destroyed 镜像回落 → 药丸同步恢复挂载
    act(() => setPomodoroMiniWindowOpen(false));
    expect(screen.getByLabelText(PILL_MAIN_LABEL)).toBeInTheDocument();
  });
});
