/**
 * O18 — 系统 / 沙箱窗口体验 + 投射呈现 测试
 *
 * 覆盖：
 * - useWbSysSize 纯分级函数阈值；
 * - WbSysSkeleton / WbSysActivityStrip 呈现契约；
 * - WorkbenchSidebarLayout 宽窗并排 / 窄窗抽屉（开合、遮罩、Esc）；
 * - PomodoroAppWindow 计时视觉状态机（idle/运行/暂停/正计时/严格模式）与模式化标题；
 * - TaskDashboardAppWindow 标题实时任务计数 + 活动条 + subscribeAnkiTaskCount 生命周期；
 * - SandboxAppWindow iframe 焦点守卫（非焦点有 / 焦点无）。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { AppWindowProps } from '@/features/workbench/core/types';

// ---- mocks（legacy 重页面全部换成轻量桩，只测适配层行为） ----

const { invokeMock } = vi.hoisted(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() { return storage.size; },
  });
  return { invokeMock: vi.fn(async () => [] as unknown) };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));

vi.mock('@/features/todo', () => ({
  TodoContentView: ({ todoListId }: { todoListId?: string }) => (
    <div data-testid="mock-todo-content" data-todo-list={todoListId ?? ''} />
  ),
  TodoShellSidebar: () => (
    <nav data-testid="mock-todo-sidebar">
      <button type="button" data-testid="mock-todo-nav-item">
        清单 A
      </button>
    </nav>
  ),
}));
vi.mock('@/features/todo/index.ts', () => ({
  TodoContentView: ({ todoListId }: { todoListId?: string }) => (
    <div data-testid="mock-todo-content" data-todo-list={todoListId ?? ''} />
  ),
  TodoShellSidebar: () => (
    <nav data-testid="mock-todo-sidebar">
      <button type="button" data-testid="mock-todo-nav-item">
        清单 A
      </button>
    </nav>
  ),
}));

vi.mock('@/features/todo/components/TodoIconRail', () => ({
  TodoIconRail: ({ className }: { className?: string }) => (
    <nav data-todo-icon-rail data-testid="mock-todo-icon-rail" className={className} />
  ),
}));

vi.mock('@/features/anki-tasks/AnkiTasksApp', () => ({
  AnkiTasksApp: () => <div data-testid="mock-task-dashboard" />,
}));

vi.mock('@/features/pomodoro', () => ({
  PomodoroPanel: () => <div data-testid="mock-pomodoro-panel" />,
}));

vi.mock('@/features/sandbox/components/SandboxWorkbenchSurface', () => {
  const Surface = ({ className, ownerKey }: { className?: string; ownerKey?: string }) => (
    <div
      data-testid="mock-sandbox-surface"
      data-owner-key={ownerKey}
      className={className}
    />
  );
  return { default: Surface, SandboxWorkbenchSurface: Surface };
});

vi.mock('@/features/sandbox/store/useSandboxWorkbenchStore', () => {
  const legacyOwnerKey = 'sandbox:legacy';
  const emptyOwnerState = {
    activeSession: null,
    isOpen: false,
    viewportPreset: 'desktop',
    inspectorOpen: false,
  };
  const state = {
    ...emptyOwnerState,
    ownerStates: { [legacyOwnerKey]: emptyOwnerState },
    activeOwnerKey: legacyOwnerKey,
  };
  return {
    LEGACY_SANDBOX_OWNER_KEY: legacyOwnerKey,
    selectSandboxWorkbenchOwnerState: (
      store: typeof state,
      ownerKey: string,
    ) => store.ownerStates[ownerKey as keyof typeof store.ownerStates] ?? emptyOwnerState,
    useSandboxWorkbenchStore: (selector: (store: typeof state) => unknown) => selector(state),
  };
});

import {
  classifyWbSysWidth,
  classifyWbSysHeight,
} from '@/features/workbench/apps/system/useWbSysSize';
import {
  WbSysSkeleton,
  WbSysActivityStrip,
  WorkbenchSidebarLayout,
} from '@/features/workbench/apps/system/SystemWindowShared';
import {
  refreshAnkiTaskCount,
  stopAnkiTaskWatcher,
  subscribeAnkiTaskCount,
  getActiveAnkiTaskCount,
} from '@/features/workbench/apps/system/ankiTaskSource';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { DEFAULT_POMODORO_SETTINGS } from '@/features/pomodoro/types';
import PomodoroAppWindow from '@/features/workbench/apps/system/PomodoroAppWindow';
import TaskDashboardAppWindow from '@/features/workbench/apps/system/TaskDashboardAppWindow';
import TodoAppWindow from '@/features/workbench/apps/system/TodoAppWindow';
import SandboxAppWindow from '@/features/workbench/apps/sandbox/SandboxAppWindow';

function makeProps(overrides: Partial<AppWindowProps> = {}): AppWindowProps {
  return {
    windowId: 'win_o18',
    instanceKey: null,
    launchPayload: undefined,
    isActive: true,
    isVisible: true,
    onTitleChange: vi.fn(),
    requestClose: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// 尺寸分级
// ============================================================================

describe('O18 useWbSysSize 分级函数', () => {
  it('宽度阈值：<640 compact / 640–879 medium / ≥880 wide', () => {
    expect(classifyWbSysWidth(0)).toBe('compact');
    expect(classifyWbSysWidth(639)).toBe('compact');
    expect(classifyWbSysWidth(640)).toBe('medium');
    expect(classifyWbSysWidth(879)).toBe('medium');
    expect(classifyWbSysWidth(880)).toBe('wide');
    expect(classifyWbSysWidth(1440)).toBe('wide');
  });

  it('高度阈值：<520 short / ≥520 tall', () => {
    expect(classifyWbSysHeight(519)).toBe('short');
    expect(classifyWbSysHeight(520)).toBe('tall');
  });
});

// ============================================================================
// 骨架屏 / 活动条
// ============================================================================

describe('O18 共享呈现件', () => {
  it('WbSysSkeleton 输出 role=status 与变体标记', () => {
    render(<WbSysSkeleton variant="dashboard" />);
    const skeleton = screen.getByRole('status');
    expect(skeleton).toHaveAttribute('data-wb-sys-skeleton', 'dashboard');
  });

  it('WbSysActivityStrip：active 切换 data-active 与可达性角色', () => {
    const { rerender, container } = render(<WbSysActivityStrip active={false} label="进行中" />);
    const strip = container.querySelector('[data-wb-sys-activity]')!;
    expect(strip).toHaveAttribute('data-active', 'false');
    expect(strip).toHaveAttribute('aria-hidden', 'true');

    rerender(<WbSysActivityStrip active label="进行中" />);
    expect(strip).toHaveAttribute('data-active', 'true');
    expect(strip).toHaveAttribute('role', 'status');
  });
});

// ============================================================================
// 侧栏布局：宽窗并排 / 窄窗抽屉
// ============================================================================

describe('O18 WorkbenchSidebarLayout', () => {
  it('wide：侧栏并排渲染，无抽屉把手', () => {
    const { container } = render(
      <WorkbenchSidebarLayout sizeClass="wide" navLabel="待办导航" sidebar={<div data-testid="side" />}>
        <div data-testid="main" />
      </WorkbenchSidebarLayout>,
    );
    expect(screen.getByTestId('side')).toBeInTheDocument();
    expect(screen.getByTestId('main')).toBeInTheDocument();
    expect(container.querySelector('[data-wb-sys-drawer-handle]')).toBeNull();
    expect(container.querySelector('[data-wb-sys-drawer]')).toBeNull();
  });

  it('compact：把手开抽屉、遮罩点击 / Esc 关抽屉', () => {
    const { container } = render(
      <WorkbenchSidebarLayout
        sizeClass="compact"
        navLabel="待办导航"
        sidebar={<div data-testid="side" />}
      >
        <div data-testid="main" />
      </WorkbenchSidebarLayout>,
    );

    const drawer = container.querySelector('[data-wb-sys-drawer]')!;
    const handle = container.querySelector('[data-wb-sys-drawer-handle]')!;
    expect(drawer).toHaveAttribute('data-open', 'false');

    fireEvent.click(handle);
    expect(drawer).toHaveAttribute('data-open', 'true');
    expect(handle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(container.querySelector('.wb-sys-scrim')!);
    expect(drawer).toHaveAttribute('data-open', 'false');

    fireEvent.click(handle);
    expect(drawer).toHaveAttribute('data-open', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(drawer).toHaveAttribute('data-open', 'false');
  });

  it('compact：点中抽屉内导航项后自动收起', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <WorkbenchSidebarLayout
          sizeClass="compact"
          navLabel="导航"
          sidebar={<button type="button" data-testid="nav-item" />}
        >
          <div />
        </WorkbenchSidebarLayout>,
      );
      const drawer = container.querySelector('[data-wb-sys-drawer]')!;
      fireEvent.click(container.querySelector('[data-wb-sys-drawer-handle]')!);
      expect(drawer).toHaveAttribute('data-open', 'true');

      fireEvent.click(screen.getByTestId('nav-item'));
      act(() => {
        vi.runAllTimers();
      });
      expect(drawer).toHaveAttribute('data-open', 'false');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// TodoAppWindow：jsdom 零尺寸 → compact 档 → 常驻图标栏形态（非抽屉）
// ============================================================================

describe('O18 TodoAppWindow', () => {
  it('lazy 内容就绪后渲染主面板；零宽环境走窄窗图标栏形态', async () => {
    const props = makeProps();
    const { container } = render(<TodoAppWindow {...props} />);

    expect(await screen.findByTestId('mock-todo-content')).toBeInTheDocument();
    // jsdom 元素宽高为 0 → compact：常驻图标栏存在、无玻璃抽屉把手
    expect(container.querySelector('[data-todo-icon-rail]')).not.toBeNull();
    expect(container.querySelector('[data-wb-sys-drawer-handle]')).toBeNull();
    expect(props.onTitleChange).toHaveBeenCalledWith('待办');

    // launchPayload.todoListId 透传
    const second = render(
      <TodoAppWindow {...makeProps({ launchPayload: { todoListId: 'list_9' } })} />,
    );
    expect(second.container.querySelector('[data-testid="mock-todo-content"]')).toHaveAttribute(
      'data-todo-list',
      'list_9',
    );
  });
});

// ============================================================================
// PomodoroAppWindow：计时视觉状态机
// ============================================================================

describe('O18 PomodoroAppWindow 计时视觉', () => {
  beforeEach(() => {
    usePomodoroStore.setState({
      mode: 'idle',
      status: 'paused',
      timeLeft: 1500,
      phaseEndsAt: null,
      phaseStartedAt: null,
      currentTaskTitle: null,
      settings: { ...DEFAULT_POMODORO_SETTINGS },
    });
  });

  it('idle：无进度、显示配置时长与开始提示，标题为应用名', () => {
    const props = makeProps();
    const { container } = render(<PomodoroAppWindow {...props} />);
    const root = container.querySelector('.wb-sys-pomo')!;
    expect(root).toHaveAttribute('data-mode', 'idle');
    expect(root).toHaveAttribute('data-status', 'idle');
    expect(container.querySelector('[data-wb-sys-pomo-time]')!.textContent).toBe('25:00');
    expect(screen.getByText('在下方开始一段专注')).toBeInTheDocument();
    expect(props.onTitleChange).toHaveBeenLastCalledWith('番茄钟');
  });

  it('专注运行：模式语义 + 进度环推进 + 模式化标题 + 任务徽章', () => {
    const props = makeProps();
    const { container } = render(<PomodoroAppWindow {...props} />);

    act(() => {
      usePomodoroStore.setState({
        mode: 'work',
        status: 'running',
        timeLeft: 600,
        phaseEndsAt: Date.now() + 600_000,
        currentTaskTitle: '写论文',
      });
    });

    const root = container.querySelector('.wb-sys-pomo')!;
    expect(root).toHaveAttribute('data-mode', 'work');
    expect(root).toHaveAttribute('data-status', 'running');
    expect(root).toHaveAttribute('data-anim', 'on');
    expect(container.querySelector('[data-wb-sys-pomo-time]')!.textContent).toBe('10:00');
    expect(screen.getByText('写论文')).toBeInTheDocument();
    expect(props.onTitleChange).toHaveBeenLastCalledWith('专注中 · 写论文');

    // 进度环：25 分钟剩 10 分钟 → 完成 60% → dashoffset = C * 0.4
    const progressCircle = container.querySelector('.wb-sys-pomo-progress')!;
    const circumference = 2 * Math.PI * 100;
    const offset = Number(progressCircle.getAttribute('stroke-dashoffset'));
    expect(offset).toBeCloseTo(circumference * 0.4, 1);
  });

  it('暂停：状态徽章出现、data-status=paused；isVisible=false 挂起动画', () => {
    const props = makeProps({ isVisible: false });
    const { container } = render(<PomodoroAppWindow {...props} />);

    act(() => {
      usePomodoroStore.setState({
        mode: 'work',
        status: 'paused',
        timeLeft: 300,
        currentTaskTitle: null,
      });
    });

    const root = container.querySelector('.wb-sys-pomo')!;
    expect(root).toHaveAttribute('data-status', 'paused');
    expect(root).toHaveAttribute('data-anim', 'off');
    expect(screen.getByText('已暂停')).toBeInTheDocument();
  });

  it('正计时专注：副标签为正计时；严格模式运行显示严格徽章', () => {
    const props = makeProps();
    render(<PomodoroAppWindow {...props} />);

    act(() => {
      usePomodoroStore.setState({
        // 正计时以会话锁定的 sessionCountUp 为准（会话开始时从 settings.countUp 锁定）
        sessionCountUp: true,
        mode: 'work',
        status: 'running',
        timeLeft: 90,
        phaseStartedAt: Date.now() - 90_000,
        settings: { ...usePomodoroStore.getState().settings, strictMode: true },
      });
    });

    expect(screen.getByText('正计时')).toBeInTheDocument();
    expect(screen.getByText('严格模式')).toBeInTheDocument();
  });

  it('休息模式映射语义色轨道（short_break → data-mode）', () => {
    const { container } = render(<PomodoroAppWindow {...makeProps()} />);
    act(() => {
      usePomodoroStore.setState({ mode: 'short_break', status: 'running', timeLeft: 240 });
    });
    expect(container.querySelector('.wb-sys-pomo')).toHaveAttribute('data-mode', 'short_break');
  });

  it('控制坞：idle 显示开始专注；点击进入专注后切换为暂停 + 停止', () => {
    render(<PomodoroAppWindow {...makeProps()} />);

    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    expect(usePomodoroStore.getState().mode).toBe('work');
    expect(usePomodoroStore.getState().status).toBe('running');

    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument();
  });

  it('今日条：渲染今日计数/目标；点击打开统计子视图，Esc 退回且焦点归还', async () => {
    usePomodoroStore.setState({ completedPomodorosToday: 3 });
    const { container } = render(<PomodoroAppWindow {...makeProps()} />);

    // 默认每日目标 8 → 3/8
    expect(container.querySelector('.wb-sys-pomo-today-text strong')!.textContent).toBe('3/8');

    const strip = screen.getByRole('button', { name: '专注趋势' });
    fireEvent.click(strip);
    await act(async () => {});
    // 统计为窗内同层子视图（非模态），切入即聚焦面板
    const panel = screen.getByRole('region', { name: '专注趋势' });
    expect(panel).toHaveAttribute('data-active', 'true');
    expect(document.activeElement).toBe(panel);

    fireEvent.keyDown(document, { key: 'Escape' });
    // 退回主视图：子视图进入退场（aria-hidden），焦点归还统计按钮
    expect(panel).toHaveAttribute('data-active', 'false');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(document.activeElement).toBe(strip);
  });

  it('设置子视图：设计系统控件齐备（7 滑杆 / 5 开关 / 音色分段），返回关闭且焦点归还', async () => {
    render(<PomodoroAppWindow {...makeProps()} />);

    const trigger = screen.getByRole('button', { name: '番茄钟设置' });
    fireEvent.click(trigger);
    // 设置为窗内同层子视图（非模态），切入即聚焦面板
    const panel = await screen.findByRole('region', { name: '番茄钟设置' });
    expect(panel).toHaveAttribute('data-active', 'true');
    expect(document.activeElement).toBe(panel);

    // 滑杆：专注/短休/长休/间隔/结束前提醒/每日目标/音量
    expect(screen.getAllByRole('slider')).toHaveLength(7);
    // 开关：自动开始休息/自动开始专注/严格模式/正计时/随专注自动播放
    expect(screen.getAllByRole('switch')).toHaveLength(5);
    // 音色分段选择
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    // 退回主视图：子视图进入退场（aria-hidden），焦点归还设置按钮
    expect(panel).toHaveAttribute('data-active', 'false');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(document.activeElement).toBe(trigger);
  });

  it('周期圆点：按长休息间隔渲染，已完成填充、当前工作颗标记', () => {
    usePomodoroStore.setState({
      completedPomodorosToday: 2,
      mode: 'work',
      status: 'running',
      timeLeft: 600,
    });
    const { container } = render(<PomodoroAppWindow {...makeProps()} />);

    // 默认长休息间隔 4 → 4 颗；已完成 2 颗；第 3 颗为当前进行中
    expect(container.querySelectorAll('.wb-sys-pomo-cycle')).toHaveLength(4);
    expect(container.querySelectorAll('.wb-sys-pomo-cycle[data-filled="true"]')).toHaveLength(2);
    expect(
      container.querySelector('.wb-sys-pomo-cycle[data-current="true"]'),
    ).not.toBeNull();
  });
});

// ============================================================================
// TaskDashboardAppWindow：标题计数 + 活动条
// ============================================================================

describe('O18 TaskDashboardAppWindow 任务进行中呈现', () => {
  beforeEach(async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
    await refreshAnkiTaskCount(); // 归零
  });

  afterEach(() => {
    stopAnkiTaskWatcher();
  });

  it('无任务：基础标题、活动条熄灭；有任务：标题带计数、活动条点亮', async () => {
    const props = makeProps();
    const { container } = render(<TaskDashboardAppWindow {...props} />);

    expect(await screen.findByTestId('mock-task-dashboard')).toBeInTheDocument();
    expect(props.onTitleChange).toHaveBeenLastCalledWith('制卡任务');
    expect(container.querySelector('[data-wb-sys-activity]')).toHaveAttribute(
      'data-active',
      'false',
    );

    invokeMock.mockResolvedValue([{ activeTasks: 2 }, { activeTasks: 1 }]);
    await act(async () => {
      await refreshAnkiTaskCount();
    });

    expect(props.onTitleChange).toHaveBeenLastCalledWith('制卡任务 · 3');
    expect(container.querySelector('[data-wb-sys-activity]')).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('subscribeAnkiTaskCount：订阅收到变化，全部退订后 watcher 停止', async () => {
    const seen: number[] = [];
    const unsubscribe = subscribeAnkiTaskCount((count) => seen.push(count));

    invokeMock.mockResolvedValue([{ activeTasks: 4 }]);
    await refreshAnkiTaskCount();
    expect(seen).toContain(4);
    expect(getActiveAnkiTaskCount()).toBe(4);

    unsubscribe();
    // 退订后不再通知
    invokeMock.mockResolvedValue([]);
    await refreshAnkiTaskCount();
    expect(seen).not.toContain(0);
  });
});

// ============================================================================
// SandboxAppWindow：iframe 焦点守卫
// ============================================================================

describe('O18 SandboxAppWindow 焦点守卫', () => {
  it('非焦点窗口铺守卫层，聚焦后卸载', async () => {
    const props = makeProps({ isActive: false });
    const { container, rerender } = render(<SandboxAppWindow {...props} />);

    expect(await screen.findByTestId('mock-sandbox-surface')).toBeInTheDocument();
    expect(screen.getByTestId('mock-sandbox-surface')).toHaveAttribute(
      'data-owner-key',
      'sandbox:legacy',
    );
    expect(container.querySelector('[data-wb-sandbox-focus-guard]')).not.toBeNull();

    rerender(<SandboxAppWindow {...makeProps({ isActive: true })} />);
    expect(container.querySelector('[data-wb-sandbox-focus-guard]')).toBeNull();

    expect(props.onTitleChange).toHaveBeenCalledWith('沙箱工作台');
  });
});
